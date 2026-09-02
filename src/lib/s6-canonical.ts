import { sha256 } from "./utils";
import type {
  OpenSide,
  S6Dimensions,
  S6Footprint2D,
  S6GeometryPrimitive,
  S6Profile,
  S6ProfileExtrusionGeometry,
  S6ProfileVertex,
  S6RectPrismGeometry,
  S6RotationMd,
  S6RoundPrismGeometry,
  S6SpatialObject,
  S6SpatialModelRecord,
  S6ValidationReceipt,
  Sha256,
} from "./types";

export const S6_SPATIAL_SCHEMA_VERSION = "s6-spatial-model-v1" as const;
export const S6_SOURCE_PROJECTION_SCHEMA_VERSION = "s5-to-s6-projection-v1" as const;
export const S6_SOURCE_FINGERPRINT_VERSION = "s6-s5-source-fingerprint-v1" as const;
export const S6_MODEL_ARTIFACT_SCHEMA_VERSION = "s6-spatial-model-artifact-v1" as const;
export const S6_VALIDATION_SCHEMA_VERSION = "s6-validation-receipt-v1" as const;
export const S6_CORRECTION_SCHEMA_VERSION = "s6-correction-event-v1" as const;
export const S6_ACCEPTANCE_SCHEMA_VERSION = "s6-acceptance-event-v1" as const;
export const S6_SUPERSESSION_SCHEMA_VERSION = "s6-supersession-event-v1" as const;
export const S6_VIEW_ARTIFACT_SCHEMA_VERSION = "s6-view-artifact-v1" as const;
export const S6_VIEW_PRESERVATION_SCHEMA_VERSION = "s6-view-preservation-v1" as const;
export const S6_JOB_SCHEMA_VERSION = "s6-job-state-v1" as const;
export const S6_IDEMPOTENCY_SCHEMA_VERSION = "s6-idempotency-v1" as const;
export const S6_HANDOFF_SCHEMA_VERSION = "s6-to-s7-handoff-v1" as const;
export const S6_CANONICALIZER_VERSION = "s6-canonical-json-v1" as const;
export const S6_VALIDATOR_VERSION = "s6-validator-v1" as const;
export const S6_VALIDATION_ORDER_VERSION = "s6-validation-order-v1" as const;
export const S6_RENDERER_VERSION = "s6-svg-geometry-v2" as const;
export const S6_ID_VERSION = "s6-object-id-v1" as const;
export const S6_TELEMETRY_SCHEMA_VERSION = "s6-telemetry-v1" as const;

export const S6_MAX_OBJECTS = 256;
export const S6_MAX_ZONES = 64;
export const S6_MAX_CAMERAS = 3;
export const S6_MAX_MATERIALS = 128;
export const S6_MAX_UNKNOWNS = 256;
export const S6_MAX_ASSUMPTIONS = 256;
export const S6_MAX_PROVENANCE_ENTRIES = 512;
export const S6_MAX_REVISIONS_PER_PROJECT = 512;
export const S6_MAX_OPERATIONS = 32;
export const S6_MAX_LABEL_CODE_POINTS = 120;
export const S6_MAX_NOTE_CODE_POINTS = 400;
export const S6_MAX_MODEL_BYTES = 1_000_000;
export const S6_MAX_CORRECTION_BODY_BYTES = 64_000;
export const S6_MAX_VIEW_BYTES = 2_000_000;
export const S6_MAX_VIEW_SET_BYTES = 6_000_000;
export const S6_MAX_JOB_ATTEMPTS = 2;
export const S6_MAX_PROFILE_VERTICES = 24;
export const S6_MAX_PROFILE_ABS_COORD_MM = 100_000;
export const S6_MIN_PROFILE_EDGE_MM = 100;
export const S6_MIN_PROFILE_AREA_MM2 = 10_000;
export const S6_MAX_ROUND_RADIUS_MM = 50_000;
export const S6_ROUND_RENDER_FACETS = 24;
export const S6_RENDER_Q16 = 65_536;
export const S6_MAX_COORDINATE_MM = 1_000_000;
export const S6_MAX_PHYSICAL_MM = 100_000;
export const S6_MIN_PHYSICAL_MM = 100;
export const S6_OPEN_SIDE_ORDER: readonly OpenSide[] = ["north", "east", "south", "west"];

type IntegerBounds = { min?: number; max?: number };

function s6Error(code: string, detail?: string): Error {
  return new Error(detail ? `${code}: ${detail}` : code);
}

export function assertS6Integer(
  value: unknown,
  fieldPath: string,
  bounds: IntegerBounds = {},
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw s6Error("CANONICAL_NUMBER_INVALID", fieldPath);
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw s6Error("NUMERIC_OUT_OF_BOUNDS", fieldPath);
  if (!Number.isSafeInteger(value)) throw s6Error("CANONICAL_NUMBER_INVALID", fieldPath);
  if ((bounds.min !== undefined && value < bounds.min) || (bounds.max !== undefined && value > bounds.max)) {
    throw s6Error("NUMERIC_OUT_OF_BOUNDS", fieldPath);
  }
}

export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) throw s6Error("CANONICAL_NUMBER_INVALID", "rounding input");
  const magnitude = Math.floor(Math.abs(value));
  const fraction = Math.abs(value) - magnitude;
  const rounded = magnitude + (fraction >= 0.5 ? 1 : 0);
  return value < 0 ? -rounded : rounded;
}

export function normalizeS6Rotation(rotation: S6RotationMd): S6RotationMd {
  const normalize = (value: unknown, fieldPath: string): number => {
    assertS6Integer(value, fieldPath);
    const remainder = value % 360_000;
    return remainder >= 180_000 ? remainder - 360_000 : remainder < -180_000 ? remainder + 360_000 : remainder;
  };
  return {
    xMd: normalize(rotation.xMd, "rotationMd.xMd"),
    yMd: normalize(rotation.yMd, "rotationMd.yMd"),
    zMd: normalize(rotation.zMd, "rotationMd.zMd"),
  };
}

function exactKeys(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw s6Error(code);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw s6Error(code);
  return record;
}

function equalVertex(left: S6ProfileVertex, right: S6ProfileVertex): boolean {
  return left.xMm === right.xMm && left.zMm === right.zMm;
}

function cross(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): bigint {
  return BigInt(b.xMm - a.xMm) * BigInt(c.zMm - a.zMm) - BigInt(b.zMm - a.zMm) * BigInt(c.xMm - a.xMm);
}

function between(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): boolean {
  return Math.min(a.xMm, c.xMm) <= b.xMm && b.xMm <= Math.max(a.xMm, c.xMm) &&
    Math.min(a.zMm, c.zMm) <= b.zMm && b.zMm <= Math.max(a.zMm, c.zMm);
}

function onSegment(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex): boolean {
  return cross(a, b, c) === 0n && between(a, b, c);
}

function segmentsIntersect(a: S6ProfileVertex, b: S6ProfileVertex, c: S6ProfileVertex, d: S6ProfileVertex): boolean {
  const first = cross(a, b, c);
  const second = cross(a, b, d);
  const third = cross(c, d, a);
  const fourth = cross(c, d, b);
  if (first === 0n && onSegment(a, c, b)) return true;
  if (second === 0n && onSegment(a, d, b)) return true;
  if (third === 0n && onSegment(c, a, d)) return true;
  if (fourth === 0n && onSegment(c, b, d)) return true;
  return ((first > 0n && second < 0n) || (first < 0n && second > 0n)) &&
    ((third > 0n && fourth < 0n) || (third < 0n && fourth > 0n));
}

function doubledArea(vertices: readonly S6ProfileVertex[]): bigint {
  let area = 0n;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    area += BigInt(current.xMm) * BigInt(next.zMm) - BigInt(current.zMm) * BigInt(next.xMm);
  }
  return area;
}

