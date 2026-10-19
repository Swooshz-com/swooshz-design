#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
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

#if !defined(SYS_clone) || !defined(SYS_clone3)
#error "s8-process-runner-contract-tests requires clone and clone3 syscall numbers"
#endif

typedef struct {
    const char *mode;
    const char *address_space_bytes;
    const char *file_bytes;
    const char *timeout_ms;
    const char *stdout_bytes;
    const char *stderr_bytes;
    int expected_status;
    const char *expected_output;
} runner_case;

static int read_all(int fd, char **result)
{
    size_t length = 0;
    size_t capacity = 4096;
    char *value = (char *)malloc(capacity);
    if (!value) return 0;
    for (;;) {
        ssize_t count;
        if (length + 1 >= capacity) {
            char *grown;
            capacity *= 2;
            if (capacity > 4u * 1024u * 1024u) { free(value); return 0; }
            grown = (char *)realloc(value, capacity);
            if (!grown) { free(value); return 0; }
            value = grown;
        }
        count = read(fd, value + length, capacity - length - 1);
        if (count == 0) break;
        if (count < 0) { free(value); return 0; }
        length += (size_t)count;
    }
    value[length] = '\0';
    *result = value;
    return 1;
}

static int has_hex_sha256(const char *text)
{
    size_t index;
    if (!text || strlen(text) < 64u) return 0;
    for (index = 0; index < 64u; index++) {
        if (!((text[index] >= '0' && text[index] <= '9') || (text[index] >= 'a' && text[index] <= 'f'))) return 0;
    }
    return 1;
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
        errno = 0;
        if (syscall(SYS_clone3, NULL, 0u) < 0 && errno == ENOSYS) { puts("clone3-blocked"); return 0; }
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
    if (!strcmp(mode, "memory")) {
        size_t length = 128u * 1024u * 1024u;
        unsigned char *memory = (unsigned char *)malloc(length);
        if (memory) {
            size_t index;
            for (index = 0; index < length; index += 4096u) memory[index] = 1u;
            free(memory);
            return 1;
        }
        puts("memory-limited");
        return 0;
    }
    if (!strcmp(mode, "file")) {
        int file;
        char buffer[8192];
        ssize_t count;
        ssize_t second;
        int write_error;
        memset(buffer, 7, sizeof(buffer));
        signal(SIGXFSZ, SIG_IGN);
        file = open("s8-runner-contract-output.bin", O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (file < 0) return 1;
        count = write(file, buffer, sizeof(buffer));
        second = count >= 0 ? write(file, buffer, sizeof(buffer)) : -1;
        write_error = errno;
        close(file);
        unlink("s8-runner-contract-output.bin");
        if ((count < 0 || second < 0) && write_error == EFBIG) { puts("file-limited"); return 0; }
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
        (void)write(STDOUT_FILENO, buffer, sizeof(buffer));
        return 0;
    }
    if (!strcmp(mode, "stderr")) {
        char buffer[4096];
        memset(buffer, 'e', sizeof(buffer));
        (void)write(STDERR_FILENO, buffer, sizeof(buffer));
        return 0;
    }
    return 2;
}

static int run_case(const char *runner, const runner_case *test_case)
{
    int output_pipe[2];
    int error_pipe[2];
    pid_t child;
    int status;
    char *output = NULL;
    char *errors = NULL;
    if (pipe(output_pipe) != 0 || pipe(error_pipe) != 0) return 0;
    child = fork();
    if (child < 0) return 0;
    if (child == 0) {
        dup2(output_pipe[1], STDOUT_FILENO);
        dup2(error_pipe[1], STDERR_FILENO);
        close(output_pipe[0]); close(output_pipe[1]); close(error_pipe[0]); close(error_pipe[1]);
        execl(runner, runner,
            "--address-space-bytes", test_case->address_space_bytes,
            "--file-bytes", test_case->file_bytes,
            "--timeout-ms", test_case->timeout_ms,
            "--stdout-bytes", test_case->stdout_bytes,
            "--stderr-bytes", test_case->stderr_bytes,
            "--max-children", "0",
            "--", "/proc/self/exe", "--child", test_case->mode,
            (char *)NULL);
        _exit(127);
    }
    close(output_pipe[1]); close(error_pipe[1]);
    if (waitpid(child, &status, 0) < 0 || !read_all(output_pipe[0], &output) || !read_all(error_pipe[0], &errors)) {
        close(output_pipe[0]); close(error_pipe[0]);
        free(output); free(errors);
        return 0;
    }
    close(output_pipe[0]); close(error_pipe[0]);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != test_case->expected_status) {
        free(output); free(errors);
        return 0;
    }
    if (strncmp(output, "S8_RUNNER_RECEIPT:{", 19) != 0 || !strstr(output, "\"schemaVersion\":\"s8-process-runner-receipt-v1\"") || !strstr(output, "\"protocol\":\"s8-process-runner-receipt-v1\"") || !strstr(output, "\"seccompPolicy\":\"s8-zero-child-seccomp-v1\"") || !strstr(output, "\"limitsApplied\":true") || !strstr(output, "\"seccompEnabled\":true") || !strstr(output, "\"filterInstalled\":true")) {
        free(output); free(errors);
        return 0;
    }
    {
        char expected_limits[1024];
        (void)snprintf(expected_limits, sizeof(expected_limits),
            "\"requestedAddressSpaceBytes\":%s,\"appliedAddressSpaceBytes\":%s,\"requestedFileBytes\":%s,\"appliedFileBytes\":%s,\"requestedTimeoutMs\":%s,\"appliedTimeoutMs\":%s,\"requestedStdoutBytes\":%s,\"appliedStdoutBytes\":%s,\"requestedStderrBytes\":%s,\"appliedStderrBytes\":%s,\"requestedMaxChildren\":0,\"appliedMaxChildren\":0",
            test_case->address_space_bytes, test_case->address_space_bytes, test_case->file_bytes, test_case->file_bytes,
            test_case->timeout_ms, test_case->timeout_ms, test_case->stdout_bytes, test_case->stdout_bytes,
            test_case->stderr_bytes, test_case->stderr_bytes);
        if (!strstr(output, expected_limits)) {
            free(output); free(errors);
            return 0;
        }
    }
    {
        char *runner_sha = strstr(output, "\"runnerSha256\":\"");
        if (!runner_sha || !has_hex_sha256(runner_sha + strlen("\"runnerSha256\":\""))) {
            free(output); free(errors);
            return 0;
        }
    }
    if (test_case->expected_output && !strstr(output, test_case->expected_output)) {
        free(output); free(errors);
        return 0;
    }
    free(output);
    free(errors);
    return 1;
}

