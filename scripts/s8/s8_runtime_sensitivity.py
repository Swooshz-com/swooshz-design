#!/usr/bin/env python3
"""Run the pinned S8 writer, Blender reopen floor, and native validator in a staged carrier."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
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
) -> bytes:
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
    except (OSError, subprocess.TimeoutExpired):
        fail("SANDBOX_LAUNCH_FAILED", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
    if result.returncode != 0:
        if b"S8_RUNNER_RECEIPT:" not in result.stdout:
            fail("SANDBOX_ADMISSION_FAILED", "HOSTED_SANDBOX_ENVIRONMENT_HOLD")
        fail("NATIVE_PROCESS_BOUNDARY_FAILED", "CANDIDATE_DEFECT__NATIVE_PROCESS_BOUNDARY")
    return result.stdout


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
    )
    receipt_payload(writer_output, "WRITER")
    artifact = work / "artifact.fbx"
    writer_receipt = work / "writer-receipt.json"
    if artifact.is_symlink() or not artifact.is_file() or writer_receipt.is_symlink() or not writer_receipt.is_file():
        fail("WRITER_OUTPUT_INVALID", "CANDIDATE_DEFECT__WRITER_OUTPUT")

    validator_output = run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/validator", ["/work/artifact.fbx"], 180, validator=validator,
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
        360, support_script=import_script,
    )
    run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", f"/runtime/support/{reopen_script.name}", "--", "--phase", "edit"],
        360, support_script=reopen_script,
    )
    run_sandbox(
        sandbox, runner, work, runtime_root, writer_root,
        "/runtime/blender-root/blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", f"/runtime/support/{reopen_script.name}", "--", "--phase", "reopen"],
        360, support_script=reopen_script,
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
