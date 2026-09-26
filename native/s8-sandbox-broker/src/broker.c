#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64

#include <errno.h>
#include <dirent.h>
#include <grp.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <stdarg.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <linux/capability.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/random.h>
#include <sys/types.h>
#include <unistd.h>

#define POLICY_PATH "/etc/swooshz/s8-broker-v1.json"
#define POLICY_MAX_BYTES 16384U
#define REQUEST_HEADER_BYTES 160U
#define RESPONSE_HEADER_BYTES 320U
#define WRITER_MAX_PAYLOAD UINT64_C(268435456)
#define VALIDATOR_MAX_PAYLOAD UINT64_C(134217728)
#define MAX_REQUEST_BYTES UINT64_C(268435616)
#define MAX_RESPONSE_BYTES UINT64_C(137445696)
#define WRITER_MAX_RESPONSE UINT64_C(137445696)
#define VALIDATOR_MAX_RESPONSE UINT64_C(9519424)
#define RECOVER_MAX_RESPONSE UINT64_C(16704)
#define METADATA_MAX_BYTES 16384U
#define BROKER_STDERR_MAX_BYTES 4096U
#define ALLOCATION_PREFIX "s8-"
#define PRIVATE_ROOT_PATH "/var/lib/swooshz/s8"
#define LAUNCHER_PATH "/usr/local/libexec/swooshz-s8/s8-sandbox"
#define BROKER_PATH "/usr/local/libexec/swooshz-s8/s8-sandbox-broker"
#define BWRAP_PATH "/usr/bin/bwrap"
#define RUNNER_PATH "/usr/local/libexec/swooshz-s8/s8-process-runner"
#define VALIDATOR_PATH "/usr/local/libexec/swooshz-s8/s8-native-validator"
#define JOURNAL_DIR ".journal"
#define JOURNAL_LOCK "lock"
#define MAX_JOURNAL_BYTES 16384U
#define MAX_CLEANUP_DEPTH 256U
#define MAX_CLEANUP_ENTRIES 4096U
#define MAX_CLEANUP_FDS 512U
#define MAX_RECOVERY_ATTEMPTS 3U
#define ARRAY_LENGTH(value) (sizeof(value) / sizeof((value)[0]))

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
    for (index = 0U; index < 16U; index++) schedule[index] = read_u32_be(block + index * 4U);
    for (index = 16U; index < 64U; index++) {
        uint32_t s0 = rotate_right(schedule[index - 15U], 7U) ^ rotate_right(schedule[index - 15U], 18U) ^ (schedule[index - 15U] >> 3U);
        uint32_t s1 = rotate_right(schedule[index - 2U], 17U) ^ rotate_right(schedule[index - 2U], 19U) ^ (schedule[index - 2U] >> 10U);
        schedule[index] = schedule[index - 16U] + s0 + schedule[index - 7U] + s1;
    }
    a = context->state[0]; b = context->state[1]; c = context->state[2]; d = context->state[3];
    e = context->state[4]; f = context->state[5]; g = context->state[6]; h = context->state[7];
    for (index = 0U; index < 64U; index++) {
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
    for (index = 0U; index < 8U; index++) context->buffer[56U + index] = (unsigned char)(bit_count >> (56U - index * 8U));
    sha256_transform(context, context->buffer);
    for (index = 0U; index < 8U; index++) write_u32_be(digest + index * 4U, context->state[index]);
}

static void sha256_bytes(const unsigned char *data, size_t length, unsigned char digest[32])
{
    sha256_context context;
    sha256_init(&context);
    sha256_update(&context, data, length);
    sha256_final(&context, digest);
}

static int sha256_fd(int fd, unsigned char digest[32])
{
    unsigned char buffer[16384];
    sha256_context context;
    off_t offset = 0;
    sha256_init(&context);
    for (;;) {
        ssize_t count = pread(fd, buffer, sizeof(buffer), offset);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return 0;
        if (count == 0) break;
        sha256_update(&context, buffer, (size_t)count);
        offset += count;
    }
    sha256_final(&context, digest);
    return 1;
}

static void hex_encode(const unsigned char *input, size_t length, char *output)
{
    static const char digits[] = "0123456789abcdef";
    size_t index;
    for (index = 0U; index < length; index++) {
        output[index * 2U] = digits[input[index] >> 4U];
        output[index * 2U + 1U] = digits[input[index] & 0x0fU];
    }
    output[length * 2U] = '\0';
}

static int hex_decode_32(const char *input, unsigned char output[32])
{
    size_t index;
    if (strlen(input) != 64U) return 0;
    for (index = 0U; index < 32U; index++) {
        unsigned int hi, lo;
        char a = input[index * 2U], b = input[index * 2U + 1U];
        if (a >= '0' && a <= '9') hi = (unsigned int)(a - '0');
        else if (a >= 'a' && a <= 'f') hi = (unsigned int)(a - 'a' + 10);
        else return 0;
        if (b >= '0' && b <= '9') lo = (unsigned int)(b - '0');
        else if (b >= 'a' && b <= 'f') lo = (unsigned int)(b - 'a' + 10);
        else return 0;
        output[index] = (unsigned char)((hi << 4U) | lo);
    }
    return 1;
}

static int constant_equal(const unsigned char *left, const unsigned char *right, size_t length)
{
    unsigned char difference = 0U;
    size_t index;
    for (index = 0U; index < length; index++) difference |= (unsigned char)(left[index] ^ right[index]);
    return difference == 0U;
}

typedef struct {
    const unsigned char *cursor;
    const unsigned char *end;
} json_cursor;

typedef struct {
    char blender_runtime_root[1025];
    char blender_executable[1025];
    char writer_script[1025];
    char private_work_root[1025];
    char process_runner_executable[1025];
    char sandbox_executable[1025];
    char native_validator_executable[1025];
    char blender_executable_sha256[65];
    char sandbox_policy_sha256[65];
} policy_config;

typedef struct {
    uint32_t host_uid;
    uint32_t host_gid;
    policy_config config;
    char private_root_device[21];
    char private_root_inode[21];
    char launcher_sha256[65];
    char broker_sha256[65];
    char bubblewrap_sha256[65];
    char runner_sha256[65];
    char validator_sha256[65];
    char writer_sha256[65];
    char private_exporter_sha256[65];
    char patch_manifest_sha256[65];
    char policy_sha256[65];
    char config_sha256[65];
} deployed_policy;

typedef struct {
    unsigned char bytes[POLICY_MAX_BYTES + 1U];
    size_t length;
    int failed;
} byte_builder;

static int valid_utf8_sequence(const unsigned char *bytes, size_t remaining, size_t *length, uint32_t *codepoint)
{
    unsigned char first;
    if (remaining == 0U) return 0;
    first = bytes[0];
    if (first <= 0x7fU) { *length = 1U; *codepoint = first; return 1; }
    if (first >= 0xc2U && first <= 0xdfU && remaining >= 2U && (bytes[1] & 0xc0U) == 0x80U) {
        *length = 2U; *codepoint = ((uint32_t)(first & 0x1fU) << 6U) | (uint32_t)(bytes[1] & 0x3fU); return 1;
    }
    if (first >= 0xe0U && first <= 0xefU && remaining >= 3U && (bytes[1] & 0xc0U) == 0x80U && (bytes[2] & 0xc0U) == 0x80U) {
        uint32_t value = ((uint32_t)(first & 0x0fU) << 12U) | ((uint32_t)(bytes[1] & 0x3fU) << 6U) | (uint32_t)(bytes[2] & 0x3fU);
        if (value < 0x800U || (value >= 0xd800U && value <= 0xdfffU)) return 0;
        if (first == 0xe0U && bytes[1] < 0xa0U) return 0;
        if (first == 0xedU && bytes[1] >= 0xa0U) return 0;
        *length = 3U; *codepoint = value; return 1;
    }
    if (first >= 0xf0U && first <= 0xf4U && remaining >= 4U && (bytes[1] & 0xc0U) == 0x80U && (bytes[2] & 0xc0U) == 0x80U && (bytes[3] & 0xc0U) == 0x80U) {
        uint32_t value = ((uint32_t)(first & 0x07U) << 18U) | ((uint32_t)(bytes[1] & 0x3fU) << 12U) | ((uint32_t)(bytes[2] & 0x3fU) << 6U) | (uint32_t)(bytes[3] & 0x3fU);
        if (value < 0x10000U || value > 0x10ffffU) return 0;
        if (first == 0xf0U && bytes[1] < 0x90U) return 0;
        if (first == 0xf4U && bytes[1] >= 0x90U) return 0;
        *length = 4U; *codepoint = value; return 1;
    }
    return 0;
}

static int append_bytes(byte_builder *builder, const void *value, size_t length)
{
    if (builder->failed || length > POLICY_MAX_BYTES - builder->length) { builder->failed = 1; return 0; }
    memcpy(builder->bytes + builder->length, value, length);
    builder->length += length;
    return 1;
}

static int append_text(byte_builder *builder, const char *value)
{
    return append_bytes(builder, value, strlen(value));
}

static int append_json_string(byte_builder *builder, const char *value)
{
    const unsigned char *bytes = (const unsigned char *)value;
    size_t length = strlen(value), offset = 0U;
    if (!append_text(builder, "\"")) return 0;
    while (offset < length) {
        unsigned char byte = bytes[offset];
        if (byte == '"' || byte == '\\') {
            unsigned char escaped[2] = {'\\', byte};
            if (!append_bytes(builder, escaped, sizeof(escaped))) return 0;
            offset++;
        } else if (byte < 0x20U) {
            return 0;
        } else if (byte < 0x80U) {
            if (!append_bytes(builder, bytes + offset, 1U)) return 0;
            offset++;
        } else {
            size_t sequence_length;
            uint32_t codepoint;
            if (!valid_utf8_sequence(bytes + offset, length - offset, &sequence_length, &codepoint) || (codepoint >= 0x80U && codepoint <= 0x9fU)) return 0;
            if (!append_bytes(builder, bytes + offset, sequence_length)) return 0;
            offset += sequence_length;
        }
    }
    return append_text(builder, "\"");
}

static int expect_json_text(json_cursor *cursor, const char *value)
{
    size_t length = strlen(value);
    if ((size_t)(cursor->end - cursor->cursor) < length || memcmp(cursor->cursor, value, length) != 0) return 0;
    cursor->cursor += length;
    return 1;
}

static int lower_hex_nibble(unsigned char value)
{
    if (value >= '0' && value <= '9') return (int)(value - '0');
    if (value >= 'a' && value <= 'f') return (int)(value - 'a' + 10);
    return -1;
}

static int parse_json_string(json_cursor *cursor, char *output, size_t capacity)
{
    size_t length = 0U;
    if (cursor->cursor == cursor->end || *cursor->cursor++ != '"') return 0;
    while (cursor->cursor < cursor->end && *cursor->cursor != '"') {
        unsigned char byte = *cursor->cursor++;
        if (byte == '\\') {
            unsigned char escaped;
            if (cursor->cursor == cursor->end) return 0;
            escaped = *cursor->cursor++;
            if (escaped == '"' || escaped == '\\') byte = escaped;
            else if (escaped == 'b') byte = '\b';
            else if (escaped == 'f') byte = '\f';
            else if (escaped == 'n') byte = '\n';
            else if (escaped == 'r') byte = '\r';
            else if (escaped == 't') byte = '\t';
            else if (escaped == 'u') {
                unsigned int codepoint = 0U;
                size_t index;
                if ((size_t)(cursor->end - cursor->cursor) < 4U) return 0;
                for (index = 0U; index < 4U; index++) {
                    int digit = lower_hex_nibble(cursor->cursor[index]);
                    if (digit < 0) return 0;
                    codepoint = (codepoint << 4U) | (unsigned int)digit;
                }
                cursor->cursor += 4U;
                if (codepoint == 0U || codepoint >= 0x20U || codepoint == 8U || codepoint == 9U || codepoint == 10U || codepoint == 12U || codepoint == 13U) return 0;
                byte = (unsigned char)codepoint;
            } else return 0;
            if (byte == 0U) return 0;
            if (length + 1U >= capacity) return 0;
            output[length++] = (char)byte;
        } else {
            size_t sequence_length;
            uint32_t codepoint;
            if (byte < 0x20U) return 0;
            if (byte < 0x80U) {
                if (length + 1U >= capacity) return 0;
                output[length++] = (char)byte;
            } else {
                cursor->cursor--;
                if (!valid_utf8_sequence(cursor->cursor, (size_t)(cursor->end - cursor->cursor), &sequence_length, &codepoint) || (codepoint >= 0x80U && codepoint <= 0x9fU)) return 0;
                if (sequence_length > capacity - length - 1U) return 0;
                memcpy(output + length, cursor->cursor, sequence_length);
                cursor->cursor += sequence_length;
                length += sequence_length;
            }
        }
    }
    if (cursor->cursor == cursor->end || *cursor->cursor++ != '"') return 0;
    output[length] = '\0';
    return 1;
}

static int parse_json_u32(json_cursor *cursor, uint32_t maximum, int allow_zero, uint32_t *output)
{
    uint64_t value = 0U;
    const unsigned char *start = cursor->cursor;
    if (cursor->cursor == cursor->end || *cursor->cursor < '0' || *cursor->cursor > '9') return 0;
    if (*cursor->cursor == '0' && cursor->cursor + 1 < cursor->end && cursor->cursor[1] >= '0' && cursor->cursor[1] <= '9') return 0;
    while (cursor->cursor < cursor->end && *cursor->cursor >= '0' && *cursor->cursor <= '9') {
        uint64_t digit = (uint64_t)(*cursor->cursor - '0');
        if (value > ((uint64_t)maximum - digit) / 10U) return 0;
        value = value * 10U + digit;
        cursor->cursor++;
    }
    if (cursor->cursor == start || (!allow_zero && value == 0U)) return 0;
    *output = (uint32_t)value;
    return 1;
}

static int parse_decimal_string(json_cursor *cursor, char *output, size_t capacity)
{
    size_t index;
    if (!parse_json_string(cursor, output, capacity)) return 0;
    if (output[0] == '\0' || (output[0] == '0' && output[1] != '\0')) return 0;
    for (index = 0U; output[index] != '\0'; index++) if (output[index] < '0' || output[index] > '9') return 0;
    return 1;
}

static int parse_digest_string(json_cursor *cursor, char output[65])
{
    size_t index;
    if (!parse_json_string(cursor, output, 65U) || strlen(output) != 64U) return 0;
    for (index = 0U; index < 64U; index++) if (lower_hex_nibble((unsigned char)output[index]) < 0) return 0;
    return 1;
}

static int serialize_config(byte_builder *builder, const policy_config *config, int include_policy_digest)
{
    if (!append_text(builder, "{\"blenderRuntimeRoot\":" ) || !append_json_string(builder, config->blender_runtime_root) ||
        !append_text(builder, ",\"blenderExecutable\":" ) || !append_json_string(builder, config->blender_executable) ||
        !append_text(builder, ",\"writerScript\":" ) || !append_json_string(builder, config->writer_script) ||
        !append_text(builder, ",\"privateWorkRoot\":" ) || !append_json_string(builder, config->private_work_root) ||
        !append_text(builder, ",\"processRunnerExecutable\":" ) || !append_json_string(builder, config->process_runner_executable) ||
        !append_text(builder, ",\"sandboxExecutable\":" ) || !append_json_string(builder, config->sandbox_executable)) return 0;
    if (!append_text(builder, ",\"nativeValidatorExecutable\":" ) || !append_json_string(builder, config->native_validator_executable) ||
        !append_text(builder, ",\"blenderExecutableSha256\":" ) || !append_json_string(builder, config->blender_executable_sha256)) return 0;
    if (include_policy_digest && (!append_text(builder, ",\"sandboxPolicySha256\":" ) || !append_json_string(builder, config->sandbox_policy_sha256))) return 0;
    return append_text(builder, "}");
}

static int serialize_policy(byte_builder *builder, const deployed_policy *policy, int include_policy_digest)
{
    char number[16];
    int result;
    result = snprintf(number, sizeof(number), "%" PRIu32, policy->host_uid);
    if (result < 0 || (size_t)result >= sizeof(number) || !append_text(builder, "{\"schemaVersion\":\"s8-sandbox-broker-policy-v1\",\"protocolVersion\":\"s8-sandbox-broker-v1\",\"hostUid\":" ) || !append_text(builder, number)) return 0;
    result = snprintf(number, sizeof(number), "%" PRIu32, policy->host_gid);
    if (result < 0 || (size_t)result >= sizeof(number) || !append_text(builder, ",\"hostGid\":" ) || !append_text(builder, number) || !append_text(builder, ",\"config\":" ) || !serialize_config(builder, &policy->config, include_policy_digest) ||
        !append_text(builder, ",\"privateRootDevice\":" ) || !append_json_string(builder, policy->private_root_device) ||
        !append_text(builder, ",\"privateRootInode\":" ) || !append_json_string(builder, policy->private_root_inode) ||
        !append_text(builder, ",\"launcherSha256\":" ) || !append_json_string(builder, policy->launcher_sha256) ||
        !append_text(builder, ",\"brokerSha256\":" ) || !append_json_string(builder, policy->broker_sha256) ||
        !append_text(builder, ",\"bubblewrapSha256\":" ) || !append_json_string(builder, policy->bubblewrap_sha256) ||
        !append_text(builder, ",\"runnerSha256\":" ) || !append_json_string(builder, policy->runner_sha256) ||
        !append_text(builder, ",\"validatorSha256\":" ) || !append_json_string(builder, policy->validator_sha256) ||
        !append_text(builder, ",\"writerSha256\":" ) || !append_json_string(builder, policy->writer_sha256) ||
        !append_text(builder, ",\"privateExporterSha256\":" ) || !append_json_string(builder, policy->private_exporter_sha256) ||
        !append_text(builder, ",\"patchManifestSha256\":" ) || !append_json_string(builder, policy->patch_manifest_sha256) || !append_text(builder, "}")) return 0;
    return 1;
}

static int parse_policy_bytes(const unsigned char *bytes, size_t length, deployed_policy *policy)
{
    json_cursor cursor = { bytes, bytes + length };
    byte_builder final_bytes = {{0U}, 0U, 0};
    byte_builder preimage = {{0U}, 0U, 0};
    byte_builder config_bytes = {{0U}, 0U, 0};
    unsigned char policy_digest[32], config_digest[32];
    memset(policy, 0, sizeof(*policy));
    if (length == 0U || length > POLICY_MAX_BYTES || (length >= 3U && bytes[0] == 0xefU && bytes[1] == 0xbbU && bytes[2] == 0xbfU)) return 0;
    if (!expect_json_text(&cursor, "{\"schemaVersion\":\"s8-sandbox-broker-policy-v1\",\"protocolVersion\":\"s8-sandbox-broker-v1\",\"hostUid\":" ) ||
        !parse_json_u32(&cursor, UINT32_C(4294967294), 0, &policy->host_uid) || !expect_json_text(&cursor, ",\"hostGid\":" ) ||
        !parse_json_u32(&cursor, UINT32_C(4294967294), 1, &policy->host_gid) || !expect_json_text(&cursor, ",\"config\":{\"blenderRuntimeRoot\":" ) ||
        !parse_json_string(&cursor, policy->config.blender_runtime_root, sizeof(policy->config.blender_runtime_root)) || !expect_json_text(&cursor, ",\"blenderExecutable\":" ) ||
        !parse_json_string(&cursor, policy->config.blender_executable, sizeof(policy->config.blender_executable)) || !expect_json_text(&cursor, ",\"writerScript\":" ) ||
        !parse_json_string(&cursor, policy->config.writer_script, sizeof(policy->config.writer_script)) || !expect_json_text(&cursor, ",\"privateWorkRoot\":" ) ||
        !parse_json_string(&cursor, policy->config.private_work_root, sizeof(policy->config.private_work_root)) || !expect_json_text(&cursor, ",\"processRunnerExecutable\":" ) ||
        !parse_json_string(&cursor, policy->config.process_runner_executable, sizeof(policy->config.process_runner_executable)) || !expect_json_text(&cursor, ",\"sandboxExecutable\":" ) ||
        !parse_json_string(&cursor, policy->config.sandbox_executable, sizeof(policy->config.sandbox_executable)) || !expect_json_text(&cursor, ",\"nativeValidatorExecutable\":" ) ||
        !parse_json_string(&cursor, policy->config.native_validator_executable, sizeof(policy->config.native_validator_executable)) || !expect_json_text(&cursor, ",\"blenderExecutableSha256\":" ) ||
        !parse_digest_string(&cursor, policy->config.blender_executable_sha256) || !expect_json_text(&cursor, ",\"sandboxPolicySha256\":" ) ||
        !parse_digest_string(&cursor, policy->config.sandbox_policy_sha256) || !expect_json_text(&cursor, "},\"privateRootDevice\":" ) ||
        !parse_decimal_string(&cursor, policy->private_root_device, sizeof(policy->private_root_device)) || !expect_json_text(&cursor, ",\"privateRootInode\":" ) ||
        !parse_decimal_string(&cursor, policy->private_root_inode, sizeof(policy->private_root_inode)) || !expect_json_text(&cursor, ",\"launcherSha256\":" ) ||
        !parse_digest_string(&cursor, policy->launcher_sha256) || !expect_json_text(&cursor, ",\"brokerSha256\":" ) ||
        !parse_digest_string(&cursor, policy->broker_sha256) || !expect_json_text(&cursor, ",\"bubblewrapSha256\":" ) ||
        !parse_digest_string(&cursor, policy->bubblewrap_sha256) || !expect_json_text(&cursor, ",\"runnerSha256\":" ) ||
        !parse_digest_string(&cursor, policy->runner_sha256) || !expect_json_text(&cursor, ",\"validatorSha256\":" ) ||
        !parse_digest_string(&cursor, policy->validator_sha256) || !expect_json_text(&cursor, ",\"writerSha256\":" ) ||
        !parse_digest_string(&cursor, policy->writer_sha256) || !expect_json_text(&cursor, ",\"privateExporterSha256\":" ) ||
        !parse_digest_string(&cursor, policy->private_exporter_sha256) || !expect_json_text(&cursor, ",\"patchManifestSha256\":" ) ||
        !parse_digest_string(&cursor, policy->patch_manifest_sha256) || !expect_json_text(&cursor, "}" ) || cursor.cursor != cursor.end) return 0;
    if (strcmp(policy->config.blender_runtime_root, "/opt/blender") != 0 || strcmp(policy->config.blender_executable, "/opt/blender/blender") != 0 ||
        strcmp(policy->config.writer_script, "/opt/swooshz/writer.py") != 0 || strcmp(policy->config.private_work_root, PRIVATE_ROOT_PATH) != 0 ||
        strcmp(policy->config.process_runner_executable, RUNNER_PATH) != 0 || strcmp(policy->config.sandbox_executable, LAUNCHER_PATH) != 0 ||
        strcmp(policy->config.native_validator_executable, VALIDATOR_PATH) != 0 || strcmp(policy->config.sandbox_policy_sha256, "") == 0) return 0;
    if (!serialize_policy(&final_bytes, policy, 1) || final_bytes.length != length || memcmp(final_bytes.bytes, bytes, length) != 0) return 0;
    if (!serialize_policy(&preimage, policy, 0) || preimage.length == 0U) return 0;
    sha256_bytes(preimage.bytes, preimage.length, policy_digest);
    hex_encode(policy_digest, sizeof(policy_digest), policy->policy_sha256);
    if (strcmp(policy->policy_sha256, policy->config.sandbox_policy_sha256) != 0) return 0;
    if (!serialize_config(&config_bytes, &policy->config, 1) || config_bytes.length == 0U) return 0;
    sha256_bytes(config_bytes.bytes, config_bytes.length, config_digest);
    hex_encode(config_digest, sizeof(config_digest), policy->config_sha256);
    return 1;
}