function removeProfileNoise(vertices: S6ProfileVertex[]): S6ProfileVertex[] {
  let result = vertices.slice();
  let changed = true;
  while (changed) {
    changed = false;
    while (result.length > 1 && equalVertex(result[0], result[result.length - 1])) {
      result.pop();
      changed = true;
    }
    for (let index = 0; index < result.length && result.length > 1; index += 1) {
      if (equalVertex(result[index], result[(index + 1) % result.length])) {
        result.splice(index + 1, 1);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    if (result.length < 3) break;
    for (let index = 0; index < result.length; index += 1) {
      const previous = result[(index + result.length - 1) % result.length];
      const current = result[index];
      const next = result[(index + 1) % result.length];
      if (cross(previous, current, next) === 0n && between(previous, current, next)) {
        result.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function rotateProfile(vertices: S6ProfileVertex[]): S6ProfileVertex[] {
  let start = 0;
  for (let index = 1; index < vertices.length; index += 1) {
    const current = vertices[index];
    const chosen = vertices[start];
    if (current.xMm < chosen.xMm || (current.xMm === chosen.xMm && current.zMm < chosen.zMm)) start = index;
  }
  return vertices.slice(start).concat(vertices.slice(0, start));
}

export function normalizeS6Profile(profile: S6Profile): S6Profile {
  const record = exactKeys(profile, ["winding", "vertices"], "S6_PROFILE_INVALID");
  if (record.winding !== "ccw-from-positive-y-v1" || !Array.isArray(record.vertices)) throw s6Error("S6_PROFILE_INVALID");
  if (record.vertices.length > S6_MAX_PROFILE_VERTICES) throw s6Error("S6_PROFILE_TOO_COMPLEX");
  const input: S6ProfileVertex[] = record.vertices.map((value, index) => {
    const vertex = exactKeys(value, ["xMm", "zMm"], "S6_PROFILE_INVALID");
    assertS6Integer(vertex.xMm, `profile.vertices[${index}].xMm`, { min: -S6_MAX_PROFILE_ABS_COORD_MM, max: S6_MAX_PROFILE_ABS_COORD_MM });
    assertS6Integer(vertex.zMm, `profile.vertices[${index}].zMm`, { min: -S6_MAX_PROFILE_ABS_COORD_MM, max: S6_MAX_PROFILE_ABS_COORD_MM });
    return { xMm: vertex.xMm, zMm: vertex.zMm };
  });
  let vertices = removeProfileNoise(input);
  if (vertices.length < 3 || vertices.length > S6_MAX_PROFILE_VERTICES) throw s6Error("S6_PROFILE_INVALID");
  const unique = new Set(vertices.map((vertex) => `${vertex.xMm},${vertex.zMm}`));
  if (unique.size !== vertices.length) throw s6Error("S6_PROFILE_INVALID");
  const minimumEdgeSquared = BigInt(S6_MIN_PROFILE_EDGE_MM) ** 2n;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const dx = BigInt(next.xMm - current.xMm);
    const dz = BigInt(next.zMm - current.zMm);
    if (dx * dx + dz * dz < minimumEdgeSquared) throw s6Error("S6_PROFILE_INVALID", "short edge");
  }
  for (let left = 0; left < vertices.length; left += 1) {
    const leftNext = (left + 1) % vertices.length;
    for (let right = left + 1; right < vertices.length; right += 1) {
      const rightNext = (right + 1) % vertices.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(vertices[left], vertices[leftNext], vertices[right], vertices[rightNext])) {
        throw s6Error("S6_PROFILE_SELF_INTERSECTION");
      }
    }
  }
  let area = doubledArea(vertices);
  if (area === 0n || (area < 0n ? -area : area) < 2n * BigInt(S6_MIN_PROFILE_AREA_MM2)) {
    throw s6Error("S6_PROFILE_INVALID", "area");
  }
  if (area > 0n) {
    vertices = vertices.slice().reverse();
    area = -area;
  }
  return {
    winding: "ccw-from-positive-y-v1",
    vertices: rotateProfile(vertices),
  };
}

function dimensions(value: unknown, fieldPath: string): S6Dimensions {
  const record = exactKeys(value, ["widthMm", "depthMm", "heightMm"], "NUMERIC_OUT_OF_BOUNDS");
  const widthMm = record.widthMm;
  const depthMm = record.depthMm;
  const heightMm = record.heightMm;
  for (const key of ["widthMm", "depthMm", "heightMm"] as const) {
    assertS6Integer(record[key], `${fieldPath}.${key}`, { min: 1, max: S6_MAX_PHYSICAL_MM });
  }
  assertS6Integer(widthMm, `${fieldPath}.widthMm`, { min: 1, max: S6_MAX_PHYSICAL_MM });
  assertS6Integer(depthMm, `${fieldPath}.depthMm`, { min: 1, max: S6_MAX_PHYSICAL_MM });
  assertS6Integer(heightMm, `${fieldPath}.heightMm`, { min: 1, max: S6_MAX_PHYSICAL_MM });
  return { widthMm, depthMm, heightMm };
}

function normalizeGeometry(value: unknown): S6GeometryPrimitive {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw s6Error("SPATIAL_SCHEMA_INVALID");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "rect_prism") {
    const record = exactKeys(value, ["kind", "dimensionsMm", "geometryState", "localAnchor"], "SPATIAL_SCHEMA_INVALID");
    if (record.geometryState !== "exact" && record.geometryState !== "bounded_inference") throw s6Error("SPATIAL_SCHEMA_INVALID");
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw s6Error("SPATIAL_SCHEMA_INVALID");
    const result: S6RectPrismGeometry = { kind, dimensionsMm: dimensions(record.dimensionsMm, "dimensionsMm"), geometryState: record.geometryState, localAnchor: record.localAnchor };
    return result;
  }
  if (kind === "round_prism") {
    const record = exactKeys(value, ["kind", "radiusMm", "heightMm", "geometryState", "localAnchor"], "ROUND_GEOMETRY_INVALID");
    try {
      assertS6Integer(record.radiusMm, "radiusMm", { min: S6_MIN_PHYSICAL_MM, max: S6_MAX_ROUND_RADIUS_MM });
      assertS6Integer(record.heightMm, "heightMm", { min: 1, max: S6_MAX_PHYSICAL_MM });
    } catch {
      throw s6Error("ROUND_GEOMETRY_INVALID");
    }
    if (record.geometryState !== "exact" && record.geometryState !== "bounded_inference") throw s6Error("ROUND_GEOMETRY_INVALID");
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw s6Error("ROUND_GEOMETRY_INVALID");
    const result: S6RoundPrismGeometry = { kind, radiusMm: record.radiusMm, heightMm: record.heightMm, geometryState: record.geometryState, localAnchor: record.localAnchor };
    return result;
  }
  if (kind === "profile_extrusion") {
    const record = exactKeys(value, ["kind", "profile", "heightMm", "geometryState", "localAnchor"], "S6_PROFILE_INVALID");
    assertS6Integer(record.heightMm, "heightMm", { min: 1, max: S6_MAX_PHYSICAL_MM });
    if (record.geometryState !== "exact" && record.geometryState !== "bounded_inference") throw s6Error("S6_PROFILE_INVALID");
    if (record.localAnchor !== "floor" && record.localAnchor !== "center") throw s6Error("S6_PROFILE_INVALID");
    const result: S6ProfileExtrusionGeometry = { kind, profile: normalizeS6Profile(record.profile as S6Profile), heightMm: record.heightMm, geometryState: record.geometryState, localAnchor: record.localAnchor };
    return result;
  }
  throw s6Error("SPATIAL_SCHEMA_INVALID", "unsupported geometry kind");
}

export function deriveS6Footprint(primitive: S6GeometryPrimitive): S6Footprint2D {
  const geometry = normalizeGeometry(primitive);
  if (geometry.kind === "rect_prism") return { kind: "rectangle", widthMm: geometry.dimensionsMm.widthMm, depthMm: geometry.dimensionsMm.depthMm };
  if (geometry.kind === "round_prism") return { kind: "circle", radiusMm: geometry.radiusMm };
  return { kind: "polygon", vertices: normalizeS6Profile(geometry.profile).vertices };
}

function normalizeOpenSides(value: unknown): OpenSide[] {
  if (!Array.isArray(value)) throw s6Error("BOOTH_ENVELOPE_INVALID");
  const result = value.map((item) => {
    if (!S6_OPEN_SIDE_ORDER.includes(item as OpenSide)) throw s6Error("BOOTH_ENVELOPE_INVALID");
    return item as OpenSide;
  });
  if (new Set(result).size !== result.length) throw s6Error("BOOTH_ENVELOPE_INVALID");
  return result.sort((left, right) => S6_OPEN_SIDE_ORDER.indexOf(left) - S6_OPEN_SIDE_ORDER.indexOf(right));
}

function canonicalNumber(value: number, fieldPath: string): string {
  assertS6Integer(value, fieldPath);
  const result = String(value);
  if (/[eE]/.test(result)) throw s6Error("CANONICAL_NUMBER_INVALID", fieldPath);
  return result;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByCanonicalId(values: unknown[], key: string): unknown[] {
  return values.slice().sort((left, right) => {
    const leftValue = typeof left === "object" && left !== null ? (left as Record<string, unknown>)[key] : undefined;
    const rightValue = typeof right === "object" && right !== null ? (right as Record<string, unknown>)[key] : undefined;
    return compareCodeUnits(String(leftValue ?? ""), String(rightValue ?? ""));
  });
}

function canonicalValue(value: unknown, fieldPath: string, parentKey: string | null = null, normalizeShapes = true): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value, fieldPath);
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value instanceof Number) {
    throw s6Error("CANONICAL_NUMBER_INVALID", fieldPath);
  }
  if (Array.isArray(value)) {
    let values = value.map((item, index) => ({ item, index }));
    if (parentKey === "openSides") {
      values.sort((left, right) => S6_OPEN_SIDE_ORDER.indexOf(left.item as OpenSide) - S6_OPEN_SIDE_ORDER.indexOf(right.item as OpenSide));
    } else if (parentKey === "objects") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "objectId").map((item, index) => ({ item, index }));
    } else if (parentKey === "zones") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "zoneId").map((item, index) => ({ item, index }));
    } else if (parentKey === "materials") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "materialId").map((item, index) => ({ item, index }));
    } else if (parentKey === "cameras") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "viewId").map((item, index) => ({ item, index }));
    } else if (parentKey === "unknowns") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "unknownId").map((item, index) => ({ item, index }));
    } else if (parentKey === "assumptions") {
      values = sortByCanonicalId(values.map((entry) => entry.item), "assumptionId").map((item, index) => ({ item, index }));
    } else if (parentKey === "reviewedObjectIds" || parentKey === "unresolvedUnknownIds" || parentKey === "explicitSimplificationUnknownIds") {
      values.sort((left, right) => compareCodeUnits(String(left.item), String(right.item)));
    } else if (parentKey === "provenance") {
      values.sort((left, right) => compareCodeUnits(canonicalValue(left.item, `${fieldPath}[${left.index}]`), canonicalValue(right.item, `${fieldPath}[${right.index}]`)));
    }
    return `[${values.map((entry, index) => canonicalValue(entry.item, `${fieldPath}[${index}]`, parentKey)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (normalizeShapes && (record.kind === "rect_prism" || record.kind === "round_prism" || record.kind === "profile_extrusion")) {
      return canonicalValue(normalizeGeometry(record), fieldPath, parentKey, false);
    }
    const entries = Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map((key) => {
      let child = record[key];
      if (key === "openSides") child = normalizeOpenSides(child);
      if (key === "rotationMd") child = normalizeS6Rotation(child as S6RotationMd);
      if (key === "colorHex" && child !== null) {
        if (typeof child !== "string" || !/^#[0-9a-f]{6}$/i.test(child)) throw s6Error("SPATIAL_SCHEMA_INVALID", "colorHex");
        child = child.toLowerCase();
      }
      if (key === "xMm" || key === "yMm" || key === "zMm") {
        assertS6Integer(child, fieldPath ? `${fieldPath}.${key}` : key, { min: -S6_MAX_COORDINATE_MM, max: S6_MAX_COORDINATE_MM });
      }
      if (key === "profile") child = normalizeS6Profile(child as S6Profile);
      return `${JSON.stringify(key)}:${canonicalValue(child, fieldPath ? `${fieldPath}.${key}` : key, key)}`;
    }).join(",")}}`;
  }
  throw s6Error("SPATIAL_SCHEMA_INVALID", fieldPath);
}

