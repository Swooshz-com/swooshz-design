#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded Blender FBX serializer for swooshz-fbx-writer-input-v1.

This file intentionally contains no S6 modelling or product decisions. It only
materializes the explicit accepted mesh payload and calls Blender's bundled FBX
exporter with the locked profile.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
from typing import Any

import bpy
import io_scene_fbx
from mathutils import Matrix


POSITION_SCALE = 1_000_000
UNIT_SCALE = 10_000_000_000
PAYLOAD_MAX = 256 * 1024 * 1024
ARTIFACT_MAX = 128 * 1024 * 1024
RECEIPT_MAX = 1024 * 1024
OBJECT_MAX = 256
CONTROL_POINT_MAX = 262_656
TRIANGLE_MAX = 524_288
EXPECTED_EXPORTER_SHA1 = {
    "__init__.py": "72c5a94e31ff783ffdf8145c4da22bd602da8f91",
    "export_fbx_bin.py": "3bb9b1805d0e5293baefa0bf9335203db80d233f",
    "encode_bin.py": "f15fd9f3fa592e85a8f727b37d5745aeec51bada",
    "fbx_utils.py": "4b6c7503c0760a2038a4fb588b036dc0b413a8c6",
}


def fail(code: str) -> "NoReturn":
    raise RuntimeError(code)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_blob_sha1(path: pathlib.Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\x00" + data).hexdigest()


def no_float(_: str) -> Any:
    fail("S8_PAYLOAD_FLOAT_FORBIDDEN")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("S8_PAYLOAD_DUPLICATE_KEY")
        result[key] = value
    return result


def integer(value: Any, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 9_007_199_254_740_991:
        fail(code)
    return value


def fixed_path(name: str) -> pathlib.Path:
    path = pathlib.Path.cwd() / name
    if path.is_symlink() or path.parent.resolve() != pathlib.Path.cwd().resolve():
        fail("S8_PATH_INVALID")
    return path


def load_payload(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > PAYLOAD_MAX:
        fail("S8_PAYLOAD_SIZE_INVALID")
    if path.read_bytes().startswith(b"\xef\xbb\xbf"):
        fail("S8_PAYLOAD_BOM_FORBIDDEN")
    with path.open("r", encoding="utf-8", newline="") as handle:
        value = json.load(
            handle,
            object_pairs_hook=unique_object,
            parse_float=no_float,
            parse_constant=no_float,
        )
    if not isinstance(value, dict):
        fail("S8_PAYLOAD_INVALID")
    if value.get("schemaVersion") != "swooshz-fbx-writer-input-v1" or value.get("profile") != "swooshz-fbx-static-mesh-v1":
        fail("S8_PAYLOAD_PROFILE_INVALID")
    scene = value.get("scene")
    if scene != {"frontAxis": "-Y", "rightAxis": "+X", "rootName": "SWZ_ROOT", "units": "millimetres", "upAxis": "+Z"}:
        fail("S8_SCENE_PROFILE_INVALID")
    objects = value.get("objects")
    materials = value.get("materials")
    if not isinstance(objects, list) or not isinstance(materials, list) or len(objects) > OBJECT_MAX:
        fail("S8_PAYLOAD_RESOURCE_LIMIT")
    return value


def assert_runtime() -> dict[str, Any]:
    if tuple(bpy.app.version) != (5, 2, 2):
        fail("S8_BLENDER_VERSION_MISMATCH")
    build_hash = bpy.app.build_hash.decode("ascii") if isinstance(bpy.app.build_hash, bytes) else str(bpy.app.build_hash)
    if not build_hash.startswith("d13f752e3b9c"):
        fail("S8_BLENDER_BUILD_HASH_MISMATCH")
    addon_version = tuple(getattr(io_scene_fbx, "bl_info", {}).get("version", ()))
    if addon_version != (5, 15, 0):
        fail("S8_EXPORTER_VERSION_MISMATCH")
    exporter_dir = pathlib.Path(io_scene_fbx.__file__).resolve().parent
    files: dict[str, Any] = {}
    for name, expected in EXPECTED_EXPORTER_SHA1.items():
        path = exporter_dir / name
        actual = git_blob_sha1(path)
        if actual != expected:
            fail("S8_EXPORTER_DIGEST_MISMATCH")
        files[name] = {"gitBlobSha1": actual, "sha256": sha256(path)}
    return {
        "blenderVersion": list(bpy.app.version),
        "blenderVersionString": bpy.app.version_string,
        "blenderBuildHash": build_hash,
        "blenderBinarySha256": sha256(pathlib.Path(bpy.app.binary_path).resolve()),
        "exporterVersion": list(addon_version),
        "exporterFiles": files,
        "platform": sys.platform,
        "pythonVersion": sys.version.split()[0],
    }


def rows_from_ticks(values: Any) -> Matrix:
    if not isinstance(values, list) or len(values) != 16:
        fail("S8_MATRIX_INVALID")
    decoded = []
    for index, value in enumerate(values):
        scale = POSITION_SCALE if index % 4 == 3 and index < 12 else UNIT_SCALE
        decoded.append(integer(value, "S8_MATRIX_INVALID") / scale)
    matrix = Matrix((decoded[0:4], decoded[4:8], decoded[8:12], decoded[12:16]))
    if any(abs(matrix[row][column] - (1.0 if row == column else 0.0)) > 1e-12 for row in range(3, 4) for column in range(4)):
        fail("S8_MATRIX_INVALID")
    return matrix


def build_materials(payload: dict[str, Any]) -> dict[str, bpy.types.Material]:
    result: dict[str, bpy.types.Material] = {}
    for item in payload["materials"]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or item["name"] in result:
            fail("S8_MATERIAL_INVALID")
        color = item.get("diffuseRgbTicks")
        if not isinstance(color, list) or len(color) != 3 or integer(item.get("opacityTicks"), "S8_MATERIAL_INVALID") != UNIT_SCALE:
            fail("S8_MATERIAL_INVALID")
        rgb = [integer(component, "S8_MATERIAL_INVALID") / UNIT_SCALE for component in color]
        if any(component < 0 or component > 1 for component in rgb):
            fail("S8_MATERIAL_INVALID")
        material = bpy.data.materials.new(item["name"])
        material.use_nodes = False
        material.diffuse_color = (*rgb, 1.0)
        material.specular_intensity = 0.0
        material.roughness = 1.0
        result[item["name"]] = material
    return result


def construct_scene(payload: dict[str, Any]) -> tuple[int, int]:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(collection):
            collection.remove(block)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"
    bpy.data.filepath = ""
    root = bpy.data.objects.new("SWZ_ROOT", None)
    scene.collection.objects.link(root)
    root["swz_profile"] = "swooshz-fbx-static-mesh-v1"
    source = payload.get("source")
    if not isinstance(source, dict):
        fail("S8_SOURCE_INVALID")
    for key in ("revisionId", "revisionHash", "s6ValidationHash", "s6HandoffDigest"):
        value = source.get(key)
        if not isinstance(value, str) or len(value) > 128:
            fail("S8_SOURCE_INVALID")
        root[f"swz_{key}"] = value
    materials = build_materials(payload)
    objects: dict[str, bpy.types.Object] = {"SWZ_ROOT": root}
    pending_parents: list[tuple[bpy.types.Object, str]] = []
    control_points = 0
    triangles_total = 0
    for item in payload["objects"]:
        if not isinstance(item, dict) or item.get("nodeKind") != "mesh":
            fail("S8_OBJECT_INVALID")
        name = item.get("name")
        parent_name = item.get("parentName")
        if not isinstance(name, str) or not name.startswith("SWZ_") or name in objects or not isinstance(parent_name, str):
            fail("S8_OBJECT_INVALID")
        vertices_raw = item.get("verticesTicks")
        triangles_raw = item.get("triangles")
        normals_raw = item.get("cornerNormalsTicks")
        if not isinstance(vertices_raw, list) or not isinstance(triangles_raw, list) or not isinstance(normals_raw, list):
            fail("S8_MESH_INVALID")
        vertices = []
        for vertex in vertices_raw:
            if not isinstance(vertex, list) or len(vertex) != 3:
                fail("S8_VERTEX_INVALID")
            vertices.append(tuple(integer(component, "S8_VERTEX_INVALID") / POSITION_SCALE for component in vertex))
        faces = []
        for triangle in triangles_raw:
            if not isinstance(triangle, list) or len(triangle) != 3:
                fail("S8_TRIANGLE_INVALID")
            face = tuple(integer(index, "S8_TRIANGLE_INVALID") for index in triangle)
            if len(set(face)) != 3 or any(index < 0 or index >= len(vertices) for index in face):
                fail("S8_TRIANGLE_INVALID")
            faces.append(face)
        if len(normals_raw) != len(faces) * 3:
            fail("S8_NORMAL_INVALID")
        normals = []
        for normal in normals_raw:
            if not isinstance(normal, list) or len(normal) != 3:
                fail("S8_NORMAL_INVALID")
            normals.append(tuple(integer(component, "S8_NORMAL_INVALID") / UNIT_SCALE for component in normal))
        control_points += len(vertices)
        triangles_total += len(faces)
        if control_points > CONTROL_POINT_MAX or triangles_total > TRIANGLE_MAX:
            fail("S8_RESOURCE_LIMIT")
        mesh = bpy.data.meshes.new(f"{name}_MESH")
        mesh.from_pydata(vertices, [], faces)
        mesh.update(calc_edges=True)
        if len(mesh.polygons) != len(faces) or any(len(polygon.vertices) != 3 for polygon in mesh.polygons):
            fail("S8_BLENDER_TOPOLOGY_CHANGED")
        mesh.normals_split_custom_set(normals)
        for polygon in mesh.polygons:
            polygon.use_smooth = False
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        obj.matrix_local = rows_from_ticks(item.get("matrixTicks"))
        obj["swz_object_id"] = item.get("objectId")
        obj["swz_identity_key"] = item.get("identityKey")
        obj["swz_geometry_state"] = item.get("geometryState")
        obj["swz_degradation_codes"] = ",".join(item.get("degradationCodes", []))
        material_name = item.get("materialName")
        if material_name is not None:
            if material_name not in materials:
                fail("S8_MATERIAL_INVALID")
            mesh.materials.append(materials[material_name])
        objects[name] = obj
        pending_parents.append((obj, parent_name))
    for obj, parent_name in pending_parents:
        parent = objects.get(parent_name)
        if parent is None:
            fail("S8_HIERARCHY_INVALID")
        local = obj.matrix_local.copy()
        obj.parent = parent
        obj.matrix_local = local
    if len(bpy.data.objects) != len(payload["objects"]) + 1:
        fail("S8_SCENE_OBJECT_COUNT_INVALID")
    return control_points, triangles_total


def export_fbx(path: pathlib.Path) -> None:
    result = bpy.ops.export_scene.fbx(
        filepath=str(path),
        check_existing=False,
        use_selection=False,
        use_visible=False,
        use_active_collection=False,
        collection="",
        object_types={"EMPTY", "MESH"},
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        axis_forward="Y",
        axis_up="Z",
        use_space_transform=False,
        bake_space_transform=False,
        use_mesh_modifiers=False,
        use_mesh_modifiers_render=False,
        use_subsurf=False,
        use_mesh_edges=False,
        use_triangles=False,
        mesh_smooth_type="OFF",
        use_tspace=False,
        colors_type="NONE",
        prioritize_active_color=False,
        use_custom_props=True,
        bake_anim=False,
        bake_anim_use_all_bones=False,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
        bake_anim_force_startend_keying=False,
        add_leaf_bones=False,
        path_mode="STRIP",
        embed_textures=False,
        batch_mode="OFF",
        use_batch_own_dir=False,
        use_metadata=False,
    )
    if result != {"FINISHED"}:
        fail("S8_EXPORT_FAILED")


def main() -> None:
    if pathlib.Path.cwd().resolve() == pathlib.Path.home().resolve():
        fail("S8_WORKDIR_INVALID")
    input_path = fixed_path("input.json")
    artifact_path = fixed_path("artifact.fbx")
    receipt_path = fixed_path("writer-receipt.json")
    if artifact_path.exists() or receipt_path.exists():
        fail("S8_OUTPUT_ALREADY_EXISTS")
    payload = load_payload(input_path)
    runtime = assert_runtime()
    control_points, triangles = construct_scene(payload)
    export_fbx(artifact_path)
    if not artifact_path.is_file() or artifact_path.stat().st_size <= 27 or artifact_path.stat().st_size > ARTIFACT_MAX:
        fail("S8_ARTIFACT_SIZE_INVALID")
    header = artifact_path.read_bytes()[:27]
    if not header.startswith(b"Kaydara FBX Binary  \x00\x1a\x00") or int.from_bytes(header[23:27], "little") != 7400:
        fail("S8_FBX_HEADER_INVALID")
    writer_path = pathlib.Path(__file__).resolve()
    receipt = {
        "schemaVersion": "swooshz-fbx-writer-receipt-v1",
        "profile": "swooshz-fbx-static-mesh-v1",
        "payloadSha256": sha256(input_path),
        "writerScriptSha256": sha256(writer_path),
        "artifactSha256": sha256(artifact_path),
        "artifactByteSize": artifact_path.stat().st_size,
        "fbxHeaderVersion": 7400,
        "objectCount": len(payload["objects"]),
        "controlPointCount": control_points,
        "triangleCount": triangles,
        "runtime": runtime,
    }
    encoded = json.dumps(receipt, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
    if len(encoded) > RECEIPT_MAX:
        fail("S8_RECEIPT_SIZE_INVALID")
    receipt_path.write_bytes(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"S8_WRITER_FAIL:{type(error).__name__}:{error}", file=sys.stderr)
        raise
