import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { flockSync } from "fs-ext-extra-prebuilt";
import { AppError, type StoreState } from "./types";
import { codePointLength, uuidV4Pattern } from "./utils";
import { validateS2Graph } from "./s2-persistence";
import { validateS3Collections, validateS3Graph } from "./s3-persistence";
import { validateS4Collections, validateS4Graph } from "./s4-persistence";

const LOCK_WAIT_MS = 15_000;
const LOCK_PROTOCOL = "swooshz-repository-lock-v2" as const;

const MUTEX_FLAGS = "exnb" as const;
export type RepositoryLockRecord = {
  protocol?: typeof LOCK_PROTOCOL;
  ownerToken: string;
  processId: number;
  acquiredAt: number;
};

export type RepositoryLockPhase =
  | "candidate-created"
  | "owner-data-before-write"
  | "owner-data-partial"
  | "owner-data-complete"
  | "owner-data-fsynced"
  | "before-canonical-claim"
  | "canonical-claiming"
  | "canonical-claimed"
  | "before-acquisition-return"
  | "before-malformed-recovery"
  | "before-dead-owner-recovery"
  | "before-canonical-release";


type FileMutexLease = {
  release: () => void;
};
type RepositoryLock = {
  candidatePath: string;
  record: RepositoryLockRecord;
  mutex: FileMutexLease;
};

type ProcessLiveness = (processId: number) => boolean;
type LockPhaseHook = (
  phase: RepositoryLockPhase,
  record: RepositoryLockRecord,
  path: string,
) => void;

class LockHookError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("simulated repository lock interruption");
    this.original = original;
  }
}

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function emptyStoreState(): StoreState {
  return {
    projects: [],
    briefAssets: [],
    drafts: [],
    briefVersions: [],
    generationRequests: [],
    generationSets: [],
    prompts: [],
    conceptAssets: [],
    candidates: [],
    idempotency: [],
    extractionAttempts: {},
    extractionOperations: [],
    generationOperations: [],
    s2Assets: [],
    s2Drafts: [],
    s2Inputs: [],
    s2QaRuns: [],
    s2Repairs: [],
    s2DerivedCandidates: [],
    s2ReQaResults: [],
    s2Operations: [],
    s2Publications: [],
    s2Transitions: [],
    s3Sources: [],
    s3Selections: [],
    s3SelectionEvents: [],
    s3Revisions: [],
    s3Assets: [],
    s3Cycles: [],
    s3ImageOperations: [],
    s3Assessments: [],
    s3AssessmentAttempts: [],
    s3Publications: [],
    s3Transitions: [],
    s4Stages: [],
    s4Masks: [],
    s4Edits: [],
    s4Revisions: [],
    s4Assets: [],
    s4ImageOperations: [],
    s4PreservationChecks: [],
    s4Assessments: [],
    s4AssessmentAttempts: [],
    s4Publications: [],
    s4Transitions: [],
  };
}

type PersistedRecord = Record<string, unknown>;
const PERSISTED_SHA256 = /^[0-9a-f]{64}$/;
const PERSISTED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidS2State(): never {
  throw new Error("invalid S2 persisted state");
}

function persistedRecord(value: unknown, keys: readonly string[]): PersistedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value as object).length !== keys.length ||
      Object.keys(value as object).some((key) => !keys.includes(key))) {
    return invalidS2State();
  }
  return value as PersistedRecord;
}

function persistedArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidS2State();
  return value;
}

function persistedString(value: unknown, maxLength = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    return invalidS2State();
  }
  return value;
}

function persistedCodePointString(value: unknown, maxLength = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || codePointLength(value) > maxLength) {
    return invalidS2State();
  }
  return value;
}

function persistedUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) return invalidS2State();
  return value;
}

function persistedSha(value: unknown): string {
  if (typeof value !== "string" || !PERSISTED_SHA256.test(value)) return invalidS2State();
  return value;
}

function persistedTimestamp(value: unknown): string {
  if (typeof value !== "string" || !PERSISTED_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    return invalidS2State();
  }
  return value;
}

function persistedNumber(value: unknown, minimum = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return invalidS2State();
  return value;
}

function persistedInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return invalidS2State();
  return value;
}

function persistedEnum(value: unknown, allowed: readonly string[]): string {
  const result = persistedString(value);
  if (!allowed.includes(result)) return invalidS2State();
  return result;
}

function persistedLiteral<T extends string | number>(value: unknown, allowed: readonly T[]): T {
  if ((typeof value !== "string" && typeof value !== "number") || !allowed.includes(value as T)) {
    return invalidS2State();
  }
  return value as T;
}

function persistedNullableUuid(value: unknown): void {
  if (value !== null) persistedUuid(value);
}

function persistedNullableTimestamp(value: unknown): void {
  if (value !== null) persistedTimestamp(value);
}

function persistedStringArray(value: unknown, maxLength = 4096): void {
  for (const item of persistedArray(value)) persistedString(item, maxLength);
}

