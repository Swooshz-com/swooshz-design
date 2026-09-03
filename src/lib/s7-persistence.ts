import { Buffer } from "node:buffer";
import type {
  S7CadExport,
  S7CadIdempotency,
  S7CadJob,
  S7CadManifestRecord,
  S7CadReadbackReceipt,
  S7SourceStamp,
  StoreState,
} from "./types";
import { jcs, privateStorageKey, sha256, uuidV4Pattern } from "./utils";

export const S7_EXPORT_VERSION = "s7-cad-export-v1" as const;
export const S7_JOB_VERSION = "s7-cad-job-v1" as const;
export const S7_IDEMPOTENCY_VERSION = "s7-cad-idempotency-v1" as const;
export const S7_MANIFEST_VERSION = "s7-cad-manifest-v1" as const;
export const S7_RECEIPT_VERSION = "s7-cad-validation-receipt-v1" as const;
export const S7_READBACK_VERSION = "s7-cad-readback-v1" as const;
export const S7_DXF_VERSION = "s7-dxf-r2000-ascii-v1" as const;
export const S7_WORLD_TO_PLAN_VERSION = "s7-world-to-plan-v1" as const;
export const S7_FIXED_DOWNLOAD_NAME = "swooshz-s7-plan.dxf" as const;

export const S7_MAX_DXF_BYTES = 8_000_000;
export const S7_MAX_DXF_LINES = 200_000;
export const S7_MAX_DXF_LINE_BYTES = 512;
export const S7_MAX_ENTITIES = 4_096;
export const S7_MAX_VERTICES = 16_384;
export const S7_MAX_LAYERS = 32;
export const S7_MAX_TABLE_RECORDS = 64;
export const S7_MAX_LABEL_CODE_POINTS = 120;
export const S7_MAX_XDATA_BYTES = 2_048;
export const S7_MAX_XDATA_STRINGS = 16;
export const S7_MAX_MANIFEST_BYTES = 4_000_000;
export const S7_MAX_RECEIPT_BYTES = 256_000;
export const S7_MAX_RECOVERY_ITEMS = 256;
export const S7_MAX_ATTEMPTS = 2;

const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const EXPORT_STATUSES = ["queued", "running", "staged", "promoted", "committed", "stale", "superseded", "failed_retryable", "failed_terminal", "aborted"] as const;
const PHASES = ["none", "staged", "promoted", "committed", "aborted"] as const;
const SOURCE_KEYS = ["sourceRevisionId", "sourceRevisionHash", "sourceS5Fingerprint", "validationReceiptId", "validationHash", "s6HandoffSchemaVersion", "handoffDigest"] as const;
const EXPORT_KEYS = ["schemaVersion", "artifactId", "projectId", "jobId", "source", "inputHash", "dxfVersion", "worldToPlanVersion", "format", "mimeType", "downloadFileName", "status", "publicationPhase", "attempt", "retryOfArtifactId", "manifestId", "manifestHash", "readbackReceiptId", "readbackHash", "sha256", "byteSize", "privateFinalStorageKey", "privateStagingStorageKey", "failureCode", "createdAt", "updatedAt", "committedAt", "staleAt", "supersededAt"] as const;
const JOB_KEYS = ["schemaVersion", "jobId", "projectId", "artifactId", "source", "inputHash", "idempotencyKey", "status", "attempt", "retryOfJobId", "claimToken", "ownerProcessId", "claimedAt", "heartbeatAt", "createdAt", "updatedAt", "terminalAt"] as const;
const IDEMPOTENCY_KEYS = ["schemaVersion", "projectId", "operation", "idempotencyKey", "inputHash", "source", "jobId", "artifactId", "createdAt"] as const;
const MANIFEST_KEYS = ["schemaVersion", "manifestId", "projectId", "artifactId", "source", "worldToPlanVersion", "dxfVersion", "manifestHash", "manifestByteSize", "privateManifestStorageKey"] as const;
const RECEIPT_KEYS = ["schemaVersion", "receiptId", "projectId", "artifactId", "source", "manifestId", "manifestHash", "worldToPlanVersion", "dxfVersion", "sha256", "byteSize", "entityCount", "correspondenceResult", "outcome", "issues", "checkedAt", "receiptHash", "readbackVersion"] as const;

