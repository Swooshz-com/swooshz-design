import { Buffer } from "node:buffer";
import type {
  S8MaxExport,
  S8MaxGenerationReceipt,
  S8MaxIdempotency,
  S8MaxJob,
  S8MaxManifestRecord,
  S8MaxProviderMetadata,
  S8MaxReadback,
  S8MaxSemanticManifestDocument,
  S8MaxValidationReceipt,
  S8SemanticBinding,
  S8SemanticNode,
  S8SourceStampV1,
  Sha256,
  S8StoreState,
  StoreState,
} from "./types";
import {
  S8_MAX_GENERATION_RECEIPT_BYTES,
  S8_MAX_MANIFEST_BYTES,
  S8_MAX_NATIVE_BYTES,
  S8_MAX_PROVIDER_ATTEMPTS,
  S8_MAX_READBACK_BYTES,
  S8_MAX_USER_PROPERTIES_BYTES,
  S8_MAX_CANDIDATE_ATTEMPTS,
  S8_NATIVE_FILE_NAME,
  S8_PAYLOAD_SCHEMA_VERSION,
  S8_TRANSPORT_FILE_NAME,
  validateS8SourceStamp,
  sourceStampDigest,
} from "./s8-payload";
import { jcs, privateStorageKey, sha256, uuidV4Pattern } from "./utils";

export const S8_EXPORT_VERSION = "s8-max-export-v1" as const;
export const S8_JOB_VERSION = "s8-max-job-v1" as const;
export const S8_IDEMPOTENCY_VERSION = "s8-max-idempotency-v1" as const;
export const S8_MANIFEST_RECORD_VERSION = "s8-max-manifest-record-v1" as const;
export const S8_GENERATION_RECEIPT_VERSION = "s8-max-generation-receipt-v1" as const;
export const S8_VALIDATION_RECEIPT_VERSION = "s8-max-validation-receipt-v1" as const;
export const S8_PROVIDER_METADATA_VERSION = "s8-max-provider-metadata-v1" as const;
export const S8_SEMANTIC_MANIFEST_VERSION = "s8-max-semantic-manifest-v1" as const;
export const S8_READBACK_VERSION = "s8-max-readback-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const PATH_OR_URL = /(?:^[A-Za-z]:[\\/]|^\\\\|^\/|(?:^|[\\/])\.\.?(?:[\\/]|$)|(?:https?|data|file):)/iu;
const SECRET_KEY = /(?:token|secret|password|authorization|cookie|privatekey|signedurl|credential)/iu;
const EXPORT_STATUSES = [
  "queued", "running", "provider_pending", "provider_running", "staged", "validating", "validated",
  "committed", "stale", "superseded", "failed_retryable", "failed_terminal", "provider_hold", "aborted",
] as const;
const PHASES = ["none", "staged", "promoted", "committed", "aborted"] as const;
const ACTIVE_STATUSES = ["running", "provider_pending", "provider_running", "staged", "validating", "validated"] as const;
const TERMINAL_STATUSES = ["committed", "stale", "superseded", "failed_terminal", "aborted"] as const;
const MAX_COLLECTION = 16_384;

type RecordValue = Record<string, unknown>;

function invalid(detail = "invalid S8 persisted state"): never {
  throw new Error(detail);
}

function record(value: unknown, keys: readonly string[]): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as RecordValue;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}

function text(value: unknown, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Array.from(value).length > max || CONTROL.test(value) || PATH_OR_URL.test(value)) return invalid();
  return value;
}

function opaque(value: unknown, max = 240): string {
  const result = text(value, max);
  if (result.includes("\\") || result.includes("\r") || result.includes("\n")) return invalid();
  return result;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) return invalid();
  return value;
}

function nullableUuid(value: unknown): void {
  if (value !== null) uuid(value);
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) return invalid();
  return value;
}

function nullableSha(value: unknown): void {
  if (value !== null) sha(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return invalid();
  return value;
}

function nullableTimestamp(value: unknown): void {
  if (value !== null) timestamp(value);
}

function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) return invalid();
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) return invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function enumValue(value: unknown, allowed: readonly string[]): string {
  const result = text(value);
  if (!allowed.includes(result)) return invalid();
  return result;
}

function nullableText(value: unknown, max = 4096): void {
  if (value !== null) text(value, max);
}

function jsonValue(value: unknown, seen = new WeakSet<object>(), key: string | null = null): void {
  if (key !== null && SECRET_KEY.test(key)) return invalid("S8_SECRET_FIELD");
  if (typeof value === "string") {
    text(value, 8192, true);
    return;
  }
  if (typeof value === "number") {
    finiteNumber(value);
    return;
  }
  if (typeof value === "boolean" || value === null) return;
  if (typeof value !== "object" || value instanceof Number || value instanceof String || value instanceof Boolean) return invalid();
  if (seen.has(value)) return invalid("S8_CYCLIC_VALUE");
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => jsonValue(item, seen, `${String(index)}`));
  else Object.entries(value).forEach(([childKey, childValue]) => jsonValue(childValue, seen, childKey));
  seen.delete(value);
}

function source(value: unknown): S8SourceStampV1 {
  try {
    return validateS8SourceStamp(value);
  } catch {
    return invalid("S8_SOURCE_STAMP_INVALID");
  }
}