function persistedUuidArray(value: unknown): void {
  for (const item of persistedArray(value)) persistedUuid(item);
}

function validateS2Geometry(value: unknown): void {
  const record = persistedRecord(value, ["widthMm", "depthMm", "openSides", "maxHeightMm"]);
  persistedInteger(record.widthMm, 1);
  persistedInteger(record.depthMm, 1);
  const sides = persistedArray(record.openSides);
  const seen = new Set<string>();
  for (const side of sides) {
    const value = persistedEnum(side, ["north", "east", "south", "west"]);
    if (seen.has(value)) invalidS2State();
    seen.add(value);
  }
  if (record.maxHeightMm !== null) persistedInteger(record.maxHeightMm, 1);
}

function validateS2Requirement(value: unknown): void {
  const record = persistedRecord(value, [
    "requirementId", "category", "expected", "expectedCount", "expectedValue",
    "criticality", "source", "text",
  ]);
  persistedString(record.requirementId, 200);
  persistedEnum(record.category, ["geometry", "functional", "mandatory", "prohibited", "free_text"]);
  persistedEnum(record.expected, ["present", "absent", "exact_count"]);
  if (record.expectedCount !== null) persistedInteger(record.expectedCount, 0);
  if (record.expectedValue !== null &&
      typeof record.expectedValue !== "string" &&
      typeof record.expectedValue !== "number" &&
      typeof record.expectedValue !== "boolean") invalidS2State();
  if (typeof record.expectedValue === "number" && !Number.isFinite(record.expectedValue)) invalidS2State();
  persistedEnum(record.criticality, ["material", "warning"]);
  persistedEnum(record.source, ["confirmed_brief", "geometry_snapshot"]);
  persistedString(record.text, 1000, true);
}

function validateS2DesignRule(value: unknown): void {
  const record = persistedRecord(value, ["ruleId", "applicability", "materiality", "repairable"]);
  persistedString(record.ruleId, 200);
  persistedEnum(record.applicability, ["applicable", "not_applicable"]);
  persistedEnum(record.materiality, ["material", "warning"]);
  if (typeof record.repairable !== "boolean") invalidS2State();
}

function validateS2Source(value: unknown): void {
  const record = persistedRecord(value, [
    "candidateId", "candidateIndex", "sourceAssetId", "sourceStorageKey", "sourceSha256",
    "sourceByteSize", "sourceWidth", "sourceHeight", "sourcePixelCount", "sourceDecodedRgbaBytes",
  ]);
  persistedUuid(record.candidateId);
  persistedLiteral(record.candidateIndex, [1, 2, 3, 4]);
  persistedUuid(record.sourceAssetId);
  persistedString(record.sourceStorageKey, 1000);
  persistedSha(record.sourceSha256);
  persistedInteger(record.sourceByteSize, 1);
  persistedInteger(record.sourceWidth, 1);
  persistedInteger(record.sourceHeight, 1);
  persistedInteger(record.sourcePixelCount, 1);
  persistedInteger(record.sourceDecodedRgbaBytes, 1);
}

function validateS2RequirementObservation(value: unknown): void {
  const record = persistedRecord(value, [
    "requirementId", "expected", "expectedCount", "expectedValue", "observed",
    "observedCount", "confidence", "evidence",
  ]);
  persistedString(record.requirementId, 200);
  persistedEnum(record.expected, ["present", "absent", "exact_count"]);
  if (record.expectedCount !== null) persistedInteger(record.expectedCount, 0);
  if (record.expectedValue !== null &&
      typeof record.expectedValue !== "string" &&
      typeof record.expectedValue !== "number" &&
      typeof record.expectedValue !== "boolean") invalidS2State();
  if (typeof record.expectedValue === "number" && !Number.isFinite(record.expectedValue)) invalidS2State();
  persistedEnum(record.observed, ["present", "absent", "uncertain", "not_verifiable"]);
  if (record.observedCount !== null) persistedInteger(record.observedCount, 0);
  const confidence = persistedNumber(record.confidence, 0);
  if (confidence > 1) invalidS2State();
  persistedCodePointString(record.evidence, 400, true);
}

function validateS2DesignObservation(value: unknown): void {
  const record = persistedRecord(value, ["ruleId", "observed", "confidence", "evidence"]);
  persistedString(record.ruleId, 200);
  persistedEnum(record.observed, ["compliant", "non_compliant", "uncertain", "not_verifiable"]);
  const confidence = persistedNumber(record.confidence, 0);
  if (confidence > 1) invalidS2State();
  persistedCodePointString(record.evidence, 400, true);
}

const S2_QA_CANDIDATE_KEYS = [
  "id", "qaRunId", "inputVersionId", "candidateId", "candidateIndex", "attempt",
  "sourceAssetId", "sourceByteSize", "sourceSha256", "status", "verdict",
  "requirementObservations", "designObservations", "materialFindingIds",
  "warningFindingIds", "uncertainFindingIds", "providerRequestId", "repairAttemptId",
  "startedAt", "completedAt",
] as const;