export function canonicalS6Json(value: unknown): string {
  return canonicalValue(value, "", null);
}

export function hashS6ValidationReceipt(receipt: S6ValidationReceipt): Sha256 {
  return sha256(canonicalS6Json({ ...receipt, validationHash: "" }));
}

export function hashS6Model(model: S6SpatialModelRecord): { modelHash: string; canonicalByteSize: number; canonicalJson: string } {
  const content = {
    schemaVersion: model.schemaVersion,
    modelRevisionId: model.modelRevisionId,
    projectId: model.projectId,
    parentRevisionId: model.parentRevisionId,
    parentRevisionHash: model.parentRevisionHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    booth: model.booth,
    objects: model.objects,
    zones: model.zones,
    materials: model.materials,
    cameras: model.cameras,
    provenance: model.provenance,
    assumptions: model.assumptions,
    unknowns: model.unknowns,
    designFormReview: model.designFormReview,
  };
  const canonicalJson = canonicalS6Json(content);
  const bytes = new TextEncoder().encode(canonicalJson);
  return { modelHash: sha256(bytes), canonicalByteSize: bytes.byteLength, canonicalJson };
}

export function compilerObjectId(projectId: string, activeRevisionId: string, stableKey: string): string {
  return `s6o_${sha256(`${S6_ID_VERSION}|${projectId}|${activeRevisionId}|${stableKey}`).slice(0, 32)}`;
}

export function userObjectId(objectUuid: string): string {
  return `s6u_${objectUuid.replace(/-/g, "").toLowerCase()}`;
}

export function normalizeS6Geometry(primitive: S6GeometryPrimitive): S6GeometryPrimitive {
  return normalizeGeometry(primitive);
}

export type S6WorldPoint = { xMm: number; yMm: number; zMm: number };
export type S6WorldPoint2D = { xMm: number; zMm: number };
export type S6WorldShapePart =
  | { kind: "polygon"; points: S6WorldPoint2D[] }
  | { kind: "circle"; center: S6WorldPoint2D; radiusMm: number };

export type S6WorldGeometry = {
  objectId: string;
  points: S6WorldPoint[];
  footprint: S6WorldShapePart;
  parts: S6WorldShapePart[];
  boundsMm: { min: S6WorldPoint; max: S6WorldPoint };
  verticalInterval: { base: number; top: number };
};

type Affine3 = {
  origin: S6WorldPoint;
  xAxis: S6WorldPoint;
  yAxis: S6WorldPoint;
  zAxis: S6WorldPoint;
};

const WORLD_GEOMETRY_EPSILON = 1e-7;
const WORLD_FIXED_SCALE = 1_000_000;

function addPoint(left: S6WorldPoint, right: S6WorldPoint): S6WorldPoint {
  return { xMm: left.xMm + right.xMm, yMm: left.yMm + right.yMm, zMm: left.zMm + right.zMm };
}