export function sameS8Source(left: S8SourceStampV1, right: S8SourceStampV1): boolean {
  return jcs(left) === jcs(right) && sourceStampDigest(left) === sourceStampDigest(right);
}

export function s8FinalMaxStorageKey(projectId: string, artifactId: string): string {
  return privateStorageKey("projects", projectId, "s8", "exports", artifactId, S8_NATIVE_FILE_NAME);
}

export function s8StagingMaxStorageKey(projectId: string, jobId: string, claimToken: string): string {
  return privateStorageKey("projects", projectId, "s8", "staging", jobId, claimToken, S8_NATIVE_FILE_NAME);
}

export function s8StagingPayloadStorageKey(projectId: string, jobId: string, claimToken: string): string {
  return privateStorageKey("projects", projectId, "s8", "staging", jobId, claimToken, S8_TRANSPORT_FILE_NAME);
}

export function s8FinalManifestStorageKey(projectId: string, manifestId: string): string {
  return privateStorageKey("projects", projectId, "s8", "manifests", `${manifestId}.json`);
}

function expectedStagingPath(projectId: string, jobId: string, path: string, fileName: string): boolean {
  const prefix = `projects/${projectId}/s8/staging/${jobId}/`;
  if (!path.startsWith(prefix)) return false;
  const suffix = path.slice(prefix.length).split("/");
  return suffix.length === 2 && (suffix[0] === "unclaimed" || uuidV4Pattern.test(suffix[0]!)) && suffix[1] === fileName;
}

function validateBinding(value: unknown): S8SemanticBinding {
  const item = record(value, [
    "sourceStampDigest", "payloadSha256", "generationAppBundleId", "generationAppBundleVersion", "generationAppBundleHash",
    "generationActivityId", "generationActivityVersion", "generationActivityHash", "validatorAppBundleId", "validatorAppBundleVersion",
    "validatorAppBundleHash", "validatorActivityId", "validatorActivityVersion", "validatorActivityHash", "engineId", "productVersion",
    "engineVersion", "constructionAlgorithmVersion", "semanticAlgorithmVersion",
  ]);
  sha(item.sourceStampDigest); sha(item.payloadSha256); sha(item.generationAppBundleHash); sha(item.generationActivityHash); sha(item.validatorAppBundleHash); sha(item.validatorActivityHash);
  for (const key of [
    "generationAppBundleId", "generationAppBundleVersion", "generationActivityId", "generationActivityVersion", "validatorAppBundleId",
    "validatorAppBundleVersion", "validatorActivityId", "validatorActivityVersion", "engineId", "productVersion", "engineVersion",
  ]) {
    const value = text(item[key], 240);
    if (value === "latest" || /[\\/]/u.test(value)) return invalid("S8_TOOL_BINDING_INVALID");
  }
  enumValue(item.constructionAlgorithmVersion, ["s8-max-scene-construction-v1"]);
  enumValue(item.semanticAlgorithmVersion, ["s8-max-semantic-v1"]);
  return item as unknown as S8SemanticBinding;
}

function point(value: unknown): void {
  const item = record(value, ["x", "y", "z"]);
  finiteNumber(item.x); finiteNumber(item.y); finiteNumber(item.z);
}

function matrix(value: unknown): void {
  const item = record(value, ["rows", "translation"]);
  const rows = array(item.rows);
  if (rows.length !== 3) return invalid();
  rows.forEach(point);
  point(item.translation);
}

function bounds(value: unknown): void {
  const item = record(value, ["min", "max"]);
  point(item.min); point(item.max);
}

function mesh(value: unknown): void {
  const item = record(value, ["vertices", "faces"]);
  const vertices = array(item.vertices); const faces = array(item.faces);
  if (vertices.length > 96 || faces.length > 128) return invalid("S8_RESOURCE_LIMIT");
  vertices.forEach(point);
  faces.forEach((face) => {
    const tuple = array(face);
    if (tuple.length !== 3) return invalid();
    tuple.forEach((index) => integer(index, 1, 96));
  });
}

function material(value: unknown): void {
  const item = record(value, ["materialId", "nativeClass", "baseColorHex", "metalness", "roughness", "transparency", "emission", "degradationCodes"]);
  text(item.materialId, 240); enumValue(item.nativeClass, ["PhysicalMaterial"]); text(item.baseColorHex, 7);
  integer(item.metalness, 0, 1); finiteNumber(item.roughness); finiteNumber(item.transparency); finiteNumber(item.emission);
  const codes = array(item.degradationCodes); if (codes.length > 16) return invalid(); codes.forEach((code) => text(code, 160, true));
}

function userProperties(value: unknown): void {
  const item = record(value, Object.keys((value ?? {}) as object));
  for (const [key, child] of Object.entries(item)) {
    text(key, 240); text(child, 4096, true);
  }
  if (Buffer.byteLength(jcs(item), "utf8") > S8_MAX_USER_PROPERTIES_BYTES) return invalid("S8_RESOURCE_LIMIT");
}

