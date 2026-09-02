import { codePointLength, uuidV4Pattern } from "./utils";
import {
  hashS6Model,
  normalizeS6Geometry,
  S6_MAX_ASSUMPTIONS,
  S6_MAX_CAMERAS,
  S6_MAX_COORDINATE_MM,
  S6_MAX_JOB_ATTEMPTS,
  S6_MAX_LABEL_CODE_POINTS,
  S6_MAX_MATERIALS,
  S6_MAX_MODEL_BYTES,
  S6_MAX_OBJECTS,
  S6_MAX_OPERATIONS,
  S6_MAX_PHYSICAL_MM,
  S6_MAX_PROVENANCE_ENTRIES,
  S6_MAX_UNKNOWNS,
  S6_MAX_ZONES,
  S6_MIN_PHYSICAL_MM,
} from "./s6-canonical";
import type { StoreState } from "./types";

type PersistedRecord = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPEN_SIDES = ["north", "east", "south", "west"] as const;
const REVISION_STATUSES = ["generated_draft", "corrected_draft", "accepted_current", "superseded", "stale", "rejected", "aborted"] as const;
const PRIMITIVES = ["floor_footprint", "wall", "partition", "box", "counter", "display_plinth", "screen", "storage_volume", "table", "seating_marker", "equipment_placeholder", "overhead_volume", "zone_region"] as const;
const ROLES = ["booth_floor", "booth_wall", "booth_partition", "furniture", "display", "screen", "storage", "seating", "equipment", "overhead", "zone"] as const;
const ZONE_CATEGORIES = ["reception_welcome", "presentation_display", "demo_product", "consultation_meeting", "storage", "interactive_activity", "photo_branding", "giveaway_brochure", "other_confirmed"] as const;
const VIEW_IDS = ["perspective-northwest", "perspective-southeast", "top-orthographic"] as const;
const MATERIAL_KINDS = ["solid_color", "wood_like", "metal_like", "fabric_like", "glass_like", "brand_reference", "unknown"] as const;
const PROVENANCE_KINDS = ["confirmed_project_input", "user_confirmed_design_decision", "bounded_design_inference", "unknown_unresolved"] as const;
const SOURCE_KINDS = ["confirmed_project_input", "user_confirmed_design_decision", "s5_visual_intent", "bounded_design_inference", "unknown"] as const;
const JOB_KINDS = ["generation", "validation", "render", "publication"] as const;
const JOB_STATUSES = ["queued", "running", "staged", "promoted", "committed", "failed_retryable", "failed_terminal", "aborted"] as const;
const PUBLICATION_PHASES = ["none", "staged", "promoted", "committed", "aborted"] as const;

function invalid(detail = "invalid S6 persisted state"): never {
  throw new Error(detail);
}

function record(value: unknown, keys: readonly string[]): PersistedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as PersistedRecord;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}

function stringValue(value: unknown, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}

function codeString(value: unknown, max = 4096, allowEmpty = false): string {
  const result = stringValue(value, max, allowEmpty);
  if (codePointLength(result) > max) return invalid();
  return result;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) return invalid();
  return value;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) return invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return invalid();
  return value;
}

function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) return invalid();
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function enumValue(value: unknown, allowed: readonly string[]): string {
  const result = stringValue(value);
  if (!allowed.includes(result)) return invalid();
  return result;
}

function literal(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.some((candidate) => Object.is(candidate, value))) return invalid();
}

function nullableUuid(value: unknown): void {
  if (value !== null) uuid(value);
}

function nullableSha(value: unknown): void {
  if (value !== null) sha(value);
}

function nullableTimestamp(value: unknown): void {
  if (value !== null) timestamp(value);
}

function uniqueStrings(value: unknown, max: number): string[] {
  const values = array(value);
  if (values.length > max) return invalid();
  const result = values.map((item) => codeString(item, 240));
  if (new Set(result).size !== result.length) return invalid("S6_DUPLICATE_ID");
  return result;
}

function privatePath(value: unknown): string {
  const result = stringValue(value, 2048);
  const parts = result.split("/");
  if (result.startsWith("/") || result.includes("\\") || parts.some((part) => !part || part === "." || part === "..")) return invalid();
  return result;
}

function validateProvenance(value: unknown): void {
  const item = record(value, ["kind", "sourceRef", "sourceFingerprint", "acceptedByUser", "note"]);
  enumValue(item.kind, PROVENANCE_KINDS);
  codeString(item.sourceRef, 512);
  nullableSha(item.sourceFingerprint);
  booleanValue(item.acceptedByUser);
  if (item.note !== null) codeString(item.note, 400);
}

function validateCoordinateConvention(value: unknown): void {
  const item = record(value, ["version", "units", "handedness", "origin", "xAxis", "yAxis", "zAxis"]);
  literal(item.version, ["booth-local-right-handed-v1"]);
  literal(item.units, ["millimetres"]);
  literal(item.handedness, ["right-handed"]);
  literal(item.origin, ["north-west-floor-corner"]);
  literal(item.xAxis, ["east"]);
  literal(item.yAxis, ["up"]);
  literal(item.zAxis, ["south"]);
}

function validateVector(value: unknown): void {
  const item = record(value, ["xMm", "yMm", "zMm"]);
  integer(item.xMm, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM);
  integer(item.yMm, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM);
  integer(item.zMm, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM);
}

function validateRotation(value: unknown): void {
  const item = record(value, ["xMd", "yMd", "zMd"]);
  for (const key of ["xMd", "yMd", "zMd"] as const) integer(item[key], -180_000, 179_999);
}

function validateTransform(value: unknown): void {
  const item = record(value, ["positionMm", "rotationMd"]);
  validateVector(item.positionMm);
  validateRotation(item.rotationMd);
}

function validateDimensions(value: unknown): void {
  const item = record(value, ["widthMm", "depthMm", "heightMm"]);
  integer(item.widthMm, S6_MIN_PHYSICAL_MM, S6_MAX_PHYSICAL_MM);
  integer(item.depthMm, S6_MIN_PHYSICAL_MM, S6_MAX_PHYSICAL_MM);
  integer(item.heightMm, 1, S6_MAX_PHYSICAL_MM);
}

function validateGeometry(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("S6_GEOMETRY_INVALID");
  const kind = (value as PersistedRecord).kind;
  try {
    normalizeS6Geometry(value as never);
  } catch {
    return invalid(kind === "round_prism" ? "S6_ROUND_GEOMETRY_INVALID" : kind === "profile_extrusion" ? "S6_PROFILE_INVALID" : "S6_GEOMETRY_INVALID");
  }
}

