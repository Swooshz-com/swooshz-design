import { AppError, type S6GeometryState, type S6GeometryPrimitive, type S6ObjectRole, type S6RotationMd, type S6ToS7Handoff } from "./types";

export const S7_LAYER_ORDER = [
  "S7-BOOTH-BOUNDARY",
  "S7-BOOTH-OPENINGS",
  "S7-WALLS-PARTITIONS",
  "S7-ZONES",
  "S7-FURNITURE",
  "S7-EQUIPMENT",
  "S7-DISPLAYS",
  "S7-OVERHEAD",
  "S7-DIMENSIONS",
  "S7-LABELS",
  "S7-UNKNOWN",
] as const;

export type S7Layer = typeof S7_LAYER_ORDER[number];
export type S7PlanPoint = { xMm: number; yMm: number };
export type S7PlanPoint3 = { xMm: number; yMm: number; zMm: number };

type S7EntityBase = {
  sourceObjectId: string;
  parentObjectId: string | null;
  identityKey: string;
  role: string;
  geometryState: S6GeometryState;
  intendedLayer: S7Layer;
  layer: S7Layer;
  partIndex: number;
  label: string | null;
};

export type S7PlanEntity = S7EntityBase & (
  | { entityType: "LWPOLYLINE"; points: S7PlanPoint[]; closed: true }
  | { entityType: "LINE"; start: S7PlanPoint; end: S7PlanPoint }
  | { entityType: "POINT"; point: S7PlanPoint }
  | { entityType: "CIRCLE"; center: S7PlanPoint; radiusMm: number }
  | { entityType: "ELLIPSE"; center: S7PlanPoint; majorAxis: S7PlanPoint; ratio: number; startParameter: number; endParameter: number }
  | { entityType: "TEXT"; insertion: S7PlanPoint; value: string; heightMm: number; rotation: number }
);

export type S7GeometryPlan = {
  entities: S7PlanEntity[];
  coordinateConvention: "booth-local-right-handed-v1";
  worldToPlanVersion: "s7-world-to-plan-v1";
};

export type S7WorldMatrix = {
  rotation: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
  translation: S7PlanPoint3;
};

const EPSILON = 1e-8;
const CLEAR_EPSILON = 1e-6;
const TWO_PI = Math.PI * 2;
const MAX_COORDINATE_MM = 1_000_000_000;
const MAX_OBJECTS = 4096;

function fail(code: string, field = "geometry"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_MM) fail("S7_GEOMETRY_INVALID", field);
  return value;
}

function pointKey(point: S7PlanPoint): string {
  return `${Math.round(point.xMm * 1e7)}:${Math.round(point.yMm * 1e7)}`;
}

function comparePoint(left: S7PlanPoint, right: S7PlanPoint): number {
  return left.xMm - right.xMm || left.yMm - right.yMm;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function samePoint(left: S7PlanPoint, right: S7PlanPoint): boolean {
  return Math.abs(left.xMm - right.xMm) <= EPSILON && Math.abs(left.yMm - right.yMm) <= EPSILON;
}

function subtract(left: S7PlanPoint, right: S7PlanPoint): S7PlanPoint {
  return { xMm: left.xMm - right.xMm, yMm: left.yMm - right.yMm };
}

function add(left: S7PlanPoint, right: S7PlanPoint): S7PlanPoint {
  return { xMm: left.xMm + right.xMm, yMm: left.yMm + right.yMm };
}

function scale(point: S7PlanPoint, factor: number): S7PlanPoint {
  return { xMm: point.xMm * factor, yMm: point.yMm * factor };
}

function dot(left: S7PlanPoint, right: S7PlanPoint): number {
  return left.xMm * right.xMm + left.yMm * right.yMm;
}

function cross(left: S7PlanPoint, right: S7PlanPoint): number {
  return left.xMm * right.yMm - left.yMm * right.xMm;
}

function length(point: S7PlanPoint): number {
  return Math.hypot(point.xMm, point.yMm);
}

function normalize(point: S7PlanPoint): S7PlanPoint {
  const value = length(point);
  if (value <= EPSILON) fail("S7_GEOMETRY_AMBIGUOUS");
  return scale(point, 1 / value);
}

function leftNormal(point: S7PlanPoint): S7PlanPoint {
  return { xMm: -point.yMm, yMm: point.xMm };
}

function cleanPolygon(points: readonly S7PlanPoint[]): S7PlanPoint[] {
  const result: S7PlanPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.xMm) || !Number.isFinite(point.yMm)) fail("S7_GEOMETRY_INVALID");
    if (result.length === 0 || !samePoint(result[result.length - 1]!, point)) result.push({ ...point });
  }
  if (result.length > 1 && samePoint(result[0]!, result[result.length - 1]!)) result.pop();
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const previous = result[(index + result.length - 1) % result.length]!;
      const current = result[index]!;
      const next = result[(index + 1) % result.length]!;
      const first = subtract(current, previous);
      const second = subtract(next, current);
      if (Math.abs(cross(first, second)) <= EPSILON && dot(first, second) >= -EPSILON) {
        result.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function signedArea(points: readonly S7PlanPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.xMm * next.yMm - current.yMm * next.xMm;
  }
  return area / 2;
}

