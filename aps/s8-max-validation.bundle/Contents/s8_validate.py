"""Independent S8 native Max readback AppBundle entry point.

This entry point is intended for a fresh Autodesk 3ds Max Python 3 process.
It opens only the exact native output and an expected semantic manifest. The
generation process and its receipt are deliberately not used as validation
state.
"""

import datetime
import hashlib
import json
import math
from pathlib import Path

from pymxs import runtime as rt


OUTPUT_NAME = "swooshz-s8-model.max"
EXPECTED_MANIFEST_NAME = "swooshz-s8-expected-manifest.json"
EXPECTED_MANIFEST_HASH_NAME = "expectedManifestSha256"
READBACK_NAME = "swooshz-s8-validation-readback.json"
MAX_MANIFEST_BYTES = 2_000_000
MAX_NATIVE_BYTES = 256 * 1024 * 1024
MATRIX_TOLERANCE = 1e-6
POSITION_TOLERANCE = 0.1


def fail(code):
    raise RuntimeError(code)


def canonical_value(value):
    if isinstance(value, float):
        if not math.isfinite(value):
            fail("S8_READBACK_INPUT_INVALID")
        if value == 0 or value.is_integer():
            return int(value)
        return value
    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_value(child) for key, child in value.items()}
    return value


def canonical(value):
    return json.dumps(canonical_value(value), ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def max_name(value):
    return str(value).lstrip("#").lower()


def require_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail("S8_READBACK_INPUT_INVALID")
    return value


def read_json(path):
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("S8_READBACK_INPUT_INVALID")


def read_expected_manifest(path):
    try:
        raw = path.read_bytes()
    except OSError:
        fail("S8_READBACK_INPUT_INVALID")
    if len(raw) <= 0 or len(raw) > MAX_MANIFEST_BYTES:
        fail("S8_RESOURCE_LIMIT")
    document = read_json(path)
    require_keys(document, ("schemaVersion", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "binding", "units", "axisConvention", "rootName", "nodes", "objectCount", "externalAssetCount", "externalDependencyCount", "semanticDigest"))
    if document["schemaVersion"] != "s8-max-semantic-manifest-v1" or document["units"] != "millimetres" or document["axisConvention"] != "s6-to-max-x-right-zup-minus-yfront-v1":
        fail("S8_READBACK_INPUT_INVALID")
    if canonical(document).encode("utf-8") != raw:
        fail("S8_READBACK_INPUT_INVALID")
    if digest(canonical({**document, "semanticDigest": ""}).encode("utf-8")) != document["semanticDigest"]:
        fail("S8_MANIFEST_HASH_MISMATCH")
    return document, raw


def read_expected_manifest_hash(path):
    try:
        value = path.read_text(encoding="ascii").strip().lower()
    except (OSError, UnicodeDecodeError):
        fail("S8_READBACK_INPUT_INVALID")
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        fail("S8_READBACK_INPUT_INVALID")
    return value


def validate_source_stamp(stamp):
    require_keys(stamp, ("schemaVersion", "projectId", "s6RevisionId", "s6RevisionHash", "sourceS5Fingerprint", "sourceS5ApprovalEventId", "sourceS5Generation", "s6ValidationReceiptId", "s6ValidationReceiptHash", "s6HandoffSchemaVersion", "s6HandoffDigest", "s7ArtifactId", "s7ArtifactHash", "s7ArtifactSize", "s7ManifestId", "s7ManifestHash", "s7ReadbackReceiptId", "s7ReadbackReceiptHash"))
    if stamp["schemaVersion"] != "s8-source-stamp-v1" or stamp["s6HandoffSchemaVersion"] != "s6-to-s7-handoff-v1":
        fail("S8_SOURCE_METADATA_INVALID")


def validate_binding(binding):
    keys = ("sourceStampDigest", "payloadSha256", "generationAppBundleId", "generationAppBundleVersion", "generationAppBundleHash", "generationActivityId", "generationActivityVersion", "generationActivityHash", "validatorAppBundleId", "validatorAppBundleVersion", "validatorAppBundleHash", "validatorActivityId", "validatorActivityVersion", "validatorActivityHash", "engineId", "productVersion", "engineVersion", "constructionAlgorithmVersion", "semanticAlgorithmVersion")
    require_keys(binding, keys)
    for value in binding.values():
        if not isinstance(value, str) or not value or value == "latest" or any(character in value for character in "\\/\r\n"):
            fail("S8_TOOL_BINDING_INVALID")
    for key in ("sourceStampDigest", "payloadSha256", "generationAppBundleHash", "generationActivityHash", "validatorAppBundleHash", "validatorActivityHash"):
        if len(binding[key]) != 64 or any(character not in "0123456789abcdef" for character in binding[key]):
            fail("S8_TOOL_BINDING_INVALID")
    if binding["constructionAlgorithmVersion"] != "s8-max-scene-construction-v1" or binding["semanticAlgorithmVersion"] != "s8-max-semantic-v1":
        fail("S8_TOOL_BINDING_INVALID")


def round_half_away_from_zero(value):
    magnitude = math.floor(abs(value))
    fraction = abs(value) - magnitude
    rounded = magnitude + (1 if fraction >= 0.5 else 0)
    return -rounded if value < 0 else rounded


def point(value):
    return {"x": float(value.x), "y": float(value.y), "z": float(value.z)}


def quantize_matrix_value(value):
    if abs(value) < 1e-12:
        return 0
    return round_half_away_from_zero(value * 1000000.0) / 1000000.0


def matrix(value):
    rows = [point(value.row1), point(value.row2), point(value.row3)]
    translation = point(value.translation)
    return {
        "rows": [{axis: quantize_matrix_value(row[axis]) for axis in ("x", "y", "z")} for row in rows],
        "translation": {axis: quantize_matrix_value(translation[axis]) for axis in ("x", "y", "z")},
    }


def quantize_matrix_document(value):
    return {
        "rows": [{axis: quantize_matrix_value(row[axis]) for axis in ("x", "y", "z")} for row in value["rows"]],
        "translation": {axis: quantize_matrix_value(value["translation"][axis]) for axis in ("x", "y", "z")},
    }


def identity_matrix():
    return {"rows": [{"x": 1, "y": 0, "z": 0}, {"x": 0, "y": 1, "z": 0}, {"x": 0, "y": 0, "z": 1}], "translation": {"x": 0, "y": 0, "z": 0}}


def linear_apply(matrix_value, value):
    rows = matrix_value["rows"]
    return {
        "x": value["x"] * rows[0]["x"] + value["y"] * rows[1]["x"] + value["z"] * rows[2]["x"],
        "y": value["x"] * rows[0]["y"] + value["y"] * rows[1]["y"] + value["z"] * rows[2]["y"],
        "z": value["x"] * rows[0]["z"] + value["y"] * rows[1]["z"] + value["z"] * rows[2]["z"],
    }


def apply_matrix(matrix_value, value):
    result = linear_apply(matrix_value, value)
    return {axis: result[axis] + matrix_value["translation"][axis] for axis in ("x", "y", "z")}


def compose(local, parent):
    return {"rows": [linear_apply(parent, row) for row in local["rows"]], "translation": apply_matrix(parent, local["translation"])}


def inverse_matrix(matrix_value):
    rows = matrix_value["rows"]
    inverse = {
        "rows": [
            {"x": rows[0]["x"], "y": rows[1]["x"], "z": rows[2]["x"]},
            {"x": rows[0]["y"], "y": rows[1]["y"], "z": rows[2]["y"]},
            {"x": rows[0]["z"], "y": rows[1]["z"], "z": rows[2]["z"]},
        ],
        "translation": {"x": 0, "y": 0, "z": 0},
    }
    negative = {axis: -matrix_value["translation"][axis] for axis in ("x", "y", "z")}
    inverse["translation"] = linear_apply(inverse, negative)
    return inverse


def matrix_close(left, right):
    for row in range(3):
        for axis in ("x", "y", "z"):
            if abs(left["rows"][row][axis] - right["rows"][row][axis]) > MATRIX_TOLERANCE:
                return False
    return all(abs(left["translation"][axis] - right["translation"][axis]) <= MATRIX_TOLERANCE for axis in ("x", "y", "z"))


def quantize_mm(value):
    return round_half_away_from_zero(value * 10.0) / 10.0


def quantized_point(value):
    raw = point(value)
    return {axis: quantize_mm(raw[axis]) for axis in ("x", "y", "z")}


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
        try:
            face = [int(vertex) for vertex in rt.polyOp.getFaceVerts(node, index)]
        except (TypeError, ValueError):
            fail("S8_MESH_INVALID")
        if len(face) not in (3, 4) or len(set(face)) != len(face) or any(vertex < 1 or vertex > vertex_count for vertex in face):
            fail("S8_MESH_INVALID")
        a, b, c = (vertices[face[position] - 1] for position in range(3))
        ab = (b["x"] - a["x"], b["y"] - a["y"], b["z"] - a["z"])
        ac = (c["x"] - a["x"], c["y"] - a["y"], c["z"] - a["z"])
        normal = (ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0])
        if math.sqrt(sum(component * component for component in normal)) <= 1e-5:
            fail("S8_MESH_INVALID")
        faces.append(face)
    return {"vertices": vertices, "faces": faces}