#ifdef S8_BROKER_CONTRACT_TEST
static void set_oracle_policy(deployed_policy *policy, uint32_t host_uid)
{
    memset(policy, 0, sizeof(*policy));
    policy->host_uid = host_uid;
    policy->host_gid = 1000U;
    (void)strcpy(policy->config.blender_runtime_root, "/opt/blender");
    (void)strcpy(policy->config.blender_executable, "/opt/blender/blender");
    (void)strcpy(policy->config.writer_script, "/opt/swooshz/writer.py");
    (void)strcpy(policy->config.private_work_root, PRIVATE_ROOT_PATH);
    (void)strcpy(policy->config.process_runner_executable, RUNNER_PATH);
    (void)strcpy(policy->config.sandbox_executable, LAUNCHER_PATH);
    (void)strcpy(policy->config.native_validator_executable, VALIDATOR_PATH);
    (void)strcpy(policy->config.blender_executable_sha256, "1111111111111111111111111111111111111111111111111111111111111111");
    (void)strcpy(policy->private_root_device, "2049");
    (void)strcpy(policy->private_root_inode, "123456");
    (void)strcpy(policy->launcher_sha256, "2222222222222222222222222222222222222222222222222222222222222222");
    (void)strcpy(policy->broker_sha256, "3333333333333333333333333333333333333333333333333333333333333333");
    (void)strcpy(policy->bubblewrap_sha256, "4444444444444444444444444444444444444444444444444444444444444444");
    (void)strcpy(policy->runner_sha256, "5555555555555555555555555555555555555555555555555555555555555555");
    (void)strcpy(policy->validator_sha256, "6666666666666666666666666666666666666666666666666666666666666666");
    (void)strcpy(policy->writer_sha256, "7777777777777777777777777777777777777777777777777777777777777777");
    (void)strcpy(policy->private_exporter_sha256, "8888888888888888888888888888888888888888888888888888888888888888");
    (void)strcpy(policy->patch_manifest_sha256, "9999999999999999999999999999999999999999999999999999999999999999");
}

static int make_oracle_final(deployed_policy *policy, byte_builder *final_bytes, byte_builder *preimage, byte_builder *config_bytes)
{
    unsigned char digest[32];
    if (!serialize_policy(preimage, policy, 0)) return 0;
    sha256_bytes(preimage->bytes, preimage->length, digest);
    hex_encode(digest, sizeof(digest), policy->policy_sha256);
    (void)strcpy(policy->config.sandbox_policy_sha256, policy->policy_sha256);
    if (!serialize_config(config_bytes, &policy->config, 1) || !serialize_policy(final_bytes, policy, 1)) return 0;
    sha256_bytes(config_bytes->bytes, config_bytes->length, digest);
    hex_encode(digest, sizeof(digest), policy->config_sha256);
    final_bytes->bytes[final_bytes->length] = 0U;
    return 1;
}

static int replace_once(const unsigned char *input, size_t input_length, const char *needle, const char *replacement, byte_builder *output)
{
    const unsigned char *found = NULL;
    size_t needle_length = strlen(needle), replacement_length = strlen(replacement), index;
    if (needle_length == 0U || input_length > POLICY_MAX_BYTES) return 0;
    for (index = 0U; index + needle_length <= input_length; index++) {
        if (memcmp(input + index, needle, needle_length) == 0) { found = input + index; break; }
    }
    if (!found || (size_t)(found - input) + replacement_length + input_length - (size_t)(found - input) - needle_length > POLICY_MAX_BYTES) return 0;
    output->length = 0U;
    output->failed = 0;
    if (!append_bytes(output, input, (size_t)(found - input)) || !append_text(output, replacement) ||
        !append_bytes(output, found + needle_length, input_length - (size_t)(found - input) - needle_length)) return 0;
    output->bytes[output->length] = 0U;
    return 1;
}

static int policy_rejects(const byte_builder *candidate)
{
    deployed_policy parsed;
    return !parse_policy_bytes(candidate->bytes, candidate->length, &parsed);
}

static int policy_identity_self_test(void)
{
    static const char expected_h[] = "73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f";
    static const char expected_q[] = "f3359c5e130c7806750275d6a2eb01ca9c214a07fb2f472f86db8daa8c2007ce";
    static const char expected_f_hash[] = "8d0c33828fe0105f88039e5b0a88f91ecbec09b3aef2a66ceb3b1d695a4fd72d";
    static const char expected_b_h[] = "1860a912dad47d8b7737854e3f605d4092d77ad41c1ec2227a21503010029f36";
    static const char expected_b_q[] = "e7dc7e6fa65c746ee8a2c5aee1c89282f728a23095d23a1bf2d7d267af0bb971";
    deployed_policy policy, parsed;
    byte_builder final_bytes = {{0U}, 0U, 0}, preimage = {{0U}, 0U, 0}, config_bytes = {{0U}, 0U, 0};
    byte_builder candidate = {{0U}, 0U, 0}, diagnostic_config = {{0U}, 0U, 0};
    unsigned char digest[32];
    char diagnostic[65];
    char wrong_digest[65];
    set_oracle_policy(&policy, 1000U);
    if (!make_oracle_final(&policy, &final_bytes, &preimage, &config_bytes) || preimage.length != 1336U || config_bytes.length != 561U || final_bytes.length != 1425U) return 0;
    if (strcmp(policy.policy_sha256, expected_h) != 0 || strcmp(policy.config_sha256, expected_q) != 0) return 0;
    sha256_bytes(final_bytes.bytes, final_bytes.length, digest);
    hex_encode(digest, sizeof(digest), diagnostic);
    if (strcmp(diagnostic, expected_f_hash) != 0 || strcmp(diagnostic, policy.policy_sha256) == 0) return 0;
    if (!parse_policy_bytes(final_bytes.bytes, final_bytes.length, &parsed) || strcmp(parsed.policy_sha256, expected_h) != 0 || strcmp(parsed.config_sha256, expected_q) != 0) return 0;
    if (!serialize_config(&diagnostic_config, &policy.config, 0)) return 0;
    sha256_bytes(diagnostic_config.bytes, diagnostic_config.length, digest);
    hex_encode(digest, sizeof(digest), wrong_digest);
    if (strcmp(wrong_digest, expected_q) == 0) return 0;

    set_oracle_policy(&policy, 1001U);
    final_bytes.length = preimage.length = config_bytes.length = 0U;
    if (!make_oracle_final(&policy, &final_bytes, &preimage, &config_bytes) || strcmp(policy.policy_sha256, expected_b_h) != 0 || strcmp(policy.config_sha256, expected_b_q) != 0) return 0;
    if (!parse_policy_bytes(final_bytes.bytes, final_bytes.length, &parsed)) return 0;

    (void)strcpy(policy.config.sandbox_policy_sha256, expected_f_hash);
    candidate.length = 0U;
    if (!serialize_policy(&candidate, &policy, 1)) return 0;
    candidate.bytes[candidate.length] = 0U;
    if (!policy_rejects(&candidate)) return 0;
    if (!serialize_policy(&candidate, &policy, 0)) return 0;
    candidate.bytes[candidate.length] = 0U;
    if (!policy_rejects(&candidate)) return 0;

    set_oracle_policy(&policy, 1000U);
    final_bytes.length = preimage.length = config_bytes.length = 0U;
    if (!make_oracle_final(&policy, &final_bytes, &preimage, &config_bytes)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":null", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"0000000000000000000000000000000000000000000000000000000000000000\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\" ", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"73FA2120547140C024F40EB43399649949F7DA1BB152622B018DF588E886013F\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"73fa\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\"sha256:73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"sandboxPolicySha256\":\"73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", "\"sandboxPolicySha256\":\" 73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"blenderRuntimeRoot\":\"/opt/blender\"", "\"blenderRuntimeRoot\":\"\\/opt/blender\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"hostUid\":1000", "\"hostUid\":1e3", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"hostUid\":1000", "\"hostUid\":1000.0", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"hostUid\":1000", "\"hostUid\":01000", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "{\"schemaVersion\":", "{ \"schemaVersion\":", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"schemaVersion\":\"s8-sandbox-broker-policy-v1\"", "\"schemaVersion\":\"s8-sandbox-broker-policy-v1\",\"unknown\":0", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"hostUid\":1000", "\"hostUid\":1000,\"hostUid\":1000", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"blenderRuntimeRoot\":\"/opt/blender\",\"blenderExecutable\":\"/opt/blender/blender\"", "\"blenderExecutable\":\"/opt/blender/blender\",\"blenderRuntimeRoot\":\"/opt/blender\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"blenderRuntimeRoot\":\"/opt/blender\"", "\"blenderRuntimeRoot\":\"/opt/blender\",\"extra\":true", &candidate) || !policy_rejects(&candidate)) return 0;
    if (!replace_once(final_bytes.bytes, final_bytes.length, "\"protocolVersion\":\"s8-sandbox-broker-v1\",\"hostUid\"", "\"hostUid\":1000,\"protocolVersion\":\"s8-sandbox-broker-v1\",\"hostUid\"", &candidate) || !policy_rejects(&candidate)) return 0;
    if (final_bytes.length + 1U > POLICY_MAX_BYTES) return 0;
    memcpy(candidate.bytes, final_bytes.bytes, final_bytes.length);
    candidate.bytes[final_bytes.length] = '\n'; candidate.length = final_bytes.length + 1U;
    if (!policy_rejects(&candidate)) return 0;
    candidate.bytes[final_bytes.length] = '\r'; candidate.bytes[final_bytes.length + 1U] = '\n'; candidate.length = final_bytes.length + 2U;
    if (!policy_rejects(&candidate)) return 0;
    memmove(candidate.bytes + 3U, final_bytes.bytes, final_bytes.length);
    candidate.bytes[0] = 0xefU; candidate.bytes[1] = 0xbbU; candidate.bytes[2] = 0xbfU; candidate.length = final_bytes.length + 3U;
    if (!policy_rejects(&candidate)) return 0;
    return 1;
}
#endif

typedef enum {
    STATUS_SUCCESS = 0,
    STATUS_PROTOCOL_INVALID = 64,
    STATUS_CALLER_OR_POLICY_INVALID = 65,
    STATUS_ROOT_OR_DEPLOYMENT_INVALID = 66,
    STATUS_JOURNAL_INVALID = 67,
    STATUS_ALLOCATION_OR_INPUT_ADMISSION_FAILED = 68,
    STATUS_LAUNCH_OR_STATUS_INVALID = 69,
    STATUS_NATIVE_OPERATION_FAILED = 70,
    STATUS_OUTPUT_OR_RECEIPT_INVALID = 71,
    STATUS_CLEANUP_HOLD = 72,
    STATUS_RECOVERY_IDENTITY_UNKNOWN_HOLD = 73,
    STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD = 74,
    STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD = 75,
    STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD = 76,
    STATUS_RECOVERY_RETRY_LIMIT_HOLD = 77,
    STATUS_BUSY = 78,
    STATUS_BROKER_INTERNAL = 79,
    STATUS_OPERATION_TIMEOUT = 124
} broker_status;

typedef enum {
    OP_WRITER = 1,
    OP_VALIDATOR = 2,
    OP_RECOVER = 3
} broker_operation;

typedef struct {
    broker_operation operation;
    unsigned char request_id[16];
    unsigned char policy_sha256[32];
    unsigned char config_sha256[32];
    uint64_t payload_length;
    unsigned char payload_sha256[32];
} broker_request;

typedef struct {
    broker_operation operation;
    broker_status status;
    unsigned char request_id[16];
    unsigned char allocation_id[16];
    unsigned char runner_pre_sha256[32];
    unsigned char runner_post_sha256[32];
    unsigned char policy_sha256[32];
    unsigned char config_sha256[32];
    int32_t native_outer_exit;
    int32_t native_outer_signal;
    const unsigned char *sections[5];
    uint64_t section_lengths[5];
} broker_response;

static uint16_t read_u16_be(const unsigned char *value)
{
    return (uint16_t)(((uint16_t)value[0] << 8U) | (uint16_t)value[1]);
}

static uint64_t read_u64_be(const unsigned char *value)
{
    uint64_t result = 0U;
    size_t index;
    for (index = 0U; index < 8U; index++) result = (result << 8U) | value[index];
    return result;
}

static void write_u16_be(unsigned char *value, uint16_t number)
{
    value[0] = (unsigned char)(number >> 8U);
    value[1] = (unsigned char)number;
}

static void write_u64_be(unsigned char *value, uint64_t number)
{
    size_t index;
    for (index = 0U; index < 8U; index++) value[index] = (unsigned char)(number >> (56U - (index * 8U)));
}

static void write_i32_be(unsigned char *value, int32_t number)
{
    uint32_t bits = (uint32_t)number;
    value[0] = (unsigned char)(bits >> 24U);
    value[1] = (unsigned char)(bits >> 16U);
    value[2] = (unsigned char)(bits >> 8U);
    value[3] = (unsigned char)bits;
}

static int parse_request_header(const unsigned char header[REQUEST_HEADER_BYTES], broker_request *request)
{
    size_t index;
    uint64_t maximum;
    if (memcmp(header, "S8BRQ001", 8U) != 0 || read_u16_be(header + 8U) != 1U || header[11] != 0U) return 0;
    if (header[10] < OP_WRITER || header[10] > OP_RECOVER) return 0;
    for (index = 132U; index < REQUEST_HEADER_BYTES; index++) if (header[index] != 0U) return 0;
    request->operation = (broker_operation)header[10];
    memcpy(request->request_id, header + 12U, sizeof(request->request_id));
    memcpy(request->policy_sha256, header + 28U, sizeof(request->policy_sha256));
    memcpy(request->config_sha256, header + 60U, sizeof(request->config_sha256));
    request->payload_length = read_u64_be(header + 92U);
    memcpy(request->payload_sha256, header + 100U, sizeof(request->payload_sha256));
    if (request->operation == OP_WRITER) maximum = WRITER_MAX_PAYLOAD;
    else if (request->operation == OP_VALIDATOR) maximum = VALIDATOR_MAX_PAYLOAD;
    else maximum = 0U;
    if (request->payload_length > maximum || request->payload_length > SIZE_MAX || request->payload_length + REQUEST_HEADER_BYTES > MAX_REQUEST_BYTES) return 0;
    return 1;
}

static int request_identity_matches(const broker_request *request, const deployed_policy *policy)
{
    unsigned char expected_policy[32], expected_config[32];
    if (!hex_decode_32(policy->policy_sha256, expected_policy) || !hex_decode_32(policy->config_sha256, expected_config)) return 0;
    return constant_equal(request->policy_sha256, expected_policy, sizeof(expected_policy)) && constant_equal(request->config_sha256, expected_config, sizeof(expected_config));
}

#ifdef S8_BROKER_CONTRACT_TEST
static int policy_request_binding_self_test(void)
{
    deployed_policy policy_a, policy_b;
    broker_request request;
    byte_builder final_a = {{0U}, 0U, 0}, preimage_a = {{0U}, 0U, 0}, config_a = {{0U}, 0U, 0};
    byte_builder final_b = {{0U}, 0U, 0}, preimage_b = {{0U}, 0U, 0}, config_b = {{0U}, 0U, 0};
    memset(&request, 0, sizeof(request));
    set_oracle_policy(&policy_a, 1000U);
    set_oracle_policy(&policy_b, 1001U);
    if (!make_oracle_final(&policy_a, &final_a, &preimage_a, &config_a) ||
        !make_oracle_final(&policy_b, &final_b, &preimage_b, &config_b) ||
        !hex_decode_32(policy_a.policy_sha256, request.policy_sha256) ||
        !hex_decode_32(policy_a.config_sha256, request.config_sha256) ||
        !request_identity_matches(&request, &policy_a)) return 0;
    if (!hex_decode_32(policy_b.policy_sha256, request.policy_sha256) ||
        !hex_decode_32(policy_b.config_sha256, request.config_sha256) ||
        !request_identity_matches(&request, &policy_b)) return 0;
    if (!hex_decode_32(policy_a.policy_sha256, request.policy_sha256) ||
        !hex_decode_32(policy_b.config_sha256, request.config_sha256) ||
        request_identity_matches(&request, &policy_a)) return 0;
    if (!hex_decode_32(policy_b.policy_sha256, request.policy_sha256) ||
        !hex_decode_32(policy_a.config_sha256, request.config_sha256) ||
        request_identity_matches(&request, &policy_b)) return 0;
    if (!hex_decode_32(policy_b.policy_sha256, request.policy_sha256) ||
        !hex_decode_32(policy_a.config_sha256, request.config_sha256) ||
        request_identity_matches(&request, &policy_a)) return 0;
    return 1;
}
#endif

static uint64_t monotonic_milliseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0U;
    return (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U;
}

static int wait_readable_until(int fd, uint64_t deadline)
{
    for (;;) {
        uint64_t now = monotonic_milliseconds();
        int timeout;
        struct pollfd descriptor = { fd, POLLIN | POLLHUP, 0 };
        int result;
        if (now == 0U || now >= deadline) return 0;
        timeout = (int)((deadline - now) > (uint64_t)INT_MAX ? INT_MAX : (deadline - now));
        result = poll(&descriptor, 1U, timeout);
        if (result > 0) return (descriptor.revents & (POLLIN | POLLHUP | POLLERR)) != 0;
        if (result == 0) return 0;
        if (errno != EINTR) return -1;
    }
}

static int read_full_until(int fd, unsigned char *buffer, size_t length, uint64_t deadline)
{
    size_t offset = 0U;
    while (offset < length) {
        ssize_t count;
        int readable = wait_readable_until(fd, deadline);
        if (readable <= 0) return readable;
        count = read(fd, buffer + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) return -1;
        if (count == 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

static int read_request_payload(int fd, const broker_request *request, unsigned char **payload)
{
    uint64_t now = monotonic_milliseconds();
    uint64_t deadline;
    size_t length = (size_t)request->payload_length;
    unsigned char *bytes = length == 0U ? NULL : malloc(length);
    unsigned char digest[32];
    unsigned char extra;
    int result;
    if (now == 0U || now > UINT64_MAX - UINT64_C(30000)) return -1;
    deadline = now + UINT64_C(30000);
    if (length != 0U && !bytes) return -1;
    if (length != 0U) {
        result = read_full_until(fd, bytes, length, deadline);
        if (result <= 0) {
            int timed_out = result == 0 && monotonic_milliseconds() >= deadline;
            free(bytes);
            return timed_out ? 2 : result;
        }
    }
    result = wait_readable_until(fd, deadline);
    if (result <= 0) {
        int timed_out = result == 0 && monotonic_milliseconds() >= deadline;
        free(bytes);
        return timed_out ? 2 : result;
    }
    do { result = (int)read(fd, &extra, 1U); } while (result < 0 && errno == EINTR);
    if (result != 0) { free(bytes); return result < 0 ? -1 : 0; }
    sha256_bytes(bytes, length, digest);
    if (!constant_equal(digest, request->payload_sha256, sizeof(digest))) { free(bytes); return 0; }
    *payload = bytes;
    return 1;
}

static uint64_t monotonic_milliseconds(void);

static int write_full_until(int fd, const unsigned char *bytes, size_t length, uint64_t deadline)
{
    size_t offset = 0U;
    while (offset < length) {
        struct pollfd descriptor = { fd, POLLOUT, 0 };
        uint64_t now = monotonic_milliseconds();
        int timeout, ready;
        size_t amount = length - offset;
        ssize_t written;
        if (now == 0U || now >= deadline) return 0;
        timeout = (int)((deadline - now) > (uint64_t)INT_MAX ? INT_MAX : deadline - now);
        ready = poll(&descriptor, 1U, timeout);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0 || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) return 0;
        if (amount > 4096U) amount = 4096U;
        written = write(fd, bytes + offset, amount);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 0;
        offset += (size_t)written;
    }
    return 1;
}

static int write_broker_response(const broker_response *response)
{
    unsigned char header[RESPONSE_HEADER_BYTES];
    unsigned char section_digest[32];
    sha256_context context;
    uint64_t total = RESPONSE_HEADER_BYTES;
    uint64_t limit = response->operation == OP_WRITER ? WRITER_MAX_RESPONSE : response->operation == OP_VALIDATOR ? VALIDATOR_MAX_RESPONSE : RECOVER_MAX_RESPONSE;
    uint64_t deadline = monotonic_milliseconds() + UINT64_C(30000);
    size_t index;
    memset(header, 0, sizeof(header));
    memcpy(header, "S8BRS001", 8U);
    write_u16_be(header + 8U, 1U);
    header[10] = (unsigned char)response->operation;
    memcpy(header + 12U, response->request_id, sizeof(response->request_id));
    write_u16_be(header + 28U, (uint16_t)response->status);
    write_i32_be(header + 32U, response->native_outer_exit);
    write_i32_be(header + 36U, response->native_outer_signal);
    memcpy(header + 40U, response->allocation_id, sizeof(response->allocation_id));
    memcpy(header + 56U, response->runner_pre_sha256, sizeof(response->runner_pre_sha256));
    memcpy(header + 88U, response->runner_post_sha256, sizeof(response->runner_post_sha256));
    memcpy(header + 120U, response->policy_sha256, sizeof(response->policy_sha256));
    memcpy(header + 152U, response->config_sha256, sizeof(response->config_sha256));
    sha256_init(&context);
    for (index = 0U; index < ARRAY_LENGTH(response->sections); index++) {
        if (response->section_lengths[index] > UINT64_MAX - total) return 0;
        total += response->section_lengths[index];
        if (response->section_lengths[index] != 0U && response->sections[index] == NULL) return 0;
        if (response->section_lengths[index] > SIZE_MAX) return 0;
        write_u64_be(header + 184U + index * 8U, response->section_lengths[index]);
        sha256_update(&context, response->sections[index], (size_t)response->section_lengths[index]);
    }
    if (total > limit || response->section_lengths[4] > METADATA_MAX_BYTES || response->section_lengths[3] > BROKER_STDERR_MAX_BYTES) return 0;
    sha256_final(&context, section_digest);
    memcpy(header + 224U, section_digest, sizeof(section_digest));
    if (!write_full_until(STDOUT_FILENO, header, sizeof(header), deadline)) return 0;
    for (index = 0U; index < ARRAY_LENGTH(response->sections); index++) {
        if (response->section_lengths[index] != 0U && !write_full_until(STDOUT_FILENO, response->sections[index], (size_t)response->section_lengths[index], deadline)) return 0;
    }
    return 1;
}

static int parse_u64_decimal(const char *text, uint64_t *value)
{
    uint64_t parsed = 0U;
    size_t index, length = strlen(text);
    if (length == 0U || (length > 1U && text[0] == '0')) return 0;
    for (index = 0U; index < length; index++) {
        uint64_t digit;
        if (text[index] < '0' || text[index] > '9') return 0;
        digit = (uint64_t)(text[index] - '0');
        if (parsed > (UINT64_MAX - digit) / 10U) return 0;
        parsed = parsed * 10U + digit;
    }
    *value = parsed;
    return 1;
}

static int path_components_are_canonical(const char *path)
{
    size_t length = strlen(path), start = 1U, index;
    if (strcmp(path, "/") == 0) return 1;
    if (length == 0U || length > 1024U || path[0] != '/' || (length > 1U && path[length - 1U] == '/')) return 0;
    for (index = 0U; index < length; index++) {
        unsigned char value = (unsigned char)path[index];
        if (value < 0x20U || (value >= 0x7fU && value <= 0x9fU)) return 0;
    }
    for (index = 1U; index <= length; index++) {
        if (index == length || path[index] == '/') {
            size_t component_length = index - start;
            if (component_length == 0U || (component_length == 1U && path[start] == '.') || (component_length == 2U && path[start] == '.' && path[start + 1U] == '.')) return 0;
            start = index + 1U;
        }
    }
    return 1;
}

static int statx_mount_id(int fd, uint64_t *mount_id)
{
    struct statx metadata;
    memset(&metadata, 0, sizeof(metadata));
#ifdef SYS_statx
    if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_MNT_ID, &metadata) != 0) return 0;
#else
    (void)fd;
    (void)mount_id;
    return 0;
#endif
    if ((metadata.stx_mask & STATX_MNT_ID) == 0U) return 0;
    *mount_id = metadata.stx_mnt_id;
    return 1;
}

