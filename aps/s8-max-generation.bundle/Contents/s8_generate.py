"""S8 generation AppBundle entry point.

This module is intentionally native-only. It must run inside a supported
Autodesk 3ds Max Python 3 process with pymxs.runtime available. The offline
repository tests parse this source but never treat that parse as Max proof.
"""

import hashlib
import json
import math
from pathlib import Path

from pymxs import runtime as rt


PAYLOAD_NAME = "swooshz-s8-payload.json"
OUTPUT_NAME = "swooshz-s8-model.max"
RECEIPT_NAME = "swooshz-s8-generation-receipt.json"
BINDING_NAME = "s8-engine-binding.json"
ARTIFACT_ID_NAME = "s8-artifact-id.txt"
PAYLOAD_SCHEMA = "s8.max.payload-v1"
MAX_PAYLOAD_BYTES = 2_000_000
MAX_NATIVE_BYTES = 256 * 1024 * 1024
ROUND_SEGMENTS = 24
POSITION_TOLERANCE = 0.1


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


def read_payload(path):
    raw = path.read_bytes()
    if len(raw) > MAX_PAYLOAD_BYTES:
        fail("S8_RESOURCE_LIMIT")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("S8_PAYLOAD_INVALID")
    require_keys(payload, ("schemaVersion", "sourceStamp", "s6Handoff", "construction"))
    if payload["schemaVersion"] != PAYLOAD_SCHEMA:
        fail("S8_PAYLOAD_INVALID")
    require_keys(payload["construction"], ("algorithmVersion", "nativeGeometryClass", "axisConvention", "roundSegments", "profileTriangulation", "materialPolicy", "noExternalAssets"))
    construction = payload["construction"]
    if construction != {
        "algorithmVersion": "s8-max-scene-construction-v1",
        "nativeGeometryClass": "Editable_Poly",
        "axisConvention": "s6-to-max-x-right-zup-minus-yfront-v1",
        "roundSegments": ROUND_SEGMENTS,
        "profileTriangulation": "ear-clipping-s6-order-v1",
        "materialPolicy": "physical-material-bounded-v1",
        "noExternalAssets": True,
    }:
        fail("S8_PAYLOAD_INVALID")
    return payload, raw


def read_binding(path, payload_hash, stamp_hash):
    try:
        binding = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("S8_TOOL_BINDING_REQUIRED")
    require_keys(binding, ("sourceStampDigest", "payloadSha256", "generationAppBundleId", "generationAppBundleVersion", "generationAppBundleHash", "generationActivityId", "generationActivityVersion", "generationActivityHash", "validatorAppBundleId", "validatorAppBundleVersion", "validatorAppBundleHash", "validatorActivityId", "validatorActivityVersion", "validatorActivityHash", "engineId", "productVersion", "engineVersion", "constructionAlgorithmVersion", "semanticAlgorithmVersion"))
    if binding["sourceStampDigest"] != stamp_hash or binding["payloadSha256"] != payload_hash:
        fail("S8_TOOL_BINDING_INVALID")
    for key, value in binding.items():
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
        value = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        fail("S8_ARTIFACT_ID_REQUIRED")
    if len(value) != 36 or value[8] != "-" or value[13] != "-" or value[18] != "-" or value[23] != "-":
        fail("S8_ARTIFACT_ID_INVALID")
    if any(character not in "0123456789abcdefABCDEF-" for character in value) or value[14] not in "4" or value[19] not in "89abAB":
        fail("S8_ARTIFACT_ID_INVALID")
    return value.lower()


def pmax(point_s6):
    return (point_s6["xMm"], -point_s6["zMm"], point_s6["yMm"])


def rotate(point_s6, rotation):
    rx = rotation["xMd"] * math.pi / 180000.0
    ry = rotation["yMd"] * math.pi / 180000.0
    rz = rotation["zMd"] * math.pi / 180000.0
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    x1 = point_s6[0]
    y1 = point_s6[1] * cx - point_s6[2] * sx
    z1 = point_s6[1] * sx + point_s6[2] * cx
    x2 = x1 * cy + z1 * sy
    y2 = y1
    z2 = -x1 * sy + z1 * cy
    return (x2 * cz - y2 * sz, x2 * sz + y2 * cz, z2)


