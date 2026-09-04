"""Independent S8 native Max readback AppBundle entry point.

The validator is intended for a fresh Autodesk 3ds Max Python 3 process. It
opens the exact .max output and reads the native scene through pymxs only.
"""

import datetime
import hashlib
import json
import math
from pathlib import Path

from pymxs import runtime as rt


PAYLOAD_NAME = "swooshz-s8-payload.json"
OUTPUT_NAME = "swooshz-s8-model.max"
BINDING_NAME = "s8-engine-binding.json"
ARTIFACT_ID_NAME = "s8-artifact-id.txt"
READBACK_NAME = "s8-max-readback.json"
MAX_PAYLOAD_BYTES = 2_000_000
MAX_NATIVE_BYTES = 256 * 1024 * 1024


def fail(code):
    raise RuntimeError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def require_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail("S8_PAYLOAD_INVALID")
    return value


def read_json(path):
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("S8_READBACK_INPUT_INVALID")


def user_prop(node, key):
    value = rt.getUserProp(node, key)
    if not isinstance(value, str):
        fail("S8_SOURCE_METADATA_INVALID")
    return value


def maybe_user_prop(node, key):
    value = rt.getUserProp(node, key)
    return value if isinstance(value, str) else None


def point(value):
    return {"x": float(value.x), "y": float(value.y), "z": float(value.z)}


def matrix(value):
    raw = {"rows": [point(value.row1), point(value.row2), point(value.row3)], "translation": point(value.translation)}
    return {"rows": [{"x": quantize_matrix_value(row["x"]), "y": quantize_matrix_value(row["y"]), "z": quantize_matrix_value(row["z"])} for row in raw["rows"]], "translation": {"x": quantize_matrix_value(raw["translation"]["x"]), "y": quantize_matrix_value(raw["translation"]["y"]), "z": quantize_matrix_value(raw["translation"]["z"])}}


def round_half_away_from_zero(value):
    magnitude = math.floor(abs(value))
    fraction = abs(value) - magnitude
    rounded = magnitude + (1 if fraction >= 0.5 else 0)
    return -rounded if value < 0 else rounded


def quantize_matrix_value(value):
    if abs(value) < 1e-12:
        return 0
    return round_half_away_from_zero(value * 1000000.0) / 1000000.0


def quantize_mm(value):
    return round_half_away_from_zero(value * 10.0) / 10.0


def quantized_point(value):
    raw = point(value)
    return {axis: quantize_mm(raw[axis]) for axis in ("x", "y", "z")}


def apply_matrix(value, matrix_value):
    rows = matrix_value["rows"]
    translation = matrix_value["translation"]
    return {
        "x": value["x"] * rows[0]["x"] + value["y"] * rows[1]["x"] + value["z"] * rows[2]["x"] + translation["x"],
        "y": value["x"] * rows[0]["y"] + value["y"] * rows[1]["y"] + value["z"] * rows[2]["y"] + translation["y"],
        "z": value["x"] * rows[0]["z"] + value["y"] * rows[1]["z"] + value["z"] * rows[2]["z"] + translation["z"],
    }


def bounds(vertices):
    if not vertices:
        fail("S8_MESH_INVALID")
    minimum = {axis: vertices[0][axis] for axis in ("x", "y", "z")}
    maximum = {axis: vertices[0][axis] for axis in ("x", "y", "z")}
    for value in vertices[1:]:
        for axis in ("x", "y", "z"):
            minimum[axis] = min(minimum[axis], value[axis])
            maximum[axis] = max(maximum[axis], value[axis])
    return {"min": minimum, "max": maximum}


def dimensions(bounds_value):
    return {
        "widthMm": quantize_mm(bounds_value["max"]["x"] - bounds_value["min"]["x"]),
        "depthMm": quantize_mm(bounds_value["max"]["y"] - bounds_value["min"]["y"]),
        "heightMm": quantize_mm(bounds_value["max"]["z"] - bounds_value["min"]["z"]),
    }