static int root_controlled_directory_stat(const struct stat *metadata)
{
    return S_ISDIR(metadata->st_mode) && metadata->st_uid == 0U && metadata->st_gid == 0U && (metadata->st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) == 0;
}

static int open_directory_path(const char *path, int require_root_control)
{
    char copy[1025];
    char *cursor;
    int current;
    struct stat metadata;
    if (!path_components_are_canonical(path)) { errno = EINVAL; return -1; }
    current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (current < 0) return -1;
    if (fstat(current, &metadata) != 0 || (require_root_control && !root_controlled_directory_stat(&metadata))) { close(current); errno = EPERM; return -1; }
    if (strcmp(path, "/") == 0) return current;
    (void)strcpy(copy, path + 1U);
    cursor = copy;
    while (*cursor != '\0') {
        char *slash = strchr(cursor, '/');
        int next;
        if (slash) *slash = '\0';
        next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (next < 0) { close(current); return -1; }
        if (fstat(next, &metadata) != 0 || (require_root_control && !root_controlled_directory_stat(&metadata))) { close(next); close(current); errno = EPERM; return -1; }
        close(current);
        current = next;
        if (!slash) break;
        cursor = slash + 1;
    }
    return current;
}

static int open_regular_file_path(const char *path, int allow_final_symlink, struct stat *metadata)
{
    char parent_path[1025];
    const char *separator;
    const char *basename;
    int parent_fd, file_fd, flags = O_RDONLY | O_CLOEXEC;
    if (!path_components_are_canonical(path) || strcmp(path, "/") == 0) { errno = EINVAL; return -1; }
    separator = strrchr(path, '/');
    if (!separator || separator[1] == '\0') { errno = EINVAL; return -1; }
    basename = separator + 1;
    if (separator == path) (void)strcpy(parent_path, "/");
    else {
        size_t parent_length = (size_t)(separator - path);
        memcpy(parent_path, path, parent_length);
        parent_path[parent_length] = '\0';
    }
    parent_fd = open_directory_path(parent_path, 1);
    if (parent_fd < 0) return -1;
    if (!allow_final_symlink) flags |= O_NOFOLLOW;
    file_fd = openat(parent_fd, basename, flags);
    close(parent_fd);
    if (file_fd < 0) return -1;
    if (fstat(file_fd, metadata) != 0 || !S_ISREG(metadata->st_mode)) { close(file_fd); errno = EPERM; return -1; }
    return file_fd;
}

static int get_acl_xattr(int fd, const char *name, unsigned char *buffer, size_t capacity, size_t *length)
{
    ssize_t result = fgetxattr(fd, name, buffer, capacity);
    if (result < 0) return errno == ENODATA || errno == ENOTSUP ? 0 : -1;
    *length = (size_t)result;
    return 1;
}

static uint16_t read_u16_le(const unsigned char *value)
{
    return (uint16_t)((uint16_t)value[0] | ((uint16_t)value[1] << 8U));
}

static uint32_t read_u32_le(const unsigned char *value)
{
    return (uint32_t)value[0] | ((uint32_t)value[1] << 8U) | ((uint32_t)value[2] << 16U) | ((uint32_t)value[3] << 24U);
}

typedef struct {
    uint16_t tag;
    uint16_t permissions;
    uint32_t identifier;
} acl_entry_value;

static int read_acl(int fd, const char *name, acl_entry_value *entries, size_t maximum, size_t *count)
{
    unsigned char bytes[4U + 8U * 16U];
    size_t length = 0U, index;
    int result = get_acl_xattr(fd, name, bytes, sizeof(bytes), &length);
    if (result <= 0) return result;
    if (length < 4U || read_u32_le(bytes) != 2U || (length - 4U) % 8U != 0U) return -1;
    *count = (length - 4U) / 8U;
    if (*count > maximum) return -1;
    for (index = 0U; index < *count; index++) {
        entries[index].tag = read_u16_le(bytes + 4U + index * 8U);
        entries[index].permissions = read_u16_le(bytes + 6U + index * 8U);
        entries[index].identifier = read_u32_le(bytes + 8U + index * 8U);
    }
    return 1;
}

static int acl_entries_equal(const acl_entry_value *actual, size_t actual_count, const acl_entry_value *expected, size_t expected_count)
{
    size_t index;
    if (actual_count != expected_count) return 0;
    for (index = 0U; index < actual_count; index++) {
        if (actual[index].tag != expected[index].tag || actual[index].permissions != expected[index].permissions || actual[index].identifier != expected[index].identifier) return 0;
    }
    return 1;
}

static int acl_default_is_absent(int fd)
{
    unsigned char bytes[4U + 8U * 16U];
    size_t length = 0U;
    int result = get_acl_xattr(fd, "system.posix_acl_default", bytes, sizeof(bytes), &length);
    return result == 0;
}

static int private_root_acl_valid(int fd, uint32_t host_uid)
{
    const acl_entry_value expected[] = {
        { 0x01U, 7U, UINT32_MAX }, { 0x02U, 1U, host_uid }, { 0x04U, 0U, UINT32_MAX },
        { 0x10U, 1U, UINT32_MAX }, { 0x20U, 0U, UINT32_MAX }
    };
    acl_entry_value actual[16];
    size_t count = 0U;
    int result = read_acl(fd, "system.posix_acl_access", actual, ARRAY_LENGTH(actual), &count);
    return result == 1 && acl_entries_equal(actual, count, expected, ARRAY_LENGTH(expected)) && acl_default_is_absent(fd);
}

static int allocation_directory_acl_valid(int fd, uint32_t host_uid, int require_default)
{
    const acl_entry_value expected_access[] = {
        { 0x01U, 7U, UINT32_MAX }, { 0x02U, 7U, host_uid }, { 0x04U, 0U, UINT32_MAX },
        { 0x10U, 7U, UINT32_MAX }, { 0x20U, 0U, UINT32_MAX }
    };
    acl_entry_value actual[16];
    size_t count = 0U;
    int result = read_acl(fd, "system.posix_acl_access", actual, ARRAY_LENGTH(actual), &count);
    if (result != 1 || !acl_entries_equal(actual, count, expected_access, ARRAY_LENGTH(expected_access))) return 0;
    if (!require_default) return acl_default_is_absent(fd);
    result = read_acl(fd, "system.posix_acl_default", actual, ARRAY_LENGTH(actual), &count);
    return result == 1 && acl_entries_equal(actual, count, expected_access, ARRAY_LENGTH(expected_access));
}

static int seed_acl_valid(int fd, uint32_t host_uid, int post)
{
    acl_entry_value expected[6];
    acl_entry_value actual[16];
    size_t expected_count = 0U, actual_count = 0U;
    expected[expected_count++] = (acl_entry_value){ 0x01U, 6U, UINT32_MAX };
    if (post) expected[expected_count++] = (acl_entry_value){ 0x02U, 4U, 0U };
    expected[expected_count++] = (acl_entry_value){ 0x02U, 7U, host_uid };
    expected[expected_count++] = (acl_entry_value){ 0x04U, 0U, UINT32_MAX };
    expected[expected_count++] = (acl_entry_value){ 0x10U, 6U, UINT32_MAX };
    expected[expected_count++] = (acl_entry_value){ 0x20U, 0U, UINT32_MAX };
    return read_acl(fd, "system.posix_acl_access", actual, ARRAY_LENGTH(actual), &actual_count) == 1 &&
        acl_entries_equal(actual, actual_count, expected, expected_count) && acl_default_is_absent(fd);
}

static void write_u16_le(unsigned char *value, uint16_t number)
{
    value[0] = (unsigned char)number;
    value[1] = (unsigned char)(number >> 8U);
}

static void write_u32_le(unsigned char *value, uint32_t number)
{
    value[0] = (unsigned char)number;
    value[1] = (unsigned char)(number >> 8U);
    value[2] = (unsigned char)(number >> 16U);
    value[3] = (unsigned char)(number >> 24U);
}

static int set_acl_xattr(int fd, const char *name, const acl_entry_value *entries, size_t count)
{
    unsigned char bytes[4U + 8U * 16U];
    size_t index;
    if (count > 16U) return 0;
    write_u32_le(bytes, 2U);
    for (index = 0U; index < count; index++) {
        write_u16_le(bytes + 4U + index * 8U, entries[index].tag);
        write_u16_le(bytes + 6U + index * 8U, entries[index].permissions);
        write_u32_le(bytes + 8U + index * 8U, entries[index].identifier);
    }
    return fsetxattr(fd, name, bytes, 4U + count * 8U, 0) == 0;
}

static int set_allocation_acl(int fd, uint32_t host_uid)
{
    const acl_entry_value access[] = {
        { 0x01U, 7U, UINT32_MAX }, { 0x02U, 7U, host_uid }, { 0x04U, 0U, UINT32_MAX },
        { 0x10U, 7U, UINT32_MAX }, { 0x20U, 0U, UINT32_MAX }
    };
    return set_acl_xattr(fd, "system.posix_acl_access", access, ARRAY_LENGTH(access)) &&
        set_acl_xattr(fd, "system.posix_acl_default", access, ARRAY_LENGTH(access));
}

static int set_seed_acl(int fd, uint32_t host_uid, int post)
{
    acl_entry_value entries[6];
    size_t count = 0U;
    entries[count++] = (acl_entry_value){ 0x01U, 6U, UINT32_MAX };
    if (post) entries[count++] = (acl_entry_value){ 0x02U, 4U, 0U };
    entries[count++] = (acl_entry_value){ 0x02U, 7U, host_uid };
    entries[count++] = (acl_entry_value){ 0x04U, 0U, UINT32_MAX };
    entries[count++] = (acl_entry_value){ 0x10U, 6U, UINT32_MAX };
    entries[count++] = (acl_entry_value){ 0x20U, 0U, UINT32_MAX };
    return set_acl_xattr(fd, "system.posix_acl_access", entries, count);
}

static int metadata_file_valid(const struct stat *metadata, mode_t required_mode)
{
    return S_ISREG(metadata->st_mode) && metadata->st_uid == 0U && metadata->st_gid == 0U &&
        (metadata->st_mode & 07777U) == required_mode && metadata->st_nlink == 1U;
}

static int hash_file_matches(const char *path, const char *expected_hex, mode_t required_mode, struct stat *result_metadata)
{
    struct stat before, after;
    unsigned char actual_digest[32], expected_digest[32];
    int fd = open_regular_file_path(path, 0, &before);
    int valid;
    if (fd < 0) return 0;
    valid = metadata_file_valid(&before, required_mode) && hex_decode_32(expected_hex, expected_digest) && sha256_fd(fd, actual_digest) && constant_equal(actual_digest, expected_digest, sizeof(actual_digest)) && fstat(fd, &after) == 0;
    if (valid) valid = before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_size == after.st_size && before.st_mtime == after.st_mtime && before.st_ctime == after.st_ctime;
    if (valid && result_metadata) *result_metadata = after;
    close(fd);
    return valid;
}

static int file_sha256_digest(const char *path, unsigned char digest[32])
{
    struct stat before, after;
    int fd = open_regular_file_path(path, 0, &before);
    int valid;
    if (fd < 0) return 0;
    valid = metadata_file_valid(&before, 0755U) && sha256_fd(fd, digest) && fstat(fd, &after) == 0 &&
        before.st_dev == after.st_dev && before.st_ino == after.st_ino && before.st_size == after.st_size &&
        before.st_mtime == after.st_mtime && before.st_ctime == after.st_ctime;
    close(fd);
    return valid;
}

static int runtime_bind_file_valid(const char *path)
{
    char resolved[PATH_MAX];
    struct stat metadata;
    int fd;
    int valid;
    if (!realpath(path, resolved)) return 0;
    fd = open_regular_file_path(resolved, 0, &metadata);
    if (fd < 0) return 0;
    valid = S_ISREG(metadata.st_mode) && metadata.st_uid == 0U && metadata.st_gid == 0U &&
        (metadata.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID)) == 0 && metadata.st_nlink >= 1U;
    close(fd);
    return valid;
}

static const char *const system_runtime_paths[] = {
    "/lib64/ld-linux-x86-64.so.2",
    "/lib/x86_64-linux-gnu/libGL.so.1",
    "/lib/x86_64-linux-gnu/libGLX.so.0",
    "/lib/x86_64-linux-gnu/libGLdispatch.so.0",
    "/lib/x86_64-linux-gnu/libICE.so.6",
    "/lib/x86_64-linux-gnu/libSM.so.6",
    "/lib/x86_64-linux-gnu/libX11.so.6",
    "/lib/x86_64-linux-gnu/libXau.so.6",
    "/lib/x86_64-linux-gnu/libXdmcp.so.6",
    "/lib/x86_64-linux-gnu/libXext.so.6",
    "/lib/x86_64-linux-gnu/libXfixes.so.3",
    "/lib/x86_64-linux-gnu/libXi.so.6",
    "/lib/x86_64-linux-gnu/libXrender.so.1",
    "/lib/x86_64-linux-gnu/libbsd.so.0",
    "/lib/x86_64-linux-gnu/libc.so.6",
    "/lib/x86_64-linux-gnu/libdl.so.2",
    "/lib/x86_64-linux-gnu/libgcc_s.so.1",
    "/lib/x86_64-linux-gnu/libm.so.6",
    "/lib/x86_64-linux-gnu/libmd.so.0",
    "/lib/x86_64-linux-gnu/libpthread.so.0",
    "/lib/x86_64-linux-gnu/librt.so.1",
    "/lib/x86_64-linux-gnu/libstdc++.so.6",
    "/lib/x86_64-linux-gnu/libutil.so.1",
    "/lib/x86_64-linux-gnu/libuuid.so.1",
    "/lib/x86_64-linux-gnu/libxcb.so.1",
    "/lib/x86_64-linux-gnu/libxkbcommon.so.0",
    "/etc/passwd"
};

static int private_root_open_and_validate(const deployed_policy *policy, int *root_fd, uint64_t *mount_id)
{
    struct stat metadata;
    uint64_t expected_device, expected_inode;
    int fd = open_directory_path(policy->config.private_work_root, 1);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & 07777U) != 0710U || !parse_u64_decimal(policy->private_root_device, &expected_device) ||
        !parse_u64_decimal(policy->private_root_inode, &expected_inode) || (uint64_t)metadata.st_dev != expected_device ||
        (uint64_t)metadata.st_ino != expected_inode || !private_root_acl_valid(fd, policy->host_uid) || !statx_mount_id(fd, mount_id)) {
        close(fd);
        return 0;
    }
    *root_fd = fd;
    return 1;
}

static int protected_policy_load(deployed_policy *policy, broker_status *failure)
{
    struct stat metadata;
    unsigned char bytes[POLICY_MAX_BYTES + 1U];
    size_t length = 0U;
    int fd = open_regular_file_path(POLICY_PATH, 0, &metadata);
    if (fd < 0 || !metadata_file_valid(&metadata, 0600U) || metadata.st_size < 0 || (uint64_t)metadata.st_size > POLICY_MAX_BYTES) {
        if (fd >= 0) close(fd);
        *failure = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
        return 0;
    }
    while (length < sizeof(bytes)) {
        ssize_t count = read(fd, bytes + length, sizeof(bytes) - length);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); *failure = STATUS_ROOT_OR_DEPLOYMENT_INVALID; return 0; }
        if (count == 0) break;
        length += (size_t)count;
    }
    close(fd);
    if (length != (size_t)metadata.st_size || length > POLICY_MAX_BYTES) { *failure = STATUS_ROOT_OR_DEPLOYMENT_INVALID; return 0; }
    if (!parse_policy_bytes(bytes, length, policy)) { *failure = STATUS_CALLER_OR_POLICY_INVALID; return 0; }
    *failure = STATUS_SUCCESS;
    return 1;
}

static int deployment_identity_valid(const deployed_policy *policy)
{
    const char *writer = policy->config.writer_script;
    char exporter[1025];
    char manifest[1025];
    int count;
    int root_fd;
    uint64_t mount_id;
    size_t index;
    if (!private_root_open_and_validate(policy, &root_fd, &mount_id)) return 0;
    (void)mount_id;
    close(root_fd);
    if (!hash_file_matches(LAUNCHER_PATH, policy->launcher_sha256, 0755U, NULL) ||
        !hash_file_matches(BROKER_PATH, policy->broker_sha256, 0755U, NULL) ||
        !hash_file_matches(BWRAP_PATH, policy->bubblewrap_sha256, 0755U, NULL) ||
        !hash_file_matches(RUNNER_PATH, policy->runner_sha256, 0755U, NULL) ||
        !hash_file_matches(VALIDATOR_PATH, policy->validator_sha256, 0755U, NULL) ||
        !hash_file_matches(policy->config.blender_executable, policy->config.blender_executable_sha256, 0755U, NULL) ||
        !hash_file_matches(writer, policy->writer_sha256, 0644U, NULL)) return 0;
    count = snprintf(exporter, sizeof(exporter), "%s/export_fbx_bin.py", "/opt/swooshz");
    if (count < 0 || (size_t)count >= sizeof(exporter)) return 0;
    count = snprintf(manifest, sizeof(manifest), "%s/patch-manifest.json", "/opt/swooshz");
    if (count < 0 || (size_t)count >= sizeof(manifest)) return 0;
    if (!hash_file_matches(exporter, policy->private_exporter_sha256, 0644U, NULL) ||
        !hash_file_matches(manifest, policy->patch_manifest_sha256, 0644U, NULL)) return 0;
    for (index = 0U; index < ARRAY_LENGTH(system_runtime_paths); index++) if (!runtime_bind_file_valid(system_runtime_paths[index])) return 0;
    return 1;
}

typedef struct {
    int bound;
    char boot_id[37];
    uint32_t pid;
    char starttime[21];
    char namespace_device[21];
    char namespace_inode[21];
} journal_process_identity;

typedef struct {
    char allocation_id[33];
    char operation[10];
    char policy_identity[65];
    char config_identity[65];
    char root_device[21];
    char root_inode[21];
    char root_boot_id[37];
    char root_mount_identity[21];
    char basename[36];
    char leaf_state[12];
    int leaf_bound;
    char leaf_device[21];
    char leaf_inode[21];
    uint32_t leaf_owner_uid;
    uint32_t leaf_owner_gid;
    uint32_t leaf_mode;
    int seed_bound;
    char seed_name[32];
    char seed_device[21];
    char seed_inode[21];
    uint64_t seed_size;
    char seed_sha256[65];
    char launch_state[32];
    journal_process_identity monitor;
    journal_process_identity init;
    char cleanup_state[12];
    uint32_t cleanup_attempt_count;
    char state[32];
    uint64_t transition_sequence;
    int has_failure;
    char failure_class[24];
    char failure_phase[24];
    char failure_code[64];
    char record_sha256[65];
} journal_record;

static int append_null(byte_builder *builder)
{
    return append_text(builder, "null");
}

static int append_json_u32(byte_builder *builder, uint32_t value)
{
    char number[16];
    int length = snprintf(number, sizeof(number), "%" PRIu32, value);
    return length > 0 && (size_t)length < sizeof(number) && append_bytes(builder, number, (size_t)length);
}

static int append_json_u64(byte_builder *builder, uint64_t value)
{
    char number[21];
    int length = snprintf(number, sizeof(number), "%" PRIu64, value);
    return length > 0 && (size_t)length < sizeof(number) && append_bytes(builder, number, (size_t)length);
}

static int parse_json_u64(json_cursor *cursor, uint64_t maximum, uint64_t *output)
{
    uint64_t value = 0U;
    const unsigned char *start = cursor->cursor;
    if (cursor->cursor == cursor->end || *cursor->cursor < '0' || *cursor->cursor > '9') return 0;
    if (*cursor->cursor == '0' && cursor->cursor + 1 < cursor->end && cursor->cursor[1] >= '0' && cursor->cursor[1] <= '9') return 0;
    while (cursor->cursor < cursor->end && *cursor->cursor >= '0' && *cursor->cursor <= '9') {
        uint64_t digit = (uint64_t)(*cursor->cursor - '0');
        if (value > (maximum - digit) / 10U) return 0;
        value = value * 10U + digit;
        cursor->cursor++;
    }
    if (cursor->cursor == start) return 0;
    *output = value;
    return 1;
}

static int parse_nullable_decimal_string(json_cursor *cursor, char *output, size_t capacity, int *bound)
{
    if (expect_json_text(cursor, "null")) {
        *bound = 0;
        output[0] = '\0';
        return 1;
    }
    if (!parse_decimal_string(cursor, output, capacity)) return 0;
    *bound = 1;
    return 1;
}

static int parse_nullable_u32(json_cursor *cursor, uint32_t maximum, uint32_t *output, int *bound)
{
    if (expect_json_text(cursor, "null")) {
        *bound = 0;
        *output = 0U;
        return 1;
    }
    if (!parse_json_u32(cursor, maximum, 1, output)) return 0;
    *bound = 1;
    return 1;
}

static int valid_lower_digest(const char *value)
{
    size_t index;
    if (strlen(value) != 64U) return 0;
    for (index = 0U; index < 64U; index++) if (lower_hex_nibble((unsigned char)value[index]) < 0) return 0;
    return 1;
}

static int valid_allocation_id(const char *value)
{
    size_t index;
    if (strlen(value) != 32U) return 0;
    for (index = 0U; index < 32U; index++) if (lower_hex_nibble((unsigned char)value[index]) < 0) return 0;
    return 1;
}

static int valid_boot_id(const char *value)
{
    static const size_t hyphens[] = { 8U, 13U, 18U, 23U };
    size_t index, hyphen_index = 0U;
    if (strlen(value) != 36U) return 0;
    for (index = 0U; index < 36U; index++) {
        if (hyphen_index < ARRAY_LENGTH(hyphens) && index == hyphens[hyphen_index]) {
            if (value[index] != '-') return 0;
            hyphen_index++;
        } else if (lower_hex_nibble((unsigned char)value[index]) < 0) return 0;
    }
    return 1;
}

static int journal_state_rank(const char *state)
{
    static const char *const states[] = {
        "PRE_JOURNALED", "ALLOCATED_BOUND", "HOST_ACCESS_ADMITTED", "INPUT_CREATED_PRE",
        "INPUT_POST_ADMITTED", "LAUNCH_INTENT", "PIDNS_INIT_REGISTERED", "RELEASE_INTENT",
        "RUNNING", "TARGET_TERMINATED", "OUTPUT_READY", "CLEANING", "ABSENT"
    };
    size_t index;
    for (index = 0U; index < ARRAY_LENGTH(states); index++) if (strcmp(state, states[index]) == 0) return (int)index;
    return -1;
}