function semanticNode(value: unknown): S8SemanticNode {
  const item = record(value, [
    "nodeKind", "objectId", "name", "parentObjectId", "nativeGeometryClass", "geometryFamily", "mesh", "localTransform", "worldTransform",
    "localBoundsMm", "worldBoundsMm", "material", "userProperties",
  ]);
  enumValue(item.nodeKind, ["root", "geometry"]); if (item.objectId !== null) text(item.objectId, 240); text(item.name, 120);
  if (item.parentObjectId !== null) text(item.parentObjectId, 240);
  enumValue(item.nativeGeometryClass, ["Dummy", "Editable_Poly"]);
  if (item.geometryFamily !== null) enumValue(item.geometryFamily, ["rect_prism", "round_prism", "profile_extrusion"]);
  if (item.mesh !== null) mesh(item.mesh);
  matrix(item.localTransform); matrix(item.worldTransform);
  if (item.localBoundsMm !== null) {
    const dims = record(item.localBoundsMm, ["widthMm", "depthMm", "heightMm"]);
    finiteNumber(dims.widthMm); finiteNumber(dims.depthMm); finiteNumber(dims.heightMm);
  }
  if (item.worldBoundsMm !== null) bounds(item.worldBoundsMm);
  if (item.material !== null) material(item.material);
  userProperties(item.userProperties);
  return item as unknown as S8SemanticNode;
}

function validateManifestDocument(value: unknown): S8MaxSemanticManifestDocument {
  const item = record(value, [
    "schemaVersion", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "binding", "units",
    "axisConvention", "rootName", "nodes", "objectCount", "externalAssetCount", "externalDependencyCount", "semanticDigest",
  ]);
  enumValue(item.schemaVersion, [S8_SEMANTIC_MANIFEST_VERSION]); uuid(item.projectId); uuid(item.artifactId); source(item.sourceStamp); sha(item.sourceStampDigest); sha(item.payloadSha256);
  validateBinding(item.binding); enumValue(item.units, ["millimetres"]); enumValue(item.axisConvention, ["s6-to-max-x-right-zup-minus-yfront-v1"]); text(item.rootName, 120);
  const nodes = array(item.nodes); if (nodes.length === 0 || nodes.length > 257) return invalid("S8_RESOURCE_LIMIT"); nodes.forEach(semanticNode);
  integer(item.objectCount, 0, 256); if (item.objectCount !== nodes.length - 1) return invalid("S8_OBJECT_COUNT_INVALID");
  integer(item.externalAssetCount, 0, 0); integer(item.externalDependencyCount, 0, 0); sha(item.semanticDigest);
  jsonValue(item);
  return item as unknown as S8MaxSemanticManifestDocument;
}

function validateReadback(value: unknown): S8MaxReadback {
  const item = record(value, [
    "schemaVersion", "projectId", "artifactId", "sourceStampDigest", "payloadSha256", "binding", "artifactSha256", "artifactByteSize",
    "units", "axisConvention", "objectCount", "nodes", "checks", "externalAssetCount", "externalDependencyCount", "missingPluginCount",
    "unsupportedSaveVersion", "outcome", "readbackHash", "checkedAt",
  ]);
  enumValue(item.schemaVersion, [S8_READBACK_VERSION]); uuid(item.projectId); uuid(item.artifactId); sha(item.sourceStampDigest); sha(item.payloadSha256); validateBinding(item.binding); sha(item.artifactSha256);
  integer(item.artifactByteSize, 1, S8_MAX_NATIVE_BYTES); enumValue(item.units, ["millimetres"]); enumValue(item.axisConvention, ["s6-to-max-x-right-zup-minus-yfront-v1"]);
  const nodes = array(item.nodes); if (nodes.length === 0 || nodes.length > 257) return invalid("S8_RESOURCE_LIMIT"); nodes.forEach(semanticNode);
  integer(item.objectCount, 0, 256); if (item.objectCount !== nodes.length - 1) return invalid("S8_OBJECT_COUNT_INVALID");
  const checks = array(item.checks); if (checks.length < 1 || checks.length > 64) return invalid(); checks.forEach((check) => text(check, 160));
  integer(item.externalAssetCount, 0, 0); integer(item.externalDependencyCount, 0, 0); integer(item.missingPluginCount, 0, 0); bool(item.unsupportedSaveVersion); enumValue(item.outcome, ["pass", "fail"]); sha(item.readbackHash); timestamp(item.checkedAt); jsonValue(item);
  return item as unknown as S8MaxReadback;
}

