import {
  type S6GeometryPrimitive,
  type S6Profile,
  type S6ToS7Handoff,
  type S8ConstructionV1,
  type S8MaxPayloadV1,
  type S8SourceStampV1,
  type Sha256,
  type UUID,
} from "./types";
import { canonicalS6Json, normalizeS6Geometry } from "./s6-canonical";
import { cloneJson, jcs, privateStorageKey, sha256, uuidV4Pattern } from "./utils";

export const S8_PAYLOAD_SCHEMA_VERSION = "s8.max.payload-v1" as const;
export const S8_SOURCE_STAMP_SCHEMA_VERSION = "s8-source-stamp-v1" as const;
export const S8_CONSTRUCTION_VERSION = "s8-max-scene-construction-v1" as const;
export const S8_SEMANTIC_VERSION = "s8-max-semantic-v1" as const;
export const S8_TRANSPORT_FILE_NAME = "swooshz-s8-payload.json" as const;
export const S8_NATIVE_FILE_NAME = "swooshz-s8-model.max" as const;

export const S8_MAX_PAYLOAD_BYTES = 2_000_000;
export const S8_MAX_OBJECTS = 256;
export const S8_MAX_HIERARCHY_DEPTH = 64;
export const S8_MAX_PROFILE_VERTICES = 24;
export const S8_MAX_ROUND_SEGMENTS = 24;
export const S8_MAX_VERTICES_PER_OBJECT = 96;
export const S8_MAX_FACES_PER_OBJECT = 128;
export const S8_MAX_TOTAL_VERTICES = 24_576;
export const S8_MAX_TOTAL_FACES = 32_768;
export const S8_MAX_ZONES = 64;
export const S8_MAX_MATERIALS = 128;
export const S8_MAX_LABEL_CODE_POINTS = 120;
export const S8_MAX_IDENTITY_KEY_CODE_POINTS = 240;
export const S8_MAX_NODE_NAME_CODE_POINTS = 120;
export const S8_MAX_USER_PROPERTIES_BYTES = 4_096;
export const S8_MAX_GENERATION_RECEIPT_BYTES = 256_000;
export const S8_MAX_READBACK_BYTES = 2_000_000;
export const S8_MAX_MANIFEST_BYTES = 2_000_000;
export const S8_MAX_NATIVE_BYTES = 256 * 1024 * 1024;
export const S8_MAX_LOCAL_SECONDS = 30;
export const S8_MAX_MAX_INSTRUCTION_SECONDS = 900;
export const S8_MAX_PROVIDER_WATCHDOG_SECONDS = 1_800;
export const S8_MAX_CANDIDATE_ATTEMPTS = 2;
export const S8_MAX_PROVIDER_ATTEMPTS = 3;
export const S8_POSITION_TOLERANCE_MM = 0.1;
export const S8_MATRIX_TOLERANCE = 1e-6;
export const S8_NORMAL_TOLERANCE = 1e-5;

const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SECRET_KEY = /(?:token|secret|password|authorization|cookie|privatekey|signedurl|credential)/iu;
const PATH_OR_URL = /(?:^[A-Za-z]:[\\/]|^\\\\|^\/|(?:^|[\\/])\.\.?(?:[\\/]|$)|(?:https?|data|file):)/iu;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;

export type S8PayloadErrorCode =
  | "S8_PAYLOAD_INVALID"
  | "S8_RESOURCE_LIMIT"
  | "S8_PROFILE_TRIANGULATION_FAILED"
  | "S8_UNSUPPORTED_GEOMETRY"
  | "S8_SOURCE_STALE"
  | "S7_CROSS_OUTPUT_MISMATCH";

export class S8PayloadError extends Error {
  readonly code: S8PayloadErrorCode;
  readonly field: string;

