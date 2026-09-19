import { AppError, type S8Artifact, type S8ExportJob, type S8IdempotencyRecord, type S8PublicationPhase, type S8SourceStamp, type S8ValidationReceipt, type StoreState } from "./types";
import { jcs, sha256, uuidV4Pattern } from "./utils";
import { S8_FBX_PROFILE, S8_LIMITS, S8_PROTOCOL_VERSION, S8_REUSE_FINGERPRINT_VERSION } from "./s8-fbx-profile";

export const S8_HEARTBEAT_MS = 30_000;
export const S8_STALE_CLAIM_MS = 120_000;
export const S8_OBJECT_NAMES = [
  "artifact.fbx",
  "writer-receipt.json",
  "native-readback.json",
  "semantic-validation-receipt.json",
  "publication-receipt.json",
] as const;

export type S8ClaimOwnerState = "live" | "dead" | "unknown";

export type S8PublicationRecord = {
  projectId: string;
  artifactId: string;
  sourceRevisionId: string;
  sourceRevisionHash: string;
  claimToken: string;
  ownerId: string;
  phase: S8PublicationPhase;
  heartbeatAtMs: number;
  stagingKey: string;
  finalKey: string;
  artifactSha256: string | null;
  validatorReceiptHash: string | null;
  committedAtMs: number | null;
  failureCode: string | null;
};

function fail(code: string, status = 409): never {
  throw new AppError(status, code, [{ field: "publication", code }]);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) fail(code, 500);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("S8_PERSISTENCE_INVALID", 500);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail("S8_PERSISTENCE_INVALID", 500);
  return value;
}

function requiredSha(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail("S8_PERSISTENCE_INVALID", 500);
}

function requiredUuid(value: unknown): void {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) fail("S8_PERSISTENCE_INVALID", 500);
}

function requiredTimestamp(value: unknown): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail("S8_PERSISTENCE_INVALID", 500);
}

export function sameS8Source(left: S8SourceStamp, right: S8SourceStamp): boolean {
  return jcs(left) === jcs(right);
}

export function s8SourceStampHash(source: S8SourceStamp): string {
  return sha256(jcs(source));
}

export function s8ResourceLimitsHash(limits: unknown): string {
  return sha256(jcs(limits));
}

export function s8StagingPrefix(projectId: string, artifactId: string, claimToken: string): string {
  return `private/projects/${projectId}/s8/staging/${artifactId}/${claimToken}`;
}

export function s8FinalPrefix(projectId: string, sourceRevisionHash: string, artifactSha256: string): string {
  return `private/projects/${projectId}/s8/committed/${sourceRevisionHash}/${artifactSha256}`;
}

export function s8StagingKey(projectId: string, artifactId: string, claimToken: string, objectName = "artifact.fbx"): string {
  return `${s8StagingPrefix(projectId, artifactId, claimToken)}/${objectName}`;
}

export function s8FinalKey(projectId: string, sourceRevisionHash: string, artifactSha256: string, objectName = "artifact.fbx"): string {
  return `${s8FinalPrefix(projectId, sourceRevisionHash, artifactSha256)}/${objectName}`;
}

export function s8ObjectKey(prefix: string, objectName: (typeof S8_OBJECT_NAMES)[number]): string {
  return `${prefix}/${objectName}`;
}

export function getS8Collections(state: StoreState): {
  jobs: S8ExportJob[];
  artifacts: S8Artifact[];
  receipts: S8ValidationReceipt[];
  idempotency: S8IdempotencyRecord[];
} {
  return {
    jobs: state.s8ExportJobs ?? [],
    artifacts: state.s8Artifacts ?? [],
    receipts: state.s8ValidationReceipts ?? [],
    idempotency: state.s8IdempotencyRecords ?? [],
  };
}