type RecordValue = Record<string, unknown>;

function invalid(detail = "invalid S7 persisted state"): never {
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
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return invalid();
  return value;
}

function opaque(value: unknown, max = 240): string {
  const result = text(value, max);
  if (Array.from(result).length > max || result.includes("\\") || result.includes("\r") || result.includes("\n")) return invalid();
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

function sourceStamp(value: unknown): S7SourceStamp {
  const item = record(value, SOURCE_KEYS);
  const result = {
    sourceRevisionId: uuid(item.sourceRevisionId),
    sourceRevisionHash: sha(item.sourceRevisionHash),
    sourceS5Fingerprint: sha(item.sourceS5Fingerprint),
    validationReceiptId: uuid(item.validationReceiptId),
    validationHash: sha(item.validationHash),
    s6HandoffSchemaVersion: enumValue(item.s6HandoffSchemaVersion, ["s6-to-s7-handoff-v1"]) as "s6-to-s7-handoff-v1",
    handoffDigest: sha(item.handoffDigest),
  } satisfies S7SourceStamp;
  return result;
}

export function sameS7Source(left: S7SourceStamp, right: S7SourceStamp): boolean {
  return left.sourceRevisionId === right.sourceRevisionId &&
    left.sourceRevisionHash === right.sourceRevisionHash &&
    left.sourceS5Fingerprint === right.sourceS5Fingerprint &&
    left.validationReceiptId === right.validationReceiptId &&
    left.validationHash === right.validationHash &&
    left.s6HandoffSchemaVersion === right.s6HandoffSchemaVersion &&
    left.handoffDigest === right.handoffDigest;
}

function privatePath(value: unknown): string {
  const result = text(value, 2048);
  try {
    privateStorageKey(...result.split("/"));
  } catch {
    return invalid();
  }
  return result;
}

export function s7FinalDxfStorageKey(projectId: string, artifactId: string): string {
  return privateStorageKey("projects", projectId, "s7", "exports", artifactId, S7_FIXED_DOWNLOAD_NAME);
}

export function s7StagingDxfStorageKey(projectId: string, jobId: string, claimToken: string): string {
  return privateStorageKey("projects", projectId, "s7", "staging", jobId, claimToken, S7_FIXED_DOWNLOAD_NAME);
}

export function s7FinalManifestStorageKey(projectId: string, manifestId: string): string {
  return privateStorageKey("projects", projectId, "s7", "manifests", `${manifestId}.json`);
}

export function s7StagingManifestStorageKey(projectId: string, jobId: string, claimToken: string): string {
  return privateStorageKey("projects", projectId, "s7", "staging", jobId, claimToken, "manifest.json");
}

function expectedStagingPath(projectId: string, jobId: string, path: string): boolean {
  const prefix = `projects/${projectId}/s7/staging/${jobId}/`;
  if (!path.startsWith(prefix)) return false;
  const suffix = path.slice(prefix.length);
  const parts = suffix.split("/");
  return parts.length === 2 && (parts[0] === "unclaimed" || uuidV4Pattern.test(parts[0]!)) && parts[1] === S7_FIXED_DOWNLOAD_NAME;
}

function validateExport(value: unknown): S7CadExport {
  const item = record(value, EXPORT_KEYS);
  const result = item as unknown as S7CadExport;
  enumValue(item.schemaVersion, [S7_EXPORT_VERSION]);
  uuid(item.artifactId); uuid(item.projectId); uuid(item.jobId); sourceStamp(item.source); sha(item.inputHash);
  enumValue(item.dxfVersion, [S7_DXF_VERSION]); enumValue(item.worldToPlanVersion, [S7_WORLD_TO_PLAN_VERSION]);
  enumValue(item.format, ["dxf"]); enumValue(item.mimeType, ["application/dxf"]); enumValue(item.downloadFileName, [S7_FIXED_DOWNLOAD_NAME]);
  const status = enumValue(item.status, EXPORT_STATUSES);
  const publicationPhase = enumValue(item.publicationPhase, PHASES);
  const attempt = integer(item.attempt, 1, S7_MAX_ATTEMPTS); if (attempt !== 1 && attempt !== 2) invalid();
  nullableUuid(item.retryOfArtifactId); uuid(item.manifestId); nullableSha(item.manifestHash); nullableUuid(item.readbackReceiptId); nullableSha(item.readbackHash); nullableSha(item.sha256);
  if (item.byteSize !== null) integer(item.byteSize, 1, S7_MAX_DXF_BYTES);
  const finalPath = privatePath(item.privateFinalStorageKey);
  if (finalPath !== s7FinalDxfStorageKey(result.projectId, result.artifactId)) invalid("S7_FINAL_PATH_INVALID");
  const stagingPath = privatePath(item.privateStagingStorageKey);
  if (!expectedStagingPath(result.projectId, result.jobId, stagingPath)) invalid("S7_STAGING_PATH_INVALID");
  nullableText(item.failureCode, 200);
  timestamp(item.createdAt); timestamp(item.updatedAt); nullableTimestamp(item.committedAt); nullableTimestamp(item.staleAt); nullableTimestamp(item.supersededAt);
  const allowedPhases: Readonly<Record<string, readonly string[]>> = {
    queued: ["none"], running: ["none"], staged: ["staged"], promoted: ["promoted"],
    committed: ["committed"], superseded: ["committed"], stale: ["none", "staged", "promoted"],
    failed_retryable: ["none", "staged", "promoted"], failed_terminal: ["aborted"], aborted: ["aborted"],
  };
  if (!allowedPhases[status]?.includes(publicationPhase)) invalid("S7_PUBLICATION_STATE_INVALID");
  if (status === "committed" || status === "superseded") {
    if (item.publicationPhase !== "committed" || item.manifestHash === null || item.readbackReceiptId === null || item.readbackHash === null || item.sha256 === null || item.byteSize === null || item.committedAt === null) invalid("S7_COMMIT_STATE_INVALID");
  } else if (item.committedAt !== null) invalid("S7_COMMIT_STATE_INVALID");
  if (status !== "stale" && item.staleAt !== null) invalid("S7_STALE_STATE_INVALID");
  if (status !== "superseded" && item.supersededAt !== null) invalid("S7_SUPERSESSION_STATE_INVALID");
  if (status === "failed_retryable" && item.attempt !== 1) invalid("S7_RETRY_CHAIN_INVALID");
  if (status === "failed_terminal" && item.attempt !== 2) invalid("S7_RETRY_CHAIN_INVALID");
  if (status === "superseded" && item.supersededAt === null) invalid("S7_SUPERSESSION_STATE_INVALID");
  if (status === "stale" && item.staleAt === null) invalid("S7_STALE_STATE_INVALID");
  return result;
}

function validateJob(value: unknown): S7CadJob {
  const item = record(value, JOB_KEYS);
  const result = item as unknown as S7CadJob;
  enumValue(item.schemaVersion, [S7_JOB_VERSION]); uuid(item.jobId); uuid(item.projectId); uuid(item.artifactId); sourceStamp(item.source); sha(item.inputHash); opaque(item.idempotencyKey);
  const status = enumValue(item.status, EXPORT_STATUSES); const attempt = integer(item.attempt, 1, S7_MAX_ATTEMPTS); if (attempt !== 1 && attempt !== 2) invalid();
  nullableUuid(item.retryOfJobId); nullableUuid(item.claimToken); nullableText(item.ownerProcessId, 240); nullableTimestamp(item.claimedAt); nullableTimestamp(item.heartbeatAt); timestamp(item.createdAt); timestamp(item.updatedAt); nullableTimestamp(item.terminalAt);
  const claimFields = [item.claimToken, item.ownerProcessId, item.claimedAt, item.heartbeatAt];
  if (claimFields.some((field) => field === null) && claimFields.some((field) => field !== null)) invalid("S7_CLAIM_STATE_INVALID");
  const active = ["running", "staged", "promoted"].includes(status);
  if (active !== claimFields.every((field) => field !== null)) invalid("S7_CLAIM_STATE_INVALID");
  const terminal = ["committed", "stale", "superseded", "failed_terminal", "aborted"].includes(status);
  if (terminal !== (item.terminalAt !== null)) invalid("S7_TERMINAL_STATE_INVALID");
  if (status === "failed_retryable" && attempt !== 1) invalid("S7_RETRY_CHAIN_INVALID");
  if (status === "failed_terminal" && attempt !== 2) invalid("S7_RETRY_CHAIN_INVALID");
  return result;
}

function validateIdempotency(value: unknown): S7CadIdempotency {
  const item = record(value, IDEMPOTENCY_KEYS);
  const result = item as unknown as S7CadIdempotency;
  enumValue(item.schemaVersion, [S7_IDEMPOTENCY_VERSION]); uuid(item.projectId); enumValue(item.operation, ["export"]); opaque(item.idempotencyKey); sha(item.inputHash); sourceStamp(item.source); uuid(item.jobId); uuid(item.artifactId); timestamp(item.createdAt);
  return result;
}

function validateManifest(value: unknown): S7CadManifestRecord {
  const item = record(value, MANIFEST_KEYS);
  const result = item as unknown as S7CadManifestRecord;
  enumValue(item.schemaVersion, [S7_MANIFEST_VERSION]); uuid(item.manifestId); uuid(item.projectId); uuid(item.artifactId); sourceStamp(item.source); enumValue(item.worldToPlanVersion, [S7_WORLD_TO_PLAN_VERSION]); enumValue(item.dxfVersion, [S7_DXF_VERSION]); sha(item.manifestHash); integer(item.manifestByteSize, 1, S7_MAX_MANIFEST_BYTES); privatePath(item.privateManifestStorageKey);
  if (item.privateManifestStorageKey !== s7FinalManifestStorageKey(result.projectId, result.manifestId)) invalid("S7_MANIFEST_PATH_INVALID");
  return result;
}

export function hashS7ReadbackReceipt(receipt: S7CadReadbackReceipt): string {
  return sha256(jcs({ ...receipt, receiptHash: "" }));
}

function validateReceipt(value: unknown): S7CadReadbackReceipt {
  const item = record(value, RECEIPT_KEYS);
  const result = item as unknown as S7CadReadbackReceipt;
  enumValue(item.schemaVersion, [S7_RECEIPT_VERSION]); uuid(item.receiptId); uuid(item.projectId); uuid(item.artifactId); sourceStamp(item.source); uuid(item.manifestId); sha(item.manifestHash); enumValue(item.worldToPlanVersion, [S7_WORLD_TO_PLAN_VERSION]); enumValue(item.dxfVersion, [S7_DXF_VERSION]); sha(item.sha256); integer(item.byteSize, 1, S7_MAX_DXF_BYTES); integer(item.entityCount, 0, S7_MAX_ENTITIES); enumValue(item.correspondenceResult, ["pass", "fail"]); enumValue(item.outcome, ["pass", "fail"]); const issues = array(item.issues); if (issues.length > 128) invalid(); issues.forEach((issue) => text(issue, 400, true)); timestamp(item.checkedAt); sha(item.receiptHash); enumValue(item.readbackVersion, [S7_READBACK_VERSION]);
  if (hashS7ReadbackReceipt(result) !== result.receiptHash) invalid("S7_RECEIPT_HASH_MISMATCH");
  if (Buffer.byteLength(jcs(result), "utf8") > S7_MAX_RECEIPT_BYTES) invalid("S7_RESOURCE_LIMIT");
  if (result.outcome === "pass" && (result.correspondenceResult !== "pass" || result.issues.length > 0)) invalid("S7_RECEIPT_OUTCOME_INVALID");
  return result;
}

function collections(state: StoreState): { exports: S7CadExport[]; jobs: S7CadJob[]; idempotency: S7CadIdempotency[]; manifests: S7CadManifestRecord[]; receipts: S7CadReadbackReceipt[] } {
  return {
    exports: state.s7CadExports ?? [],
    jobs: state.s7CadJobs ?? [],
    idempotency: state.s7CadIdempotency ?? [],
    manifests: state.s7CadManifests ?? [],
    receipts: state.s7CadReadbackReceipts ?? [],
  };
}

export function getS7Collections(state: StoreState): ReturnType<typeof collections> {
  return collections(state);
}

export function validateS7Collections(parsedRecord: unknown, state: StoreState): void {
  if (typeof parsedRecord !== "object" || parsedRecord === null || Array.isArray(parsedRecord)) return invalid();
  const parsed = parsedRecord as RecordValue;
  const fields: Array<[keyof StoreState, (value: unknown) => unknown]> = [
    ["s7CadExports", validateExport],
    ["s7CadJobs", validateJob],
    ["s7CadIdempotency", validateIdempotency],
    ["s7CadManifests", validateManifest],
    ["s7CadReadbackReceipts", validateReceipt],
  ];
  for (const [field, validator] of fields) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
    const values = array(parsed[field]);
    for (const value of values) validator(value);
  }
  void state;
}