  constructor(code: S8PayloadErrorCode, field = "payload") {
    super(`${code}: ${field}`);
    this.name = "S8PayloadError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: S8PayloadErrorCode, field = "payload"): never {
  throw new S8PayloadError(code, field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("S8_PAYLOAD_INVALID", field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("S8_PAYLOAD_INVALID", field);
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = record(value, field);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail("S8_PAYLOAD_INVALID", field);
  return result;
}

function text(value: unknown, field: string, maxCodePoints = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Array.from(value).length > maxCodePoints || CONTROL.test(value)) {
    fail("S8_PAYLOAD_INVALID", field);
  }
  if (PATH_OR_URL.test(value) || EMAIL.test(value)) fail("S8_PAYLOAD_INVALID", field);
  return value;
}

function safeValue(value: unknown, field: string, seen: WeakSet<object>, key: string | null = null): void {
  if (key !== null && SECRET_KEY.test(key)) fail("S8_PAYLOAD_INVALID", field);
  if (typeof value === "string") {
    text(value, field, 8_192, true);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("S8_PAYLOAD_INVALID", field);
    return;
  }
  if (typeof value === "boolean" || value === null) return;
  if (typeof value !== "object" || value instanceof Number || value instanceof String || value instanceof Boolean) fail("S8_PAYLOAD_INVALID", field);
  if (seen.has(value)) fail("S8_PAYLOAD_INVALID", field);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => safeValue(item, `${field}[${String(index)}]`, seen));
  else Object.entries(value).forEach(([childKey, childValue]) => safeValue(childValue, `${field}.${childKey}`, seen, childKey));
  seen.delete(value);
}

function uuid(value: unknown, field: string): UUID {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) fail("S8_PAYLOAD_INVALID", field);
  return value as UUID;
}

function hash(value: unknown, field: string): Sha256 {
  if (typeof value !== "string" || !SHA256.test(value)) fail("S8_PAYLOAD_INVALID", field);
  return value as Sha256;
}

function safeInteger(value: unknown, field: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail("S8_PAYLOAD_INVALID", field);
  return value;
}

function nonNegativeInteger(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  return safeInteger(value, field, 0, max);
}

function validateStamp(value: unknown): S8SourceStampV1 {
  const item = exactKeys(value, [
    "schemaVersion", "projectId", "s6RevisionId", "s6RevisionHash", "sourceS5Fingerprint",
    "sourceS5ApprovalEventId", "sourceS5Generation", "s6ValidationReceiptId", "s6ValidationReceiptHash",
    "s6HandoffSchemaVersion", "s6HandoffDigest", "s7ArtifactId", "s7ArtifactHash", "s7ArtifactSize",
    "s7ManifestId", "s7ManifestHash", "s7ReadbackReceiptId", "s7ReadbackReceiptHash",
  ], "sourceStamp");
  if (item.schemaVersion !== S8_SOURCE_STAMP_SCHEMA_VERSION || item.s6HandoffSchemaVersion !== "s6-to-s7-handoff-v1") fail("S8_PAYLOAD_INVALID", "sourceStamp.schemaVersion");
  const result = {
    schemaVersion: item.schemaVersion,
    projectId: uuid(item.projectId, "sourceStamp.projectId"),
    s6RevisionId: uuid(item.s6RevisionId, "sourceStamp.s6RevisionId"),
    s6RevisionHash: hash(item.s6RevisionHash, "sourceStamp.s6RevisionHash"),
    sourceS5Fingerprint: hash(item.sourceS5Fingerprint, "sourceStamp.sourceS5Fingerprint"),
    sourceS5ApprovalEventId: uuid(item.sourceS5ApprovalEventId, "sourceStamp.sourceS5ApprovalEventId"),
    sourceS5Generation: nonNegativeInteger(item.sourceS5Generation, "sourceStamp.sourceS5Generation"),
    s6ValidationReceiptId: uuid(item.s6ValidationReceiptId, "sourceStamp.s6ValidationReceiptId"),
    s6ValidationReceiptHash: hash(item.s6ValidationReceiptHash, "sourceStamp.s6ValidationReceiptHash"),
    s6HandoffSchemaVersion: item.s6HandoffSchemaVersion,
    s6HandoffDigest: hash(item.s6HandoffDigest, "sourceStamp.s6HandoffDigest"),
    s7ArtifactId: uuid(item.s7ArtifactId, "sourceStamp.s7ArtifactId"),
    s7ArtifactHash: hash(item.s7ArtifactHash, "sourceStamp.s7ArtifactHash"),
    s7ArtifactSize: nonNegativeInteger(item.s7ArtifactSize, "sourceStamp.s7ArtifactSize", S8_MAX_NATIVE_BYTES),
    s7ManifestId: uuid(item.s7ManifestId, "sourceStamp.s7ManifestId"),
    s7ManifestHash: hash(item.s7ManifestHash, "sourceStamp.s7ManifestHash"),
    s7ReadbackReceiptId: uuid(item.s7ReadbackReceiptId, "sourceStamp.s7ReadbackReceiptId"),
    s7ReadbackReceiptHash: hash(item.s7ReadbackReceiptHash, "sourceStamp.s7ReadbackReceiptHash"),
  } as S8SourceStampV1;
  return result;
}