function validateSource(value: unknown): void {
  const item = record(value);
  exactKeys(item, ["projectId", "sourceRevisionId", "sourceRevisionHash", "sourceS5Fingerprint", "s6ValidationReceiptId", "s6ValidationHash", "s6HandoffDigest", "s7ArtifactId", "s7ArtifactHash", "s7ReadbackHash", "s7ManifestId", "s7ManifestHash", "s8Profile", "s8ProtocolVersion"], "S8_PERSISTENCE_INVALID");
  for (const key of ["projectId", "sourceRevisionId", "s6ValidationReceiptId", "s7ArtifactId", "s7ManifestId"]) requiredUuid(item[key]);
  for (const key of ["sourceRevisionHash", "sourceS5Fingerprint", "s6ValidationHash", "s6HandoffDigest", "s7ArtifactHash", "s7ReadbackHash", "s7ManifestHash"]) requiredSha(item[key]);
  if (item.s8Profile !== S8_FBX_PROFILE || item.s8ProtocolVersion !== S8_PROTOCOL_VERSION) fail("S8_PERSISTENCE_INVALID", 500);
}

function validateJob(value: unknown): void {
  const item = record(value);
  exactKeys(item, ["schemaVersion", "jobId", "projectId", "artifactId", "source", "inputHash", "idempotencyKey", "status", "publicationPhase", "attempt", "claimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt", "createdAt", "updatedAt", "terminalAt", "failureCode"], "S8_PERSISTENCE_INVALID");
  if (item.schemaVersion !== "s8-export-job-v2") fail("S8_PERSISTENCE_INVALID", 500);
  requiredUuid(item.jobId); requiredUuid(item.projectId); requiredUuid(item.artifactId); validateSource(item.source); requiredSha(item.inputHash); requiredString(item.idempotencyKey, 240);
  if (!["queued", "running", "staged", "validated", "promoted", "committed", "stale", "failed_retryable", "failed_terminal", "aborted"].includes(String(item.status))) fail("S8_PERSISTENCE_INVALID", 500);
  if (!["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"].includes(String(item.publicationPhase))) fail("S8_PERSISTENCE_INVALID", 500);
  if (item.attempt !== 1) fail("S8_PERSISTENCE_INVALID", 500);
  if (item.claimToken !== null) requiredUuid(item.claimToken);
  if (item.ownerId !== null) requiredString(item.ownerId, 240);
  if (item.ownerProcessId !== null && (!Number.isSafeInteger(item.ownerProcessId) || Number(item.ownerProcessId) <= 0)) fail("S8_PERSISTENCE_INVALID", 500);
  for (const key of ["claimedAt", "heartbeatAt", "terminalAt"]) if (item[key] !== null) requiredTimestamp(item[key]);
  requiredTimestamp(item.createdAt); requiredTimestamp(item.updatedAt);
  if (item.failureCode !== null) requiredString(item.failureCode, 240);
}

