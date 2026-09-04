import { Buffer } from "node:buffer";
import {
  type S6Dimensions,
  type S6GeometryPrimitive,
  type S6Profile,
  type S6ProfileVertex,
  type S6ToS7Handoff,
  type S6Transform,
  type S8MaterialSemantic,
  type S8MaxBounds,
  type S8MaxFace,
  type S8MaxMatrix3,
  type S8MaxPayloadV1,
  type S8MaxPoint,
  type S8MaxReadback,
  type S8MaxSemanticManifestDocument,
  type S8SemanticBinding,
  type S8SemanticNode,
  type S8SourceStampV1,
  type Sha256,
  type Timestamp,
  type UUID,
} from "./types";
import {
  S8_MAX_FACES_PER_OBJECT,
  S8_MAX_HIERARCHY_DEPTH,
  S8_MAX_NODE_NAME_CODE_POINTS,
  S8_MAX_OBJECTS,
  S8_MAX_ROUND_SEGMENTS,
  S8_MAX_TOTAL_FACES,
  S8_MAX_TOTAL_VERTICES,
  S8_MAX_USER_PROPERTIES_BYTES,
  S8_MAX_VERTICES_PER_OBJECT,
  S8_NORMAL_TOLERANCE,
  S8_POSITION_TOLERANCE_MM,
  S8_SEMANTIC_VERSION,
  sourceStampDigest,
} from "./s8-payload";
import { normalizeS6Geometry, normalizeS6Profile, roundHalfAwayFromZero } from "./s6-canonical";
import { cloneJson, jcs, sha256 } from "./utils";

export class S8SemanticError extends Error {
  readonly code: string;

  constructor(code: string, detail = "scene") {
    super(`${code}: ${detail}`);
    this.name = "S8SemanticError";
    this.code = code;
  }
}

function fail(code: string, detail = "scene"): never {
  throw new S8SemanticError(code, detail);
}

type Vector = { x: number; y: number; z: number };
type S6Point = { xMm: number; yMm: number; zMm: number };
type Mesh = { vertices: S8MaxPoint[]; faces: S8MaxFace[] };

function clean(value: number): number {
  if (!Number.isFinite(value)) fail("S8_NUMERIC_INVALID");
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function point(x: number, y: number, z: number): S8MaxPoint {
  return { x: clean(x), y: clean(y), z: clean(z) };
}

function mapS6ToMax(value: S6Point): S8MaxPoint {
  return point(value.xMm, -value.zMm, value.yMm);
}

function rotateS6(value: S6Point, rotation: S6Transform["rotationMd"]): S6Point {
  const rx = rotation.xMd * Math.PI / 180_000;
  const ry = rotation.yMd * Math.PI / 180_000;
  const rz = rotation.zMd * Math.PI / 180_000;
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  const x1 = value.xMm;
  const y1 = value.yMm * cx - value.zMm * sx;
  const z1 = value.yMm * sx + value.zMm * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return {
    xMm: x2 * cz - y2 * sz,
    yMm: x2 * sz + y2 * cz,
    zMm: z2,
  };
}

/**
 * Matrix3 is represented in Autodesk's basis-row convention: a point is
 * transformed as p' = p.x*row1 + p.y*row2 + p.z*row3 + translation.
 * The rows are therefore images of the S6 basis vectors, not columns copied
 * from a column-vector matrix.
 */
export function s8MaxMatrixFromS6Transform(transform: S6Transform): S8MaxMatrix3 {
  const basis = [
    rotateS6({ xMm: 1, yMm: 0, zMm: 0 }, transform.rotationMd),
    rotateS6({ xMm: 0, yMm: 1, zMm: 0 }, transform.rotationMd),
    rotateS6({ xMm: 0, yMm: 0, zMm: 1 }, transform.rotationMd),
  ];
  return {
    rows: [mapS6ToMax(basis[0]!), mapS6ToMax(basis[1]!), mapS6ToMax(basis[2]!)],
    translation: mapS6ToMax(transform.positionMm),
  };
}

export const s6ToMaxMatrix = s8MaxMatrixFromS6Transform;

function linearApply(matrix: S8MaxMatrix3, value: Vector): Vector {
  return {
    x: clean(value.x * matrix.rows[0].x + value.y * matrix.rows[1].x + value.z * matrix.rows[2].x),
    y: clean(value.x * matrix.rows[0].y + value.y * matrix.rows[1].y + value.z * matrix.rows[2].y),
    z: clean(value.x * matrix.rows[0].z + value.y * matrix.rows[1].z + value.z * matrix.rows[2].z),
  };
}

export function applyS8MaxMatrix(matrix: S8MaxMatrix3, value: S8MaxPoint): S8MaxPoint {
  const linear = linearApply(matrix, value);
  return point(linear.x + matrix.translation.x, linear.y + matrix.translation.y, linear.z + matrix.translation.z);
}

export function transformS8MaxVector(matrix: S8MaxMatrix3, value: S8MaxPoint): S8MaxPoint {
  const transformed = linearApply(matrix, value);
  return point(transformed.x, transformed.y, transformed.z);
}

/** Composition follows the locked worldMax = localMax * parentWorldMax rule. */
export function multiplyS8MaxMatrices(left: S8MaxMatrix3, right: S8MaxMatrix3): S8MaxMatrix3 {
  return {
    rows: [
      transformS8MaxVector(right, left.rows[0]),
      transformS8MaxVector(right, left.rows[1]),
      transformS8MaxVector(right, left.rows[2]),
    ],
    translation: applyS8MaxMatrix(right, left.translation),
  };
}

export const composeS8MaxMatrix = multiplyS8MaxMatrices;

export function inverseS8MaxMatrix(matrix: S8MaxMatrix3): S8MaxMatrix3 {
  const a = matrix.rows;
  const inverseRows: [S8MaxPoint, S8MaxPoint, S8MaxPoint] = [
    point(a[0].x, a[1].x, a[2].x),
    point(a[0].y, a[1].y, a[2].y),
    point(a[0].z, a[1].z, a[2].z),
  ];
  const inverse: S8MaxMatrix3 = { rows: inverseRows, translation: point(0, 0, 0) };
  const negated = point(-matrix.translation.x, -matrix.translation.y, -matrix.translation.z);
  inverse.translation = transformS8MaxVector(inverse, negated);
  return inverse;
}

export const invertS8MaxMatrix = inverseS8MaxMatrix;

function identityMatrix(): S8MaxMatrix3 {
  return { rows: [point(1, 0, 0), point(0, 1, 0), point(0, 0, 1)], translation: point(0, 0, 0) };
}

function cross2(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): number {
  return (b.xMm - a.xMm) * (c.zMm - a.zMm) - (b.zMm - a.zMm) * (c.xMm - a.xMm);
}

function signedArea(vertices: readonly S6ProfileVertex[]): number {
  let area = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    area += current.xMm * next.zMm - current.zMm * next.xMm;
  }
  return area / 2;
}

