#define _GNU_SOURCE

#include <asm/unistd.h>
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

#ifndef SYS_clone3
#define SYS_clone3 435
#endif
#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000U
#endif

#define RECEIPT_PREFIX "S8_RUNNER_RECEIPT:"
#define RECEIPT_SCHEMA "s8-process-runner-receipt-v2"
#define POLICY_ID "s8-zero-child-seccomp-x86_64-v2"
#define EVIDENCE_MAGIC 0x53385232U
#define EVIDENCE_VERSION 2U
#define MAX_CAPTURE_BYTES (64ULL * 1024ULL * 1024ULL)

enum result_code {
    RESULT_SUCCESS = 0,
    RESULT_ARGUMENT_INVALID = 64,
    RESULT_INTERNAL = 70,
    RESULT_CHILD_SETUP_FAILED = 71,
    RESULT_EVIDENCE_INVALID = 72,
    RESULT_EXEC_FAILED = 73,
    RESULT_STDOUT_LIMIT = 74,
    RESULT_STDERR_LIMIT = 75,
    RESULT_TARGET_EXIT_NONZERO = 76,
    RESULT_TARGET_SIGNAL = 77,
    RESULT_TIMEOUT = 124
};

enum setup_stage {
    SETUP_NONE = 0,
    SETUP_SETPGID = 1,
    SETUP_PDEATHSIG = 2,
    SETUP_PARENT_CHECK = 3,
    SETUP_RLIMIT_AS = 4,
    SETUP_RLIMIT_FSIZE = 5,
    SETUP_RLIMIT_CPU = 6,
    SETUP_RLIMIT_NPROC = 7,
    SETUP_NO_NEW_PRIVS = 8,
    SETUP_SECCOMP = 9,
    SETUP_CHILD_EVIDENCE = 10,
    SETUP_RELEASE = 11
};

typedef struct {
    uint64_t address_space_bytes;
    uint64_t file_bytes;
    uint64_t timeout_ms;
    uint64_t stdout_bytes;
    uint64_t stderr_bytes;
    uint64_t max_children;
    uint64_t cpu_seconds;
    int command_index;
} runner_options;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t size;
    uint64_t child_pid;
    uint64_t parent_pid;
    uint64_t as_cur;
    uint64_t as_max;
    uint64_t fsize_cur;
    uint64_t fsize_max;
    uint64_t cpu_cur;
    uint64_t cpu_max;
    uint64_t nproc_cur;
    uint64_t nproc_max;
    uint32_t no_new_privs;
    uint32_t seccomp_mode;
    uint32_t setup_stage;
    uint32_t reserved;
} child_evidence;

typedef struct {
    unsigned char *data;
    size_t length;
    size_t limit;
    int fd;
    int closed;
    int overflow;
} capture;

typedef struct {
    uint64_t as_cur;
    uint64_t as_max;
    uint64_t fsize_cur;
    uint64_t fsize_max;
    uint64_t cpu_cur;
    uint64_t cpu_max;
    uint64_t nproc_cur;
    uint64_t nproc_max;
    int no_new_privs;
    int seccomp_mode;
} observed_limits;

typedef struct {
    uint32_t state[8];
    uint64_t bit_count;
    unsigned char buffer[64];
    size_t buffer_length;
} sha256_context;

static const uint32_t SHA256_INITIAL_STATE[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U
};

static const uint32_t SHA256_ROUND_CONSTANTS[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
};

static uint32_t rotate_right(uint32_t value, unsigned int amount)
{
    return (value >> amount) | (value << (32U - amount));
}

static uint32_t read_u32_be(const unsigned char *value)
{
    return ((uint32_t)value[0] << 24U) | ((uint32_t)value[1] << 16U) | ((uint32_t)value[2] << 8U) | (uint32_t)value[3];
}

static void write_u32_be(unsigned char *value, uint32_t number)
{
    value[0] = (unsigned char)(number >> 24U);
    value[1] = (unsigned char)(number >> 16U);
    value[2] = (unsigned char)(number >> 8U);
    value[3] = (unsigned char)number;
}