def matrix_from_transform(transform):
    rotation = transform["rotationMd"]
    rows = tuple(pmax({"xMm": axis[0], "yMm": axis[1], "zMm": axis[2]}) for axis in (
        rotate((1, 0, 0), rotation), rotate((0, 1, 0), rotation), rotate((0, 0, 1), rotation)))
    return rows, pmax(transform["positionMm"])


def linear(matrix, value):
    rows, _translation = matrix
    return (
        value[0] * rows[0][0] + value[1] * rows[1][0] + value[2] * rows[2][0],
        value[0] * rows[0][1] + value[1] * rows[1][1] + value[2] * rows[2][1],
        value[0] * rows[0][2] + value[1] * rows[1][2] + value[2] * rows[2][2],
    )


def apply_matrix(matrix, value):
    result = linear(matrix, value)
    translation = matrix[1]
    return (result[0] + translation[0], result[1] + translation[1], result[2] + translation[2])


def compose(local, parent):
    return (tuple(linear(parent, row) for row in local[0]), apply_matrix(parent, local[1]))


def cross(a, b, c):
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    return (ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0])


def dot(left, right):
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]


def oriented_face(vertices, face_indices, expected):
    face = tuple(face_indices)
    if len(face) not in (3, 4) or len(set(face)) != len(face):
        fail("S8_MESH_INVALID")
    actual = cross(vertices[face[0] - 1], vertices[face[1] - 1], vertices[face[2] - 1])
    if abs(dot(actual, expected)) <= 1e-5:
        fail("S8_MESH_WINDING_INVALID")
    if dot(actual, expected) > 0:
        return face
    return (face[0],) + tuple(reversed(face[1:]))


def rect_mesh(geometry):
    dimensions = geometry["dimensionsMm"]
    height = dimensions["heightMm"]
    base = -height / 2.0 if geometry["localAnchor"] == "center" else 0
    width, depth = dimensions["widthMm"], dimensions["depthMm"]
    s6 = ((0, base, 0), (width, base, 0), (width, base, depth), (0, base, depth), (0, base + height, 0), (width, base + height, 0), (width, base + height, depth), (0, base + height, depth))
    vertices = [pmax({"xMm": point[0], "yMm": point[1], "zMm": point[2]}) for point in s6]
    raw = (((1, 4, 3, 2), (0, 0, -1)), ((5, 6, 7, 8), (0, 0, 1)), ((1, 2, 6, 5), (0, 1, 0)), ((2, 3, 7, 6), (1, 0, 0)), ((3, 4, 8, 7), (0, -1, 0)), ((4, 1, 5, 8), (-1, 0, 0)))
    return vertices, [oriented_face(vertices, item, expected) for item, expected in raw]


def round_mesh(geometry):
    height = geometry["heightMm"]
    base = -height / 2.0 if geometry["localAnchor"] == "center" else 0
    radius = geometry["radiusMm"]
    vertices = []
    for y in (base, base + height):
        for index in range(ROUND_SEGMENTS):
            angle = 2.0 * math.pi * index / ROUND_SEGMENTS
            vertices.append(pmax({"xMm": radius * math.cos(angle), "yMm": y, "zMm": radius * math.sin(angle)}))
    bottom_center = len(vertices) + 1
    vertices.append(pmax({"xMm": 0, "yMm": base, "zMm": 0}))
    top_center = len(vertices) + 1
    vertices.append(pmax({"xMm": 0, "yMm": base + height, "zMm": 0}))
    faces = []
    for index in range(ROUND_SEGMENTS):
        next_index = (index + 1) % ROUND_SEGMENTS
        b, bn = index + 1, next_index + 1
        t, tn = ROUND_SEGMENTS + index + 1, ROUND_SEGMENTS + next_index + 1
        angle = 2.0 * math.pi * (index + 0.5) / ROUND_SEGMENTS
        outward = (math.cos(angle), -math.sin(angle), 0)
        faces.extend((oriented_face(vertices, (b, bn, tn, t), outward), oriented_face(vertices, (bottom_center, bn, b), (0, 0, -1)), oriented_face(vertices, (top_center, t, tn), (0, 0, 1))))
    return vertices, faces