function validateMaterial(value: unknown): void {
  const item = record(value, ["materialId", "label", "finishKind", "colorHex", "source", "sourceAssetId", "sourceAssetSha256", "notes", "provenance"]);
  codeString(item.materialId, 160);
  codeString(item.label, S6_MAX_LABEL_CODE_POINTS);
  enumValue(item.finishKind, MATERIAL_KINDS);
  if (item.colorHex !== null && !/^#[0-9a-f]{6}$/u.test(stringValue(item.colorHex, 7))) return invalid();
  enumValue(item.source, SOURCE_KINDS);
  nullableUuid(item.sourceAssetId);
  nullableSha(item.sourceAssetSha256);
  if ((item.sourceAssetId === null) !== (item.sourceAssetSha256 === null)) return invalid();
  if (item.notes !== null) codeString(item.notes, 400);
  validateProvenance(item.provenance);
}

function validateObject(value: unknown): void {
  const item = record(value, ["objectId", "identityKey", "parentObjectId", "objectType", "role", "label", "primitive", "transform", "zoneIds", "requirementIds", "materialIds", "unknownIds", "provenance", "hardConstraint", "editable", "removable"]);
  codeString(item.objectId, 200);
  codeString(item.identityKey, 240);
  if (item.parentObjectId !== null) codeString(item.parentObjectId, 200);
  enumValue(item.objectType, PRIMITIVES);
  enumValue(item.role, ROLES);
  codeString(item.label, S6_MAX_LABEL_CODE_POINTS);
  validateGeometry(item.primitive);
  validateTransform(item.transform);
  uniqueStrings(item.zoneIds, S6_MAX_ZONES);
  uniqueStrings(item.requirementIds, 128);
  uniqueStrings(item.materialIds, S6_MAX_MATERIALS);
  uniqueStrings(item.unknownIds, S6_MAX_UNKNOWNS);
  validateProvenance(item.provenance);
  enumValue(item.hardConstraint, ["booth_envelope", "requirement", "design_inference", "user_editable"]);
  booleanValue(item.editable);
  booleanValue(item.removable);
}

function validateZone(value: unknown): void {
  const item = record(value, ["zoneId", "label", "category", "regionObjectId", "requirementIds", "unknownIds", "provenance"]);
  codeString(item.zoneId, 200);
  codeString(item.label, S6_MAX_LABEL_CODE_POINTS);
  enumValue(item.category, ZONE_CATEGORIES);
  codeString(item.regionObjectId, 200);
  uniqueStrings(item.requirementIds, 128);
  uniqueStrings(item.unknownIds, S6_MAX_UNKNOWNS);
  validateProvenance(item.provenance);
}

function validateUnknown(value: unknown): void {
  const item = record(value, ["unknownId", "kind", "fieldPath", "requirementId", "question", "blocking", "status", "resolutionKind", "resolutionNote", "resolvedBy", "resolvedAt", "provenance"]);
  codeString(item.unknownId, 200);
  enumValue(item.kind, ["geometry", "material", "requirement_mapping", "design_form", "camera"]);
  codeString(item.fieldPath, 512);
  if (item.requirementId !== null) codeString(item.requirementId, 240);
  codeString(item.question, 480);
  booleanValue(item.blocking);
  const status = enumValue(item.status, ["unresolved", "resolved"]);
  if (item.resolutionKind !== null) enumValue(item.resolutionKind, ["represented", "explicit_simplification"]);
  if (item.resolutionNote !== null) codeString(item.resolutionNote, 400);
  if (item.resolvedBy !== null) enumValue(item.resolvedBy, ["user", "system"]);
  nullableTimestamp(item.resolvedAt);
  if (status === "unresolved" && (item.resolutionKind !== null || item.resolutionNote !== null || item.resolvedBy !== null || item.resolvedAt !== null)) return invalid();
  if (status === "resolved" && (item.resolutionKind === null || item.resolvedBy === null || item.resolvedAt === null)) return invalid();
  validateProvenance(item.provenance);
}

function validateAssumption(value: unknown): void {
  const item = record(value, ["assumptionId", "fieldPath", "value", "provenance", "acceptedByUser", "requiresConfirmation", "createdAt"]);
  codeString(item.assumptionId, 200);
  codeString(item.fieldPath, 512);
  codeString(item.value, 400);
  validateProvenance(item.provenance);
  booleanValue(item.acceptedByUser);
  booleanValue(item.requiresConfirmation);
  timestamp(item.createdAt);
}

function validateBooth(value: unknown): void {
  const item = record(value, ["widthMm", "depthMm", "openSides", "maxHeightMm", "coordinateConvention", "heightState"]);
  integer(item.widthMm, S6_MIN_PHYSICAL_MM, S6_MAX_PHYSICAL_MM);
  integer(item.depthMm, S6_MIN_PHYSICAL_MM, S6_MAX_PHYSICAL_MM);
  const openSides = array(item.openSides);
  if (openSides.length < 1 || openSides.length > 4 || new Set(openSides).size !== openSides.length) return invalid();
  openSides.forEach((side) => enumValue(side, OPEN_SIDES));
  if (item.maxHeightMm !== null) integer(item.maxHeightMm, 1, S6_MAX_PHYSICAL_MM);
  const heightState = enumValue(item.heightState, ["known", "unknown"]);
  if ((heightState === "known") !== (item.maxHeightMm !== null)) return invalid();
  validateCoordinateConvention(item.coordinateConvention);
}

function validateCamera(value: unknown): void {
  const item = record(value, ["viewId", "projection", "positionMm", "targetMm", "up", "fovMd", "orthoScaleMm", "paddingMm", "nearMm", "farMm", "heightBasis", "derivedRenderHeightMm", "cameraHash"]);
  enumValue(item.viewId, VIEW_IDS);
  const projection = enumValue(item.projection, ["perspective", "orthographic"]);
  validateVector(item.positionMm);
  validateVector(item.targetMm);
  enumValue(item.up, ["world-y", "negative-world-z"]);
  if (item.fovMd !== null) integer(item.fovMd, 1, 179_999);
  if (item.orthoScaleMm !== null) integer(item.orthoScaleMm, 1, S6_MAX_PHYSICAL_MM * 4);
  if ((projection === "perspective") !== (item.fovMd !== null && item.orthoScaleMm === null)) return invalid();
  if ((projection === "orthographic") !== (item.fovMd === null && item.orthoScaleMm !== null)) return invalid();
  integer(item.paddingMm, 0, S6_MAX_PHYSICAL_MM);
  const near = integer(item.nearMm, 1, S6_MAX_PHYSICAL_MM * 4);
  integer(item.farMm, near + 1, S6_MAX_PHYSICAL_MM * 100);
  enumValue(item.heightBasis, ["confirmed_max_height", "derived_render_height"]);
  integer(item.derivedRenderHeightMm, 1, S6_MAX_PHYSICAL_MM);
  sha(item.cameraHash);
}

function validateArtifactPointer(value: unknown): void {
  const item = record(value, ["artifactKey", "stagingKey", "sha256", "byteSize", "status"]);
  privatePath(item.artifactKey);
  privatePath(item.stagingKey);
  nullableSha(item.sha256);
  if (item.byteSize !== null) integer(item.byteSize, 0, S6_MAX_MODEL_BYTES);
  enumValue(item.status, ["not_written", "staged", "promoted", "committed", "failed_terminal"]);
  if (item.status === "not_written" && (item.sha256 !== null || item.byteSize !== null)) return invalid();
  if (item.status === "committed" && (item.sha256 === null || item.byteSize === null)) return invalid();
}

function validateDesignFormReview(value: unknown): void {
  const item = record(value, ["status", "evidenceAssetId", "evidenceAssetSha256", "sourceS5Fingerprint", "reviewedObjectIds", "unresolvedUnknownIds", "explicitSimplificationUnknownIds", "acceptedByUser"]);
  enumValue(item.status, ["required", "in_progress", "complete", "unsupported"]);
  uuid(item.evidenceAssetId);
  sha(item.evidenceAssetSha256);
  sha(item.sourceS5Fingerprint);
  uniqueStrings(item.reviewedObjectIds, S6_MAX_OBJECTS);
  const unresolved = uniqueStrings(item.unresolvedUnknownIds, S6_MAX_UNKNOWNS);
  const simplified = uniqueStrings(item.explicitSimplificationUnknownIds, S6_MAX_UNKNOWNS);
  booleanValue(item.acceptedByUser);
  if (item.status === "complete" && !item.acceptedByUser) return invalid("S6_DESIGN_FORM_REVIEW_INCOMPLETE");
  if (item.status !== "complete" && item.acceptedByUser) return invalid("S6_DESIGN_FORM_REVIEW_INCOMPLETE");
  if (new Set([...unresolved, ...simplified]).size !== unresolved.length + simplified.length) return invalid();
}

const MODEL_KEYS = ["schemaVersion", "modelRevisionId", "projectId", "parentRevisionId", "parentRevisionHash", "revisionNumber", "sourceS5Fingerprint", "sourceS5ApprovalEventId", "sourceS5ApprovalGeneration", "status", "booth", "objects", "zones", "materials", "cameras", "provenance", "assumptions", "unknowns", "designFormReview", "modelHash", "canonicalByteSize", "modelArtifact", "validationReceiptId", "acceptanceEventId", "createdBy", "createdAt", "updatedAt", "acceptedAt", "supersededAt", "staleAt"] as const;

function validateModel(value: unknown): void {
  const item = record(value, MODEL_KEYS);
  literal(item.schemaVersion, ["s6-spatial-model-v1"]);
  uuid(item.modelRevisionId);
  uuid(item.projectId);
  nullableUuid(item.parentRevisionId);
  nullableSha(item.parentRevisionHash);
  const revisionNumber = integer(item.revisionNumber, 1, 512);
  if (revisionNumber === 1 && (item.parentRevisionId !== null || item.parentRevisionHash !== null)) return invalid();
  if ((item.parentRevisionId === null) !== (item.parentRevisionHash === null)) return invalid();
  sha(item.sourceS5Fingerprint);
  uuid(item.sourceS5ApprovalEventId);
  integer(item.sourceS5ApprovalGeneration, 1);
  enumValue(item.status, REVISION_STATUSES);
  validateBooth(item.booth);
  const objects = array(item.objects);
  if (objects.length > S6_MAX_OBJECTS) return invalid();
  objects.forEach(validateObject);
  const zones = array(item.zones);
  if (zones.length > S6_MAX_ZONES) return invalid();
  zones.forEach(validateZone);
  const materials = array(item.materials);
  if (materials.length > S6_MAX_MATERIALS) return invalid();
  materials.forEach(validateMaterial);
  const cameras = array(item.cameras);
  if (cameras.length > S6_MAX_CAMERAS) return invalid();
  cameras.forEach(validateCamera);
  const provenance = array(item.provenance);
  if (provenance.length > S6_MAX_PROVENANCE_ENTRIES) return invalid();
  provenance.forEach(validateProvenance);
  const assumptions = array(item.assumptions);
  if (assumptions.length > S6_MAX_ASSUMPTIONS) return invalid();
  assumptions.forEach(validateAssumption);
  const unknowns = array(item.unknowns);
  if (unknowns.length > S6_MAX_UNKNOWNS) return invalid();
  unknowns.forEach(validateUnknown);
  validateDesignFormReview(item.designFormReview);
  sha(item.modelHash);
  const byteSize = integer(item.canonicalByteSize, 1, S6_MAX_MODEL_BYTES);
  validateArtifactPointer(item.modelArtifact);
  nullableUuid(item.validationReceiptId);
  nullableUuid(item.acceptanceEventId);
  enumValue(item.createdBy, ["compiler", "user_correction"]);
  timestamp(item.createdAt);
  timestamp(item.updatedAt);
  nullableTimestamp(item.acceptedAt);
  nullableTimestamp(item.supersededAt);
  nullableTimestamp(item.staleAt);
  if (item.status === "accepted_current" && (item.acceptanceEventId === null || item.acceptedAt === null)) return invalid("S6_ACCEPTANCE_LINK_INVALID");
  if (item.status === "generated_draft" || item.status === "corrected_draft") {
    if (item.acceptanceEventId !== null || item.acceptedAt !== null || item.supersededAt !== null || item.staleAt !== null) return invalid();
  }
  if (item.status === "superseded" && item.supersededAt === null) return invalid();
  if (item.status === "stale" && item.staleAt === null) return invalid();
  try {
    const digest = hashS6Model(item as never);
    if (digest.modelHash !== item.modelHash || digest.canonicalByteSize !== byteSize) return invalid("S6_MODEL_HASH_MISMATCH");
  } catch {
    return invalid("S6_MODEL_HASH_MISMATCH");
  }
}

function validateIssue(value: unknown): void {
  const item = record(value, ["code", "severity", "fieldPath", "objectId", "requirementId", "detail"]);
  codeString(item.code, 160);
  enumValue(item.severity, ["error", "warning"]);
  codeString(item.fieldPath, 512);
  if (item.objectId !== null) codeString(item.objectId, 200);
  if (item.requirementId !== null) codeString(item.requirementId, 240);
  codeString(item.detail, 400);
}

function validateReceipt(value: unknown): void {
  const item = record(value, ["schemaVersion", "receiptId", "projectId", "revisionId", "revisionHash", "sourceS5Fingerprint", "validatorVersion", "orderVersion", "outcome", "errors", "warnings", "checkedAt", "validationHash"]);
  literal(item.schemaVersion, ["s6-validation-receipt-v1"]);
  uuid(item.receiptId); uuid(item.projectId); uuid(item.revisionId); sha(item.revisionHash); sha(item.sourceS5Fingerprint);
  literal(item.validatorVersion, ["s6-validator-v1"]); literal(item.orderVersion, ["s6-validation-order-v1"]);
  enumValue(item.outcome, ["pass", "pass_with_warnings", "acceptance_blocked", "render_blocked", "failed"]);
  const errors = array(item.errors); const warnings = array(item.warnings);
  if (errors.length > 256 || warnings.length > 256) return invalid();
  errors.forEach(validateIssue); warnings.forEach(validateIssue); timestamp(item.checkedAt); sha(item.validationHash);
}

function validateCorrectionGeometry(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const kind = (value as PersistedRecord).kind;
  if (kind === "rect_prism") {
    const item = record(value, ["kind", "dimensionsMm", "localAnchor"]);
    validateDimensions(item.dimensionsMm); enumValue(item.localAnchor, ["floor", "center"]); return;
  }
  if (kind === "round_prism") {
    const item = record(value, ["kind", "radiusMm", "heightMm", "localAnchor"]);
    integer(item.radiusMm, S6_MIN_PHYSICAL_MM, 50_000); integer(item.heightMm, 1, S6_MAX_PHYSICAL_MM); enumValue(item.localAnchor, ["floor", "center"]); return;
  }
  if (kind === "profile_extrusion") {
    const item = record(value, ["kind", "profile", "heightMm", "localAnchor"]);
    integer(item.heightMm, 1, S6_MAX_PHYSICAL_MM); enumValue(item.localAnchor, ["floor", "center"]);
    try { normalizeS6Geometry({ kind, profile: item.profile, heightMm: item.heightMm, geometryState: "exact", localAnchor: item.localAnchor } as never); } catch { return invalid("S6_PROFILE_INVALID"); }
    return;
  }
  return invalid();
}

function validateCorrectionOperation(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const kind = (value as PersistedRecord).kind;
  if (kind === "move") {
    const item = record(value, ["kind", "objectId", "deltaMm"]); codeString(item.objectId, 200); validateVector(item.deltaMm); return;
  }
  if (kind === "rotate") {
    const item = record(value, ["kind", "objectId", "rotationMd"]); codeString(item.objectId, 200); validateRotation(item.rotationMd); return;
  }
  if (kind === "resize") {
    const item = record(value, ["kind", "objectId", "dimensionsMm"]); codeString(item.objectId, 200); validateDimensions(item.dimensionsMm); return;
  }
  if (kind === "replace_geometry") {
    const item = record(value, ["kind", "objectId", "geometry"]); codeString(item.objectId, 200); validateCorrectionGeometry(item.geometry); return;
  }
  if (kind === "material") {
    const item = record(value, ["kind", "objectId", "material"]); codeString(item.objectId, 200); validateMaterial(item.material); return;
  }
  if (kind === "zone_requirement_map") {
    const item = record(value, ["kind", "objectId", "zoneIds", "requirementIds"]); codeString(item.objectId, 200); uniqueStrings(item.zoneIds, S6_MAX_ZONES); uniqueStrings(item.requirementIds, 128); return;
  }
  if (kind === "confirm_design_inference") {
    const item = record(value, ["kind", "objectIds", "note"]); uniqueStrings(item.objectIds, S6_MAX_OBJECTS); codeString(item.note, 400); return;
  }
  if (kind === "resolve_unknown") {
    const item = record(value, ["kind", "unknownId", "resolutionKind", "resolutionNote", "replacement"]);
    codeString(item.unknownId, 200); enumValue(item.resolutionKind, ["represented", "explicit_simplification"]); codeString(item.resolutionNote, 400);
    if (item.replacement !== null) {
      const replacement = record(item.replacement, ["objectType", "role", "label", "geometry", "positionMm", "rotationMd", "material"]);
      enumValue(replacement.objectType, PRIMITIVES); enumValue(replacement.role, ROLES); codeString(replacement.label, S6_MAX_LABEL_CODE_POINTS); validateCorrectionGeometry(replacement.geometry); validateVector(replacement.positionMm); validateRotation(replacement.rotationMd); validateMaterial(replacement.material);
    }
    return;
  }
  if (kind === "add") {
    const item = record(value, ["kind", "objectType", "role", "label", "geometry", "positionMm", "rotationMd", "material", "parentObjectId", "zoneIds", "requirementIds"]);
    enumValue(item.objectType, ["counter", "display_plinth", "screen", "storage_volume", "table", "seating_marker", "equipment_placeholder", "box", "overhead_volume", "partition"]);
    enumValue(item.role, ["furniture", "display", "screen", "storage", "seating", "equipment", "overhead", "booth_partition"]); codeString(item.label, S6_MAX_LABEL_CODE_POINTS); validateCorrectionGeometry(item.geometry); validateVector(item.positionMm); validateRotation(item.rotationMd); validateMaterial(item.material);
    if (item.parentObjectId !== null) codeString(item.parentObjectId, 200); uniqueStrings(item.zoneIds, S6_MAX_ZONES); uniqueStrings(item.requirementIds, 128); return;
  }
  if (kind === "remove") {
    const item = record(value, ["kind", "objectId"]); codeString(item.objectId, 200); return;
  }
  return invalid();
}

function validateCorrectionEvent(value: unknown): void {
  const item = record(value, ["schemaVersion", "correctionEventId", "projectId", "parentRevisionId", "parentRevisionHash", "childRevisionId", "childRevisionHash", "sourceS5Fingerprint", "actorSubjectId", "operations", "requestHash", "idempotencyKey", "requestReferenceId", "occurredAt"]);
  literal(item.schemaVersion, ["s6-correction-event-v1"]); uuid(item.correctionEventId); uuid(item.projectId); uuid(item.parentRevisionId); sha(item.parentRevisionHash); uuid(item.childRevisionId); sha(item.childRevisionHash); sha(item.sourceS5Fingerprint); codeString(item.actorSubjectId, 240);
  const operations = array(item.operations); if (operations.length > S6_MAX_OPERATIONS) return invalid(); operations.forEach(validateCorrectionOperation); sha(item.requestHash); uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.occurredAt);
}