static void sha256_transform(sha256_context *context, const unsigned char *block)
{
    uint32_t schedule[64];
    uint32_t a, b, c, d, e, f, g, h;
    size_t index;
    for (index = 0; index < 16U; index++) schedule[index] = read_u32_be(block + index * 4U);
    for (index = 16U; index < 64U; index++) {
        uint32_t s0 = rotate_right(schedule[index - 15U], 7U) ^ rotate_right(schedule[index - 15U], 18U) ^ (schedule[index - 15U] >> 3U);
        uint32_t s1 = rotate_right(schedule[index - 2U], 17U) ^ rotate_right(schedule[index - 2U], 19U) ^ (schedule[index - 2U] >> 10U);
        schedule[index] = schedule[index - 16U] + s0 + schedule[index - 7U] + s1;
    }
    a = context->state[0]; b = context->state[1]; c = context->state[2]; d = context->state[3];
    e = context->state[4]; f = context->state[5]; g = context->state[6]; h = context->state[7];
    for (index = 0; index < 64U; index++) {
        uint32_t s1 = rotate_right(e, 6U) ^ rotate_right(e, 11U) ^ rotate_right(e, 25U);
        uint32_t choice = (e & f) ^ ((~e) & g);
        uint32_t temporary1 = h + s1 + choice + SHA256_ROUND_CONSTANTS[index] + schedule[index];
        uint32_t s0 = rotate_right(a, 2U) ^ rotate_right(a, 13U) ^ rotate_right(a, 22U);
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
    context->bit_count = 0U;
    context->buffer_length = 0U;
}

static void sha256_update(sha256_context *context, const unsigned char *data, size_t length)
{
    context->bit_count += (uint64_t)length * 8U;
    while (length > 0U) {
        size_t available = sizeof(context->buffer) - context->buffer_length;
        size_t count = length < available ? length : available;
        memcpy(context->buffer + context->buffer_length, data, count);
        context->buffer_length += count;
        data += count;
        length -= count;
        if (context->buffer_length == sizeof(context->buffer)) {
            sha256_transform(context, context->buffer);
            context->buffer_length = 0U;
        }
    }
}

static void sha256_final(sha256_context *context, unsigned char digest[32])
{
    uint64_t bit_count = context->bit_count;
    size_t index;
    context->buffer[context->buffer_length++] = 0x80U;
    if (context->buffer_length > 56U) {
        while (context->buffer_length < sizeof(context->buffer)) context->buffer[context->buffer_length++] = 0U;
        sha256_transform(context, context->buffer);
        context->buffer_length = 0U;
    }
    while (context->buffer_length < 56U) context->buffer[context->buffer_length++] = 0U;
    for (index = 0; index < 8U; index++) context->buffer[56U + index] = (unsigned char)(bit_count >> (56U - index * 8U));
    sha256_transform(context, context->buffer);
    for (index = 0; index < 8U; index++) write_u32_be(digest + index * 4U, context->state[index]);
}

static int runner_sha256(char output[65])
{
    char path[PATH_MAX];
    unsigned char buffer[8192];
    unsigned char digest[32];
    sha256_context context;
    ssize_t path_length = readlink("/proc/self/exe", path, sizeof(path) - 1U);
    int file;
    ssize_t count;
    size_t index;
    static const char hex[] = "0123456789abcdef";
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
        output[index * 2U] = hex[digest[index] >> 4U];
        output[index * 2U + 1U] = hex[digest[index] & 0x0FU];
    }
    output[64] = '\0';
    return 1;
}

static uint64_t monotonic_ms(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0U;
    return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}