int main(int argc, char **argv)
{
    static const runner_case cases[] = {
        { "ordinary", "268435456", "1048576", "1000", "1024", "1024", 0, "ordinary-ok" },
        { "fork", "268435456", "1048576", "1000", "1024", "1024", 0, "fork-blocked" },
        { "vfork", "268435456", "1048576", "1000", "1024", "1024", 0, "vfork-blocked" },
        { "clone", "268435456", "1048576", "1000", "1024", "1024", 0, "clone-blocked" },
        { "clone3", "268435456", "1048576", "1000", "1024", "1024", 0, "clone3-blocked" },
        { "thread", "268435456", "1048576", "1000", "1024", "1024", 0, "thread-allowed" },
        { "memory", "67108864", "1048576", "1000", "1024", "1024", 0, "memory-limited" },
        { "file", "268435456", "4096", "1000", "1024", "1024", 0, "file-limited" },
        { "sleep", "268435456", "1048576", "100", "1024", "1024", 124, NULL },
        { "stdout", "268435456", "1048576", "1000", "256", "1024", 125, NULL },
        { "stderr", "268435456", "1048576", "1000", "1024", "256", 125, NULL },
    };
    size_t index;
    if (argc == 3 && !strcmp(argv[1], "--child")) return child_mode(argv[2]);
    if (argc != 2) return 2;
    for (index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) if (!run_case(argv[1], &cases[index])) return 1;
    puts("s8-process-runner-contract: seccomp, limits, receipt, and execution contract passed");
    return 0;
}