function validateS2QaCandidate(value: unknown, reQa: boolean): void {
  const keys = reQa ? [...S2_QA_CANDIDATE_KEYS, "phase", "derivedCandidateId"] : S2_QA_CANDIDATE_KEYS;
  const record = persistedRecord(value, keys);
  persistedUuid(record.id);
  persistedUuid(record.qaRunId);
  persistedUuid(record.inputVersionId);
  persistedUuid(record.candidateId);
  persistedLiteral(record.candidateIndex, [1, 2, 3, 4]);
  persistedLiteral(record.attempt, [1, 2]);
  persistedUuid(record.sourceAssetId);
  persistedInteger(record.sourceByteSize, 1);
  persistedSha(record.sourceSha256);
  persistedEnum(record.status, ["queued", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal", ...(reQa ? ["re_qa_unavailable"] : [])]);
  persistedEnum(record.verdict, ["PASS", "WARNING", "MATERIAL_FAIL", "QA_UNAVAILABLE"]);
  for (const item of persistedArray(record.requirementObservations)) validateS2RequirementObservation(item);
  for (const item of persistedArray(record.designObservations)) validateS2DesignObservation(item);
  persistedStringArray(record.materialFindingIds, 200);
  persistedStringArray(record.warningFindingIds, 200);
  persistedStringArray(record.uncertainFindingIds, 200);
  if (record.providerRequestId !== null) persistedString(record.providerRequestId, 200);
  persistedNullableUuid(record.repairAttemptId);
  persistedNullableTimestamp(record.startedAt);
  persistedNullableTimestamp(record.completedAt);
  if (reQa) {
    persistedEnum(record.phase, ["re_qa"]);
    persistedUuid(record.derivedCandidateId);
  }
}

function validateS2Asset(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "kind", "status", "originalSha256", "originalBytes",
    "normalizedSha256", "normalizedBytes", "detectedMime", "width", "height",
    "pixelCount", "hasAlpha", "storageKeyOriginal", "storageKeyNormalized",
    "createdAt", "deletedAt",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId);
  persistedEnum(record.kind, ["reference", "logo"]);
  persistedEnum(record.status, ["ready", "deleted"]);
  persistedSha(record.originalSha256); persistedInteger(record.originalBytes, 1);
  persistedSha(record.normalizedSha256); persistedInteger(record.normalizedBytes, 1);
  persistedEnum(record.detectedMime, ["image/png", "image/jpeg", "image/webp"]);
  persistedInteger(record.width, 1); persistedInteger(record.height, 1);
  persistedInteger(record.pixelCount, 1); if (typeof record.hasAlpha !== "boolean") invalidS2State();
  persistedString(record.storageKeyOriginal, 1000); persistedString(record.storageKeyNormalized, 1000);
  persistedTimestamp(record.createdAt); persistedNullableTimestamp(record.deletedAt);
}

function validateS2Draft(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "revision", "status", "referenceAssetIds", "logoAssetIds",
    "updatedAt", "frozenAt", "frozenByQaRunId",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedInteger(record.revision, 1);
  persistedEnum(record.status, ["editable", "frozen"]);
  persistedUuidArray(record.referenceAssetIds); persistedUuidArray(record.logoAssetIds);
  persistedTimestamp(record.updatedAt); persistedNullableTimestamp(record.frozenAt); persistedNullableUuid(record.frozenByQaRunId);
}

function validateS2Input(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "sourceGenerationSetId", "sourceCandidates", "confirmedBriefVersionId",
    "confirmedBriefContentHash", "geometrySnapshot", "geometryHash", "canonicalRequirements",
    "requirementHash", "designRulesVersion", "designRuleSnapshot", "decoderProfile", "qaModel",
    "qaSchema", "referenceAssetIds", "logoAssetIds", "draftRevision", "inputHash",
    "bindingHash", "status", "createdAt", "boundAt", "qaRunId",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.sourceGenerationSetId);
  for (const item of persistedArray(record.sourceCandidates)) validateS2Source(item);
  persistedUuid(record.confirmedBriefVersionId); persistedSha(record.confirmedBriefContentHash);
  validateS2Geometry(record.geometrySnapshot); persistedSha(record.geometryHash);
  for (const item of persistedArray(record.canonicalRequirements)) validateS2Requirement(item);
  persistedSha(record.requirementHash); persistedEnum(record.designRulesVersion, ["s2-design-rules-v1"]);
  for (const item of persistedArray(record.designRuleSnapshot)) validateS2DesignRule(item);
  persistedEnum(record.decoderProfile, ["s2-media-v1"]); persistedEnum(record.qaModel, ["gpt-5.4-mini-2026-03-17"]);
  persistedEnum(record.qaSchema, ["s2-qa-v1"]); persistedUuidArray(record.referenceAssetIds); persistedUuidArray(record.logoAssetIds);
  persistedInteger(record.draftRevision, 1); persistedSha(record.inputHash); persistedSha(record.bindingHash);
  persistedEnum(record.status, ["bound"]); persistedTimestamp(record.createdAt); persistedTimestamp(record.boundAt); persistedUuid(record.qaRunId);
}