export function deterministicConvexHull(points: readonly S7PlanPoint[]): S7PlanPoint[] {
  const sorted = points.slice().sort(comparePoint);
  const unique: S7PlanPoint[] = [];
  for (const point of sorted) {
    if (unique.length === 0 || !samePoint(unique[unique.length - 1]!, point)) unique.push({ ...point });
  }
  if (unique.length <= 2) return unique;
  const lower: S7PlanPoint[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(subtract(lower[lower.length - 1]!, lower[lower.length - 2]!), subtract(point, lower[lower.length - 1]!)) <= EPSILON) lower.pop();
    lower.push(point);
  }
  const upper: S7PlanPoint[] = [];
  for (const point of unique.slice().reverse()) {
    while (upper.length >= 2 && cross(subtract(upper[upper.length - 1]!, upper[upper.length - 2]!), subtract(point, upper[upper.length - 1]!)) <= EPSILON) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function rotationMatrix(rotation: S6RotationMd): S7WorldMatrix["rotation"] {
  const rx = rotation.xMd * Math.PI / 180_000;
  const ry = rotation.yMd * Math.PI / 180_000;
  const rz = rotation.zMd * Math.PI / 180_000;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const rxMatrix = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]] as const;
  const ryMatrix = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]] as const;
  const rzMatrix = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]] as const;
  return multiply3(multiply3(rzMatrix, ryMatrix), rxMatrix);
}

function multiply3(
  left: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
  right: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
): S7WorldMatrix["rotation"] {
  return [
    [left[0][0] * right[0][0] + left[0][1] * right[1][0] + left[0][2] * right[2][0], left[0][0] * right[0][1] + left[0][1] * right[1][1] + left[0][2] * right[2][1], left[0][0] * right[0][2] + left[0][1] * right[1][2] + left[0][2] * right[2][2]],
    [left[1][0] * right[0][0] + left[1][1] * right[1][0] + left[1][2] * right[2][0], left[1][0] * right[0][1] + left[1][1] * right[1][1] + left[1][2] * right[2][1], left[1][0] * right[0][2] + left[1][1] * right[1][2] + left[1][2] * right[2][2]],
    [left[2][0] * right[0][0] + left[2][1] * right[1][0] + left[2][2] * right[2][0], left[2][0] * right[0][1] + left[2][1] * right[1][1] + left[2][2] * right[2][1], left[2][0] * right[0][2] + left[2][1] * right[1][2] + left[2][2] * right[2][2]],
  ];
}

function multiplyVector(matrix: S7WorldMatrix["rotation"], vector: S7PlanPoint3): S7PlanPoint3 {
  return {
    xMm: matrix[0][0] * vector.xMm + matrix[0][1] * vector.yMm + matrix[0][2] * vector.zMm,
    yMm: matrix[1][0] * vector.xMm + matrix[1][1] * vector.yMm + matrix[1][2] * vector.zMm,
    zMm: matrix[2][0] * vector.xMm + matrix[2][1] * vector.yMm + matrix[2][2] * vector.zMm,
  };
}

function applyMatrix(matrix: S7WorldMatrix, point: S7PlanPoint3): S7PlanPoint3 {
  const rotated = multiplyVector(matrix.rotation, point);
  return { xMm: rotated.xMm + matrix.translation.xMm, yMm: rotated.yMm + matrix.translation.yMm, zMm: rotated.zMm + matrix.translation.zMm };
}

function composeMatrix(parent: S7WorldMatrix, local: S7WorldMatrix): S7WorldMatrix {
  const translation = applyMatrix(parent, local.translation);
  return { rotation: multiply3(parent.rotation, local.rotation), translation };
}

function localMatrix(object: S6ToS7Handoff["objects"][number]): S7WorldMatrix {
  const rotation = rotationMatrix(object.transform.rotationMd);
  const translation = {
    xMm: finite(object.transform.positionMm.xMm, "transform.positionMm.xMm"),
    yMm: finite(object.transform.positionMm.yMm, "transform.positionMm.yMm"),
    zMm: finite(object.transform.positionMm.zMm, "transform.positionMm.zMm"),
  };
  return { rotation, translation };
}

/**
 * Independently constructs the full-Euler hierarchy oracle. It deliberately
 * does not call any S6 transform helper: every parent multiplication is
 * performed here as a 3x3 matrix plus translation composition.
 */
export function buildS7MatrixOracle(handoff: S6ToS7Handoff): ReadonlyMap<string, S7WorldMatrix> {
  if (handoff.objects.length > MAX_OBJECTS) fail("S7_RESOURCE_LIMIT", "objects");
  const byId = new Map<string, S6ToS7Handoff["objects"][number]>();
  for (const object of handoff.objects) {
    if (!object.objectId || byId.has(object.objectId)) fail("S7_HIERARCHY_INVALID", "objects");
    byId.set(object.objectId, object);
  }
  if (handoff.hierarchy.length !== handoff.objects.length) fail("S7_HIERARCHY_INVALID", "hierarchy");
  for (const item of handoff.hierarchy) {
    const object = byId.get(item.objectId);
    if (!object || object.parentObjectId !== item.parentObjectId) fail("S7_HIERARCHY_INVALID", "hierarchy");
    if (item.parentObjectId !== null && !byId.has(item.parentObjectId)) fail("S7_HIERARCHY_INVALID", "hierarchy");
  }
  const hierarchyIds = new Set(handoff.hierarchy.map((item) => item.objectId));
  if (hierarchyIds.size !== handoff.hierarchy.length || hierarchyIds.size !== handoff.objects.length || [...byId.keys()].some((objectId) => !hierarchyIds.has(objectId))) fail("S7_HIERARCHY_INVALID", "hierarchy");
  const cache = new Map<string, S7WorldMatrix>();
  const visiting = new Set<string>();
  const resolve = (object: S6ToS7Handoff["objects"][number]): S7WorldMatrix => {
    const cached = cache.get(object.objectId);
    if (cached) return cached;
    if (visiting.has(object.objectId)) fail("S7_HIERARCHY_CYCLE", "hierarchy");
    visiting.add(object.objectId);
    const local = localMatrix(object);
    const parent = object.parentObjectId === null ? null : byId.get(object.parentObjectId);
    if (object.parentObjectId !== null && !parent) fail("S7_HIERARCHY_INVALID", "hierarchy");
    const result = parent ? composeMatrix(resolve(parent), local) : local;
    visiting.delete(object.objectId);
    cache.set(object.objectId, result);
    return result;
  };
  for (const object of handoff.objects) resolve(object);
  return cache;
}

