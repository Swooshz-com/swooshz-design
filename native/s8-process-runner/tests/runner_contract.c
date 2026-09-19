#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "s8-process-runner-contract-tests requires Linux x86_64"
#endif

#ifndef SYS_clone3
#define SYS_clone3 435
#endif

#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000U
#endif

#define RECEIPT_PREFIX "S8_RUNNER_RECEIPT:{"
#define RECEIPT_SCHEMA "\"schemaVersion\":\"s8-process-runner-receipt-v2\""
#define RECEIPT_PROTOCOL "\"protocol\":\"s8-process-runner-receipt-v2\""
#define RECEIPT_POLICY "\"policyId\":\"s8-zero-child-seccomp-x86_64-v2\""
#define RECEIPT_MAX_BYTES (4U * 1024U * 1024U)
#define SELF_EXECUTABLE_CAPACITY (PATH_MAX + 1U)

typedef struct {
    const char *name;
    const char *mode;
    const char *address_space_bytes;
    const char *file_bytes;
    const char *timeout_ms;
    const char *cpu_seconds;
    const char *stdout_bytes;
    const char *stderr_bytes;
    int expected_status;
    int expected_code;
    const char *expected_name;
    const char *expected_termination;
    const char *target_output;
    const char *receipt_extra;
} runner_case;

static int read_all(int fd, char **result)
{
    size_t length = 0U;
    size_t capacity = 4096U;
    char *value = (char *)malloc(capacity);
    if (!value) return 0;
    for (;;) {
        ssize_t count;
        if (length + 1U >= capacity) {
            char *grown;
            if (capacity >= RECEIPT_MAX_BYTES) { free(value); return 0; }
            capacity *= 2U;
            if (capacity > RECEIPT_MAX_BYTES) capacity = RECEIPT_MAX_BYTES;
            grown = (char *)realloc(value, capacity);
            if (!grown) { free(value); return 0; }
            value = grown;
        }
        count = read(fd, value + length, capacity - length - 1U);
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            free(value);
            return 0;
        }
        length += (size_t)count;
        if (length >= RECEIPT_MAX_BYTES - 1U) { free(value); return 0; }
    }
    value[length] = '\0';
    *result = value;
    return 1;
}

static int has_sha256_after(const char *text, const char *marker)
{
    const char *value = strstr(text, marker);
    size_t index;
    if (!value) return 0;
    value += strlen(marker);
    for (index = 0U; index < 64U; index++) {
        char character = value[index];
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return 0;
    }
    return value[64] == '"';
}

static int resolve_contract_test_executable(char *path, size_t capacity)
{
    ssize_t length;
    if (capacity < 2U) return 0;
    length = readlink("/proc/self/exe", path, capacity - 1U);
    if (length < 0 || (size_t)length >= capacity - 1U) return 0;
    path[length] = '\0';
    if (path[0] != '/' || path[1] == '\0') return 0;
    return access(path, X_OK) == 0;
}

static void *thread_main(void *argument)
{
    *(int *)argument = 1;
    return NULL;
}