static int journal_failure_value(const char *class_value, const char *phase_value, const char *code_value)
{
    static const char *const classes[] = { "ADMISSION", "LAUNCH", "OUTPUT", "CLEANUP", "RECOVERY" };
    static const char *const phases[] = { "PRE_LAUNCH", "PRE_EXEC", "RUNNING", "POST_RUN", "CLEANUP", "RECOVERY" };
    static const char *const codes[] = {
        "CALLER_INVALID", "POLICY_INVALID", "DEPLOYMENT_INVALID", "INPUT_INVALID", "LAUNCH_IDENTITY_UNKNOWN",
        "PIDNS_INIT_IDENTITY_UNKNOWN", "PROCESS_TREE_NOT_QUIESCENT", "CLEANUP_BOUND_EXCEEDED",
        "CLEANUP_IDENTITY_CHANGED", "CLEANUP_IO_FAILED", "RECOVERY_JOURNAL_INVALID", "RECOVERY_IDENTITY_UNKNOWN"
    };
    size_t index;
    int class_found = 0, phase_found = 0, code_found = 0;
    for (index = 0U; index < ARRAY_LENGTH(classes); index++) if (strcmp(class_value, classes[index]) == 0) class_found = 1;
    for (index = 0U; index < ARRAY_LENGTH(phases); index++) if (strcmp(phase_value, phases[index]) == 0) phase_found = 1;
    for (index = 0U; index < ARRAY_LENGTH(codes); index++) if (strcmp(code_value, codes[index]) == 0) code_found = 1;
    return class_found && phase_found && code_found;
}

static int append_process_identity(byte_builder *builder, const journal_process_identity *identity, int is_init)
{
    if (!identity->bound) return append_null(builder);
    if (!append_text(builder, "{\"bootId\":") || !append_json_string(builder, identity->boot_id) ||
        !append_text(builder, ",\"pid\":") || !append_json_u32(builder, identity->pid) ||
        !append_text(builder, ",\"starttime\":") || !append_json_string(builder, identity->starttime)) return 0;
    if (is_init && (!append_text(builder, ",\"namespaceDevice\":") || !append_json_string(builder, identity->namespace_device) ||
        !append_text(builder, ",\"namespaceInode\":") || !append_json_string(builder, identity->namespace_inode))) return 0;
    return append_text(builder, "}");
}

static int serialize_journal(const journal_record *record, int include_record_digest, byte_builder *builder)
{
    memset(builder, 0, sizeof(*builder));
    if (!append_text(builder, "{\"schemaVersion\":\"s8-sandbox-broker-journal-v1\",\"protocolVersion\":\"s8-sandbox-broker-v1\",\"allocationId\":") ||
        !append_json_string(builder, record->allocation_id) || !append_text(builder, ",\"operation\":") ||
        !append_json_string(builder, record->operation) || !append_text(builder, ",\"policyIdentity\":") ||
        !append_json_string(builder, record->policy_identity) || !append_text(builder, ",\"configIdentity\":") ||
        !append_json_string(builder, record->config_identity) || !append_text(builder, ",\"root\":{\"device\":") ||
        !append_json_string(builder, record->root_device) || !append_text(builder, ",\"inode\":") ||
        !append_json_string(builder, record->root_inode) || !append_text(builder, ",\"bootId\":") ||
        !append_json_string(builder, record->root_boot_id) || !append_text(builder, ",\"mountIdentity\":") ||
        !append_json_string(builder, record->root_mount_identity) || !append_text(builder, "},\"basename\":") ||
        !append_json_string(builder, record->basename) || !append_text(builder, ",\"leaf\":{\"state\":") ||
        !append_json_string(builder, record->leaf_state) || !append_text(builder, ",\"device\":")) return 0;
    if (record->leaf_bound) {
        if (!append_json_string(builder, record->leaf_device)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"inode\":")) return 0;
    if (record->leaf_bound) {
        if (!append_json_string(builder, record->leaf_inode)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"ownerUid\":")) return 0;
    if (record->leaf_bound) {
        if (!append_json_u32(builder, record->leaf_owner_uid)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"ownerGid\":")) return 0;
    if (record->leaf_bound) {
        if (!append_json_u32(builder, record->leaf_owner_gid)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"mode\":")) return 0;
    if (record->leaf_bound) {
        if (!append_json_u32(builder, record->leaf_mode)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, "},\"seed\":{\"name\":") || !append_json_string(builder, record->seed_name) ||
        !append_text(builder, ",\"device\":")) return 0;
    if (record->seed_bound) {
        if (!append_json_string(builder, record->seed_device)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"inode\":")) return 0;
    if (record->seed_bound) {
        if (!append_json_string(builder, record->seed_inode)) return 0;
    } else if (!append_null(builder)) return 0;
    if (!append_text(builder, ",\"size\":") || !append_json_u64(builder, record->seed_size) ||
        !append_text(builder, ",\"sha256\":") || !append_json_string(builder, record->seed_sha256) ||
        !append_text(builder, "},\"launch\":{\"state\":") || !append_json_string(builder, record->launch_state) ||
        !append_text(builder, ",\"monitor\":") || !append_process_identity(builder, &record->monitor, 0) ||
        !append_text(builder, ",\"init\":") || !append_process_identity(builder, &record->init, 1) ||
        !append_text(builder, "},\"cleanup\":{\"state\":") || !append_json_string(builder, record->cleanup_state) ||
        !append_text(builder, ",\"attemptCount\":") || !append_json_u32(builder, record->cleanup_attempt_count) ||
        !append_text(builder, "},\"state\":") || !append_json_string(builder, record->state) ||
        !append_text(builder, ",\"transitionSequence\":") || !append_json_u64(builder, record->transition_sequence) ||
        !append_text(builder, ",\"lastFailure\":")) return 0;
    if (record->has_failure) {
        if (!append_text(builder, "{\"class\":") || !append_json_string(builder, record->failure_class) ||
            !append_text(builder, ",\"phase\":") || !append_json_string(builder, record->failure_phase) ||
            !append_text(builder, ",\"code\":") || !append_json_string(builder, record->failure_code) ||
            !append_text(builder, "}")) return 0;
    } else if (!append_null(builder)) return 0;
    if (include_record_digest && (!append_text(builder, ",\"recordSha256\":") || !append_json_string(builder, record->record_sha256))) return 0;
    if (!append_text(builder, "}") || !append_text(builder, "\n")) return 0;
    return !builder->failed && builder->length <= MAX_JOURNAL_BYTES;
}

static int journal_checksum(journal_record *record)
{
    byte_builder preimage = {{0U}, 0U, 0};
    unsigned char digest[32];
    if (!serialize_journal(record, 0, &preimage)) return 0;
    sha256_bytes(preimage.bytes, preimage.length, digest);
    hex_encode(digest, sizeof(digest), record->record_sha256);
    return 1;
}

static int parse_journal_process(json_cursor *cursor, journal_process_identity *identity, int is_init)
{
    int bound;
    memset(identity, 0, sizeof(*identity));
    if (expect_json_text(cursor, "null")) return 1;
    if (!expect_json_text(cursor, "{\"bootId\":") ||
        !parse_json_string(cursor, identity->boot_id, sizeof(identity->boot_id)) ||
        !expect_json_text(cursor, ",\"pid\":") ||
        !parse_json_u32(cursor, UINT32_MAX, 0, &identity->pid) ||
        !expect_json_text(cursor, ",\"starttime\":") ||
        !parse_decimal_string(cursor, identity->starttime, sizeof(identity->starttime))) return 0;
    if (is_init && (!expect_json_text(cursor, ",\"namespaceDevice\":") ||
        !parse_decimal_string(cursor, identity->namespace_device, sizeof(identity->namespace_device)) ||
        !expect_json_text(cursor, ",\"namespaceInode\":") ||
        !parse_decimal_string(cursor, identity->namespace_inode, sizeof(identity->namespace_inode)))) return 0;
    if (!expect_json_text(cursor, "}")) return 0;
    bound = valid_boot_id(identity->boot_id);
    identity->bound = bound;
    return bound;
}

static int parse_journal_bytes(const unsigned char *bytes, size_t length, journal_record *record)
{
    json_cursor cursor = { bytes, bytes + length };
    byte_builder canonical = {{0U}, 0U, 0};
    byte_builder preimage = {{0U}, 0U, 0};
    unsigned char digest[32];
    int bound;
    uint64_t sequence;
    memset(record, 0, sizeof(*record));
    if (length == 0U || length > MAX_JOURNAL_BYTES || bytes[length - 1U] != '\n' ||
        (length >= 3U && bytes[0] == 0xefU && bytes[1] == 0xbbU && bytes[2] == 0xbfU)) return 0;
    if (!expect_json_text(&cursor, "{\"schemaVersion\":\"s8-sandbox-broker-journal-v1\",\"protocolVersion\":\"s8-sandbox-broker-v1\",\"allocationId\":") ||
        !parse_json_string(&cursor, record->allocation_id, sizeof(record->allocation_id)) ||
        !expect_json_text(&cursor, ",\"operation\":") || !parse_json_string(&cursor, record->operation, sizeof(record->operation)) ||
        !expect_json_text(&cursor, ",\"policyIdentity\":") || !parse_digest_string(&cursor, record->policy_identity) ||
        !expect_json_text(&cursor, ",\"configIdentity\":") || !parse_digest_string(&cursor, record->config_identity) ||
        !expect_json_text(&cursor, ",\"root\":{\"device\":") || !parse_decimal_string(&cursor, record->root_device, sizeof(record->root_device)) ||
        !expect_json_text(&cursor, ",\"inode\":") || !parse_decimal_string(&cursor, record->root_inode, sizeof(record->root_inode)) ||
        !expect_json_text(&cursor, ",\"bootId\":") || !parse_json_string(&cursor, record->root_boot_id, sizeof(record->root_boot_id)) ||
        !expect_json_text(&cursor, ",\"mountIdentity\":") || !parse_decimal_string(&cursor, record->root_mount_identity, sizeof(record->root_mount_identity)) ||
        !expect_json_text(&cursor, "},\"basename\":") || !parse_json_string(&cursor, record->basename, sizeof(record->basename)) ||
        !expect_json_text(&cursor, ",\"leaf\":{\"state\":") || !parse_json_string(&cursor, record->leaf_state, sizeof(record->leaf_state)) ||
        !expect_json_text(&cursor, ",\"device\":") || !parse_nullable_decimal_string(&cursor, record->leaf_device, sizeof(record->leaf_device), &bound)) return 0;
    record->leaf_bound = bound;
    if (!expect_json_text(&cursor, ",\"inode\":") || !parse_nullable_decimal_string(&cursor, record->leaf_inode, sizeof(record->leaf_inode), &bound) || bound != record->leaf_bound) return 0;
    if (!expect_json_text(&cursor, ",\"ownerUid\":") || !parse_nullable_u32(&cursor, UINT32_MAX, &record->leaf_owner_uid, &bound) || bound != record->leaf_bound) return 0;
    if (!expect_json_text(&cursor, ",\"ownerGid\":") || !parse_nullable_u32(&cursor, UINT32_MAX, &record->leaf_owner_gid, &bound) || bound != record->leaf_bound) return 0;
    if (!expect_json_text(&cursor, ",\"mode\":") || !parse_nullable_u32(&cursor, 07777U, &record->leaf_mode, &bound) || bound != record->leaf_bound ||
        !expect_json_text(&cursor, "},\"seed\":{\"name\":") || !parse_json_string(&cursor, record->seed_name, sizeof(record->seed_name)) ||
        !expect_json_text(&cursor, ",\"device\":") || !parse_nullable_decimal_string(&cursor, record->seed_device, sizeof(record->seed_device), &bound)) return 0;
    record->seed_bound = bound;
    if (!expect_json_text(&cursor, ",\"inode\":") || !parse_nullable_decimal_string(&cursor, record->seed_inode, sizeof(record->seed_inode), &bound) || bound != record->seed_bound ||
        !expect_json_text(&cursor, ",\"size\":") || !parse_json_u64(&cursor, MAX_REQUEST_BYTES, &record->seed_size) ||
        !expect_json_text(&cursor, ",\"sha256\":") || !parse_digest_string(&cursor, record->seed_sha256) ||
        !expect_json_text(&cursor, "},\"launch\":{\"state\":") || !parse_json_string(&cursor, record->launch_state, sizeof(record->launch_state)) ||
        !expect_json_text(&cursor, ",\"monitor\":") || !parse_journal_process(&cursor, &record->monitor, 0) ||
        !expect_json_text(&cursor, ",\"init\":") || !parse_journal_process(&cursor, &record->init, 1) ||
        !expect_json_text(&cursor, "},\"cleanup\":{\"state\":") || !parse_json_string(&cursor, record->cleanup_state, sizeof(record->cleanup_state)) ||
        !expect_json_text(&cursor, ",\"attemptCount\":") || !parse_json_u32(&cursor, MAX_RECOVERY_ATTEMPTS, 1, &record->cleanup_attempt_count) ||
        !expect_json_text(&cursor, "},\"state\":") || !parse_json_string(&cursor, record->state, sizeof(record->state)) ||
        !expect_json_text(&cursor, ",\"transitionSequence\":") || !parse_json_u64(&cursor, UINT64_C(9007199254740991), &sequence)) return 0;
    record->transition_sequence = sequence;
    if (!expect_json_text(&cursor, ",\"lastFailure\":")) return 0;
    if (expect_json_text(&cursor, "null")) {
        record->has_failure = 0;
    } else {
        if (!expect_json_text(&cursor, "{\"class\":") || !parse_json_string(&cursor, record->failure_class, sizeof(record->failure_class)) ||
            !expect_json_text(&cursor, ",\"phase\":") || !parse_json_string(&cursor, record->failure_phase, sizeof(record->failure_phase)) ||
            !expect_json_text(&cursor, ",\"code\":") || !parse_json_string(&cursor, record->failure_code, sizeof(record->failure_code)) ||
            !expect_json_text(&cursor, "}") || !journal_failure_value(record->failure_class, record->failure_phase, record->failure_code)) return 0;
        record->has_failure = 1;
    }
    if (!expect_json_text(&cursor, ",\"recordSha256\":") || !parse_digest_string(&cursor, record->record_sha256) ||
        !expect_json_text(&cursor, "}\n") || cursor.cursor != cursor.end) return 0;
    if (!valid_allocation_id(record->allocation_id) ||
        (strcmp(record->operation, "WRITER") != 0 && strcmp(record->operation, "VALIDATOR") != 0) ||
        !valid_boot_id(record->root_boot_id) || !valid_lower_digest(record->policy_identity) || !valid_lower_digest(record->config_identity)) return 0;
    if (strcmp(record->basename, ALLOCATION_PREFIX) != 0) {
        char expected[36];
        int count = snprintf(expected, sizeof(expected), "%s%s", ALLOCATION_PREFIX, record->allocation_id);
        if (count < 0 || (size_t)count >= sizeof(expected) || strcmp(record->basename, expected) != 0) return 0;
    } else return 0;
    if (strcmp(record->seed_name, record->operation[0] == 'W' ? "input.json" : "artifact.fbx") != 0 ||
        !valid_lower_digest(record->seed_sha256) || record->transition_sequence > UINT64_C(9007199254740991)) return 0;
    if (journal_state_rank(record->state) < 0 ||
        (strcmp(record->leaf_state, "UNBOUND") != 0 && strcmp(record->leaf_state, "STAGING") != 0 &&
         strcmp(record->leaf_state, "BOUND") != 0 && strcmp(record->leaf_state, "ABSENT") != 0)) return 0;
    if (((strcmp(record->leaf_state, "BOUND") == 0 || strcmp(record->leaf_state, "STAGING") == 0) != record->leaf_bound) ||
        ((strcmp(record->leaf_state, "UNBOUND") == 0 || strcmp(record->leaf_state, "ABSENT") == 0) && record->leaf_bound)) return 0;
    if (record->seed_bound && (record->seed_device[0] == '\0' || record->seed_inode[0] == '\0')) return 0;
    if (record->monitor.bound && !valid_boot_id(record->monitor.boot_id)) return 0;
    if (record->init.bound && !valid_boot_id(record->init.boot_id)) return 0;
    if (!serialize_journal(record, 1, &canonical) || canonical.length != length || memcmp(canonical.bytes, bytes, length) != 0) return 0;
    if (!serialize_journal(record, 0, &preimage)) return 0;
    sha256_bytes(preimage.bytes, preimage.length, digest);
    {
        char actual[65];
        hex_encode(digest, sizeof(digest), actual);
        if (strcmp(actual, record->record_sha256) != 0) return 0;
    }
    return 1;
}

#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif

typedef struct {
    unsigned char *bytes;
    size_t length;
    size_t capacity;
    size_t limit;
    int overflow;
} capture_buffer;

static int write_all_fd(int fd, const unsigned char *bytes, size_t length)
{
    size_t offset = 0U;
    while (offset < length) {
        ssize_t count = write(fd, bytes + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

static int read_file_at_bounded(int directory_fd, const char *name, unsigned char *bytes, size_t capacity, size_t *length, struct stat *metadata)
{
    int fd = openat(directory_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    size_t used = 0U;
    if (fd < 0) return 0;
    if (fstat(fd, metadata) != 0 || !S_ISREG(metadata->st_mode) || metadata->st_size < 0 || (uint64_t)metadata->st_size > capacity) {
        close(fd);
        return 0;
    }
    while (used < capacity) {
        ssize_t count = read(fd, bytes + used, capacity - used);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return 0; }
        if (count == 0) break;
        used += (size_t)count;
    }
    if (used != (size_t)metadata->st_size) { close(fd); return 0; }
    {
        unsigned char extra;
        ssize_t count;
        do { count = read(fd, &extra, 1U); } while (count < 0 && errno == EINTR);
        if (count != 0) { close(fd); return 0; }
    }
    close(fd);
    *length = used;
    return 1;
}

static int current_boot_id(char output[37])
{
    unsigned char bytes[64];
    size_t length = 0U;
    struct stat metadata;
    int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode)) { close(fd); return 0; }
    while (length < sizeof(bytes)) {
        ssize_t count = read(fd, bytes + length, sizeof(bytes) - length);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return 0; }
        if (count == 0) break;
        length += (size_t)count;
    }
    close(fd);
    if (length == 37U && bytes[36] == '\n') length--;
    if (length != 36U || memchr(bytes, '\n', length) != NULL) return 0;
    memcpy(output, bytes, length);
    output[length] = '\0';
    return valid_boot_id(output);
}

static int proc_starttime(pid_t pid, char output[21])
{
    char path[64];
    char bytes[4096];
    char *cursor, *right_paren;
    size_t used = 0U;
    unsigned int field;
    int fd, printed = snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    if (printed < 0 || (size_t)printed >= sizeof(path)) return 0;
    fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    while (used + 1U < sizeof(bytes)) {
        ssize_t count = read(fd, bytes + used, sizeof(bytes) - used - 1U);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return 0; }
        if (count == 0) break;
        used += (size_t)count;
    }
    close(fd);
    bytes[used] = '\0';
    right_paren = strrchr(bytes, ')');
    if (!right_paren) return 0;
    cursor = right_paren + 1;
    for (field = 3U; field <= 22U; field++) {
        char *start;
        size_t length;
        while (*cursor == ' ' || *cursor == '\t') cursor++;
        if (*cursor == '\0' || *cursor == '\n') return 0;
        start = cursor;
        while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t' && *cursor != '\n') cursor++;
        length = (size_t)(cursor - start);
        if (field == 22U) {
            if (length == 0U || length >= 21U) return 0;
            memcpy(output, start, length);
            output[length] = '\0';
            return parse_u64_decimal(output, &(uint64_t){0U});
        }
    }
    return 0;
}

static int process_namespace_identity(pid_t pid, journal_process_identity *identity, int require_pid_one)
{
    char path[96];
    char starttime[21];
    char boot_id[37];
    char proc_status[8192];
    struct stat metadata;
    size_t used = 0U;
    int fd, printed;
    uint64_t number;
    memset(identity, 0, sizeof(*identity));
    if (pid <= 0 || !current_boot_id(boot_id) || !proc_starttime(pid, starttime)) return 0;
    printed = snprintf(path, sizeof(path), "/proc/%ld/ns/pid", (long)pid);
    if (printed < 0 || (size_t)printed >= sizeof(path) || stat(path, &metadata) != 0) return 0;
    (void)snprintf(identity->namespace_device, sizeof(identity->namespace_device), "%" PRIu64, (uint64_t)metadata.st_dev);
    (void)snprintf(identity->namespace_inode, sizeof(identity->namespace_inode), "%" PRIu64, (uint64_t)metadata.st_ino);
    printed = snprintf(path, sizeof(path), "/proc/%ld/status", (long)pid);
    if (printed < 0 || (size_t)printed >= sizeof(path)) return 0;
    fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    while (used + 1U < sizeof(proc_status)) {
        ssize_t count = read(fd, proc_status + used, sizeof(proc_status) - used - 1U);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return 0; }
        if (count == 0) break;
        used += (size_t)count;
    }
    close(fd);
    proc_status[used] = '\0';
    if (require_pid_one) {
        char *line = proc_status;
        int found = 0;
        while (*line != '\0') {
            char *next = strchr(line, '\n');
            size_t line_length = next ? (size_t)(next - line) : strlen(line);
            if (line_length >= 6U && memcmp(line, "NSpid:", 6U) == 0) {
                char *value = line + 6U;
                char *end = line + line_length;
                unsigned int count = 0U;
                uint64_t last = 0U;
                while (value < end) {
                    char token[21];
                    size_t length;
                    while (value < end && (*value == ' ' || *value == '\t')) value++;
                    if (value == end) break;
                    {
                        char *begin = value;
                        while (value < end && *value >= '0' && *value <= '9') value++;
                        length = (size_t)(value - begin);
                        if (length == 0U || length >= sizeof(token)) return 0;
                        memcpy(token, begin, length);
                        token[length] = '\0';
                        if (!parse_u64_decimal(token, &last)) return 0;
                    }
                    count++;
                }
                found = count >= 2U && last == 1U;
                break;
            }
            if (!next) break;
            line = next + 1;
        }
        if (!found) return 0;
    }
    if (!parse_u64_decimal(starttime, &number) || number == 0U) return 0;
    memcpy(identity->boot_id, boot_id, sizeof(identity->boot_id));
    memcpy(identity->starttime, starttime, strlen(starttime) + 1U);
    identity->pid = (uint32_t)pid;
    identity->bound = 1;
    return 1;
}

static int process_identity_matches(const journal_process_identity *expected, int require_pid_one)
{
    journal_process_identity current;
    if (!expected->bound || expected->pid == 0U || !process_namespace_identity((pid_t)expected->pid, &current, require_pid_one)) return 0;
    if (strcmp(expected->boot_id, current.boot_id) != 0 || strcmp(expected->starttime, current.starttime) != 0) return 0;
    if (expected->namespace_inode[0] != '\0' && strcmp(expected->namespace_inode, current.namespace_inode) != 0) return 0;
    if (expected->namespace_device[0] != '\0' && strcmp(expected->namespace_device, current.namespace_device) != 0) return 0;
    return 1;
}

static int open_pidfd_checked(const journal_process_identity *identity, int require_pid_one)
{
    int fd;
    if (!process_identity_matches(identity, require_pid_one)) { errno = ESRCH; return -1; }
    fd = (int)syscall(SYS_pidfd_open, (pid_t)identity->pid, 0U);
    if (fd < 0) return -1;
    if (!process_identity_matches(identity, require_pid_one)) { close(fd); errno = ESTALE; return -1; }
    return fd;
}

