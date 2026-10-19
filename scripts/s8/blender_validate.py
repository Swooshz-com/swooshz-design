#!/usr/bin/env python3
"""Headless import receipt for the exact stored S8 FBX artifact."""

import hashlib
import json
import pathlib

import bpy


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(code):
    raise RuntimeError(code)


def main():
    work = pathlib.Path.cwd().resolve()
    artifact = work / "artifact.fbx"
    expected_path = work / "expected.json"
    receipt_path = work / "blender-import-receipt.json"
    if any(path.is_symlink() for path in (artifact, expected_path, receipt_path)) or not artifact.is_file() or not expected_path.is_file() or receipt_path.exists():
        fail("S8_BLENDER_IMPORT_PATH_INVALID")
    if tuple(bpy.app.version) != (5, 2, 2):
        fail("S8_BLENDER_VERSION_MISMATCH")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    expected_names = expected.get("objectNames")
    if not isinstance(expected_names, list) or not all(isinstance(value, str) for value in expected_names):
        fail("S8_BLENDER_EXPECTED_INVALID")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    result = bpy.ops.import_scene.fbx(filepath=str(artifact), use_custom_normals=True, use_image_search=False, use_anim=False, automatic_bone_orientation=False)
    if result != {"FINISHED"}:
        fail("S8_BLENDER_IMPORT_FAILED")
    objects = sorted(bpy.context.scene.objects, key=lambda item: item.name)
    actual_names = [item.name for item in objects if item.name == "SWZ_ROOT" or item.name.startswith("SWZ_")]
    if actual_names != sorted(["SWZ_ROOT", *expected_names]):
        fail("S8_BLENDER_OBJECT_SET_MISMATCH")
    meshes = [item for item in objects if item.type == "MESH"]
    if len(meshes) != len(expected_names) or any(len(item.data.polygons) == 0 or any(len(face.vertices) != 3 for face in item.data.polygons) for item in meshes):
        fail("S8_BLENDER_MESH_INVALID")
    receipt = {
        "schemaVersion": "s8-blender-import-receipt-v1",
        "artifactSha256": sha256(artifact),
        "blenderVersion": list(bpy.app.version),
        "blenderBuildHash": bpy.app.build_hash.decode("ascii") if isinstance(bpy.app.build_hash, bytes) else str(bpy.app.build_hash),
        "objectNames": actual_names,
        "meshCount": len(meshes),
        "selectableEditable": all(not item.hide_select and item.library is None and item.override_library is None for item in meshes),
    }
    receipt_path.write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")), encoding="ascii")


main()