function validateArtifact(value: unknown): void {
  const item = record(value);
  exactKeys(item, ["schemaVersion", "artifactId", "projectId", "jobId", "source", "inputHash", "profile", "format", "mimeType", "downloadFileName", "status", "publicationPhase", "payloadSha256", "objectHashes", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "publicationReceiptHash", "validationReceiptId", "validationReceiptHash", "immutableReuseFingerprint", "privateStagingPrefix", "privateFinalPrefix", "attempt", "retryOfArtifactId", "failureCode", "createdAt", "updatedAt", "committedAt", "staleAt"], "S8_PERSISTENCE_INVALID");
  if (item.schemaVersion !== "s8-artifact-v2" || item.profile !== S8_FBX_PROFILE || item.format !== "fbx" || item.mimeType !== "application/octet-stream" || item.downloadFileName !== "swooshz-s8-scene.fbx") fail("S8_PERSISTENCE_INVALID", 500);
  requiredUuid(item.artifactId); requiredUuid(item.projectId); requiredUuid(item.jobId); validateSource(item.source); requiredSha(item.inputHash);
  if (!["queued", "running", "staged", "validated", "promoted", "committed", "stale", "failed_retryable", "failed_terminal", "aborted"].includes(String(item.status))) fail("S8_PERSISTENCE_INVALID", 500);
  if (!["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"].includes(String(item.publicationPhase))) fail("S8_PERSISTENCE_INVALID", 500);
  for (const key of ["payloadSha256", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "publicationReceiptHash", "validationReceiptHash", "immutableReuseFingerprint"]) if (item[key] !== null) requiredSha(item[key]);
  if (item.validationReceiptId !== null) requiredUuid(item.validationReceiptId);
  if (item.objectHashes !== null) {
    const hashes = record(item.objectHashes);
    exactKeys(hashes, ["artifactSha256", "artifactByteSize", "writerReceiptSha256", "nativeReadbackSha256", "semanticReceiptSha256", "publicationReceiptSha256"], "S8_PERSISTENCE_INVALID");
    requiredSha(hashes.artifactSha256); requiredSha(hashes.writerReceiptSha256); requiredSha(hashes.nativeReadbackSha256); requiredSha(hashes.semanticReceiptSha256); requiredSha(hashes.publicationReceiptSha256);
    if (!Number.isSafeInteger(hashes.artifactByteSize) || Number(hashes.artifactByteSize) <= 27 || Number(hashes.artifactByteSize) > S8_LIMITS.artifactBytes) fail("S8_PERSISTENCE_INVALID", 500);
  }
  requiredString(item.privateStagingPrefix, 2000); requiredString(item.privateFinalPrefix, 2000);
  if (item.attempt !== 1 || item.retryOfArtifactId !== null) fail("S8_PERSISTENCE_INVALID", 500);
  requiredTimestamp(item.createdAt); requiredTimestamp(item.updatedAt); if (item.committedAt !== null) requiredTimestamp(item.committedAt); if (item.staleAt !== null) requiredTimestamp(item.staleAt);
  if (item.failureCode !== null) requiredString(item.failureCode, 240);
}

function validateReceipt(value: unknown): void {
  const item = record(value);
  exactKeys(item, ["schemaVersion", "receiptId", "projectId", "artifactId", "source", "payloadSha256", "artifactSha256", "artifactByteSize", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "nativeOutcome", "semanticOutcome", "fingerprintVersion", "immutableReuseFingerprint", "resourceLimitsHash", "checkedAt", "receiptHash"], "S8_PERSISTENCE_INVALID");
  if (item.schemaVersion !== "s8-validation-receipt-v2" || item.nativeOutcome !== "pass" || item.semanticOutcome !== "pass" || item.fingerprintVersion !== S8_REUSE_FINGERPRINT_VERSION) fail("S8_PERSISTENCE_INVALID", 500);
  requiredUuid(item.receiptId); requiredUuid(item.projectId); requiredUuid(item.artifactId); validateSource(item.source);
  for (const key of ["payloadSha256", "artifactSha256", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "immutableReuseFingerprint", "resourceLimitsHash", "receiptHash"]) requiredSha(item[key]);
  if (!Number.isSafeInteger(item.artifactByteSize) || Number(item.artifactByteSize) <= 27 || Number(item.artifactByteSize) > S8_LIMITS.artifactBytes) fail("S8_PERSISTENCE_INVALID", 500);
  requiredTimestamp(item.checkedAt);
}

function validateIdempotency(value: unknown): void {
  const item = record(value);
  exactKeys(item, ["schemaVersion", "projectId", "operation", "idempotencyKey", "inputHash", "source", "jobId", "artifactId", "createdAt"], "S8_PERSISTENCE_INVALID");
  if (item.schemaVersion !== "s8-idempotency-v2" || item.operation !== "export") fail("S8_PERSISTENCE_INVALID", 500);
  requiredUuid(item.projectId); requiredString(item.idempotencyKey, 240); requiredSha(item.inputHash); validateSource(item.source); requiredUuid(item.jobId); requiredUuid(item.artifactId); requiredTimestamp(item.createdAt);
}

export function validateS8Collections(parsed: Record<string, unknown>, merged: StoreState): void {
  const validators: Readonly<Record<string, (value: unknown) => void>> = { s8ExportJobs: validateJob, s8Artifacts: validateArtifact, s8ValidationReceipts: validateReceipt, s8IdempotencyRecords: validateIdempotency };
  for (const [name, validate] of Object.entries(validators)) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      const values = parsed[name];
      if (!Array.isArray(values)) fail("S8_PERSISTENCE_INVALID", 500);
      values.forEach(validate);
    }
    if (!Array.isArray(merged[name as keyof StoreState])) fail("S8_PERSISTENCE_INVALID", 500);
  }
}

