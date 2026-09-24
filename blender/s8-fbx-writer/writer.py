#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail-closed Blender FBX writer for the accepted S8 source-rigid contract."""

from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import math
import pathlib
import sys
from typing import Any, NoReturn

import bpy
import io_scene_fbx
from mathutils import Matrix


POSITION_SCALE = 1_000_000
UNIT_SCALE = 10_000_000_000
PAYLOAD_MAX = 256 * 1024 * 1024
ARTIFACT_MAX = 128 * 1024 * 1024
RECEIPT_MAX = 1024 * 1024
OBJECT_MAX = 256
MATERIAL_MAX = 128
CONTROL_POINT_MAX = 262_656
TRIANGLE_MAX = 524_288
PHYSICAL_DEPTH_MAX = 256
SERIALIZED_DEPTH_MAX = 257
UTF8_METADATA_MAX = 4096

EXPECTED_EXPORTER_SHA1 = {
    "__init__.py": "72c5a94e31ff783ffdf8145c4da22bd602da8f91",
    "export_fbx_bin.py": "3bb9b1805d0e5293baefa0bf9335203db80d233f",
    "encode_bin.py": "f15fd9f3fa592e85a8f727b37d5745aeec51bada",
    "fbx_utils.py": "4b6c7503c0760a2038a4fb588b036dc0b413a8c6",
}
PATCH_MANIFEST_VERSION = "s8-exporter-patch-manifest-v1"
PATCH_IDENTITY = "s8-b3-source-rigid-exporter-v1"

SOURCE_FIELDS = (
    "projectId",
    "revisionId",
    "revisionHash",
    "sourceS5Fingerprint",
    "s6ValidationReceiptId",
    "s6ValidationHash",
    "s6HandoffDigest",
    "s7ArtifactId",
    "s7ArtifactHash",
    "s7ReadbackHash",
)
SOURCE_HASH_FIELDS = {
    "revisionHash",
    "sourceS5Fingerprint",
    "s6ValidationHash",
    "s6HandoffDigest",
    "s7ArtifactHash",
    "s7ReadbackHash",
}
OBJECT_FIELDS = (
    "name",
    "objectId",
    "identityKey",
    "parentName",
    "sourceObjectId",
    "sourceParentObjectId",
    "localTranslationTicks",
    "sourceEulerMicrodegrees",
    "unitScaleTicks",
    "nodeKind",
    "matrixTicks",
    "transformDigest",
    "verticesTicks",
    "triangles",
    "cornerNormalsTicks",
    "materialName",
    "degradationCodes",
    "geometryState",
    "roundSegments",
    "analyticSagittaTicks",
)

# This is the exact finite keyword surface of the pinned private save_single.
# Wrapper-only concepts such as output-existence checks, batching, collection
# filters and space-transform toggles are deliberately not passed to it.
DIRECT_EXPORT_KWARG_NAMES = frozenset(
    {
        "filepath",
        "global_matrix",
        "apply_unit_scale",
        "global_scale",
        "apply_scale_options",
        "axis_up",
        "axis_forward",
        "context_objects",
        "object_types",
        "use_mesh_modifiers",
        "use_mesh_modifiers_render",
        "mesh_smooth_type",
        "use_subsurf",
        "use_armature_deform_only",
        "bake_anim",
        "bake_anim_use_all_bones",
        "bake_anim_use_nla_strips",
        "bake_anim_use_all_actions",
        "bake_anim_step",
        "bake_anim_simplify_factor",
        "bake_anim_force_startend_keying",
        "add_leaf_bones",
        "primary_bone_axis",
        "secondary_bone_axis",
        "use_metadata",
        "path_mode",
        "use_mesh_edges",
        "use_tspace",
        "use_triangles",
        "embed_textures",
        "use_custom_props",
        "bake_space_transform",
        "armature_nodetype",
        "colors_type",
        "prioritize_active_color",
        "s8_transform_table",
    }
)


def fail(code: str) -> NoReturn:
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