function projectPoint(matrix: S7WorldMatrix, point: S7PlanPoint3): S7PlanPoint {
  const world = applyMatrix(matrix, point);
  finite(world.xMm, "world.xMm");
  finite(world.zMm, "world.zMm");
  return { xMm: world.xMm, yMm: world.zMm };
}

function primitiveHeight(primitive: S6GeometryPrimitive): number {
  return primitive.kind === "rect_prism" ? primitive.dimensionsMm.heightMm : primitive.heightMm;
}

function primitiveBaseY(primitive: S6GeometryPrimitive): number {
  const height = primitiveHeight(primitive);
  return primitive.localAnchor === "center" ? -height / 2 : 0;
}

function assertPrimitive(primitive: S6GeometryPrimitive): void {
  if (primitive.kind === "rect_prism") {
    if (![primitive.dimensionsMm.widthMm, primitive.dimensionsMm.depthMm, primitive.dimensionsMm.heightMm].every((value) => Number.isFinite(value) && value >= 0)) fail("S7_GEOMETRY_INVALID");
    return;
  }
  if (!Number.isFinite(primitive.heightMm) || primitive.heightMm < 0) fail("S7_GEOMETRY_INVALID");
  if (primitive.kind === "round_prism") {
    if (!Number.isFinite(primitive.radiusMm) || primitive.radiusMm < 0) fail("S7_GEOMETRY_INVALID");
    return;
  }
  const vertices = primitive.profile.vertices;
  if (vertices.length < 3 || vertices.length > 24) fail("S7_PROFILE_INVALID", "profile.vertices");
  for (const vertex of vertices) {
    if (!Number.isSafeInteger(vertex.xMm) || !Number.isSafeInteger(vertex.zMm) || Math.abs(vertex.xMm) > MAX_COORDINATE_MM || Math.abs(vertex.zMm) > MAX_COORDINATE_MM) fail("S7_PROFILE_INVALID", "profile.vertices");
  }
  const normalized = vertices.map((vertex) => ({ xMm: vertex.xMm, yMm: vertex.zMm }));
  if (Math.abs(signedArea(normalized)) <= EPSILON) fail("S7_PROFILE_INVALID", "profile.vertices");
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    const leftStart = normalized[leftIndex]!;
    const leftEnd = normalized[(leftIndex + 1) % normalized.length]!;
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      if (Math.abs(leftIndex - rightIndex) <= 1 || (leftIndex === 0 && rightIndex === normalized.length - 1)) continue;
      const rightStart = normalized[rightIndex]!;
      const rightEnd = normalized[(rightIndex + 1) % normalized.length]!;
      if (segmentsProperlyIntersect(leftStart, leftEnd, rightStart, rightEnd)) fail("S7_PROFILE_SELF_INTERSECTION", "profile.vertices");
    }
  }
}

function orientation(a: S7PlanPoint, b: S7PlanPoint, c: S7PlanPoint): number {
  return cross(subtract(b, a), subtract(c, a));
}

function onSegment(point: S7PlanPoint, start: S7PlanPoint, end: S7PlanPoint): boolean {
  return Math.abs(orientation(start, end, point)) <= EPSILON &&
    point.xMm >= Math.min(start.xMm, end.xMm) - EPSILON && point.xMm <= Math.max(start.xMm, end.xMm) + EPSILON &&
    point.yMm >= Math.min(start.yMm, end.yMm) - EPSILON && point.yMm <= Math.max(start.yMm, end.yMm) + EPSILON;
}

function segmentsProperlyIntersect(a: S7PlanPoint, b: S7PlanPoint, c: S7PlanPoint, d: S7PlanPoint): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (((first > EPSILON && second < -EPSILON) || (first < -EPSILON && second > EPSILON)) && ((third > EPSILON && fourth < -EPSILON) || (third < -EPSILON && fourth > EPSILON))) return true;
  return (Math.abs(first) <= EPSILON && onSegment(c, a, b)) || (Math.abs(second) <= EPSILON && onSegment(d, a, b)) ||
    (Math.abs(third) <= EPSILON && onSegment(a, c, d)) || (Math.abs(fourth) <= EPSILON && onSegment(b, c, d));
}

function rectCorners(primitive: Extract<S6GeometryPrimitive, { kind: "rect_prism" }>): S7PlanPoint3[] {
  const baseY = primitiveBaseY(primitive);
  const width = primitive.dimensionsMm.widthMm;
  const depth = primitive.dimensionsMm.depthMm;
  const topY = baseY + primitive.dimensionsMm.heightMm;
  return [
    { xMm: 0, yMm: baseY, zMm: 0 },
    { xMm: width, yMm: baseY, zMm: 0 },
    { xMm: width, yMm: baseY, zMm: depth },
    { xMm: 0, yMm: baseY, zMm: depth },
    { xMm: 0, yMm: topY, zMm: 0 },
    { xMm: width, yMm: topY, zMm: 0 },
    { xMm: width, yMm: topY, zMm: depth },
    { xMm: 0, yMm: topY, zMm: depth },
  ];
}