const EXPORT_KEYS = [
  "schemaVersion", "artifactId", "projectId", "jobId", "sourceStamp", "sourceStampDigest", "payloadSha256", "payloadByteSize", "inputHash",
  "status", "publicationPhase", "candidateAttempt", "retryOfArtifactId", "manifestId", "generationReceiptId", "validationReceiptId", "artifactSha256",
  "artifactByteSize", "privateFinalStorageKey", "privateStagingStorageKey", "privatePayloadStorageKey", "failureCode", "createdAt", "updatedAt",
  "committedAt", "staleAt", "supersededAt",
] as const;
const JOB_KEYS = [
  "schemaVersion", "jobId", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "inputHash", "idempotencyKey",
  "candidateAttempt", "retryOfJobId", "stage", "status", "generationProviderAttempts", "validationProviderAttempts", "claimToken", "ownerProcessId",
  "claimedAt", "heartbeatAt", "createdAt", "updatedAt", "terminalAt",
] as const;
const IDEMPOTENCY_KEYS = ["schemaVersion", "projectId", "operation", "idempotencyKey", "sourceStamp", "sourceStampDigest", "inputHash", "jobId", "artifactId", "createdAt"] as const;
const MANIFEST_KEYS = ["schemaVersion", "manifestId", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "manifestHash", "manifestByteSize", "document", "privateStorageKey"] as const;
const GENERATION_RECEIPT_KEYS = ["schemaVersion", "receiptId", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "binding", "artifactSha256", "artifactByteSize", "manifestId", "manifestHash", "nativeSaveOutcome", "outcome", "checkedAt", "receiptHash"] as const;
const VALIDATION_RECEIPT_KEYS = ["schemaVersion", "receiptId", "projectId", "artifactId", "sourceStamp", "sourceStampDigest", "payloadSha256", "binding", "manifestId", "manifestHash", "artifactSha256", "artifactByteSize", "readback", "readbackHash", "outcome", "issues", "checkedAt", "receiptHash"] as const;
const PROVIDER_KEYS = ["schemaVersion", "metadataId", "projectId", "artifactId", "jobId", "stage", "provider", "providerAttempt", "outcome", "failureCode", "engineId", "productVersion", "engineVersion", "appBundleId", "appBundleVersion", "appBundleHash", "activityId", "activityVersion", "activityHash", "occurredAt"] as const;

function validateExport(value: unknown): S8MaxExport {
  const item = record(value, EXPORT_KEYS); const result = item as unknown as S8MaxExport;
  enumValue(item.schemaVersion, [S8_EXPORT_VERSION]); uuid(item.artifactId); uuid(item.projectId); uuid(item.jobId); source(item.sourceStamp); sha(item.sourceStampDigest); if (item.sourceStampDigest !== sourceStampDigest(result.sourceStamp)) return invalid("S8_SOURCE_STAMP_DIGEST_INVALID"); sha(item.payloadSha256); integer(item.payloadByteSize, 1, 2_000_000); sha(item.inputHash);
  const status = enumValue(item.status, EXPORT_STATUSES); const phase = enumValue(item.publicationPhase, PHASES); const attempt = integer(item.candidateAttempt, 1, S8_MAX_CANDIDATE_ATTEMPTS); if (attempt !== 1 && attempt !== 2) return invalid("S8_ATTEMPT_INVALID");
  nullableUuid(item.retryOfArtifactId); uuid(item.manifestId); nullableUuid(item.generationReceiptId); nullableUuid(item.validationReceiptId); nullableSha(item.artifactSha256); if (item.artifactByteSize !== null) integer(item.artifactByteSize, 1, S8_MAX_NATIVE_BYTES);
  text(item.privateFinalStorageKey, 2048); text(item.privateStagingStorageKey, 2048); text(item.privatePayloadStorageKey, 2048);
  if (item.privateFinalStorageKey !== s8FinalMaxStorageKey(result.projectId, result.artifactId)) return invalid("S8_FINAL_PATH_INVALID");
  if (!expectedStagingPath(result.projectId, result.jobId, result.privateStagingStorageKey, S8_NATIVE_FILE_NAME) || !expectedStagingPath(result.projectId, result.jobId, result.privatePayloadStorageKey, S8_TRANSPORT_FILE_NAME)) return invalid("S8_STAGING_PATH_INVALID");
  nullableText(item.failureCode, 200); timestamp(item.createdAt); timestamp(item.updatedAt); nullableTimestamp(item.committedAt); nullableTimestamp(item.staleAt); nullableTimestamp(item.supersededAt);
  if ((item.artifactSha256 === null) !== (item.artifactByteSize === null)) return invalid("S8_ARTIFACT_REFERENCE_INVALID");
  const allowed: Record<string, readonly string[]> = {
    queued: ["none"], running: ["none"], provider_pending: ["none", "staged", "promoted"], provider_running: ["none", "staged", "promoted"], staged: ["staged"], validating: ["promoted"], validated: ["promoted"],
    committed: ["committed"], superseded: ["committed"], stale: ["none", "staged", "promoted"], failed_retryable: ["none", "staged", "promoted"],
    failed_terminal: ["aborted"], provider_hold: ["none", "staged", "promoted"], aborted: ["aborted"],
  };
  if (!allowed[status]?.includes(phase)) return invalid("S8_PUBLICATION_STATE_INVALID");
  if (status === "committed" || status === "superseded") {
    if (phase !== "committed" || item.generationReceiptId === null || item.validationReceiptId === null || item.artifactSha256 === null || item.artifactByteSize === null || item.committedAt === null) return invalid("S8_COMMIT_STATE_INVALID");
  } else if (item.committedAt !== null) return invalid("S8_COMMIT_STATE_INVALID");
  if (status === "stale" && item.staleAt === null) return invalid("S8_STALE_STATE_INVALID");
  if (status !== "stale" && item.staleAt !== null) return invalid("S8_STALE_STATE_INVALID");
  if (status === "superseded" && item.supersededAt === null) return invalid("S8_SUPERSESSION_STATE_INVALID");
  if (status !== "superseded" && item.supersededAt !== null) return invalid("S8_SUPERSESSION_STATE_INVALID");
  if (status === "failed_retryable" && attempt !== 1) return invalid("S8_RETRY_CHAIN_INVALID");
  if (status === "failed_terminal" && attempt !== 2) return invalid("S8_RETRY_CHAIN_INVALID");
  return result;
}