def mesh_readback(node):
    vertex_count = rt.polyOp.getNumVerts(node)
    face_count = rt.polyOp.getNumFaces(node)
    if vertex_count <= 0 or vertex_count > 96 or face_count <= 0 or face_count > 128:
        fail("S8_MESH_INVALID")
    vertices = [quantized_point(rt.polyOp.getVert(node, index)) for index in range(1, vertex_count + 1)]
    faces = []
    for index in range(1, face_count + 1):
        face_value = rt.polyOp.getFace(node, index)
        face = [int(face_value.x), int(face_value.y), int(face_value.z)]
        if len(set(face)) != 3 or any(vertex < 1 or vertex > vertex_count for vertex in face):
            fail("S8_MESH_INVALID")
        ab = (vertices[face[1] - 1]["x"] - vertices[face[0] - 1]["x"], vertices[face[1] - 1]["y"] - vertices[face[0] - 1]["y"], vertices[face[1] - 1]["z"] - vertices[face[0] - 1]["z"])
        ac = (vertices[face[2] - 1]["x"] - vertices[face[0] - 1]["x"], vertices[face[2] - 1]["y"] - vertices[face[0] - 1]["y"], vertices[face[2] - 1]["z"] - vertices[face[0] - 1]["z"])
        normal = (ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0])
        if math.sqrt(sum(component * component for component in normal)) <= 1e-5:
            fail("S8_MESH_INVALID")
        faces.append(face)
    return {"vertices": vertices, "faces": faces}


def material_semantic(material_ref, object_id):
    material = material_ref or {
        "materialId": "s8-default-%s" % hashlib.sha256(object_id.encode("utf-8")).hexdigest()[:12],
        "finishKind": "unknown",
        "colorHex": "#808080",
    }
    degradation = []
    if not material.get("colorHex"):
        degradation.append("S8_MATERIAL_COLOR_UNSPECIFIED")
    degradation.append("S8_MATERIAL_ROUGHNESS_UNSPECIFIED")
    if material.get("finishKind") == "glass_like":
        degradation.append("S8_MATERIAL_TRANSPARENCY_UNSPECIFIED")
    if material.get("finishKind") == "unknown":
        degradation.append("S8_MATERIAL_FINISH_UNSPECIFIED")
    return {
        "materialId": material["materialId"],
        "baseColorHex": (material.get("colorHex") or "#808080").lower(),
        "metalness": 1 if material.get("finishKind") == "metal_like" else 0,
        "roughness": 0.5,
        "transparency": 0.25 if material.get("finishKind") == "glass_like" else 0.0,
        "emission": 0.0,
        "degradationCodes": degradation,
    }


def material_readback(node, material_ref, object_id):
    material = node.material
    if material is None or "Physical" not in str(rt.classOf(material)):
        fail("S8_MATERIAL_CLASS_INVALID")
    base = material.base_color
    base_color = "#%02x%02x%02x" % (int(base.r), int(base.g), int(base.b))
    emit = material.emit_color
    if any(int(channel) != 0 for channel in (emit.r, emit.g, emit.b)):
        fail("S8_MATERIAL_VALUE_INVALID")
    expected = material_semantic(material_ref, object_id)
    finish = {
        "materialId": expected["materialId"],
        "nativeClass": "PhysicalMaterial",
        "baseColorHex": base_color,
        "metalness": int(round(float(material.metalness))),
        "roughness": float(material.roughness),
        "transparency": float(material.transparency),
        "emission": 0.0,
        "degradationCodes": [user_prop(node, "s8.degradationCode")],
    }
    if finish["baseColorHex"] != expected["baseColorHex"] or finish["metalness"] != expected["metalness"] or abs(finish["roughness"] - expected["roughness"]) > 1e-6 or abs(finish["transparency"] - expected["transparency"]) > 1e-6 or abs(finish["emission"] - expected["emission"]) > 1e-6 or finish["degradationCodes"] != [",".join(expected["degradationCodes"])]:
        fail("S8_MATERIAL_VALUE_INVALID")
    return finish


