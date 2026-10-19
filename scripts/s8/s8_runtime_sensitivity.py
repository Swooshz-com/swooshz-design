#!/usr/bin/env python3
"""Run pinned-Blender writer, import/reopen, and fail-closed mutation checks."""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile
from typing import Any

UNIT_SCALE = 10_000_000_000
POSITION_SCALE = 1_000_000


def default_payload() -> dict[str, Any]:
    digest = "a" * 64
    object_id = "runtime-object"
    object_name = "SWZ_0000_" + __import__("hashlib").sha256(object_id.encode("utf-8")).hexdigest()[:16]
    return {
        "schemaVersion": "swooshz-fbx-writer-input-v1",
        "profile": "swooshz-fbx-static-mesh-v1",
        "source": {key: digest for key in ("projectId", "revisionId", "revisionHash", "sourceS5Fingerprint", "s6ValidationReceiptId", "s6ValidationHash", "s6HandoffDigest", "s7ArtifactId", "s7ArtifactHash", "s7ReadbackHash")},
        "scene": {"frontAxis": "-Y", "rightAxis": "+X", "rootName": "SWZ_ROOT", "units": "millimetres", "upAxis": "+Z"},
        "materials": [],
        "objects": [{
            "name": object_name, "objectId": object_id, "identityKey": object_id, "parentName": "SWZ_ROOT", "sourceObjectId": object_id, "sourceParentObjectId": None,
            "localTranslationTicks": [0, 0, 0], "sourceEulerMicrodegrees": [0, 0, 0], "unitScaleTicks": [UNIT_SCALE, UNIT_SCALE, UNIT_SCALE], "nodeKind": "mesh",
            "matrixTicks": [UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE], "transformDigest": digest,
            "verticesTicks": [[0, 0, 0], [POSITION_SCALE, 0, 0], [0, POSITION_SCALE, 0]], "triangles": [[0, 1, 2]], "cornerNormalsTicks": [[0, 0, UNIT_SCALE]] * 3,
            "materialName": None, "degradationCodes": [], "geometryState": "exact", "roundSegments": None, "analyticSagittaTicks": None,
        }],
    }