function validateS2QaRun(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "inputVersionId", "sourceGenerationSetId", "status", "candidateResults",
    "completedCandidateCount", "passCount", "warningCount", "materialFailCount", "unavailableCount",
    "createdAt", "startedAt", "completedAt",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.inputVersionId); persistedUuid(record.sourceGenerationSetId);
  persistedEnum(record.status, ["queued", "running", "completed"]);
  for (const item of persistedArray(record.candidateResults)) validateS2QaCandidate(item, false);
  persistedInteger(record.completedCandidateCount, 0); persistedInteger(record.passCount, 0);
  persistedInteger(record.warningCount, 0); persistedInteger(record.materialFailCount, 0); persistedInteger(record.unavailableCount, 0);
  persistedTimestamp(record.createdAt); persistedNullableTimestamp(record.startedAt); persistedNullableTimestamp(record.completedAt);
}

function validateS2Repair(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "qaRunId", "inputVersionId", "candidateId", "attempt", "status",
    "eligibleFindingIds", "sourceAssetId", "sourceByteSize", "sourceSha256", "repairInputHash",
    "repairPromptHash", "outputSha256", "derivedCandidateId", "reQaCandidateResultId",
    "providerRequestId", "createdAt", "startedAt", "completedAt",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.qaRunId); persistedUuid(record.inputVersionId); persistedUuid(record.candidateId);
  persistedLiteral(record.attempt, [1]); persistedEnum(record.status, ["not_eligible", "eligible", "queued", "running", "failed", "derived_ready", "re_qa_running", "re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable"]);
  persistedStringArray(record.eligibleFindingIds, 200); persistedUuid(record.sourceAssetId); persistedInteger(record.sourceByteSize, 1);
  persistedSha(record.sourceSha256); persistedSha(record.repairInputHash); persistedSha(record.repairPromptHash);
  if (record.outputSha256 !== null) persistedSha(record.outputSha256);
  persistedNullableUuid(record.derivedCandidateId); persistedNullableUuid(record.reQaCandidateResultId);
  if (record.providerRequestId !== null) persistedString(record.providerRequestId, 200);
  persistedTimestamp(record.createdAt); persistedNullableTimestamp(record.startedAt); persistedNullableTimestamp(record.completedAt);
}

function validateS2Derived(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "sourceGenerationSetId", "inputVersionId", "qaRunId", "sourceCandidateId",
    "repairAttemptId", "sourceAssetId", "sourceByteSize", "sourceSha256", "outputSha256",
    "normalizedBytes", "width", "height", "storageKeyNormalized", "createdAt",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.sourceGenerationSetId);
  persistedUuid(record.inputVersionId); persistedUuid(record.qaRunId); persistedUuid(record.sourceCandidateId);
  persistedUuid(record.repairAttemptId); persistedUuid(record.sourceAssetId); persistedInteger(record.sourceByteSize, 1);
  persistedSha(record.sourceSha256); persistedSha(record.outputSha256); persistedInteger(record.normalizedBytes, 1);
  persistedInteger(record.width, 1); persistedInteger(record.height, 1); persistedString(record.storageKeyNormalized, 1000);
  persistedTimestamp(record.createdAt);
}

function validateS2ReQa(value: unknown): void {
  validateS2QaCandidate(value, true);
}

