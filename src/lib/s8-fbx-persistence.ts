import { AppError } from "./types";

export type S8PublicationPhase = "source_admission" | "claim" | "private_staging" | "independent_validation" | "source_claim_recheck" | "immutable_promotion" | "commit";
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

export const S8_HEARTBEAT_MS = 30_000;
export const S8_STALE_CLAIM_MS = 120_000;

function fail(code: string): never {
  throw new AppError(409, code, [{ field: "publication", code }]);
}

export function s8StagingKey(projectId: string, artifactId: string, claimToken: string): string {
  return `private/projects/${projectId}/s8/staging/${artifactId}/${claimToken}/artifact.fbx`;
}

export function s8FinalKey(projectId: string, sourceRevisionHash: string, artifactSha256: string): string {
  return `private/projects/${projectId}/s8/committed/${sourceRevisionHash}/${artifactSha256}/artifact.fbx`;
}

export function assertS8ClaimOwned(record: S8PublicationRecord, claimToken: string, ownerId: string): void {
  if (record.claimToken !== claimToken || record.ownerId !== ownerId || record.failureCode !== null || record.committedAtMs !== null) fail("S8_CLAIM_FENCED");
}

export function advanceS8Publication(record: S8PublicationRecord, claimToken: string, ownerId: string, next: S8PublicationPhase, nowMs: number): S8PublicationRecord {
  assertS8ClaimOwned(record, claimToken, ownerId);
  const order: S8PublicationPhase[] = ["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "commit"];
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