def _text(value: Any, code: str, maximum: int = 4096, ascii_only: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        fail(code)
    if ascii_only:
        try:
            value.encode("ascii")
        except UnicodeEncodeError:
            fail(code)
    return value


def _utf8_key(value: str) -> bytes:
    return value.encode("utf-8")


def _stable_object_name(ordinal: int, source_object_id: str) -> str:
    digest = hashlib.sha256(source_object_id.encode("utf-8")).hexdigest()[:16]
    return f"SWZ_{ordinal:04d}_{digest}"


def load_patch_manifest() -> dict[str, Any]:
    manifest_path = pathlib.Path(__file__).resolve().with_name("patch-manifest.json")
    private_exporter_path = pathlib.Path(__file__).resolve().with_name("export_fbx_bin.py")
    if manifest_path.is_symlink() or private_exporter_path.is_symlink():
        fail("S8_PATCH_PATH_INVALID")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        fail("S8_PATCH_MANIFEST_INVALID")
    if not isinstance(manifest, dict):
        fail("S8_PATCH_MANIFEST_INVALID")
    if manifest.get("schemaVersion") != PATCH_MANIFEST_VERSION or manifest.get("patchIdentity") != PATCH_IDENTITY:
        fail("S8_PATCH_MANIFEST_INVALID")
    if manifest.get("upstreamExporterBlobs") != EXPECTED_EXPORTER_SHA1:
        fail("S8_PATCH_UPSTREAM_IDENTITY_MISMATCH")
    private_sha = manifest.get("privateExporterSha256")
    if not isinstance(private_sha, str) or sha256(private_exporter_path) != private_sha:
        fail("S8_PATCH_MANIFEST_MISMATCH")
    return {
        "schemaVersion": PATCH_MANIFEST_VERSION,
        "patchIdentity": PATCH_IDENTITY,
        "privateExporterSha256": private_sha,
        "manifestSha256": sha256(manifest_path),
    }


def load_private_exporter():
    private_path = pathlib.Path(__file__).resolve().with_name("export_fbx_bin.py")
    spec = importlib.util.spec_from_file_location("io_scene_fbx.s8_private_export_fbx_bin", private_path)
    if spec is None or spec.loader is None:
        fail("S8_PATCH_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        fail(f"S8_PATCH_IMPORT_FAILED:{type(error).__name__}")
    return module


def assert_save_single_signature(exporter: Any) -> tuple[str, ...]:
    try:
        signature = inspect.signature(exporter.save_single)
    except (TypeError, ValueError):
        fail("S8_SAVE_SINGLE_SIGNATURE_INVALID")
    parameter_names = tuple(signature.parameters)
    if not DIRECT_EXPORT_KWARG_NAMES.issubset(set(parameter_names)):
        fail("S8_SAVE_SINGLE_SIGNATURE_INVALID")
    unknown = DIRECT_EXPORT_KWARG_NAMES.difference(parameter_names)
    if unknown:
        fail("S8_SAVE_SINGLE_SIGNATURE_INVALID")
    return parameter_names


def load_payload(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > PAYLOAD_MAX:
        fail("S8_PAYLOAD_SIZE_INVALID")
    if path.read_bytes().startswith(b"\xef\xbb\xbf"):
        fail("S8_PAYLOAD_BOM_FORBIDDEN")
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            value = json.load(
                handle,
                object_pairs_hook=unique_object,
                parse_float=no_float,
                parse_constant=no_float,
            )
    except RuntimeError:
        raise
    except (OSError, UnicodeDecodeError, ValueError):
        fail("S8_PAYLOAD_INVALID")
    if not isinstance(value, dict):
        fail("S8_PAYLOAD_INVALID")
    if set(value) != {"schemaVersion", "profile", "source", "scene", "materials", "objects"}:
        fail("S8_PAYLOAD_UNKNOWN_FIELD")
    if value.get("schemaVersion") != "swooshz-fbx-writer-input-v1" or value.get("profile") != "swooshz-fbx-static-mesh-v1":
        fail("S8_PAYLOAD_PROFILE_INVALID")
    scene = value.get("scene")
    if scene != {"frontAxis": "-Y", "rightAxis": "+X", "rootName": "SWZ_ROOT", "units": "millimetres", "upAxis": "+Z"}:
        fail("S8_SCENE_PROFILE_INVALID")
    objects = value.get("objects")
    materials = value.get("materials")
    if not isinstance(objects, list) or not isinstance(materials, list) or len(objects) > OBJECT_MAX or len(materials) > MATERIAL_MAX:
        fail("S8_PAYLOAD_RESOURCE_LIMIT")
    def depth(item: Any, current: int = 0) -> None:
        if current > SERIALIZED_DEPTH_MAX:
            fail("S8_SERIALIZED_DEPTH_LIMIT")
        if isinstance(item, dict):
            for child in item.values():
                depth(child, current + 1)
        elif isinstance(item, list):
            for child in item:
                depth(child, current + 1)
    depth(value)
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
    patch = load_patch_manifest()
    return {
        "blenderVersion": list(bpy.app.version),
        "blenderVersionString": bpy.app.version_string,
        "blenderBuildHash": build_hash,
        "blenderBinarySha256": sha256(pathlib.Path(bpy.app.binary_path).resolve()),
        "exporterVersion": list(addon_version),
        "exporterFiles": files,
        "privateExporterPatch": patch,
        "platform": sys.platform,
        "pythonVersion": sys.version.split()[0],
    }


def require_factory_filepath() -> None:
    if bpy.data.filepath != "":
        fail("S8_BLENDER_FILEPATH_NOT_EMPTY")


def validate_matrix_ticks(values: Any) -> None:
    if not isinstance(values, list) or len(values) != 16:
        fail("S8_MATRIX_INVALID")
    for value in values:
        integer(value, "S8_MATRIX_INVALID")
    if values[12:] != [0, 0, 0, UNIT_SCALE]:
        fail("S8_MATRIX_INVALID")


def _round_half_up(value: float, scale: int) -> int:
    result = math.floor(value * scale + 0.5)
    if abs(result) > 9_007_199_254_740_991:
        fail("S8_MATRIX_INVALID")
    return 0 if result == 0 else result


def _rotation_from_microdegrees(values: list[int]) -> list[list[float]]:
    rx, ry, rz = (value * math.pi / 180_000_000 for value in values)
    x = [[1.0, 0.0, 0.0], [0.0, math.cos(rx), -math.sin(rx)], [0.0, math.sin(rx), math.cos(rx)]]
    y = [[math.cos(ry), 0.0, math.sin(ry)], [0.0, 1.0, 0.0], [-math.sin(ry), 0.0, math.cos(ry)]]
    z = [[math.cos(rz), -math.sin(rz), 0.0], [math.sin(rz), math.cos(rz), 0.0], [0.0, 0.0, 1.0]]
    def multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
        return [[sum(left[row][k] * right[k][column] for k in range(3)) for column in range(3)] for row in range(3)]
    return multiply(multiply(z, y), x)


def transform_binding(item: dict[str, Any]) -> dict[str, Any]:
    source_object_id = item.get("sourceObjectId")
    source_parent_object_id = item.get("sourceParentObjectId")
    translation = item.get("localTranslationTicks")
    rotation = item.get("sourceEulerMicrodegrees")
    scale = item.get("unitScaleTicks")
    _text(source_object_id, "S8_SOURCE_BINDING_INVALID", 256)
    if source_parent_object_id is not None:
        _text(source_parent_object_id, "S8_SOURCE_BINDING_INVALID", 256)
    if source_object_id != item.get("objectId"):
        fail("S8_SOURCE_BINDING_INVALID")
    for values, code in ((translation, "S8_TRANSLATION_INVALID"), (rotation, "S8_ROTATION_INVALID"), (scale, "S8_SCALE_INVALID")):
        if not isinstance(values, list) or len(values) != 3:
            fail(code)
        for value in values:
            integer(value, code)
    if scale != [UNIT_SCALE, UNIT_SCALE, UNIT_SCALE]:
        fail("S8_SOURCE_SCALE_NOT_RIGID")
    matrix = item.get("matrixTicks")
    validate_matrix_ticks(matrix)
    digest = item.get("transformDigest")
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        fail("S8_TRANSFORM_ORACLE_MISMATCH")
    if matrix[3] != translation[0] or matrix[7] != translation[1] or matrix[11] != translation[2]:
        fail("S8_TRANSFORM_ORACLE_MISMATCH")
    rotation_matrix = _rotation_from_microdegrees(rotation)
    for row in range(3):
        for column in range(3):
            expected = _round_half_up(rotation_matrix[row][column], UNIT_SCALE)
            # Euler microdegree serialization is a bounded redundant check; the
            # translation and bottom row remain exact and catch matrix tampering.
            if abs(matrix[row * 4 + column] - expected) > 20_000:
                fail("S8_TRANSFORM_ORACLE_MISMATCH")
    return {
        "sourceObjectId": source_object_id,
        "sourceParentObjectId": source_parent_object_id,
        "localTranslationTicks": list(translation),
        "sourceEulerMicrodegrees": list(rotation),
        "unitScaleTicks": list(scale),
    }


def _validate_source(source: Any) -> dict[str, str]:
    if not isinstance(source, dict) or set(source) != set(SOURCE_FIELDS):
        fail("S8_SOURCE_INVALID")
    result: dict[str, str] = {}
    for field in SOURCE_FIELDS:
        value = _text(source.get(field), "S8_SOURCE_INVALID", 128)
        if field in SOURCE_HASH_FIELDS and (len(value) != 64 or any(char not in "0123456789abcdef" for char in value)):
            fail("S8_SOURCE_INVALID")
        result[field] = value
    return result


def _validate_materials(materials: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(materials, list) or len(materials) > MATERIAL_MAX:
        fail("S8_MATERIAL_INVALID")
    result: dict[str, dict[str, Any]] = {}
    for item in materials:
        if not isinstance(item, dict) or set(item) != {"materialId", "name", "diffuseRgbTicks", "opacityTicks", "degradationCodes"}:
            fail("S8_MATERIAL_INVALID")
        material_id = _text(item.get("materialId"), "S8_MATERIAL_INVALID", 256)
        name = _text(item.get("name"), "S8_MATERIAL_INVALID", 256, ascii_only=True)
        expected_name = f"SWZ_MAT_{hashlib.sha256(material_id.encode('utf-8')).hexdigest()[:16]}"
        if name != expected_name or material_id in result:
            fail("S8_MATERIAL_INVALID")
        color = item.get("diffuseRgbTicks")
        if not isinstance(color, list) or len(color) != 3:
            fail("S8_MATERIAL_INVALID")
        for component in color:
            value = integer(component, "S8_MATERIAL_INVALID")
            if value < 0 or value > UNIT_SCALE:
                fail("S8_MATERIAL_INVALID")
        if integer(item.get("opacityTicks"), "S8_MATERIAL_INVALID") != UNIT_SCALE:
            fail("S8_MATERIAL_INVALID")
        degradation_codes = item.get("degradationCodes")
        if not isinstance(degradation_codes, list) or any(not isinstance(code, str) or len(code) > 128 for code in degradation_codes):
            fail("S8_MATERIAL_INVALID")
        result[material_id] = item
    return result


def _validate_object_record(item: Any, material_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(item, dict) or set(item) != set(OBJECT_FIELDS):
        fail("S8_OBJECT_INVALID")
    if item.get("nodeKind") != "mesh":
        fail("S8_OBJECT_INVALID")
    name = _text(item.get("name"), "S8_OBJECT_INVALID", 256, ascii_only=True)
    if not name.startswith("SWZ_") or name == "SWZ_ROOT":
        fail("S8_OBJECT_INVALID")
    object_id = _text(item.get("objectId"), "S8_SOURCE_BINDING_INVALID", 256)
    _text(item.get("identityKey"), "S8_OBJECT_INVALID", UTF8_METADATA_MAX)
    parent_name = _text(item.get("parentName"), "S8_HIERARCHY_INVALID", 256, ascii_only=True)
    source_parent_id = item.get("sourceParentObjectId")
    if source_parent_id is not None:
        _text(source_parent_id, "S8_SOURCE_BINDING_INVALID", 256)
    if item.get("materialName") is not None:
        material_name = _text(item.get("materialName"), "S8_MATERIAL_INVALID", 256, ascii_only=True)
        if material_name not in {value["name"] for value in material_by_id.values()}:
            fail("S8_MATERIAL_INVALID")
    if item.get("geometryState") not in {"exact", "bounded_inference"}:
        fail("S8_OBJECT_INVALID")
    round_segments = item.get("roundSegments")
    if round_segments is not None and (integer(round_segments, "S8_OBJECT_INVALID") < 0 or round_segments > 512):
        fail("S8_OBJECT_INVALID")
    if item.get("analyticSagittaTicks") is not None:
        integer(item.get("analyticSagittaTicks"), "S8_OBJECT_INVALID")
    degradation_codes = item.get("degradationCodes")
    if not isinstance(degradation_codes, list) or any(not isinstance(code, str) or len(code) > 128 for code in degradation_codes):
        fail("S8_OBJECT_INVALID")
    if degradation_codes != sorted(degradation_codes, key=_utf8_key):
        fail("S8_OBJECT_INVALID")

    binding = transform_binding(item)
    vertices_raw = item.get("verticesTicks")
    triangles_raw = item.get("triangles")
    normals_raw = item.get("cornerNormalsTicks")
    if not isinstance(vertices_raw, list) or not isinstance(triangles_raw, list) or not isinstance(normals_raw, list):
        fail("S8_MESH_INVALID")
    vertices: list[list[int]] = []
    for vertex in vertices_raw:
        if not isinstance(vertex, list) or len(vertex) != 3:
            fail("S8_VERTEX_INVALID")
        vertices.append([integer(component, "S8_VERTEX_INVALID") for component in vertex])
    faces: list[list[int]] = []
    for triangle in triangles_raw:
        if not isinstance(triangle, list) or len(triangle) != 3:
            fail("S8_TRIANGLE_INVALID")
        face = [integer(index, "S8_TRIANGLE_INVALID") for index in triangle]
        if len(set(face)) != 3 or any(index < 0 or index >= len(vertices) for index in face):
            fail("S8_TRIANGLE_INVALID")
        faces.append(face)
    if len(normals_raw) != len(faces) * 3:
        fail("S8_NORMAL_INVALID")
    normals: list[list[int]] = []
    for normal in normals_raw:
        if not isinstance(normal, list) or len(normal) != 3:
            fail("S8_NORMAL_INVALID")
        normals.append([integer(component, "S8_NORMAL_INVALID") for component in normal])
    if not vertices or not faces:
        fail("S8_MESH_INVALID")
    return {
        "item": item,
        "name": name,
        "objectId": object_id,
        "identityKey": item["identityKey"],
        "parentName": parent_name,
        "sourceParentObjectId": source_parent_id,
        "binding": binding,
        "vertices": vertices,
        "faces": faces,
        "normals": normals,
    }


def _validate_source_graph(records: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    by_source: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for record in records:
        source_id = record["objectId"]
        if source_id == "SWZ_ROOT" or source_id in by_source or record["name"] in by_name:
            fail("S8_HIERARCHY_INVALID")
        by_source[source_id] = record
        by_name[record["name"]] = record
    sorted_ids = sorted(by_source, key=_utf8_key)
    for ordinal, source_id in enumerate(sorted_ids):
        if by_source[source_id]["name"] != _stable_object_name(ordinal, source_id):
            fail("S8_SOURCE_BINDING_INVALID")
    expected_parent_by_name: dict[str, str] = {}
    for record in records:
        parent_id = record["sourceParentObjectId"]
        if parent_id is None:
            expected = "SWZ_ROOT"
        else:
            parent = by_source.get(parent_id)
            if parent is None:
                fail("S8_HIERARCHY_INVALID")
            expected = parent["name"]
        if record["parentName"] != expected:
            fail("S8_HIERARCHY_INVALID")
        expected_parent_by_name[record["name"]] = expected

    for record in records:
        current: str | None = record["objectId"]
        seen: set[str] = set()
        depth = 0
        while current is not None:
            if current in seen:
                fail("S8_HIERARCHY_CYCLE")
            seen.add(current)
            current_record = by_source.get(current)
            if current_record is None:
                fail("S8_HIERARCHY_INVALID")
            depth += 1
            if depth > PHYSICAL_DEPTH_MAX:
                fail("S8_HIERARCHY_DEPTH_LIMIT")
            current = current_record["sourceParentObjectId"]
    return by_source, expected_parent_by_name


def admit_payload(payload: dict[str, Any]) -> dict[str, Any]:
    source = _validate_source(payload.get("source"))
    material_by_id = _validate_materials(payload.get("materials"))
    objects = payload.get("objects")
    if not isinstance(objects, list) or len(objects) > OBJECT_MAX:
        fail("S8_PAYLOAD_RESOURCE_LIMIT")
    records = [_validate_object_record(item, material_by_id) for item in objects]
    by_source, expected_parent_by_name = _validate_source_graph(records)
    if len({record["name"] for record in records}) != len(records):
        fail("S8_HIERARCHY_INVALID")
    control_points = sum(len(record["vertices"]) for record in records)
    triangles = sum(len(record["faces"]) for record in records)
    if control_points > CONTROL_POINT_MAX or triangles > TRIANGLE_MAX:
        fail("S8_RESOURCE_LIMIT")
    return {
        "payload": payload,
        "source": source,
        "materials": material_by_id,
        "records": records,
        "record_by_source": by_source,
        "expected_parent_by_name": expected_parent_by_name,
        "physical_names": frozenset(record["name"] for record in records),
        "expected_names": frozenset({"SWZ_ROOT", *(record["name"] for record in records)}),
        "control_points": control_points,
        "triangles": triangles,
    }


def build_materials(payload: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for item in payload["materials"]:
        material = bpy.data.materials.new(item["name"])
        material.use_nodes = False
        rgb = [component / UNIT_SCALE for component in item["diffuseRgbTicks"]]
        material.diffuse_color = (*rgb, 1.0)
        material.specular_intensity = 0.0
        material.roughness = 1.0
        result[item["name"]] = material
    return result


def _remove_all(collection: Any) -> None:
    for item in list(collection):
        try:
            collection.remove(item, do_unlink=True)
        except TypeError:
            collection.remove(item)


def clear_factory_scene() -> None:
    _remove_all(bpy.data.objects)
    for collection_name in ("meshes", "materials", "curves", "cameras", "lights"):
        collection = getattr(bpy.data, collection_name, None)
        if collection is not None:
            _remove_all(collection)


def _neutral_object_state(obj: Any) -> None:
    obj.rotation_mode = "XYZ"
    obj.delta_location = (0.0, 0.0, 0.0)
    obj.delta_rotation_euler = (0.0, 0.0, 0.0)
    obj.delta_scale = (1.0, 1.0, 1.0)
    obj.scale = (1.0, 1.0, 1.0)
    obj.hide_viewport = False
    obj.hide_render = False
    obj.hide_select = False
    obj.instance_type = "NONE"
    if getattr(obj, "type", None) == "EMPTY":
        obj.instance_collection = None
    if hasattr(obj, "active_material_index"):
        obj.active_material_index = 0


def construct_scene(admission: dict[str, Any]) -> dict[str, Any]:
    clear_factory_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"

    root = bpy.data.objects.new("SWZ_ROOT", None)
    scene.collection.objects.link(root)
    root.parent = None
    root.location = (0.0, 0.0, 0.0)
    root.rotation_mode = "XYZ"
    root.rotation_euler = (0.0, 0.0, 0.0)
    root.scale = (1.0, 1.0, 1.0)
    root.matrix_parent_inverse = Matrix.Identity(4)
    _neutral_object_state(root)
    root["swz_profile"] = "swooshz-fbx-static-mesh-v1"
    for key, value in admission["source"].items():
        root[f"swz_{key}"] = value

    materials = build_materials(admission["payload"])
    objects: dict[str, Any] = {"SWZ_ROOT": root}
    transform_table: dict[str, dict[str, Any]] = {
        "SWZ_ROOT": {
            "sourceObjectId": "SWZ_ROOT",
            "sourceParentObjectId": None,
            "localTranslationTicks": [0, 0, 0],
            "sourceEulerMicrodegrees": [0, 0, 0],
            "unitScaleTicks": [UNIT_SCALE, UNIT_SCALE, UNIT_SCALE],
            "matrixTicks": [UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE, 0, 0, 0, 0, UNIT_SCALE],
            "transformDigest": hashlib.sha256(b"SWZ_ROOT").hexdigest(),
        }
    }

    for record in admission["records"]:
        item = record["item"]
        mesh = bpy.data.meshes.new(f"{record['name']}_MESH")
        vertices = [tuple(component / POSITION_SCALE for component in vertex) for vertex in record["vertices"]]
        faces = [tuple(face) for face in record["faces"]]
        mesh.from_pydata(vertices, [], faces)
        mesh.update(calc_edges=True)
        if len(mesh.polygons) != len(faces) or any(len(polygon.vertices) != 3 for polygon in mesh.polygons):
            fail("S8_BLENDER_TOPOLOGY_CHANGED")
        normals = [tuple(component / UNIT_SCALE for component in normal) for normal in record["normals"]]
        mesh.normals_split_custom_set(normals)
        for polygon in mesh.polygons:
            polygon.use_smooth = False
        obj = bpy.data.objects.new(record["name"], mesh)
        scene.collection.objects.link(obj)
        obj["swz_object_id"] = item["objectId"]
        obj["swz_identity_key"] = item["identityKey"]
        obj["swz_geometry_state"] = item["geometryState"]
        obj["swz_degradation_codes"] = ",".join(item["degradationCodes"])
        if item["materialName"] is not None:
            mesh.materials.append(materials[item["materialName"]])
        _neutral_object_state(obj)
        objects[record["name"]] = obj
        transform_table[record["name"]] = record["binding"]

    for record in admission["records"]:
        obj = objects[record["name"]]
        parent = objects[admission["expected_parent_by_name"][record["name"]]]
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.location = tuple(value / POSITION_SCALE for value in record["binding"]["localTranslationTicks"])
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = tuple(value / 1_000_000 * math.pi / 180 for value in record["binding"]["sourceEulerMicrodegrees"])
        obj.scale = (1.0, 1.0, 1.0)

    if set(objects) != admission["expected_names"] or len(list(bpy.data.objects)) != len(admission["expected_names"]):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    return {
        "scene": scene,
        "root": root,
        "objects": objects,
        "transform_table": transform_table,
        "control_points": admission["control_points"],
        "triangles": admission["triangles"],
    }


def _as_tuple(value: Any) -> tuple[Any, ...]:
    try:
        return tuple(value)
    except TypeError:
        fail("S8_EXPORT_OBJECT_SET_INVALID")


def _assert_neutral_object(obj: Any, is_root: bool) -> None:
    if _as_tuple(getattr(obj, "delta_location", ())) != (0.0, 0.0, 0.0):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if _as_tuple(getattr(obj, "delta_rotation_euler", ())) != (0.0, 0.0, 0.0):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if _as_tuple(getattr(obj, "delta_scale", ())) != (1.0, 1.0, 1.0):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if _as_tuple(getattr(obj, "scale", ())) != (1.0, 1.0, 1.0):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if getattr(obj, "rotation_mode", None) != "XYZ":
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if bool(getattr(obj, "hide_viewport", False)) or bool(getattr(obj, "hide_render", False)) or bool(getattr(obj, "hide_select", False)):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if getattr(obj, "instance_type", "NONE") != "NONE" or getattr(obj, "instance_collection", None) is not None:
        fail("S8_EXPORT_INSTANCE_FORBIDDEN")
    if getattr(obj, "library", None) is not None or getattr(obj, "override_library", None) is not None:
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if len(getattr(obj, "modifiers", ())) or len(getattr(obj, "constraints", ())) or len(getattr(obj, "particle_systems", ())):
        fail("S8_EXPORT_INSTANCE_FORBIDDEN")
    if getattr(obj, "animation_data", None) is not None:
        fail("S8_EXPORT_HIDDEN_STATE")
    data = getattr(obj, "data", None)
    if data is not None:
        if getattr(data, "shape_keys", None) is not None or getattr(data, "animation_data", None) is not None:
            fail("S8_EXPORT_HIDDEN_STATE")
        if getattr(data, "library", None) is not None or getattr(data, "override_library", None) is not None:
            fail("S8_EXPORT_HIDDEN_STATE")
    if [key for key in obj.keys() if not str(key).startswith("swz_")]:
        fail("S8_EXPORT_HIDDEN_STATE")
    parent_inverse = getattr(obj, "matrix_parent_inverse", None)
    if parent_inverse is not None:
        expected_inverse = Matrix.Identity(4)
        if any(float(parent_inverse[row][column]) != float(expected_inverse[row][column]) for row in range(4) for column in range(4)):
            fail("S8_EXPORT_HIDDEN_STATE")
    if getattr(obj, "mode", "OBJECT") != "OBJECT":
        fail("S8_EXPORT_HIDDEN_STATE")
    if is_root:
        if getattr(obj, "type", None) != "EMPTY" or getattr(obj, "parent", None) is not None:
            fail("S8_HIERARCHY_INVALID")
        if _as_tuple(getattr(obj, "location", ())) != (0.0, 0.0, 0.0) or _as_tuple(getattr(obj, "rotation_euler", ())) != (0.0, 0.0, 0.0):
            fail("S8_HIERARCHY_INVALID")
    elif getattr(obj, "type", None) != "MESH":
        fail("S8_EXPORT_OBJECT_SET_INVALID")


def _original_object(obj: Any) -> Any:
    original = getattr(obj, "original", None)
    return original if original is not None else obj


def _surface_map(surface: Any) -> dict[str, Any]:
    if surface is None:
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    result: dict[str, Any] = {}
    try:
        values = list(surface)
    except TypeError:
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    for obj in values:
        name = getattr(obj, "name", None)
        if not isinstance(name, str) or name in result:
            fail("S8_EXPORT_OBJECT_SET_INVALID")
        result[name] = obj
    return result


def _assert_surface_identity(surface: Any, expected: dict[str, Any], use_original: bool = False) -> None:
    actual = _surface_map(surface)
    if set(actual) != set(expected):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    for name, expected_object in expected.items():
        actual_object = _original_object(actual[name]) if use_original else actual[name]
        if actual_object is not expected_object:
            fail("S8_EXPORT_OBJECT_SET_INVALID")


def _evaluated_view_layer_objects(depsgraph: Any) -> Any:
    view_layer = getattr(depsgraph, "view_layer", None)
    if view_layer is not None and hasattr(view_layer, "objects"):
        return view_layer.objects
    graph_objects = getattr(depsgraph, "objects", None)
    if graph_objects is not None:
        return graph_objects
    fail("S8_EXPORT_OBJECT_SET_INVALID")


def audit_hierarchy(admission: dict[str, Any], objects: dict[str, Any]) -> None:
    root = objects.get("SWZ_ROOT")
    if root is None:
        fail("S8_HIERARCHY_INVALID")
    _assert_neutral_object(root, True)
    for record in admission["records"]:
        obj = objects.get(record["name"])
        expected_parent_name = admission["expected_parent_by_name"].get(record["name"])
        if obj is None or expected_parent_name is None:
            fail("S8_HIERARCHY_INVALID")
        expected_parent = objects.get(expected_parent_name)
        if expected_parent is None or getattr(obj, "parent", None) is not expected_parent:
            fail("S8_HIERARCHY_INVALID")
        _assert_neutral_object(obj, False)


def audit_original_scene(admission: dict[str, Any], state: dict[str, Any]) -> None:
    expected = state["objects"]
    _assert_surface_identity(bpy.context.scene.objects, expected)
    _assert_surface_identity(bpy.context.view_layer.objects, expected)
    _assert_surface_identity(bpy.data.objects, expected)
    if set(state["transform_table"]) != set(expected):
        fail("S8_EXPORT_TABLE_MISMATCH")
    audit_hierarchy(admission, expected)


def audit_evaluated_membership(admission: dict[str, Any], state: dict[str, Any], depsgraph: Any) -> None:
    expected = state["objects"]
    _assert_surface_identity(bpy.context.scene.objects, expected)
    _assert_surface_identity(_evaluated_view_layer_objects(depsgraph), expected, use_original=True)
    _assert_surface_identity(bpy.data.objects, expected)
    audit_hierarchy(admission, expected)

    instances = getattr(depsgraph, "object_instances", None)
    if instances is not None:
        seen: list[Any] = []
        for instance in list(instances):
            if bool(getattr(instance, "is_instance", False)):
                fail("S8_EXPORT_INSTANCE_FORBIDDEN")
            candidate = _original_object(getattr(instance, "object", None))
            if not any(candidate is value for value in expected.values()) or any(candidate is prior for prior in seen):
                fail("S8_EXPORT_INSTANCE_FORBIDDEN")
            seen.append(candidate)
        if {getattr(obj, "name", None) for obj in seen} != set(expected):
            fail("S8_EXPORT_OBJECT_SET_INVALID")


def audit_exporter_discovery(exporter: Any, context_objects: tuple[Any, ...], depsgraph: Any) -> None:
    wrapper_type = getattr(exporter, "ObjectWrapper", None)
    if wrapper_type is None:
        fail("S8_EXPORTER_DISCOVERY_INVALID")
    for obj in context_objects:
        try:
            discovered = wrapper_type(obj).dupli_list_gen(depsgraph)
        except (AttributeError, TypeError):
            fail("S8_EXPORTER_DISCOVERY_INVALID")
        for _ in discovered:
            fail("S8_EXPORT_INSTANCE_FORBIDDEN")


def build_context_objects(objects: dict[str, Any]) -> tuple[Any, ...]:
    if not isinstance(objects, dict) or not objects:
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    ordered = tuple(sorted(objects.values(), key=lambda obj: obj.name))
    if len({id(obj) for obj in ordered}) != len(ordered):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if [obj.name for obj in ordered] != sorted((obj.name for obj in ordered)):
        fail("S8_EXPORT_OBJECT_ORDER_INVALID")
    return ordered


def assert_membership(admission: dict[str, Any], state: dict[str, Any], depsgraph: Any, context_objects: Any) -> None:
    expected = state["objects"]
    transform_table = state["transform_table"]
    if set(expected) != set(admission["expected_names"]):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if set(transform_table) != set(admission["expected_names"]):
        fail("S8_EXPORT_TABLE_MISMATCH")
    if not isinstance(context_objects, tuple):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    if len(context_objects) != len(expected) or {obj.name for obj in context_objects} != set(expected):
        fail("S8_EXPORT_OBJECT_SET_INVALID")
    expected_order = sorted(expected)
    if [obj.name for obj in context_objects] != expected_order:
        fail("S8_EXPORT_OBJECT_ORDER_INVALID")
    for obj in context_objects:
        if expected.get(obj.name) is not obj:
            fail("S8_EXPORT_OBJECT_SET_INVALID")
    _assert_surface_identity(bpy.context.scene.objects, expected)
    _assert_surface_identity(_evaluated_view_layer_objects(depsgraph), expected, use_original=True)
    _assert_surface_identity(bpy.data.objects, expected)


def export_fbx(
    path: pathlib.Path,
    exporter: Any,
    scene: Any,
    depsgraph: Any,
    context_objects: tuple[Any, ...],
    transform_table: dict[str, dict[str, Any]],
) -> None:
    class Operator:
        def report(self, *_args: Any) -> None:
            return None

    kwargs = {
        "filepath": str(path),
        "global_matrix": Matrix.Identity(4),
        "context_objects": context_objects,
        "s8_transform_table": transform_table,
        "apply_unit_scale": True,
        "global_scale": 1.0,
        "apply_scale_options": "FBX_SCALE_UNITS",
        "axis_up": "Z",
        "axis_forward": "Y",
        "object_types": {"EMPTY", "MESH"},
        "use_mesh_modifiers": False,
        "use_mesh_modifiers_render": False,
        "mesh_smooth_type": "OFF",
        "use_subsurf": False,
        "use_armature_deform_only": False,
        "bake_anim": False,
        "bake_anim_use_all_bones": False,
        "bake_anim_use_nla_strips": False,
        "bake_anim_use_all_actions": False,
        "bake_anim_step": 1.0,
        "bake_anim_simplify_factor": 1.0,
        "bake_anim_force_startend_keying": False,
        "add_leaf_bones": False,
        "primary_bone_axis": "Y",
        "secondary_bone_axis": "X",
        "use_metadata": False,
        "path_mode": "STRIP",
        "use_mesh_edges": False,
        "use_tspace": False,
        "use_triangles": False,
        "embed_textures": False,
        "use_custom_props": True,
        "bake_space_transform": False,
        "armature_nodetype": "NULL",
        "colors_type": "NONE",
        "prioritize_active_color": False,
    }
    if set(kwargs) != DIRECT_EXPORT_KWARG_NAMES:
        fail("S8_SAVE_SINGLE_SIGNATURE_INVALID")
    result = exporter.save_single(Operator(), scene, depsgraph, **kwargs)
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
    exporter = load_private_exporter()
    assert_save_single_signature(exporter)
    require_factory_filepath()
    admission = admit_payload(payload)

    state = construct_scene(admission)
    bpy.context.view_layer.update()
    audit_original_scene(admission, state)
    authoritative_depsgraph = bpy.context.evaluated_depsgraph_get()
    audit_evaluated_membership(admission, state, authoritative_depsgraph)
    context_objects = build_context_objects(state["objects"])
    audit_exporter_discovery(exporter, context_objects, authoritative_depsgraph)
    assert_membership(admission, state, authoritative_depsgraph, context_objects)

    export_fbx(
        artifact_path,
        exporter,
        state["scene"],
        authoritative_depsgraph,
        context_objects,
        state["transform_table"],
    )
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
        "controlPointCount": state["control_points"],
        "triangleCount": state["triangles"],
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