function unique<T>(values: readonly T[], getId: (value: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    const id = getId(value);
    if (map.has(id)) invalid("S7_DUPLICATE_ID");
    map.set(id, value);
  }
  return map;
}

function validateRetryChains(exports: readonly S7CadExport[], jobs: readonly S7CadJob[]): void {
  const jobById = new Map(jobs.map((item) => [item.jobId, item]));
  const exportGroups = new Map<string, S7CadExport[]>();
  for (const item of exports) {
    const job = jobById.get(item.jobId);
    if (!job) invalid("S7_RETRY_CHAIN_INVALID");
    const key = `${item.projectId}:${item.source.sourceRevisionId}:${item.inputHash}:${job.idempotencyKey}`;
    const group = exportGroups.get(key) ?? []; group.push(item); exportGroups.set(key, group);
  }
  for (const group of exportGroups.values()) {
    group.sort((left, right) => left.attempt - right.attempt);
    if (group.length > S7_MAX_ATTEMPTS || group.some((item, index) => item.attempt !== index + 1)) invalid("S7_RETRY_CHAIN_INVALID");
    if (group[0]!.retryOfArtifactId !== null) invalid("S7_RETRY_CHAIN_INVALID");
    if (group.length === 2 && (group[1]!.retryOfArtifactId !== group[0]!.artifactId || group[1]!.jobId === group[0]!.jobId)) invalid("S7_RETRY_CHAIN_INVALID");
  }
  const jobGroups = new Map<string, S7CadJob[]>();
  for (const item of jobs) {
    const key = `${item.projectId}:${item.source.sourceRevisionId}:${item.inputHash}:${item.idempotencyKey}`;
    const group = jobGroups.get(key) ?? []; group.push(item); jobGroups.set(key, group);
  }
  for (const group of jobGroups.values()) {
    group.sort((left, right) => left.attempt - right.attempt);
    if (group.length > S7_MAX_ATTEMPTS || group.some((item, index) => item.attempt !== index + 1)) invalid("S7_RETRY_CHAIN_INVALID");
    if (group[0]!.retryOfJobId !== null) invalid("S7_RETRY_CHAIN_INVALID");
    if (group.length === 2 && (group[1]!.retryOfJobId !== group[0]!.jobId || group[1]!.jobId === group[0]!.jobId)) invalid("S7_RETRY_CHAIN_INVALID");
  }
}