function validateConstruction(value: unknown): S8ConstructionV1 {
  const item = exactKeys(value, [
    "algorithmVersion", "nativeGeometryClass", "axisConvention", "roundSegments",
    "profileTriangulation", "materialPolicy", "noExternalAssets",
  ], "construction");
  if (
    item.algorithmVersion !== S8_CONSTRUCTION_VERSION ||
    item.nativeGeometryClass !== "Editable_Poly" ||
    item.axisConvention !== "s6-to-max-x-right-zup-minus-yfront-v1" ||
    item.roundSegments !== S8_MAX_ROUND_SEGMENTS ||
    item.profileTriangulation !== "ear-clipping-s6-order-v1" ||
    item.materialPolicy !== "physical-material-bounded-v1" ||
    item.noExternalAssets !== true
  ) fail("S8_PAYLOAD_INVALID", "construction");
  return item as S8ConstructionV1;
}

function validateGeometry(value: unknown, field: string): S6GeometryPrimitive {
  const item = record(value, field);
  const kind = item.kind;
  if (kind === "profile_extrusion") {
    const profile = record(item.profile, `${field}.profile`);
    if (Array.isArray(profile.vertices) && profile.vertices.length > S8_MAX_PROFILE_VERTICES) fail("S8_RESOURCE_LIMIT", `${field}.profile.vertices`);
  }
  try {
    const geometry = normalizeS6Geometry(value as S6GeometryPrimitive);
    if (geometry.kind === "profile_extrusion" && geometry.profile.vertices.length > S8_MAX_PROFILE_VERTICES) fail("S8_RESOURCE_LIMIT", `${field}.profile.vertices`);
    return geometry;
  } catch (error) {
    if (error instanceof S8PayloadError) throw error;
    if (kind === "profile_extrusion") fail("S8_PROFILE_TRIANGULATION_FAILED", field);
    fail("S8_PAYLOAD_INVALID", field);
  }
}