export function validateS8Graph(state: StoreState): void {
  const collections = getS8Collections(state);
  const jobs = new Map(collections.jobs.map((item) => [item.jobId, item]));
  const artifacts = new Map(collections.artifacts.map((item) => [item.artifactId, item]));
  const receipts = new Map(collections.receipts.map((item) => [item.receiptId, item]));
  const idempotency = new Set<string>();
  if (jobs.size !== collections.jobs.length || artifacts.size !== collections.artifacts.length || receipts.size !== collections.receipts.length) fail("S8_PERSISTENCE_INVALID", 500);
  for (const job of collections.jobs) {
    const artifact = artifacts.get(job.artifactId);
    if (!artifact || artifact.jobId !== job.jobId || artifact.projectId !== job.projectId || !sameS8Source(job.source, artifact.source) || artifact.status !== job.status) fail("S8_PERSISTENCE_INVALID", 500);
  }
  for (const artifact of collections.artifacts) if (artifact.validationReceiptId !== null) {
    const receipt = receipts.get(artifact.validationReceiptId);
    if (!receipt || receipt.artifactId !== artifact.artifactId || receipt.projectId !== artifact.projectId || receipt.receiptHash !== artifact.validationReceiptHash) fail("S8_PERSISTENCE_INVALID", 500);
  }
  for (const item of collections.idempotency) {
    const key = `${item.projectId}\u0000${item.idempotencyKey}`;
    if (idempotency.has(key) || !jobs.has(item.jobId) || !artifacts.has(item.artifactId)) fail("S8_PERSISTENCE_INVALID", 500);
    idempotency.add(key);
  }
}

export function assertS8ClaimOwned(record: S8PublicationRecord, claimToken: string, ownerId: string): void {
  if (record.claimToken !== claimToken || record.ownerId !== ownerId || record.failureCode !== null || record.committedAtMs !== null) fail("S8_CLAIM_FENCED");
}

export function advanceS8Publication(record: S8PublicationRecord, claimToken: string, ownerId: string, next: S8PublicationPhase, nowMs: number): S8PublicationRecord {
  assertS8ClaimOwned(record, claimToken, ownerId);
  const order: S8PublicationPhase[] = ["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"];
  if (order.indexOf(next) !== order.indexOf(record.phase) + 1) fail("S8_PUBLICATION_PHASE_INVALID");
  return { ...record, phase: next, heartbeatAtMs: nowMs, committedAtMs: next === "commit" ? nowMs : null };
}

export function assertS8SourceFence(record: S8PublicationRecord, currentRevisionId: string, currentRevisionHash: string): void {
  if (record.sourceRevisionId !== currentRevisionId || record.sourceRevisionHash !== currentRevisionHash) fail("S8_SOURCE_STALE");
}

export function mayReclaimS8Claim(record: S8PublicationRecord, nowMs: number, ownerState: S8ClaimOwnerState): boolean {
  if (nowMs - record.heartbeatAtMs <= S8_STALE_CLAIM_MS) return false;
  if (ownerState === "live" || ownerState === "unknown") fail("S8_CONTROLLER_REQUIRED");
  return true;
}

export function reuseCommittedS8Artifact(record: S8PublicationRecord, projectId: string, sourceRevisionId: string, sourceRevisionHash: string): S8PublicationRecord {
  if (record.projectId !== projectId) fail("S8_UNAUTHORIZED_OR_NOT_FOUND");
  if (record.phase !== "commit" || record.committedAtMs === null || !record.artifactSha256 || !record.validatorReceiptHash) fail("S8_ARTIFACT_NOT_COMMITTED");
  if (record.sourceRevisionId !== sourceRevisionId || record.sourceRevisionHash !== sourceRevisionHash) fail("S8_SOURCE_STALE");
  return { ...record };
}