function validateAcceptanceEvent(value: unknown): void {
  const item = record(value, ["schemaVersion", "acceptanceEventId", "projectId", "revisionId", "revisionHash", "sourceS5Fingerprint", "priorAcceptedRevisionId", "priorAcceptedRevisionHash", "actorSubjectId", "expectedCurrentAcceptedRevisionId", "expectedCurrentAcceptedHash", "idempotencyKey", "requestReferenceId", "occurredAt"]);
  literal(item.schemaVersion, ["s6-acceptance-event-v1"]); uuid(item.acceptanceEventId); uuid(item.projectId); uuid(item.revisionId); sha(item.revisionHash); sha(item.sourceS5Fingerprint); nullableUuid(item.priorAcceptedRevisionId); nullableSha(item.priorAcceptedRevisionHash);
  if ((item.priorAcceptedRevisionId === null) !== (item.priorAcceptedRevisionHash === null)) return invalid(); codeString(item.actorSubjectId, 240); nullableUuid(item.expectedCurrentAcceptedRevisionId); nullableSha(item.expectedCurrentAcceptedHash); if ((item.expectedCurrentAcceptedRevisionId === null) !== (item.expectedCurrentAcceptedHash === null)) return invalid(); uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.occurredAt);
}

function validateSupersessionEvent(value: unknown): void {
  const item = record(value, ["schemaVersion", "supersessionEventId", "projectId", "supersededRevisionId", "supersededRevisionHash", "replacementRevisionId", "replacementRevisionHash", "sourceS5Fingerprint", "acceptanceEventId", "actorSubjectId", "requestReferenceId", "occurredAt"]);
  literal(item.schemaVersion, ["s6-supersession-event-v1"]); uuid(item.supersessionEventId); uuid(item.projectId); uuid(item.supersededRevisionId); sha(item.supersededRevisionHash); uuid(item.replacementRevisionId); sha(item.replacementRevisionHash); sha(item.sourceS5Fingerprint); uuid(item.acceptanceEventId); codeString(item.actorSubjectId, 240); uuid(item.requestReferenceId); timestamp(item.occurredAt);
  if (item.supersededRevisionId === item.replacementRevisionId) return invalid();
}