static int pidfd_signal_checked(int fd, int signal_number)
{
    return syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0U) == 0;
}

static int pidfd_exited_until(int fd, uint64_t deadline)
{
    struct pollfd descriptor = { fd, POLLIN, 0 };
    for (;;) {
        uint64_t now = monotonic_milliseconds();
        int timeout, result;
        if (now == 0U || now >= deadline) return 0;
        timeout = (int)((deadline - now) > (uint64_t)INT_MAX ? INT_MAX : deadline - now);
        result = poll(&descriptor, 1U, timeout);
        if (result > 0) return (descriptor.revents & (POLLIN | POLLHUP | POLLERR)) != 0;
        if (result == 0) return 0;
        if (errno != EINTR) return 0;
    }
}

static int random_allocation_id(char output[33])
{
    unsigned char bytes[16];
    size_t offset = 0U;
    while (offset < sizeof(bytes)) {
        ssize_t count = getrandom(bytes + offset, sizeof(bytes) - offset, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    hex_encode(bytes, sizeof(bytes), output);
    return 1;
}

static int journal_directory_open(int root_fd, int create, int *journal_fd)
{
    struct stat metadata;
    acl_entry_value access_entries[16];
    size_t access_count = 0U;
    int fd;
    if (create && mkdirat(root_fd, JOURNAL_DIR, 0700) != 0 && errno != EEXIST) return 0;
    fd = openat(root_fd, JOURNAL_DIR, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 || fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & 07777U) != 0700U || (metadata.st_mode & (S_ISUID | S_ISGID | S_ISVTX)) != 0U ||
        read_acl(fd, "system.posix_acl_access", access_entries, ARRAY_LENGTH(access_entries), &access_count) != 0 || !acl_default_is_absent(fd)) {
        if (fd >= 0) close(fd);
        return 0;
    }
    *journal_fd = fd;
    return 1;
}

static int journal_lock_open(int journal_fd, int *lock_fd)
{
    struct stat metadata;
    int fd = openat(journal_fd, JOURNAL_LOCK, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & 07777U) != 0600U || metadata.st_nlink != 1U || flock(fd, LOCK_EX | LOCK_NB) != 0) {
        close(fd);
        return 0;
    }
    *lock_fd = fd;
    return 1;
}