function validateS2Operation(value: unknown): void {
  const record = persistedRecord(value, [
    "id", "projectId", "phase", "attempt", "qaRunId", "candidateId", "repairAttemptId",
    "inputHash", "referenceId", "status", "claimedBy", "claimedProcessId", "claimToken",
    "claimedAt", "startedAt", "completedAt", "providerDispatchState", "failureCode", "resultId",
  ]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedEnum(record.phase, ["qa", "repair", "re_qa"]);
  persistedLiteral(record.attempt, [1, 2]); persistedUuid(record.qaRunId); persistedUuid(record.candidateId);
  persistedNullableUuid(record.repairAttemptId); persistedSha(record.inputHash); persistedUuid(record.referenceId);
  persistedEnum(record.status, ["queued", "running", "succeeded", "failed"]);
  if (record.claimedBy !== null) persistedString(record.claimedBy, 200);
  if (record.claimedProcessId !== null) persistedInteger(record.claimedProcessId, 1);
  persistedNullableUuid(record.claimToken); persistedNullableTimestamp(record.claimedAt);
  persistedNullableTimestamp(record.startedAt); persistedNullableTimestamp(record.completedAt);
  persistedEnum(record.providerDispatchState, ["not_started", "may_have_started", "consumed"]);
  if (record.failureCode !== null) persistedString(record.failureCode, 200);
  persistedNullableUuid(record.resultId);
  if (record.phase === "qa" && record.repairAttemptId !== null) invalidS2State();
  if (record.phase !== "qa" && record.repairAttemptId === null) invalidS2State();
  if (record.phase !== "qa" && record.attempt !== 1) invalidS2State();
  if (record.phase === "repair" && record.resultId !== null) invalidS2State();
  if (record.phase === "re_qa" && record.resultId === null) invalidS2State();
  if (record.status === "queued") {
    if (record.providerDispatchState !== "not_started" || record.claimedBy !== null || record.claimedProcessId !== null ||
        record.claimToken !== null || record.claimedAt !== null || record.startedAt !== null || record.completedAt !== null) invalidS2State();
  }
  if (record.status === "running") {
    if (record.providerDispatchState === "consumed" || record.claimedBy === null || record.claimedProcessId === null ||
        record.claimToken === null || record.claimedAt === null || record.startedAt === null || record.completedAt !== null) invalidS2State();
  }
  if (record.status === "succeeded" || record.status === "failed") {
    if (record.providerDispatchState !== "consumed" || record.claimedBy !== null || record.claimedProcessId !== null ||
        record.claimToken !== null || record.claimedAt !== null || record.completedAt === null) invalidS2State();
  }
}

function validateS2PublicationObject(value: unknown): void {
  const record = persistedRecord(value, ["key", "sha256", "byteSize"]);
  persistedString(record.key, 2000); persistedSha(record.sha256); persistedInteger(record.byteSize, 1);
}

function validateS2UploadPublication(value: unknown): void {
  const record = persistedRecord(value, [
    "kind", "id", "projectId", "assetId", "idempotencyKey", "inputHash", "ownerProcessId",
    "stagingObjects", "finalObjects", "intendedAsset", "state", "createdAt", "updatedAt",
  ]);
  persistedEnum(record.kind, ["asset_upload"]); persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.assetId);
  persistedUuid(record.idempotencyKey); persistedSha(record.inputHash); persistedInteger(record.ownerProcessId, 1);
  for (const item of persistedArray(record.stagingObjects)) validateS2PublicationObject(item);
  for (const item of persistedArray(record.finalObjects)) validateS2PublicationObject(item);
  validateS2Asset(record.intendedAsset); persistedEnum(record.state, ["staged", "promoted", "committed", "aborted"]);
  persistedTimestamp(record.createdAt); persistedTimestamp(record.updatedAt);
}

function validateS2RepairPublication(value: unknown): void {
  const record = persistedRecord(value, [
    "kind", "id", "projectId", "operationId", "repairAttemptId", "qaRunId", "candidateId",
    "inputVersionId", "inputHash", "stagingObjects", "finalObjects", "intendedDerived",
    "intendedReQa", "intendedReQaOperation", "providerRequestId", "state", "createdAt", "updatedAt",
  ]);
  persistedEnum(record.kind, ["repair_output"]); persistedUuid(record.id); persistedUuid(record.projectId);
  persistedUuid(record.operationId); persistedUuid(record.repairAttemptId); persistedUuid(record.qaRunId); persistedUuid(record.candidateId);
  persistedUuid(record.inputVersionId); persistedSha(record.inputHash);
  for (const item of persistedArray(record.stagingObjects)) validateS2PublicationObject(item);
  for (const item of persistedArray(record.finalObjects)) validateS2PublicationObject(item);
  validateS2Derived(record.intendedDerived); validateS2ReQa(record.intendedReQa); validateS2Operation(record.intendedReQaOperation);
  if (record.providerRequestId !== null) persistedString(record.providerRequestId, 200);
  persistedEnum(record.state, ["staged", "promoted", "committed", "aborted"]);
  persistedTimestamp(record.createdAt); persistedTimestamp(record.updatedAt);
}

function validateS2Publication(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidS2State();
  const kind = (value as PersistedRecord).kind;
  if (kind === "asset_upload") validateS2UploadPublication(value);
  else if (kind === "repair_output") validateS2RepairPublication(value);
  else invalidS2State();
}

function validateS2Transition(value: unknown): void {
  const record = persistedRecord(value, ["id", "projectId", "operationId", "phase", "attempt", "from", "to", "referenceId", "at"]);
  persistedUuid(record.id); persistedUuid(record.projectId); persistedUuid(record.operationId);
  persistedEnum(record.phase, ["qa", "repair", "re_qa"]); persistedLiteral(record.attempt, [1, 2]);
  persistedString(record.from, 200); persistedString(record.to, 200); persistedUuid(record.referenceId); persistedTimestamp(record.at);
}