function validateViewArtifact(value: unknown): void {
  const item = record(value, ["schemaVersion", "artifactId", "artifactGroupId", "projectId", "revisionId", "revisionHash", "sourceS5Fingerprint", "viewId", "purpose", "rendererVersion", "format", "mimeType", "fileExtension", "fileName", "artifactKey", "stagingKey", "outputSha256", "outputByteSize", "cameraHash", "sceneHash", "preservationReceiptId", "attempt", "retryOfArtifactId", "status", "publicationPhase", "workerId", "processId", "claimToken", "claimedAt", "startedAt", "stagedAt", "promotedAt", "completedAt", "terminalAt", "failureCode", "idempotencyKey", "requestReferenceId", "createdAt", "updatedAt"]);
  literal(item.schemaVersion, ["s6-view-artifact-v1"]); uuid(item.artifactId); uuid(item.artifactGroupId); uuid(item.projectId); uuid(item.revisionId); sha(item.revisionHash); sha(item.sourceS5Fingerprint); enumValue(item.viewId, VIEW_IDS); enumValue(item.purpose, ["draft_preview", "accepted_view"]); literal(item.rendererVersion, ["s6-svg-geometry-v2"]); literal(item.format, ["svg"]); literal(item.mimeType, ["image/svg+xml"]); literal(item.fileExtension, [".svg"]);
  const fileName = stringValue(item.fileName, 120);
  if (!/^swooshz-spatial-(perspective-northwest|perspective-southeast|top-orthographic)\.svg$/u.test(fileName)) return invalid();
  privatePath(item.artifactKey); privatePath(item.stagingKey); nullableSha(item.outputSha256);
  if (item.outputByteSize !== null) integer(item.outputByteSize, 0, 2_000_000);
  sha(item.cameraHash); nullableSha(item.sceneHash); nullableUuid(item.preservationReceiptId);
  literal(item.attempt, [1, 2]); nullableUuid(item.retryOfArtifactId); enumValue(item.status, JOB_STATUSES); enumValue(item.publicationPhase, PUBLICATION_PHASES);
  if (item.workerId !== null) codeString(item.workerId, 240);
  if (item.processId !== null) integer(item.processId, 1);
  nullableUuid(item.claimToken); nullableTimestamp(item.claimedAt); nullableTimestamp(item.startedAt); nullableTimestamp(item.stagedAt); nullableTimestamp(item.promotedAt); nullableTimestamp(item.completedAt); nullableTimestamp(item.terminalAt);
  if (item.failureCode !== null) codeString(item.failureCode, 200);
  uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.createdAt); timestamp(item.updatedAt);
  if (item.status === "failed_terminal" && (item.terminalAt === null || item.failureCode === null)) return invalid();
  if (item.status === "failed_retryable" && item.attempt !== 1) return invalid();
  if (item.status === "committed" && (item.outputSha256 === null || item.outputByteSize === null || item.publicationPhase !== "committed")) return invalid();
}