static int write_full(int fd, const void *data, size_t length)
{
    const unsigned char *bytes = (const unsigned char *)data;
    size_t written = 0U;
    while (written < length) {
        ssize_t count = write(fd, bytes + written, length - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        written += (size_t)count;
    }
    return 1;
}

static int read_full(int fd, void *data, size_t length)
{
    unsigned char *bytes = (unsigned char *)data;
    size_t read_bytes = 0U;
    while (read_bytes < length) {
        ssize_t count = read(fd, bytes + read_bytes, length - read_bytes);
        if (count < 0 && errno == EINTR) continue;
        if (count == 0) return 0;
        if (count < 0) return -1;
        read_bytes += (size_t)count;
    }
    return 1;
}

static int parse_u64(const char *text, uint64_t *value, int allow_zero)
{
    char *end = NULL;
    unsigned long long parsed;
    if (!text || !*text) return 0;
    errno = 0;
    parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || !end || *end != '\0') return 0;
    if (!allow_zero && parsed == 0ULL) return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int parse_options(int argc, char **argv, runner_options *options)
{
    int index;
    memset(options, 0, sizeof(*options));
    for (index = 1; index < argc; index++) {
        if (!strcmp(argv[index], "--")) { options->command_index = index + 1; break; }
        if (index + 1 >= argc) return 0;
        if (!strcmp(argv[index], "--address-space-bytes")) {
            if (!parse_u64(argv[++index], &options->address_space_bytes, 0)) return 0;
        } else if (!strcmp(argv[index], "--file-bytes")) {
            if (!parse_u64(argv[++index], &options->file_bytes, 0)) return 0;
        } else if (!strcmp(argv[index], "--timeout-ms")) {
            if (!parse_u64(argv[++index], &options->timeout_ms, 0)) return 0;
        } else if (!strcmp(argv[index], "--stdout-bytes")) {
            if (!parse_u64(argv[++index], &options->stdout_bytes, 0)) return 0;
        } else if (!strcmp(argv[index], "--stderr-bytes")) {
            if (!parse_u64(argv[++index], &options->stderr_bytes, 0)) return 0;
        } else if (!strcmp(argv[index], "--max-children")) {
            if (!parse_u64(argv[++index], &options->max_children, 1)) return 0;
        } else return 0;
    }
    if (options->command_index <= 0 || options->command_index >= argc || options->max_children != 0U) return 0;
    if (options->stdout_bytes > MAX_CAPTURE_BYTES || options->stderr_bytes > MAX_CAPTURE_BYTES || options->timeout_ms > 86400000U) return 0;
    options->cpu_seconds = options->timeout_ms / 1000U + (options->timeout_ms % 1000U == 0U ? 0U : 1U) + 1U;
    return options->cpu_seconds > 0U;
}

static int set_limit_exact(int resource, uint64_t value)
{
    struct rlimit limit;
    if (value > (uint64_t)RLIM_INFINITY) return 0;
    limit.rlim_cur = (rlim_t)value;
    limit.rlim_max = (rlim_t)value;
    return setrlimit(resource, &limit) == 0;
}

static int get_limit_exact(pid_t child, int resource, uint64_t *current, uint64_t *maximum)
{
    struct rlimit limit;
    if (prlimit(child, resource, NULL, &limit) != 0) return 0;
    *current = (uint64_t)limit.rlim_cur;
    *maximum = (uint64_t)limit.rlim_max;
    return 1;
}

static int install_seccomp_v2(void)
{
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
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
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = { (unsigned short)(sizeof(filter) / sizeof(filter[0])), filter };
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) == 0;
}

static int read_proc_security(pid_t child, int *no_new_privs, int *seccomp_mode)
{
    char path[64];
    char line[256];
    FILE *file;
    int have_no_new_privs = 0;
    int have_seccomp = 0;
    if (snprintf(path, sizeof(path), "/proc/%ld/status", (long)child) < 0) return 0;
    file = fopen(path, "r");
    if (!file) return 0;
    while (fgets(line, sizeof(line), file) != NULL) {
        if (!strncmp(line, "NoNewPrivs:", 11)) {
            if (sscanf(line + 11, "%d", no_new_privs) != 1) { fclose(file); return 0; }
            have_no_new_privs = 1;
        } else if (!strncmp(line, "Seccomp:", 8)) {
            if (sscanf(line + 8, "%d", seccomp_mode) != 1) { fclose(file); return 0; }
            have_seccomp = 1;
        }
    }
    fclose(file);
    return have_no_new_privs && have_seccomp;
}

static uint32_t setup_failure_record(int evidence_fd, pid_t child, pid_t parent, uint32_t stage)
{
    child_evidence evidence;
    memset(&evidence, 0, sizeof(evidence));
    evidence.magic = EVIDENCE_MAGIC; evidence.version = EVIDENCE_VERSION; evidence.size = (uint16_t)sizeof(evidence);
    evidence.child_pid = (uint64_t)child; evidence.parent_pid = (uint64_t)parent; evidence.setup_stage = stage;
    (void)write_full(evidence_fd, &evidence, sizeof(evidence));
    return stage;
}

static int apply_child_setup(const runner_options *options, int evidence_fd, pid_t expected_parent)
{
    child_evidence evidence;
    pid_t child = getpid();
    struct rlimit limit;
    if (setpgid(0, 0) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_SETPGID); return 0; }
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_PDEATHSIG); return 0; }
    if (getppid() != expected_parent) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_PARENT_CHECK); return 0; }
    if (!set_limit_exact(RLIMIT_AS, options->address_space_bytes)) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_RLIMIT_AS); return 0; }
    if (!set_limit_exact(RLIMIT_FSIZE, options->file_bytes)) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_RLIMIT_FSIZE); return 0; }
    if (!set_limit_exact(RLIMIT_CPU, options->cpu_seconds)) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_RLIMIT_CPU); return 0; }
