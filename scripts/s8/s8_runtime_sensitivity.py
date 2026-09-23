#!/usr/bin/env python3
"""Run the pinned S8 writer, Blender reopen floor, and native validator in a staged carrier."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import NoReturn


UNIT_SCALE = 10_000_000_000
POSITION_SCALE = 1_000_000
RUNNER_TIMEOUT_MS = 300_000
RUNNER_STDOUT_BYTES = 1_048_576
RUNNER_STDERR_BYTES = 1_048_576


def fail(code: str, classification: str = "CANDIDATE_FAILURE") -> NoReturn:
    print(f"FAILURE_CLASS={classification}", file=sys.stderr)
    print(f"CANDIDATE_FAILURE_PROVEN={'NO' if classification == 'HOSTED_SANDBOX_ENVIRONMENT_HOLD' else 'YES'}", file=sys.stderr)
    print(f"S8_RUNTIME_SENSITIVITY_FAIL:{code}", file=sys.stderr)
    raise SystemExit(1)


def regular(path_value: str, label: str) -> pathlib.Path:
    original = pathlib.Path(path_value)
    path = original.resolve()
    if original.is_symlink() or not path.is_file():
        fail(f"{label}_PATH_INVALID", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    return path


def directory(path_value: str, label: str) -> pathlib.Path:
    original = pathlib.Path(path_value)
    path = original.resolve()
    if original.is_symlink() or not path.is_dir():
        fail(f"{label}_PATH_INVALID", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    return path


def carrier_mount(path: pathlib.Path, carrier_root: pathlib.Path, label: str) -> str:
    try:
        relative = path.relative_to(carrier_root)
    except ValueError:
        fail(f"{label}_OUTSIDE_CARRIER", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    return f"/carrier/{relative.as_posix()}"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sample_payload() -> dict[str, object]:
    object_id = "g3-runtime-object"
    object_name = f"SWZ_0000_{digest(object_id)[:16]}"
    identity = digest("g3-runtime-identity")
    source_hash = digest("g3-runtime-source")
    return {
        "schemaVersion": "swooshz-fbx-writer-input-v1",
        "profile": "swooshz-fbx-static-mesh-v1",
        "source": {
            "projectId": "g3-runtime-project",
            "revisionId": "g3-runtime-revision",
            "revisionHash": source_hash,
            "sourceS5Fingerprint": digest("g3-runtime-s5"),
            "s6ValidationReceiptId": "g3-runtime-s6-receipt",
            "s6ValidationHash": digest("g3-runtime-s6"),
            "s6HandoffDigest": digest("g3-runtime-s6-handoff"),
            "s7ArtifactId": "g3-runtime-s7-artifact",
            "s7ArtifactHash": digest("g3-runtime-s7"),
            "s7ReadbackHash": digest("g3-runtime-s7-readback"),
        },
        "scene": {
            "units": "millimetres",
            "upAxis": "+Z",
            "frontAxis": "-Y",
            "rightAxis": "+X",
            "rootName": "SWZ_ROOT",
        },
        "materials": [],
        "objects": [
            {
                "name": object_name,
                "objectId": object_id,
                "identityKey": identity,
                "parentName": "SWZ_ROOT",
                "sourceObjectId": object_id,
                "sourceParentObjectId": None,
                "localTranslationTicks": [0, 0, 0],
                "sourceEulerMicrodegrees": [0, 0, 0],
                "unitScaleTicks": [UNIT_SCALE, UNIT_SCALE, UNIT_SCALE],
                "nodeKind": "mesh",
                "matrixTicks": [
                    UNIT_SCALE, 0, 0, 0,
                    0, UNIT_SCALE, 0, 0,
                    0, 0, UNIT_SCALE, 0,
                    0, 0, 0, UNIT_SCALE,
                ],
                "transformDigest": digest(object_id),
                "verticesTicks": [[0, 0, 0], [POSITION_SCALE, 0, 0], [0, POSITION_SCALE, 0]],
                "triangles": [[0, 1, 2]],
                "cornerNormalsTicks": [[0, 0, UNIT_SCALE], [0, 0, UNIT_SCALE], [0, 0, UNIT_SCALE]],
                "materialName": None,
                "degradationCodes": [],
                "geometryState": "exact",
                "roundSegments": None,
                "analyticSagittaTicks": None,
            }
        ],
    }


RUNNER_RECEIPT_PREFIX = b"S8_RUNNER_RECEIPT:"
RUNNER_RECEIPT_MAX_PRELUDE_BYTES = 8192
RUNNER_RECEIPT_MAX_LINE_BYTES = 8192
SANDBOX_DIAGNOSTIC_MAX_BYTES = 32 * 1024
SANDBOX_DIAGNOSTIC_EXCERPT_SIDE_BYTES = 768

RUNNER_RESULTS = {
    0: ("S8_RUNNER_SUCCESS", "target-exit-zero"),
    70: ("S8_RUNNER_INTERNAL", "runner-internal"),
    71: ("S8_RUNNER_CHILD_SETUP_FAILED", "child-setup-failed"),
    72: ("S8_RUNNER_EVIDENCE_INVALID", "evidence-failed"),
    73: ("S8_RUNNER_EXEC_FAILED", "exec-failed"),
    74: ("S8_RUNNER_STDOUT_LIMIT", "stdout-limit"),
    75: ("S8_RUNNER_STDERR_LIMIT", "stderr-limit"),
    76: ("S8_RUNNER_TARGET_EXIT_NONZERO", "target-exit-nonzero"),
    77: ("S8_RUNNER_TARGET_SIGNAL", "target-signal"),
    124: ("S8_RUNNER_TIMEOUT", "wall-timeout"),
}

_RUNNER_SECRET_PATTERNS = (
    re.compile(rb"(?im)(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*"),
    re.compile(
        rb"(?i)(\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    ),
    re.compile(rb"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*"),
    re.compile(rb"(?i)(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])"),
)


class RunnerReceiptError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RunnerReceiptError("RUNNER_RECEIPT_DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> NoReturn:
    raise RunnerReceiptError("RUNNER_RECEIPT_NONSTANDARD_NUMBER")


def _require_field(
    parent: dict[str, object],
    key: str,
    expected_type: type,
    *,
    nullable: bool = False,
) -> object:
    if key not in parent:
        raise RunnerReceiptError("RUNNER_RECEIPT_FIELD_MISSING")
    value = parent[key]
    if nullable and value is None:
        return value
    if expected_type is int:
        valid = type(value) is int
    else:
        valid = isinstance(value, expected_type)
    if not valid:
        raise RunnerReceiptError("RUNNER_RECEIPT_FIELD_TYPE_INVALID")
    return value


def _parse_runner_receipt(output: bytes) -> tuple[dict[str, object], bytes, bytes]:
    marker_count = output.count(RUNNER_RECEIPT_PREFIX)
    if marker_count == 0:
        raise RunnerReceiptError("RUNNER_RECEIPT_MISSING")
    if marker_count != 1:
        raise RunnerReceiptError("RUNNER_RECEIPT_DUPLICATE_MARKER")

    marker_offset = output.find(RUNNER_RECEIPT_PREFIX)
    if marker_offset > 0 and output[marker_offset - 1] != 0x0A:
        raise RunnerReceiptError("RUNNER_RECEIPT_UNANCHORED_MARKER")
    line_end = output.find(b"\n", marker_offset)
    if line_end < 0:
        raise RunnerReceiptError("RUNNER_RECEIPT_INCOMPLETE_LINE")

    prelude = output[:marker_offset]
    if len(prelude) > RUNNER_RECEIPT_MAX_PRELUDE_BYTES:
        raise RunnerReceiptError("RUNNER_RECEIPT_OVERSIZED_PRELUDE")
    receipt_line = output[marker_offset:line_end]
    if len(receipt_line) > RUNNER_RECEIPT_MAX_LINE_BYTES:
        raise RunnerReceiptError("RUNNER_RECEIPT_OVERSIZED_LINE")

    try:
        payload_text = receipt_line[len(RUNNER_RECEIPT_PREFIX) :].decode("ascii", errors="strict")
    except UnicodeDecodeError as error:
        raise RunnerReceiptError("RUNNER_RECEIPT_NON_ASCII") from error
    try:
        receipt_value = json.loads(
            payload_text,
            object_pairs_hook=_reject_duplicate_json_keys,
            parse_constant=_reject_json_constant,
        )
    except RunnerReceiptError:
        raise
    except (json.JSONDecodeError, ValueError, RecursionError) as error:
        raise RunnerReceiptError("RUNNER_RECEIPT_MALFORMED_JSON") from error
    if not isinstance(receipt_value, dict):
        raise RunnerReceiptError("RUNNER_RECEIPT_ROOT_INVALID")

    for key, expected in (
        ("schemaVersion", "s8-process-runner-receipt-v2"),
        ("protocol", "s8-process-runner-receipt-v2"),
        ("policyId", "s8-zero-child-seccomp-x86_64-v2"),
    ):
        value = _require_field(receipt_value, key, str)
        if value != expected:
            raise RunnerReceiptError("RUNNER_RECEIPT_CONTRACT_MISMATCH")

    parent_verification = _require_field(receipt_value, "runnerParentVerification", dict)
    assert isinstance(parent_verification, dict)
    verification_status = _require_field(parent_verification, "status", str)
    if verification_status not in {"PASS", "FAIL"}:
        raise RunnerReceiptError("RUNNER_RECEIPT_PARENT_STATUS_INVALID")
    _require_field(parent_verification, "mismatchCode", str, nullable=True)

    result = _require_field(receipt_value, "result", dict)
    assert isinstance(result, dict)
    result_code = _require_field(result, "code", int)
    result_name = _require_field(result, "name", str)
    termination = _require_field(result, "terminationClass", str)
    target_exit = _require_field(result, "targetExit", int, nullable=True)
    target_signal = _require_field(result, "targetSignal", int, nullable=True)
    stdout_bytes = _require_field(result, "stdoutBytes", int)
    stderr_bytes = _require_field(result, "stderrBytes", int)
    _require_field(result, "elapsedMs", int)
    setup_stage = _require_field(result, "setupStage", str, nullable=True)
    evidence_code = _require_field(result, "evidenceCode", str, nullable=True)

    expected_result = RUNNER_RESULTS.get(result_code)
    if expected_result is None:
        raise RunnerReceiptError("RUNNER_RECEIPT_RESULT_CODE_UNKNOWN")
    if (result_name, termination) != expected_result:
        raise RunnerReceiptError("RUNNER_RECEIPT_RESULT_MAPPING_INVALID")
    if stdout_bytes < 0 or stderr_bytes < 0:
        raise RunnerReceiptError("RUNNER_RECEIPT_BYTE_COUNT_INVALID")

    if result_code == 76 and (type(target_exit) is not int or target_exit == 0):
        raise RunnerReceiptError("RUNNER_RECEIPT_TARGET_EXIT_INVALID")
    if result_code == 77 and type(target_signal) is not int:
        raise RunnerReceiptError("RUNNER_RECEIPT_TARGET_SIGNAL_INVALID")
    if result_code == 71 and not isinstance(setup_stage, str):
        raise RunnerReceiptError("RUNNER_RECEIPT_SETUP_STAGE_MISSING")
    if result_code == 72 and not isinstance(evidence_code, str):
        raise RunnerReceiptError("RUNNER_RECEIPT_EVIDENCE_CODE_MISSING")

    target_stdout = output[line_end + 1 :]
    return receipt_value, receipt_line + b"\n", target_stdout


def _byte_output(value: object) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8", errors="replace")
    return b""


def _redact_diagnostic_bytes(value: bytes) -> bytes:
    for pattern in _RUNNER_SECRET_PATTERNS:
        value = pattern.sub(lambda match: match.group(1) + b"[REDACTED]" if match.lastindex else b"[REDACTED]", value)
    return value


def _safe_excerpt(value: bytes | None) -> dict[str, object] | None:
    if value is None:
        return None
    head_limit = SANDBOX_DIAGNOSTIC_EXCERPT_SIDE_BYTES
    selected_length = min(len(value), head_limit * 2)
    sanitized = _redact_diagnostic_bytes(value)
    if len(value) <= head_limit * 2:
        selected = sanitized
        omitted_bytes = 0
    else:
        omitted_bytes = len(value) - head_limit * 2
        selected = sanitized[:head_limit] + b"\n<OMITTED>\n" + sanitized[-head_limit:]
    return {
        "data": selected.decode("latin-1"),
        "omittedBytes": omitted_bytes,
        "selectedBytes": selected_length,
    }


def _diagnostic_value(value: object) -> str:
    if value is None:
        return "null"
    if type(value) is int:
        return str(value)
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        return value
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def _emit_sandbox_diagnostic(
    phase: str,
    outer_return_code: int | None,
    outer_stdout: bytes,
    outer_stderr: bytes,
    terminal_reason: str,
    *,
    receipt: dict[str, object] | None = None,
    target_stdout: bytes | None = None,
) -> None:
    result = receipt.get("result") if receipt is not None else None
    parent_verification = receipt.get("runnerParentVerification") if receipt is not None else None
    if not isinstance(result, dict):
        result = None
    if not isinstance(parent_verification, dict):
        parent_verification = None

    result_fields = result or {}
    parent_fields = parent_verification or {}
    target_stdout_excerpt = _safe_excerpt(target_stdout)
    stderr_bytes = result_fields.get("stderrBytes")
    stderr_is_exact = type(stderr_bytes) is int and len(outer_stderr) == stderr_bytes
    target_stderr_excerpt = _safe_excerpt(outer_stderr) if stderr_is_exact else None
    transport_stderr_excerpt: object = (
        "SAME_AS_TARGET_STDERR" if stderr_is_exact else _safe_excerpt(outer_stderr)
    )

    def field(key: str) -> str:
        return _diagnostic_value(result_fields.get(key))

    def parent_field(key: str) -> str:
        return _diagnostic_value(parent_fields.get(key))

    lines = [
        "SANDBOX_DIAGNOSTIC_BEGIN",
        f"SANDBOX_PHASE={phase}",
        f"SANDBOX_OUTER_RETURN_CODE={_diagnostic_value(outer_return_code)}",
        f"RUNNER_RECEIPT_VALID={'YES' if receipt is not None else 'NO'}",
        f"SANDBOX_VALIDATION_REASON={terminal_reason}",
        f"RUNNER_SCHEMA_VERSION={_diagnostic_value(receipt.get('schemaVersion') if receipt else None)}",
        f"RUNNER_PROTOCOL={_diagnostic_value(receipt.get('protocol') if receipt else None)}",
        f"RUNNER_POLICY_ID={_diagnostic_value(receipt.get('policyId') if receipt else None)}",
        f"RUNNER_PARENT_VERIFICATION={parent_field('status')}",
        f"RUNNER_MISMATCH_CODE={parent_field('mismatchCode')}",
        f"RUNNER_RESULT_CODE={field('code')}",
        f"RUNNER_RESULT_NAME={field('name')}",
        f"RUNNER_TERMINATION_CLASS={field('terminationClass')}",
        f"RUNNER_TARGET_EXIT={field('targetExit')}",
        f"RUNNER_TARGET_SIGNAL={field('targetSignal')}",
        f"RUNNER_SETUP_STAGE={field('setupStage')}",
        f"RUNNER_EVIDENCE_CODE={field('evidenceCode')}",
        f"RUNNER_ELAPSED_MS={field('elapsedMs')}",
        f"RUNNER_STDOUT_BYTES={field('stdoutBytes')}",
        f"RUNNER_STDERR_BYTES={field('stderrBytes')}",
        f"TARGET_STDERR_ATTRIBUTION={'EXACT' if stderr_is_exact else 'UNAVAILABLE_MISMATCH' if receipt else 'null'}",
        f"TARGET_STDOUT_ACTUAL_BYTES={_diagnostic_value(len(target_stdout) if target_stdout is not None else None)}",
        f"OUTER_STDOUT_BYTES={len(outer_stdout)}",
        f"OUTER_STDERR_BYTES={len(outer_stderr)}",
        "TARGET_STDOUT_EXCERPT=" + json.dumps(target_stdout_excerpt, ensure_ascii=True, separators=(",", ":")),
        "TARGET_STDERR_EXCERPT=" + json.dumps(target_stderr_excerpt, ensure_ascii=True, separators=(",", ":")),
        "TRANSPORT_STDERR_EXCERPT=" + json.dumps(transport_stderr_excerpt, ensure_ascii=True, separators=(",", ":")),
        "SANDBOX_DIAGNOSTIC_END",
    ]
    block = "\n".join(lines)
    if len(block.encode("ascii")) > SANDBOX_DIAGNOSTIC_MAX_BYTES:
        raise RuntimeError("bounded sandbox diagnostic exceeded its cap")
    print(block, file=sys.stderr, flush=True)


def run_sandbox(
    sandbox: pathlib.Path,
    runner: pathlib.Path,
    work: pathlib.Path,
    runtime_root: pathlib.Path,
    writer_root: pathlib.Path,
    target: str,
    target_args: list[str],
    timeout_seconds: int,
    validator: pathlib.Path | None = None,
    support_script: pathlib.Path | None = None,
    *,
    phase: str,
) -> bytes:
    if not isinstance(phase, str) or phase not in {"WRITER", "VALIDATOR", "IMPORT", "EDIT", "REOPEN"}:
        fail("SANDBOX_PHASE_INVALID", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")
    carrier_root = work.parent
    if carrier_root.is_symlink() or not carrier_root.is_dir():
        fail("CARRIER_ROOT_INVALID", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    runtime_mount = carrier_mount(runtime_root, carrier_root, "RUNTIME")
    writer_mount = carrier_mount(writer_root, carrier_root, "WRITER")
    runner_mount = carrier_mount(runner, carrier_root, "RUNNER")
    work_mount = carrier_mount(work, carrier_root, "WORK")
    command = [
        str(sandbox),
        "--unshare-user", "--unshare-net", "--die-with-parent", "--new-session",
        "--ro-bind", str(carrier_root), "/carrier",
        "--ro-bind", runtime_mount, "/runtime/blender-root",
        "--ro-bind", writer_mount, "/runtime/writer",
        "--ro-bind", runner_mount, "/runtime/process-runner",
        "--bind", work_mount, "/work", "--chdir", "/work",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ]
    if validator is not None:
        command.extend(["--ro-bind", carrier_mount(validator, carrier_root, "VALIDATOR"), "/runtime/validator"])
    if support_script is not None:
        command.extend(["--ro-bind", carrier_mount(support_script, carrier_root, "SUPPORT"), f"/runtime/support/{support_script.name}"])
    command.extend([
        "--", "/runtime/process-runner",
        "--address-space-bytes", str(4 * 1024 * 1024 * 1024),
        "--file-bytes", str(128 * 1024 * 1024),
        "--timeout-ms", str(RUNNER_TIMEOUT_MS),
        "--stdout-bytes", str(RUNNER_STDOUT_BYTES),
        "--stderr-bytes", str(RUNNER_STDERR_BYTES),
        "--max-children", "0", "--", target,
        *target_args,
    ])
    try:
        result = subprocess.run(
            command,
            cwd=work,
            env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
    except OSError:
        _emit_sandbox_diagnostic(phase, None, b"", b"", "SANDBOX_LAUNCH_FAILED")
        fail("SANDBOX_LAUNCH_FAILED", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    except subprocess.TimeoutExpired as error:
        outer_stdout = _byte_output(getattr(error, "stdout", None) or getattr(error, "output", None))
        outer_stderr = _byte_output(getattr(error, "stderr", None))
        _emit_sandbox_diagnostic(phase, None, outer_stdout, outer_stderr, "SANDBOX_LAUNCH_TIMEOUT")
        fail("SANDBOX_LAUNCH_TIMEOUT", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")

    outer_stdout = _byte_output(result.stdout)
    outer_stderr = _byte_output(result.stderr)
    try:
        receipt, receipt_frame, target_stdout = _parse_runner_receipt(outer_stdout)
    except RunnerReceiptError as error:
        classification = (
            "HOSTED_SANDBOX_ENVIRONMENT_HOLD"
            if error.reason == "RUNNER_RECEIPT_MISSING"
            else "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY"
        )
        _emit_sandbox_diagnostic(phase, result.returncode, outer_stdout, outer_stderr, error.reason)
        fail(error.reason, classification)

    runner_result = receipt["result"]
    parent_verification = receipt["runnerParentVerification"]
    assert isinstance(runner_result, dict)
    assert isinstance(parent_verification, dict)
    result_code = runner_result["code"]
    if result.returncode != result_code or len(target_stdout) != runner_result["stdoutBytes"]:
        _emit_sandbox_diagnostic(
            phase,
            result.returncode,
            outer_stdout,
            outer_stderr,
            "RUNNER_TRANSPORT_MISMATCH",
            receipt=receipt,
            target_stdout=target_stdout,
        )
        fail("RUNNER_TRANSPORT_MISMATCH", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")

    if result_code == 0:
        if (
            runner_result["targetExit"] != 0
            or runner_result["targetSignal"] is not None
            or runner_result["setupStage"] is not None
            or runner_result["evidenceCode"] is not None
            or parent_verification["status"] != "PASS"
            or parent_verification["mismatchCode"] is not None
        ):
            _emit_sandbox_diagnostic(
                phase,
                result.returncode,
                outer_stdout,
                outer_stderr,
                "RUNNER_RECEIPT_SUCCESS_INVALID",
                receipt=receipt,
                target_stdout=target_stdout,
            )
            fail("RUNNER_RECEIPT_SUCCESS_INVALID", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")
        return receipt_frame + target_stdout

    failure_class = "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY"
    if result_code == 76:
        failure_reason = "TARGET_EXIT_NONZERO"
    elif result_code == 77:
        failure_reason = "TARGET_SIGNAL"
    elif result_code == 124:
        failure_reason = "TARGET_TIMEOUT"
    elif result_code == 74:
        failure_reason = "STDOUT_LIMIT"
    elif result_code == 75:
        failure_reason = "STDERR_LIMIT"
    elif result_code == 71:
        failure_class = "HOSTED_SANDBOX_ENVIRONMENT_HOLD"
        failure_reason = "RUNNER_CHILD_SETUP_FAILED"
    elif result_code == 72:
        failure_class = "HOSTED_SANDBOX_ENVIRONMENT_HOLD"
        failure_reason = "RUNNER_EVIDENCE_INVALID"
    elif result_code == 73:
        failure_class = "HOSTED_SANDBOX_ENVIRONMENT_HOLD"
        failure_reason = "RUNNER_EXEC_FAILED"
    elif result_code == 70:
        failure_class = "HOSTED_SANDBOX_ENVIRONMENT_HOLD"
        failure_reason = "RUNNER_INTERNAL"
    else:
        _emit_sandbox_diagnostic(
            phase,
            result.returncode,
            outer_stdout,
            outer_stderr,
            "RUNNER_RECEIPT_RESULT_CODE_UNKNOWN",
            receipt=receipt,
            target_stdout=target_stdout,
        )
        fail("RUNNER_RECEIPT_RESULT_CODE_UNKNOWN", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")

    _emit_sandbox_diagnostic(
        phase,
        result.returncode,
        outer_stdout,
        outer_stderr,
        failure_reason,
        receipt=receipt,
        target_stdout=target_stdout,
    )
    fail(failure_reason, failure_class)

def receipt_payload(output: bytes, label: str) -> bytes:
    prefix = b"S8_RUNNER_RECEIPT:"
    if not output.startswith(prefix):
        fail(f"{label}_RUNNER_RECEIPT_MISSING", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    newline = output.find(b"\n")
    if newline <= len(prefix):
        fail(f"{label}_RUNNER_RECEIPT_INVALID", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")
    return output[newline + 1 :]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--blender", required=True)
    parser.add_argument("--writer", required=True)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--sandbox", required=True)
    parser.add_argument("--validator", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--import-script")
    parser.add_argument("--reopen-script")
    args = parser.parse_args()

    blender = regular(args.blender, "BLENDER")
    writer = regular(args.writer, "WRITER")
    runner = regular(args.runner, "RUNNER")
    sandbox = regular(args.sandbox, "SANDBOX")
    validator = regular(args.validator, "VALIDATOR")
    work = directory(args.output_dir, "WORK")
    writer_root = writer.parent
    runtime_root = blender.parent
    private_exporter = writer_root / "export_fbx_bin.py"
    patch_manifest = writer_root / "patch-manifest.json"
    if private_exporter.is_symlink() or not private_exporter.is_file() or patch_manifest.is_symlink() or not patch_manifest.is_file():
        fail("WRITER_SUPPORT_PATH_INVALID", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")

    for child in work.iterdir():
        if child.name not in {".keep"}:
            fail("WORK_NOT_EMPTY", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    payload_path = work / "input.json"
    expected_path = work / "expected.json"
    payload = sample_payload()
    payload_path.write_text(json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")), encoding="ascii")
    expected_path.write_text(json.dumps({"objectNames": [payload["objects"][0]["name"]]}, sort_keys=True, separators=(",", ":")), encoding="ascii")

    writer_output = run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", "/runtime/writer/writer.py", "--"],
        360,
        phase="WRITER",
    )
    receipt_payload(writer_output, "WRITER")
    artifact = work / "artifact.fbx"
    writer_receipt = work / "writer-receipt.json"
    if artifact.is_symlink() or not artifact.is_file() or writer_receipt.is_symlink() or not writer_receipt.is_file():
        fail("WRITER_OUTPUT_INVALID", "CANDIDATE_DEFECT__WRITER_OUTPUT")

    validator_output = run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/validator", ["/work/artifact.fbx"], 180, validator=validator,
        phase="VALIDATOR",
    )
    validator_payload = receipt_payload(validator_output, "VALIDATOR")
    try:
        readback = json.loads(validator_payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        fail("NATIVE_READBACK_INVALID", "CANDIDATE_DEFECT__NATIVE_VALIDATOR")
    readback_value = readback.get("readback", readback) if isinstance(readback, dict) else None
    if not isinstance(readback_value, dict) or readback_value.get("schemaVersion") != "s8-ufbx-readback-v1":
        fail("NATIVE_READBACK_SCHEMA_INVALID", "CANDIDATE_DEFECT__NATIVE_VALIDATOR")

    import_script = pathlib.Path(args.import_script).resolve() if args.import_script else pathlib.Path(__file__).resolve().with_name("blender_validate.py")
    reopen_script = pathlib.Path(args.reopen_script).resolve() if args.reopen_script else pathlib.Path(__file__).resolve().with_name("blender_reopen_validate.py")
    for script, label in ((import_script, "IMPORT"), (reopen_script, "REOPEN")):
        if script.is_symlink() or not script.is_file():
            fail(f"{label}_SCRIPT_INVALID", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")

    run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", f"/runtime/support/{import_script.name}", "--"],
        360, support_script=import_script, phase="IMPORT",
    )
    run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", f"/runtime/support/{reopen_script.name}", "--", "--phase", "edit"],
        360, support_script=reopen_script, phase="EDIT",
    )
    run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", f"/runtime/support/{reopen_script.name}", "--", "--phase", "reopen"],
        360, support_script=reopen_script, phase="REOPEN",
    )
    for name in ("blender-import-receipt.json", "edited.blend", "edit-receipt.json", "reopen-receipt.json"):
        value = work / name
        if value.is_symlink() or not value.is_file():
            fail(f"{name.replace('-', '_').upper()}_MISSING", "CANDIDATE_DEFECT__BLENDER_QUALIFICATION")

    print("S8_RUNTIME_SENSITIVITY=PASS")
    print(f"WRITER_ARTIFACT_SHA256={hashlib.sha256(artifact.read_bytes()).hexdigest()}")
    print("NATIVE_VALIDATOR_READBACK=s8-ufbx-readback-v1")
    print("BLENDER_IMPORT_EDIT_REOPEN=PASS")


if __name__ == "__main__":
    main()