static int journal_record_write(int journal_fd, journal_record *record)
{
    char filename[40];
    byte_builder bytes = {{0U}, 0U, 0};
    struct stat metadata;
    int fd, printed;
    if (!journal_checksum(record) || !serialize_journal(record, 1, &bytes)) return 0;
    if (fstatat(journal_fd, ".next", &metadata, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!S_ISREG(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
            (metadata.st_mode & 07777U) != 0600U || metadata.st_nlink != 1U) return 0;
        if (unlinkat(journal_fd, ".next", 0) != 0) return 0;
    } else if (errno != ENOENT) return 0;
    fd = openat(journal_fd, ".next", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) return 0;
    if (fchown(fd, 0, 0) != 0 || fchmod(fd, 0600) != 0 || !write_all_fd(fd, bytes.bytes, bytes.length) || fsync(fd) != 0) {
        close(fd);
        return 0;
    }
    if (close(fd) != 0) return 0;
    printed = snprintf(filename, sizeof(filename), "%s.json", record->allocation_id);
    if (printed < 0 || (size_t)printed >= sizeof(filename)) return 0;
    if (fstatat(journal_fd, filename, &metadata, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!S_ISREG(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
            (metadata.st_mode & 07777U) != 0600U || metadata.st_nlink != 1U) return 0;
    } else if (errno != ENOENT) return 0;
    if (renameat(journal_fd, ".next", journal_fd, filename) != 0 || fsync(journal_fd) != 0) return 0;
    return 1;
}

static int journal_record_read(int journal_fd, const char *filename, journal_record *record)
{
    unsigned char bytes[MAX_JOURNAL_BYTES];
    size_t length = 0U;
    struct stat metadata;
    if (!read_file_at_bounded(journal_fd, filename, bytes, sizeof(bytes), &length, &metadata) ||
        metadata.st_uid != 0U || metadata.st_gid != 0U || (metadata.st_mode & 07777U) != 0600U || metadata.st_nlink != 1U) return 0;
    return parse_journal_bytes(bytes, length, record);
}

static void journal_set_state(journal_record *record, const char *state)
{
    (void)snprintf(record->state, sizeof(record->state), "%s", state);
    if (record->transition_sequence < UINT64_C(9007199254740991)) record->transition_sequence++;
}

static void journal_set_failure(journal_record *record, const char *class_value, const char *phase_value, const char *code_value)
{
    record->has_failure = 1;
    (void)snprintf(record->failure_class, sizeof(record->failure_class), "%s", class_value);
    (void)snprintf(record->failure_phase, sizeof(record->failure_phase), "%s", phase_value);
    (void)snprintf(record->failure_code, sizeof(record->failure_code), "%s", code_value);
    if (!journal_failure_value(record->failure_class, record->failure_phase, record->failure_code)) record->has_failure = 0;
}

static int journal_root_binding_valid(const journal_record *record, const deployed_policy *policy, int root_fd, uint64_t mount_id, const char boot_id[37])
{
    struct stat metadata;
    char device[21], inode[21], mount[21];
    if (fstat(root_fd, &metadata) != 0) return 0;
    (void)snprintf(device, sizeof(device), "%" PRIu64, (uint64_t)metadata.st_dev);
    (void)snprintf(inode, sizeof(inode), "%" PRIu64, (uint64_t)metadata.st_ino);
    (void)snprintf(mount, sizeof(mount), "%" PRIu64, mount_id);
    return strcmp(record->policy_identity, policy->policy_sha256) == 0 && strcmp(record->config_identity, policy->config_sha256) == 0 &&
        strcmp(record->root_device, device) == 0 && strcmp(record->root_inode, inode) == 0 &&
        strcmp(record->root_mount_identity, mount) == 0 && strcmp(record->root_boot_id, boot_id) == 0;
}

static int journal_leaf_open(int root_fd, const journal_record *record, int *leaf_fd)
{
    struct stat metadata;
    uint64_t device, inode;
    int fd;
    if (!record->leaf_bound || !parse_u64_decimal(record->leaf_device, &device) || !parse_u64_decimal(record->leaf_inode, &inode)) return 0;
    fd = openat(root_fd, record->basename, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || (uint64_t)metadata.st_dev != device || (uint64_t)metadata.st_ino != inode ||
        metadata.st_uid != record->leaf_owner_uid || metadata.st_gid != record->leaf_owner_gid || (uint32_t)(metadata.st_mode & 07777U) != record->leaf_mode) {
        close(fd);
        return 0;
    }
    *leaf_fd = fd;
    return 1;
}

static int journal_transition_write(int journal_fd, journal_record *record, const char *state)
{
    journal_set_state(record, state);
    return journal_record_write(journal_fd, record);
}

typedef struct {
    uint64_t root_device;
    uint64_t root_mount;
    uint64_t deadline;
    size_t entries;
    size_t open_fds;
    uint32_t host_uid;
    uint32_t host_gid;
} cleanup_budget;

static int cleanup_path_identity(int fd, cleanup_budget *budget, struct stat *metadata)
{
    uint64_t mount_id;
    return fstat(fd, metadata) == 0 && (uint64_t)metadata->st_dev == budget->root_device &&
        statx_mount_id(fd, &mount_id) && mount_id == budget->root_mount;
}

static int cleanup_directory_contents(int directory_fd, unsigned int depth, cleanup_budget *budget)
{
    int scan_fd;
    DIR *directory;
    struct dirent *entry;
    struct stat parent_metadata;
    if (depth > MAX_CLEANUP_DEPTH || budget->open_fds >= MAX_CLEANUP_FDS || budget->entries > MAX_CLEANUP_ENTRIES ||
        monotonic_milliseconds() >= budget->deadline || !cleanup_path_identity(directory_fd, budget, &parent_metadata) || !S_ISDIR(parent_metadata.st_mode)) return 0;
    scan_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 3);
    if (scan_fd < 0) return 0;
    budget->open_fds++;
    directory = fdopendir(scan_fd);
    if (!directory) { close(scan_fd); budget->open_fds--; return 0; }
    for (;;) {
        struct stat observed, opened_metadata, after_metadata;
        int child_fd;
        errno = 0;
        entry = readdir(directory);
        if (!entry) {
            int read_error = errno;
            closedir(directory);
            budget->open_fds--;
            return read_error == 0 && monotonic_milliseconds() < budget->deadline;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (++budget->entries > MAX_CLEANUP_ENTRIES || monotonic_milliseconds() >= budget->deadline ||
            fstatat(directory_fd, entry->d_name, &observed, AT_SYMLINK_NOFOLLOW) != 0 || observed.st_dev != parent_metadata.st_dev ||
            S_ISLNK(observed.st_mode) || observed.st_nlink == 0U) { closedir(directory); budget->open_fds--; return 0; }
        if (S_ISDIR(observed.st_mode)) {
            if (budget->open_fds + 2U > MAX_CLEANUP_FDS) { closedir(directory); budget->open_fds--; return 0; }
            child_fd = openat(directory_fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (child_fd < 0) { closedir(directory); budget->open_fds--; return 0; }
            budget->open_fds++;
            if (!cleanup_path_identity(child_fd, budget, &opened_metadata) || opened_metadata.st_ino != observed.st_ino ||
                (opened_metadata.st_uid != 0U && opened_metadata.st_uid != budget->host_uid) ||
                (opened_metadata.st_gid != 0U && opened_metadata.st_gid != budget->host_gid) ||
                !cleanup_directory_contents(child_fd, depth + 1U, budget)) {
                close(child_fd); budget->open_fds--; closedir(directory); budget->open_fds--; return 0;
            }
            if (fstatat(directory_fd, entry->d_name, &after_metadata, AT_SYMLINK_NOFOLLOW) != 0 || after_metadata.st_ino != opened_metadata.st_ino ||
                after_metadata.st_dev != opened_metadata.st_dev || unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR) != 0) {
                close(child_fd); budget->open_fds--; closedir(directory); budget->open_fds--; return 0;
            }
            close(child_fd);
            budget->open_fds--;
        } else if (S_ISREG(observed.st_mode)) {
            if (observed.st_nlink != 1U || budget->open_fds + 2U > MAX_CLEANUP_FDS) { closedir(directory); budget->open_fds--; return 0; }
            child_fd = openat(directory_fd, entry->d_name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
            if (child_fd < 0) { closedir(directory); budget->open_fds--; return 0; }
            budget->open_fds++;
            if (!cleanup_path_identity(child_fd, budget, &opened_metadata) || opened_metadata.st_ino != observed.st_ino ||
                opened_metadata.st_nlink != 1U || (opened_metadata.st_uid != 0U && opened_metadata.st_uid != budget->host_uid) ||
                (opened_metadata.st_gid != 0U && opened_metadata.st_gid != budget->host_gid) ||
                fstatat(directory_fd, entry->d_name, &after_metadata, AT_SYMLINK_NOFOLLOW) != 0 || after_metadata.st_ino != opened_metadata.st_ino ||
                after_metadata.st_dev != opened_metadata.st_dev || unlinkat(directory_fd, entry->d_name, 0) != 0) {
                close(child_fd); budget->open_fds--; closedir(directory); budget->open_fds--; return 0;
            }
            close(child_fd);
            budget->open_fds--;
        } else { closedir(directory); budget->open_fds--; return 0; }
    }
}

static int remove_allocation_leaf(int root_fd, uint64_t root_mount, const deployed_policy *policy, journal_record *record)
{
    int leaf_fd;
    struct stat leaf_metadata, path_metadata;
    uint64_t device, mount_id;
    cleanup_budget budget;
    if (fstatat(root_fd, record->basename, &path_metadata, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno != ENOENT) return 0;
        (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "ABSENT");
        record->leaf_bound = 0;
        record->leaf_device[0] = '\0'; record->leaf_inode[0] = '\0';
        record->leaf_owner_uid = 0U; record->leaf_owner_gid = 0U; record->leaf_mode = 0U;
        return 1;
    }
    if (!journal_leaf_open(root_fd, record, &leaf_fd)) return 0;
    if (strcmp(record->leaf_state, "STAGING") == 0) {
        acl_entry_value entries[16];
        size_t count = 0U;
        if (fstat(leaf_fd, &leaf_metadata) != 0 || (leaf_metadata.st_mode & 07777U) != 0700U ||
            read_acl(leaf_fd, "system.posix_acl_access", entries, ARRAY_LENGTH(entries), &count) != 0 || !acl_default_is_absent(leaf_fd)) { close(leaf_fd); return 0; }
    } else if (!allocation_directory_acl_valid(leaf_fd, policy->host_uid, 1)) { close(leaf_fd); return 0; }
    if (fstat(leaf_fd, &leaf_metadata) != 0 || fstat(root_fd, &path_metadata) != 0 ||
        !statx_mount_id(leaf_fd, &mount_id) || mount_id != root_mount) { close(leaf_fd); return 0; }
    device = (uint64_t)path_metadata.st_dev;
    memset(&budget, 0, sizeof(budget));
    budget.root_device = device;
    budget.root_mount = root_mount;
    budget.deadline = monotonic_milliseconds() + UINT64_C(30000);
    budget.open_fds = 1U;
    budget.host_uid = policy->host_uid;
    budget.host_gid = policy->host_gid;
    if ((uint64_t)leaf_metadata.st_dev != device || mount_id != root_mount || !cleanup_directory_contents(leaf_fd, 0U, &budget)) { close(leaf_fd); return 0; }
    if (fstatat(root_fd, record->basename, &path_metadata, AT_SYMLINK_NOFOLLOW) != 0 ||
        (uint64_t)path_metadata.st_dev != (uint64_t)leaf_metadata.st_dev || path_metadata.st_ino != leaf_metadata.st_ino ||
        !S_ISDIR(path_metadata.st_mode) || unlinkat(root_fd, record->basename, AT_REMOVEDIR) != 0 || fsync(root_fd) != 0) { close(leaf_fd); return 0; }
    close(leaf_fd);
    record->leaf_state[0] = '\0';
    (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "ABSENT");
    record->leaf_bound = 0;
    record->leaf_device[0] = '\0'; record->leaf_inode[0] = '\0';
    record->leaf_owner_uid = 0U; record->leaf_owner_gid = 0U; record->leaf_mode = 0U;
    return 1;
}

typedef struct {
    uid_t effective_uid;
    gid_t effective_gid;
    gid_t groups[NGROUPS_MAX];
    int group_count;
    unsigned long long cap_effective;
    int active;
} host_identity_guard;

static int host_identity_leave(host_identity_guard *guard);

static int effective_capabilities(unsigned long long *value)
{
    char bytes[4096];
    size_t used = 0U;
    int fd = open("/proc/self/status", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    while (used + 1U < sizeof(bytes)) {
        ssize_t count = read(fd, bytes + used, sizeof(bytes) - used - 1U);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return 0; }
        if (count == 0) break;
        used += (size_t)count;
    }
    close(fd);
    bytes[used] = '\0';
    {
        char *line = bytes;
        while (*line != '\0') {
            if (strncmp(line, "CapEff:", 7U) == 0) {
                char *end = NULL;
                errno = 0;
                *value = strtoull(line + 7U, &end, 16);
                return errno == 0 && end != line + 7U;
            }
            line = strchr(line, '\n');
            if (!line) break;
            line++;
        }
    }
    return 0;
}

static int host_identity_enter(uint32_t host_uid, uint32_t host_gid, host_identity_guard *guard)
{
    int group_count;
    memset(guard, 0, sizeof(*guard));
    if (geteuid() != 0U || getegid() != 0U) return 0;
    guard->effective_uid = geteuid();
    guard->effective_gid = getegid();
    group_count = getgroups(NGROUPS_MAX, guard->groups);
    if (group_count < 0 || !effective_capabilities(&guard->cap_effective)) return 0;
    guard->group_count = group_count;
    guard->active = 1;
    if (setgroups(0U, NULL) != 0 || setegid((gid_t)host_gid) != 0 || seteuid((uid_t)host_uid) != 0) { (void)host_identity_leave(guard); return 0; }
    if (geteuid() != (uid_t)host_uid || getegid() != (gid_t)host_gid || getgroups(0, NULL) != 0) { (void)host_identity_leave(guard); return 0; }
    {
        unsigned long long capabilities = ULLONG_MAX;
        if (!effective_capabilities(&capabilities) || capabilities != 0ULL) { (void)host_identity_leave(guard); return 0; }
    }
    return 1;
}

static int host_identity_leave(host_identity_guard *guard)
{
    unsigned long long capabilities = 0ULL;
    gid_t restored_groups[NGROUPS_MAX];
    int restored_count;
    int ok = 1;
    if (!guard->active) return 0;
    if (seteuid(guard->effective_uid) != 0 || setegid(guard->effective_gid) != 0 || setgroups((size_t)guard->group_count, guard->groups) != 0) ok = 0;
    restored_count = getgroups(NGROUPS_MAX, restored_groups);
    if (geteuid() != guard->effective_uid || getegid() != guard->effective_gid || restored_count != guard->group_count ||
        (restored_count >= 0 && memcmp(restored_groups, guard->groups, (size_t)restored_count * sizeof(gid_t)) != 0) ||
        !effective_capabilities(&capabilities) || capabilities != guard->cap_effective) ok = 0;
    guard->active = 0;
    return ok;
}

static int write_seed_file(int leaf_fd, const deployed_policy *policy, const unsigned char *bytes, size_t length, const char *name, journal_record *record)
{
    host_identity_guard guard;
    struct stat metadata;
    unsigned char digest[32];
    int fd = -1, ok = 0, entered = 0;
    if (strcmp(record->seed_name, name) != 0) return 0;
    if (!host_identity_enter(policy->host_uid, policy->host_gid, &guard)) return 0;
    entered = 1;
    fd = openat(leaf_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0660);
    if (fd < 0 || fchmod(fd, 0660) != 0 || !set_seed_acl(fd, policy->host_uid, 0) || !seed_acl_valid(fd, policy->host_uid, 0) ||
        !write_all_fd(fd, bytes, length) || fsync(fd) != 0 || fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        metadata.st_uid != policy->host_uid || metadata.st_gid != policy->host_gid || metadata.st_nlink != 1U || (uint64_t)metadata.st_size != (uint64_t)length) goto done;
    if (!host_identity_leave(&guard)) { entered = 0; goto done; }
    entered = 0;
    if (!seed_acl_valid(fd, policy->host_uid, 0) || fstat(fd, &metadata) != 0 || metadata.st_nlink != 1U ||
        metadata.st_uid != policy->host_uid || metadata.st_gid != policy->host_gid || (uint64_t)metadata.st_size != (uint64_t)length) goto done;
    sha256_bytes(bytes, length, digest);
    hex_encode(digest, sizeof(digest), record->seed_sha256);
    (void)snprintf(record->seed_device, sizeof(record->seed_device), "%" PRIu64, (uint64_t)metadata.st_dev);
    (void)snprintf(record->seed_inode, sizeof(record->seed_inode), "%" PRIu64, (uint64_t)metadata.st_ino);
    record->seed_bound = 1;
    record->seed_size = (uint64_t)length;
    ok = 1;
done:
    if (entered) (void)host_identity_leave(&guard);
    if (fd >= 0) close(fd);
    return ok;
}

static int seed_post_admit(int leaf_fd, const deployed_policy *policy, const journal_record *record)
{
    struct stat metadata;
    uint64_t expected_device, expected_inode;
    unsigned char digest[32];
    char actual_digest[65];
    int fd;
    if (!record->seed_bound || !parse_u64_decimal(record->seed_device, &expected_device) || !parse_u64_decimal(record->seed_inode, &expected_inode)) return 0;
    fd = openat(leaf_fd, record->seed_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1U ||
        (uint64_t)metadata.st_dev != expected_device || (uint64_t)metadata.st_ino != expected_inode ||
        metadata.st_uid != policy->host_uid || metadata.st_gid != policy->host_gid || (uint64_t)metadata.st_size != record->seed_size ||
        !seed_acl_valid(fd, policy->host_uid, 0) || !sha256_fd(fd, digest)) { close(fd); return 0; }
    hex_encode(digest, sizeof(digest), actual_digest);
    if (strcmp(actual_digest, record->seed_sha256) != 0 || !set_seed_acl(fd, policy->host_uid, 1) || !seed_acl_valid(fd, policy->host_uid, 1)) { close(fd); return 0; }
    close(fd);
    return 1;
}

typedef struct {
    uint32_t child_pid;
    uint64_t ipc_namespace;
    uint64_t mount_namespace;
    uint64_t network_namespace;
    uint64_t pid_namespace;
    uint64_t uts_namespace;
} bwrap_initial_status;

static void json_skip_space(json_cursor *cursor)
{
    while (cursor->cursor < cursor->end && (*cursor->cursor == ' ' || *cursor->cursor == '\t' || *cursor->cursor == '\r' || *cursor->cursor == '\n')) cursor->cursor++;
}

static int json_expect(json_cursor *cursor, const char *text)
{
    json_skip_space(cursor);
    return expect_json_text(cursor, text);
}

static int parse_bwrap_initial_status(const unsigned char *bytes, size_t length, bwrap_initial_status *status)
{
    json_cursor cursor = { bytes, bytes + length };
    unsigned int fields = 0U;
    memset(status, 0, sizeof(*status));
    if (!json_expect(&cursor, "{")) return 0;
    for (;;) {
        char key[32];
        unsigned int bit;
        uint64_t number;
        if (!parse_json_string(&cursor, key, sizeof(key)) || !json_expect(&cursor, ":")) return 0;
        if (strcmp(key, "child-pid") == 0) bit = 1U;
        else if (strcmp(key, "ipc-namespace") == 0) bit = 2U;
        else if (strcmp(key, "mnt-namespace") == 0) bit = 4U;
        else if (strcmp(key, "net-namespace") == 0) bit = 8U;
        else if (strcmp(key, "pid-namespace") == 0) bit = 16U;
        else if (strcmp(key, "uts-namespace") == 0) bit = 32U;
        else return 0;
        if ((fields & bit) != 0U || !parse_json_u64(&cursor, bit == 1U ? UINT32_MAX : UINT64_MAX, &number) || number == 0U) return 0;
        fields |= bit;
        if (bit == 1U) status->child_pid = (uint32_t)number;
        else if (bit == 2U) status->ipc_namespace = number;
        else if (bit == 4U) status->mount_namespace = number;
        else if (bit == 8U) status->network_namespace = number;
        else if (bit == 16U) status->pid_namespace = number;
        else status->uts_namespace = number;
        json_skip_space(&cursor);
        if (cursor.cursor < cursor.end && *cursor.cursor == ',') { cursor.cursor++; continue; }
        break;
    }
    if (!json_expect(&cursor, "}") || cursor.cursor != cursor.end || fields != 63U) return 0;
    return status->child_pid > 0U;
}

static int parse_bwrap_terminal_status(const unsigned char *bytes, size_t length, int32_t *exit_code)
{
    json_cursor cursor = { bytes, bytes + length };
    uint32_t value;
    if (!json_expect(&cursor, "{") || !json_expect(&cursor, "\"exit-code\"") || !json_expect(&cursor, ":") ||
        !parse_json_u32(&cursor, 255U, 1, &value) || !json_expect(&cursor, "}") || cursor.cursor != cursor.end) return 0;
    *exit_code = (int32_t)value;
    return 1;
}

static int pipe_read_line_until(int fd, unsigned char *output, size_t capacity, size_t *length, uint64_t deadline)
{
    *length = 0U;
    while (*length < capacity) {
        unsigned char value;
        int ready = wait_readable_until(fd, deadline);
        ssize_t count;
        if (ready <= 0) return 0;
        count = read(fd, &value, 1U);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        output[(*length)++] = value;
        if (value == '\n') return 1;
    }
    return 0;
}

static int capture_append(capture_buffer *capture, const unsigned char *bytes, size_t length)
{
    size_t required, capacity;
    unsigned char *grown;
    if (length > capture->limit - (capture->length <= capture->limit ? capture->length : capture->limit)) {
        capture->overflow = 1;
        return 0;
    }
    required = capture->length + length;
    if (required > capture->capacity) {
        capacity = capture->capacity == 0U ? 16384U : capture->capacity;
        while (capacity < required) {
            if (capacity > capture->limit / 2U) { capacity = capture->limit; break; }
            capacity *= 2U;
        }
        if (capacity < required) { capture->overflow = 1; return 0; }
        grown = (unsigned char *)realloc(capture->bytes, capacity);
        if (!grown) return 0;
        capture->bytes = grown;
        capture->capacity = capacity;
    }
    memcpy(capture->bytes + capture->length, bytes, length);
    capture->length = required;
    return 1;
}

static int capture_pipe_drain(int fd, capture_buffer *capture, int *open)
{
    unsigned char bytes[16384];
    for (;;) {
        ssize_t count = read(fd, bytes, sizeof(bytes));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 1;
        if (count < 0) return 0;
        if (count == 0) { close(fd); *open = 0; return 1; }
        if (!capture_append(capture, bytes, (size_t)count)) return 0;
    }
}

static int argv_add(const char **arguments, size_t *count, const char *value)
{
    if (*count + 1U >= 256U) return 0;
    arguments[(*count)++] = value;
    arguments[*count] = NULL;
    return 1;
}

static int argv_add_pair(const char **arguments, size_t *count, const char *option, const char *value)
{
    return argv_add(arguments, count, option) && argv_add(arguments, count, value);
}

static int argv_add_triple(const char **arguments, size_t *count, const char *option, const char *source, const char *destination)
{
    return argv_add(arguments, count, option) && argv_add(arguments, count, source) && argv_add(arguments, count, destination);
}

static int build_sandbox_argv(const deployed_policy *policy, const broker_request *request, const char *leaf_path, char work_path[1200], const char **arguments, size_t *argument_count)
{
    static const char *const mkdir_paths[] = { "/etc", "/lib", "/lib64", "/lib/x86_64-linux-gnu", "/run", "/run/s8-runtime", "/run/s8-runtime/swooshz", "/opt", "/work" };
    static const char *const writer_command[] = { "/run/s8-runtime/blender/blender", "--background", "--factory-startup", "--python-exit-code", "1", "--python", "/run/s8-runtime/swooshz/writer.py" };
    static const char *const writer_runner_limits[] = { "--address-space-bytes", "4294967296", "--file-bytes", "134217728", "--timeout-ms", "300000", "--stdout-bytes", "1048576", "--stderr-bytes", "1048576", "--max-children", "0" };
    static const char *const validator_runner_limits[] = { "--address-space-bytes", "1610612736", "--file-bytes", "268435456", "--timeout-ms", "120000", "--stdout-bytes", "8388608", "--stderr-bytes", "1048576", "--max-children", "0" };
    size_t count = 0U, index;
    int printed;
    memset(arguments, 0, 256U * sizeof(arguments[0]));
    printed = snprintf(work_path, 1200U, "%s/%s", policy->config.private_work_root, leaf_path);
    if (printed < 0 || (size_t)printed >= 1200U) return 0;
    if (!argv_add(arguments, &count, "--unshare-user") || !argv_add(arguments, &count, "--unshare-net") ||
        !argv_add(arguments, &count, "--unshare-pid") || !argv_add(arguments, &count, "--unshare-ipc") ||
        !argv_add(arguments, &count, "--unshare-uts") || !argv_add(arguments, &count, "--disable-userns") ||
        !argv_add(arguments, &count, "--assert-userns-disabled") || !argv_add(arguments, &count, "--die-with-parent") ||
        !argv_add(arguments, &count, "--new-session") || !argv_add_pair(arguments, &count, "--uid", "65534") ||
        !argv_add_pair(arguments, &count, "--gid", "65534") || !argv_add_pair(arguments, &count, "--cap-drop", "ALL") ||
        !argv_add(arguments, &count, "--clearenv")) return 0;
    for (index = 0U; index < ARRAY_LENGTH(mkdir_paths); index++) if (!argv_add_pair(arguments, &count, "--dir", mkdir_paths[index])) return 0;
    for (index = 0U; index < ARRAY_LENGTH(system_runtime_paths); index++)
        if (!argv_add_triple(arguments, &count, "--ro-bind", system_runtime_paths[index], system_runtime_paths[index])) return 0;
    if (!argv_add_triple(arguments, &count, "--ro-bind", policy->config.blender_runtime_root, "/run/s8-runtime/blender") ||
        !argv_add_triple(arguments, &count, "--ro-bind", RUNNER_PATH, "/run/s8-runtime/process-runner")) return 0;
    if (request->operation == OP_WRITER) {
        char exporter[1025], manifest[1025];
        int one = snprintf(exporter, sizeof(exporter), "%s/export_fbx_bin.py", "/opt/swooshz");
        int two = snprintf(manifest, sizeof(manifest), "%s/patch-manifest.json", "/opt/swooshz");
        if (one < 0 || (size_t)one >= sizeof(exporter) || two < 0 || (size_t)two >= sizeof(manifest) ||
            !argv_add_triple(arguments, &count, "--ro-bind", policy->config.writer_script, "/run/s8-runtime/swooshz/writer.py") ||
            !argv_add_triple(arguments, &count, "--ro-bind", exporter, "/run/s8-runtime/swooshz/export_fbx_bin.py") ||
            !argv_add_triple(arguments, &count, "--ro-bind", manifest, "/run/s8-runtime/swooshz/patch-manifest.json")) return 0;
    } else if (request->operation == OP_VALIDATOR) {
        if (!argv_add_triple(arguments, &count, "--ro-bind", policy->config.native_validator_executable, "/run/s8-runtime/native-validator")) return 0;
    } else return 0;
    if (!argv_add_pair(arguments, &count, "--proc", "/proc") || !argv_add_pair(arguments, &count, "--dev", "/dev") ||
        !argv_add_pair(arguments, &count, "--tmpfs", "/tmp") || !argv_add_triple(arguments, &count, "--bind", work_path, "/work") ||
        !argv_add_pair(arguments, &count, "--chdir", "/work") || !argv_add_pair(arguments, &count, "--block-fd", "3") ||
        !argv_add_pair(arguments, &count, "--sync-fd", "4") || !argv_add_pair(arguments, &count, "--json-status-fd", "5") ||
        !argv_add(arguments, &count, "--as-pid-1") || !argv_add(arguments, &count, "--") ||
        !argv_add(arguments, &count, "/run/s8-runtime/process-runner")) return 0;
    for (index = 0U; index < ARRAY_LENGTH(writer_runner_limits); index++) {
        const char *const *limits = request->operation == OP_WRITER ? writer_runner_limits : validator_runner_limits;
        if (!argv_add(arguments, &count, limits[index])) return 0;
    }
    if (!argv_add(arguments, &count, "--") ) return 0;
    if (request->operation == OP_WRITER) {
        for (index = 0U; index < ARRAY_LENGTH(writer_command); index++) if (!argv_add(arguments, &count, writer_command[index])) return 0;
    } else {
        if (!argv_add(arguments, &count, "/run/s8-runtime/native-validator") || !argv_add(arguments, &count, "/work/artifact.fbx")) return 0;
    }
    *argument_count = count;
    return 1;
}

static int sandbox_namespace_identity_valid(const bwrap_initial_status *status, journal_process_identity *identity)
{
    static const char *const names[] = { "ipc", "mnt", "net", "pid", "uts" };
    const uint64_t expected[] = { status->ipc_namespace, status->mount_namespace, status->network_namespace, status->pid_namespace, status->uts_namespace };
    struct stat host_metadata;
    size_t index;
    char path[96];
    if (!process_namespace_identity((pid_t)status->child_pid, identity, 1)) return 0;
    if (strcmp(identity->namespace_inode, "") == 0 || (uint64_t)strtoull(identity->namespace_inode, NULL, 10) != status->pid_namespace) return 0;
    for (index = 0U; index < ARRAY_LENGTH(names); index++) {
        struct stat actual;
        int printed = snprintf(path, sizeof(path), "/proc/%u/ns/%s", status->child_pid, names[index]);
        if (printed < 0 || (size_t)printed >= sizeof(path) || stat(path, &actual) != 0 || (uint64_t)actual.st_ino != expected[index]) return 0;
        printed = snprintf(path, sizeof(path), "/proc/self/ns/%s", names[index]);
        if (printed < 0 || (size_t)printed >= sizeof(path) || stat(path, &host_metadata) != 0 || actual.st_ino == host_metadata.st_ino) return 0;
    }
    return 1;
}

typedef struct {
    char sandbox_work_path[1200];
    const char *sandbox_argv[256];
    size_t sandbox_argc;
    capture_buffer native_stdout;
    capture_buffer native_stderr;
    int pidfd_termination_pass;
} sandbox_run_result;

static int journal_checkpoint_write(int journal_fd, journal_record *record)
{
    if (record->transition_sequence >= UINT64_C(9007199254740991)) return 0;
    record->transition_sequence++;
    return journal_record_write(journal_fd, record);
}

static int parse_proc_pid(const char *text, pid_t *pid)
{
    uint64_t value = 0U;
    const unsigned char *cursor = (const unsigned char *)text;
    if (*cursor == '\0') return 0;
    while (*cursor != '\0') {
        uint64_t digit;
        if (*cursor < '0' || *cursor > '9') return 0;
        digit = (uint64_t)(*cursor - '0');
        if (value > (UINT32_MAX - digit) / 10U) return 0;
        value = value * 10U + digit;
        cursor++;
    }
    if (value == 0U) return 0;
    *pid = (pid_t)value;
    return 1;
}

static int pid_namespace_processes_present(uint64_t expected_device, uint64_t expected_inode)
{
    DIR *proc = opendir("/proc");
    struct dirent *entry;
    if (!proc) return -1;
    while ((entry = readdir(proc)) != NULL) {
        pid_t pid;
        char path[96];
        struct stat metadata;
        int printed;
        if (!parse_proc_pid(entry->d_name, &pid)) continue;
        printed = snprintf(path, sizeof(path), "/proc/%ld/ns/pid", (long)pid);
        if (printed < 0 || (size_t)printed >= sizeof(path)) { closedir(proc); return -1; }
        if (stat(path, &metadata) != 0) continue;
        if ((uint64_t)metadata.st_dev == expected_device && (uint64_t)metadata.st_ino == expected_inode) { closedir(proc); return 1; }
    }
    closedir(proc);
    return 0;
}

static int wait_child_until(pid_t pid, int pidfd, uint64_t deadline, int *status)
{
    for (;;) {
        pid_t result = waitpid(pid, status, WNOHANG);
        if (result == pid) return 1;
        if (result < 0 && errno != EINTR) return 0;
        if (monotonic_milliseconds() >= deadline) return 0;
        if (pidfd >= 0) {
            struct pollfd descriptor = { pidfd, POLLIN, 0 };
            (void)poll(&descriptor, 1U, 50);
        } else {
            struct timespec pause = { 0, 50000000L };
            (void)nanosleep(&pause, NULL);
        }
    }
}

static void close_fd_if_open(int *fd)
{
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static int create_pipe_cloexec(int pipe_fds[2])
{
    pipe_fds[0] = -1; pipe_fds[1] = -1;
    return pipe2(pipe_fds, O_CLOEXEC) == 0;
}

static int set_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static void close_child_descriptors(void)
{
#ifdef SYS_close_range
    if (syscall(SYS_close_range, 6U, UINT_MAX, 0U) == 0) return;
#endif
    {
        long maximum = sysconf(_SC_OPEN_MAX);
        int fd;
        if (maximum < 0 || maximum > 65536) maximum = 65536;
        for (fd = 6; fd < maximum; fd++) (void)close(fd);
    }
}

static int spawn_sandbox_monitor(const char **arguments, const char *environment[], int launch_pipe[2], int gate_pipe[2], int sync_pipe[2], int status_pipe[2], int stdout_pipe[2], int stderr_pipe[2], pid_t *monitor_pid)
{
    int gate_source, sync_source, status_source, stdout_source, stderr_source;
    char *exec_arguments[257];
    size_t index;
    pid_t pid, parent_pid = getpid();
    exec_arguments[0] = (char *)BWRAP_PATH;
    for (index = 0U; arguments[index] != NULL; index++) exec_arguments[index + 1U] = (char *)arguments[index];
    exec_arguments[index + 1U] = NULL;
    pid = fork();
    if (pid < 0) return 0;
    if (pid == 0) {
        unsigned char launch;
        ssize_t launch_count;
        close(launch_pipe[1]);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent_pid) _exit(126);
        do { launch_count = read(launch_pipe[0], &launch, 1U); } while (launch_count < 0 && errno == EINTR);
        close(launch_pipe[0]);
        if (launch_count != 1 || launch != 'L') _exit(126);
        gate_source = fcntl(gate_pipe[0], F_DUPFD_CLOEXEC, 10);
        sync_source = fcntl(sync_pipe[1], F_DUPFD_CLOEXEC, 10);
        status_source = fcntl(status_pipe[1], F_DUPFD_CLOEXEC, 10);
        stdout_source = fcntl(stdout_pipe[1], F_DUPFD_CLOEXEC, 10);
        stderr_source = fcntl(stderr_pipe[1], F_DUPFD_CLOEXEC, 10);
        if (gate_source < 0 || sync_source < 0 || status_source < 0 || stdout_source < 0 || stderr_source < 0 ||
            dup2(gate_source, 3) < 0 || dup2(sync_source, 4) < 0 || dup2(status_source, 5) < 0 ||
            dup2(stdout_source, STDOUT_FILENO) < 0 || dup2(stderr_source, STDERR_FILENO) < 0) _exit(126);
        close_child_descriptors();
        execve(BWRAP_PATH, exec_arguments, (char *const *)environment);
        _exit(127);
    }
    *monitor_pid = pid;
    return 1;
}

static int terminate_launch(int init_pidfd, int monitor_pidfd, pid_t monitor_pid, uint64_t deadline, int *wait_status)
{
    int init_exited = init_pidfd < 0 || pidfd_exited_until(init_pidfd, deadline);
    int monitor_exited = 0;
    if (!init_exited && init_pidfd >= 0) (void)pidfd_signal_checked(init_pidfd, SIGKILL);
    if (!init_exited && init_pidfd >= 0) init_exited = pidfd_exited_until(init_pidfd, deadline);
    monitor_exited = monitor_pidfd >= 0 && pidfd_exited_until(monitor_pidfd, deadline);
    if (!monitor_exited && monitor_pidfd >= 0) (void)pidfd_signal_checked(monitor_pidfd, SIGKILL);
    if (!monitor_exited && monitor_pidfd >= 0) monitor_exited = pidfd_exited_until(monitor_pidfd, deadline);
    if (monitor_pid > 0 && wait_status) {
        pid_t waited = waitpid(monitor_pid, wait_status, WNOHANG);
        if (waited == monitor_pid) monitor_exited = 1;
        else if (waited == 0) {
            int ignored;
            if (!wait_child_until(monitor_pid, monitor_pidfd, deadline, &ignored)) return 0;
            *wait_status = ignored;
            monitor_exited = 1;
        } else if (waited < 0 && errno == ECHILD && monitor_pidfd >= 0) {
            monitor_exited = pidfd_exited_until(monitor_pidfd, deadline);
        }
    }
    return init_exited && monitor_exited;
}

static broker_status run_sandbox(const deployed_policy *policy, const broker_request *request, int journal_fd,
    journal_record *record, sandbox_run_result *result, int *outer_wait_status)
{
    int launch_pipe[2] = { -1, -1 }, gate_pipe[2] = { -1, -1 }, sync_pipe[2] = { -1, -1 }, status_pipe[2] = { -1, -1 }, stdout_pipe[2] = { -1, -1 }, stderr_pipe[2] = { -1, -1 };
    const char *environment[] = { "PWD=/work", NULL };
    unsigned char first_line[1024], launch = 'L', release = 'R';
    size_t first_length = 0U;
    uint64_t setup_deadline, run_deadline, teardown_deadline;
    bwrap_initial_status initial;
    journal_process_identity monitor_identity, init_identity;
    pid_t monitor_pid = -1;
    int monitor_pidfd = -1, init_pidfd = -1, monitor_reaped = 0, monitor_status = 0;
    int gate_open = 0, sync_open = 1, status_open = 1, stdout_open = 1, stderr_open = 1;
    capture_buffer status_capture = { NULL, 0U, 0U, 2048U, 0 };
    broker_status failure = STATUS_LAUNCH_OR_STATUS_INVALID;
    int timeout = 0, protocol_error = 0;
    size_t maximum_stdout = request->operation == OP_WRITER ? 1064960U : 8404992U;
    size_t maximum_stderr = 1048576U;
    memset(result, 0, sizeof(*result));
    result->native_stdout.limit = maximum_stdout;
    result->native_stderr.limit = maximum_stderr;
    *outer_wait_status = 0;
    if (!build_sandbox_argv(policy, request, record->basename, result->sandbox_work_path, result->sandbox_argv, &result->sandbox_argc)) return STATUS_BROKER_INTERNAL;
    if (!create_pipe_cloexec(launch_pipe) || !create_pipe_cloexec(gate_pipe) || !create_pipe_cloexec(sync_pipe) || !create_pipe_cloexec(status_pipe) ||
        !create_pipe_cloexec(stdout_pipe) || !create_pipe_cloexec(stderr_pipe)) goto done;
    if (!spawn_sandbox_monitor(result->sandbox_argv, environment, launch_pipe, gate_pipe, sync_pipe, status_pipe, stdout_pipe, stderr_pipe, &monitor_pid)) goto done;
    close_fd_if_open(&launch_pipe[0]);
    close_fd_if_open(&gate_pipe[0]);
    close_fd_if_open(&sync_pipe[1]);
    close_fd_if_open(&status_pipe[1]);
    close_fd_if_open(&stdout_pipe[1]);
    close_fd_if_open(&stderr_pipe[1]);
    gate_open = 1;
    monitor_pidfd = (int)syscall(SYS_pidfd_open, monitor_pid, 0U);
    if (monitor_pidfd < 0 || !process_namespace_identity(monitor_pid, &monitor_identity, 0)) goto terminate;
    record->monitor = monitor_identity;
    if (!journal_checkpoint_write(journal_fd, record)) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    if (!write_all_fd(launch_pipe[1], &launch, 1U)) goto terminate;
    close_fd_if_open(&launch_pipe[1]);
    if (!set_nonblocking(sync_pipe[0]) || !set_nonblocking(status_pipe[0]) || !set_nonblocking(stdout_pipe[0]) || !set_nonblocking(stderr_pipe[0])) goto terminate;
    setup_deadline = monotonic_milliseconds() + UINT64_C(30000);
    if (!pipe_read_line_until(status_pipe[0], first_line, sizeof(first_line), &first_length, setup_deadline) || first_length < 2U || first_line[first_length - 1U] != '\n' ||
        !parse_bwrap_initial_status(first_line, first_length - 1U, &initial)) goto terminate;
    if (!capture_append(&status_capture, first_line, first_length) || !sandbox_namespace_identity_valid(&initial, &init_identity)) {
        failure = STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD;
        goto terminate;
    }
    init_pidfd = open_pidfd_checked(&init_identity, 1);
    if (init_pidfd < 0 || initial.child_pid != init_identity.pid) { failure = STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD; goto terminate; }
    record->init = init_identity;
    (void)snprintf(record->launch_state, sizeof(record->launch_state), "PIDNS_INIT_REGISTERED");
    if (!journal_transition_write(journal_fd, record, "PIDNS_INIT_REGISTERED")) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    if (!journal_transition_write(journal_fd, record, "RELEASE_INTENT")) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    if (!write_all_fd(gate_pipe[1], &release, 1U)) goto terminate;
    close_fd_if_open(&gate_pipe[1]);
    gate_open = 0;
    if (!journal_transition_write(journal_fd, record, "RUNNING")) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    run_deadline = monotonic_milliseconds() + (request->operation == OP_WRITER ? UINT64_C(310000) : UINT64_C(130000));
    for (;;) {
        struct pollfd descriptors[5];
        int kinds[5];
        nfds_t count = 0U;
        uint64_t now = monotonic_milliseconds();
        int wait_ms, poll_result;
        if (now == 0U || now >= run_deadline) { timeout = 1; break; }
        if (stdout_open) { descriptors[count] = (struct pollfd){ stdout_pipe[0], POLLIN | POLLHUP, 0 }; kinds[count++] = 1; }
        if (stderr_open) { descriptors[count] = (struct pollfd){ stderr_pipe[0], POLLIN | POLLHUP, 0 }; kinds[count++] = 2; }
        if (status_open) { descriptors[count] = (struct pollfd){ status_pipe[0], POLLIN | POLLHUP, 0 }; kinds[count++] = 3; }
        if (sync_open) { descriptors[count] = (struct pollfd){ sync_pipe[0], POLLIN | POLLHUP, 0 }; kinds[count++] = 4; }
        if (!monitor_reaped) { descriptors[count] = (struct pollfd){ monitor_pidfd, POLLIN, 0 }; kinds[count++] = 5; }
        wait_ms = (int)((run_deadline - now) > 100U ? 100U : run_deadline - now);
        poll_result = poll(descriptors, count, wait_ms);
        if (poll_result < 0 && errno != EINTR) { protocol_error = 1; break; }
        for (nfds_t index = 0U; index < count && poll_result > 0; index++) {
            if (descriptors[index].revents == 0) continue;
            if (kinds[index] == 1 && !capture_pipe_drain(stdout_pipe[0], &result->native_stdout, &stdout_open)) { protocol_error = 1; break; }
            if (kinds[index] == 2 && !capture_pipe_drain(stderr_pipe[0], &result->native_stderr, &stderr_open)) { protocol_error = 1; break; }
            if (kinds[index] == 3 && !capture_pipe_drain(status_pipe[0], &status_capture, &status_open)) { protocol_error = 1; break; }
            if (kinds[index] == 4) {
                unsigned char unexpected[8];
                ssize_t bytes = read(sync_pipe[0], unexpected, sizeof(unexpected));
                if (bytes < 0 && errno == EINTR) continue;
                if (bytes < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
                if (bytes > 0) { protocol_error = 1; break; }
                close_fd_if_open(&sync_pipe[0]);
                sync_open = 0;
            }
        }
        if (result->native_stdout.overflow || result->native_stderr.overflow || status_capture.overflow) { protocol_error = 1; break; }
        if (!monitor_reaped) {
            pid_t waited = waitpid(monitor_pid, &monitor_status, WNOHANG);
            if (waited == monitor_pid) { monitor_reaped = 1; *outer_wait_status = monitor_status; }
            else if (waited < 0 && errno != EINTR) { protocol_error = 1; break; }
        }
        if (monitor_reaped && !stdout_open && !stderr_open && !status_open && !sync_open) break;
    }
    if (timeout || protocol_error) {
        teardown_deadline = monotonic_milliseconds() + UINT64_C(30000);
        if (!terminate_launch(init_pidfd, monitor_pidfd, monitor_pid, teardown_deadline, outer_wait_status)) failure = STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD;
        else if (timeout) failure = STATUS_OPERATION_TIMEOUT;
        else failure = STATUS_LAUNCH_OR_STATUS_INVALID;
        goto done;
    }
    if (!monitor_reaped || !WIFEXITED(monitor_status)) { failure = STATUS_LAUNCH_OR_STATUS_INVALID; goto terminate; }
    if (status_capture.length <= first_length || status_capture.bytes[status_capture.length - 1U] != '\n' ||
        memchr(status_capture.bytes + first_length, '\n', status_capture.length - first_length - 1U) != NULL) goto terminate;
    {
        size_t terminal_length = status_capture.length - first_length;
        int32_t reported_exit;
        if (terminal_length < 2U || !parse_bwrap_terminal_status(status_capture.bytes + first_length, terminal_length - 1U, &reported_exit) ||
            reported_exit != (int32_t)WEXITSTATUS(monitor_status)) goto terminate;
    }
    teardown_deadline = monotonic_milliseconds() + UINT64_C(30000);
    if (!pidfd_exited_until(init_pidfd, teardown_deadline)) { failure = STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD; goto terminate; }
    {
        uint64_t ns_device, ns_inode;
        int present;
        if (!parse_u64_decimal(record->init.namespace_device, &ns_device) || !parse_u64_decimal(record->init.namespace_inode, &ns_inode)) { failure = STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD; goto terminate; }
        present = pid_namespace_processes_present(ns_device, ns_inode);
        if (present != 0) { failure = STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD; goto terminate; }
    }
    result->pidfd_termination_pass = 1;
    if (!journal_transition_write(journal_fd, record, "TARGET_TERMINATED")) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    (void)snprintf(record->launch_state, sizeof(record->launch_state), "TARGET_TERMINATED");
    if (!journal_checkpoint_write(journal_fd, record)) { failure = STATUS_JOURNAL_INVALID; goto terminate; }
    if (!WIFEXITED(monitor_status) || WEXITSTATUS(monitor_status) != 0 || result->native_stderr.length > BROKER_STDERR_MAX_BYTES) {
        failure = STATUS_NATIVE_OPERATION_FAILED;
        goto done;
    }
    failure = STATUS_SUCCESS;
    goto done;

terminate:
    close_fd_if_open(&launch_pipe[1]);
    close_fd_if_open(&gate_pipe[1]);
    gate_open = 0;
    teardown_deadline = monotonic_milliseconds() + UINT64_C(30000);
    if (monitor_pid > 0 && !terminate_launch(init_pidfd, monitor_pidfd, monitor_pid, teardown_deadline, outer_wait_status)) {
        failure = STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD;
    }
done:
    close_fd_if_open(&launch_pipe[0]); close_fd_if_open(&launch_pipe[1]);
    if (gate_open) { close_fd_if_open(&gate_pipe[1]); gate_open = 0; }
    close_fd_if_open(&gate_pipe[0]); close_fd_if_open(&gate_pipe[1]);
    close_fd_if_open(&sync_pipe[0]); close_fd_if_open(&sync_pipe[1]);
    close_fd_if_open(&status_pipe[0]); close_fd_if_open(&status_pipe[1]);
    close_fd_if_open(&stdout_pipe[0]); close_fd_if_open(&stdout_pipe[1]);
    close_fd_if_open(&stderr_pipe[0]); close_fd_if_open(&stderr_pipe[1]);
    close_fd_if_open(&monitor_pidfd); close_fd_if_open(&init_pidfd);
    free(status_capture.bytes);
    return failure;
}

static int allocation_directory_empty(int fd)
{
    int scan_fd = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    DIR *directory;
    struct dirent *entry;
    if (scan_fd < 0) return 0;
    directory = fdopendir(scan_fd);
    if (!directory) { close(scan_fd); return 0; }
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) { closedir(directory); return 0; }
    }
    closedir(directory);
    return 1;
}

static int journal_record_initialize(journal_record *record, const deployed_policy *policy, broker_operation operation, int root_fd, uint64_t root_mount)
{
    struct stat root_metadata;
    unsigned char empty_digest[32];
    int printed;
    memset(record, 0, sizeof(*record));
    if (!random_allocation_id(record->allocation_id) || !current_boot_id(record->root_boot_id) || fstat(root_fd, &root_metadata) != 0) return 0;
    (void)snprintf(record->operation, sizeof(record->operation), "%s", operation == OP_WRITER ? "WRITER" : "VALIDATOR");
    (void)snprintf(record->policy_identity, sizeof(record->policy_identity), "%s", policy->policy_sha256);
    (void)snprintf(record->config_identity, sizeof(record->config_identity), "%s", policy->config_sha256);
    (void)snprintf(record->root_device, sizeof(record->root_device), "%" PRIu64, (uint64_t)root_metadata.st_dev);
    (void)snprintf(record->root_inode, sizeof(record->root_inode), "%" PRIu64, (uint64_t)root_metadata.st_ino);
    (void)snprintf(record->root_mount_identity, sizeof(record->root_mount_identity), "%" PRIu64, root_mount);
    printed = snprintf(record->basename, sizeof(record->basename), "%s%s", ALLOCATION_PREFIX, record->allocation_id);
    if (printed < 0 || (size_t)printed >= sizeof(record->basename)) return 0;
    (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "UNBOUND");
    (void)snprintf(record->seed_name, sizeof(record->seed_name), "%s", operation == OP_WRITER ? "input.json" : "artifact.fbx");
    (void)snprintf(record->launch_state, sizeof(record->launch_state), "NOT_STARTED");
    (void)snprintf(record->cleanup_state, sizeof(record->cleanup_state), "NOT_STARTED");
    (void)snprintf(record->state, sizeof(record->state), "PRE_JOURNALED");
    sha256_bytes((const unsigned char *)"", 0U, empty_digest);
    hex_encode(empty_digest, sizeof(empty_digest), record->seed_sha256);
    return 1;
}

static int allocation_leaf_create(int root_fd, int journal_fd, const deployed_policy *policy, journal_record *record, int *leaf_fd)
{
    struct stat metadata;
    acl_entry_value entries[16];
    size_t entry_count = 0U;
    int fd;
    if (!journal_record_write(journal_fd, record)) return 0;
    if (mkdirat(root_fd, record->basename, 0700) != 0 || fsync(root_fd) != 0) return 0;
    fd = openat(root_fd, record->basename, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & 07777U) != 0700U || read_acl(fd, "system.posix_acl_access", entries, ARRAY_LENGTH(entries), &entry_count) != 0 ||
        !acl_default_is_absent(fd) || !allocation_directory_empty(fd)) { close(fd); return 0; }
    record->leaf_bound = 1;
    (void)snprintf(record->leaf_device, sizeof(record->leaf_device), "%" PRIu64, (uint64_t)metadata.st_dev);
    (void)snprintf(record->leaf_inode, sizeof(record->leaf_inode), "%" PRIu64, (uint64_t)metadata.st_ino);
    record->leaf_owner_uid = (uint32_t)metadata.st_uid;
    record->leaf_owner_gid = (uint32_t)metadata.st_gid;
    record->leaf_mode = (uint32_t)(metadata.st_mode & 07777U);
    (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "STAGING");
    if (!journal_checkpoint_write(journal_fd, record)) { close(fd); return 0; }
    if (!set_allocation_acl(fd, policy->host_uid) || fchmod(fd, 0770) != 0 || !allocation_directory_acl_valid(fd, policy->host_uid, 1) ||
        fstat(fd, &metadata) != 0 || metadata.st_uid != 0U || metadata.st_gid != 0U || (metadata.st_mode & 07777U) != 0770U) { close(fd); return 0; }
    record->leaf_mode = (uint32_t)(metadata.st_mode & 07777U);
    (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "BOUND");
    if (!journal_checkpoint_write(journal_fd, record) || !journal_transition_write(journal_fd, record, "ALLOCATED_BOUND") ||
        !journal_transition_write(journal_fd, record, "HOST_ACCESS_ADMITTED")) { close(fd); return 0; }
    *leaf_fd = fd;
    return 1;
}

static int recovery_identity_state(const journal_process_identity *identity, int require_pid_one)
{
    struct stat proc_metadata, ns_metadata;
    char path[96], current_boot[37], starttime[21];
    int printed;
    if (!identity->bound || !current_boot_id(current_boot) || strcmp(current_boot, identity->boot_id) != 0) return -1;
    printed = snprintf(path, sizeof(path), "/proc/%u", identity->pid);
    if (printed < 0 || (size_t)printed >= sizeof(path)) return -1;
    if (stat(path, &proc_metadata) != 0) return errno == ENOENT ? 0 : -1;
    if (!proc_starttime((pid_t)identity->pid, starttime)) return stat(path, &proc_metadata) != 0 && errno == ENOENT ? 0 : -1;
    if (strcmp(starttime, identity->starttime) != 0) return -1;
    if (identity->namespace_device[0] != '\0' || identity->namespace_inode[0] != '\0') {
        uint64_t expected_device, expected_inode;
        printed = snprintf(path, sizeof(path), "/proc/%u/ns/pid", identity->pid);
        if (printed < 0 || (size_t)printed >= sizeof(path) || stat(path, &ns_metadata) != 0 ||
            !parse_u64_decimal(identity->namespace_device, &expected_device) || !parse_u64_decimal(identity->namespace_inode, &expected_inode) ||
            (uint64_t)ns_metadata.st_dev != expected_device || (uint64_t)ns_metadata.st_ino != expected_inode) return -1;
    }
    if (require_pid_one && !process_identity_matches(identity, 1)) return -1;
    return 1;
}

static broker_status recover_identity_process(const journal_process_identity *identity, int require_pid_one, broker_status unknown_status)
{
    int state = recovery_identity_state(identity, require_pid_one);
    int fd;
    uint64_t deadline;
    if (state == 0) return STATUS_SUCCESS;
    if (state < 0) return unknown_status;
    fd = open_pidfd_checked(identity, require_pid_one);
    if (fd < 0) return unknown_status;
    if (!pidfd_signal_checked(fd, SIGKILL) && errno != ESRCH) { close(fd); return unknown_status; }
    deadline = monotonic_milliseconds() + UINT64_C(30000);
    if (!pidfd_exited_until(fd, deadline)) { close(fd); return STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD; }
    close(fd);
    return STATUS_SUCCESS;
}

static broker_status recover_record_processes(journal_record *record)
{
    int rank = journal_state_rank(record->state);
    broker_status status;
    uint64_t device, inode;
    int present;
    if (rank < 5 || rank >= 10) return STATUS_SUCCESS;
    if (!record->monitor.bound) return rank == 5 ? STATUS_SUCCESS : STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD;
    if (rank == 5) return recover_identity_process(&record->monitor, 0, STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD);
    if (!record->init.bound) return STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD;
    if (rank == 9) {
        if (!parse_u64_decimal(record->init.namespace_device, &device) || !parse_u64_decimal(record->init.namespace_inode, &inode)) return STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD;
        present = pid_namespace_processes_present(device, inode);
        if (present != 0) return STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD;
        return recover_identity_process(&record->monitor, 0, STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD);
    }
    status = recover_identity_process(&record->init, 1, STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD);
    if (status != STATUS_SUCCESS) return status;
    if (!parse_u64_decimal(record->init.namespace_device, &device) || !parse_u64_decimal(record->init.namespace_inode, &inode)) return STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD;
    present = pid_namespace_processes_present(device, inode);
    if (present != 0) return STATUS_RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD;
    status = recover_identity_process(&record->monitor, 0, STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD);
    return status;
}

static int bind_unbound_staging_leaf(int root_fd, int journal_fd, journal_record *record)
{
    struct stat metadata;
    acl_entry_value entries[16];
    size_t entry_count = 0U;
    int fd;
    if (fstatat(root_fd, record->basename, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno != ENOENT) return 0;
        record->leaf_bound = 0;
        (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "ABSENT");
        return 1;
    }
    if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U || (metadata.st_mode & 07777U) != 0700U) return 0;
    fd = openat(root_fd, record->basename, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0U || metadata.st_gid != 0U ||
        (metadata.st_mode & 07777U) != 0700U || read_acl(fd, "system.posix_acl_access", entries, ARRAY_LENGTH(entries), &entry_count) != 0 ||
        !acl_default_is_absent(fd) || !allocation_directory_empty(fd)) { close(fd); return 0; }
    record->leaf_bound = 1;
    (void)snprintf(record->leaf_device, sizeof(record->leaf_device), "%" PRIu64, (uint64_t)metadata.st_dev);
    (void)snprintf(record->leaf_inode, sizeof(record->leaf_inode), "%" PRIu64, (uint64_t)metadata.st_ino);
    record->leaf_owner_uid = 0U; record->leaf_owner_gid = 0U; record->leaf_mode = 0700U;
    (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "STAGING");
    close(fd);
    return journal_checkpoint_write(journal_fd, record);
}