#ifdef RLIMIT_NPROC
    if (!set_limit_exact(RLIMIT_NPROC, 64U)) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_RLIMIT_NPROC); return 0; }
#endif
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_NO_NEW_PRIVS); return 0; }
    if (!install_seccomp_v2()) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_SECCOMP); return 0; }
    memset(&evidence, 0, sizeof(evidence));
    evidence.magic = EVIDENCE_MAGIC; evidence.version = EVIDENCE_VERSION; evidence.size = (uint16_t)sizeof(evidence);
    evidence.child_pid = (uint64_t)child; evidence.parent_pid = (uint64_t)expected_parent;
    if (getrlimit(RLIMIT_AS, &limit) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_CHILD_EVIDENCE); return 0; }
    evidence.as_cur = (uint64_t)limit.rlim_cur; evidence.as_max = (uint64_t)limit.rlim_max;
    if (getrlimit(RLIMIT_FSIZE, &limit) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_CHILD_EVIDENCE); return 0; }
    evidence.fsize_cur = (uint64_t)limit.rlim_cur; evidence.fsize_max = (uint64_t)limit.rlim_max;
    if (getrlimit(RLIMIT_CPU, &limit) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_CHILD_EVIDENCE); return 0; }
    evidence.cpu_cur = (uint64_t)limit.rlim_cur; evidence.cpu_max = (uint64_t)limit.rlim_max;
#ifdef RLIMIT_NPROC
    if (getrlimit(RLIMIT_NPROC, &limit) != 0) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_CHILD_EVIDENCE); return 0; }
    evidence.nproc_cur = (uint64_t)limit.rlim_cur; evidence.nproc_max = (uint64_t)limit.rlim_max;
#else
    evidence.nproc_cur = 64U; evidence.nproc_max = 64U;
#endif
    evidence.no_new_privs = (uint32_t)prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
    evidence.seccomp_mode = (uint32_t)prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
    if (evidence.no_new_privs != 1U || evidence.seccomp_mode != SECCOMP_MODE_FILTER || !write_full(evidence_fd, &evidence, sizeof(evidence))) { setup_failure_record(evidence_fd, child, expected_parent, SETUP_CHILD_EVIDENCE); return 0; }
    return 1;
}

static const char *setup_stage_name(uint32_t stage)
{
    switch (stage) {
        case SETUP_SETPGID: return "setpgid";
        case SETUP_PDEATHSIG: return "pdeathsig";
        case SETUP_PARENT_CHECK: return "parent_check";
        case SETUP_RLIMIT_AS: return "rlimit_as";
        case SETUP_RLIMIT_FSIZE: return "rlimit_fsize";
        case SETUP_RLIMIT_CPU: return "rlimit_cpu";
        case SETUP_RLIMIT_NPROC: return "rlimit_nproc";
        case SETUP_NO_NEW_PRIVS: return "no_new_privs";
        case SETUP_SECCOMP: return "seccomp";
        case SETUP_CHILD_EVIDENCE: return "child_evidence";
        case SETUP_RELEASE: return "release";
        default: return "unknown";
    }
}

static const char *result_name(int code)
{
    switch (code) {
        case RESULT_SUCCESS: return "S8_RUNNER_SUCCESS";
        case RESULT_ARGUMENT_INVALID: return "S8_RUNNER_ARGUMENT_INVALID";
        case RESULT_INTERNAL: return "S8_RUNNER_INTERNAL";
        case RESULT_CHILD_SETUP_FAILED: return "S8_RUNNER_CHILD_SETUP_FAILED";
        case RESULT_EVIDENCE_INVALID: return "S8_RUNNER_EVIDENCE_INVALID";
        case RESULT_EXEC_FAILED: return "S8_RUNNER_EXEC_FAILED";
        case RESULT_STDOUT_LIMIT: return "S8_RUNNER_STDOUT_LIMIT";
        case RESULT_STDERR_LIMIT: return "S8_RUNNER_STDERR_LIMIT";
        case RESULT_TARGET_EXIT_NONZERO: return "S8_RUNNER_TARGET_EXIT_NONZERO";
        case RESULT_TARGET_SIGNAL: return "S8_RUNNER_TARGET_SIGNAL";
        case RESULT_TIMEOUT: return "S8_RUNNER_TIMEOUT";
        default: return "S8_RUNNER_INTERNAL";
    }
}