export function validateS7Graph(state: StoreState): void {
  const { exports, jobs, idempotency, manifests, receipts } = collections(state);
  if (exports.length > MAX_COLLECTION || jobs.length > MAX_COLLECTION || idempotency.length > MAX_COLLECTION || manifests.length > MAX_COLLECTION || receipts.length > MAX_COLLECTION) invalid("S7_RESOURCE_LIMIT");
  const exportById = unique(exports, (item) => item.artifactId);
  const jobById = unique(jobs, (item) => item.jobId);
  const manifestById = unique(manifests, (item) => item.manifestId);
  const receiptById = unique(receipts, (item) => item.receiptId);
  unique(receipts, (item) => item.artifactId);
  const claimTokens = new Set<string>();
  const idempotencyByKey = new Map<string, S7CadIdempotency>();
  for (const item of idempotency) {
    const key = `${item.projectId}:${item.operation}:${item.idempotencyKey}`;
    if (idempotencyByKey.has(key)) invalid("S7_IDEMPOTENCY_KEY_REUSED");
    idempotencyByKey.set(key, item);
    const job = jobById.get(item.jobId); const artifact = exportById.get(item.artifactId);
    if (!job || !artifact || job.projectId !== item.projectId || artifact.projectId !== item.projectId || job.artifactId !== artifact.artifactId || job.inputHash !== item.inputHash || artifact.inputHash !== item.inputHash || !sameS7Source(job.source, item.source) || !sameS7Source(artifact.source, item.source) || job.idempotencyKey !== item.idempotencyKey) invalid("S7_IDEMPOTENCY_LINK_INVALID");
  }
  for (const artifact of exports) {
    const job = jobById.get(artifact.jobId);
    if (!job || job.projectId !== artifact.projectId || job.artifactId !== artifact.artifactId || job.status !== artifact.status || job.attempt !== artifact.attempt || !sameS7Source(job.source, artifact.source)) invalid("S7_ARTIFACT_REFERENCE_INVALID");
    if ((artifact.readbackReceiptId === null) !== (artifact.readbackHash === null)) invalid("S7_RECEIPT_REFERENCE_INVALID");
    if ((artifact.sha256 === null) !== (artifact.byteSize === null)) invalid("S7_ARTIFACT_REFERENCE_INVALID");
    if (artifact.readbackReceiptId !== null && artifact.status !== "committed" && artifact.status !== "superseded") invalid("S7_RECEIPT_REFERENCE_INVALID");
    if (!idempotencyByKey.has(`${artifact.projectId}:export:${job.idempotencyKey}`)) invalid("S7_IDEMPOTENCY_LINK_INVALID");
    if (artifact.manifestHash !== null) {
      const manifest = manifestById.get(artifact.manifestId);
      if (!manifest || manifest.projectId !== artifact.projectId || manifest.artifactId !== artifact.artifactId || manifest.manifestHash !== artifact.manifestHash || !sameS7Source(manifest.source, artifact.source)) invalid("S7_MANIFEST_REFERENCE_INVALID");
    }
    if (artifact.readbackReceiptId !== null) {
      const receipt = receiptById.get(artifact.readbackReceiptId);
      if (!receipt || receipt.receiptId !== artifact.readbackReceiptId || receipt.receiptHash !== artifact.readbackHash || receipt.projectId !== artifact.projectId || receipt.artifactId !== artifact.artifactId || receipt.manifestId !== artifact.manifestId || receipt.manifestHash !== artifact.manifestHash || receipt.sha256 !== artifact.sha256 || receipt.byteSize !== artifact.byteSize || receipt.readbackVersion !== S7_READBACK_VERSION || !sameS7Source(receipt.source, artifact.source) || receipt.outcome !== "pass" || receipt.correspondenceResult !== "pass" || receipt.issues.length !== 0) invalid("S7_RECEIPT_REFERENCE_INVALID");
    }
    if (artifact.status === "committed" && (artifact.readbackReceiptId === null || artifact.manifestHash === null || artifact.sha256 === null || artifact.byteSize === null)) invalid("S7_COMMIT_REFERENCE_INVALID");
  }
  for (const job of jobs) {
    if (job.claimToken !== null && claimTokens.has(job.claimToken)) invalid("S7_CLAIM_STATE_INVALID");
    if (job.claimToken !== null) claimTokens.add(job.claimToken);
    const artifact = exportById.get(job.artifactId);
    if (!artifact || artifact.jobId !== job.jobId || artifact.projectId !== job.projectId || !sameS7Source(artifact.source, job.source)) invalid("S7_JOB_REFERENCE_INVALID");
  }
  for (const manifest of manifests) {
    const artifact = exportById.get(manifest.artifactId);
    if (!artifact || artifact.manifestId !== manifest.manifestId || artifact.projectId !== manifest.projectId || artifact.manifestHash !== manifest.manifestHash || !sameS7Source(artifact.source, manifest.source)) invalid("S7_MANIFEST_REFERENCE_INVALID");
  }
  for (const receipt of receipts) {
    const artifact = exportById.get(receipt.artifactId);
    if (!artifact || artifact.manifestId !== receipt.manifestId || artifact.projectId !== receipt.projectId || artifact.manifestHash !== receipt.manifestHash || artifact.sha256 !== receipt.sha256 || artifact.byteSize !== receipt.byteSize || !sameS7Source(artifact.source, receipt.source)) invalid("S7_RECEIPT_REFERENCE_INVALID");
  }
  validateRetryChains(exports, jobs);
}

const MAX_COLLECTION = 16_384;