function between(value: S6ProfileVertex, left: S6ProfileVertex, right: S6ProfileVertex): boolean {
  return value.xMm >= Math.min(left.xMm, right.xMm) && value.xMm <= Math.max(left.xMm, right.xMm) && value.zMm >= Math.min(left.zMm, right.zMm) && value.zMm <= Math.max(left.zMm, right.zMm);
}

function pointInTriangle(pointValue: S6ProfileVertex, a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): boolean {
  const ab = cross2(a, b, pointValue);
  const bc = cross2(b, c, pointValue);
  const ca = cross2(c, a, pointValue);
  const positive = ab > 0 && bc > 0 && ca > 0;
  const negative = ab < 0 && bc < 0 && ca < 0;
  if (positive || negative) return true;
  return (ab === 0 && between(pointValue, a, b)) || (bc === 0 && between(pointValue, b, c)) || (ca === 0 && between(pointValue, c, a));
}

/** Deterministic first-valid-ear clipping over the normalized S6 profile order. */
export function triangulateS8Profile(profile: S6Profile): Array<[number, number, number]> {
  let vertices: S6ProfileVertex[];
  try {
    vertices = normalizeS6Profile(profile).vertices;
  } catch {
    fail("S8_PROFILE_TRIANGULATION_FAILED", "profile");
  }
  if (vertices.length < 3) fail("S8_PROFILE_TRIANGULATION_FAILED", "profile");
  const orientation = signedArea(vertices) >= 0 ? 1 : -1;
  const remaining = vertices.map((_vertex, index) => index);
  const triangles: Array<[number, number, number]> = [];
  let guard = 0;
  while (remaining.length > 3 && guard < vertices.length * vertices.length) {
    guard += 1;
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previousIndex = remaining[(index + remaining.length - 1) % remaining.length]!;
      const currentIndex = remaining[index]!;
      const nextIndex = remaining[(index + 1) % remaining.length]!;
      const previous = vertices[previousIndex]!;
      const current = vertices[currentIndex]!;
      const next = vertices[nextIndex]!;
      if (orientation * cross2(previous, current, next) <= 0) continue;
      let containsOther = false;
      for (const candidateIndex of remaining) {
        if (candidateIndex === previousIndex || candidateIndex === currentIndex || candidateIndex === nextIndex) continue;
        if (pointInTriangle(vertices[candidateIndex]!, previous, current, next)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      triangles.push([previousIndex, currentIndex, nextIndex]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) fail("S8_PROFILE_TRIANGULATION_FAILED", "profile");
  }
  if (remaining.length !== 3) fail("S8_PROFILE_TRIANGULATION_FAILED", "profile");
  triangles.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  return triangles;
}

export const triangulateProfile = triangulateS8Profile;

function normal(a: S8MaxPoint, b: S8MaxPoint, c: S8MaxPoint): Vector {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
}

function orientFace(vertices: readonly S8MaxPoint[], face: S8MaxFace, expected: Vector): S8MaxFace {
  const current = normal(vertices[face[0] - 1]!, vertices[face[1] - 1]!, vertices[face[2] - 1]!);
  const dot = current.x * expected.x + current.y * expected.y + current.z * expected.z;
  if (Math.abs(dot) <= S8_NORMAL_TOLERANCE) fail("S8_MESH_WINDING_INVALID", "face");
  return dot > 0 ? face : [face[0], face[2], face[1]];
}

function addFace(mesh: Mesh, face: [number, number, number], expected: Vector): void {
  mesh.faces.push(orientFace(mesh.vertices, face, expected));
}

function s6LocalPoint(xMm: number, yMm: number, zMm: number): S8MaxPoint {
  return mapS6ToMax({ xMm, yMm, zMm });
}

function rectMesh(geometry: Extract<S6GeometryPrimitive, { kind: "rect_prism" }>): Mesh {
  const height = geometry.dimensionsMm.heightMm;
  const base = geometry.localAnchor === "center" ? -height / 2 : 0;
  const { widthMm: width, depthMm: depth } = geometry.dimensionsMm;
  const mesh: Mesh = {
    vertices: [
      s6LocalPoint(0, base, 0), s6LocalPoint(width, base, 0), s6LocalPoint(width, base, depth), s6LocalPoint(0, base, depth),
      s6LocalPoint(0, base + height, 0), s6LocalPoint(width, base + height, 0), s6LocalPoint(width, base + height, depth), s6LocalPoint(0, base + height, depth),
    ],
    faces: [],
  };
  addFace(mesh, [1, 3, 2], { x: 0, y: 0, z: -1 });
  addFace(mesh, [1, 4, 3], { x: 0, y: 0, z: -1 });
  addFace(mesh, [5, 6, 7], { x: 0, y: 0, z: 1 });
  addFace(mesh, [5, 7, 8], { x: 0, y: 0, z: 1 });
  addFace(mesh, [1, 2, 6], { x: 0, y: 1, z: 0 });
  addFace(mesh, [1, 6, 5], { x: 0, y: 1, z: 0 });
  addFace(mesh, [2, 3, 7], { x: 1, y: 0, z: 0 });
  addFace(mesh, [2, 7, 6], { x: 1, y: 0, z: 0 });
  addFace(mesh, [3, 4, 8], { x: 0, y: -1, z: 0 });
  addFace(mesh, [3, 8, 7], { x: 0, y: -1, z: 0 });
  addFace(mesh, [4, 1, 5], { x: -1, y: 0, z: 0 });
  addFace(mesh, [4, 5, 8], { x: -1, y: 0, z: 0 });
  return mesh;
}

function roundMesh(geometry: Extract<S6GeometryPrimitive, { kind: "round_prism" }>): Mesh {
  const height = geometry.heightMm;
  const base = geometry.localAnchor === "center" ? -height / 2 : 0;
  const radius = geometry.radiusMm;
  const mesh: Mesh = { vertices: [], faces: [] };
  for (const y of [base, base + height]) {
    for (let index = 0; index < S8_MAX_ROUND_SEGMENTS; index += 1) {
      const angle = 2 * Math.PI * index / S8_MAX_ROUND_SEGMENTS;
      mesh.vertices.push(s6LocalPoint(radius * Math.cos(angle), y, radius * Math.sin(angle)));
    }
  }
  const bottomCenter = mesh.vertices.push(s6LocalPoint(0, base, 0));
  const topCenter = mesh.vertices.push(s6LocalPoint(0, base + height, 0));
  for (let index = 0; index < S8_MAX_ROUND_SEGMENTS; index += 1) {
    const next = (index + 1) % S8_MAX_ROUND_SEGMENTS;
    const b = index + 1; const bn = next + 1; const t = S8_MAX_ROUND_SEGMENTS + index + 1; const tn = S8_MAX_ROUND_SEGMENTS + next + 1;
    const angle = 2 * Math.PI * (index + 0.5) / S8_MAX_ROUND_SEGMENTS;
    addFace(mesh, [b, bn, tn], { x: Math.cos(angle), y: -Math.sin(angle), z: 0 });
    addFace(mesh, [b, tn, t], { x: Math.cos(angle), y: -Math.sin(angle), z: 0 });
    addFace(mesh, [bottomCenter, bn, b], { x: 0, y: 0, z: -1 });
    addFace(mesh, [topCenter, t, tn], { x: 0, y: 0, z: 1 });
  }
  return mesh;
}

function profileMesh(geometry: Extract<S6GeometryPrimitive, { kind: "profile_extrusion" }>): Mesh {
  const profile = normalizeS6Profile(geometry.profile);
  const height = geometry.heightMm;
  const base = geometry.localAnchor === "center" ? -height / 2 : 0;
  const mesh: Mesh = { vertices: [], faces: [] };
  for (const y of [base, base + height]) for (const vertex of profile.vertices) mesh.vertices.push(s6LocalPoint(vertex.xMm, y, vertex.zMm));
  const n = profile.vertices.length;
  const triangles = triangulateS8Profile(profile);
  for (const triangle of triangles) {
    addFace(mesh, [triangle[0] + n + 1, triangle[1] + n + 1, triangle[2] + n + 1], { x: 0, y: 0, z: 1 });
    addFace(mesh, [triangle[2] + 1, triangle[1] + 1, triangle[0] + 1], { x: 0, y: 0, z: -1 });
  }
  const area = signedArea(profile.vertices);
  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n;
    const left = profile.vertices[index]!; const right = profile.vertices[next]!;
    const dx = right.xMm - left.xMm; const dz = right.zMm - left.zMm;
    const outside = area > 0 ? { x: dz, z: -dx } : { x: -dz, z: dx };
    const length = Math.hypot(outside.x, outside.z);
    if (length <= 0) fail("S8_PROFILE_TRIANGULATION_FAILED", "profile.edge");
    addFace(mesh, [index + 1, next + 1, n + next + 1], { x: outside.x / length, y: -outside.z / length, z: 0 });
    addFace(mesh, [index + 1, n + next + 1, n + index + 1], { x: outside.x / length, y: -outside.z / length, z: 0 });
  }
  return mesh;
}

function meshFor(geometry: S6GeometryPrimitive): Mesh {
  const normalized = normalizeS6Geometry(geometry);
  if (normalized.kind === "rect_prism") return rectMesh(normalized);
  if (normalized.kind === "round_prism") return roundMesh(normalized);
  return profileMesh(normalized);
}

function allowedGeometry(objectType: string, kind: S6GeometryPrimitive["kind"]): boolean {
  const allowed: Readonly<Record<string, readonly S6GeometryPrimitive["kind"][]>> = {
    floor_footprint: ["rect_prism"],
    wall: ["rect_prism", "profile_extrusion"],
    partition: ["rect_prism", "profile_extrusion"],
    box: ["rect_prism", "round_prism", "profile_extrusion"],
    counter: ["rect_prism", "round_prism", "profile_extrusion"],
    display_plinth: ["rect_prism", "round_prism", "profile_extrusion"],
    equipment_placeholder: ["rect_prism", "round_prism", "profile_extrusion"],
    overhead_volume: ["rect_prism", "round_prism", "profile_extrusion"],
    screen: ["rect_prism", "profile_extrusion"],
    storage_volume: ["rect_prism", "profile_extrusion"],
    table: ["rect_prism", "round_prism"],
    seating_marker: ["rect_prism", "round_prism"],
    zone_region: ["rect_prism", "profile_extrusion"],
  };
  return allowed[objectType]?.includes(kind) ?? false;
}

function localBounds(geometry: S6GeometryPrimitive): S6Dimensions {
  if (geometry.kind === "rect_prism") return cloneJson(geometry.dimensionsMm);
  if (geometry.kind === "round_prism") return { widthMm: geometry.radiusMm * 2, depthMm: geometry.radiusMm * 2, heightMm: geometry.heightMm };
  const xs = geometry.profile.vertices.map((item) => item.xMm);
  const zs = geometry.profile.vertices.map((item) => item.zMm);
  return { widthMm: Math.max(...xs) - Math.min(...xs), depthMm: Math.max(...zs) - Math.min(...zs), heightMm: geometry.heightMm };
}

function boundsOf(vertices: readonly S8MaxPoint[]): S8MaxBounds {
  if (vertices.length === 0) fail("S8_MESH_INVALID", "vertices");
  const initial = { min: { ...vertices[0]! }, max: { ...vertices[0]! } };
  for (const vertex of vertices.slice(1)) {
    initial.min.x = Math.min(initial.min.x, vertex.x); initial.min.y = Math.min(initial.min.y, vertex.y); initial.min.z = Math.min(initial.min.z, vertex.z);
    initial.max.x = Math.max(initial.max.x, vertex.x); initial.max.y = Math.max(initial.max.y, vertex.y); initial.max.z = Math.max(initial.max.z, vertex.z);
  }
  return initial;
}

function compareDimensions(actual: S6Dimensions, expected: S6Dimensions): boolean {
  return Math.abs(actual.widthMm - expected.widthMm) <= S8_POSITION_TOLERANCE_MM && Math.abs(actual.depthMm - expected.depthMm) <= S8_POSITION_TOLERANCE_MM && Math.abs(actual.heightMm - expected.heightMm) <= S8_POSITION_TOLERANCE_MM;
}

function dimensionsFromMaxBounds(bounds: S8MaxBounds): S6Dimensions {
  return { widthMm: bounds.max.x - bounds.min.x, depthMm: bounds.max.y - bounds.min.y, heightMm: bounds.max.z - bounds.min.z };
}

function roundMm(value: number): number {
  return roundHalfAwayFromZero(value * 10) / 10;
}

export function quantizeS8Millimetres(value: number): number {
  return roundMm(value);
}

function quantizePoint(value: S8MaxPoint): S8MaxPoint {
  return point(roundMm(value.x), roundMm(value.y), roundMm(value.z));
}

function quantizeBounds(value: S8MaxBounds): S8MaxBounds {
  return { min: quantizePoint(value.min), max: quantizePoint(value.max) };
}

function quantizeMatrix(value: S8MaxMatrix3): S8MaxMatrix3 {
  const q = (n: number) => Math.abs(n) < S8_MATRIX_ZERO ? 0 : Math.round(n * 1_000_000) / 1_000_000;
  return { rows: value.rows.map((row) => point(q(row.x), q(row.y), q(row.z))) as S8MaxMatrix3["rows"], translation: point(q(value.translation.x), q(value.translation.y), q(value.translation.z)) };
}

const S8_MATRIX_ZERO = 1e-12;

function safeUserProperties(properties: Record<string, string>): Record<string, string> {
  const bytes = Buffer.byteLength(jcs(properties), "utf8");
  if (bytes > S8_MAX_USER_PROPERTIES_BYTES) fail("S8_RESOURCE_LIMIT", "userProperties");
  return properties;
}

function materialFor(material: S6ToS7Handoff["materials"][number] | undefined, objectId: string): S8MaterialSemantic {
  const degradationCodes: string[] = [];
  const materialId = material?.materialId ?? `s8-default-${sha256(objectId).slice(0, 12)}`;
  const baseColorHex = material?.colorHex?.toLowerCase() ?? "#808080";
  if (!material?.colorHex) degradationCodes.push("S8_MATERIAL_COLOR_UNSPECIFIED");
  const metalness = material?.finishKind === "metal_like" ? 1 : 0;
  const roughness = 0.5;
  degradationCodes.push("S8_MATERIAL_ROUGHNESS_UNSPECIFIED");
  const transparency = material?.finishKind === "glass_like" ? 0.25 : 0;
  if (material?.finishKind === "glass_like") degradationCodes.push("S8_MATERIAL_TRANSPARENCY_UNSPECIFIED");
  const emission = 0;
  if (material?.finishKind === "unknown") degradationCodes.push("S8_MATERIAL_FINISH_UNSPECIFIED");
  return { materialId, nativeClass: "PhysicalMaterial", baseColorHex, metalness: metalness as 0 | 1, roughness, transparency, emission, degradationCodes };
}

function validateMesh(mesh: Mesh, objectId: string): void {
  if (mesh.vertices.length > S8_MAX_VERTICES_PER_OBJECT || mesh.faces.length > S8_MAX_FACES_PER_OBJECT) fail("S8_RESOURCE_LIMIT", `objects.${objectId}.mesh`);
  for (const face of mesh.faces) for (const index of face) if (!Number.isInteger(index) || index < 1 || index > mesh.vertices.length) fail("S8_MESH_INVALID", `objects.${objectId}.faces`);
}

function sourceObjectDepth(objectId: string, byId: ReadonlyMap<string, S6ToS7Handoff["objects"][number]>, visiting: Set<string>, memo: Map<string, number>): number {
  const cached = memo.get(objectId);
  if (cached !== undefined) return cached;
  if (visiting.has(objectId)) fail("S8_HIERARCHY_INVALID", "cycle");
  const object = byId.get(objectId);
  if (!object) fail("S8_HIERARCHY_INVALID", objectId);
  visiting.add(objectId);
  const depth = object.parentObjectId === null ? 1 : sourceObjectDepth(object.parentObjectId, byId, visiting, memo) + 1;
  visiting.delete(objectId);
  if (depth > S8_MAX_HIERARCHY_DEPTH) fail("S8_RESOURCE_LIMIT", "hierarchyDepth");
  memo.set(objectId, depth);
  return depth;
}

function topoObjects(objects: S6ToS7Handoff["objects"]): S6ToS7Handoff["objects"] {
  if (objects.length > S8_MAX_OBJECTS) fail("S8_RESOURCE_LIMIT", "objects");
  const byId = new Map(objects.map((object) => [object.objectId, object]));
  const memo = new Map<string, number>();
  const indexed = objects.map((object, index) => ({ object, index, depth: sourceObjectDepth(object.objectId, byId, new Set<string>(), memo) }));
  indexed.sort((left, right) => left.depth - right.depth || left.index - right.index);
  return indexed.map((item) => item.object);
}

function nodeName(objectId: string, identityKey: string): string {
  const value = `S8__OBJ__${objectId}__I__${sha256(identityKey).slice(0, 12)}`;
  if (Array.from(value).length > S8_MAX_NODE_NAME_CODE_POINTS) fail("S8_IDENTITY_COLLISION", objectId);
  return value;
}

function buildObjectNode(
  object: S6ToS7Handoff["objects"][number],
  parentWorld: S8MaxMatrix3 | null,
  materials: ReadonlyMap<string, S6ToS7Handoff["materials"][number]>,
  stamp: S8SourceStampV1,
  payloadSha256: Sha256,
): S8SemanticNode {
  const geometry = normalizeS6Geometry(object.geometry);
  if (!allowedGeometry(object.objectType, geometry.kind)) fail("S8_UNSUPPORTED_GEOMETRY", object.objectId);
  let mesh: Mesh;
  try { mesh = meshFor(geometry); } catch (error) {
    if (error instanceof S8SemanticError) throw error;
    fail(geometry.kind === "profile_extrusion" ? "S8_PROFILE_TRIANGULATION_FAILED" : "S8_MESH_INVALID", object.objectId);
  }
  mesh = { vertices: mesh.vertices.map(quantizePoint), faces: mesh.faces.map((face) => [face[0], face[1], face[2]]) };
  validateMesh(mesh, object.objectId);
  const expectedLocal = localBounds(geometry);
  const actualLocal = dimensionsFromMaxBounds(boundsOf(mesh.vertices));
  if (!compareDimensions(actualLocal, expectedLocal) || !compareDimensions(expectedLocal, object.boundsMm)) fail("S8_BOUNDS_MISMATCH", object.objectId);
  const localTransform = s8MaxMatrixFromS6Transform(object.transform);
  const worldTransform = parentWorld ? multiplyS8MaxMatrices(localTransform, parentWorld) : localTransform;
  const worldVertices = mesh.vertices.map((vertex) => applyS8MaxMatrix(worldTransform, vertex));
  const semanticMaterial = materialFor(materials.get(object.materialIds[0] ?? ""), object.objectId);
  const userProperties = safeUserProperties({
    "s8.objectId": object.objectId,
    "s8.identityKey": object.identityKey,
    "s8.parentObjectId": object.parentObjectId ?? "",
    "s8.semanticRole": object.role,
    "s8.semanticType": object.objectType,
    "s8.geometryFamily": geometry.kind,
    "s8.sourceRevisionId": stamp.s6RevisionId,
    "s8.degradationCode": semanticMaterial.degradationCodes.join(","),
  });
  return {
    nodeKind: "geometry",
    objectId: object.objectId,
    name: nodeName(object.objectId, object.identityKey),
    parentObjectId: object.parentObjectId,
    nativeGeometryClass: "Editable_Poly",
    geometryFamily: geometry.kind,
    mesh: { vertices: mesh.vertices, faces: mesh.faces },
    localTransform: quantizeMatrix(localTransform),
    worldTransform: quantizeMatrix(worldTransform),
    localBoundsMm: expectedLocal,
    worldBoundsMm: quantizeBounds(boundsOf(worldVertices)),
    material: semanticMaterial,
    userProperties,
  };
}

export type S8Scene = {
  root: S8SemanticNode;
  nodes: S8SemanticNode[];
  objectCount: number;
  totalVertices: number;
  totalFaces: number;
};

export function buildS8Scene(payload: S8MaxPayloadV1, artifactId: UUID, payloadSha256Override?: Sha256): S8Scene {
  const stamp = payload.sourceStamp;
  const stampDigest = sourceStampDigest(stamp);
  const scenePayloadSha256 = payloadSha256Override ?? payloadSha256ForScene(payload);
  const identity = `s8-root:${stampDigest}`;
  const rootName = `S8__ROOT__I__${sha256(identity).slice(0, 12)}`;
  const root: S8SemanticNode = {
    nodeKind: "root",
    objectId: null,
    name: rootName,
    parentObjectId: null,
    nativeGeometryClass: "Dummy",
    geometryFamily: null,
    mesh: null,
    localTransform: identityMatrix(),
    worldTransform: identityMatrix(),
    localBoundsMm: null,
    worldBoundsMm: null,
    material: null,
    userProperties: safeUserProperties({
      "s8.sourceStampDigest": stampDigest,
      "s8.payloadDigest": scenePayloadSha256,
      "s8.constructionAlgorithmVersion": payload.construction.algorithmVersion,
      "s8.projectId": stamp.projectId,
    }),
  };
  const materials = new Map(payload.s6Handoff.materials.map((material) => [material.materialId, material]));
  const worldById = new Map<string, S8MaxMatrix3>();
  const nodes: S8SemanticNode[] = [];
  for (const object of topoObjects(payload.s6Handoff.objects)) {
    const parentWorld = object.parentObjectId === null ? null : worldById.get(object.parentObjectId);
    if (object.parentObjectId !== null && !parentWorld) fail("S8_HIERARCHY_INVALID", object.objectId);
    const node = buildObjectNode(object, parentWorld ?? null, materials, stamp, scenePayloadSha256);
    worldById.set(object.objectId, node.worldTransform);
    nodes.push(node);
  }
  const names = new Set<string>([root.name]);
  for (const node of nodes) {
    if (names.has(node.name)) fail("S8_IDENTITY_COLLISION", node.name);
    names.add(node.name);
  }
  const totalVertices = nodes.reduce((sum, node) => sum + (node.mesh?.vertices.length ?? 0), 0);
  const totalFaces = nodes.reduce((sum, node) => sum + (node.mesh?.faces.length ?? 0), 0);
  if (totalVertices > S8_MAX_TOTAL_VERTICES || totalFaces > S8_MAX_TOTAL_FACES) fail("S8_RESOURCE_LIMIT", "scene");
  return { root, nodes, objectCount: nodes.length, totalVertices, totalFaces };
}

function payloadSha256ForScene(payload: S8MaxPayloadV1): Sha256 {
  return sha256(Buffer.from(jcs({ schemaVersion: payload.schemaVersion, sourceStamp: payload.sourceStamp, construction: payload.construction }), "utf8"));
}

export type S8SemanticManifestInput = {
  projectId: UUID;
  artifactId: UUID;
  sourceStamp: S8SourceStampV1;
  payloadSha256: Sha256;
  binding: S8SemanticBinding;
};

function semanticSceneNodes(scene: S8Scene): S8SemanticNode[] {
  return [scene.root, ...scene.nodes].map((node) => cloneJson(node));
}

export function hashS8SemanticManifest(document: Omit<S8MaxSemanticManifestDocument, "semanticDigest"> & { semanticDigest?: Sha256 }): Sha256 {
  const unsigned = { ...document, semanticDigest: "" };
  return sha256(Buffer.from(jcs(unsigned), "utf8"));
}

export function buildS8SemanticManifest(input: S8SemanticManifestInput, payload: S8MaxPayloadV1): S8MaxSemanticManifestDocument {
  validateS8SemanticBinding(input.binding);
  if (input.binding.sourceStampDigest !== sourceStampDigest(input.sourceStamp) || input.binding.payloadSha256 !== input.payloadSha256) fail("S8_TOOL_BINDING_INVALID", "binding.source");
  const scene = buildS8Scene(payload, input.artifactId, input.payloadSha256);
  const unsigned: Omit<S8MaxSemanticManifestDocument, "semanticDigest"> & { semanticDigest: string } = {
    schemaVersion: "s8-max-semantic-manifest-v1",
    projectId: input.projectId,
    artifactId: input.artifactId,
    sourceStamp: cloneJson(input.sourceStamp),
    sourceStampDigest: sourceStampDigest(input.sourceStamp),
    payloadSha256: input.payloadSha256,
    binding: cloneJson(input.binding),
    units: "millimetres",
    axisConvention: "s6-to-max-x-right-zup-minus-yfront-v1",
    rootName: scene.root.name,
    nodes: semanticSceneNodes(scene),
    objectCount: scene.objectCount,
    externalAssetCount: 0,
    externalDependencyCount: 0,
    semanticDigest: "",
  };
  return { ...unsigned, semanticDigest: hashS8SemanticManifest(unsigned) };
}

function nodeComparable(node: S8SemanticNode): unknown {
  return {
    nodeKind: node.nodeKind,
    objectId: node.objectId,
    name: node.name,
    parentObjectId: node.parentObjectId,
    nativeGeometryClass: node.nativeGeometryClass,
    geometryFamily: node.geometryFamily,
    mesh: node.mesh,
    localTransform: node.localTransform,
    worldTransform: node.worldTransform,
    localBoundsMm: node.localBoundsMm,
    worldBoundsMm: node.worldBoundsMm,
    material: node.material,
    userProperties: node.userProperties,
  };
}

export type S8ReadbackInput = {
  projectId: UUID;
  artifactId: UUID;
  sourceStampDigest: Sha256;
  payloadSha256: Sha256;
  binding: S8SemanticBinding;
  artifactSha256: Sha256;
  artifactByteSize: number;
  scene: S8Scene;
  checkedAt: Timestamp;
};

export function buildS8IndependentReadback(input: S8ReadbackInput): S8MaxReadback {
  validateS8SemanticBinding(input.binding);
  if (input.binding.sourceStampDigest !== input.sourceStampDigest || input.binding.payloadSha256 !== input.payloadSha256) fail("S8_TOOL_BINDING_INVALID", "binding.source");
  const nodes = semanticSceneNodes(input.scene);
  const checks = [
    "artifact-source-binding",
    "engine-tool-binding",
    "millimetre-units",
    "object-count",
    "identity-hierarchy",
    "editable-poly",
    "vertices-faces",
    "local-world-transforms",
    "bounds-dimensions",
    "materials-degradation",
    "source-metadata",
    "no-xrefs-textures-missing-dependencies",
    "supported-save-version",
  ];
  const unsigned: Omit<S8MaxReadback, "readbackHash"> & { readbackHash: string } = {
    schemaVersion: "s8-max-readback-v1",
    projectId: input.projectId,
    artifactId: input.artifactId,
    sourceStampDigest: input.sourceStampDigest,
    payloadSha256: input.payloadSha256,
    binding: cloneJson(input.binding),
    artifactSha256: input.artifactSha256,
    artifactByteSize: input.artifactByteSize,
    units: "millimetres",
    axisConvention: "s6-to-max-x-right-zup-minus-yfront-v1",
    objectCount: input.scene.objectCount,
    nodes,
    checks,
    externalAssetCount: 0,
    externalDependencyCount: 0,
    missingPluginCount: 0,
    unsupportedSaveVersion: false,
    outcome: "pass",
    readbackHash: "",
    checkedAt: input.checkedAt,
  };
  return { ...unsigned, readbackHash: sha256(Buffer.from(jcs(unsigned), "utf8")) };
}

export type S8SemanticComparison = { outcome: "pass" | "fail"; issues: string[] };

export function compareS8SemanticManifest(manifest: S8MaxSemanticManifestDocument, readback: S8MaxReadback): S8SemanticComparison {
  const issues: string[] = [];
  if (manifest.schemaVersion !== "s8-max-semantic-manifest-v1") issues.push("S8_MANIFEST_INVALID");
  if (readback.schemaVersion !== "s8-max-readback-v1") issues.push("S8_READBACK_INVALID");
  if (manifest.projectId !== readback.projectId || manifest.artifactId !== readback.artifactId) issues.push("S8_ARTIFACT_SOURCE_MISMATCH");
  if (manifest.sourceStampDigest !== readback.sourceStampDigest || manifest.payloadSha256 !== readback.payloadSha256) issues.push("S8_SOURCE_BINDING_MISMATCH");
  if (jcs(manifest.binding) !== jcs(readback.binding)) issues.push("S8_TOOL_BINDING_MISMATCH");
  if (manifest.objectCount !== readback.objectCount || manifest.nodes.length !== readback.nodes.length) issues.push("S8_OBJECT_COUNT_MISMATCH");
  if (manifest.units !== readback.units || manifest.axisConvention !== readback.axisConvention) issues.push("S8_UNITS_AXIS_MISMATCH");
  if (manifest.externalAssetCount !== 0 || manifest.externalDependencyCount !== 0 || readback.externalAssetCount !== 0 || readback.externalDependencyCount !== 0 || readback.missingPluginCount !== 0 || readback.unsupportedSaveVersion) issues.push("S8_EXTERNAL_DEPENDENCY");
  const expectedNodes = manifest.nodes.map(nodeComparable);
  const actualNodes = readback.nodes.map(nodeComparable);
  if (jcs(expectedNodes) !== jcs(actualNodes)) issues.push("S8_SEMANTIC_MISMATCH");
  if (hashS8SemanticManifest(manifest) !== manifest.semanticDigest) issues.push("S8_MANIFEST_HASH_MISMATCH");
  const readbackHash = sha256(Buffer.from(jcs({ ...readback, readbackHash: "" }), "utf8"));
  if (readbackHash !== readback.readbackHash) issues.push("S8_READBACK_HASH_MISMATCH");
  if (readback.outcome !== "pass") issues.push("S8_VALIDATOR_FAILED");
  return { outcome: issues.length === 0 ? "pass" : "fail", issues };
}

export function validateS8SemanticBinding(binding: S8SemanticBinding): void {
  const values = [
    binding.sourceStampDigest, binding.payloadSha256, binding.generationAppBundleHash, binding.generationActivityHash,
    binding.validatorAppBundleHash, binding.validatorActivityHash,
  ];
  if (values.some((value) => !/^[0-9a-f]{64}$/u.test(value))) fail("S8_TOOL_BINDING_INVALID", "binding.hash");
  const strings = [
    binding.generationAppBundleId, binding.generationAppBundleVersion, binding.generationActivityId, binding.generationActivityVersion,
    binding.validatorAppBundleId, binding.validatorAppBundleVersion, binding.validatorActivityId, binding.validatorActivityVersion,
    binding.engineId, binding.productVersion, binding.engineVersion,
  ];
  if (strings.some((value) => typeof value !== "string" || value.length === 0 || value === "latest" || /[\u0000-\u001f\\/]/u.test(value))) fail("S8_TOOL_BINDING_INVALID", "binding.identity");
  if (binding.constructionAlgorithmVersion !== "s8-max-scene-construction-v1" || binding.semanticAlgorithmVersion !== S8_SEMANTIC_VERSION) fail("S8_TOOL_BINDING_INVALID", "binding.algorithm");
}

export function semanticDigestForScene(scene: S8Scene): Sha256 {
  return sha256(Buffer.from(jcs({ root: scene.root, nodes: scene.nodes, objectCount: scene.objectCount }), "utf8"));
}

export function assertS8SceneLimits(scene: S8Scene): void {
  if (scene.objectCount > S8_MAX_OBJECTS || scene.nodes.some((node) => (node.mesh?.vertices.length ?? 0) > S8_MAX_VERTICES_PER_OBJECT || (node.mesh?.faces.length ?? 0) > S8_MAX_FACES_PER_OBJECT) || scene.totalVertices > S8_MAX_TOTAL_VERTICES || scene.totalFaces > S8_MAX_TOTAL_FACES || scene.nodes.length !== scene.objectCount) fail("S8_RESOURCE_LIMIT", "scene");
  if (scene.nodes.some((node) => node.nativeGeometryClass !== "Editable_Poly" || !node.objectId)) fail("S8_NATIVE_CLASS_INVALID", "scene.nodes");
}

export function compareS8Matrices(left: S8MaxMatrix3, right: S8MaxMatrix3, tolerance = S8_NORMAL_TOLERANCE): boolean {
  const values = [
    left.rows[0].x - right.rows[0].x, left.rows[0].y - right.rows[0].y, left.rows[0].z - right.rows[0].z,
    left.rows[1].x - right.rows[1].x, left.rows[1].y - right.rows[1].y, left.rows[1].z - right.rows[1].z,
    left.rows[2].x - right.rows[2].x, left.rows[2].y - right.rows[2].y, left.rows[2].z - right.rows[2].z,
    left.translation.x - right.translation.x, left.translation.y - right.translation.y, left.translation.z - right.translation.z,
  ];
  return values.every((value) => Math.abs(value) <= tolerance);
}

export function assertS8MatrixInverse(matrix: S8MaxMatrix3): void {
  if (!compareS8Matrices(multiplyS8MaxMatrices(matrix, inverseS8MaxMatrix(matrix)), identityMatrix(), S8_MATRIX_TOLERANCE)) fail("S8_TRANSFORM_INVALID", "inverse");
}

const S8_MATRIX_TOLERANCE = 1e-6;

export function sourceStampDigestForPayload(payload: S8MaxPayloadV1): Sha256 {
  return sourceStampDigest(payload.sourceStamp);
}