def area(profile):
    return sum(profile[index][0] * profile[(index + 1) % len(profile)][1] - profile[index][1] * profile[(index + 1) % len(profile)][0] for index in range(len(profile))) / 2.0


def between(value, left, right):
    return min(left[0], right[0]) <= value[0] <= max(left[0], right[0]) and min(left[1], right[1]) <= value[1] <= max(left[1], right[1])


def point_in_triangle(value, a, b, c):
    def c2(left, right, test):
        return (right[0] - left[0]) * (test[1] - left[1]) - (right[1] - left[1]) * (test[0] - left[0])
    values = (c2(a, b, value), c2(b, c, value), c2(c, a, value))
    if all(item > 0 for item in values) or all(item < 0 for item in values):
        return True
    return (values[0] == 0 and between(value, a, b)) or (values[1] == 0 and between(value, b, c)) or (values[2] == 0 and between(value, c, a))


def triangulate(profile):
    if len(profile) < 3 or len(profile) > 24 or abs(area(profile)) <= 1e-9 or len(set(profile)) != len(profile):
        fail("S8_PROFILE_TRIANGULATION_FAILED")
    orientation = 1 if area(profile) >= 0 else -1
    remaining = list(range(len(profile)))
    triangles = []
    guard = 0
    while len(remaining) > 3 and guard < len(profile) * len(profile):
        guard += 1
        clipped = False
        for position in range(len(remaining)):
            previous = remaining[(position - 1) % len(remaining)]
            current = remaining[position]
            following = remaining[(position + 1) % len(remaining)]
            a, b, c = profile[previous], profile[current], profile[following]
            cross_value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if orientation * cross_value <= 0:
                continue
            if any(point_in_triangle(profile[item], a, b, c) for item in remaining if item not in (previous, current, following)):
                continue
            triangles.append((previous, current, following))
            remaining.pop(position)
            clipped = True
            break
        if not clipped:
            fail("S8_PROFILE_TRIANGULATION_FAILED")
    if len(remaining) != 3:
        fail("S8_PROFILE_TRIANGULATION_FAILED")
    triangles.append(tuple(remaining))
    return triangles


def profile_mesh(geometry):
    profile_data = geometry["profile"]
    require_keys(profile_data, ("winding", "vertices"))
    profile = [(item["xMm"], item["zMm"]) for item in profile_data["vertices"]]
    height = geometry["heightMm"]
    base = -height / 2.0 if geometry["localAnchor"] == "center" else 0
    vertices = [pmax({"xMm": vertex[0], "yMm": y, "zMm": vertex[1]}) for y in (base, base + height) for vertex in profile]
    count = len(profile)
    faces = []
    for triangle in triangulate(profile):
        faces.append(oriented_face(vertices, (triangle[0] + count + 1, triangle[1] + count + 1, triangle[2] + count + 1), (0, 0, 1)))
        faces.append(oriented_face(vertices, (triangle[2] + 1, triangle[1] + 1, triangle[0] + 1), (0, 0, -1)))
    winding_area = area(profile)
    for index in range(count):
        next_index = (index + 1) % count
        left, right = profile[index], profile[next_index]
        dx, dz = right[0] - left[0], right[1] - left[1]
        outside = (dz, -dx) if winding_area > 0 else (-dz, dx)
        length = math.hypot(outside[0], outside[1])
        if length <= 0:
            fail("S8_PROFILE_TRIANGULATION_FAILED")
        expected = (outside[0] / length, -outside[1] / length, 0)
        faces.append(oriented_face(vertices, (index + 1, next_index + 1, count + next_index + 1, count + index + 1), expected))
    return vertices, faces