function scalePoint(value: S6WorldPoint, scale: number): S6WorldPoint {
  return { xMm: value.xMm * scale, yMm: value.yMm * scale, zMm: value.zMm * scale };
}

function rotateS6Point(point: S6WorldPoint, rotation: S6RotationMd): S6WorldPoint {
  const rx = rotation.xMd * Math.PI / 180_000;
  const ry = rotation.yMd * Math.PI / 180_000;
  const rz = rotation.zMd * Math.PI / 180_000;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const x1 = point.xMm;
  const y1 = point.yMm * cx - point.zMm * sx;
  const z1 = point.yMm * sx + point.zMm * cx;
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return {
    xMm: x2 * cz - y2 * sz,
    yMm: x2 * sz + y2 * cz,
    zMm: z2,
  };
}

function localAffine(transform: S6SpatialObject["transform"]): Affine3 {
  return {
    origin: { ...transform.positionMm },
    xAxis: rotateS6Point({ xMm: 1, yMm: 0, zMm: 0 }, transform.rotationMd),
    yAxis: rotateS6Point({ xMm: 0, yMm: 1, zMm: 0 }, transform.rotationMd),
    zAxis: rotateS6Point({ xMm: 0, yMm: 0, zMm: 1 }, transform.rotationMd),
  };
}

function applyAffine(affine: Affine3, point: S6WorldPoint): S6WorldPoint {
  return addPoint(
    affine.origin,
    addPoint(scalePoint(affine.xAxis, point.xMm), addPoint(scalePoint(affine.yAxis, point.yMm), scalePoint(affine.zAxis, point.zMm))),
  );
}

function transformVector(affine: Affine3, vector: S6WorldPoint): S6WorldPoint {
  return addPoint(
    scalePoint(affine.xAxis, vector.xMm),
    addPoint(scalePoint(affine.yAxis, vector.yMm), scalePoint(affine.zAxis, vector.zMm)),
  );
}

function composeAffine(parent: Affine3, local: Affine3): Affine3 {
  return {
    origin: applyAffine(parent, local.origin),
    xAxis: transformVector(parent, local.xAxis),
    yAxis: transformVector(parent, local.yAxis),
    zAxis: transformVector(parent, local.zAxis),
  };
}

function affineFor(
  object: S6SpatialObject,
  byId: ReadonlyMap<string, S6SpatialObject>,
  cache: Map<string, Affine3>,
  visiting: Set<string>,
): Affine3 {
  const cached = cache.get(object.objectId);
  if (cached) return cached;
  if (visiting.has(object.objectId)) throw new Error("S6_WORLD_GEOMETRY_INVALID");
  visiting.add(object.objectId);
  const local = localAffine(object.transform);
  const parent = object.parentObjectId === null ? null : byId.get(object.parentObjectId);
  if (object.parentObjectId !== null && !parent) throw new Error("S6_WORLD_GEOMETRY_INVALID");
  const result = parent ? composeAffine(affineFor(parent, byId, cache, visiting), local) : local;
  visiting.delete(object.objectId);
  cache.set(object.objectId, result);
  return result;
}

function localFootprintVertices(primitive: S6GeometryPrimitive): S6WorldPoint2D[] {
  if (primitive.kind === "rect_prism") {
    return [
      { xMm: 0, zMm: 0 },
      { xMm: primitive.dimensionsMm.widthMm, zMm: 0 },
      { xMm: primitive.dimensionsMm.widthMm, zMm: primitive.dimensionsMm.depthMm },
      { xMm: 0, zMm: primitive.dimensionsMm.depthMm },
    ];
  }
  if (primitive.kind === "profile_extrusion") return primitive.profile.vertices.map((vertex) => ({ xMm: vertex.xMm, zMm: vertex.zMm }));
  return [];
}

function localHeight(primitive: S6GeometryPrimitive): number {
  return primitive.kind === "rect_prism" ? primitive.dimensionsMm.heightMm : primitive.heightMm;
}

function localBaseY(primitive: S6GeometryPrimitive): number {
  const height = localHeight(primitive);
  return primitive.localAnchor === "center" ? -height / 2 : 0;
}

function cross2(left: S6WorldPoint2D, middle: S6WorldPoint2D, right: S6WorldPoint2D): bigint {
  const lx = BigInt(Math.round(left.xMm * WORLD_FIXED_SCALE));
  const lz = BigInt(Math.round(left.zMm * WORLD_FIXED_SCALE));
  const mx = BigInt(Math.round(middle.xMm * WORLD_FIXED_SCALE));
  const mz = BigInt(Math.round(middle.zMm * WORLD_FIXED_SCALE));
  const rx = BigInt(Math.round(right.xMm * WORLD_FIXED_SCALE));
  const rz = BigInt(Math.round(right.zMm * WORLD_FIXED_SCALE));
  return (mx - lx) * (rz - lz) - (mz - lz) * (rx - lx);
}

function pointOnSegment2(point: S6WorldPoint2D, left: S6WorldPoint2D, right: S6WorldPoint2D): boolean {
  return cross2(left, point, right) === 0n &&
    point.xMm >= Math.min(left.xMm, right.xMm) - WORLD_GEOMETRY_EPSILON &&
    point.xMm <= Math.max(left.xMm, right.xMm) + WORLD_GEOMETRY_EPSILON &&
    point.zMm >= Math.min(left.zMm, right.zMm) - WORLD_GEOMETRY_EPSILON &&
    point.zMm <= Math.max(left.zMm, right.zMm) + WORLD_GEOMETRY_EPSILON;
}

function pointInPolygon(point: S6WorldPoint2D, polygon: readonly S6WorldPoint2D[], strict: boolean): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index]!;
    const right = polygon[(index + 1) % polygon.length]!;
    if (pointOnSegment2(point, left, right)) return !strict;
    const crosses = (left.zMm > point.zMm) !== (right.zMm > point.zMm);
    if (crosses) {
      const x = left.xMm + (right.xMm - left.xMm) * (point.zMm - left.zMm) / (right.zMm - left.zMm);
      if (x > point.xMm) inside = !inside;
    }
  }
  return inside;
}

function properSegmentsIntersect(leftStart: S6WorldPoint2D, leftEnd: S6WorldPoint2D, rightStart: S6WorldPoint2D, rightEnd: S6WorldPoint2D): boolean {
  const first = cross2(leftStart, leftEnd, rightStart);
  const second = cross2(leftStart, leftEnd, rightEnd);
  const third = cross2(rightStart, rightEnd, leftStart);
  const fourth = cross2(rightStart, rightEnd, leftEnd);
  return ((first > 0n && second < 0n) || (first < 0n && second > 0n)) &&
    ((third > 0n && fourth < 0n) || (third < 0n && fourth > 0n));
}

function polygonWitness(polygon: readonly S6WorldPoint2D[]): S6WorldPoint2D | null {
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    if (cross2(polygon[0]!, polygon[index]!, polygon[index + 1]!) !== 0n) {
      return {
        xMm: (polygon[0]!.xMm + polygon[index]!.xMm + polygon[index + 1]!.xMm) / 3,
        zMm: (polygon[0]!.zMm + polygon[index]!.zMm + polygon[index + 1]!.zMm) / 3,
      };
    }
  }
  return null;
}

function polygonOverlapPositive(left: readonly S6WorldPoint2D[], right: readonly S6WorldPoint2D[]): boolean {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftNext = left[(leftIndex + 1) % left.length]!;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (properSegmentsIntersect(left[leftIndex]!, leftNext, right[rightIndex]!, right[(rightIndex + 1) % right.length]!)) return true;
    }
  }
  if (left.some((point) => pointInPolygon(point, right, true)) || right.some((point) => pointInPolygon(point, left, true))) return true;
  const leftWitness = polygonWitness(left);
  const rightWitness = polygonWitness(right);
  return (leftWitness !== null && pointInPolygon(leftWitness, right, true)) ||
    (rightWitness !== null && pointInPolygon(rightWitness, left, true));
}

