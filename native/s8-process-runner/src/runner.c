#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

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
    if (options->command_index == 0 || options->command_index >= argc || options->address_space_bytes == 0 || options->file_bytes == 0 || options->timeout_ms == 0 || options->stdout_bytes == 0 || options->stderr_bytes == 0) return 0;
    return 1;
}

static int set_limit(int resource, uint64_t value)
{
    struct rlimit limit;
    limit.rlim_cur = (rlim_t)value;
    limit.rlim_max = (rlim_t)value;
    return setrlimit(resource, &limit);
}

static int child_limits(const runner_options *options)
{
    uint64_t cpu_seconds = (options->timeout_ms + 999) / 1000 + 1;
    if (set_limit(RLIMIT_AS, options->address_space_bytes) != 0) return 0;
    if (set_limit(RLIMIT_FSIZE, options->file_bytes) != 0) return 0;
    if (set_limit(RLIMIT_CPU, cpu_seconds) != 0) return 0;
#ifdef RLIMIT_NPROC
    if (options->max_children == 0 && set_limit(RLIMIT_NPROC, 1) != 0) return 0;
#endif
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 0;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 0;
    if (getppid() != getpid() && getppid() == 1) return 0;
    return 1;
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
    pid_t child;
    int status = 0;
    int killed = 0;
    int timed_out = 0;
    int output_limited = 0;
    capture output;
    capture errors;
    if (!parse_options(argc, argv, &options)) { usage(); return 2; }
    memset(&output, 0, sizeof(output));
    memset(&errors, 0, sizeof(errors));
    if (pipe(output_pipe) != 0 || pipe(error_pipe) != 0) return 125;
    child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        (void)setpgid(0, 0);
        close(output_pipe[0]);
        close(error_pipe[0]);
        if (dup2(output_pipe[1], STDOUT_FILENO) < 0 || dup2(error_pipe[1], STDERR_FILENO) < 0 || !child_limits(&options)) _exit(126);
        close(output_pipe[1]);
        close(error_pipe[1]);
        execvp(argv[options.command_index], &argv[options.command_index]);
        _exit(127);
    }
    close(output_pipe[1]);
    close(error_pipe[1]);
    (void)setpgid(child, child);
    if (!capture_init(&output, output_pipe[0], (size_t)options.stdout_bytes) || !capture_init(&errors, error_pipe[0], (size_t)options.stderr_bytes)) {
        kill_process_group(child);
        (void)waitpid(child, &status, 0);
        return 125;
    }
    while (!output.closed || !errors.closed || waitpid(child, &status, WNOHANG) == 0) {
        struct pollfd descriptors[2];
        int descriptor_count = 0;
        descriptors[0].fd = output.fd;
        descriptors[0].events = output.closed ? 0 : POLLIN;
        descriptors[1].fd = errors.fd;
        descriptors[1].events = errors.closed ? 0 : POLLIN;
        descriptor_count = 2;
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