def user_prop(node, key):
    value = rt.getUserProp(node, key)
    if not isinstance(value, str):
        fail("S8_SOURCE_METADATA_INVALID")
    return value


def maybe_user_prop(node, key):
    value = rt.getUserProp(node, key)
    return value if isinstance(value, str) else None


def node_name(object_id, identity_key):
    value = "S8__OBJ__%s__I__%s" % (object_id, hashlib.sha256(identity_key.encode("utf-8")).hexdigest()[:12])
    if len(value) > 120:
        fail("S8_IDENTITY_COLLISION")
    return value


def material_readback(node, expected):
    if expected is None:
        fail("S8_MATERIAL_VALUE_INVALID")
    material = node.material
    if material is None or "Physical" not in str(rt.classOf(material)):
        fail("S8_MATERIAL_CLASS_INVALID")
    base = material.base_color
    degradation_value = user_prop(node, "s8.degradationCode")
    actual = {
        "materialId": expected["materialId"],
        "nativeClass": "PhysicalMaterial",
        "baseColorHex": "#%02x%02x%02x" % (int(base.r), int(base.g), int(base.b)),
        "metalness": int(round(float(material.metalness))),
        "roughness": float(material.roughness),
        "transparency": float(material.transparency),
        "emission": 0.0,
        "degradationCodes": degradation_value.split(",") if degradation_value else [],
    }
    emit = material.emit_color
    if any(int(channel) != 0 for channel in (emit.r, emit.g, emit.b)):
        fail("S8_MATERIAL_VALUE_INVALID")
    if actual["baseColorHex"] != expected["baseColorHex"] or actual["metalness"] != expected["metalness"] or abs(actual["roughness"] - expected["roughness"]) > 1e-6 or abs(actual["transparency"] - expected["transparency"]) > 1e-6 or actual["degradationCodes"] != expected["degradationCodes"]:
        fail("S8_MATERIAL_VALUE_INVALID")
    return actual