const S2_COLLECTION_VALIDATORS: Readonly<Record<string, (value: unknown) => void>> = {
  s2Assets: validateS2Asset,
  s2Drafts: validateS2Draft,
  s2Inputs: validateS2Input,
  s2QaRuns: validateS2QaRun,
  s2Repairs: validateS2Repair,
  s2DerivedCandidates: validateS2Derived,
  s2ReQaResults: validateS2ReQa,
  s2Operations: validateS2Operation,
  s2Publications: validateS2Publication,
  s2Transitions: validateS2Transition,
};

function validateS2Collections(parsed: PersistedRecord, merged: StoreState): void {
  for (const [name, validate] of Object.entries(S2_COLLECTION_VALIDATORS)) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) {
      const values = persistedArray(parsed[name]);
      values.forEach(validate);
    }
    if (!Array.isArray(merged[name as keyof StoreState])) invalidS2State();
  }
}

function assertPrivateKey(key: string): string[] {
  const parts = key.split("/");
  if (
    !key ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\"),
    )
  ) {
    throw new Error("Invalid private object key");
  }
  return parts;
}

export class PrivateObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, ...assertPrivateKey(key));
    const relativePath = relative(this.root, path);
    if (
      relativePath === ".." ||
      relativePath.startsWith(".." + sep)
    ) {
      throw new Error("Private object path escaped root");
    }
    return path;
  }

  put(key: string, bytes: Uint8Array): void {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: key });
    }
    const temporary = path + "." + randomUUID() + ".tmp";
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx");
      writeFileSync(descriptor, Buffer.from(bytes));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, path);
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence failure without exposing a path.
      }
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: key });
    }
  }

  promote(stagingKey: string, finalKey: string): void {
    const source = this.pathFor(stagingKey);
    const target = this.pathFor(finalKey);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: finalKey });
    }
    try {
      renameSync(source, target);
    } catch {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: finalKey });
    }
  }

  putExact(key: string, bytes: Uint8Array): void {
    const expected = Buffer.from(bytes);
    if (this.exists(key)) {
      let actual: Buffer;
      try { actual = this.read(key); } catch { throw new AppError(500, "PERSISTENCE_FAILED"); }
      if (!actual.equals(expected)) throw new AppError(500, "PERSISTENCE_FAILED");
      return;
    }
    this.put(key, expected);
  }

  promoteExact(stagingKey: string, finalKey: string, expected: Uint8Array): void {
    const bytes = Buffer.from(expected);
    if (this.exists(finalKey)) {
      let actual: Buffer;
      try { actual = this.read(finalKey); } catch { throw new AppError(500, "PERSISTENCE_FAILED"); }
      if (!actual.equals(bytes)) throw new AppError(500, "PERSISTENCE_FAILED");
      return;
    }
    this.promote(stagingKey, finalKey);
  }

  read(key: string): Buffer {
    try {
      return readFileSync(this.pathFor(key));
    } catch {
      throw new AppError(404, "ASSET_NOT_FOUND");
    }
  }

  remove(key: string): void {
    try {
      rmSync(this.pathFor(key), { force: true });
    } catch {
      // Cleanup is best effort. The workflow remains failed and never publishes
      // a candidate when cleanup cannot complete.
    }
  }

  exists(key: string): boolean {
    return existsSync(this.pathFor(key));
  }
}

type CanonicalLockInspection =
  | { kind: "missing" }
  | { kind: "valid"; record: RepositoryLockRecord }
  | { kind: "malformed" };

export class JsonRepository {
  readonly root: string;
  readonly statePath: string;
  readonly lockPath: string;
  private current: StoreState;
  readonly mutexPath: string;
  private readonly beforeCommit: (() => void) | undefined;
  private readonly lockWaitMs: number;
  private readonly processId: number;
  private readonly isProcessAlive: ProcessLiveness;
  private readonly onLockPhase: LockPhaseHook | undefined;

  constructor(
    root: string,
    options: {
      beforeCommit?: () => void;
      lockWaitMs?: number;
      processId?: number;
      isProcessAlive?: ProcessLiveness;
      onLockPhase?: LockPhaseHook;
    } = {},
  ) {
    this.root = resolve(root);
    this.statePath = join(this.root, "state.json");
    this.lockPath = join(this.root, "state.json.lock");
    this.mutexPath = join(this.root, "state.json.mutex");
    this.beforeCommit = options.beforeCommit;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.onLockPhase = options.onLockPhase;
    mkdirSync(this.root, { recursive: true });
    this.current = this.load();
  }