function validateS6Handoff(value: unknown): S6ToS7Handoff {
  const handoff = exactKeys(value, [
    "schemaVersion", "projectId", "acceptedRevisionId", "acceptedRevisionHash", "sourceS5Fingerprint",
    "spatialSchemaVersion", "units", "coordinateConvention", "booth", "objects", "hierarchy", "zones",
    "requirements", "materials", "assumptions", "unknowns", "validationReceipt", "eligibility",
  ], "s6Handoff");
  if (handoff.schemaVersion !== "s6-to-s7-handoff-v1" || handoff.spatialSchemaVersion !== "s6-spatial-model-v1" || handoff.units !== "millimetres") fail("S8_PAYLOAD_INVALID", "s6Handoff.schemaVersion");
  uuid(handoff.projectId, "s6Handoff.projectId");
  uuid(handoff.acceptedRevisionId, "s6Handoff.acceptedRevisionId");
  hash(handoff.acceptedRevisionHash, "s6Handoff.acceptedRevisionHash");
  hash(handoff.sourceS5Fingerprint, "s6Handoff.sourceS5Fingerprint");
  const convention = exactKeys(handoff.coordinateConvention, ["version", "units", "handedness", "origin", "xAxis", "yAxis", "zAxis"], "s6Handoff.coordinateConvention");
  if (convention.version !== "booth-local-right-handed-v1" || convention.units !== "millimetres" || convention.handedness !== "right-handed" || convention.origin !== "north-west-floor-corner" || convention.xAxis !== "east" || convention.yAxis !== "up" || convention.zAxis !== "south") fail("S8_PAYLOAD_INVALID", "s6Handoff.coordinateConvention");
  const booth = exactKeys(handoff.booth, ["widthMm", "depthMm", "openSides", "maxHeightMm", "heightState"], "s6Handoff.booth");
  safeInteger(booth.widthMm, "s6Handoff.booth.widthMm", 1, 1_000_000);
  safeInteger(booth.depthMm, "s6Handoff.booth.depthMm", 1, 1_000_000);
  if (!Array.isArray(booth.openSides) || booth.openSides.length > 4 || new Set(booth.openSides).size !== booth.openSides.length || booth.openSides.some((side) => !["north", "east", "south", "west"].includes(String(side)))) fail("S8_PAYLOAD_INVALID", "s6Handoff.booth.openSides");
  if (booth.maxHeightMm !== null) safeInteger(booth.maxHeightMm, "s6Handoff.booth.maxHeightMm", 1, 1_000_000);
  if (booth.heightState !== (booth.maxHeightMm === null ? "unknown" : "known")) fail("S8_PAYLOAD_INVALID", "s6Handoff.booth.heightState");
  const objects = handoff.objects;
  if (!Array.isArray(objects) || objects.length > S8_MAX_OBJECTS) fail("S8_RESOURCE_LIMIT", "s6Handoff.objects");
  const objectIds = new Set<string>();
  const identityKeys = new Set<string>();
  for (let index = 0; index < objects.length; index += 1) {
    const field = `s6Handoff.objects[${String(index)}]`;
    const object = exactKeys(objects[index], [
      "objectId", "identityKey", "parentObjectId", "objectType", "role", "geometry", "footprint", "transform",
      "boundsMm", "zoneIds", "requirementIds", "materialIds", "provenance", "unknownIds",
    ], field);
    const objectId = text(object.objectId, `${field}.objectId`, S8_MAX_IDENTITY_KEY_CODE_POINTS);
    const identityKey = text(object.identityKey, `${field}.identityKey`, S8_MAX_IDENTITY_KEY_CODE_POINTS);
    if (objectIds.has(objectId) || identityKeys.has(identityKey)) fail("S8_PAYLOAD_INVALID", field);
    objectIds.add(objectId); identityKeys.add(identityKey);
    if (object.parentObjectId !== null) text(object.parentObjectId, `${field}.parentObjectId`, S8_MAX_IDENTITY_KEY_CODE_POINTS);
    text(object.objectType, `${field}.objectType`, 80);
    text(object.role, `${field}.role`, 80);
    safeValue(object.provenance, `${field}.provenance`, new WeakSet<object>());
    validateGeometry(object.geometry, `${field}.geometry`);
    safeValue(object.footprint, `${field}.footprint`, new WeakSet<object>());
    safeValue(object.transform, `${field}.transform`, new WeakSet<object>());
    safeValue(object.boundsMm, `${field}.boundsMm`, new WeakSet<object>());
    for (const key of ["zoneIds", "requirementIds", "materialIds", "unknownIds"] as const) {
      if (!Array.isArray(object[key]) || new Set(object[key]).size !== object[key].length || object[key].some((item) => typeof item !== "string")) fail("S8_PAYLOAD_INVALID", `${field}.${key}`);
    }
  }
  const hierarchy = handoff.hierarchy;
  if (!Array.isArray(hierarchy) || hierarchy.length !== objects.length) fail("S8_PAYLOAD_INVALID", "s6Handoff.hierarchy");
  const hierarchyIds = new Set<string>();
  for (let index = 0; index < hierarchy.length; index += 1) {
    const item = exactKeys(hierarchy[index], ["objectId", "parentObjectId"], `s6Handoff.hierarchy[${String(index)}]`);
    const objectId = text(item.objectId, `s6Handoff.hierarchy[${String(index)}].objectId`, S8_MAX_IDENTITY_KEY_CODE_POINTS);
    if (hierarchyIds.has(objectId) || !objectIds.has(objectId)) fail("S8_PAYLOAD_INVALID", "s6Handoff.hierarchy");
    hierarchyIds.add(objectId);
    if (item.parentObjectId !== null && !objectIds.has(text(item.parentObjectId, "s6Handoff.hierarchy.parentObjectId", S8_MAX_IDENTITY_KEY_CODE_POINTS))) fail("S8_PAYLOAD_INVALID", "s6Handoff.hierarchy.parentObjectId");
  }
  const receipt = exactKeys(handoff.validationReceipt, ["receiptId", "validationHash", "outcome"], "s6Handoff.validationReceipt");
  uuid(receipt.receiptId, "s6Handoff.validationReceipt.receiptId");
  hash(receipt.validationHash, "s6Handoff.validationReceipt.validationHash");
  if (receipt.outcome !== "pass" && receipt.outcome !== "pass_with_warnings") fail("S8_PAYLOAD_INVALID", "s6Handoff.validationReceipt.outcome");
  const eligibility = exactKeys(handoff.eligibility, ["currentAccepted", "sourceCurrent", "stale"], "s6Handoff.eligibility");
  if (eligibility.currentAccepted !== true || eligibility.sourceCurrent !== true || eligibility.stale !== false) fail("S8_SOURCE_STALE", "s6Handoff.eligibility");
  safeValue(handoff.zones, "s6Handoff.zones", new WeakSet<object>());
  safeValue(handoff.requirements, "s6Handoff.requirements", new WeakSet<object>());
  safeValue(handoff.materials, "s6Handoff.materials", new WeakSet<object>());
  safeValue(handoff.assumptions, "s6Handoff.assumptions", new WeakSet<object>());
  safeValue(handoff.unknowns, "s6Handoff.unknowns", new WeakSet<object>());
  if (!Array.isArray(handoff.zones) || handoff.zones.length > S8_MAX_ZONES || !Array.isArray(handoff.materials) || handoff.materials.length > S8_MAX_MATERIALS) fail("S8_RESOURCE_LIMIT", "s6Handoff");
  return handoff as S6ToS7Handoff;
}

