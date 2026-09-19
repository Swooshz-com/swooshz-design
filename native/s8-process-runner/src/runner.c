#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error "s8-process-runner requires Linux x86_64"
#endif

#if !defined(SYS_clone) || !defined(SYS_clone3) || !defined(SYS_fork) || !defined(SYS_vfork)
#error "s8-process-runner requires clone, clone3, fork, and vfork syscall numbers"
#endif

#define RUNNER_RECEIPT_PREFIX "S8_RUNNER_RECEIPT:"
#define RUNNER_RECEIPT_SCHEMA "s8-process-runner-receipt-v1"
#define RUNNER_SECCOMP_POLICY "s8-zero-child-seccomp-v1"

typedef struct {
    uint64_t address_space_bytes;
    uint64_t file_bytes;
    uint64_t timeout_ms;
    uint64_t stdout_bytes;
    uint64_t stderr_bytes;
    uint64_t max_children;
    int command_index;
} runner_options;

typedef struct {
    unsigned char *data;
    size_t length;
    size_t capacity;
    size_t limit;
    int fd;
    int closed;
} capture;

typedef struct {
    uint32_t state[8];
    uint64_t bit_count;
    unsigned char buffer[64];
    size_t buffer_length;
} sha256_context;

static const uint32_t SHA256_INITIAL_STATE[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
};