def sandboxed_blender_command(
    blender: pathlib.Path,
    writer: pathlib.Path,
    work: pathlib.Path,
    sandbox: pathlib.Path | None,
    extra: list[str],
    script: pathlib.Path | None = None,
) -> tuple[list[str] | None, list[str]]:
    blender_root = blender.parent.resolve()
    writer_dir = writer.parent.resolve()
    blender_relative = blender.resolve().relative_to(blender_root).as_posix()
    blender_args = [f"/runtime/blender-root/{blender_relative}", "--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", "/runtime/writer/writer.py", "--", *extra]
    if sandbox is None:
        python_script = str(script or writer)
        return None, [str(blender), "--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", python_script, "--", *extra]
    if script is not None:
        shutil.copy2(script, work / script.name)
        blender_args[blender_args.index("/runtime/writer/writer.py")] = "/work/" + script.name
    return [str(sandbox), "--unshare-user", "--unshare-net", "--die-with-parent", "--new-session", "--ro-bind", str(blender_root), "/runtime/blender-root", "--ro-bind", str(writer_dir), "/runtime/writer", "--bind", str(work), "/work", "--chdir", "/work", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"], blender_args


def run_command(command: list[str], work: pathlib.Path, runner: pathlib.Path | None, address_space: int, file_bytes: int, timeout_ms: int, stdout_bytes: int, stderr_bytes: int, sandbox_prefix: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    if runner is not None:
        runner_args = ["--address-space-bytes", str(address_space), "--file-bytes", str(file_bytes), "--timeout-ms", str(timeout_ms), "--stdout-bytes", str(stdout_bytes), "--stderr-bytes", str(stderr_bytes), "--max-children", "0", "--", *command]
        if sandbox_prefix is None:
            command = [str(runner), *runner_args]
        else:
            command = [*sandbox_prefix, "--ro-bind", str(runner.resolve()), "/runtime/process-runner", "/runtime/process-runner", *runner_args]
    return subprocess.run(command, cwd=work, text=True, capture_output=True, check=False, timeout=timeout_ms / 1000 + 10)


def run_writer(payload: dict[str, Any], blender: pathlib.Path, writer: pathlib.Path, runner: pathlib.Path | None, sandbox: pathlib.Path | None, work: pathlib.Path) -> subprocess.CompletedProcess[str]:
    (work / "input.json").write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    sandbox_prefix, command = sandboxed_blender_command(blender, writer, work, sandbox, [])
    return run_command(command, work, runner, 4 * 1024 * 1024 * 1024, 128 * 1024 * 1024, 300000, 1024 * 1024, 1024 * 1024, sandbox_prefix)


def run_blender_script(script: pathlib.Path, blender: pathlib.Path, writer: pathlib.Path, runner: pathlib.Path | None, sandbox: pathlib.Path | None, work: pathlib.Path, extra: list[str]) -> subprocess.CompletedProcess[str]:
    sandbox_prefix, command = sandboxed_blender_command(blender, writer, work, sandbox, extra, script)
    return run_command(command, work, runner, 4 * 1024 * 1024 * 1024, 128 * 1024 * 1024, 300000, 1024 * 1024, 1024 * 1024, sandbox_prefix)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", type=pathlib.Path)
    parser.add_argument("--blender", required=True, type=pathlib.Path)
    parser.add_argument("--writer", required=True, type=pathlib.Path)
    parser.add_argument("--runner", required=True, type=pathlib.Path)
    parser.add_argument("--sandbox", type=pathlib.Path)
    parser.add_argument("--validator", type=pathlib.Path)
    parser.add_argument("--output-dir", type=pathlib.Path)
    args = parser.parse_args()
    payload = json.loads(args.payload.read_text(encoding="utf-8")) if args.payload else default_payload()
    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=False)
        baseline_work = args.output_dir
        cleanup = False
    else:
        temporary = tempfile.TemporaryDirectory(prefix="s8-sensitivity-")
        baseline_work = pathlib.Path(temporary.name)
        cleanup = True

    baseline = run_writer(payload, args.blender, args.writer, args.runner, args.sandbox, baseline_work)
    if baseline.returncode != 0:
        raise SystemExit(f"baseline writer failed: {baseline.stderr[-400:]}")
    expected_names = [item["name"] for item in payload["objects"]]
    (baseline_work / "expected.json").write_text(json.dumps({"objectNames": expected_names}, sort_keys=True, separators=(",", ":")), encoding="ascii")
    if args.validator:
        validator_prefix = None if args.sandbox is None else [str(args.sandbox), "--unshare-user", "--unshare-net", "--die-with-parent", "--new-session", "--ro-bind", str(args.validator.parent.resolve()), "/runtime/validator", "--bind", str(baseline_work), "/work", "--chdir", "/work", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
        validator_command = [str(args.validator), str(baseline_work / "artifact.fbx")] if args.sandbox is None else ["/runtime/validator/" + args.validator.name, "/work/artifact.fbx"]
        validation = run_command(validator_command, baseline_work, args.runner, 1536 * 1024 * 1024, 256 * 1024 * 1024, 120000, 8 * 1024 * 1024, 1024 * 1024, validator_prefix)
        if validation.returncode != 0 or '"schemaVersion":"s8-ufbx-readback-v1"' not in validation.stdout:
            raise SystemExit(f"native validator failed: {validation.stderr[-400:]}")
    imported = run_blender_script(pathlib.Path(__file__).with_name("blender_validate.py"), args.blender, args.writer, args.runner, args.sandbox, baseline_work, [])
    if imported.returncode != 0:
        raise SystemExit(f"Blender import validation failed: {imported.stderr[-400:]}")
    edited = run_blender_script(pathlib.Path(__file__).with_name("blender_reopen_validate.py"), args.blender, args.writer, args.runner, args.sandbox, baseline_work, ["--phase", "edit"])
    if edited.returncode != 0:
        raise SystemExit(f"Blender edit validation failed: {edited.stderr[-400:]}")
    reopened = run_blender_script(pathlib.Path(__file__).with_name("blender_reopen_validate.py"), args.blender, args.writer, args.runner, args.sandbox, baseline_work, ["--phase", "reopen"])
    if reopened.returncode != 0:
        raise SystemExit(f"Blender reopen validation failed: {reopened.stderr[-400:]}")

    with tempfile.TemporaryDirectory(prefix="s8-mutation-") as directory:
        mutation_work = pathlib.Path(directory)
        matrix_mutation = json.loads(json.dumps(payload))
        matrix_mutation["objects"][0]["matrixTicks"][3] += 1000
        matrix_result = run_writer(matrix_mutation, args.blender, args.writer, args.runner, args.sandbox, mutation_work)
        if matrix_result.returncode == 0 or "S8_TRANSFORM_ORACLE_MISMATCH" not in matrix_result.stderr:
            raise SystemExit("matrix sensitivity mutation was not rejected by the writer")
        axis_mutation = json.loads(json.dumps(payload))
        axis_mutation["scene"]["upAxis"] = "+Y"
        axis_result = run_writer(axis_mutation, args.blender, args.writer, args.runner, args.sandbox, mutation_work)
        if axis_result.returncode == 0 or "S8_SCENE_PROFILE_INVALID" not in axis_result.stderr:
            raise SystemExit("axis sensitivity mutation was not rejected by the writer")
    if cleanup:
        temporary.cleanup()
    print("s8-runtime-sensitivity: baseline/import/edit/reopen/native pass; transform and axis mutations rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