def node_name(object_id, identity_key):
    value = "S8__OBJ__%s__I__%s" % (object_id, hashlib.sha256(identity_key.encode("utf-8")).hexdigest()[:12])
    if len(value) > 120:
        fail("S8_IDENTITY_COLLISION")
    return value


def semantic_node(node, root, expected, material_refs, source_revision_id):
    native_class = str(rt.classOf(node.baseObject))
    if native_class != "Editable_Poly":
        fail("S8_NATIVE_CLASS_INVALID")
    object_id = user_prop(node, "s8.objectId")
    parent_id = user_prop(node, "s8.parentObjectId") or None
    if parent_id is None and node.parent != root:
        fail("S8_HIERARCHY_INVALID")
    if parent_id is not None and (node.parent is None or maybe_user_prop(node.parent, "s8.objectId") != parent_id):
        fail("S8_HIERARCHY_INVALID")
    required = {
        "s8.objectId": object_id,
        "s8.identityKey": user_prop(node, "s8.identityKey"),
        "s8.parentObjectId": user_prop(node, "s8.parentObjectId"),
        "s8.semanticRole": user_prop(node, "s8.semanticRole"),
        "s8.semanticType": user_prop(node, "s8.semanticType"),
        "s8.geometryFamily": user_prop(node, "s8.geometryFamily"),
        "s8.sourceRevisionId": user_prop(node, "s8.sourceRevisionId"),
        "s8.degradationCode": user_prop(node, "s8.degradationCode"),
    }
    if object_id != expected["objectId"] or str(node.name) != node_name(expected["objectId"], expected["identityKey"]) or required["s8.identityKey"] != expected["identityKey"] or required["s8.semanticRole"] != expected["role"] or required["s8.semanticType"] != expected["objectType"] or required["s8.geometryFamily"] != expected["geometry"]["kind"] or required["s8.sourceRevisionId"] != source_revision_id:
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    mesh = mesh_readback(node)
    local_bounds = bounds(mesh["vertices"])
    world_matrix = matrix(node.objectTransform)
    world_bounds = bounds([apply_matrix(vertex, world_matrix) for vertex in mesh["vertices"]])
    local_dimensions = dimensions(local_bounds)
    expected_dimensions = expected["boundsMm"]
    if any(abs(local_dimensions[key] - expected_dimensions[key]) > 0.1 for key in ("widthMm", "depthMm", "heightMm")):
        fail("S8_BOUNDS_MISMATCH")
    return {
        "nodeKind": "geometry", "objectId": object_id, "name": str(node.name), "parentObjectId": parent_id,
        "nativeGeometryClass": "Editable_Poly", "geometryFamily": required["s8.geometryFamily"],
        "mesh": mesh, "localTransform": matrix(node.transform), "worldTransform": world_matrix,
        "localBoundsMm": expected_dimensions, "worldBoundsMm": {"min": {key: quantize_mm(value) for key, value in world_bounds["min"].items()}, "max": {key: quantize_mm(value) for key, value in world_bounds["max"].items()}},
        "material": material_readback(node, material_refs.get(expected["materialIds"][0]) if expected.get("materialIds") else None, object_id), "userProperties": required,
    }


def read_binding(path, payload_hash, stamp_hash):
    binding = read_json(path)
    require_keys(binding, ("sourceStampDigest", "payloadSha256", "generationAppBundleId", "generationAppBundleVersion", "generationAppBundleHash", "generationActivityId", "generationActivityVersion", "generationActivityHash", "validatorAppBundleId", "validatorAppBundleVersion", "validatorAppBundleHash", "validatorActivityId", "validatorActivityVersion", "validatorActivityHash", "engineId", "productVersion", "engineVersion", "constructionAlgorithmVersion", "semanticAlgorithmVersion"))
    if binding["sourceStampDigest"] != stamp_hash or binding["payloadSha256"] != payload_hash:
        fail("S8_TOOL_BINDING_INVALID")
    for value in binding.values():
        if not isinstance(value, str) or not value or value == "latest" or any(character in value for character in "\\/\r\n"):
            fail("S8_TOOL_BINDING_INVALID")
    for key in ("sourceStampDigest", "payloadSha256", "generationAppBundleHash", "generationActivityHash", "validatorAppBundleHash", "validatorActivityHash"):
        if len(binding[key]) != 64 or any(character not in "0123456789abcdef" for character in binding[key]):
            fail("S8_TOOL_BINDING_INVALID")
    if binding["constructionAlgorithmVersion"] != "s8-max-scene-construction-v1" or binding["semanticAlgorithmVersion"] != "s8-max-semantic-v1":
        fail("S8_TOOL_BINDING_INVALID")
    return binding