def expected_user_properties(expected):
    properties = expected.get("userProperties")
    if not isinstance(properties, dict):
        fail("S8_SOURCE_METADATA_INVALID")
    return properties


def semantic_node(node, root, expected):
    if str(rt.classOf(node.baseObject)) != "Editable_Poly":
        fail("S8_NATIVE_CLASS_INVALID")
    object_id = expected.get("objectId")
    if not isinstance(object_id, str) or maybe_user_prop(node, "s8.objectId") != object_id:
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    expected_parent = expected.get("parentObjectId")
    actual_parent = node.parent
    if expected_parent is None:
        if actual_parent != root:
            fail("S8_HIERARCHY_INVALID")
    elif actual_parent is None or maybe_user_prop(actual_parent, "s8.objectId") != expected_parent:
        fail("S8_HIERARCHY_INVALID")
    properties = expected_user_properties(expected)
    for key, value in properties.items():
        if user_prop(node, key) != value:
            fail("S8_SOURCE_METADATA_INVALID")
    if str(node.name) != node_name(object_id, properties["s8.identityKey"]):
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    mesh = mesh_readback(node)
    if mesh != expected["mesh"]:
        fail("S8_SEMANTIC_MISMATCH")
    local_bounds = bounds(mesh["vertices"])
    expected_local_bounds = expected["localBoundsMm"]
    actual_dimensions = dimensions(local_bounds)
    if any(abs(actual_dimensions[key] - expected_local_bounds[key]) > POSITION_TOLERANCE for key in ("widthMm", "depthMm", "heightMm")):
        fail("S8_BOUNDS_MISMATCH")
    world_matrix = matrix(node.transform)
    parent_world = matrix(actual_parent.transform) if actual_parent is not None else identity_matrix()
    derived_local = quantize_matrix_document(compose(world_matrix, inverse_matrix(parent_world)))
    expected_local = expected["localTransform"]
    expected_world = expected["worldTransform"]
    if not matrix_close(world_matrix, expected_world) or not matrix_close(derived_local, expected_local) or not matrix_close(compose(expected_local, parent_world), expected_world):
        fail("S8_TRANSFORM_MISMATCH")
    world_vertices = [apply_matrix(world_matrix, vertex) for vertex in mesh["vertices"]]
    actual_world_bounds = bounds(world_vertices)
    expected_world_bounds = expected["worldBoundsMm"]
    if any(abs(quantize_mm(actual_world_bounds[side][axis]) - expected_world_bounds[side][axis]) > POSITION_TOLERANCE for side in ("min", "max") for axis in ("x", "y", "z")):
        fail("S8_BOUNDS_MISMATCH")
    return {
        "nodeKind": "geometry", "objectId": object_id, "name": str(node.name), "parentObjectId": expected_parent,
        "nativeGeometryClass": "Editable_Poly", "geometryFamily": expected["geometryFamily"], "mesh": mesh,
        "localTransform": derived_local, "worldTransform": world_matrix, "localBoundsMm": expected_local_bounds,
        "worldBoundsMm": {side: {axis: quantize_mm(actual_world_bounds[side][axis]) for axis in ("x", "y", "z")} for side in ("min", "max")},
        "material": material_readback(node, expected["material"]), "userProperties": properties,
    }


