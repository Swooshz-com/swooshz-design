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

export function validateS8Collections(parsed: Record<string, unknown>, merged: StoreState): void {
  const names = [
    "s8ExportJobs", "s8Artifacts", "s8ValidationReceipts", "s8ValidationReceiptBytes", "s8IdempotencyRecords",
    "s8NativeOperationAttempts", "s8NativeProofCheckpoints", "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines",
  ] as const;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(parsed, name) && !Array.isArray(parsed[name])) fail("S8_PERSISTENCE_INVALID", 500);
    if (!Array.isArray(merged[name as keyof StoreState])) fail("S8_PERSISTENCE_INVALID", 500);
  }
}

export function validateS8Graph(_state: StoreState): never {
  fail("S8_PROOF_REQUIRED", 500);
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