static int set_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static int capture_init(capture *value, int fd, uint64_t limit)
{
    value->limit = (size_t)limit;
    value->data = (unsigned char *)malloc(value->limit == 0U ? 1U : value->limit);
    if (!value->data || !set_nonblocking(fd)) { free(value->data); value->data = NULL; return 0; }
    value->length = 0U; value->fd = fd; value->closed = 0; value->overflow = 0;
    return 1;
}

static void capture_close(capture *value)
{
    if (value->data == NULL) return;
    if (value->fd >= 0) close(value->fd);
    free(value->data); value->fd = -1; value->data = NULL;
}

static int capture_read(capture *value)
{
    unsigned char buffer[8192];
    for (;;) {
        ssize_t count = read(value->fd, buffer, sizeof(buffer));
        if (count == 0) { value->closed = 1; close(value->fd); value->fd = -1; return 1; }
        if (count < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
            return 0;
        }
        if ((size_t)count > value->limit - value->length) {
            size_t available = value->limit - value->length;
            if (available > 0U) memcpy(value->data + value->length, buffer, available);
            value->length = value->limit; value->overflow = 1; return 1;
        }
        memcpy(value->data + value->length, buffer, (size_t)count); value->length += (size_t)count;
    }
}

static void kill_process_group(pid_t child)
{
    if (kill(-child, SIGKILL) != 0) (void)kill(child, SIGKILL);
}

static int parent_setpgid(pid_t child)
{
    int attempts;
    for (attempts = 0; attempts < 100; attempts++) {
        if (setpgid(child, child) == 0) return 1;
        if (errno != EINTR && errno != EACCES && errno != ESRCH) return 0;
        {
            struct timespec delay = {0, 1000000L};
            nanosleep(&delay, NULL);
        }
    }
    return 0;
}

static int observe_limits(pid_t child, observed_limits *value, const child_evidence *evidence, const runner_options *options, const char **mismatch)
{
    if (!get_limit_exact(child, RLIMIT_AS, &value->as_cur, &value->as_max) || value->as_cur != evidence->as_cur || value->as_max != evidence->as_max) { *mismatch = "PARENT_PRLIMIT_AS"; return 0; }
    if (!get_limit_exact(child, RLIMIT_FSIZE, &value->fsize_cur, &value->fsize_max) || value->fsize_cur != evidence->fsize_cur || value->fsize_max != evidence->fsize_max) { *mismatch = "PARENT_PRLIMIT_FSIZE"; return 0; }
    if (!get_limit_exact(child, RLIMIT_CPU, &value->cpu_cur, &value->cpu_max) || value->cpu_cur != evidence->cpu_cur || value->cpu_max != evidence->cpu_max) { *mismatch = "PARENT_PRLIMIT_CPU"; return 0; }
#ifdef RLIMIT_NPROC
    if (!get_limit_exact(child, RLIMIT_NPROC, &value->nproc_cur, &value->nproc_max) || value->nproc_cur != evidence->nproc_cur || value->nproc_max != evidence->nproc_max) { *mismatch = "PARENT_PRLIMIT_NPROC"; return 0; }
#else
    value->nproc_cur = 64U; value->nproc_max = 64U;
#endif
    if (!read_proc_security(child, &value->no_new_privs, &value->seccomp_mode)) { *mismatch = "PARENT_PROC_STATUS"; return 0; }
    if (value->no_new_privs != (int)evidence->no_new_privs || value->seccomp_mode != (int)evidence->seccomp_mode) { *mismatch = "PARENT_PROC_SECURITY"; return 0; }
    if (value->as_cur != options->address_space_bytes || value->fsize_cur != options->file_bytes || value->cpu_cur != options->cpu_seconds || value->nproc_cur != 64U) { *mismatch = "REQUESTED_APPLIED_OBSERVED"; return 0; }
    return 1;
}