function validateJob(value: unknown): S8MaxJob {
  const item = record(value, JOB_KEYS); const result = item as unknown as S8MaxJob;
  enumValue(item.schemaVersion, [S8_JOB_VERSION]); uuid(item.jobId); uuid(item.projectId); uuid(item.artifactId); source(item.sourceStamp); sha(item.sourceStampDigest); if (item.sourceStampDigest !== sourceStampDigest(result.sourceStamp)) return invalid("S8_SOURCE_STAMP_DIGEST_INVALID"); sha(item.payloadSha256); sha(item.inputHash); opaque(item.idempotencyKey);
  const attempt = integer(item.candidateAttempt, 1, S8_MAX_CANDIDATE_ATTEMPTS); if (attempt !== 1 && attempt !== 2) return invalid("S8_ATTEMPT_INVALID"); nullableUuid(item.retryOfJobId); enumValue(item.stage, ["generation", "validation", "complete"]); const status = enumValue(item.status, EXPORT_STATUSES);
  integer(item.generationProviderAttempts, 0, S8_MAX_PROVIDER_ATTEMPTS); integer(item.validationProviderAttempts, 0, S8_MAX_PROVIDER_ATTEMPTS); nullableUuid(item.claimToken); nullableText(item.ownerProcessId, 240); nullableTimestamp(item.claimedAt); nullableTimestamp(item.heartbeatAt); timestamp(item.createdAt); timestamp(item.updatedAt); nullableTimestamp(item.terminalAt);
  const claimFields = [item.claimToken, item.ownerProcessId, item.claimedAt, item.heartbeatAt]; if (claimFields.some((field) => field === null) && claimFields.some((field) => field !== null)) return invalid("S8_CLAIM_STATE_INVALID");
  const active = ACTIVE_STATUSES.includes(status as typeof ACTIVE_STATUSES[number]); if (active !== claimFields.every((field) => field !== null)) return invalid("S8_CLAIM_STATE_INVALID");
  const terminal = TERMINAL_STATUSES.includes(status as typeof TERMINAL_STATUSES[number]); if (terminal !== (item.terminalAt !== null)) return invalid("S8_TERMINAL_STATE_INVALID");
  if (status === "failed_retryable" && attempt !== 1) return invalid("S8_RETRY_CHAIN_INVALID"); if (status === "failed_terminal" && attempt !== 2) return invalid("S8_RETRY_CHAIN_INVALID");
  return result;
}

function validateIdempotency(value: unknown): S8MaxIdempotency {
  const item = record(value, IDEMPOTENCY_KEYS); const result = item as unknown as S8MaxIdempotency;
  enumValue(item.schemaVersion, [S8_IDEMPOTENCY_VERSION]); uuid(item.projectId); enumValue(item.operation, ["export", "retry"]); opaque(item.idempotencyKey); source(item.sourceStamp); sha(item.sourceStampDigest); if (item.sourceStampDigest !== sourceStampDigest(item.sourceStamp as S8SourceStampV1)) return invalid("S8_SOURCE_STAMP_DIGEST_INVALID"); sha(item.inputHash); uuid(item.jobId); uuid(item.artifactId); timestamp(item.createdAt);
  return result;
}

function hashManifestDocument(document: S8MaxSemanticManifestDocument): Sha256 {
  return sha256(Buffer.from(jcs(document), "utf8"));
}

function hashSemanticDocument(document: S8MaxSemanticManifestDocument): Sha256 {
  return sha256(Buffer.from(jcs({ ...document, semanticDigest: "" }), "utf8"));
}

export function hashS8GenerationReceipt(receipt: S8MaxGenerationReceipt): Sha256 {
  return sha256(Buffer.from(jcs({ ...receipt, receiptHash: "" }), "utf8"));
}

export function hashS8ValidationReceipt(receipt: S8MaxValidationReceipt): Sha256 {
  return sha256(Buffer.from(jcs({ ...receipt, receiptHash: "" }), "utf8"));
}

function validateManifest(value: unknown): S8MaxManifestRecord {
  const item = record(value, MANIFEST_KEYS); const result = item as unknown as S8MaxManifestRecord;
  enumValue(item.schemaVersion, [S8_MANIFEST_RECORD_VERSION]); uuid(item.manifestId); uuid(item.projectId); uuid(item.artifactId); source(item.sourceStamp); sha(item.sourceStampDigest); sha(item.payloadSha256); const document = validateManifestDocument(item.document); sha(item.manifestHash); integer(item.manifestByteSize, 1, S8_MAX_MANIFEST_BYTES); text(item.privateStorageKey, 2048);
  if (item.privateStorageKey !== s8FinalManifestStorageKey(result.projectId, result.manifestId)) return invalid("S8_MANIFEST_PATH_INVALID");
  if (document.projectId !== result.projectId || document.artifactId !== result.artifactId || document.sourceStampDigest !== result.sourceStampDigest || document.sourceStampDigest !== sourceStampDigest(document.sourceStamp) || document.payloadSha256 !== result.payloadSha256 || document.semanticDigest !== hashSemanticDocument(document)) return invalid("S8_MANIFEST_BINDING_INVALID");
  if (Buffer.byteLength(jcs(document), "utf8") !== item.manifestByteSize || hashManifestDocument(document) !== item.manifestHash) return invalid("S8_MANIFEST_HASH_MISMATCH");
  return result;
}