function profileCorners(primitive: Extract<S6GeometryPrimitive, { kind: "profile_extrusion" }>): { base: S7PlanPoint3[]; top: S7PlanPoint3[] } {
  const baseY = primitiveBaseY(primitive);
  const topY = baseY + primitive.heightMm;
  return {
    base: primitive.profile.vertices.map((vertex) => ({ xMm: vertex.xMm, yMm: baseY, zMm: vertex.zMm })),
    top: primitive.profile.vertices.map((vertex) => ({ xMm: vertex.xMm, yMm: topY, zMm: vertex.zMm })),
  };
}

function pointInPolygon(point: S7PlanPoint, polygon: readonly S7PlanPoint[]): boolean {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index]!;
    const right = polygon[(index + 1) % polygon.length]!;
    if (onSegment(point, left, right)) return true;
    if ((left.yMm > point.yMm) !== (right.yMm > point.yMm)) {
      const x = left.xMm + (right.xMm - left.xMm) * (point.yMm - left.yMm) / (right.yMm - left.yMm);
      if (x > point.xMm) inside = !inside;
    }
  }
  return inside;
}

type UnionSegment = { start: S7PlanPoint; end: S7PlanPoint };

function segmentParameter(point: S7PlanPoint, start: S7PlanPoint, end: S7PlanPoint): number {
  const delta = subtract(end, start);
  if (Math.abs(delta.xMm) >= Math.abs(delta.yMm) && Math.abs(delta.xMm) > EPSILON) return (point.xMm - start.xMm) / delta.xMm;
  if (Math.abs(delta.yMm) > EPSILON) return (point.yMm - start.yMm) / delta.yMm;
  return 0;
}

function addParameter(parameters: number[], value: number): void {
  if (Number.isFinite(value) && value >= -EPSILON && value <= 1 + EPSILON) parameters.push(Math.max(0, Math.min(1, value)));
}

function addIntersectionParameters(left: UnionSegment, right: UnionSegment, parameters: number[]): void {
  const r = subtract(left.end, left.start);
  const s = subtract(right.end, right.start);
  const denominator = cross(r, s);
  const q = subtract(right.start, left.start);
  if (Math.abs(denominator) <= EPSILON) {
    if (Math.abs(cross(q, r)) <= EPSILON) {
      addParameter(parameters, segmentParameter(right.start, left.start, left.end));
      addParameter(parameters, segmentParameter(right.end, left.start, left.end));
    }
    return;
  }
  const t = cross(q, s) / denominator;
  const u = cross(q, r) / denominator;
  if (u >= -EPSILON && u <= 1 + EPSILON) addParameter(parameters, t);
}

function unionPolygons(polygons: readonly S7PlanPoint[][]): S7PlanPoint[][] {
  const sourceSegments: UnionSegment[] = [];
  for (const polygon of polygons) {
    const clean = cleanPolygon(polygon);
    if (clean.length < 3 || Math.abs(signedArea(clean)) <= EPSILON) continue;
    for (let index = 0; index < clean.length; index += 1) sourceSegments.push({ start: clean[index]!, end: clean[(index + 1) % clean.length]! });
  }
  const directed = new Map<string, UnionSegment>();
  for (let index = 0; index < sourceSegments.length; index += 1) {
    const segment = sourceSegments[index]!;
    const parameters = [0, 1];
    for (let otherIndex = 0; otherIndex < sourceSegments.length; otherIndex += 1) {
      if (index === otherIndex) continue;
      addIntersectionParameters(segment, sourceSegments[otherIndex]!, parameters);
    }
    const sorted = parameters.slice().sort((left, right) => left - right).filter((value, position, values) => position === 0 || Math.abs(value - values[position - 1]!) > EPSILON);
    for (let parameterIndex = 0; parameterIndex + 1 < sorted.length; parameterIndex += 1) {
      const startRatio = sorted[parameterIndex]!;
      const endRatio = sorted[parameterIndex + 1]!;
      if (endRatio - startRatio <= EPSILON) continue;
      const start = add(segment.start, scale(subtract(segment.end, segment.start), startRatio));
      const end = add(segment.start, scale(subtract(segment.end, segment.start), endRatio));
      const middle = scale(add(start, end), 0.5);
      const normal = normalize(leftNormal(subtract(end, start)));
      const offset = Math.max(1e-7, Math.min(0.01, length(subtract(end, start)) * 1e-7));
      const leftInside = polygons.some((polygon) => pointInPolygon(add(middle, scale(normal, offset)), polygon));
      const rightInside = polygons.some((polygon) => pointInPolygon(add(middle, scale(normal, -offset)), polygon));
      if (leftInside === rightInside) continue;
      const oriented = leftInside ? { start, end } : { start: end, end: start };
      const forwardKey = `${pointKey(oriented.start)}>${pointKey(oriented.end)}`;
      const reverseKey = `${pointKey(oriented.end)}>${pointKey(oriented.start)}`;
      if (directed.has(reverseKey)) directed.delete(reverseKey);
      else directed.set(forwardKey, oriented);
    }
  }
  const remaining = new Set(directed.keys());
  const loops: S7PlanPoint[][] = [];
  while (remaining.size > 0) {
    const firstKey = Array.from(remaining).sort()[0]!;
    const first = directed.get(firstKey)!;
    remaining.delete(firstKey);
    const loop = [first.start, first.end];
    let current = first.end;
    while (!samePoint(current, loop[0]!) && loop.length <= directed.size + 2) {
      const candidates = Array.from(remaining).map((key) => ({ key, segment: directed.get(key)! })).filter((item) => samePoint(item.segment.start, current));
      if (candidates.length === 0) break;
      candidates.sort((left, right) => left.key.localeCompare(right.key));
      const selected = candidates[0]!;
      remaining.delete(selected.key);
      loop.push(selected.segment.end);
      current = selected.segment.end;
    }
    const clean = cleanPolygon(loop);
    if (clean.length >= 3 && Math.abs(signedArea(clean)) > EPSILON) loops.push(canonicalLoop(clean));
  }
  return loops.sort((left, right) => comparePoint(left[0]!, right[0]!));
}