static int emit_receipt(const runner_options *options, const char *runner_sha, const child_evidence *evidence, const observed_limits *observed, const char *verification_status, const char *mismatch_code, int result, const char *termination, int target_exit, int target_signal, uint64_t elapsed_ms, size_t stdout_bytes, size_t stderr_bytes, const char *setup_stage, const char *evidence_code)
{
    if (printf(RECEIPT_PREFIX "{\"schemaVersion\":\"%s\",\"protocol\":\"%s\",\"policyId\":\"%s\",\"requested\":{\"rlimitAsBytes\":%llu,\"rlimitFsizeBytes\":%llu,\"rlimitCpuSeconds\":%llu,\"rlimitNproc\":64,\"wallTimeoutMs\":%llu,\"stdoutBytes\":%llu,\"stderrBytes\":%llu,\"maxChildren\":0},\"appliedByChild\":{\"rlimitAsBytes\":%llu,\"rlimitFsizeBytes\":%llu,\"rlimitCpuSeconds\":%llu,\"rlimitNproc\":%llu,\"noNewPrivs\":%u,\"seccompMode\":%u},\"observedByRunnerParent\":{\"rlimitAsBytes\":%llu,\"rlimitFsizeBytes\":%llu,\"rlimitCpuSeconds\":%llu,\"rlimitNproc\":%llu,\"noNewPrivs\":%d,\"seccompMode\":%d},\"runnerParentVerification\":{\"status\":\"%s\",\"mismatchCode\":",
               RECEIPT_SCHEMA, RECEIPT_SCHEMA, POLICY_ID,
               (unsigned long long)options->address_space_bytes, (unsigned long long)options->file_bytes, (unsigned long long)options->cpu_seconds, (unsigned long long)options->timeout_ms, (unsigned long long)options->stdout_bytes, (unsigned long long)options->stderr_bytes,
               (unsigned long long)evidence->as_cur, (unsigned long long)evidence->fsize_cur, (unsigned long long)evidence->cpu_cur, (unsigned long long)evidence->nproc_cur, evidence->no_new_privs, evidence->seccomp_mode,
               (unsigned long long)observed->as_cur, (unsigned long long)observed->fsize_cur, (unsigned long long)observed->cpu_cur, (unsigned long long)observed->nproc_cur, observed->no_new_privs, observed->seccomp_mode,
               verification_status) < 0) return 0;
    if (mismatch_code == NULL) { if (printf("null}") < 0) return 0; } else if (printf("\"%s\"}", mismatch_code) < 0) return 0;
    if (printf(",\"runnerBinary\":{\"selfSha256\":\"%s\"},\"result\":{\"code\":%d,\"name\":\"%s\",\"terminationClass\":\"%s\",\"targetExit\":", runner_sha, result, result_name(result), termination) < 0) return 0;
    if (target_exit >= 0) { if (printf("%d", target_exit) < 0) return 0; } else if (printf("null") < 0) return 0;
    if (printf(",\"targetSignal\":") < 0) return 0;
    if (target_signal >= 0) { if (printf("%d", target_signal) < 0) return 0; } else if (printf("null") < 0) return 0;
    if (printf(",\"elapsedMs\":%llu,\"stdoutBytes\":%llu,\"stderrBytes\":%llu,\"setupStage\":", (unsigned long long)elapsed_ms, (unsigned long long)stdout_bytes, (unsigned long long)stderr_bytes) < 0) return 0;
    if (setup_stage == NULL) { if (printf("null") < 0) return 0; } else if (printf("\"%s\"", setup_stage) < 0) return 0;
    if (printf(",\"evidenceCode\":") < 0) return 0;
    if (evidence_code == NULL) { if (printf("null") < 0) return 0; } else if (printf("\"%s\"", evidence_code) < 0) return 0;
    if (printf("}}\n") < 0) return 0;
    return fflush(stdout) == 0;
}

static int write_captured(const capture *value, int fd)
{
    return value->length == 0U || write_full(fd, value->data, value->length);
}

static void usage(void)
{
    fprintf(stderr, "usage: s8-process-runner --address-space-bytes N --file-bytes N --timeout-ms N --stdout-bytes N --stderr-bytes N --max-children 0 -- command [args...]\n");
}