function validateGenerationReceipt(value: unknown): S8MaxGenerationReceipt {
  const item = record(value, GENERATION_RECEIPT_KEYS); const result = item as unknown as S8MaxGenerationReceipt;
  enumValue(item.schemaVersion, [S8_GENERATION_RECEIPT_VERSION]); uuid(item.receiptId); uuid(item.projectId); uuid(item.artifactId); source(item.sourceStamp); sha(item.sourceStampDigest); if (item.sourceStampDigest !== sourceStampDigest(result.sourceStamp)) return invalid("S8_SOURCE_STAMP_DIGEST_INVALID"); sha(item.payloadSha256); const binding = validateBinding(item.binding); if (binding.sourceStampDigest !== item.sourceStampDigest || binding.payloadSha256 !== item.payloadSha256) return invalid("S8_TOOL_BINDING_INVALID"); sha(item.artifactSha256); integer(item.artifactByteSize, 1, S8_MAX_NATIVE_BYTES); uuid(item.manifestId); sha(item.manifestHash); enumValue(item.nativeSaveOutcome, ["pass", "fail"]); enumValue(item.outcome, ["pass", "fail"]); timestamp(item.checkedAt); sha(item.receiptHash);
  if (result.outcome === "pass" && result.nativeSaveOutcome !== "pass") return invalid("S8_RECEIPT_OUTCOME_INVALID"); if (hashS8GenerationReceipt(result) !== result.receiptHash) return invalid("S8_RECEIPT_HASH_MISMATCH"); if (Buffer.byteLength(jcs(result), "utf8") > S8_MAX_GENERATION_RECEIPT_BYTES) return invalid("S8_RESOURCE_LIMIT");
  return result;
}

function validateValidationReceipt(value: unknown): S8MaxValidationReceipt {
  const item = record(value, VALIDATION_RECEIPT_KEYS); const result = item as unknown as S8MaxValidationReceipt;
  enumValue(item.schemaVersion, [S8_VALIDATION_RECEIPT_VERSION]); uuid(item.receiptId); uuid(item.projectId); uuid(item.artifactId); source(item.sourceStamp); sha(item.sourceStampDigest); if (item.sourceStampDigest !== sourceStampDigest(result.sourceStamp)) return invalid("S8_SOURCE_STAMP_DIGEST_INVALID"); sha(item.payloadSha256); const binding = validateBinding(item.binding); if (binding.sourceStampDigest !== item.sourceStampDigest || binding.payloadSha256 !== item.payloadSha256) return invalid("S8_TOOL_BINDING_INVALID"); uuid(item.manifestId); sha(item.manifestHash); sha(item.artifactSha256); integer(item.artifactByteSize, 1, S8_MAX_NATIVE_BYTES); const readback = validateReadback(item.readback); if (readback.sourceStampDigest !== item.sourceStampDigest || readback.payloadSha256 !== item.payloadSha256 || readback.artifactSha256 !== item.artifactSha256 || readback.artifactByteSize !== item.artifactByteSize || jcs(readback.binding) !== jcs(binding)) return invalid("S8_READBACK_BINDING_INVALID"); sha(item.readbackHash); enumValue(item.outcome, ["pass", "fail"]); const issues = array(item.issues); if (issues.length > 128) return invalid("S8_RESOURCE_LIMIT"); issues.forEach((issue) => text(issue, 240, true)); timestamp(item.checkedAt); sha(item.receiptHash);
  if (readback.readbackHash !== result.readbackHash) return invalid("S8_READBACK_HASH_MISMATCH"); if (hashS8ValidationReceipt(result) !== result.receiptHash) return invalid("S8_RECEIPT_HASH_MISMATCH"); if (Buffer.byteLength(jcs(result), "utf8") > S8_MAX_READBACK_BYTES) return invalid("S8_RESOURCE_LIMIT"); if (result.outcome === "pass" && (issues.length !== 0 || readback.outcome !== "pass")) return invalid("S8_RECEIPT_OUTCOME_INVALID");
  return result;
}

function validateProviderMetadata(value: unknown): S8MaxProviderMetadata {
  const item = record(value, PROVIDER_KEYS); const result = item as unknown as S8MaxProviderMetadata;
  enumValue(item.schemaVersion, [S8_PROVIDER_METADATA_VERSION]); uuid(item.metadataId); uuid(item.projectId); uuid(item.artifactId); uuid(item.jobId); enumValue(item.stage, ["generation", "validation"]); enumValue(item.provider, ["aps-oss-v2-direct-s3", "mock-oss-v2", "unavailable"]); integer(item.providerAttempt, 1, S8_MAX_PROVIDER_ATTEMPTS); enumValue(item.outcome, ["pass", "hold", "fail"]); nullableText(item.failureCode, 120); text(item.engineId, 240); text(item.productVersion, 240); text(item.engineVersion, 240); text(item.appBundleId, 240); text(item.appBundleVersion, 240); sha(item.appBundleHash); text(item.activityId, 240); text(item.activityVersion, 240); sha(item.activityHash); timestamp(item.occurredAt);
  return result;
}