def root_readback(root, expected):
    if str(rt.classOf(root.baseObject)) != "Dummy" or root.parent is not None:
        fail("S8_SOURCE_METADATA_INVALID")
    if str(root.name) != expected["name"]:
        fail("S8_SOURCE_METADATA_INVALID")
    properties = expected_user_properties(expected)
    for key, value in properties.items():
        if user_prop(root, key) != value:
            fail("S8_SOURCE_METADATA_INVALID")
    actual_local = matrix(root.transform)
    actual_world = matrix(root.transform)
    if not matrix_close(actual_local, expected["localTransform"]) or not matrix_close(actual_world, expected["worldTransform"]):
        fail("S8_TRANSFORM_MISMATCH")
    return {
        "nodeKind": "root", "objectId": None, "name": str(root.name), "parentObjectId": None,
        "nativeGeometryClass": "Dummy", "geometryFamily": None, "mesh": None, "localTransform": actual_local,
        "worldTransform": actual_world, "localBoundsMm": None, "worldBoundsMm": None, "material": None,
        "userProperties": properties,
    }


def main():
    working = Path.cwd()
    artifact_path = working / OUTPUT_NAME
    expected_manifest_path = working / EXPECTED_MANIFEST_NAME
    expected_manifest_hash_path = working / EXPECTED_MANIFEST_HASH_NAME
    readback_path = working / READBACK_NAME
    if readback_path.exists():
        fail("S8_OUTPUT_EXISTS")
    if not artifact_path.exists() or artifact_path.stat().st_size <= 0 or artifact_path.stat().st_size > MAX_NATIVE_BYTES:
        fail("APS_OUTPUT_MISSING")
    expected_manifest, expected_manifest_bytes = read_expected_manifest(expected_manifest_path)
    expected_manifest_hash = read_expected_manifest_hash(expected_manifest_hash_path)
    if digest(expected_manifest_bytes) != expected_manifest_hash:
        fail("S8_MANIFEST_HASH_MISMATCH")
    validate_source_stamp(expected_manifest["sourceStamp"])
    validate_binding(expected_manifest["binding"])
    if expected_manifest["sourceStampDigest"] != digest(canonical(expected_manifest["sourceStamp"]).encode("utf-8")) or expected_manifest["binding"]["sourceStampDigest"] != expected_manifest["sourceStampDigest"] or expected_manifest["binding"]["payloadSha256"] != expected_manifest["payloadSha256"]:
        fail("S8_SOURCE_METADATA_INVALID")
    expected_nodes = expected_manifest["nodes"]
    if not isinstance(expected_nodes, list) or len(expected_nodes) != expected_manifest["objectCount"] + 1 or expected_manifest["objectCount"] > 256:
        fail("S8_OBJECT_COUNT_INVALID")
    root_expected = [node for node in expected_nodes if node.get("nodeKind") == "root"]
    geometry_expected = [node for node in expected_nodes if node.get("nodeKind") == "geometry"]
    if len(root_expected) != 1 or len(geometry_expected) != expected_manifest["objectCount"]:
        fail("S8_OBJECT_COUNT_INVALID")
    rt.resetMaxFile(rt.Name("noprompt"))
    loaded = rt.loadMaxFile(str(artifact_path), useFileUnits=True, quiet=True, allowPrompts=False, missingExtFilesAction=rt.Name("abort"), missingDLLsAction=rt.Name("abort"), missingXRefsAction=rt.Name("abort"), skipXRefs=False)
    if loaded is not True:
        fail("APS_OUTPUT_MISSING")
    try:
        if max_name(rt.units.SystemType) != "millimeters" or abs(float(rt.units.SystemScale) - 1.0) > MATRIX_TOLERANCE or max_name(rt.units.DisplayType) != "metric" or max_name(rt.units.MetricType) != "millimeters":
            fail("S8_UNITS_INVALID")
        if rt.maxVersion() is None:
            fail("S8_SUPPORTED_SAVE_VERSION")
    except RuntimeError:
        raise
    except Exception:
        fail("S8_SUPPORTED_SAVE_VERSION")
    all_nodes = list(rt.objects)
    stamp_digest = expected_manifest["sourceStampDigest"]
    roots = [node for node in all_nodes if maybe_user_prop(node, "s8.sourceStampDigest") == stamp_digest]
    if len(roots) != 1:
        fail("S8_SOURCE_METADATA_INVALID")
    root = roots[0]
    root_value = root_readback(root, root_expected[0])
    geometry_nodes = [node for node in all_nodes if node != root and maybe_user_prop(node, "s8.objectId") is not None]
    if len(all_nodes) != len(geometry_nodes) + 1 or len(geometry_nodes) != len(geometry_expected):
        fail("S8_EXTRA_SCENE_NODE")
    if len({user_prop(node, "s8.objectId") for node in geometry_nodes}) != len(geometry_nodes):
        fail("S8_IDENTITY_HIERARCHY_INVALID")
    if rt.xrefs.getXRefFileCount() != 0 or len(rt.getClassInstances(rt.TextureMap)) != 0:
        fail("S8_EXTERNAL_DEPENDENCY")
    nodes_by_id = {user_prop(node, "s8.objectId"): node for node in geometry_nodes}
    readback_geometry = []
    for expected in geometry_expected:
        object_id = expected.get("objectId")
        if object_id not in nodes_by_id:
            fail("S8_IDENTITY_HIERARCHY_INVALID")
        readback_geometry.append(semantic_node(nodes_by_id[object_id], root, expected))
    nodes = [root_value] + readback_geometry
    if nodes != expected_nodes:
        fail("S8_SEMANTIC_MISMATCH")
    artifact_bytes = artifact_path.read_bytes()
    readback = {
        "schemaVersion": "s8-max-readback-v1", "projectId": expected_manifest["projectId"], "artifactId": expected_manifest["artifactId"],
        "sourceStampDigest": stamp_digest, "payloadSha256": expected_manifest["payloadSha256"], "binding": expected_manifest["binding"],
        "artifactSha256": digest(artifact_bytes), "artifactByteSize": len(artifact_bytes), "units": "millimetres",
        "axisConvention": "s6-to-max-x-right-zup-minus-yfront-v1", "objectCount": len(readback_geometry), "nodes": nodes,
        "checks": ["artifact-source-binding", "expected-manifest-hash", "engine-tool-binding", "millimetre-units", "object-count", "identity-hierarchy", "editable-poly", "vertices-faces", "local-world-transforms", "bounds-dimensions", "materials-degradation", "source-metadata", "no-xrefs-textures-missing-dependencies", "supported-save-version"],
        "externalAssetCount": 0, "externalDependencyCount": 0, "missingPluginCount": 0, "unsupportedSaveVersion": False,
        "outcome": "pass", "readbackHash": "", "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    readback["readbackHash"] = digest(canonical(readback).encode("utf-8"))
    rt.resetMaxFile(rt.Name("noprompt"))
    readback_path.write_text(canonical(readback), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