function validatePreservationReceipt(value: unknown): void {
  const item = record(value, ["schemaVersion", "receiptId", "projectId", "revisionId", "revisionHash", "sourceS5Fingerprint", "viewId", "rendererVersion", "cameraHash", "sceneHash", "outcome", "hardInvariantHash", "objectIds", "overheadObjectIds", "materialIds", "checks", "checkedAt", "receiptHash"]);
  literal(item.schemaVersion, ["s6-view-preservation-v1"]); uuid(item.receiptId); uuid(item.projectId); uuid(item.revisionId); sha(item.revisionHash); sha(item.sourceS5Fingerprint); enumValue(item.viewId, VIEW_IDS); literal(item.rendererVersion, ["s6-svg-geometry-v2"]); sha(item.cameraHash); sha(item.sceneHash); enumValue(item.outcome, ["pass", "fail"]); sha(item.hardInvariantHash); uniqueStrings(item.objectIds, S6_MAX_OBJECTS); uniqueStrings(item.overheadObjectIds, S6_MAX_OBJECTS); uniqueStrings(item.materialIds, S6_MAX_MATERIALS);
  const checks = array(item.checks); if (checks.length > 256) return invalid(); checks.forEach(validateIssue); timestamp(item.checkedAt); sha(item.receiptHash);
}