static int reconcile_staging_leaf(int root_fd, int journal_fd, const deployed_policy *policy, journal_record *record)
{
    struct stat metadata;
    acl_entry_value access_entries[16];
    size_t access_count = 0U;
    uint64_t device, inode;
    int fd;
    if (strcmp(record->leaf_state, "STAGING") != 0 || !record->leaf_bound ||
        !parse_u64_decimal(record->leaf_device, &device) || !parse_u64_decimal(record->leaf_inode, &inode)) return 1;
    fd = openat(root_fd, record->basename, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || (uint64_t)metadata.st_dev != device || (uint64_t)metadata.st_ino != inode ||
        metadata.st_uid != 0U || metadata.st_gid != 0U) { close(fd); return 0; }
    if ((metadata.st_mode & 07777U) == 0700U && read_acl(fd, "system.posix_acl_access", access_entries, ARRAY_LENGTH(access_entries), &access_count) == 0 && acl_default_is_absent(fd)) {
        close(fd);
        return 1;
    }
    if ((metadata.st_mode & 07777U) == 0770U && allocation_directory_acl_valid(fd, policy->host_uid, 1)) {
        record->leaf_mode = 0770U;
        (void)snprintf(record->leaf_state, sizeof(record->leaf_state), "BOUND");
        close(fd);
        return journal_checkpoint_write(journal_fd, record);
    }
    close(fd);
    return 0;
}

static broker_status recover_record(int journal_fd, int root_fd, const deployed_policy *policy, uint64_t root_mount, const char boot_id[37], journal_record *record)
{
    int rank = journal_state_rank(record->state);
    broker_status status;
    if (strcmp(record->root_boot_id, boot_id) != 0) return STATUS_RECOVERY_IDENTITY_UNKNOWN_HOLD;
    if (strcmp(record->policy_identity, policy->policy_sha256) != 0 || strcmp(record->config_identity, policy->config_sha256) != 0 ||
        !journal_root_binding_valid(record, policy, root_fd, root_mount, boot_id)) return STATUS_JOURNAL_INVALID;
    if (rank == 12) return STATUS_SUCCESS;
    status = recover_record_processes(record);
    if (status != STATUS_SUCCESS) return status;
    if (record->cleanup_attempt_count >= MAX_RECOVERY_ATTEMPTS) return STATUS_RECOVERY_RETRY_LIMIT_HOLD;
    record->cleanup_attempt_count++;
    (void)snprintf(record->cleanup_state, sizeof(record->cleanup_state), "IN_PROGRESS");
    if (!journal_transition_write(journal_fd, record, "CLEANING")) return STATUS_JOURNAL_INVALID;
    if (!record->leaf_bound && strcmp(record->leaf_state, "UNBOUND") == 0 && !bind_unbound_staging_leaf(root_fd, journal_fd, record)) {
        journal_set_failure(record, "CLEANUP", "CLEANUP", "CLEANUP_IDENTITY_CHANGED");
        (void)journal_checkpoint_write(journal_fd, record);
        return STATUS_CLEANUP_HOLD;
    }
    if (record->leaf_bound && !reconcile_staging_leaf(root_fd, journal_fd, policy, record)) {
        journal_set_failure(record, "CLEANUP", "CLEANUP", "CLEANUP_IDENTITY_CHANGED");
        (void)journal_checkpoint_write(journal_fd, record);
        return STATUS_CLEANUP_HOLD;
    }
    if (record->leaf_bound && !remove_allocation_leaf(root_fd, root_mount, policy, record)) {
        journal_set_failure(record, "CLEANUP", "CLEANUP", "CLEANUP_IO_FAILED");
        (void)snprintf(record->cleanup_state, sizeof(record->cleanup_state), "HOLD");
        (void)journal_checkpoint_write(journal_fd, record);
        return STATUS_CLEANUP_HOLD;
    }
    (void)snprintf(record->cleanup_state, sizeof(record->cleanup_state), "ABSENT");
    if (!journal_transition_write(journal_fd, record, "ABSENT")) return STATUS_CLEANUP_HOLD;
    return STATUS_SUCCESS;
}

static broker_status recover_journal_all(int journal_fd, int root_fd, const deployed_policy *policy, uint64_t root_mount)
{
    char boot_id[37];
    int scan_fd;
    DIR *directory;
    struct dirent *entry;
    size_t entries = 0U;
    struct stat metadata;
    if (!current_boot_id(boot_id)) return STATUS_ROOT_OR_DEPLOYMENT_INVALID;
    scan_fd = fcntl(journal_fd, F_DUPFD_CLOEXEC, 3);
    if (scan_fd < 0) return STATUS_JOURNAL_INVALID;
    directory = fdopendir(scan_fd);
    if (!directory) { close(scan_fd); return STATUS_JOURNAL_INVALID; }
    for (;;) {
        size_t length;
        journal_record record;
        broker_status status;
        errno = 0;
        entry = readdir(directory);
        if (!entry) {
            int read_error = errno;
            closedir(directory);
            return read_error == 0 ? STATUS_SUCCESS : STATUS_JOURNAL_INVALID;
        }
        length = strlen(entry->d_name);
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0 || strcmp(entry->d_name, JOURNAL_LOCK) == 0) continue;
        if (++entries > MAX_CLEANUP_ENTRIES) { closedir(directory); return STATUS_JOURNAL_INVALID; }
        if (strcmp(entry->d_name, ".next") == 0) {
            if (fstatat(journal_fd, ".next", &metadata, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != 0U ||
                metadata.st_gid != 0U || (metadata.st_mode & 07777U) != 0600U || metadata.st_nlink != 1U || unlinkat(journal_fd, ".next", 0) != 0 || fsync(journal_fd) != 0) {
                closedir(directory); return STATUS_JOURNAL_INVALID;
            }
            continue;
        }
        if (length != 37U || memcmp(entry->d_name + 32U, ".json", 5U) != 0) { closedir(directory); return STATUS_JOURNAL_INVALID; }
        {
            char allocation[33];
            memcpy(allocation, entry->d_name, 32U); allocation[32] = '\0';
            if (!valid_allocation_id(allocation) || !journal_record_read(journal_fd, entry->d_name, &record) || strcmp(record.allocation_id, allocation) != 0) {
                closedir(directory); return STATUS_JOURNAL_INVALID;
            }
        }
        status = recover_record(journal_fd, root_fd, policy, root_mount, boot_id, &record);
        if (status != STATUS_SUCCESS) { closedir(directory); return status; }
    }
}

