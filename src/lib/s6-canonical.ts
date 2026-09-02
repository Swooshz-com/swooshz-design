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
  S6SpatialModelRecord,
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