function validateJob(value: unknown): void {
  const item = record(value, ["schemaVersion", "jobId", "projectId", "kind", "revisionId", "viewId", "sourceS5Fingerprint", "inputHash", "attempt", "retryOfJobId", "status", "publicationPhase", "artifactId", "workerId", "processId", "claimToken", "claimedAt", "startedAt", "stagedAt", "promotedAt", "completedAt", "terminalAt", "failureCode", "idempotencyKey", "requestReferenceId", "createdAt", "updatedAt"]);
  literal(item.schemaVersion, ["s6-job-state-v1"]); uuid(item.jobId); uuid(item.projectId); enumValue(item.kind, JOB_KINDS); nullableUuid(item.revisionId); if (item.viewId !== null) enumValue(item.viewId, VIEW_IDS); sha(item.sourceS5Fingerprint); sha(item.inputHash); literal(item.attempt, [1, 2]); nullableUuid(item.retryOfJobId); enumValue(item.status, JOB_STATUSES); enumValue(item.publicationPhase, PUBLICATION_PHASES); nullableUuid(item.artifactId);
  if (item.workerId !== null) codeString(item.workerId, 240); if (item.processId !== null) integer(item.processId, 1); nullableUuid(item.claimToken); nullableTimestamp(item.claimedAt); nullableTimestamp(item.startedAt); nullableTimestamp(item.stagedAt); nullableTimestamp(item.promotedAt); nullableTimestamp(item.completedAt); nullableTimestamp(item.terminalAt); if (item.failureCode !== null) codeString(item.failureCode, 200);
  uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.createdAt); timestamp(item.updatedAt);
  if (item.status === "failed_terminal" && (item.terminalAt === null || item.failureCode === null)) return invalid(); if (item.status === "failed_retryable" && item.attempt !== 1) return invalid();
}

function validateIdempotency(value: unknown): void {
  const item = record(value, ["schemaVersion", "key", "operation", "projectId", "inputHash", "sourceS5Fingerprint", "result", "createdAt"]);
  literal(item.schemaVersion, ["s6-idempotency-v1"]); uuid(item.key); enumValue(item.operation, ["generation", "correction", "reopen", "validation", "acceptance", "render", "publication"]); uuid(item.projectId); sha(item.inputHash); sha(item.sourceS5Fingerprint);
  if (typeof item.result !== "object" || item.result === null || Array.isArray(item.result)) return invalid();
  timestamp(item.createdAt);
}

const COLLECTION_VALIDATORS: Readonly<Record<string, (value: unknown) => void>> = {
  s6SpatialModels: validateModel,
  s6ValidationReceipts: validateReceipt,
  s6CorrectionEvents: validateCorrectionEvent,
  s6AcceptanceEvents: validateAcceptanceEvent,
  s6SupersessionEvents: validateSupersessionEvent,
  s6ViewArtifacts: validateViewArtifact,
  s6ViewPreservationReceipts: validatePreservationReceipt,
  s6Jobs: validateJob,
  s6Idempotency: validateIdempotency,
};

const COLLECTION_NAMES = Object.keys(COLLECTION_VALIDATORS);

export function validateS6Collections(parsedRecord: unknown, state: StoreState): void {
  if (typeof parsedRecord !== "object" || parsedRecord === null || Array.isArray(parsedRecord)) return invalid();
  const parsed = parsedRecord as PersistedRecord;
  for (const name of COLLECTION_NAMES) {
    const stateValue = (state as unknown as PersistedRecord)[name];
    if (!Array.isArray(stateValue)) return invalid();
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      const values = array(parsed[name]);
      values.forEach(COLLECTION_VALIDATORS[name]!);
    }
  }
}

function persistedRecords(value: unknown): PersistedRecord[] {
  return array(value).map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return invalid();
    return item as PersistedRecord;
  });
}

function uniqueRecordIds(values: PersistedRecord[], key: string): Map<string, PersistedRecord> {
  const result = new Map<string, PersistedRecord>();
  for (const item of values) {
    const value = item[key];
    if (typeof value !== "string" || result.has(value)) return invalid("S6_DUPLICATE_ID");
    result.set(value, item);
  }
  return result;
}

function sameNullablePair(left: PersistedRecord, idKey: string, hashKey: string): void {
  if ((left[idKey] === null) !== (left[hashKey] === null)) return invalid();
}

function modelObjectMap(model: PersistedRecord): Map<string, PersistedRecord> {
  return uniqueRecordIds(persistedRecords(model.objects), "objectId");
}

function validateModelReferences(models: PersistedRecord[], modelById: Map<string, PersistedRecord>): void {
  const byProject = new Map<string, PersistedRecord[]>();
  for (const model of models) {
    const projectId = String(model.projectId);
    const projectModels = byProject.get(projectId) ?? [];
    projectModels.push(model);
    byProject.set(projectId, projectModels);
  }
  for (const projectModels of byProject.values()) {
    projectModels.sort((left, right) => Number(left.revisionNumber) - Number(right.revisionNumber));
    const history = new Map<string, { identityKey: string; lastModelId: string }>();
    for (const model of projectModels) {
      const objects = modelObjectMap(model);
      const parent = model.parentRevisionId === null ? null : modelById.get(String(model.parentRevisionId));
      const parentObjects = parent === null || parent === undefined ? new Map<string, PersistedRecord>() : modelObjectMap(parent);
      for (const object of objects.values()) {
        const objectId = String(object.objectId);
        const identityKey = String(object.identityKey);
        const previous = history.get(objectId);
        if (previous !== undefined) {
          if (previous.identityKey !== identityKey) return invalid("OBJECT_ID_REUSED");
          if (previous.lastModelId !== parent?.modelRevisionId) return invalid("OBJECT_ID_REUSED");
        }
        history.set(objectId, { identityKey, lastModelId: String(model.modelRevisionId) });
        if (object.parentObjectId !== null && !objects.has(String(object.parentObjectId))) return invalid("S6_OBJECT_PARENT_INVALID");
        if (object.parentObjectId === object.objectId) return invalid("S6_OBJECT_PARENT_INVALID");
        for (const zoneId of object.zoneIds as string[]) {
          if (!persistedRecords(model.zones).some((zone) => zone.zoneId === zoneId)) return invalid("S6_OBJECT_REFERENCE_INVALID");
        }
        for (const materialId of object.materialIds as string[]) {
          if (!persistedRecords(model.materials).some((material) => material.materialId === materialId)) return invalid("S6_OBJECT_REFERENCE_INVALID");
        }
        for (const unknownId of object.unknownIds as string[]) {
          if (!persistedRecords(model.unknowns).some((unknown) => unknown.unknownId === unknownId)) return invalid("S6_OBJECT_REFERENCE_INVALID");
        }
        if (previous === undefined && parentObjects.has(objectId)) {
          const inherited = parentObjects.get(objectId)!;
          if (String(inherited.identityKey) !== identityKey) return invalid("OBJECT_ID_REUSED");
        }
      }
      const zones = uniqueRecordIds(persistedRecords(model.zones), "zoneId");
      for (const zone of zones.values()) {
        if (!objects.has(String(zone.regionObjectId))) return invalid("S6_ZONE_REFERENCE_INVALID");
        for (const objectId of zone.unknownIds as string[]) {
          if (!persistedRecords(model.unknowns).some((unknown) => unknown.unknownId === objectId)) return invalid("S6_ZONE_REFERENCE_INVALID");
        }
      }
      uniqueRecordIds(persistedRecords(model.materials), "materialId");
      uniqueRecordIds(persistedRecords(model.unknowns), "unknownId");
      uniqueRecordIds(persistedRecords(model.assumptions), "assumptionId");
      uniqueRecordIds(persistedRecords(model.cameras), "viewId");
      history.forEach((entry, id) => {
        if (!objects.has(id) && entry.lastModelId === model.modelRevisionId) history.delete(id);
      });
    }
  }
}