def read_artifact_id(path):
    try:
        value = path.read_text(encoding="ascii").strip().lower()
    except (OSError, UnicodeDecodeError):
        fail("S8_ARTIFACT_ID_REQUIRED")
    if len(value) != 36 or value[8] != "-" or value[13] != "-" or value[18] != "-" or value[23] != "-" or any(character not in "0123456789abcdef-" for character in value) or value[14] != "4" or value[19] not in "89ab":
        fail("S8_ARTIFACT_ID_INVALID")
    return value


def root_readback(root):
    return {
        "nodeKind": "root", "objectId": None, "name": str(root.name), "parentObjectId": None,
        "nativeGeometryClass": "Dummy", "geometryFamily": None, "mesh": None,
        "localTransform": matrix(root.transform), "worldTransform": matrix(root.objectTransform),
        "localBoundsMm": None, "worldBoundsMm": None, "material": None,
        "userProperties": {
            "s8.sourceStampDigest": user_prop(root, "s8.sourceStampDigest"),
            "s8.payloadDigest": user_prop(root, "s8.payloadDigest"),
            "s8.constructionAlgorithmVersion": user_prop(root, "s8.constructionAlgorithmVersion"),
            "s8.projectId": user_prop(root, "s8.projectId"),
        },
    }


def ordered_objects(objects):
    by_id = {item["objectId"]: item for item in objects}
    depths = {}

    def depth(object_id, visiting):
        if object_id in depths:
            return depths[object_id]
        if object_id in visiting or object_id not in by_id:
            fail("S8_HIERARCHY_INVALID")
        visiting.add(object_id)
        parent = by_id[object_id].get("parentObjectId")
        value = 1 if parent is None else depth(parent, visiting) + 1
        visiting.remove(object_id)
        if value > 64:
            fail("S8_RESOURCE_LIMIT")
        depths[object_id] = value
        return value

    indexed = [(depth(item["objectId"], set()), index, item) for index, item in enumerate(objects)]
    indexed.sort(key=lambda value: (value[0], value[1]))
    return [item[2] for item in indexed]