function collections(state: StoreState): {
  exports: S8MaxExport[];
  jobs: S8MaxJob[];
  idempotency: S8MaxIdempotency[];
  manifests: S8MaxManifestRecord[];
  generationReceipts: S8MaxGenerationReceipt[];
  validationReceipts: S8MaxValidationReceipt[];
  providerMetadata: S8MaxProviderMetadata[];
} {
  const s8 = state as S8StoreState;
  if (!Array.isArray(s8.s8MaxExports) || !Array.isArray(s8.s8MaxJobs) || !Array.isArray(s8.s8MaxIdempotency) || !Array.isArray(s8.s8MaxManifests) || !Array.isArray(s8.s8MaxGenerationReceipts) || !Array.isArray(s8.s8MaxValidationReceipts) || !Array.isArray(s8.s8MaxProviderMetadata)) return invalid("S8_COLLECTIONS_MISSING");
  return {
    exports: s8.s8MaxExports, jobs: s8.s8MaxJobs, idempotency: s8.s8MaxIdempotency, manifests: s8.s8MaxManifests,
    generationReceipts: s8.s8MaxGenerationReceipts, validationReceipts: s8.s8MaxValidationReceipts, providerMetadata: s8.s8MaxProviderMetadata,
  };
}

export function getS8Collections(state: StoreState): ReturnType<typeof collections> {
  return collections(state);
}

export function validateS8Collections(parsedRecord: unknown, state: StoreState): void {
  if (typeof parsedRecord !== "object" || parsedRecord === null || Array.isArray(parsedRecord)) return invalid();
  const parsed = parsedRecord as RecordValue;
  const fields: Array<[keyof S8StoreState, (value: unknown) => unknown]> = [
    ["s8MaxExports", validateExport], ["s8MaxJobs", validateJob], ["s8MaxIdempotency", validateIdempotency], ["s8MaxManifests", validateManifest],
    ["s8MaxGenerationReceipts", validateGenerationReceipt], ["s8MaxValidationReceipts", validateValidationReceipt], ["s8MaxProviderMetadata", validateProviderMetadata],
  ];
  for (const [field, validator] of fields) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
    for (const value of array(parsed[field])) validator(value);
  }
  void state;
}

function unique<T>(values: readonly T[], getId: (value: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) { const id = getId(value); if (map.has(id)) invalid("S8_DUPLICATE_ID"); map.set(id, value); }
  return map;
}

function validateRetryChains(exports: readonly S8MaxExport[], jobs: readonly S8MaxJob[]): void {
  const exportGroups = new Map<string, S8MaxExport[]>(); const jobGroups = new Map<string, S8MaxJob[]>();
  const jobById = new Map(jobs.map((item) => [item.jobId, item]));
  for (const item of exports) {
    const job = jobById.get(item.jobId); if (!job) return invalid("S8_RETRY_CHAIN_INVALID");
    const key = `${item.projectId}:${item.sourceStampDigest}:${item.inputHash}:${job.idempotencyKey}`; const group = exportGroups.get(key) ?? []; group.push(item); exportGroups.set(key, group);
  }
  for (const item of jobs) { const key = `${item.projectId}:${item.sourceStampDigest}:${item.inputHash}:${item.idempotencyKey}`; const group = jobGroups.get(key) ?? []; group.push(item); jobGroups.set(key, group); }
  for (const group of [...exportGroups.values(), ...jobGroups.values()]) {
    group.sort((left, right) => left.candidateAttempt - right.candidateAttempt);
    if (group.length > S8_MAX_CANDIDATE_ATTEMPTS || group.some((item, index) => item.candidateAttempt !== index + 1)) return invalid("S8_RETRY_CHAIN_INVALID");
    const first = group[0]!; const firstRetry = "retryOfArtifactId" in first ? first.retryOfArtifactId : first.retryOfJobId; if (firstRetry !== null) return invalid("S8_RETRY_CHAIN_INVALID");
    if (group.length === 2) {
      const second = group[1]!; const expected = "retryOfArtifactId" in first ? first.artifactId : first.jobId; const retry = "retryOfArtifactId" in second ? second.retryOfArtifactId : second.retryOfJobId;
      if (retry !== expected) return invalid("S8_RETRY_CHAIN_INVALID");
    }
  }
}