static int read_generated_file(int leaf_fd, const deployed_policy *policy, const journal_record *record, const char *name, size_t maximum,
    unsigned char **output, size_t *output_length)
{
    struct stat metadata, after;
    uint64_t expected_device, expected_mount, mount_id, now, deadline;
    size_t length = 0U;
    unsigned char *bytes;
    unsigned char extra;
    int fd;
    now = monotonic_milliseconds();
    if (now == 0U || now > UINT64_MAX - UINT64_C(30000)) return 0;
    deadline = now + UINT64_C(30000);
    if (!parse_u64_decimal(record->leaf_device, &expected_device) || !parse_u64_decimal(record->root_mount_identity, &expected_mount)) return 0;
    fd = openat(leaf_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (fstat(fd, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1U || metadata.st_size < 0 ||
        (uint64_t)metadata.st_size > maximum || (uint64_t)metadata.st_dev != expected_device ||
        (metadata.st_uid != 0U && metadata.st_uid != policy->host_uid) || (metadata.st_gid != 0U && metadata.st_gid != policy->host_gid) ||
        (metadata.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) != 0U || !statx_mount_id(fd, &mount_id) || mount_id != expected_mount) {
        close(fd);
        return 0;
    }
    length = (size_t)metadata.st_size;
    bytes = (unsigned char *)malloc(length == 0U ? 1U : length);
    if (!bytes) { close(fd); return 0; }
    {
        size_t offset = 0U;
        ssize_t count;
        while (offset < length) {
            if ((now = monotonic_milliseconds()) == 0U || now >= deadline) { free(bytes); close(fd); return 0; }
            count = read(fd, bytes + offset, length - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) { free(bytes); close(fd); return 0; }
            offset += (size_t)count;
        }
        do { count = read(fd, &extra, 1U); } while (count < 0 && errno == EINTR);
        if (count != 0 || (now = monotonic_milliseconds()) == 0U || now >= deadline) { free(bytes); close(fd); return 0; }
    }
    if (fstat(fd, &after) != 0 || metadata.st_dev != after.st_dev || metadata.st_ino != after.st_ino || metadata.st_size != after.st_size ||
        metadata.st_mtim.tv_sec != after.st_mtim.tv_sec || metadata.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
        metadata.st_ctim.tv_sec != after.st_ctim.tv_sec || metadata.st_ctim.tv_nsec != after.st_ctim.tv_nsec) { free(bytes); close(fd); return 0; }
    close(fd);
    *output = bytes;
    *output_length = length;
    return 1;
}

static int serialize_success_metadata(byte_builder *metadata, const broker_request *request, const sandbox_run_result *result)
{
    size_t index;
    const char *operation = request->operation == OP_WRITER ? "WRITER" : "VALIDATOR";
    memset(metadata, 0, sizeof(*metadata));
    if (!append_text(metadata, "{\"schemaVersion\":\"s8-sandbox-broker-metadata-v1\",\"operation\":") ||
        !append_json_string(metadata, operation) || !append_text(metadata, ",\"sandboxArgv\":[")) return 0;
    for (index = 0U; index < result->sandbox_argc; index++) {
        if (index != 0U && !append_text(metadata, ",")) return 0;
        if (!append_json_string(metadata, result->sandbox_argv[index])) return 0;
    }
    return append_text(metadata, "],\"targetUid\":65534,\"targetGid\":65534,\"targetEnvironmentKeys\":[\"PWD\"],\"pidnsInitRegisteredBeforeRelease\":true,\"pidfdTermination\":\"PASS\",\"cleanupState\":\"ABSENT\"}") &&
        !metadata->failed && metadata->length <= METADATA_MAX_BYTES;
}

static int serialize_failure_metadata(byte_builder *metadata, broker_operation operation)
{
    memset(metadata, 0, sizeof(*metadata));
    if (!append_text(metadata, "{\"schemaVersion\":\"s8-sandbox-broker-metadata-v1\",\"operation\":") ||
        !append_json_string(metadata, operation == OP_WRITER ? "WRITER" : operation == OP_VALIDATOR ? "VALIDATOR" : "RECOVER") ||
        !append_text(metadata, ",\"sandboxArgv\":[],\"targetUid\":65534,\"targetGid\":65534,\"targetEnvironmentKeys\":[\"PWD\"],\"pidnsInitRegisteredBeforeRelease\":false,\"pidfdTermination\":\"UNKNOWN\",\"cleanupState\":\"HOLD\"}")) return 0;
    return !metadata->failed && metadata->length <= METADATA_MAX_BYTES;
}

static int response_set_allocation_id(broker_response *response, const char *allocation_id)
{
    size_t index;
    if (!valid_allocation_id(allocation_id)) return 0;
    for (index = 0U; index < 16U; index++) {
        int high = lower_hex_nibble((unsigned char)allocation_id[index * 2U]);
        int low = lower_hex_nibble((unsigned char)allocation_id[index * 2U + 1U]);
        if (high < 0 || low < 0) return 0;
        response->allocation_id[index] = (unsigned char)((high << 4) | low);
    }
    return 1;
}

static void response_initialize(broker_response *response, broker_operation operation, const unsigned char request_id[16])
{
    memset(response, 0, sizeof(*response));
    response->operation = operation;
    response->status = STATUS_PROTOCOL_INVALID;
    response->native_outer_exit = -1;
    response->native_outer_signal = -1;
    if (request_id) memcpy(response->request_id, request_id, sizeof(response->request_id));
}

static void response_bind_policy(broker_response *response, const deployed_policy *policy)
{
    (void)hex_decode_32(policy->policy_sha256, response->policy_sha256);
    (void)hex_decode_32(policy->config_sha256, response->config_sha256);
}

static int output_name_absent(int leaf_fd, const char *name)
{
    struct stat metadata;
    if (fstatat(leaf_fd, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0) return 0;
    return errno == ENOENT;
}

static int pidfd_preflight(void)
{
    int fd = (int)syscall(SYS_pidfd_open, getpid(), 0U);
    if (fd < 0) return 0;
    if (syscall(SYS_pidfd_send_signal, fd, 0, NULL, 0U) != 0) { close(fd); return 0; }
    close(fd);
    return 1;
}

#ifdef S8_BROKER_CONTRACT_TEST
static int journal_roundtrip_self_test(void)
{
    journal_record record, parsed;
    byte_builder encoded = {{0U}, 0U, 0};
    unsigned char empty_digest[32];
    unsigned char original;
    memset(&record, 0, sizeof(record));
    (void)snprintf(record.allocation_id, sizeof(record.allocation_id), "0123456789abcdef0123456789abcdef");
    (void)snprintf(record.operation, sizeof(record.operation), "WRITER");
    memset(record.policy_identity, '0', 64U); record.policy_identity[64] = '\0';
    memset(record.config_identity, '1', 64U); record.config_identity[64] = '\0';
    (void)snprintf(record.root_device, sizeof(record.root_device), "1");
    (void)snprintf(record.root_inode, sizeof(record.root_inode), "2");
    (void)snprintf(record.root_boot_id, sizeof(record.root_boot_id), "01234567-89ab-cdef-0123-456789abcdef");
    (void)snprintf(record.root_mount_identity, sizeof(record.root_mount_identity), "3");
    (void)snprintf(record.basename, sizeof(record.basename), "s8-0123456789abcdef0123456789abcdef");
    (void)snprintf(record.leaf_state, sizeof(record.leaf_state), "UNBOUND");
    (void)snprintf(record.seed_name, sizeof(record.seed_name), "input.json");
    sha256_bytes((const unsigned char *)"", 0U, empty_digest);
    hex_encode(empty_digest, sizeof(empty_digest), record.seed_sha256);
    (void)snprintf(record.launch_state, sizeof(record.launch_state), "NOT_STARTED");
    (void)snprintf(record.cleanup_state, sizeof(record.cleanup_state), "NOT_STARTED");
    (void)snprintf(record.state, sizeof(record.state), "PRE_JOURNALED");
    if (!journal_checksum(&record) || !serialize_journal(&record, 1, &encoded) || !parse_journal_bytes(encoded.bytes, encoded.length, &parsed)) return 0;
    if (encoded.length < 5U || encoded.bytes[encoded.length - 4U] == 'x') return 0;
    original = encoded.bytes[encoded.length - 4U];
    encoded.bytes[encoded.length - 4U] = encoded.bytes[encoded.length - 4U] == '0' ? '1' : '0';
    if (parse_journal_bytes(encoded.bytes, encoded.length, &parsed)) return 0;
    encoded.bytes[encoded.length - 4U] = original;
    encoded.bytes[encoded.length - 1U] = 'x';
    if (parse_journal_bytes(encoded.bytes, encoded.length, &parsed)) return 0;
    encoded.bytes[encoded.length - 1U] = '\n';
    encoded.bytes[encoded.length - 2U] = 'x';
    return !parse_journal_bytes(encoded.bytes, encoded.length, &parsed);
}

static int pidfd_lifecycle_self_test(void)
{
    struct timespec child_delay = { 2, 0 };
    journal_process_identity identity;
    pid_t child = fork();
    int pidfd = -1, wait_status = 0, signal_sent = 0, exited = 0;
    uint64_t now, deadline;
    pid_t waited;
    if (child < 0) return 0;
    if (child == 0) {
        while (nanosleep(&child_delay, &child_delay) != 0 && errno == EINTR) { }
        _exit(0);
    }
    if (process_namespace_identity(child, &identity, 0)) pidfd = open_pidfd_checked(&identity, 0);
    if (pidfd >= 0 && pidfd_signal_checked(pidfd, SIGKILL)) {
        signal_sent = 1;
        now = monotonic_milliseconds();
        if (now != 0U && now <= UINT64_MAX - UINT64_C(3000)) {
            deadline = now + UINT64_C(3000);
            exited = pidfd_exited_until(pidfd, deadline);
        }
    }
    if (pidfd >= 0) close(pidfd);
    do { waited = waitpid(child, &wait_status, 0); } while (waited < 0 && errno == EINTR);
    return signal_sent && exited && waited == child && WIFSIGNALED(wait_status) && WTERMSIG(wait_status) == SIGKILL;
}

static int cleanup_budget_for_test(int root_fd, cleanup_budget *budget, uint64_t *root_mount)
{
    struct stat metadata;
    uint64_t now;
    memset(budget, 0, sizeof(*budget));
    if (fstat(root_fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || !statx_mount_id(root_fd, root_mount)) return 0;
    now = monotonic_milliseconds();
    if (now == 0U || now > UINT64_MAX - UINT64_C(5000)) return 0;
    budget->root_device = (uint64_t)metadata.st_dev;
    budget->root_mount = *root_mount;
    budget->deadline = now + UINT64_C(5000);
    budget->open_fds = 1U;
    budget->host_uid = (uint32_t)metadata.st_uid;
    budget->host_gid = (uint32_t)metadata.st_gid;
    return 1;
}

static int cleanup_contract_self_test(void)
{
    char root_path[] = "/tmp/s8-broker-contract-XXXXXX";
    int root_fd = -1, nested_fd = -1, file_fd = -1, ok = 0;
    uint64_t root_mount = 0U;
    struct stat metadata;
    cleanup_budget budget;
    journal_record record;
    deployed_policy policy;
    unsigned char payload = 0x5aU;
    if (!mkdtemp(root_path)) return 0;
    root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root_fd < 0 || !cleanup_budget_for_test(root_fd, &budget, &root_mount)) goto done;
    file_fd = openat(root_fd, "hard-a", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (file_fd < 0 || !write_all_fd(file_fd, &payload, sizeof(payload))) goto done;
    close(file_fd); file_fd = -1;
    if (linkat(root_fd, "hard-a", root_fd, "hard-b", 0) != 0 ||
        cleanup_directory_contents(root_fd, 0U, &budget) ||
        fstatat(root_fd, "hard-a", &metadata, AT_SYMLINK_NOFOLLOW) != 0 || metadata.st_nlink != 2U ||
        fstatat(root_fd, "hard-b", &metadata, AT_SYMLINK_NOFOLLOW) != 0 || metadata.st_nlink != 2U) goto done;
    if (unlinkat(root_fd, "hard-a", 0) != 0 || unlinkat(root_fd, "hard-b", 0) != 0 ||
        symlinkat("missing", root_fd, "link") != 0 || !cleanup_budget_for_test(root_fd, &budget, &root_mount) ||
        cleanup_directory_contents(root_fd, 0U, &budget) ||
        fstatat(root_fd, "link", &metadata, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISLNK(metadata.st_mode) || unlinkat(root_fd, "link", 0) != 0) goto done;
    if (mkdirat(root_fd, "nested", 0700) != 0) goto done;
    nested_fd = openat(root_fd, "nested", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (nested_fd < 0) goto done;
    file_fd = openat(nested_fd, "payload", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (file_fd < 0 || !write_all_fd(file_fd, &payload, sizeof(payload))) goto done;
    close(file_fd); file_fd = -1;
    close(nested_fd); nested_fd = -1;
    if (!cleanup_budget_for_test(root_fd, &budget, &root_mount) || !cleanup_directory_contents(root_fd, 0U, &budget) || !allocation_directory_empty(root_fd)) goto done;

    memset(&record, 0, sizeof(record));
    memset(&policy, 0, sizeof(policy));
    (void)snprintf(record.basename, sizeof(record.basename), "s8-0123456789abcdef0123456789abcdef");
    (void)snprintf(record.leaf_state, sizeof(record.leaf_state), "BOUND");
    record.leaf_bound = 1;
    policy.host_uid = (uint32_t)metadata.st_uid;
    policy.host_gid = (uint32_t)metadata.st_gid;
    if (!remove_allocation_leaf(root_fd, root_mount, &policy, &record) || record.leaf_bound || strcmp(record.leaf_state, "ABSENT") != 0) goto done;
    (void)snprintf(record.state, sizeof(record.state), "LAUNCH_INTENT");
    if (recover_record_processes(&record) != STATUS_SUCCESS) goto done;
    (void)snprintf(record.state, sizeof(record.state), "PIDNS_INIT_REGISTERED");
    if (recover_record_processes(&record) != STATUS_RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD) goto done;
    record.monitor.bound = 1;
    if (recover_record_processes(&record) != STATUS_RECOVERY_PIDNS_INIT_IDENTITY_HOLD) goto done;
    ok = 1;
done:
    if (file_fd >= 0) close(file_fd);
    if (nested_fd >= 0) close(nested_fd);
    if (root_fd >= 0) {
        nested_fd = openat(root_fd, "nested", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (nested_fd >= 0) { (void)unlinkat(nested_fd, "payload", 0); close(nested_fd); }
        (void)unlinkat(root_fd, "nested", AT_REMOVEDIR);
        (void)unlinkat(root_fd, "hard-a", 0);
        (void)unlinkat(root_fd, "hard-b", 0);
        (void)unlinkat(root_fd, "link", 0);
        close(root_fd);
    }
    if (rmdir(root_path) != 0) ok = 0;
    return ok;
}

static int contract_self_test(void)
{
    unsigned char header[REQUEST_HEADER_BYTES] = { 0 };
    broker_request request;
    bwrap_initial_status initial;
    int32_t exit_code;
    static const unsigned char initial_json[] = "{ \"child-pid\": 44, \"ipc-namespace\": 1, \"mnt-namespace\": 2, \"net-namespace\": 3, \"pid-namespace\": 4, \"uts-namespace\": 5 }";
    static const unsigned char exit_json[] = "{\"exit-code\":0}";
    static const unsigned char duplicate_json[] = "{\"child-pid\":1,\"child-pid\":2,\"ipc-namespace\":1,\"mnt-namespace\":2,\"net-namespace\":3,\"pid-namespace\":4,\"uts-namespace\":5}";
    memcpy(header, "S8BRQ001", 8U); write_u16_be(header + 8U, 1U); header[10] = (unsigned char)OP_WRITER;
    if (!policy_identity_self_test()) return 2;
    if (!policy_request_binding_self_test()) return 3;
    if (!journal_roundtrip_self_test()) return 4;
    if (!parse_request_header(header, &request)) return 5;
    if (!pidfd_lifecycle_self_test()) return 6;
    if (!cleanup_contract_self_test()) return 7;
    if (!parse_bwrap_initial_status(initial_json, sizeof(initial_json) - 1U, &initial)) return 6;
    if (initial.child_pid != 44U || initial.pid_namespace != 4U) return 8;
    if (!parse_bwrap_terminal_status(exit_json, sizeof(exit_json) - 1U, &exit_code)) return 9;
    if (exit_code != 0) return 10;
    if (parse_bwrap_initial_status(duplicate_json, sizeof(duplicate_json) - 1U, &initial)) return 11;
    return 0;
}
#endif

static int broker_recover_main(void)
{
    deployed_policy policy;
    broker_status failure = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
    uint64_t root_mount;
    int root_fd = -1, journal_fd = -1, lock_fd = -1;
    broker_status status;
    if (geteuid() != 0U || getuid() != 0U || getegid() != 0U) return STATUS_CALLER_OR_POLICY_INVALID;
    if (!protected_policy_load(&policy, &failure)) return failure;
    if (!deployment_identity_valid(&policy) || !private_root_open_and_validate(&policy, &root_fd, &root_mount) || !journal_directory_open(root_fd, 1, &journal_fd)) {
        if (root_fd >= 0) close(root_fd);
        if (journal_fd >= 0) close(journal_fd);
        return STATUS_ROOT_OR_DEPLOYMENT_INVALID;
    }
    if (!journal_lock_open(journal_fd, &lock_fd)) {
        status = (errno == EWOULDBLOCK || errno == EAGAIN) ? STATUS_BUSY : STATUS_JOURNAL_INVALID;
        close(journal_fd); close(root_fd);
        return status;
    }
    status = recover_journal_all(journal_fd, root_fd, &policy, root_mount);
    close(lock_fd); close(journal_fd); close(root_fd);
    return status;
}

static int broker_stdio_main(void)
{
    unsigned char header[REQUEST_HEADER_BYTES];
    unsigned char *payload = NULL;
    broker_request request;
    broker_response response;
    deployed_policy policy;
    broker_status policy_failure = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
    byte_builder metadata = {{0U}, 0U, 0};
    sandbox_run_result run_result;
    journal_record record;
    int root_fd = -1, journal_fd = -1, lock_fd = -1, leaf_fd = -1;
    int have_record = 0, outer_wait_status = 0;
    uint64_t root_mount = 0U;
    unsigned char runner_before[32], runner_after[32];
    int runner_before_valid = file_sha256_digest(RUNNER_PATH, runner_before);
    broker_status status = STATUS_PROTOCOL_INVALID;
    int read_result, write_result;
    uint64_t header_deadline, now;
    memset(&request, 0, sizeof(request));
    memset(&record, 0, sizeof(record));
    memset(&run_result, 0, sizeof(run_result));
    response_initialize(&response, OP_WRITER, NULL);
    (void)signal(SIGPIPE, SIG_IGN);
    if (runner_before_valid) memcpy(response.runner_pre_sha256, runner_before, sizeof(runner_before));
    now = monotonic_milliseconds();
    if (now == 0U || now > UINT64_MAX - UINT64_C(30000)) { status = STATUS_BROKER_INTERNAL; goto respond; }
    header_deadline = now + UINT64_C(30000);
    read_result = read_full_until(STDIN_FILENO, header, sizeof(header), header_deadline);
    if (read_result != 1) {
        if (read_result == 0 && monotonic_milliseconds() >= header_deadline) status = STATUS_OPERATION_TIMEOUT;
        else status = read_result < 0 ? STATUS_BROKER_INTERNAL : STATUS_PROTOCOL_INVALID;
        goto respond;
    }
    if (read_result == 1) {
        if (header[10] >= OP_WRITER && header[10] <= OP_RECOVER) response.operation = (broker_operation)header[10];
        memcpy(response.request_id, header + 12U, sizeof(response.request_id));
        if (!parse_request_header(header, &request)) goto respond;
        response_initialize(&response, request.operation, request.request_id);
        if (geteuid() != 0U) { status = STATUS_CALLER_OR_POLICY_INVALID; goto respond; }
        if (!protected_policy_load(&policy, &policy_failure)) { status = policy_failure; goto respond; }
        response_bind_policy(&response, &policy);
        if (runner_before_valid) memcpy(response.runner_pre_sha256, runner_before, sizeof(runner_before));
        if (getuid() != (uid_t)policy.host_uid || getgid() != (gid_t)policy.host_gid || !request_identity_matches(&request, &policy)) {
            status = STATUS_CALLER_OR_POLICY_INVALID;
            goto respond;
        }
        if ((request.operation == OP_RECOVER && request.payload_length != 0U) ||
            (request.operation != OP_RECOVER && request.payload_length == 0U)) { status = STATUS_PROTOCOL_INVALID; goto respond; }
        read_result = read_request_payload(STDIN_FILENO, &request, &payload);
        if (read_result != 1) {
            status = read_result == 2 ? STATUS_OPERATION_TIMEOUT : read_result < 0 ? STATUS_BROKER_INTERNAL : STATUS_PROTOCOL_INVALID;
            goto respond;
        }
        if (!deployment_identity_valid(&policy) || !private_root_open_and_validate(&policy, &root_fd, &root_mount)) {
            status = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
            goto respond;
        }
        if (!journal_directory_open(root_fd, 1, &journal_fd)) { status = STATUS_JOURNAL_INVALID; goto respond; }
        if (!journal_lock_open(journal_fd, &lock_fd)) {
            status = (errno == EWOULDBLOCK || errno == EAGAIN) ? STATUS_BUSY : STATUS_JOURNAL_INVALID;
            goto respond;
        }
        status = recover_journal_all(journal_fd, root_fd, &policy, root_mount);
        if (status != STATUS_SUCCESS || request.operation == OP_RECOVER) goto respond;
        if (!pidfd_preflight()) { status = STATUS_LAUNCH_OR_STATUS_INVALID; goto respond; }
        if (!journal_record_initialize(&record, &policy, request.operation, root_fd, root_mount)) { status = STATUS_BROKER_INTERNAL; goto respond; }
        have_record = 1;
        response_set_allocation_id(&response, record.allocation_id);
        if (!allocation_leaf_create(root_fd, journal_fd, &policy, &record, &leaf_fd)) { status = STATUS_ALLOCATION_OR_INPUT_ADMISSION_FAILED; goto clean_record; }
        if (!write_seed_file(leaf_fd, &policy, payload, (size_t)request.payload_length, record.seed_name, &record) ||
            !journal_transition_write(journal_fd, &record, "INPUT_CREATED_PRE")) { status = STATUS_ALLOCATION_OR_INPUT_ADMISSION_FAILED; goto clean_record; }
        if (!seed_post_admit(leaf_fd, &policy, &record) || !journal_transition_write(journal_fd, &record, "INPUT_POST_ADMITTED")) { status = STATUS_ALLOCATION_OR_INPUT_ADMISSION_FAILED; goto clean_record; }
        if ((request.operation == OP_WRITER && (!output_name_absent(leaf_fd, "artifact.fbx") || !output_name_absent(leaf_fd, "writer-receipt.json"))) ||
            !journal_transition_write(journal_fd, &record, "LAUNCH_INTENT")) { status = STATUS_ALLOCATION_OR_INPUT_ADMISSION_FAILED; goto clean_record; }
        (void)snprintf(record.launch_state, sizeof(record.launch_state), "LAUNCH_INTENT");
        status = run_sandbox(&policy, &request, journal_fd, &record, &run_result, &outer_wait_status);
        if (WIFEXITED(outer_wait_status)) response.native_outer_exit = WEXITSTATUS(outer_wait_status);
        else if (WIFSIGNALED(outer_wait_status)) response.native_outer_signal = WTERMSIG(outer_wait_status);
        response.sections[2] = run_result.native_stdout.bytes;
        response.section_lengths[2] = run_result.native_stdout.length;
        response.sections[3] = run_result.native_stderr.bytes;
        response.section_lengths[3] = run_result.native_stderr.length;
        if (status != STATUS_SUCCESS) goto clean_record;
        if (request.operation == OP_WRITER) {
            size_t artifact_length = 0U, receipt_length = 0U;
            unsigned char *artifact = NULL, *receipt = NULL;
            if (!read_generated_file(leaf_fd, &policy, &record, "artifact.fbx", UINT64_C(134217728), &artifact, &artifact_length) ||
                artifact_length <= 27U || !read_generated_file(leaf_fd, &policy, &record, "writer-receipt.json", 65536U, &receipt, &receipt_length) || receipt_length == 0U) {
                free(artifact); free(receipt); status = STATUS_OUTPUT_OR_RECEIPT_INVALID; goto clean_record;
            }
            response.sections[0] = artifact; response.section_lengths[0] = artifact_length;
            response.sections[1] = receipt; response.section_lengths[1] = receipt_length;
        }
        if (!journal_transition_write(journal_fd, &record, "OUTPUT_READY")) { status = STATUS_JOURNAL_INVALID; goto clean_record; }
        status = STATUS_SUCCESS;
clean_record:
        if (leaf_fd >= 0) { close(leaf_fd); leaf_fd = -1; }
        if (have_record) {
            char boot_id[37];
            broker_status cleanup_status = current_boot_id(boot_id) ? recover_record(journal_fd, root_fd, &policy, root_mount, boot_id, &record) : STATUS_RECOVERY_IDENTITY_UNKNOWN_HOLD;
            if (cleanup_status != STATUS_SUCCESS) status = cleanup_status;
        }
    }
respond:
    if (runner_before_valid) {
        if (!file_sha256_digest(RUNNER_PATH, runner_after)) {
            status = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
        } else {
            memcpy(response.runner_post_sha256, runner_after, sizeof(runner_after));
            if (!constant_equal(runner_before, runner_after, sizeof(runner_before))) status = STATUS_ROOT_OR_DEPLOYMENT_INVALID;
        }
    }
    response.status = status;
    if (status == STATUS_SUCCESS && have_record && record.state[0] != '\0' && strcmp(record.cleanup_state, "ABSENT") == 0 && run_result.pidfd_termination_pass) {
        if (!serialize_success_metadata(&metadata, &request, &run_result)) status = STATUS_BROKER_INTERNAL;
    } else {
        (void)serialize_failure_metadata(&metadata, response.operation);
    }
    response.status = status;
    if (status != STATUS_SUCCESS) {
        if (response.section_lengths[0] != 0U) { free((void *)response.sections[0]); response.sections[0] = NULL; response.section_lengths[0] = 0U; }
        if (response.section_lengths[1] != 0U) { free((void *)response.sections[1]); response.sections[1] = NULL; response.section_lengths[1] = 0U; }
        (void)serialize_failure_metadata(&metadata, response.operation);
    }
    response.sections[4] = metadata.bytes;
    response.section_lengths[4] = metadata.length;
    write_result = write_broker_response(&response);
    free((void *)response.sections[0]);
    free((void *)response.sections[1]);
    free(run_result.native_stdout.bytes);
    free(run_result.native_stderr.bytes);
    free(payload);
    if (lock_fd >= 0) close(lock_fd);
    if (journal_fd >= 0) close(journal_fd);
    if (root_fd >= 0) close(root_fd);
    return write_result ? 0 : 1;
}

int main(int argc, char **argv)
{
#ifdef S8_BROKER_CONTRACT_TEST
    if (argc == 2 && strcmp(argv[1], "--contract-self-test") == 0) return contract_self_test() ? 0 : 1;
#endif
    if (argc != 2) return STATUS_PROTOCOL_INVALID;
    if (strcmp(argv[1], "--stdio-v1") == 0) return broker_stdio_main();
    if (strcmp(argv[1], "--recover-v1") == 0) return broker_recover_main();
    return STATUS_PROTOCOL_INVALID;
}