export const S8_CONSTRUCTION: S8ConstructionV1 = {
  algorithmVersion: S8_CONSTRUCTION_VERSION,
  nativeGeometryClass: "Editable_Poly",
  axisConvention: "s6-to-max-x-right-zup-minus-yfront-v1",
  roundSegments: S8_MAX_ROUND_SEGMENTS,
  profileTriangulation: "ear-clipping-s6-order-v1",
  materialPolicy: "physical-material-bounded-v1",
  noExternalAssets: true,
};

export function validateS8SourceStamp(value: unknown): S8SourceStampV1 {
  safeValue(value, "sourceStamp", new WeakSet<object>());
  return validateStamp(value);
}

export function sourceStampDigest(stamp: S8SourceStampV1): Sha256 {
  validateStamp(stamp);
  return sha256(Buffer.from(jcs(stamp), "utf8"));
}

export const s8SourceStampDigest = sourceStampDigest;

export function validateS8Payload(value: unknown): S8MaxPayloadV1 {
  safeValue(value, "payload", new WeakSet<object>());
  const payload = exactKeys(value, ["schemaVersion", "sourceStamp", "s6Handoff", "construction"], "payload");
  if (payload.schemaVersion !== S8_PAYLOAD_SCHEMA_VERSION) fail("S8_PAYLOAD_INVALID", "schemaVersion");
  const stamp = validateStamp(payload.sourceStamp);
  const handoff = validateS6Handoff(payload.s6Handoff);
  validateConstruction(payload.construction);
  if (stamp.projectId !== handoff.projectId || stamp.s6RevisionId !== handoff.acceptedRevisionId || stamp.s6RevisionHash !== handoff.acceptedRevisionHash || stamp.sourceS5Fingerprint !== handoff.sourceS5Fingerprint || stamp.s6ValidationReceiptId !== handoff.validationReceipt.receiptId || stamp.s6ValidationReceiptHash !== handoff.validationReceipt.validationHash || stamp.s6HandoffDigest !== sha256(Buffer.from(jcs(handoff), "utf8"))) {
    fail("S7_CROSS_OUTPUT_MISMATCH", "sourceStamp");
  }
  return payload as S8MaxPayloadV1;
}

export type S8CanonicalPayload = {
  payload: S8MaxPayloadV1;
  canonicalJson: string;
  bytes: Buffer;
  sha256: Sha256;
  byteSize: number;
};