function validateModelLineage(models: PersistedRecord[]): Map<string, PersistedRecord> {
  const modelById = uniqueRecordIds(models, "modelRevisionId");
  const projectRevisionKeys = new Set<string>();
  for (const model of models) {
    const projectId = String(model.projectId);
    const revisionNumber = Number(model.revisionNumber);
    const revisionKey = projectId + ":" + revisionNumber;
    if (projectRevisionKeys.has(revisionKey)) return invalid("S6_DUPLICATE_REVISION");
    projectRevisionKeys.add(revisionKey);
    if (model.parentRevisionId === null) {
      // A source-epoch root has no parent even when earlier source epochs
      // already consumed lower project revision numbers.
    } else {
      const parent = modelById.get(String(model.parentRevisionId));
      if (parent === undefined || parent.projectId !== model.projectId || Number(parent.revisionNumber) !== revisionNumber - 1) return invalid("S6_LINEAGE_INVALID");
      if (parent.modelHash !== model.parentRevisionHash || parent.sourceS5Fingerprint !== model.sourceS5Fingerprint) return invalid("S6_LINEAGE_INVALID");
    }
  }
  validateModelReferences(models, modelById);
  return modelById;
}

function validateAcceptanceGraph(models: PersistedRecord[], modelById: Map<string, PersistedRecord>, events: PersistedRecord[], supersessions: PersistedRecord[]): void {
  const eventById = uniqueRecordIds(events, "acceptanceEventId");
  const acceptedByProject = new Map<string, PersistedRecord>();
  for (const model of models) {
    if (model.status !== "accepted_current") continue;
    const projectKey = String(model.projectId) + ":" + String(model.sourceS5Fingerprint);
    if (acceptedByProject.has(projectKey)) return invalid("S6_MULTIPLE_ACCEPTED_REVISIONS");
    acceptedByProject.set(projectKey, model);
    const eventId = String(model.acceptanceEventId);
    const event = eventById.get(eventId);
    if (event === undefined || event.projectId !== model.projectId || event.revisionId !== model.modelRevisionId || event.revisionHash !== model.modelHash || event.sourceS5Fingerprint !== model.sourceS5Fingerprint) return invalid("S6_ACCEPTANCE_LINK_INVALID");
  }
  for (const event of events) {
    const model = modelById.get(String(event.revisionId));
    if (model === undefined || model.projectId !== event.projectId || model.modelHash !== event.revisionHash || model.sourceS5Fingerprint !== event.sourceS5Fingerprint || (model.status !== "accepted_current" && model.status !== "superseded" && model.status !== "stale") || model.acceptanceEventId !== event.acceptanceEventId) return invalid("S6_ACCEPTANCE_LINK_INVALID");
    sameNullablePair(event, "priorAcceptedRevisionId", "priorAcceptedRevisionHash");
    sameNullablePair(event, "expectedCurrentAcceptedRevisionId", "expectedCurrentAcceptedHash");
    if (event.priorAcceptedRevisionId !== null) {
      const prior = modelById.get(String(event.priorAcceptedRevisionId));
      if (prior === undefined || prior.projectId !== event.projectId || prior.modelHash !== event.priorAcceptedRevisionHash || prior.sourceS5Fingerprint !== event.sourceS5Fingerprint) return invalid("S6_ACCEPTANCE_LINK_INVALID");
    }
  }
  const supersessionIds = new Set<string>();
  for (const event of supersessions) {
    const prior = modelById.get(String(event.supersededRevisionId));
    const replacement = modelById.get(String(event.replacementRevisionId));
    const acceptance = eventById.get(String(event.acceptanceEventId));
    if (supersessionIds.has(String(event.supersededRevisionId))) return invalid("S6_DUPLICATE_SUPERSESSION");
    supersessionIds.add(String(event.supersededRevisionId));
    if (prior === undefined || replacement === undefined || acceptance === undefined || prior.projectId !== event.projectId || replacement.projectId !== event.projectId || prior.modelHash !== event.supersededRevisionHash || replacement.modelHash !== event.replacementRevisionHash || prior.sourceS5Fingerprint !== event.sourceS5Fingerprint || replacement.sourceS5Fingerprint !== event.sourceS5Fingerprint || prior.status !== "superseded" || replacement.status !== "accepted_current" || acceptance.revisionId !== replacement.modelRevisionId || acceptance.acceptanceEventId !== event.acceptanceEventId) return invalid("S6_SUPERSESSION_INVALID");
  }
}