export function validateS8Graph(state: StoreState): void {
  const { exports, jobs, idempotency, manifests, generationReceipts, validationReceipts, providerMetadata } = collections(state);
  if ([exports, jobs, idempotency, manifests, generationReceipts, validationReceipts, providerMetadata].some((items) => items.length > MAX_COLLECTION)) return invalid("S8_RESOURCE_LIMIT");
  const exportById = unique(exports, (item) => item.artifactId); const jobById = unique(jobs, (item) => item.jobId); const manifestById = unique(manifests, (item) => item.manifestId); const generationById = unique(generationReceipts, (item) => item.receiptId); const validationById = unique(validationReceipts, (item) => item.receiptId); unique(validationReceipts, (item) => item.artifactId); unique(generationReceipts, (item) => item.artifactId); unique(providerMetadata, (item) => item.metadataId);
  const idempotencyByKey = new Map<string, S8MaxIdempotency>(); const claimTokens = new Set<string>();
  for (const item of idempotency) {
    const key = `${item.projectId}:${item.operation}:${item.idempotencyKey}`; if (idempotencyByKey.has(key)) return invalid("S8_IDEMPOTENCY_KEY_REUSED"); idempotencyByKey.set(key, item);
    const job = jobById.get(item.jobId); const artifact = exportById.get(item.artifactId); if (!job || !artifact || job.projectId !== item.projectId || artifact.projectId !== item.projectId || job.artifactId !== artifact.artifactId || job.inputHash !== item.inputHash || artifact.inputHash !== item.inputHash || job.sourceStampDigest !== item.sourceStampDigest || artifact.sourceStampDigest !== item.sourceStampDigest || !sameS8Source(job.sourceStamp, item.sourceStamp) || !sameS8Source(artifact.sourceStamp, item.sourceStamp)) return invalid("S8_IDEMPOTENCY_LINK_INVALID");
    if (item.operation === "export" && (job.idempotencyKey !== item.idempotencyKey || artifact.candidateAttempt !== 1 || artifact.retryOfArtifactId !== null || job.retryOfJobId !== null)) return invalid("S8_IDEMPOTENCY_LINK_INVALID");
  }
  for (const artifact of exports) {
    const job = jobById.get(artifact.jobId); if (!job || job.projectId !== artifact.projectId || job.artifactId !== artifact.artifactId || job.status !== artifact.status || job.candidateAttempt !== artifact.candidateAttempt || job.sourceStampDigest !== artifact.sourceStampDigest || !sameS8Source(job.sourceStamp, artifact.sourceStamp)) return invalid("S8_ARTIFACT_REFERENCE_INVALID");
    const manifest = manifestById.get(artifact.manifestId); if (artifact.generationReceiptId !== null && !manifest) return invalid("S8_MANIFEST_REFERENCE_INVALID");
    if (artifact.generationReceiptId !== null) { const receipt = generationById.get(artifact.generationReceiptId); if (!receipt || receipt.artifactId !== artifact.artifactId || receipt.manifestId !== artifact.manifestId || receipt.artifactSha256 !== artifact.artifactSha256 || receipt.artifactByteSize !== artifact.artifactByteSize || receipt.sourceStampDigest !== artifact.sourceStampDigest) return invalid("S8_RECEIPT_REFERENCE_INVALID"); }
    if (artifact.validationReceiptId !== null) { const receipt = validationById.get(artifact.validationReceiptId); if (!receipt || receipt.artifactId !== artifact.artifactId || receipt.manifestId !== artifact.manifestId || receipt.artifactSha256 !== artifact.artifactSha256 || receipt.artifactByteSize !== artifact.artifactByteSize || receipt.sourceStampDigest !== artifact.sourceStampDigest || receipt.outcome !== "pass") return invalid("S8_RECEIPT_REFERENCE_INVALID"); }
    if (artifact.status === "committed" && (artifact.validationReceiptId === null || artifact.generationReceiptId === null || artifact.artifactSha256 === null || artifact.artifactByteSize === null || !manifest)) return invalid("S8_COMMIT_REFERENCE_INVALID");
    if (artifact.status === "validated" && artifact.validationReceiptId === null) return invalid("S8_RECEIPT_REFERENCE_INVALID");
  }
  for (const job of jobs) {
    if (job.claimToken !== null && claimTokens.has(job.claimToken)) return invalid("S8_CLAIM_STATE_INVALID"); if (job.claimToken !== null) claimTokens.add(job.claimToken);
    const artifact = exportById.get(job.artifactId); if (!artifact || artifact.jobId !== job.jobId || artifact.projectId !== job.projectId || !sameS8Source(artifact.sourceStamp, job.sourceStamp)) return invalid("S8_JOB_REFERENCE_INVALID");
  }
  for (const manifest of manifests) {
    const artifact = exportById.get(manifest.artifactId); if (!artifact || artifact.projectId !== manifest.projectId || artifact.manifestId !== manifest.manifestId || artifact.sourceStampDigest !== manifest.sourceStampDigest || artifact.payloadSha256 !== manifest.payloadSha256) return invalid("S8_MANIFEST_REFERENCE_INVALID");
  }
  for (const receipt of generationReceipts) {
    const artifact = exportById.get(receipt.artifactId); if (!artifact || artifact.projectId !== receipt.projectId || artifact.manifestId !== receipt.manifestId || artifact.generationReceiptId !== receipt.receiptId || artifact.sourceStampDigest !== receipt.sourceStampDigest) return invalid("S8_RECEIPT_REFERENCE_INVALID");
  }
  for (const receipt of validationReceipts) {
    const artifact = exportById.get(receipt.artifactId); if (!artifact || artifact.projectId !== receipt.projectId || artifact.manifestId !== receipt.manifestId || artifact.validationReceiptId !== receipt.receiptId || artifact.sourceStampDigest !== receipt.sourceStampDigest) return invalid("S8_RECEIPT_REFERENCE_INVALID");
  }
  for (const metadata of providerMetadata) {
    const job = jobById.get(metadata.jobId); if (!job || job.projectId !== metadata.projectId || job.artifactId !== metadata.artifactId) return invalid("S8_PROVIDER_REFERENCE_INVALID");
  }
  validateRetryChains(exports, jobs);
}