function distanceSquaredToSegment(point: S6WorldPoint2D, left: S6WorldPoint2D, right: S6WorldPoint2D): number {
  const dx = right.xMm - left.xMm;
  const dz = right.zMm - left.zMm;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0) {
    const px = point.xMm - left.xMm;
    const pz = point.zMm - left.zMm;
    return px * px + pz * pz;
  }
  const ratio = Math.max(0, Math.min(1, ((point.xMm - left.xMm) * dx + (point.zMm - left.zMm) * dz) / lengthSquared));
  const px = left.xMm + ratio * dx;
  const pz = left.zMm + ratio * dz;
  return (point.xMm - px) ** 2 + (point.zMm - pz) ** 2;
}

function shapePartOverlap(left: S6WorldShapePart, right: S6WorldShapePart): boolean {
  if (left.kind === "circle" && right.kind === "circle") {
    const dx = left.center.xMm - right.center.xMm;
    const dz = left.center.zMm - right.center.zMm;
    const radius = left.radiusMm + right.radiusMm;
    return dx * dx + dz * dz < radius * radius - WORLD_GEOMETRY_EPSILON;
  }
  if (left.kind === "polygon" && right.kind === "polygon") return polygonOverlapPositive(left.points, right.points);
  const circle = left.kind === "circle" ? left : right.kind === "circle" ? right : null;
  const polygon = left.kind === "polygon" ? left : right.kind === "polygon" ? right : null;
  if (!circle || !polygon) return false;
  if (pointInPolygon(circle.center, polygon.points, true)) return true;
  if (polygon.points.some((point) => (point.xMm - circle.center.xMm) ** 2 + (point.zMm - circle.center.zMm) ** 2 < circle.radiusMm ** 2 - WORLD_GEOMETRY_EPSILON)) return true;
  for (let index = 0; index < polygon.points.length; index += 1) {
    const distance = distanceSquaredToSegment(circle.center, polygon.points[index]!, polygon.points[(index + 1) % polygon.points.length]!);
    if (distance < circle.radiusMm ** 2 - WORLD_GEOMETRY_EPSILON) return true;
  }
  return false;
}

function partContains(outer: S6WorldShapePart, inner: S6WorldShapePart): boolean {
  if (outer.kind === "circle" && inner.kind === "circle") {
    const dx = outer.center.xMm - inner.center.xMm;
    const dz = outer.center.zMm - inner.center.zMm;
    return Math.sqrt(dx * dx + dz * dz) + inner.radiusMm <= outer.radiusMm + WORLD_GEOMETRY_EPSILON;
  }
  if (outer.kind === "circle" && inner.kind === "polygon") {
    return inner.points.every((point) => (point.xMm - outer.center.xMm) ** 2 + (point.zMm - outer.center.zMm) ** 2 <= outer.radiusMm ** 2 + WORLD_GEOMETRY_EPSILON);
  }
  if (outer.kind === "polygon" && inner.kind === "circle") {
    if (!pointInPolygon(inner.center, outer.points, false)) return false;
    for (let index = 0; index < outer.points.length; index += 1) {
      if (distanceSquaredToSegment(inner.center, outer.points[index]!, outer.points[(index + 1) % outer.points.length]!) < inner.radiusMm ** 2 - WORLD_GEOMETRY_EPSILON) return false;
    }
    return true;
  }
  if (outer.kind === "polygon" && inner.kind === "polygon") {
    if (!inner.points.every((point) => pointInPolygon(point, outer.points, false))) return false;
    for (let leftIndex = 0; leftIndex < inner.points.length; leftIndex += 1) {
      const left = inner.points[leftIndex]!;
      const right = inner.points[(leftIndex + 1) % inner.points.length]!;
      for (let rightIndex = 0; rightIndex < outer.points.length; rightIndex += 1) {
        if (properSegmentsIntersect(left, right, outer.points[rightIndex]!, outer.points[(rightIndex + 1) % outer.points.length]!)) return false;
      }
    }
    return true;
  }
  return false;
}

function pointInParts(point: S6WorldPoint2D, parts: readonly S6WorldShapePart[]): boolean {
  return parts.some((part) => part.kind === "circle"
    ? (point.xMm - part.center.xMm) ** 2 + (point.zMm - part.center.zMm) ** 2 <= part.radiusMm ** 2 + WORLD_GEOMETRY_EPSILON
    : pointInPolygon(point, part.points, false));
}

type S6WorldBoundary =
  | { kind: "segment"; start: S6WorldPoint2D; end: S6WorldPoint2D }
  | { kind: "circle"; center: S6WorldPoint2D; radiusMm: number };

function numericCross(left: S6WorldPoint2D, middle: S6WorldPoint2D, right: S6WorldPoint2D): number {
  return (middle.xMm - left.xMm) * (right.zMm - left.zMm) - (middle.zMm - left.zMm) * (right.xMm - left.xMm);
}

function boundaryDistance(point: S6WorldPoint2D, boundary: S6WorldBoundary): number {
  if (boundary.kind === "segment") return Math.sqrt(distanceSquaredToSegment(point, boundary.start, boundary.end));
  return Math.abs(Math.hypot(point.xMm - boundary.center.xMm, point.zMm - boundary.center.zMm) - boundary.radiusMm);
}

function boundariesEquivalent(left: S6WorldBoundary, right: S6WorldBoundary): boolean {
  if (left.kind === "circle" && right.kind === "circle") {
    return Math.abs(left.center.xMm - right.center.xMm) <= WORLD_GEOMETRY_EPSILON &&
      Math.abs(left.center.zMm - right.center.zMm) <= WORLD_GEOMETRY_EPSILON &&
      Math.abs(left.radiusMm - right.radiusMm) <= WORLD_GEOMETRY_EPSILON;
  }
  if (left.kind !== "segment" || right.kind !== "segment") return false;
  if (Math.abs(numericCross(left.start, left.end, right.start)) > WORLD_GEOMETRY_EPSILON ||
      Math.abs(numericCross(left.start, left.end, right.end)) > WORLD_GEOMETRY_EPSILON) return false;
  const overlapX = Math.min(left.end.xMm, left.start.xMm, right.end.xMm, right.start.xMm) <= Math.max(left.end.xMm, left.start.xMm, right.end.xMm, right.start.xMm) + WORLD_GEOMETRY_EPSILON &&
    Math.max(Math.min(left.end.xMm, left.start.xMm), Math.min(right.end.xMm, right.start.xMm)) <= Math.min(Math.max(left.end.xMm, left.start.xMm), Math.max(right.end.xMm, right.start.xMm)) + WORLD_GEOMETRY_EPSILON;
  const overlapZ = Math.max(Math.min(left.end.zMm, left.start.zMm), Math.min(right.end.zMm, right.start.zMm)) <= Math.min(Math.max(left.end.zMm, left.start.zMm), Math.max(right.end.zMm, right.start.zMm)) + WORLD_GEOMETRY_EPSILON;
  return overlapX && overlapZ;
}

function segmentParameter(point: S6WorldPoint2D, start: S6WorldPoint2D, end: S6WorldPoint2D): number {
  const dx = end.xMm - start.xMm;
  const dz = end.zMm - start.zMm;
  if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > WORLD_GEOMETRY_EPSILON) return (point.xMm - start.xMm) / dx;
  if (Math.abs(dz) > WORLD_GEOMETRY_EPSILON) return (point.zMm - start.zMm) / dz;
  return 0;
}

function addParameter(parameters: number[], value: number): void {
  if (Number.isFinite(value) && value >= -WORLD_GEOMETRY_EPSILON && value <= 1 + WORLD_GEOMETRY_EPSILON) {
    parameters.push(Math.max(0, Math.min(1, value)));
  }
}