static int child_mode(const char *mode)
{
    if (!strcmp(mode, "ordinary")) {
        puts("ordinary-ok");
        return 0;
    }
    if (!strcmp(mode, "fork")) {
        pid_t child;
        errno = 0;
        child = fork();
        if (child < 0 && errno == EPERM) { puts("fork-blocked"); return 0; }
        if (child == 0) _exit(99);
        if (child > 0) (void)waitpid(child, NULL, 0);
        return 1;
    }
    if (!strcmp(mode, "vfork")) {
        pid_t child;
        errno = 0;
        child = vfork();
        if (child < 0 && errno == EPERM) { puts("vfork-blocked"); return 0; }
        if (child == 0) _exit(99);
        if (child > 0) (void)waitpid(child, NULL, 0);
        return 1;
    }
    if (!strcmp(mode, "clone")) {
        long child;
        errno = 0;
        child = syscall(SYS_clone, (unsigned long)SIGCHLD, NULL, NULL, NULL, NULL);
        if (child < 0 && errno == EPERM) { puts("clone-blocked"); return 0; }
        if (child == 0) _exit(99);
        if (child > 0) (void)waitpid((pid_t)child, NULL, 0);
        return 1;
    }
    if (!strcmp(mode, "clone3")) {
        long result = syscall(SYS_clone3, NULL, 0U);
        if (result < 0 && errno == ENOSYS) { puts("clone3-blocked"); return 0; }
        if (result == 0) _exit(99);
        return 1;
    }
    if (!strcmp(mode, "thread")) {
        pthread_t thread;
        int value = 0;
        if (pthread_create(&thread, NULL, thread_main, &value) != 0) return 1;
        if (pthread_join(thread, NULL) != 0 || value != 1) return 1;
        puts("thread-allowed");
        return 0;
    }
    if (!strcmp(mode, "x32")) {
        (void)syscall((long)(__X32_SYSCALL_BIT | (unsigned long)SYS_getpid));
        puts("x32-not-blocked");
        return 1;
    }
    if (!strcmp(mode, "memory")) {
        size_t length = 128U * 1024U * 1024U;
        unsigned char *memory = (unsigned char *)mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (memory == MAP_FAILED) { puts("memory-limited"); return 0; }
        memory[0] = 1U;
        memory[length - 4096U] = 1U;
        (void)munmap(memory, length);
        return 1;
    }
    if (!strcmp(mode, "file")) {
        int file;
        char buffer[8192];
        ssize_t first;
        ssize_t second;
        int write_error;
        memset(buffer, 7, sizeof(buffer));
        signal(SIGXFSZ, SIG_IGN);
        file = open("s8-runner-contract-output.bin", O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (file < 0) return 1;
        first = write(file, buffer, sizeof(buffer));
        second = first >= 0 ? write(file, buffer, sizeof(buffer)) : -1;
        write_error = errno;
        (void)close(file);
        (void)unlink("s8-runner-contract-output.bin");
        if ((first < 0 || second < 0) && write_error == EFBIG) { puts("file-limited"); return 0; }
        return 1;
    }
    if (!strcmp(mode, "sleep")) {
        struct timespec delay = { 2, 0 };
        (void)nanosleep(&delay, NULL);
        return 1;
    }
    if (!strcmp(mode, "stdout")) {
        char buffer[4096];
        memset(buffer, 'o', sizeof(buffer));
        (void)(write(STDOUT_FILENO, buffer, sizeof(buffer)) < 0);
        return 0;
    }
    if (!strcmp(mode, "stderr")) {
        char buffer[4096];
        memset(buffer, 'e', sizeof(buffer));
        (void)(write(STDERR_FILENO, buffer, sizeof(buffer)) < 0);
        return 0;
    }
    return 2;
}

static int receipt_has_limits(const char *receipt, const runner_case *test_case)
{
    char requested[1024];
    char applied[512];
    char observed[512];
    (void)snprintf(requested, sizeof(requested),
        "\"requested\":{\"rlimitAsBytes\":%s,\"rlimitFsizeBytes\":%s,\"rlimitCpuSeconds\":%s,\"rlimitNproc\":64,\"wallTimeoutMs\":%s,\"stdoutBytes\":%s,\"stderrBytes\":%s,\"maxChildren\":0}",
        test_case->address_space_bytes, test_case->file_bytes, test_case->cpu_seconds, test_case->timeout_ms, test_case->stdout_bytes, test_case->stderr_bytes);
    (void)snprintf(applied, sizeof(applied),
        "\"appliedByChild\":{\"rlimitAsBytes\":%s,\"rlimitFsizeBytes\":%s,\"rlimitCpuSeconds\":%s,\"rlimitNproc\":64,\"noNewPrivs\":1,\"seccompMode\":2}",
        test_case->address_space_bytes, test_case->file_bytes, test_case->cpu_seconds);
    (void)snprintf(observed, sizeof(observed),
        "\"observedByRunnerParent\":{\"rlimitAsBytes\":%s,\"rlimitFsizeBytes\":%s,\"rlimitCpuSeconds\":%s,\"rlimitNproc\":64,\"noNewPrivs\":1,\"seccompMode\":2}",
        test_case->address_space_bytes, test_case->file_bytes, test_case->cpu_seconds);
    return strstr(receipt, requested) != NULL && strstr(receipt, applied) != NULL && strstr(receipt, observed) != NULL;
}

static int run_case(const char *runner, const char *target_executable, const runner_case *test_case, const char **observation)
{
    int output_pipe[2] = {-1, -1};
    int error_pipe[2] = {-1, -1};
    pid_t child;
    int status = 0;
    char *output = NULL;
    char *errors = NULL;
    char *newline;
    char result_fragment[256];
    const char *failure_stage = "harness-setup-failed";
    int passed = 0;

    if (pipe(output_pipe) != 0 || pipe(error_pipe) != 0) {
        failure_stage = "pipe-setup-failed";
        goto done;
    }
    child = fork();
    if (child < 0) {
        failure_stage = "runner-fork-failed";
        goto done;
    }
    if (child == 0) {
        (void)dup2(output_pipe[1], STDOUT_FILENO);
        (void)dup2(error_pipe[1], STDERR_FILENO);
        close(output_pipe[0]); close(output_pipe[1]); close(error_pipe[0]); close(error_pipe[1]);
        execl(runner, runner,
            "--address-space-bytes", test_case->address_space_bytes,
            "--file-bytes", test_case->file_bytes,
            "--timeout-ms", test_case->timeout_ms,
            "--stdout-bytes", test_case->stdout_bytes,
            "--stderr-bytes", test_case->stderr_bytes,
            "--max-children", "0",
            "--", target_executable, "--child", test_case->mode,
            (char *)NULL);
        _exit(127);
    }
    close(output_pipe[1]); output_pipe[1] = -1;
    close(error_pipe[1]); error_pipe[1] = -1;
    if (waitpid(child, &status, 0) < 0) {
        failure_stage = "runner-wait-failed";
        goto done;
    }
    if (!read_all(output_pipe[0], &output) || !read_all(error_pipe[0], &errors)) {
        failure_stage = "runner-output-read-failed";
        goto done;
    }
    newline = strchr(output, '\n');
    if (strncmp(output, RECEIPT_PREFIX, strlen(RECEIPT_PREFIX)) != 0) {
        failure_stage = "receipt-prefix-missing";
        goto done;
    }
    if (!newline) {
        failure_stage = "receipt-framing-mismatch";
        goto done;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != test_case->expected_status) {
        failure_stage = "runner-exit-mismatch";
        goto done;
    }
    if (strstr(output, RECEIPT_SCHEMA) == NULL || strstr(output, RECEIPT_PROTOCOL) == NULL || strstr(output, RECEIPT_POLICY) == NULL) {
        failure_stage = "receipt-schema-mismatch";
        goto done;
    }
    if (!receipt_has_limits(output, test_case)) {
        failure_stage = "requested-applied-mismatch";
        goto done;
    }
    if (strstr(output, "\"runnerParentVerification\":{\"status\":\"PASS\",\"mismatchCode\":null}") == NULL) {
        failure_stage = "runner-parent-verification-mismatch";
        goto done;
    }
    if (!has_sha256_after(output, "\"runnerBinary\":{\"selfSha256\":\"")) {
        failure_stage = "runner-sha-mismatch";
        goto done;
    }
    (void)snprintf(result_fragment, sizeof(result_fragment), "\"result\":{\"code\":%d,\"name\":\"%s\",\"terminationClass\":\"%s\"", test_case->expected_code, test_case->expected_name, test_case->expected_termination);
    if (strstr(output, result_fragment) == NULL) {
        failure_stage = "result-code-mismatch";
        goto done;
    }
    if (test_case->receipt_extra != NULL && strstr(output, test_case->receipt_extra) == NULL) {
        failure_stage = "receipt-detail-mismatch";
        goto done;
    }
    if (test_case->target_output != NULL && strstr(newline + 1, test_case->target_output) == NULL) {
        failure_stage = "target-output-mismatch";
        goto done;
    }
    passed = 1;

done:
    if (output_pipe[0] >= 0) close(output_pipe[0]);
    if (output_pipe[1] >= 0) close(output_pipe[1]);
    if (error_pipe[0] >= 0) close(error_pipe[0]);
    if (error_pipe[1] >= 0) close(error_pipe[1]);
    free(output);
    free(errors);
    if (observation != NULL) *observation = passed ? "code-and-v2-evidence-verified" : failure_stage;
    return passed;
}

static const runner_case *find_case(const char *name)
{
    static const runner_case cases[] = {
        { "ordinary_exec", "ordinary", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "fork_denied", "fork", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "fork-blocked", NULL },
        { "vfork_denied", "vfork", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "vfork-blocked", NULL },
        { "clone_non_thread_denied", "clone", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "clone-blocked", NULL },
        { "clone3_enosys", "clone3", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "clone3-blocked", NULL },
        { "pthread_allowed", "thread", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "thread-allowed", NULL },
        { "x32_abi_rejected", "x32", "268435456", "1048576", "1000", "2", "1024", "1024", 77, 77, "S8_RUNNER_TARGET_SIGNAL", "target-signal", NULL, "\"targetSignal\":31" },
        { "memory_limit", "memory", "67108864", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "memory-limited", NULL },
        { "file_limit", "file", "268435456", "4096", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "file-limited", NULL },
        { "timeout", "sleep", "268435456", "1048576", "100", "2", "1024", "1024", 124, 124, "S8_RUNNER_TIMEOUT", "wall-timeout", NULL, NULL },
        { "stdout_limit", "stdout", "268435456", "1048576", "1000", "2", "256", "1024", 74, 74, "S8_RUNNER_STDOUT_LIMIT", "stdout-limit", NULL, NULL },
        { "stderr_limit", "stderr", "268435456", "1048576", "1000", "2", "1024", "256", 75, 75, "S8_RUNNER_STDERR_LIMIT", "stderr-limit", NULL, NULL },
        { "receipt_schema", "ordinary", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "runner_sha256", "ordinary", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "applied_rlimit_as", "ordinary", "67108864", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "applied_rlimit_fsize", "ordinary", "268435456", "4096", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "applied_timeout", "ordinary", "268435456", "1048576", "321", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "applied_output_caps", "ordinary", "268435456", "1048576", "1000", "2", "256", "384", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", NULL },
        { "max_children_zero", "ordinary", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", "\"maxChildren\":0" },
        { "seccomp_filter_installed", "ordinary", "268435456", "1048576", "1000", "2", "1024", "1024", 0, 0, "S8_RUNNER_SUCCESS", "target-exit-zero", "ordinary-ok", "\"seccompMode\":2" },
    };
    size_t index;
    for (index = 0U; index < sizeof(cases) / sizeof(cases[0]); index++) if (!strcmp(cases[index].name, name)) return &cases[index];
    return NULL;
}

int main(int argc, char **argv)
{
    const runner_case *test_case;
    const char *observation = "harness-setup-failed";
    char contract_test_executable[SELF_EXECUTABLE_CAPACITY];
    int passed;
    if (argc == 3 && !strcmp(argv[1], "--child")) return child_mode(argv[2]);
    if (argc != 4 || strcmp(argv[1], "--case") != 0) return 2;
    test_case = find_case(argv[2]);
    if (!test_case) return 2;
    if (!resolve_contract_test_executable(contract_test_executable, sizeof(contract_test_executable))) {
        printf("CASE=s8-runner.%s\n", test_case->name);
        printf("EXPECTED=code=%d;name=%s;termination=%s\n", test_case->expected_code, test_case->expected_name, test_case->expected_termination);
        printf("OBSERVED=test-executable-resolution-failed\n");
        printf("RESULT=FAIL\n");
        return 1;
    }
    passed = run_case(argv[3], contract_test_executable, test_case, &observation);
    printf("CASE=s8-runner.%s\n", test_case->name);
    printf("EXPECTED=code=%d;name=%s;termination=%s\n", test_case->expected_code, test_case->expected_name, test_case->expected_termination);
    printf("OBSERVED=%s\n", observation);
    printf("RESULT=%s\n", passed ? "PASS" : "FAIL");
    return passed ? 0 : 1;
}