int main(int argc, char **argv)
{
    runner_options options;
    char runner_sha[65];
    int stdout_pipe[2] = {-1, -1};
    int stderr_pipe[2] = {-1, -1};
    int evidence_pipe[2] = {-1, -1};
    int release_pipe[2] = {-1, -1};
    int exec_pipe[2] = {-1, -1};
    pid_t child = -1;
    child_evidence evidence;
    observed_limits observed;
    capture output = {.fd = -1};
    capture errors = {.fd = -1};
    int status = 0;
    int result = RESULT_INTERNAL;
    int target_exit = -1;
    int target_signal = -1;
    int exec_state = 0;
    int reaped = 0;
    int timed_out = 0;
    const char *verification = "FAIL";
    const char *mismatch = "INTERNAL";
    const char *termination = "runner-internal";
    const char *setup_stage = NULL;
    const char *evidence_code = NULL;
    uint64_t started_ms = 0U;
    const char *observe_mismatch = NULL;
    memset(&evidence, 0, sizeof(evidence));
    memset(&observed, 0, sizeof(observed));
    if (!parse_options(argc, argv, &options)) { usage(); return RESULT_ARGUMENT_INVALID; }
    if (!runner_sha256(runner_sha)) return RESULT_INTERNAL;
    if (pipe2(stdout_pipe, O_CLOEXEC) != 0 || pipe2(stderr_pipe, O_CLOEXEC) != 0 || pipe2(evidence_pipe, O_CLOEXEC) != 0 || pipe2(release_pipe, O_CLOEXEC) != 0 || pipe2(exec_pipe, O_CLOEXEC) != 0) return RESULT_INTERNAL;
    child = fork();
    if (child < 0) return RESULT_INTERNAL;
    if (child == 0) {
        unsigned char release;
        int exec_error;
        close(stdout_pipe[0]); close(stderr_pipe[0]); close(evidence_pipe[0]); close(release_pipe[1]); close(exec_pipe[0]);
        if (dup2(stdout_pipe[1], STDOUT_FILENO) < 0 || dup2(stderr_pipe[1], STDERR_FILENO) < 0) _exit(RESULT_CHILD_SETUP_FAILED);
        close(stdout_pipe[1]); close(stderr_pipe[1]);
        if (!apply_child_setup(&options, evidence_pipe[1], getppid())) _exit(RESULT_CHILD_SETUP_FAILED);
        close(evidence_pipe[1]);
        if (read(release_pipe[0], &release, 1) != 1) _exit(RESULT_CHILD_SETUP_FAILED);
        close(release_pipe[0]);
        execvp(argv[options.command_index], &argv[options.command_index]);
        exec_error = errno;
        (void)write_full(exec_pipe[1], &exec_error, sizeof(exec_error));
        close(exec_pipe[1]);
        _exit(RESULT_EXEC_FAILED);
    }
    close(stdout_pipe[1]); stdout_pipe[1] = -1; close(stderr_pipe[1]); stderr_pipe[1] = -1; close(evidence_pipe[1]); evidence_pipe[1] = -1; close(release_pipe[0]); release_pipe[0] = -1; close(exec_pipe[1]); exec_pipe[1] = -1;
    if (!parent_setpgid(child)) { result = RESULT_INTERNAL; mismatch = "PARENT_SETPGID"; kill_process_group(child); goto finish; }
    {
        int evidence_result = read_full(evidence_pipe[0], &evidence, sizeof(evidence));
        close(evidence_pipe[0]); evidence_pipe[0] = -1;
        if (evidence_result != 1 || evidence.magic != EVIDENCE_MAGIC || evidence.version != EVIDENCE_VERSION || evidence.size != sizeof(evidence) || evidence.child_pid != (uint64_t)child || evidence.parent_pid != (uint64_t)getpid()) { result = RESULT_EVIDENCE_INVALID; mismatch = "CHILD_EVIDENCE_MALFORMED"; evidence_code = "CHILD_EVIDENCE_MALFORMED"; termination = "evidence-failed"; kill_process_group(child); goto finish; }
        if (evidence.setup_stage != SETUP_NONE) { result = RESULT_CHILD_SETUP_FAILED; termination = "child-setup-failed"; setup_stage = setup_stage_name(evidence.setup_stage); mismatch = NULL; kill_process_group(child); goto finish; }
    }
    if (!observe_limits(child, &observed, &evidence, &options, &observe_mismatch)) { result = RESULT_EVIDENCE_INVALID; mismatch = observe_mismatch; evidence_code = observe_mismatch; termination = "evidence-failed"; kill_process_group(child); goto finish; }
    verification = "PASS"; mismatch = NULL;
    if (!write_full(release_pipe[1], "R", 1)) { result = RESULT_EVIDENCE_INVALID; mismatch = "RELEASE_CHANNEL"; evidence_code = "RELEASE_CHANNEL"; termination = "evidence-failed"; kill_process_group(child); goto finish; }
    close(release_pipe[1]); release_pipe[1] = -1;
    started_ms = monotonic_ms();
    if (!set_nonblocking(exec_pipe[0])) { result = RESULT_INTERNAL; mismatch = "EXEC_CHANNEL"; kill_process_group(child); goto finish; }
    if (!capture_init(&output, stdout_pipe[0], options.stdout_bytes) || !capture_init(&errors, stderr_pipe[0], options.stderr_bytes)) { result = RESULT_INTERNAL; mismatch = "CAPTURE_INIT"; kill_process_group(child); goto finish; }
    while (!reaped || !output.closed || !errors.closed || exec_state == 0) {
        struct pollfd descriptors[3];
        int descriptor_count = 0;
        if (!output.closed) { descriptors[descriptor_count].fd = output.fd; descriptors[descriptor_count].events = POLLIN | POLLHUP; descriptor_count++; }
        if (!errors.closed) { descriptors[descriptor_count].fd = errors.fd; descriptors[descriptor_count].events = POLLIN | POLLHUP; descriptor_count++; }
        if (exec_state == 0) { descriptors[descriptor_count].fd = exec_pipe[0]; descriptors[descriptor_count].events = POLLIN | POLLHUP; descriptor_count++; }
        if (poll(descriptors, (nfds_t)descriptor_count, 20) < 0 && errno != EINTR) { result = RESULT_INTERNAL; mismatch = "POLL"; break; }
        if (!output.closed && !capture_read(&output)) { result = RESULT_INTERNAL; mismatch = "STDOUT_READ"; break; }
        if (!errors.closed && !capture_read(&errors)) { result = RESULT_INTERNAL; mismatch = "STDERR_READ"; break; }
        if (exec_state == 0) {
            int error_code;
            ssize_t count = read(exec_pipe[0], &error_code, sizeof(error_code));
            if (count == 0) exec_state = 1;
            else if (count == (ssize_t)sizeof(error_code)) exec_state = 2;
            else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) exec_state = 2;
        }
        if (!reaped) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child) reaped = 1;
            else if (waited < 0 && errno != EINTR) { result = RESULT_INTERNAL; mismatch = "WAITPID"; break; }
        }
        if (output.overflow || errors.overflow) { result = output.overflow ? RESULT_STDOUT_LIMIT : RESULT_STDERR_LIMIT; termination = output.overflow ? "stdout-limit" : "stderr-limit"; kill_process_group(child); }
        if (!reaped && started_ms > 0U && monotonic_ms() - started_ms >= options.timeout_ms) { timed_out = 1; result = RESULT_TIMEOUT; termination = "wall-timeout"; kill_process_group(child); }
        if (exec_state == 2 && !reaped) { result = RESULT_EXEC_FAILED; termination = "exec-failed"; kill_process_group(child); }
        if ((output.overflow || errors.overflow || timed_out || exec_state == 2) && !reaped) { if (waitpid(child, &status, 0) == child) reaped = 1; }
        if (reaped && output.closed && errors.closed && exec_state != 0) break;
    }
    if (!reaped) { kill_process_group(child); if (waitpid(child, &status, 0) == child) reaped = 1; }
    if (!output.closed) (void)capture_read(&output);
    if (!errors.closed) (void)capture_read(&errors);
    if (result == RESULT_INTERNAL && !output.overflow && !errors.overflow && !timed_out && exec_state != 2) {
        if (WIFEXITED(status)) { target_exit = WEXITSTATUS(status); if (target_exit == 0) { result = RESULT_SUCCESS; termination = "target-exit-zero"; } else { result = RESULT_TARGET_EXIT_NONZERO; termination = "target-exit-nonzero"; } }
        else if (WIFSIGNALED(status)) { target_signal = WTERMSIG(status); result = RESULT_TARGET_SIGNAL; termination = "target-signal"; }
        else { result = RESULT_INTERNAL; termination = "runner-internal"; }
    }

finish:
    if (child > 0 && !reaped) { kill_process_group(child); (void)waitpid(child, &status, 0); }
    if (evidence_pipe[0] >= 0) close(evidence_pipe[0]);
    if (release_pipe[1] >= 0) close(release_pipe[1]);
    if (exec_pipe[0] >= 0) close(exec_pipe[0]);
    if (output.data == NULL && stdout_pipe[0] >= 0) close(stdout_pipe[0]);
    if (errors.data == NULL && stderr_pipe[0] >= 0) close(stderr_pipe[0]);
    if (!emit_receipt(&options, runner_sha, &evidence, &observed, verification, mismatch, result, termination, target_exit, target_signal, started_ms > 0U ? monotonic_ms() - started_ms : 0U, output.length, errors.length, setup_stage, evidence_code)) result = RESULT_INTERNAL;
    if (output.data != NULL) (void)write_captured(&output, STDOUT_FILENO);
    if (errors.data != NULL) (void)write_captured(&errors, STDERR_FILENO);
    capture_close(&output); capture_close(&errors);
    return result;
}