static const uint32_t SHA256_ROUND_CONSTANTS[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static uint32_t rotate_right(uint32_t value, unsigned int amount)
{
    return (value >> amount) | (value << (32u - amount));
}

static uint32_t read_u32_be(const unsigned char *value)
{
    return ((uint32_t)value[0] << 24u) | ((uint32_t)value[1] << 16u) | ((uint32_t)value[2] << 8u) | (uint32_t)value[3];
}

static void write_u32_be(unsigned char *value, uint32_t number)
{
    value[0] = (unsigned char)(number >> 24u);
    value[1] = (unsigned char)(number >> 16u);
    value[2] = (unsigned char)(number >> 8u);
    value[3] = (unsigned char)number;
}

static void sha256_transform(sha256_context *context, const unsigned char *block)
{
    uint32_t schedule[64];
    uint32_t a, b, c, d, e, f, g, h;
    size_t index;
    for (index = 0; index < 16; index++) schedule[index] = read_u32_be(block + index * 4u);
    for (index = 16; index < 64; index++) {
        uint32_t s0 = rotate_right(schedule[index - 15u], 7u) ^ rotate_right(schedule[index - 15u], 18u) ^ (schedule[index - 15u] >> 3u);
        uint32_t s1 = rotate_right(schedule[index - 2u], 17u) ^ rotate_right(schedule[index - 2u], 19u) ^ (schedule[index - 2u] >> 10u);
        schedule[index] = schedule[index - 16u] + s0 + schedule[index - 7u] + s1;
    }
    a = context->state[0]; b = context->state[1]; c = context->state[2]; d = context->state[3];
    e = context->state[4]; f = context->state[5]; g = context->state[6]; h = context->state[7];
    for (index = 0; index < 64; index++) {
        uint32_t s1 = rotate_right(e, 6u) ^ rotate_right(e, 11u) ^ rotate_right(e, 25u);
        uint32_t choice = (e & f) ^ ((~e) & g);
        uint32_t temporary1 = h + s1 + choice + SHA256_ROUND_CONSTANTS[index] + schedule[index];
        uint32_t s0 = rotate_right(a, 2u) ^ rotate_right(a, 13u) ^ rotate_right(a, 22u);
        uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temporary2 = s0 + majority;
        h = g; g = f; f = e; e = d + temporary1; d = c; c = b; b = a; a = temporary1 + temporary2;
    }
    context->state[0] += a; context->state[1] += b; context->state[2] += c; context->state[3] += d;
    context->state[4] += e; context->state[5] += f; context->state[6] += g; context->state[7] += h;
}

static void sha256_init(sha256_context *context)
{
    memcpy(context->state, SHA256_INITIAL_STATE, sizeof(context->state));
    context->bit_count = 0;
    context->buffer_length = 0;
}

static void sha256_update(sha256_context *context, const unsigned char *data, size_t length)
{
    context->bit_count += (uint64_t)length * 8u;
    while (length > 0) {
        size_t available = sizeof(context->buffer) - context->buffer_length;
        size_t count = length < available ? length : available;
        memcpy(context->buffer + context->buffer_length, data, count);
        context->buffer_length += count;
        data += count;
        length -= count;
        if (context->buffer_length == sizeof(context->buffer)) {
            sha256_transform(context, context->buffer);
            context->buffer_length = 0;
        }
    }
}

static void sha256_final(sha256_context *context, unsigned char digest[32])
{
    uint64_t bit_count = context->bit_count;
    size_t index;
    context->buffer[context->buffer_length++] = 0x80u;
    if (context->buffer_length > 56u) {
        while (context->buffer_length < sizeof(context->buffer)) context->buffer[context->buffer_length++] = 0;
        sha256_transform(context, context->buffer);
        context->buffer_length = 0;
    }
    while (context->buffer_length < 56u) context->buffer[context->buffer_length++] = 0;
    for (index = 0; index < 8; index++) context->buffer[56u + index] = (unsigned char)(bit_count >> (56u - index * 8u));
    sha256_transform(context, context->buffer);
    for (index = 0; index < 8; index++) write_u32_be(digest + index * 4u, context->state[index]);
}

static int runner_sha256(char output[65])
{
    char path[PATH_MAX];
    unsigned char buffer[8192];
    unsigned char digest[32];
    sha256_context context;
    ssize_t path_length;
    int file;
    ssize_t count;
    size_t index;
    static const char hex[] = "0123456789abcdef";
    path_length = readlink("/proc/self/exe", path, sizeof(path) - 1u);
    if (path_length <= 0 || (size_t)path_length >= sizeof(path)) return 0;
    path[path_length] = '\0';
    file = open(path, O_RDONLY | O_CLOEXEC);
    if (file < 0) return 0;
    sha256_init(&context);
    for (;;) {
        count = read(file, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0) { close(file); return 0; }
        sha256_update(&context, buffer, (size_t)count);
    }
    if (close(file) != 0) return 0;
    sha256_final(&context, digest);
    for (index = 0; index < sizeof(digest); index++) {
        output[index * 2u] = hex[digest[index] >> 4u];
        output[index * 2u + 1u] = hex[digest[index] & 0x0fu];
    }
    output[64] = '\0';
    return 1;
}

static void usage(void)
{
    fprintf(stderr, "usage: s8-process-runner --address-space-bytes N --file-bytes N --timeout-ms N --stdout-bytes N --stderr-bytes N --max-children N -- command [args...]\n");
}

static int parse_u64(const char *text, uint64_t *value)
{
    char *end = NULL;
    unsigned long long parsed;
    if (!text || !*text) return 0;
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno || !end || *end || parsed == 0) return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int parse_nonnegative_u64(const char *text, uint64_t *value)
{
    char *end = NULL;
    unsigned long long parsed;
    if (!text || !*text) return 0;
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno || !end || *end) return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int parse_options(int argc, char **argv, runner_options *options)
{
    int index;
    memset(options, 0, sizeof(*options));
    options->max_children = 0;
    for (index = 1; index < argc; index++) {
        if (!strcmp(argv[index], "--")) {
            options->command_index = index + 1;
            break;
        }
        if (index + 1 >= argc) return 0;
        if (!strcmp(argv[index], "--address-space-bytes")) {
            if (!parse_u64(argv[++index], &options->address_space_bytes)) return 0;
        } else if (!strcmp(argv[index], "--file-bytes")) {
            if (!parse_u64(argv[++index], &options->file_bytes)) return 0;
        } else if (!strcmp(argv[index], "--timeout-ms")) {
            if (!parse_u64(argv[++index], &options->timeout_ms)) return 0;
        } else if (!strcmp(argv[index], "--stdout-bytes")) {
            if (!parse_u64(argv[++index], &options->stdout_bytes)) return 0;
        } else if (!strcmp(argv[index], "--stderr-bytes")) {
            if (!parse_u64(argv[++index], &options->stderr_bytes)) return 0;
        } else if (!strcmp(argv[index], "--max-children")) {
            if (!parse_nonnegative_u64(argv[++index], &options->max_children)) return 0;
        } else {
            return 0;
        }
    }
    if (options->command_index == 0 || options->command_index >= argc || options->address_space_bytes == 0 || options->file_bytes == 0 || options->timeout_ms == 0 || options->stdout_bytes == 0 || options->stderr_bytes == 0 || options->max_children != 0) return 0;
    return 1;
}

static int set_limit(int resource, uint64_t value)
{
    struct rlimit limit;
    limit.rlim_cur = (rlim_t)value;
    limit.rlim_max = (rlim_t)value;
    return setrlimit(resource, &limit);
}

static int install_seccomp_filter(void)
{
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)SYS_fork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)SYS_vfork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)SYS_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, (uint32_t)CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { (unsigned short)(sizeof(filter) / sizeof(filter[0])), filter };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) == 0;
}