def geometry_mesh(object_type, geometry):
    kind = geometry.get("kind")
    allowed = {
        "floor_footprint": ("rect_prism",), "wall": ("rect_prism", "profile_extrusion"), "partition": ("rect_prism", "profile_extrusion"),
        "box": ("rect_prism", "round_prism", "profile_extrusion"), "counter": ("rect_prism", "round_prism", "profile_extrusion"),
        "display_plinth": ("rect_prism", "round_prism", "profile_extrusion"), "equipment_placeholder": ("rect_prism", "round_prism", "profile_extrusion"),
        "overhead_volume": ("rect_prism", "round_prism", "profile_extrusion"), "screen": ("rect_prism", "profile_extrusion"),
        "storage_volume": ("rect_prism", "profile_extrusion"), "table": ("rect_prism", "round_prism"), "seating_marker": ("rect_prism", "round_prism"),
        "zone_region": ("rect_prism", "profile_extrusion"),
    }
    if kind not in allowed.get(object_type, ()):
        fail("S8_UNSUPPORTED_GEOMETRY")
    if kind == "rect_prism":
        return rect_mesh(geometry)
    if kind == "round_prism":
        return round_mesh(geometry)
    return profile_mesh(geometry)


def bounds(vertices):
    minimum = list(vertices[0])
    maximum = list(vertices[0])
    for vertex in vertices[1:]:
        for index in range(3):
            minimum[index] = min(minimum[index], vertex[index])
            maximum[index] = max(maximum[index], vertex[index])
    return minimum, maximum


def round_half_away_from_zero(value):
    magnitude = math.floor(abs(value))
    fraction = abs(value) - magnitude
    rounded = magnitude + (1 if fraction >= 0.5 else 0)
    return -rounded if value < 0 else rounded


def quantize_mm(value):
    return round_half_away_from_zero(value * 10.0) / 10.0


def quantize_vertex(value):
    return (quantize_mm(value[0]), quantize_mm(value[1]), quantize_mm(value[2]))


def quantize_matrix(matrix):
    rows, translation = matrix
    def quantize_entry(value):
        if abs(value) < 1e-12:
            return 0
        return round_half_away_from_zero(value * 1000000.0) / 1000000.0
    return (
        tuple(tuple(quantize_entry(component) for component in row) for row in rows),
        tuple(quantize_entry(component) for component in translation),
    )


def check_dimensions(vertices, expected):
    minimum, maximum = bounds(vertices)
    actual = (maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2])
    wanted = (expected["widthMm"], expected["depthMm"], expected["heightMm"])
    if any(abs(actual[index] - wanted[index]) > POSITION_TOLERANCE for index in range(3)):
        fail("S8_BOUNDS_MISMATCH")


def node_name(object_id, identity_key):
    name = "S8__OBJ__%s__I__%s" % (object_id, hashlib.sha256(identity_key.encode("utf-8")).hexdigest()[:12])
    if len(name) > 120:
        fail("S8_IDENTITY_COLLISION")
    return name


def max_matrix(matrix):
    rows, translation = matrix
    return rt.Matrix3(rt.Point3(*rows[0]), rt.Point3(*rows[1]), rt.Point3(*rows[2]), rt.Point3(*translation))


def set_user_property(node, key, value):
    rt.setUserProp(node, key, str(value))


def color(hex_value):
    value = hex_value.lstrip("#")
    if len(value) != 6:
        fail("S8_MATERIAL_COLOR_INVALID")
    return rt.Color(int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def material_semantic(material_ref, object_id):
    material = material_ref or {
        "materialId": "s8-default-%s" % hashlib.sha256(object_id.encode("utf-8")).hexdigest()[:12],
        "finishKind": "unknown",
        "colorHex": "#808080",
    }
    color_hex = material.get("colorHex") or "#808080"
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
        "baseColorHex": color_hex.lower(),
        "metalness": 1 if material.get("finishKind") == "metal_like" else 0,
        "roughness": 0.5,
        "transparency": 0.25 if material.get("finishKind") == "glass_like" else 0.0,
        "emission": 0.0,
        "degradationCodes": degradation,
    }


def physical_material(material_ref, object_id):
    material = rt.Physical_Material()
    semantic = material_semantic(material_ref, object_id)
    material.base_color = color(semantic["baseColorHex"])
    material.metalness = float(semantic["metalness"])
    material.roughness = semantic["roughness"]
    material.transparency = semantic["transparency"]
    material.emit_color = color("#000000")
    return material