def main():
    working = Path.cwd()
    payload_path = working / PAYLOAD_NAME
    artifact_path = working / OUTPUT_NAME
    payload_bytes = payload_path.read_bytes()
    if len(payload_bytes) > MAX_PAYLOAD_BYTES or not artifact_path.exists() or artifact_path.stat().st_size <= 0 or artifact_path.stat().st_size > MAX_NATIVE_BYTES:
        fail("S8_RESOURCE_LIMIT")
    payload = read_json(payload_path)
    require_keys(payload, ("schemaVersion", "sourceStamp", "s6Handoff", "construction"))
    if payload["schemaVersion"] != "s8.max.payload-v1":
        fail("S8_PAYLOAD_INVALID")
    payload_hash = digest(payload_bytes)
    stamp_hash = digest(canonical(payload["sourceStamp"]).encode("utf-8"))
    binding = read_binding(working / BINDING_NAME, payload_hash, stamp_hash)
    artifact_id = read_artifact_id(working / ARTIFACT_ID_NAME)
    rt.resetMaxFile(rt.Name("noprompt"))
    if not rt.loadMaxFile(str(artifact_path), useFileUnits=True, quiet=True):
        fail("APS_OUTPUT_MISSING")
    try:
        if "metric" not in str(rt.units.SystemType).lower() or "millimeter" not in str(rt.units.MetricType).lower():
            fail("S8_UNITS_INVALID")
        if rt.maxVersion() is None:
            fail("S8_SUPPORTED_SAVE_VERSION")
    except RuntimeError:
        raise
    except Exception:
        fail("S8_SUPPORTED_SAVE_VERSION")
    all_nodes = list(rt.objects)
    root_candidates = [node for node in all_nodes if maybe_user_prop(node, "s8.sourceStampDigest") == stamp_hash]
    if len(root_candidates) != 1:
        fail("S8_SOURCE_METADATA_INVALID")
    root = root_candidates[0]
    generation_properties = {
        "s8.engineId": "engineId", "s8.productVersion": "productVersion", "s8.engineVersion": "engineVersion",
        "s8.generationAppBundleId": "generationAppBundleId", "s8.generationAppBundleVersion": "generationAppBundleVersion", "s8.generationAppBundleHash": "generationAppBundleHash",
        "s8.generationActivityId": "generationActivityId", "s8.generationActivityVersion": "generationActivityVersion", "s8.generationActivityHash": "generationActivityHash",
    }
    if str(rt.classOf(root.baseObject)) != "Dummy" or user_prop(root, "s8.payloadDigest") != payload_hash or user_prop(root, "s8.projectId") != payload["sourceStamp"]["projectId"] or user_prop(root, "s8.artifactId") != artifact_id or any(user_prop(root, key) != binding[binding_key] for key, binding_key in generation_properties.items()):
        fail("S8_SOURCE_METADATA_INVALID")
    geometry_nodes = [node for node in all_nodes if node != root and maybe_user_prop(node, "s8.objectId") is not None]
    if len(all_nodes) != len(geometry_nodes) + 1:
        fail("S8_EXTRA_SCENE_NODE")
    expected_objects = payload["s6Handoff"]["objects"]
    if len(geometry_nodes) != len(expected_objects):
        fail("S8_OBJECT_COUNT_INVALID")
    expected_ids = {item["objectId"] for item in expected_objects}
    actual_ids = {user_prop(node, "s8.objectId") for node in geometry_nodes}
    if actual_ids != expected_ids:
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    if rt.xrefs.getXRefFileCount() != 0 or len(rt.getClassInstances(rt.TextureMap)) != 0:
        fail("S8_EXTERNAL_DEPENDENCY")
    material_refs = {item["materialId"]: item for item in payload["s6Handoff"].get("materials", [])}
    nodes_by_id = {user_prop(node, "s8.objectId"): node for node in geometry_nodes}
    if len(nodes_by_id) != len(geometry_nodes):
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    geometry_readback = [semantic_node(nodes_by_id[item["objectId"]], root, item, material_refs, payload["sourceStamp"]["s6RevisionId"]) for item in ordered_objects(expected_objects)]
    nodes = [root_readback(root)] + geometry_readback
    readback = {
        "schemaVersion": "s8-max-readback-v1", "projectId": payload["sourceStamp"]["projectId"], "artifactId": artifact_id,
        "sourceStampDigest": stamp_hash, "payloadSha256": payload_hash, "binding": binding, "artifactSha256": digest(artifact_path.read_bytes()), "artifactByteSize": artifact_path.stat().st_size,
        "units": "millimetres", "axisConvention": "s6-to-max-x-right-zup-minus-yfront-v1", "objectCount": len(geometry_readback), "nodes": nodes,
        "checks": ["artifact-source-binding", "engine-tool-binding", "millimetre-units", "object-count", "identity-hierarchy", "editable-poly", "vertices-faces", "local-world-transforms", "bounds-dimensions", "materials-degradation", "source-metadata", "no-xrefs-textures-missing-dependencies", "supported-save-version"],
        "externalAssetCount": 0, "externalDependencyCount": 0, "missingPluginCount": 0, "unsupportedSaveVersion": False, "outcome": "pass", "readbackHash": "",
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    readback["readbackHash"] = digest(canonical(readback).encode("utf-8"))
    rt.resetMaxFile(rt.Name("noprompt"))
    (working / READBACK_NAME).write_text(canonical(readback), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