export function canonicalS8Json(value: S8MaxPayloadV1): string {
  validateS8Payload(value);
  try {
    return canonicalS6Json(value);
  } catch (error) {
    if (error instanceof S8PayloadError) throw error;
    const message = error instanceof Error ? error.message : "S8_PAYLOAD_INVALID";
    if (message.includes("PROFILE")) fail("S8_PROFILE_TRIANGULATION_FAILED", "s6Handoff.objects");
    fail("S8_PAYLOAD_INVALID", "payload");
  }
}

export function buildS8Payload(sourceStamp: S8SourceStampV1, s6Handoff: S6ToS7Handoff): S8CanonicalPayload {
  validateStamp(sourceStamp);
  validateS6Handoff(s6Handoff);
  const payload: S8MaxPayloadV1 = {
    schemaVersion: S8_PAYLOAD_SCHEMA_VERSION,
    sourceStamp: cloneJson(sourceStamp),
    s6Handoff: cloneJson(s6Handoff),
    construction: cloneJson(S8_CONSTRUCTION),
  };
  const canonicalJson = canonicalS8Json(payload);
  const bytes = Buffer.from(canonicalJson, "utf8");
  if (bytes.length > S8_MAX_PAYLOAD_BYTES) fail("S8_RESOURCE_LIMIT", "payload");
  return { payload, canonicalJson, bytes, sha256: sha256(bytes), byteSize: bytes.length };
}

export const createS8Payload = buildS8Payload;

export function assertS8PrivateKey(value: string): string {
  try {
    return privateStorageKey(...value.split("/"));
  } catch {
    fail("S8_PAYLOAD_INVALID", "privateStorageKey");
  }
}

export function sourceStampFromParts(parts: {
  projectId: UUID;
  s6RevisionId: UUID;
  s6RevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  sourceS5ApprovalEventId: UUID;
  sourceS5Generation: number;
  s6ValidationReceiptId: UUID;
  s6ValidationReceiptHash: Sha256;
  s6Handoff: S6ToS7Handoff;
  s7ArtifactId: UUID;
  s7ArtifactHash: Sha256;
  s7ArtifactSize: number;
  s7ManifestId: UUID;
  s7ManifestHash: Sha256;
  s7ReadbackReceiptId: UUID;
  s7ReadbackReceiptHash: Sha256;
}): S8SourceStampV1 {
  const stamp: S8SourceStampV1 = {
    schemaVersion: S8_SOURCE_STAMP_SCHEMA_VERSION,
    projectId: parts.projectId,
    s6RevisionId: parts.s6RevisionId,
    s6RevisionHash: parts.s6RevisionHash,
    sourceS5Fingerprint: parts.sourceS5Fingerprint,
    sourceS5ApprovalEventId: parts.sourceS5ApprovalEventId,
    sourceS5Generation: parts.sourceS5Generation,
    s6ValidationReceiptId: parts.s6ValidationReceiptId,
    s6ValidationReceiptHash: parts.s6ValidationReceiptHash,
    s6HandoffSchemaVersion: "s6-to-s7-handoff-v1",
    s6HandoffDigest: sha256(Buffer.from(jcs(parts.s6Handoff), "utf8")),
    s7ArtifactId: parts.s7ArtifactId,
    s7ArtifactHash: parts.s7ArtifactHash,
    s7ArtifactSize: parts.s7ArtifactSize,
    s7ManifestId: parts.s7ManifestId,
    s7ManifestHash: parts.s7ManifestHash,
    s7ReadbackReceiptId: parts.s7ReadbackReceiptId,
    s7ReadbackReceiptHash: parts.s7ReadbackReceiptHash,
  };
  validateStamp(stamp);
  return stamp;
}

export function sourceStampsEqual(left: S8SourceStampV1, right: S8SourceStampV1): boolean {
  return sourceStampDigest(left) === sourceStampDigest(right);
}

export function assertS8PayloadResourceCounts(payload: S8MaxPayloadV1, counts: { vertices: number; faces: number }): void {
  validateS8Payload(payload);
  if (counts.vertices > S8_MAX_TOTAL_VERTICES || counts.faces > S8_MAX_TOTAL_FACES) fail("S8_RESOURCE_LIMIT", "scene");
}

export function profileOf(geometry: S6GeometryPrimitive): S6Profile | null {
  return geometry.kind === "profile_extrusion" ? geometry.profile : null;
}