def ordered_objects(objects):
    by_id = {item["objectId"]: item for item in objects}
    result = []
    depth_cache = {}

    def depth(object_id, visiting):
        if object_id in depth_cache:
            return depth_cache[object_id]
        if object_id in visiting:
            fail("S8_HIERARCHY_INVALID")
        visiting.add(object_id)
        parent = by_id[object_id].get("parentObjectId")
        value = 1 if parent is None else depth(parent, visiting) + 1
        visiting.remove(object_id)
        if value > 64:
            fail("S8_RESOURCE_LIMIT")
        depth_cache[object_id] = value
        return value

    for index, item in enumerate(objects):
        if item["objectId"] not in by_id:
            fail("S8_HIERARCHY_INVALID")
        if item.get("parentObjectId") is not None and item["parentObjectId"] not in by_id:
            fail("S8_HIERARCHY_INVALID")
        result.append((depth(item["objectId"], set()), index, item))
    result.sort(key=lambda value: (value[0], value[1]))
    return [item[2] for item in result]


def editable_poly_node(vertices, faces, name):
    if len(vertices) < 3 or not faces:
        fail("S8_MESH_INVALID")
    native_vertices = [rt.Point3(*vertex) for vertex in vertices]
    # mesh() is only a temporary deterministic seed; the final faces are
    # created on the converted Editable_Poly so locked quads are retained.
    node = rt.mesh(vertices=native_vertices, faces=[rt.Point3(1, 2, 3)], name=name)
    rt.convertTo(node, rt.Editable_Poly)
    rt.polyOp.deleteFaces(node, rt.Array(1), delIsoVerts=False)
    for face_indices in faces:
        expected_vertices = tuple(face_indices)
        try:
            face_index = int(node.EditablePoly.createFace(rt.Array(*expected_vertices)))
            face_count = int(node.EditablePoly.GetNumFaces())
            face_degree = int(node.EditablePoly.GetFaceDegree(face_index))
            actual_vertices = tuple(
                int(node.EditablePoly.GetFaceVertex(face_index, corner))
                for corner in range(1, face_degree + 1)
            )
        except Exception:
            fail("S8_MESH_FACE_CREATE_FAILED")
        if (
            face_index <= 0
            or face_index > face_count
            or face_degree != len(expected_vertices)
            or actual_vertices != expected_vertices
        ):
            fail("S8_MESH_FACE_CREATE_FAILED")
    return node