function canonicalLoop(points: readonly S7PlanPoint[]): S7PlanPoint[] {
  const clean = cleanPolygon(points);
  if (signedArea(clean) < 0) clean.reverse();
  let first = 0;
  for (let index = 1; index < clean.length; index += 1) if (comparePoint(clean[index]!, clean[first]!) < 0) first = index;
  return clean.slice(first).concat(clean.slice(0, first));
}

function degenerateShape(points: readonly S7PlanPoint[]): Array<{ kind: "polygon"; points: S7PlanPoint[] } | { kind: "line"; start: S7PlanPoint; end: S7PlanPoint } | { kind: "point"; point: S7PlanPoint }> {
  const hull = deterministicConvexHull(points);
  if (hull.length >= 3 && Math.abs(signedArea(hull)) > EPSILON) return [{ kind: "polygon", points: canonicalLoop(hull) }];
  if (hull.length === 2) return [{ kind: "line", start: hull[0]!, end: hull[1]! }];
  if (hull.length === 1) return [{ kind: "point", point: hull[0]! }];
  fail("S7_GEOMETRY_INVALID");
}

function rectShapes(matrix: S7WorldMatrix, primitive: Extract<S6GeometryPrimitive, { kind: "rect_prism" }>): ReturnType<typeof degenerateShape> {
  return degenerateShape(rectCorners(primitive).map((point) => projectPoint(matrix, point)));
}

function profileShapes(matrix: S7WorldMatrix, primitive: Extract<S6GeometryPrimitive, { kind: "profile_extrusion" }>): ReturnType<typeof degenerateShape> {
  const corners = profileCorners(primitive);
  const base = corners.base.map((point) => projectPoint(matrix, point));
  const top = corners.top.map((point) => projectPoint(matrix, point));
  const polygons: S7PlanPoint[][] = [];
  if (base.length >= 3 && Math.abs(signedArea(base)) > EPSILON) polygons.push(base);
  if (top.length >= 3 && Math.abs(signedArea(top)) > EPSILON) polygons.push(top);
  for (let index = 0; index < base.length; index += 1) {
    const next = (index + 1) % base.length;
    const quad = deterministicConvexHull([base[index]!, base[next]!, top[next]!, top[index]!]);
    if (quad.length >= 3 && Math.abs(signedArea(quad)) > EPSILON) polygons.push(quad);
  }
  const loops = unionPolygons(polygons);
  if (loops.length > 0) return loops.map((points) => ({ kind: "polygon" as const, points }));
  return degenerateShape(base.concat(top));
}

function projectedColumn(matrix: S7WorldMatrix, column: 0 | 1 | 2): S7PlanPoint {
  return { xMm: matrix.rotation[0][column], yMm: matrix.rotation[2][column] };
}

function clearOrZero(value: number): "zero" | "clear" | "ambiguous" {
  const absolute = Math.abs(value);
  if (absolute <= EPSILON) return "zero";
  if (absolute >= CLEAR_EPSILON) return "clear";
  return "ambiguous";
}

function vectorClassification(vector: S7PlanPoint): "zero" | "clear" | "ambiguous" {
  return clearOrZero(length(vector));
}

function roundShapes(matrix: S7WorldMatrix, primitive: Extract<S6GeometryPrimitive, { kind: "round_prism" }>): Array<
  { kind: "circle"; center: S7PlanPoint; radiusMm: number } |
  { kind: "ellipse"; center: S7PlanPoint; majorAxis: S7PlanPoint; ratio: number; startParameter: number; endParameter: number } |
  { kind: "line"; start: S7PlanPoint; end: S7PlanPoint } |
  { kind: "polygon"; points: S7PlanPoint[] } |
  { kind: "point"; point: S7PlanPoint }