function addSegmentSegmentParameters(left: S6WorldBoundary & { kind: "segment" }, right: S6WorldBoundary & { kind: "segment" }, parameters: number[]): void {
  const rX = left.end.xMm - left.start.xMm;
  const rZ = left.end.zMm - left.start.zMm;
  const sX = right.end.xMm - right.start.xMm;
  const sZ = right.end.zMm - right.start.zMm;
  const denominator = rX * sZ - rZ * sX;
  const qX = right.start.xMm - left.start.xMm;
  const qZ = right.start.zMm - left.start.zMm;
  if (Math.abs(denominator) <= WORLD_GEOMETRY_EPSILON) {
    if (Math.abs(qX * rZ - qZ * rX) <= WORLD_GEOMETRY_EPSILON) {
      addParameter(parameters, segmentParameter(right.start, left.start, left.end));
      addParameter(parameters, segmentParameter(right.end, left.start, left.end));
    }
    return;
  }
  const t = (qX * sZ - qZ * sX) / denominator;
  const u = (qX * rZ - qZ * rX) / denominator;
  if (u >= -WORLD_GEOMETRY_EPSILON && u <= 1 + WORLD_GEOMETRY_EPSILON) addParameter(parameters, t);
}

function addSegmentCircleParameters(segment: S6WorldBoundary & { kind: "segment" }, circle: S6WorldBoundary & { kind: "circle" }, parameters: number[]): void {
  const dx = segment.end.xMm - segment.start.xMm;
  const dz = segment.end.zMm - segment.start.zMm;
  const fx = segment.start.xMm - circle.center.xMm;
  const fz = segment.start.zMm - circle.center.zMm;
  const coefficientA = dx * dx + dz * dz;
  if (coefficientA <= WORLD_GEOMETRY_EPSILON) return;
  const coefficientB = 2 * (fx * dx + fz * dz);
  const coefficientC = fx * fx + fz * fz - circle.radiusMm * circle.radiusMm;
  const discriminant = coefficientB * coefficientB - 4 * coefficientA * coefficientC;
  if (discriminant < -WORLD_GEOMETRY_EPSILON) return;
  const root = Math.sqrt(Math.max(0, discriminant));
  addParameter(parameters, (-coefficientB - root) / (2 * coefficientA));
  addParameter(parameters, (-coefficientB + root) / (2 * coefficientA));
}

function addBoundaryParameters(segment: S6WorldBoundary & { kind: "segment" }, other: S6WorldBoundary, parameters: number[]): void {
  if (other.kind === "segment") addSegmentSegmentParameters(segment, other, parameters);
  else addSegmentCircleParameters(segment, other, parameters);
}

function uniqueParameters(parameters: readonly number[]): number[] {
  const sorted = parameters.slice().sort((left, right) => left - right);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]!) > WORLD_GEOMETRY_EPSILON) result.push(value);
  }
  return result;
}

function normalizeAngle(value: number): number {
  const fullTurn = Math.PI * 2;
  const result = value % fullTurn;
  return result < 0 ? result + fullTurn : result;
}

function addCircleBoundaryAngles(circle: S6WorldBoundary & { kind: "circle" }, other: S6WorldBoundary, angles: number[]): void {
  if (other.kind === "segment") {
    const parameters: number[] = [];
    addSegmentCircleParameters(other, circle, parameters);
    for (const parameter of parameters) {
      const point = {
        xMm: other.start.xMm + (other.end.xMm - other.start.xMm) * parameter,
        zMm: other.start.zMm + (other.end.zMm - other.start.zMm) * parameter,
      };
      angles.push(normalizeAngle(Math.atan2(point.zMm - circle.center.zMm, point.xMm - circle.center.xMm)));
    }
    return;
  }
  const dx = other.center.xMm - circle.center.xMm;
  const dz = other.center.zMm - circle.center.zMm;
  const distance = Math.hypot(dx, dz);
  if (distance <= WORLD_GEOMETRY_EPSILON || distance > circle.radiusMm + other.radiusMm + WORLD_GEOMETRY_EPSILON || distance < Math.abs(circle.radiusMm - other.radiusMm) - WORLD_GEOMETRY_EPSILON) return;
  const base = Math.atan2(dz, dx);
  const cosine = Math.max(-1, Math.min(1, (circle.radiusMm ** 2 + distance ** 2 - other.radiusMm ** 2) / (2 * circle.radiusMm * distance)));
  const offset = Math.acos(cosine);
  angles.push(normalizeAngle(base - offset), normalizeAngle(base + offset));
}

function boundariesForPart(part: S6WorldShapePart): S6WorldBoundary[] {
  if (part.kind === "circle") return [{ kind: "circle", center: part.center, radiusMm: part.radiusMm }];
  return part.points.map((start, index) => ({ kind: "segment" as const, start, end: part.points[(index + 1) % part.points.length]! }));
}

function pointInBoundaryShape(point: S6WorldPoint2D, part: S6WorldShapePart, strict: boolean): boolean {
  if (part.kind === "polygon") return pointInPolygon(point, part.points, strict);
  const distanceSquared = (point.xMm - part.center.xMm) ** 2 + (point.zMm - part.center.zMm) ** 2;
  return strict ? distanceSquared < part.radiusMm ** 2 - WORLD_GEOMETRY_EPSILON : distanceSquared <= part.radiusMm ** 2 + WORLD_GEOMETRY_EPSILON;
}

function splitSegmentBoundary(boundary: S6WorldBoundary & { kind: "segment" }, allBoundaries: readonly S6WorldBoundary[]): number[] {
  const parameters = [0, 1];
  for (const other of allBoundaries) if (other !== boundary) addBoundaryParameters(boundary, other, parameters);
  return uniqueParameters(parameters);
}

function splitCircleBoundary(boundary: S6WorldBoundary & { kind: "circle" }, allBoundaries: readonly S6WorldBoundary[]): number[] {
  const angles = [0];
  for (const other of allBoundaries) if (other !== boundary) addCircleBoundaryAngles(boundary, other, angles);
  const sorted = angles.map(normalizeAngle).sort((left, right) => left - right);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]!) > WORLD_GEOMETRY_EPSILON) result.push(value);
  }
  return result;
}

function pointOnCircle(circle: S6WorldBoundary & { kind: "circle" }, angle: number, radius = circle.radiusMm): S6WorldPoint2D {
  return {
    xMm: circle.center.xMm + Math.cos(angle) * radius,
    zMm: circle.center.zMm + Math.sin(angle) * radius,
  };
}

function polygonInteriorWitness(points: readonly S6WorldPoint2D[]): S6WorldPoint2D | null {
  try {
    for (const triangle of triangulate(points)) {
      const witness = {
        xMm: (triangle[0]!.xMm + triangle[1]!.xMm + triangle[2]!.xMm) / 3,
        zMm: (triangle[0]!.zMm + triangle[1]!.zMm + triangle[2]!.zMm) / 3,
      };
      if (pointInPolygon(witness, points, true)) return witness;
    }
  } catch {
    return null;
  }
  return null;
}

function boundaryOffsetDistance(point: S6WorldPoint2D, current: S6WorldBoundary, allBoundaries: readonly S6WorldBoundary[], maximum: number): number {
  let result = maximum;
  for (const other of allBoundaries) {
    if (other === current || boundariesEquivalent(current, other)) continue;
    const distance = boundaryDistance(point, other);
    if (distance <= WORLD_GEOMETRY_EPSILON) return 0;
    result = Math.min(result, distance / 4);
  }
  return result;
}

