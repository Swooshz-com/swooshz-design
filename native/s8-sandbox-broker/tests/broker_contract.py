#!/usr/bin/env python3
import hashlib
import json
import struct
import subprocess
import sys


contract, production = sys.argv[1:]


def invoke(args, payload=b""):
    return subprocess.run(
        [production, *args], input=payload, check=False, capture_output=True, timeout=5
    )


completed = subprocess.run(
    [contract, "--contract-self-test"], check=False, capture_output=True, timeout=5
)
if completed.returncode != 0 or completed.stdout or completed.stderr:
    raise SystemExit(f"BROKER_CONTRACT_SELF_TEST_FAILED:{completed.returncode}")

for args in [[], ["--recover-v1", "extra"], ["--stdio-v1", "extra"], ["--arbitrary-command"]]:
    result = invoke(args)
    if result.returncode != 64 or result.stdout or result.stderr:
        raise SystemExit(f"BROKER_ARGUMENT_ADMISSION_FAILED:{args!r}:{result.returncode}")


def assert_protocol_rejection(header, expected_operation, expected_request_id):
    result = invoke(["--stdio-v1"], header)
    if result.returncode != 0 or result.stderr:
        raise SystemExit(f"BROKER_MALFORMED_REQUEST_PROCESS_FAILED:{result.returncode}")
    response = result.stdout
    if len(response) < 320 or response[:8] != b"S8BRS001":
        raise SystemExit("BROKER_RESPONSE_HEADER_INVALID")
    if struct.unpack_from(">H", response, 8)[0] != 1:
        raise SystemExit("BROKER_RESPONSE_VERSION_INVALID")
    if response[10] != expected_operation or response[11] != 0:
        raise SystemExit("BROKER_RESPONSE_OPERATION_INVALID")
    if response[12:28] != expected_request_id:
        raise SystemExit("BROKER_RESPONSE_REQUEST_ID_INVALID")
    if struct.unpack_from(">H", response, 28)[0] != 64 or response[30:32] != b"\0\0":
        raise SystemExit("BROKER_PROTOCOL_STATUS_INVALID")
    lengths = struct.unpack_from(">5Q", response, 184)
    if sum(lengths) != len(response) - 320:
        raise SystemExit("BROKER_RESPONSE_LENGTH_INVALID")
    sections = []
    offset = 320
    for length in lengths:
        sections.append(response[offset : offset + length])
        offset += length
    if hashlib.sha256(b"".join(sections)).digest() != response[224:256]:
        raise SystemExit("BROKER_RESPONSE_SECTION_DIGEST_INVALID")
    if response[256:320] != bytes(64) or any(lengths[:4]) or not lengths[4]:
        raise SystemExit("BROKER_PROTOCOL_FAILURE_SECTIONS_INVALID")
    try:
        metadata = json.loads(sections[4])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("BROKER_FAILURE_METADATA_INVALID") from error
    operation_names = {1: "WRITER", 2: "VALIDATOR", 3: "RECOVER"}
    if metadata.get("schemaVersion") != "s8-sandbox-broker-metadata-v1":
        raise SystemExit("BROKER_FAILURE_METADATA_SCHEMA_INVALID")
    if metadata.get("operation") != operation_names[expected_operation]:
        raise SystemExit("BROKER_FAILURE_METADATA_OPERATION_INVALID")


bad_magic = bytearray(160)
bad_magic[10] = 2
bad_magic[12:28] = bytes(range(16))
assert_protocol_rejection(bytes(bad_magic), 2, bytes(range(16)))

reserved_byte = bytearray(160)
reserved_byte[:8] = b"S8BRQ001"
struct.pack_into(">H", reserved_byte, 8, 1)
reserved_byte[10] = 1
reserved_byte[11] = 1
reserved_byte[12:28] = b"broker-test-id-1"
assert_protocol_rejection(bytes(reserved_byte), 1, b"broker-test-id-1")

invalid_operation = bytearray(160)
invalid_operation[:8] = b"S8BRQ001"
struct.pack_into(">H", invalid_operation, 8, 1)
invalid_operation[10] = 4
invalid_operation[12:28] = b"broker-test-id-2"
assert_protocol_rejection(bytes(invalid_operation), 1, b"broker-test-id-2")

print("BROKER_CONTRACT_SELF_TEST=PASS")
print("BROKER_ARGUMENT_ADMISSION=PASS")
print("BROKER_MALFORMED_PROTOCOL_RESPONSES=PASS")