> {
  const baseY = primitiveBaseY(primitive);
  const midY = baseY + primitive.heightMm / 2;
  const origin = projectPoint(matrix, { xMm: 0, yMm: midY, zMm: 0 });
  const ex = scale(projectedColumn(matrix, 0), primitive.radiusMm);
  const ez = scale(projectedColumn(matrix, 2), primitive.radiusMm);
  const axis = scale(projectedColumn(matrix, 1), primitive.heightMm);
  const qxx = dot(ex, ex);
  const qxy = dot(ex, ez);
  const qyy = dot(ez, ez);
  const trace = qxx + qyy;
  const discriminant = Math.max(0, Math.sqrt(Math.max(0, (qxx - qyy) ** 2 + 4 * qxy ** 2)));
  const lambdaMajor = (trace + discriminant) / 2;
  const lambdaMinor = Math.max(0, (trace - discriminant) / 2);
  const major = Math.sqrt(lambdaMajor);
  const minor = Math.sqrt(lambdaMinor);
  const majorClass = vectorClassification({ xMm: major, yMm: 0 });
  const minorClass = vectorClassification({ xMm: minor, yMm: 0 });
  if (majorClass === "ambiguous" || minorClass === "ambiguous") fail("S7_GEOMETRY_AMBIGUOUS");
  const axisClass = vectorClassification(axis);
  if (axisClass === "ambiguous") fail("S7_GEOMETRY_AMBIGUOUS");
  if (majorClass === "zero") {
    if (axisClass === "zero") return [{ kind: "point", point: origin }];
    return [{ kind: "line", start: add(origin, scale(axis, -0.5)), end: add(origin, scale(axis, 0.5)) }];
  }

  let u: S7PlanPoint;
  if (Math.abs(qxy) > EPSILON || Math.abs(qxx - lambdaMajor) > EPSILON) {
    const candidate = Math.abs(qxy) >= Math.abs(lambdaMajor - qxx)
      ? { xMm: qxy, yMm: lambdaMajor - qxx }
      : { xMm: lambdaMajor - qyy, yMm: qxy };
    u = normalize(candidate);
  } else {
    const first = length(ex) >= length(ez) ? ex : ez;
    u = normalize(first);
  }
  if (u.xMm < -EPSILON || (Math.abs(u.xMm) <= EPSILON && u.yMm < 0)) u = scale(u, -1);
  const v = leftNormal(u);
  const circleProof = Math.abs(major - minor) <= EPSILON && Math.abs(dot(ex, ez)) <= EPSILON && Math.abs(length(ex) - length(ez)) <= EPSILON;

  if (minorClass === "zero") {
    if (axisClass === "zero") return [{ kind: "line", start: add(origin, scale(u, -major)), end: add(origin, scale(u, major)) }];
    const radial = scale(u, major);
    return degenerateShape([add(origin, add(scale(radial, -1), scale(axis, -0.5))), add(origin, add(radial, scale(axis, -0.5))), add(origin, add(radial, scale(axis, 0.5))), add(origin, add(scale(radial, -1), scale(axis, 0.5)))])
      .map((shape) => shape.kind === "polygon" ? shape : shape);
  }

  if (axisClass === "zero") {
    if (circleProof) return [{ kind: "circle", center: origin, radiusMm: major }];
    return [{ kind: "ellipse", center: origin, majorAxis: scale(u, major), ratio: minor / major, startParameter: 0, endParameter: TWO_PI }];
  }

  const axisUnit = normalize(axis);
  const normalOne = leftNormal(axisUnit);
  const normalTwo = scale(normalOne, -1);
  const q = (normal: S7PlanPoint): S7PlanPoint => {
    const matrixVector = add(scale(u, major * major * dot(normal, u)), scale(v, minor * minor * dot(normal, v)));
    const denominator = Math.sqrt(Math.max(EPSILON, dot(normal, matrixVector)));
    return scale(matrixVector, 1 / denominator);
  };
  const parameterFor = (relative: S7PlanPoint): number => {
    const cosine = Math.max(-1, Math.min(1, dot(relative, u) / major));
    const sine = Math.max(-1, Math.min(1, dot(relative, v) / minor));
    const value = Math.atan2(sine, cosine);
    return value < 0 ? value + TWO_PI : value;
  };
  const relativeOne = q(normalOne);
  const relativeTwo = q(normalTwo);
  const parameterOne = parameterFor(relativeOne);
  const parameterTwo = parameterFor(relativeTwo);
  const normalAt = (parameter: number): S7PlanPoint => add(scale(u, Math.cos(parameter) / major), scale(v, Math.sin(parameter) / minor));
  const arc = (first: number, second: number, positive: boolean): { start: number; end: number } => {
    const forward = ((second - first) % TWO_PI + TWO_PI) % TWO_PI;
    const forwardEnd = first + (forward <= EPSILON ? TWO_PI : forward);
    const forwardMid = normalAt((first + forwardEnd) / 2);
    if ((dot(forwardMid, axis) > 0) === positive) return { start: first, end: forwardEnd };
    const reverse = ((first - second) % TWO_PI + TWO_PI) % TWO_PI;
    const reverseEnd = second + (reverse <= EPSILON ? TWO_PI : reverse);
    return { start: second, end: reverseEnd };
  };
  const positiveArc = arc(parameterOne, parameterTwo, true);
  const negativeArc = arc(parameterOne, parameterTwo, false);
  return [
    { kind: "ellipse", center: add(origin, scale(axis, 0.5)), majorAxis: scale(u, major), ratio: minor / major, startParameter: positiveArc.start, endParameter: positiveArc.end },
    { kind: "ellipse", center: add(origin, scale(axis, -0.5)), majorAxis: scale(u, major), ratio: minor / major, startParameter: negativeArc.start, endParameter: negativeArc.end },
    { kind: "line", start: add(add(origin, scale(axis, 0.5)), relativeOne), end: add(add(origin, scale(axis, -0.5)), relativeOne) },
    { kind: "line", start: add(add(origin, scale(axis, 0.5)), relativeTwo), end: add(add(origin, scale(axis, -0.5)), relativeTwo) },
  ];
}

function roleLayer(role: S6ObjectRole): S7Layer {
  switch (role) {
    case "booth_floor": return "S7-BOOTH-BOUNDARY";
    case "booth_wall":
    case "booth_partition": return "S7-WALLS-PARTITIONS";
    case "zone": return "S7-ZONES";
    case "furniture":
    case "storage":
    case "seating": return "S7-FURNITURE";
    case "equipment": return "S7-EQUIPMENT";
    case "display":
    case "screen": return "S7-DISPLAYS";
    case "overhead": return "S7-OVERHEAD";
  }
}

function unknownSet(handoff: S6ToS7Handoff): Set<string> {
  return new Set(handoff.unknowns.filter((item) => item.status === "unresolved").map((item) => item.unknownId));
}