function checkSegmentBoundarySides(
  boundary: S6WorldBoundary & { kind: "segment" },
  point: S6WorldPoint2D,
  inner: S6WorldShapePart,
  outerParts: readonly S6WorldShapePart[],
  allBoundaries: readonly S6WorldBoundary[],
): boolean {
  const dx = boundary.end.xMm - boundary.start.xMm;
  const dz = boundary.end.zMm - boundary.start.zMm;
  const length = Math.hypot(dx, dz);
  if (length <= WORLD_GEOMETRY_EPSILON) return true;
  const distance = boundaryOffsetDistance(point, boundary, allBoundaries, length / 8);
  if (distance <= WORLD_GEOMETRY_EPSILON) return true;
  const normal = { xMm: -dz / length, zMm: dx / length };
  for (const sign of [-1, 1]) {
    const candidate = { xMm: point.xMm + normal.xMm * distance * sign, zMm: point.zMm + normal.zMm * distance * sign };
    if (pointInBoundaryShape(candidate, inner, false) && !pointInParts(candidate, outerParts)) return false;
  }
  return true;
}

function checkCircleBoundarySides(
  boundary: S6WorldBoundary & { kind: "circle" },
  angle: number,
  inner: S6WorldShapePart,
  outerParts: readonly S6WorldShapePart[],
  allBoundaries: readonly S6WorldBoundary[],
): boolean {
  const point = pointOnCircle(boundary, angle);
  const distance = boundaryOffsetDistance(point, boundary, allBoundaries, boundary.radiusMm / 8);
  if (distance <= WORLD_GEOMETRY_EPSILON) return true;
  for (const sign of [-1, 1]) {
    const candidate = pointOnCircle(boundary, angle, boundary.radiusMm + distance * sign);
    if (pointInBoundaryShape(candidate, inner, false) && !pointInParts(candidate, outerParts)) return false;
  }
  return true;
}

function innerBoundaryCovered(inner: S6WorldShapePart, outerParts: readonly S6WorldShapePart[], outerBoundaries: readonly S6WorldBoundary[]): boolean {
  for (const boundary of boundariesForPart(inner)) {
    if (boundary.kind === "segment") {
      const breakpoints = splitSegmentBoundary(boundary, outerBoundaries);
      for (let index = 0; index + 1 < breakpoints.length; index += 1) {
        const start = breakpoints[index]!;
        const end = breakpoints[index + 1]!;
        if (end - start <= WORLD_GEOMETRY_EPSILON) continue;
        const ratio = (start + end) / 2;
        const point = { xMm: boundary.start.xMm + (boundary.end.xMm - boundary.start.xMm) * ratio, zMm: boundary.start.zMm + (boundary.end.zMm - boundary.start.zMm) * ratio };
        if (!pointInParts(point, outerParts)) return false;
      }
    } else {
      const angles = splitCircleBoundary(boundary, outerBoundaries);
      for (let index = 0; index < angles.length; index += 1) {
        const start = angles[index]!;
        const end = index + 1 < angles.length ? angles[index + 1]! : angles[0]! + Math.PI * 2;
        if (end - start <= WORLD_GEOMETRY_EPSILON) continue;
        if (!pointInParts(pointOnCircle(boundary, (start + end) / 2), outerParts)) return false;
      }
    }
  }
  return true;
}

function outerBoundaryLeavesInnerGap(inner: S6WorldShapePart, outerParts: readonly S6WorldShapePart[]): boolean {
  const innerBoundaries = boundariesForPart(inner);
  const outerBoundaries = outerParts.flatMap(boundariesForPart);
  const allBoundaries = innerBoundaries.concat(outerBoundaries);
  for (const boundary of outerBoundaries) {
    if (boundary.kind === "segment") {
      const breakpoints = splitSegmentBoundary(boundary, allBoundaries);
      for (let index = 0; index + 1 < breakpoints.length; index += 1) {
        const start = breakpoints[index]!;
        const end = breakpoints[index + 1]!;
        if (end - start <= WORLD_GEOMETRY_EPSILON) continue;
        const ratio = (start + end) / 2;
        const point = { xMm: boundary.start.xMm + (boundary.end.xMm - boundary.start.xMm) * ratio, zMm: boundary.start.zMm + (boundary.end.zMm - boundary.start.zMm) * ratio };
        if (pointInBoundaryShape(point, inner, true) && !checkSegmentBoundarySides(boundary, point, inner, outerParts, allBoundaries)) return true;
      }
    } else {
      const angles = splitCircleBoundary(boundary, allBoundaries);
      for (let index = 0; index < angles.length; index += 1) {
        const start = angles[index]!;
        const end = index + 1 < angles.length ? angles[index + 1]! : angles[0]! + Math.PI * 2;
        if (end - start <= WORLD_GEOMETRY_EPSILON) continue;
        const angle = (start + end) / 2;
        if (pointInBoundaryShape(pointOnCircle(boundary, angle), inner, true) && !checkCircleBoundarySides(boundary, angle, inner, outerParts, allBoundaries)) return true;
      }
    }
  }
  return false;
}