static int child_limits(const runner_options *options)
{
    uint64_t cpu_seconds = (options->timeout_ms + 999) / 1000 + 1;
    if (set_limit(RLIMIT_AS, options->address_space_bytes) != 0) return 0;
    if (set_limit(RLIMIT_FSIZE, options->file_bytes) != 0) return 0;
    if (set_limit(RLIMIT_CPU, cpu_seconds) != 0) return 0;
#ifdef RLIMIT_NPROC
    /* Seccomp is the exact zero-child boundary; leave room for CLONE_THREAD. */
    if (set_limit(RLIMIT_NPROC, 64) != 0) return 0;
#endif
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 0;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 0;
    if (getppid() != getpid() && getppid() == 1) return 0;
    if (!install_seccomp_filter()) return 0;
    return 1;
}

static int write_receipt(const runner_options *options)
{
    char runner_sha256[65];
    if (!runner_sha256(runner_sha256)) return 0;
    if (printf(RUNNER_RECEIPT_PREFIX
               "{\"schemaVersion\":\"%s\",\"protocol\":\"%s\",\"runnerSha256\":\"%s\","
               "\"requestedAddressSpaceBytes\":%llu,\"appliedAddressSpaceBytes\":%llu,"
               "\"requestedFileBytes\":%llu,\"appliedFileBytes\":%llu,"
               "\"requestedTimeoutMs\":%llu,\"appliedTimeoutMs\":%llu,"
               "\"requestedStdoutBytes\":%llu,\"appliedStdoutBytes\":%llu,"
               "\"requestedStderrBytes\":%llu,\"appliedStderrBytes\":%llu,"
               "\"requestedMaxChildren\":%llu,\"appliedMaxChildren\":%llu,"
               "\"seccompPolicy\":\"%s\",\"limitsApplied\":true,\"seccompEnabled\":true,\"filterInstalled\":true}\n",
               RUNNER_RECEIPT_SCHEMA, RUNNER_RECEIPT_SCHEMA, runner_sha256,
               (unsigned long long)options->address_space_bytes, (unsigned long long)options->address_space_bytes,
               (unsigned long long)options->file_bytes, (unsigned long long)options->file_bytes,
               (unsigned long long)options->timeout_ms, (unsigned long long)options->timeout_ms,
               (unsigned long long)options->stdout_bytes, (unsigned long long)options->stdout_bytes,
               (unsigned long long)options->stderr_bytes, (unsigned long long)options->stderr_bytes,
               (unsigned long long)options->max_children, (unsigned long long)options->max_children,
               RUNNER_SECCOMP_POLICY) < 0) return 0;
    return fflush(stdout) == 0;
}