def create_scene(payload, payload_bytes, binding, artifact_id):
    handoff = payload["s6Handoff"]
    objects = handoff["objects"]
    if len(objects) > 256:
        fail("S8_RESOURCE_LIMIT")
    payload_hash = digest(payload_bytes)
    stamp_hash = digest(canonical(payload["sourceStamp"]).encode("utf-8"))
    root_name = "S8__ROOT__I__%s" % hashlib.sha256(("s8-root:" + stamp_hash).encode("utf-8")).hexdigest()[:12]
    root = rt.Dummy(name=root_name)
    root.transform = rt.Matrix3(rt.Point3(1, 0, 0), rt.Point3(0, 1, 0), rt.Point3(0, 0, 1), rt.Point3(0, 0, 0))
    set_user_property(root, "s8.sourceStampDigest", stamp_hash)
    set_user_property(root, "s8.payloadDigest", payload_hash)
    set_user_property(root, "s8.constructionAlgorithmVersion", payload["construction"]["algorithmVersion"])
    set_user_property(root, "s8.projectId", payload["sourceStamp"]["projectId"])
    set_user_property(root, "s8.artifactId", artifact_id)
    set_user_property(root, "s8.engineId", binding["engineId"])
    set_user_property(root, "s8.productVersion", binding["productVersion"])
    set_user_property(root, "s8.engineVersion", binding["engineVersion"])
    set_user_property(root, "s8.generationAppBundleId", binding["generationAppBundleId"])
    set_user_property(root, "s8.generationAppBundleVersion", binding["generationAppBundleVersion"])
    set_user_property(root, "s8.generationAppBundleHash", binding["generationAppBundleHash"])
    set_user_property(root, "s8.generationActivityId", binding["generationActivityId"])
    set_user_property(root, "s8.generationActivityVersion", binding["generationActivityVersion"])
    set_user_property(root, "s8.generationActivityHash", binding["generationActivityHash"])
    material_refs = {item["materialId"]: item for item in handoff.get("materials", [])}
    world_by_id = {}
    node_by_id = {}
    names = {root_name}
    for item in ordered_objects(objects):
        object_id = item["objectId"]
        name = node_name(object_id, item["identityKey"])
        if name in names:
            fail("S8_IDENTITY_COLLISION")
        names.add(name)
        vertices, faces = geometry_mesh(item["objectType"], item["geometry"])
        vertices = [quantize_vertex(vertex) for vertex in vertices]
        if len(vertices) > 96 or len(faces) > 128:
            fail("S8_RESOURCE_LIMIT")
        check_dimensions(vertices, item["boundsMm"])
        local = quantize_matrix(matrix_from_transform(item["transform"]))
        parent_id = item.get("parentObjectId")
        if parent_id is None:
            world = local
            parent_node = root
        else:
            if parent_id not in world_by_id:
                fail("S8_HIERARCHY_INVALID")
            world = compose(local, world_by_id[parent_id])
            parent_node = node_by_id[parent_id]
        world = quantize_matrix(world)
        node = editable_poly_node(vertices, faces, name)
        node.parent = parent_node
        # Max node.transform is the world-space matrix. Apply the composed
        # world matrix after parenting; local is derived by the validator.
        node.transform = max_matrix(world)
        node.material = physical_material(material_refs.get(item["materialIds"][0]) if item.get("materialIds") else None, object_id)
        set_user_property(node, "s8.objectId", object_id)
        set_user_property(node, "s8.identityKey", item["identityKey"])
        set_user_property(node, "s8.parentObjectId", parent_id or "")
        set_user_property(node, "s8.semanticRole", item["role"])
        set_user_property(node, "s8.semanticType", item["objectType"])
        set_user_property(node, "s8.geometryFamily", item["geometry"]["kind"])
        set_user_property(node, "s8.sourceRevisionId", payload["sourceStamp"]["s6RevisionId"])
        set_user_property(node, "s8.degradationCode", ",".join(material_semantic(material_refs.get(item["materialIds"][0]) if item.get("materialIds") else None, object_id)["degradationCodes"]))
        world_by_id[object_id] = world
        node_by_id[object_id] = node
    rt.select(root)
    return payload_hash, stamp_hash, len(objects)


def main():
    working = Path.cwd()
    payload, payload_bytes = read_payload(working / PAYLOAD_NAME)
    output = working / OUTPUT_NAME
    receipt_path = working / RECEIPT_NAME
    if output.exists() or receipt_path.exists():
        fail("S8_OUTPUT_EXISTS")
    rt.resetMaxFile(rt.Name("noprompt"))
    rt.units.SystemType = rt.Name("Millimeters")
    rt.units.SystemScale = 1.0
    rt.units.DisplayType = rt.Name("Metric")
    rt.units.MetricType = rt.Name("Millimeters")
    payload_hash = digest(payload_bytes)
    stamp_hash = digest(canonical(payload["sourceStamp"]).encode("utf-8"))
    binding = read_binding(working / BINDING_NAME, payload_hash, stamp_hash)
    artifact_id = read_artifact_id(working / ARTIFACT_ID_NAME)
    object_count = create_scene(payload, payload_bytes, binding, artifact_id)[2]
    if rt.saveMaxFile(str(output), clearNeedSaveFlag=True, useNewFile=True, quiet=True) is not True:
        fail("S8_NATIVE_SAVE_FAILED")
    if not output.exists() or output.stat().st_size <= 0 or output.stat().st_size > MAX_NATIVE_BYTES:
        fail("S8_NATIVE_SAVE_FAILED")
    receipt_without_hash = {"schemaVersion": "s8-max-generation-receipt-v1", "payloadSha256": payload_hash, "sourceStampDigest": stamp_hash, "artifactId": artifact_id, "objectCount": object_count, "nativeFileName": OUTPUT_NAME, "nativeSaveOutcome": "pass", "binding": binding, "artifactSha256": digest(output.read_bytes()), "artifactByteSize": output.stat().st_size, "receiptHash": ""}
    receipt = dict(receipt_without_hash)
    receipt["receiptHash"] = digest(canonical(receipt_without_hash).encode("utf-8"))
    receipt_path.write_text(canonical(receipt), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