  private load(): StoreState {
    if (!existsSync(this.statePath)) return emptyStoreState();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("invalid state");
      }
      const parsedRecord = parsed as PersistedRecord;
      const merged = { ...emptyStoreState(), ...(parsedRecord as Partial<StoreState>) };
      if (!Array.isArray(merged.extractionOperations)) {
        merged.extractionOperations = [];
      }
      if (!Array.isArray(merged.generationOperations)) {
        merged.generationOperations = [];
      }
      validateS2Collections(parsedRecord, merged);
      validateS3Collections(parsedRecord, merged);
      validateS4Collections(parsedRecord, merged);
      validateS2Graph(merged);
      validateS3Graph(merged);
      validateS4Graph(merged);
      return merged;
    } catch {
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  state(): StoreState {
    this.current = this.load();
    return this.current;
  }

  private parseLockRecord(value: unknown): RepositoryLockRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<RepositoryLockRecord> & {
      protocol?: unknown;
    };
    if (
      candidate.protocol !== undefined &&
      candidate.protocol !== LOCK_PROTOCOL
    ) {
      return null;
    }
    if (
      typeof candidate.ownerToken !== "string" ||
      candidate.ownerToken.length < 1 ||
      !Number.isInteger(candidate.processId) ||
      (candidate.processId as number) <= 0 ||
      typeof candidate.acquiredAt !== "number" ||
      !Number.isFinite(candidate.acquiredAt)
    ) {
      return null;
    }
    return {
      ...(candidate.protocol === LOCK_PROTOCOL
        ? { protocol: LOCK_PROTOCOL }
        : {}),
      ownerToken: candidate.ownerToken,
      processId: candidate.processId as number,
      acquiredAt: candidate.acquiredAt,
    };
  }

  private readRecordAt(path: string): RepositoryLockRecord | null {
    try {
      return this.parseLockRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private readLockRecord(): RepositoryLockRecord | null {
    return this.readRecordAt(this.lockPath);
  }

  private inspectCanonicalLock(): CanonicalLockInspection {
    if (!existsSync(this.lockPath)) return { kind: "missing" };
    try {
      if (!statSync(this.lockPath).isFile()) return { kind: "malformed" };
    } catch {
      return { kind: "malformed" };
    }
    const record = this.readLockRecord();
    return record ? { kind: "valid", record } : { kind: "malformed" };
  }

  private ownerIsLive(record: RepositoryLockRecord): boolean {
    try {
      // A liveness-check failure is held as live. It is safer to return a
      // bounded busy result than to reclaim an owner we cannot disprove.
      return this.isProcessAlive(record.processId);
    } catch {
      return true;
    }
  }

  private recordsMatch(
    left: RepositoryLockRecord,
    right: RepositoryLockRecord,
  ): boolean {
    return (
      left.ownerToken === right.ownerToken &&
      left.processId === right.processId &&
      left.acquiredAt === right.acquiredAt &&
      (left.protocol ?? null) === (right.protocol ?? null)
    );
  }
  private acquireMutex(deadline: number): FileMutexLease {
    let descriptor: number;
    try {
      descriptor = openSync(this.mutexPath, "a+");
    } catch {
      throw new AppError(503, "PERSISTENCE_BUSY");
    }

    try {
      while (true) {
        try {
          flockSync(descriptor, MUTEX_FLAGS);
          let released = false;
          return {
            release: () => {
              if (released) return;
              released = true;
              try {
                flockSync(descriptor, "un");
              } catch {
                // Closing the descriptor still releases the OS lock after a
                // best-effort explicit unlock failure.
              }
              try {
                closeSync(descriptor);
              } catch {
                // The descriptor is already closed or the process is exiting.
              }
            },
          };
        } catch {
          if (Date.now() >= deadline) throw new AppError(503, "PERSISTENCE_BUSY");
          sleepSync(5);
        }
      }
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the bounded busy result without exposing filesystem data.
      }
      if (error instanceof AppError) throw error;
      throw new AppError(503, "PERSISTENCE_BUSY");
    }
  }

  private removeLockIfOwned(record: RepositoryLockRecord): boolean {
    const current = this.readLockRecord();
    if (!current || !this.recordsMatch(current, record)) return false;
    try {
      rmSync(this.lockPath, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private removeCandidate(path: string): void {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // A recovery sweep can remove the artifact later. The canonical claim
      // remains authoritative and is never downgraded to an unsafe fallback.
    }
  }

  private emitLockPhase(
    phase: RepositoryLockPhase,
    record: RepositoryLockRecord,
    path: string,
  ): void {
    try {
      this.onLockPhase?.(phase, { ...record }, path);
    } catch (error) {
      throw new LockHookError(error);
    }
  }

  private candidatePath(record: RepositoryLockRecord): string {
    return this.lockPath + "." + record.ownerToken + ".candidate";
  }

  private recoverCandidateArtifacts(): void {
    const prefix = basename(this.lockPath) + ".";
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".candidate")) continue;
      const path = join(this.root, name);
      const record = this.readRecordAt(path);
      if (record && this.ownerIsLive(record)) continue;
      // Candidate files are never canonical owners. Incomplete or dead
      // candidates are safe to remove, while a live candidate is preserved.
      this.removeCandidate(path);
    }
  }

  private recoverMalformedCanonical(): void {
    const recoveryPath =
      this.lockPath + "." + randomUUID() + ".recovery";
    try {
      // Quarantine is a same-directory rename. It cannot replace a successor
      // canonical claim because the destination is unique and the source is
      // removed atomically from the canonical name.
      renameSync(this.lockPath, recoveryPath);
      this.removeCandidate(recoveryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new AppError(503, "PERSISTENCE_BUSY");
    }
  }

  private prepareCandidate(record: RepositoryLockRecord): string {
    const path = this.candidatePath(record);
    let descriptor: number | null = null;
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    const partialLength = Math.max(1, Math.floor(bytes.length / 2));
    try {
      descriptor = openSync(path, "wx", 0o600);
      this.emitLockPhase("candidate-created", record, path);
      this.emitLockPhase("owner-data-before-write", record, path);
      writeSync(descriptor, bytes, 0, partialLength, 0);
      this.emitLockPhase("owner-data-partial", record, path);
      writeSync(
        descriptor,
        bytes,
        partialLength,
        bytes.length - partialLength,
        partialLength,
      );
      this.emitLockPhase("owner-data-complete", record, path);
      fsyncSync(descriptor);
      this.emitLockPhase("owner-data-fsynced", record, path);
      closeSync(descriptor);
      descriptor = null;
      return path;
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // The process-crash simulation owns the incomplete artifact.
        }
      }
      if (error instanceof LockHookError) throw error;
      this.removeCandidate(path);
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  private acquireLock(): RepositoryLock {
    const deadline = Date.now() + this.lockWaitMs;
    const record: RepositoryLockRecord = {
      protocol: LOCK_PROTOCOL,
      ownerToken: randomUUID(),
      processId: this.processId,
      acquiredAt: Date.now(),
    };
    let candidate: string | null = null;
    let mutex: FileMutexLease | null = null;
    try {
      mutex = this.acquireMutex(deadline);

      while (true) {
        this.recoverCandidateArtifacts();
        const inspection = this.inspectCanonicalLock();
        if (inspection.kind === "malformed") {
          this.emitLockPhase("before-malformed-recovery", record, this.lockPath);
          this.recoverMalformedCanonical();
          continue;
        }

        if (inspection.kind === "valid") {
          if (this.ownerIsLive(inspection.record)) {
            mutex.release();
            mutex = null;
            if (Date.now() >= deadline) throw new AppError(503, "PERSISTENCE_BUSY");
            sleepSync(5);
            mutex = this.acquireMutex(deadline);
            continue;
          }
          this.emitLockPhase("before-dead-owner-recovery", inspection.record, this.lockPath);
          this.removeLockIfOwned(inspection.record);
          continue;
        }

        candidate = this.prepareCandidate(record);
        this.emitLockPhase("before-canonical-claim", record, this.lockPath);
        this.emitLockPhase("canonical-claiming", record, this.lockPath);
        try {
          // The owner record is complete and fsynced before linkSync. A hard
          // link is atomic and cannot overwrite an existing canonical path.
          linkSync(candidate, this.lockPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            this.removeCandidate(candidate);
            candidate = null;
            continue;
          }
          throw new AppError(500, "PERSISTENCE_FAILED");
        }
        this.emitLockPhase("canonical-claimed", record, this.lockPath);
        this.removeCandidate(candidate);
        this.emitLockPhase("before-acquisition-return", record, this.lockPath);
        return { candidatePath: candidate, mutex, record };
      }
    } catch (error) {
      if (!(error instanceof LockHookError) && candidate !== null) {
        this.removeCandidate(candidate);
      }
      mutex?.release();
      if (error instanceof LockHookError) throw error.original;
      if (error instanceof AppError) throw error;
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  private releaseLock(lock: RepositoryLock): void {
    try {
      // The OS-backed mutex is held from canonical inspection through release.
      // A successor cannot publish between this observation and the removal.
      this.emitLockPhase("before-canonical-release", lock.record, this.lockPath);
      this.removeLockIfOwned(lock.record);
      this.removeCandidate(lock.candidatePath);
    } finally {
      lock.mutex.release();
    }
  }

  private commit(state: StoreState): void {
    const temporary = this.statePath + "." + randomUUID() + ".tmp";
    let descriptor: number | null = null;
    try {
      this.beforeCommit?.();
      descriptor = openSync(temporary, "wx");
      writeFileSync(descriptor, JSON.stringify(state), { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.statePath);
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence failure without exposing a path.
      }
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  transact<T>(mutation: (state: StoreState) => T): T {
    const lock = this.acquireLock();
    try {
      const fresh = this.load();
      const result = mutation(fresh);
      try {
        validateS2Graph(fresh);
        validateS3Graph(fresh);
        validateS4Graph(fresh);
      } catch {
        throw new AppError(500, "PERSISTENCE_FAILED");
      }
      this.commit(fresh);
      this.current = fresh;
      return result;
    } finally {
      this.releaseLock(lock);
    }
  }
}

export function defaultDataRoot(): string {
  return process.env.SWOOSHZ_DATA_ROOT ?? join(process.cwd(), ".swooshz-data");
}