function entityBase(
  sourceObjectId: string,
  parentObjectId: string | null,
  identityKey: string,
  role: string,
  geometryState: S6GeometryState,
  intendedLayer: S7Layer,
  layer: S7Layer,
  partIndex: number,
  label: string | null,
): S7EntityBase {
  return { sourceObjectId, parentObjectId, identityKey, role, geometryState, intendedLayer, layer, partIndex, label };
}

function shapeEntities(
  shapes: ReturnType<typeof rectShapes> | ReturnType<typeof profileShapes> | ReturnType<typeof roundShapes>,
  base: S7EntityBase,
): S7PlanEntity[] {
  return shapes.map((shape, index) => {
    const metadata = { ...base, partIndex: base.partIndex + index };
    if (shape.kind === "polygon") return { ...metadata, entityType: "LWPOLYLINE" as const, points: shape.points, closed: true };
    if (shape.kind === "line") return { ...metadata, entityType: "LINE" as const, start: shape.start, end: shape.end };
    if (shape.kind === "point") return { ...metadata, entityType: "POINT" as const, point: shape.point };
    if (shape.kind === "circle") return { ...metadata, entityType: "CIRCLE" as const, center: shape.center, radiusMm: shape.radiusMm };
    return { ...metadata, entityType: "ELLIPSE" as const, center: shape.center, majorAxis: shape.majorAxis, ratio: shape.ratio, startParameter: shape.startParameter, endParameter: shape.endParameter };
  });
}

function textEntity(base: S7EntityBase, insertion: S7PlanPoint, value: string, heightMm: number, rotation = 0): S7PlanEntity {
  return { ...base, entityType: "TEXT", insertion, value, heightMm, rotation };
}

function markerForSide(side: "north" | "east" | "south" | "west", width: number, depth: number): S7PlanPoint[] {
  const sideLength = side === "north" || side === "south" ? width : depth;
  const markerLength = Math.max(1, Math.min(300, sideLength / 3));
  if (side === "north") return [{ xMm: (width - markerLength) / 2, yMm: 0 }, { xMm: (width + markerLength) / 2, yMm: 0 }];
  if (side === "east") return [{ xMm: width, yMm: (depth - markerLength) / 2 }, { xMm: width, yMm: (depth + markerLength) / 2 }];
  if (side === "south") return [{ xMm: (width + markerLength) / 2, yMm: depth }, { xMm: (width - markerLength) / 2, yMm: depth }];
  return [{ xMm: 0, yMm: (depth + markerLength) / 2 }, { xMm: 0, yMm: (depth - markerLength) / 2 }];
}

function sortEntities(entities: S7PlanEntity[]): S7PlanEntity[] {
  const layerRank = new Map(S7_LAYER_ORDER.map((layer, index) => [layer, index]));
  const typeRank: Record<S7PlanEntity["entityType"], number> = { LWPOLYLINE: 1, CIRCLE: 2, ELLIPSE: 3, LINE: 4, POINT: 5, TEXT: 6 };
  const openingRank = new Map([["north", 0], ["east", 1], ["south", 2], ["west", 3]]);
  return entities.slice().sort((left, right) =>
    (layerRank.get(left.layer) ?? 999) - (layerRank.get(right.layer) ?? 999) ||
    (left.layer === "S7-BOOTH-OPENINGS" && right.layer === "S7-BOOTH-OPENINGS"
      ? (openingRank.get(left.identityKey.slice("booth-opening:".length)) ?? 999) - (openingRank.get(right.identityKey.slice("booth-opening:".length)) ?? 999)
      : compareUtf8(left.identityKey, right.identityKey)) ||
    left.partIndex - right.partIndex ||
    typeRank[left.entityType] - typeRank[right.entityType],
  );
}