function convexHull(points: readonly S6WorldPoint2D[]): S6WorldPoint2D[] {
  const sorted = points
    .slice()
    .sort((left, right) => left.xMm - right.xMm || left.zMm - right.zMm);
  const unique: S6WorldPoint2D[] = [];
  for (const point of sorted) {
    if (!unique.some((item) => Math.abs(item.xMm - point.xMm) <= WORLD_GEOMETRY_EPSILON && Math.abs(item.zMm - point.zMm) <= WORLD_GEOMETRY_EPSILON)) unique.push(point);
  }
  if (unique.length <= 2) return unique;
  const lower: S6WorldPoint2D[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0n) lower.pop();
    lower.push(point);
  }
  const upper: S6WorldPoint2D[] = [];
  for (const point of unique.slice().reverse()) {
    while (upper.length >= 2 && cross2(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0n) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function triangulate(vertices: readonly S6WorldPoint2D[]): S6WorldPoint2D[][] {
  if (vertices.length === 3) return [vertices.slice() as S6WorldPoint2D[]];
  const area = vertices.reduce((total, point, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    return total + point.xMm * next.zMm - point.zMm * next.xMm;
  }, 0);
  const orientation = area >= 0 ? 1n : -1n;
  const remaining = vertices.map((_point, index) => index);
  const triangles: S6WorldPoint2D[][] = [];
  while (remaining.length > 3) {
    let earFound = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = vertices[remaining[(index + remaining.length - 1) % remaining.length]!]!;
      const current = vertices[remaining[index]!]!;
      const next = vertices[remaining[(index + 1) % remaining.length]!]!;
      if (cross2(previous, current, next) * orientation <= 0n) continue;
      const containsVertex = remaining.some((candidate, candidateIndex) => {
        if (candidateIndex === index || candidateIndex === (index + remaining.length - 1) % remaining.length || candidateIndex === (index + 1) % remaining.length) return false;
        const point = vertices[candidate]!;
        const first = cross2(previous, current, point) * orientation;
        const second = cross2(current, next, point) * orientation;
        const third = cross2(next, previous, point) * orientation;
        return first >= 0n && second >= 0n && third >= 0n;
      });
      if (containsVertex) continue;
      triangles.push([previous, current, next]);
      remaining.splice(index, 1);
      earFound = true;
      break;
    }
    if (!earFound) throw new Error("S6_WORLD_GEOMETRY_INVALID");
  }
  triangles.push(remaining.map((index) => vertices[index]!));
  return triangles;
}

function shapePartForPrism(affine: Affine3, primitive: S6GeometryPrimitive): S6WorldShapePart[] {
  const baseY = localBaseY(primitive);
  const height = localHeight(primitive);
  const vertices = localFootprintVertices(primitive);
  const base = vertices.map((point) => applyAffine(affine, { xMm: point.xMm, yMm: baseY, zMm: point.zMm }));
  if (Math.abs(affine.yAxis.xMm) <= WORLD_GEOMETRY_EPSILON && Math.abs(affine.yAxis.zMm) <= WORLD_GEOMETRY_EPSILON) {
    return [{ kind: "polygon", points: base.map((point) => ({ xMm: point.xMm, zMm: point.zMm })) }];
  }
  const triangles = triangulate(vertices);
  return triangles.map((triangle) => {
    const projected = triangle.flatMap((point) => {
      const bottom = applyAffine(affine, { xMm: point.xMm, yMm: baseY, zMm: point.zMm });
      const upper = applyAffine(affine, { xMm: point.xMm, yMm: baseY + height, zMm: point.zMm });
      return [{ xMm: bottom.xMm, zMm: bottom.zMm }, { xMm: upper.xMm, zMm: upper.zMm }];
    });
    return { kind: "polygon" as const, points: convexHull(projected) };
  }).filter((part) => part.points.length >= 3);
}

function roundPartForCylinder(affine: Affine3, primitive: Extract<S6GeometryPrimitive, { kind: "round_prism" }>): S6WorldShapePart[] {
  const baseY = localBaseY(primitive);
  const topY = baseY + primitive.heightMm;
  const horizontalCircle = Math.abs(affine.yAxis.xMm) <= WORLD_GEOMETRY_EPSILON &&
    Math.abs(affine.yAxis.zMm) <= WORLD_GEOMETRY_EPSILON &&
    Math.abs(affine.xAxis.yMm) <= WORLD_GEOMETRY_EPSILON &&
    Math.abs(affine.zAxis.yMm) <= WORLD_GEOMETRY_EPSILON;
  if (horizontalCircle) {
    const center = applyAffine(affine, { xMm: 0, yMm: baseY, zMm: 0 });
    return [{ kind: "circle", center: { xMm: center.xMm, zMm: center.zMm }, radiusMm: primitive.radiusMm }];
  }
  const points: S6WorldPoint2D[] = [];
  for (const yMm of [baseY, topY]) {
    for (let index = 0; index < 96; index += 1) {
      const angle = index * Math.PI * 2 / 96;
      const point = applyAffine(affine, { xMm: Math.cos(angle) * primitive.radiusMm, yMm, zMm: Math.sin(angle) * primitive.radiusMm });
      points.push({ xMm: point.xMm, zMm: point.zMm });
    }
  }
  return [{ kind: "polygon", points: convexHull(points) }];
}

function roundBounds(affine: Affine3, primitive: Extract<S6GeometryPrimitive, { kind: "round_prism" }>): { min: S6WorldPoint; max: S6WorldPoint } {
  const baseY = localBaseY(primitive);
  const topY = baseY + primitive.heightMm;
  const min: S6WorldPoint = { xMm: Number.POSITIVE_INFINITY, yMm: Number.POSITIVE_INFINITY, zMm: Number.POSITIVE_INFINITY };
  const max: S6WorldPoint = { xMm: Number.NEGATIVE_INFINITY, yMm: Number.NEGATIVE_INFINITY, zMm: Number.NEGATIVE_INFINITY };
  for (const axis of ["xMm", "yMm", "zMm"] as const) {
    const axisValue = (point: S6WorldPoint) => point[axis];
    const circleRadius = primitive.radiusMm * Math.sqrt(axisValue(affine.xAxis) ** 2 + axisValue(affine.zAxis) ** 2);
    const lowerY = affine.origin[axis] + affine.yAxis[axis] * baseY;
    const upperY = affine.origin[axis] + affine.yAxis[axis] * topY;
    min[axis] = Math.min(lowerY, upperY) - circleRadius;
    max[axis] = Math.max(lowerY, upperY) + circleRadius;
  }
  return { min, max };
}

function boundsForPoints(points: readonly S6WorldPoint[]): { min: S6WorldPoint; max: S6WorldPoint } {
  if (points.length === 0) throw new Error("S6_WORLD_GEOMETRY_INVALID");
  return {
    min: {
      xMm: Math.min(...points.map((point) => point.xMm)),
      yMm: Math.min(...points.map((point) => point.yMm)),
      zMm: Math.min(...points.map((point) => point.zMm)),
    },
    max: {
      xMm: Math.max(...points.map((point) => point.xMm)),
      yMm: Math.max(...points.map((point) => point.yMm)),
      zMm: Math.max(...points.map((point) => point.zMm)),
    },
  };
}

function buildWorldGeometry(object: S6SpatialObject, affine: Affine3): S6WorldGeometry {
  const primitive = normalizeGeometry(object.primitive);
  const baseY = localBaseY(primitive);
  const height = localHeight(primitive);
  let points: S6WorldPoint[];
  let parts: S6WorldShapePart[];
  let bounds: { min: S6WorldPoint; max: S6WorldPoint };
  if (primitive.kind === "round_prism") {
    points = [];
    for (const yMm of [baseY, baseY + height]) {
      for (let index = 0; index < S6_ROUND_RENDER_FACETS; index += 1) {
        const angle = index * Math.PI * 2 / S6_ROUND_RENDER_FACETS;
        points.push(applyAffine(affine, { xMm: Math.cos(angle) * primitive.radiusMm, yMm, zMm: Math.sin(angle) * primitive.radiusMm }));
      }
    }
    parts = roundPartForCylinder(affine, primitive);
    bounds = roundBounds(affine, primitive);
  } else {
    const vertices = localFootprintVertices(primitive);
    const basePoints = vertices.map((point) => applyAffine(affine, { xMm: point.xMm, yMm: baseY, zMm: point.zMm }));
    const topPoints = vertices.map((point) => applyAffine(affine, { xMm: point.xMm, yMm: baseY + height, zMm: point.zMm }));
    points = basePoints.concat(topPoints);
    parts = shapePartForPrism(affine, primitive);
    bounds = boundsForPoints(points);
  }
  const footprint = parts[0];
  if (!footprint) throw new Error("S6_WORLD_GEOMETRY_INVALID");
  return {
    objectId: object.objectId,
    points,
    footprint,
    parts,
    boundsMm: bounds,
    verticalInterval: { base: bounds.min.yMm, top: bounds.max.yMm },
  };
}

export function deriveS6WorldGeometry(model: S6SpatialModelRecord): S6WorldGeometry[] {
  const byId = new Map(model.objects.map((object) => [object.objectId, object]));
  const cache = new Map<string, Affine3>();
  return model.objects.map((object) => buildWorldGeometry(object, affineFor(object, byId, cache, new Set())));
}

function shapeContainedByParts(inner: S6WorldShapePart, outerParts: readonly S6WorldShapePart[]): boolean {
  if (outerParts.length === 0 || !innerBoundaryCovered(inner, outerParts, outerParts.flatMap(boundariesForPart))) return false;
  const witness = inner.kind === "circle" ? inner.center : polygonInteriorWitness(inner.points);
  if (witness === null || !pointInParts(witness, outerParts)) return false;
  return !outerBoundaryLeavesInnerGap(inner, outerParts);
}

export function containsS6WorldGeometry(outer: S6WorldGeometry, inner: S6WorldGeometry): boolean {
  return inner.parts.every((part) => shapeContainedByParts(part, outer.parts));
}

export function containsS6WorldBooth(geometry: S6WorldGeometry, widthMm: number, depthMm: number): boolean {
  const booth: S6WorldShapePart = {
    kind: "polygon",
    points: [
      { xMm: 0, zMm: 0 },
      { xMm: widthMm, zMm: 0 },
      { xMm: widthMm, zMm: depthMm },
      { xMm: 0, zMm: depthMm },
    ],
  };
  return geometry.parts.every((part) => partContains(booth, part));
}

export function overlapsS6WorldGeometry(left: S6WorldGeometry, right: S6WorldGeometry): boolean {
  return left.parts.some((leftPart) => right.parts.some((rightPart) => shapePartOverlap(leftPart, rightPart)));
}