static uint64_t now_ms(void)
{
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static int set_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int capture_init(capture *value, int fd, size_t limit)
{
    value->data = (unsigned char *)malloc(limit ? limit : 1);
    if (!value->data) return 0;
    value->length = 0;
    value->capacity = limit;
    value->limit = limit;
    value->fd = fd;
    value->closed = 0;
    return set_nonblocking(fd);
}

static int capture_read(capture *value)
{
    unsigned char buffer[8192];
    for (;;) {
        ssize_t count = read(value->fd, buffer, sizeof(buffer));
        if (count == 0) {
            value->closed = 1;
            close(value->fd);
            return 1;
        }
        if (count < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
            return 0;
        }
        if ((size_t)count > value->limit - value->length) return 0;
        memcpy(value->data + value->length, buffer, (size_t)count);
        value->length += (size_t)count;
    }
}

static void kill_process_group(pid_t pid)
{
    if (kill(-pid, SIGKILL) != 0) (void)kill(pid, SIGKILL);
}

static int write_capture(const capture *value, FILE *stream)
{
    return value->length == 0 || fwrite(value->data, 1, value->length, stream) == value->length;
}

int main(int argc, char **argv)
{
    runner_options options;
    int output_pipe[2] = {-1, -1};
    int error_pipe[2] = {-1, -1};
    int status_pipe[2] = {-1, -1};
    pid_t child;
    int status = 0;
    int killed = 0;
    int timed_out = 0;
    int output_limited = 0;
    unsigned char child_ready = 0;
    capture output;
    capture errors;
    if (!parse_options(argc, argv, &options)) { usage(); return 2; }
    memset(&output, 0, sizeof(output));
    memset(&errors, 0, sizeof(errors));
    if (pipe(output_pipe) != 0 || pipe(error_pipe) != 0 || pipe(status_pipe) != 0) return 125;
    child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        unsigned char ready = 'S';
        unsigned char failed = 'F';
        (void)setpgid(0, 0);
        close(output_pipe[0]);
        close(error_pipe[0]);
        close(status_pipe[0]);
        if (dup2(output_pipe[1], STDOUT_FILENO) < 0 || dup2(error_pipe[1], STDERR_FILENO) < 0 || !child_limits(&options)) {
            (void)write(status_pipe[1], &failed, 1);
            _exit(126);
        }
        if (write(status_pipe[1], &ready, 1) != 1) _exit(126);
        close(status_pipe[1]);
        close(output_pipe[1]);
        close(error_pipe[1]);
        execvp(argv[options.command_index], &argv[options.command_index]);
        _exit(127);
    }
    close(output_pipe[1]);
    close(error_pipe[1]);
    close(status_pipe[1]);
    (void)setpgid(child, child);
    if (read(status_pipe[0], &child_ready, 1) != 1 || child_ready != 'S') {
        close(status_pipe[0]);
        kill_process_group(child);
        (void)waitpid(child, &status, 0);
        close(output_pipe[0]);
        close(error_pipe[0]);
        return 126;
    }
    close(status_pipe[0]);
    if (!write_receipt(&options)) {
        kill_process_group(child);
        (void)waitpid(child, &status, 0);
        close(output_pipe[0]);
        close(error_pipe[0]);
        return 125;
    }
    if (!capture_init(&output, output_pipe[0], (size_t)options.stdout_bytes) || !capture_init(&errors, error_pipe[0], (size_t)options.stderr_bytes)) {
        kill_process_group(child);
        (void)waitpid(child, &status, 0);
        return 125;
    }
    while (!output.closed || !errors.closed || waitpid(child, &status, WNOHANG) == 0) {
        struct pollfd descriptors[2];
        int descriptor_count = 2;
        descriptors[0].fd = output.fd;
        descriptors[0].events = output.closed ? 0 : POLLIN;
        descriptors[1].fd = errors.fd;
        descriptors[1].events = errors.closed ? 0 : POLLIN;
        if (poll(descriptors, descriptor_count, 25) < 0 && errno != EINTR) break;
        if (!output.closed && !capture_read(&output)) { output_limited = 1; break; }
        if (!errors.closed && !capture_read(&errors)) { output_limited = 1; break; }
        if (!killed) {
            static uint64_t started = 0;
            if (started == 0) started = now_ms();
            if (now_ms() - started > options.timeout_ms) { timed_out = 1; killed = 1; kill_process_group(child); }
        }
        if (waitpid(child, &status, WNOHANG) == child && output.closed && errors.closed) break;
    }
    if (!killed && !timed_out && !output_limited) (void)waitpid(child, &status, 0);
    if (timed_out || output_limited) {
        if (!killed) kill_process_group(child);
        (void)waitpid(child, &status, 0);
    }
    if (!output.closed) (void)capture_read(&output);
    if (!errors.closed) (void)capture_read(&errors);
    (void)write_capture(&output, stdout);
    (void)write_capture(&errors, stderr);
    free(output.data);
    free(errors.data);
    if (timed_out) return 124;
    if (output_limited) return 125;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 125;
}