function validateRetryChains(values: PersistedRecord[], idKey: string, groupKey: (value: PersistedRecord) => string, retryKey: string): void {
  const groups = new Map<string, PersistedRecord[]>();
  for (const value of values) {
    const key = groupKey(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => Number(left.attempt) - Number(right.attempt));
    if (group.length > S6_MAX_JOB_ATTEMPTS || group[0]!.attempt !== 1) return invalid("S6_RETRY_CHAIN_INVALID");
    if (group.length === 1 && group[0]![retryKey] !== null) return invalid("S6_RETRY_CHAIN_INVALID");
    if (group.length === 2) {
      if (group[1]!.attempt !== 2 || group[0]![retryKey] !== null || group[1]![retryKey] !== group[0]![idKey]) return invalid("S6_RETRY_CHAIN_INVALID");
    }
  }
}

function validateArtifactGraph(models: PersistedRecord[], modelById: Map<string, PersistedRecord>, artifacts: PersistedRecord[], receipts: PersistedRecord[], jobs: PersistedRecord[]): void {
  const artifactById = uniqueRecordIds(artifacts, "artifactId");
  const receiptById = uniqueRecordIds(receipts, "receiptId");
  const jobById = uniqueRecordIds(jobs, "jobId");
  for (const artifact of artifacts) {
    const model = modelById.get(String(artifact.revisionId));
    if (model === undefined || model.projectId !== artifact.projectId || model.modelHash !== artifact.revisionHash || model.sourceS5Fingerprint !== artifact.sourceS5Fingerprint) return invalid("S6_ARTIFACT_REFERENCE_INVALID");
    if (artifact.preservationReceiptId !== null) {
      const receipt = receiptById.get(String(artifact.preservationReceiptId));
      if (receipt === undefined || receipt.projectId !== artifact.projectId || receipt.revisionId !== artifact.revisionId || receipt.revisionHash !== artifact.revisionHash || receipt.viewId !== artifact.viewId) return invalid("S6_ARTIFACT_REFERENCE_INVALID");
    }
    if (artifact.retryOfArtifactId !== null) {
      const prior = artifactById.get(String(artifact.retryOfArtifactId));
      if (prior === undefined || prior.artifactGroupId !== artifact.artifactGroupId || prior.revisionId !== artifact.revisionId || prior.viewId !== artifact.viewId || prior.attempt !== 1) return invalid("S6_RETRY_CHAIN_INVALID");
    }
  }
  validateRetryChains(artifacts, "artifactId", (item) => [String(item.artifactGroupId), String(item.revisionId), String(item.viewId)].join(":"), "retryOfArtifactId");
  for (const receipt of receipts) {
    const model = modelById.get(String(receipt.revisionId));
    if (model === undefined || model.projectId !== receipt.projectId || model.modelHash !== receipt.revisionHash || model.sourceS5Fingerprint !== receipt.sourceS5Fingerprint) return invalid("S6_RECEIPT_REFERENCE_INVALID");
  }
  for (const job of jobs) {
    if (job.revisionId !== null) {
      const model = modelById.get(String(job.revisionId));
      if (model === undefined || model.projectId !== job.projectId || model.sourceS5Fingerprint !== job.sourceS5Fingerprint) return invalid("S6_JOB_REFERENCE_INVALID");
    }
    if (job.artifactId !== null) {
      const artifact = artifactById.get(String(job.artifactId));
      if (artifact === undefined || artifact.projectId !== job.projectId || artifact.revisionId !== job.revisionId) return invalid("S6_JOB_REFERENCE_INVALID");
    }
    if (job.retryOfJobId !== null) {
      const prior = jobById.get(String(job.retryOfJobId));
      if (prior === undefined || prior.projectId !== job.projectId || prior.kind !== job.kind || prior.revisionId !== job.revisionId || prior.viewId !== job.viewId || prior.inputHash !== job.inputHash || prior.attempt !== 1) return invalid("S6_RETRY_CHAIN_INVALID");
    }
  }
  validateRetryChains(jobs, "jobId", (item) => [String(item.projectId), String(item.kind), String(item.revisionId), String(item.viewId), String(item.inputHash)].join(":"), "retryOfJobId");
}

function validateEventGraph(models: PersistedRecord[], modelById: Map<string, PersistedRecord>, corrections: PersistedRecord[], acceptances: PersistedRecord[], supersessions: PersistedRecord[]): void {
  const correctionById = uniqueRecordIds(corrections, "correctionEventId");
  const correctionRequestKeys = new Set<string>();
  for (const event of corrections) {
    const parent = modelById.get(String(event.parentRevisionId));
    const child = modelById.get(String(event.childRevisionId));
    const requestKey = String(event.projectId) + ":" + String(event.idempotencyKey);
    if (correctionRequestKeys.has(requestKey)) return invalid("S6_IDEMPOTENCY_KEY_REUSED");
    correctionRequestKeys.add(requestKey);
    if (parent === undefined || child === undefined || parent.projectId !== event.projectId || child.projectId !== event.projectId || parent.modelHash !== event.parentRevisionHash || child.modelHash !== event.childRevisionHash || child.parentRevisionId !== parent.modelRevisionId || child.parentRevisionHash !== parent.modelHash || child.sourceS5Fingerprint !== event.sourceS5Fingerprint || child.createdBy !== "user_correction") return invalid("S6_CORRECTION_LINEAGE_INVALID");
  }
  void correctionById;
  validateAcceptanceGraph(models, modelById, acceptances, supersessions);
}

function validateIdempotencyGraph(values: PersistedRecord[]): void {
  const keys = new Map<string, string>();
  for (const value of values) {
    const key = String(value.key);
    const inputHash = String(value.inputHash);
    const previous = keys.get(key);
    if (previous !== undefined && previous !== inputHash) return invalid("S6_IDEMPOTENCY_KEY_REUSED");
    if (previous !== undefined) return invalid("S6_IDEMPOTENCY_KEY_REUSED");
    keys.set(key, inputHash);
  }
}

export function validateS6Graph(state: StoreState): void {
  const models = persistedRecords(state.s6SpatialModels);
  const receipts = persistedRecords(state.s6ValidationReceipts);
  const corrections = persistedRecords(state.s6CorrectionEvents);
  const acceptances = persistedRecords(state.s6AcceptanceEvents);
  const supersessions = persistedRecords(state.s6SupersessionEvents);
  const artifacts = persistedRecords(state.s6ViewArtifacts);
  const preservationReceipts = persistedRecords(state.s6ViewPreservationReceipts);
  const jobs = persistedRecords(state.s6Jobs);
  const idempotency = persistedRecords(state.s6Idempotency);
  const modelById = validateModelLineage(models);
  validateEventGraph(models, modelById, corrections, acceptances, supersessions);
  validateArtifactGraph(models, modelById, artifacts, preservationReceipts, jobs);
  validateIdempotencyGraph(idempotency);
}
