#!/usr/bin/env python3
"""Two-phase Blender edit/save/reopen qualification for a stored S8 FBX."""

import hashlib
import json
import pathlib
import sys

import bpy


def fail(code):
    raise RuntimeError(code)


def digest_scene():
    digest = hashlib.sha256()
    for obj in sorted((item for item in bpy.context.scene.objects if item.type == "MESH"), key=lambda item: item.name):
        digest.update(obj.name.encode("ascii"))
        for vertex in obj.data.vertices:
            digest.update(("%.9f,%.9f,%.9f;" % tuple(vertex.co)).encode("ascii"))
        for face in obj.data.polygons:
            digest.update((",".join(str(index) for index in face.vertices) + ";").encode("ascii"))
    return digest.hexdigest()


def phase_argument():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 2 or args[0] != "--phase" or args[1] not in ("edit", "reopen"):
        fail("S8_BLENDER_REOPEN_USAGE")
    return args[1]


def edit(work):
    artifact = work / "artifact.fbx"
    blend = work / "edited.blend"
    receipt_path = work / "edit-receipt.json"
    if not artifact.is_file() or blend.exists() or receipt_path.exists():
        fail("S8_BLENDER_EDIT_PATH_INVALID")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    if bpy.ops.import_scene.fbx(filepath=str(artifact), use_custom_normals=True, use_image_search=False, use_anim=False) != {"FINISHED"}:
        fail("S8_BLENDER_IMPORT_FAILED")
    meshes = sorted((item for item in bpy.context.scene.objects if item.type == "MESH" and len(item.data.vertices) > 0), key=lambda item: item.name)
    if not meshes:
        fail("S8_BLENDER_EDIT_NO_MESH")
    target = meshes[0]
    before_scene = digest_scene()
    before = list(target.data.vertices[0].co)
    target.data.vertices[0].co.x += 1.0
    target.data.update()
    after = list(target.data.vertices[0].co)
    after_scene = digest_scene()
    if abs((after[0] - before[0]) - 1.0) > 1e-7 or before_scene == after_scene:
        fail("S8_BLENDER_EDIT_NOT_APPLIED")
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), check_existing=False, compress=False)
    receipt_path.write_text(json.dumps({
        "schemaVersion": "s8-blender-edit-receipt-v1", "objectName": target.name, "vertexIndex": 0,
        "before": before, "after": after, "beforeSceneDigest": before_scene, "afterSceneDigest": after_scene,
    }, sort_keys=True, separators=(",", ":")), encoding="ascii")


def reopen(work):
    blend = work / "edited.blend"
    edit_receipt = work / "edit-receipt.json"
    output = work / "reopen-receipt.json"
    if not blend.is_file() or not edit_receipt.is_file() or output.exists():
        fail("S8_BLENDER_REOPEN_PATH_INVALID")
    expected = json.loads(edit_receipt.read_text(encoding="ascii"))
    bpy.ops.wm.open_mainfile(filepath=str(blend), load_ui=False, use_scripts=False)
    target = bpy.data.objects.get(expected["objectName"])
    if target is None or target.type != "MESH" or len(target.data.vertices) <= expected["vertexIndex"]:
        fail("S8_BLENDER_REOPEN_TARGET_MISSING")
    actual = list(target.data.vertices[expected["vertexIndex"]].co)
    if any(abs(actual[index] - expected["after"][index]) > 1e-7 for index in range(3)) or digest_scene() != expected["afterSceneDigest"]:
        fail("S8_BLENDER_REOPEN_MISMATCH")
    output.write_text(json.dumps({
        "schemaVersion": "s8-blender-reopen-receipt-v1", "outcome": "pass", "objectName": target.name,
        "vertexIndex": expected["vertexIndex"], "actual": actual, "sceneDigest": digest_scene(),
    }, sort_keys=True, separators=(",", ":")), encoding="ascii")


if tuple(bpy.app.version) != (5, 2, 2):
    fail("S8_BLENDER_VERSION_MISMATCH")
phase = phase_argument()
working_directory = pathlib.Path.cwd().resolve()
edit(working_directory) if phase == "edit" else reopen(working_directory)