export function buildS7GeometryPlan(handoff: S6ToS7Handoff): S7GeometryPlan {
  if (handoff.schemaVersion !== "s6-to-s7-handoff-v1" || handoff.spatialSchemaVersion !== "s6-spatial-model-v1" || handoff.units !== "millimetres" || handoff.coordinateConvention.version !== "booth-local-right-handed-v1") fail("S7_SOURCE_INVALID", "handoff");
  if (!Number.isSafeInteger(handoff.booth.widthMm) || !Number.isSafeInteger(handoff.booth.depthMm) || handoff.booth.widthMm < 0 || handoff.booth.depthMm < 0) fail("S7_GEOMETRY_INVALID", "booth");
  const oracle = buildS7MatrixOracle(handoff);
  const unresolved = unknownSet(handoff);
  const entities: S7PlanEntity[] = [];
  const floor = handoff.objects.filter((object) => object.role === "booth_floor");
  if (floor.length > 1) fail("S7_GEOMETRY_INVALID", "booth");
  const floorObject = floor[0] ?? null;
  const boundaryBase = entityBase(floorObject?.objectId ?? "booth-envelope", null, floorObject?.identityKey ?? "booth-envelope", "booth_floor", "exact", "S7-BOOTH-BOUNDARY", "S7-BOOTH-BOUNDARY", 0, null);
  entities.push({
    ...boundaryBase,
    entityType: "LWPOLYLINE",
    points: [{ xMm: 0, yMm: 0 }, { xMm: handoff.booth.widthMm, yMm: 0 }, { xMm: handoff.booth.widthMm, yMm: handoff.booth.depthMm }, { xMm: 0, yMm: handoff.booth.depthMm }],
    closed: true,
  });
  const sides = ["north", "east", "south", "west"] as const;
  for (const side of sides) {
    if (!handoff.booth.openSides.includes(side)) continue;
    const points = markerForSide(side, handoff.booth.widthMm, handoff.booth.depthMm);
    entities.push({
      ...entityBase(floorObject?.objectId ?? "booth-envelope", null, "booth-opening:" + side, "opening_marker", "exact", "S7-BOOTH-OPENINGS", "S7-BOOTH-OPENINGS", sides.indexOf(side), "OPEN " + side.toUpperCase()),
      entityType: "LINE",
      start: points[0]!,
      end: points[1]!,
    });
  }

  for (const object of handoff.objects) {
    assertPrimitive(object.geometry);
    if (object.role === "booth_floor") continue;
    const matrix = oracle.get(object.objectId);
    if (!matrix) fail("S7_HIERARCHY_INVALID");
    const intendedLayer = roleLayer(object.role);
    const isUnknown = object.geometry.geometryState === "bounded_inference" || object.unknownIds.some((id) => unresolved.has(id));
    const layer = isUnknown ? "S7-UNKNOWN" : intendedLayer;
    // The accepted S6->S7 handoff carries stable identity, not presentation
    // labels. Use that identity as the deterministic derived label source;
    // the writer applies the canonical printable-ASCII encoding policy.
    const derivedLabel = object.identityKey;
    const base = entityBase(object.objectId, object.parentObjectId, object.identityKey, object.role, object.geometry.geometryState, intendedLayer, layer, 0, derivedLabel);
    if (object.geometry.kind === "rect_prism") entities.push(...shapeEntities(rectShapes(matrix, object.geometry), base));
    else if (object.geometry.kind === "profile_extrusion") entities.push(...shapeEntities(profileShapes(matrix, object.geometry), base));
    else entities.push(...shapeEntities(roundShapes(matrix, object.geometry), base));
    const labelPoint = projectPoint(matrix, { xMm: 0, yMm: primitiveBaseY(object.geometry) + primitiveHeight(object.geometry) / 2, zMm: 0 });
    entities.push(textEntity(entityBase(object.objectId, object.parentObjectId, object.identityKey + ":label", object.role, object.geometry.geometryState, intendedLayer, "S7-LABELS", 0, derivedLabel), labelPoint, derivedLabel, 100, 0));
  }

  const widthBase = entityBase("booth-envelope", null, "dimension:width", "dimension", "exact", "S7-DIMENSIONS", "S7-DIMENSIONS", 0, null);
  const widthY = -Math.max(300, Math.min(600, handoff.booth.depthMm / 5));
  entities.push({ ...widthBase, entityType: "LINE", start: { xMm: 0, yMm: widthY }, end: { xMm: handoff.booth.widthMm, yMm: widthY } });
  entities.push({ ...widthBase, entityType: "LINE", partIndex: 1, start: { xMm: 0, yMm: 0 }, end: { xMm: 0, yMm: widthY } });
  entities.push({ ...widthBase, entityType: "LINE", partIndex: 2, start: { xMm: handoff.booth.widthMm, yMm: 0 }, end: { xMm: handoff.booth.widthMm, yMm: widthY } });
  entities.push(textEntity({ ...widthBase, partIndex: 3 }, { xMm: handoff.booth.widthMm / 2, yMm: widthY - 150 }, `${handoff.booth.widthMm} mm`, 100));
  const depthX = -Math.max(300, Math.min(600, handoff.booth.widthMm / 5));
  const depthBase = entityBase("booth-envelope", null, "dimension:depth", "dimension", "exact", "S7-DIMENSIONS", "S7-DIMENSIONS", 4, null);
  entities.push({ ...depthBase, entityType: "LINE", start: { xMm: depthX, yMm: 0 }, end: { xMm: depthX, yMm: handoff.booth.depthMm } });
  entities.push({ ...depthBase, entityType: "LINE", partIndex: 5, start: { xMm: 0, yMm: 0 }, end: { xMm: depthX, yMm: 0 } });
  entities.push({ ...depthBase, entityType: "LINE", partIndex: 6, start: { xMm: 0, yMm: handoff.booth.depthMm }, end: { xMm: depthX, yMm: handoff.booth.depthMm } });
  entities.push(textEntity({ ...depthBase, partIndex: 7 }, { xMm: depthX - 150, yMm: handoff.booth.depthMm / 2 }, `${handoff.booth.depthMm} mm`, 100, Math.PI / 2));
  if (handoff.booth.maxHeightMm !== null) {
    entities.push(textEntity(entityBase("booth-envelope", null, "dimension:max-height", "dimension", "exact", "S7-DIMENSIONS", "S7-DIMENSIONS", 8, null), { xMm: 0, yMm: handoff.booth.depthMm + 450 }, `MAX HEIGHT ${handoff.booth.maxHeightMm} mm (INFO)`, 100));
  }
  for (const unknown of handoff.unknowns.filter((item) => item.status === "unresolved")) {
    entities.push(textEntity(entityBase("unknown:" + unknown.unknownId, null, "unknown:" + unknown.unknownId, "unknown_diagnostic", "bounded_inference", "S7-UNKNOWN", "S7-UNKNOWN", 0, null), { xMm: 0, yMm: handoff.booth.depthMm + 600 + entities.filter((entity) => entity.layer === "S7-UNKNOWN" && entity.entityType === "TEXT").length * 120 }, `UNKNOWN ${unknown.unknownId} ${unknown.status.toUpperCase()}`, 80));
  }
  return { entities: sortEntities(entities), coordinateConvention: "booth-local-right-handed-v1", worldToPlanVersion: "s7-world-to-plan-v1" };
}
