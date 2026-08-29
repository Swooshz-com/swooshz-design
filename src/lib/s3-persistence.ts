import { uuidV4Pattern } from "./utils";
import type {
  StoreState,
} from "./types";

type RecordValue = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalid(): never {
  throw new Error("invalid S3 persisted state");
}

function record(value: unknown, keys: readonly string[]): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const actual = Object.keys(value as object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as RecordValue;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}

function stringValue(value: unknown, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) return invalid();
  return value;
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

function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}

function numberValue(value: unknown, minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function enumValue(value: unknown, allowed: readonly string[]): string {
  const result = stringValue(value);
  if (!allowed.includes(result)) return invalid();
  return result;
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

function stringArray(value: unknown, max = 4096): void {
  for (const item of array(value)) stringValue(item, max);
}

function uuidArray(value: unknown): void {
  for (const item of array(value)) uuid(item);
}

function tupleOf(value: unknown, lengths: readonly number[], validator: (item: unknown) => void): void {
  const values = array(value);
  if (!lengths.includes(values.length)) return invalid();
  values.forEach(validator);
}

function geometry(value: unknown): void {
  const item = record(value, ["widthMm", "depthMm", "openSides", "maxHeightMm"]);
  integer(item.widthMm, 1); integer(item.depthMm, 1);
  const sides = array(item.openSides);
  const seen = new Set<string>();
  for (const side of sides) {
    const value = enumValue(side, ["north", "east", "south", "west"]);
    if (seen.has(value)) return invalid();
    seen.add(value);
  }
  if (item.maxHeightMm !== null) integer(item.maxHeightMm, 1);
}

function requirement(value: unknown): void {
  const item = record(value, [
    "requirementId", "category", "expected", "expectedCount", "expectedValue",
    "criticality", "source", "text",
  ]);
  stringValue(item.requirementId, 200);
  enumValue(item.category, ["geometry", "functional", "mandatory", "prohibited", "free_text"]);
  enumValue(item.expected, ["present", "absent", "exact_count"]);
  if (item.expectedCount !== null) integer(item.expectedCount, 0);
  if (item.expectedValue !== null && typeof item.expectedValue !== "string" &&
      typeof item.expectedValue !== "number" && typeof item.expectedValue !== "boolean") return invalid();
  if (typeof item.expectedValue === "number" && !Number.isFinite(item.expectedValue)) return invalid();
  enumValue(item.criticality, ["material", "warning"]);
  enumValue(item.source, ["confirmed_brief", "geometry_snapshot"]);
  stringValue(item.text, 1000, true);
}

function designRule(value: unknown): void {
  const item = record(value, ["ruleId", "applicability", "materiality", "repairable"]);
  stringValue(item.ruleId, 200);
  enumValue(item.applicability, ["applicable", "not_applicable"]);
  enumValue(item.materiality, ["material", "warning"]);
  bool(item.repairable);
}

function requirementObservation(value: unknown): void {
  const item = record(value, [
    "requirementId", "expected", "expectedCount", "expectedValue", "observed",
    "observedCount", "confidence", "evidence",
  ]);
  stringValue(item.requirementId, 200);
  enumValue(item.expected, ["present", "absent", "exact_count"]);
  if (item.expectedCount !== null) integer(item.expectedCount, 0);
  if (item.expectedValue !== null && typeof item.expectedValue !== "string" &&
      typeof item.expectedValue !== "number" && typeof item.expectedValue !== "boolean") return invalid();
  if (typeof item.expectedValue === "number" && !Number.isFinite(item.expectedValue)) return invalid();
  enumValue(item.observed, ["present", "absent", "uncertain", "not_verifiable"]);
  if (item.observedCount !== null) integer(item.observedCount, 0);
  numberValue(item.confidence, 0, 1);
  stringValue(item.evidence, 400, true);
}

function designObservation(value: unknown): void {
  const item = record(value, ["ruleId", "observed", "confidence", "evidence"]);
  stringValue(item.ruleId, 200);
  enumValue(item.observed, ["compliant", "non_compliant", "uncertain", "not_verifiable"]);
  numberValue(item.confidence, 0, 1);
  stringValue(item.evidence, 400, true);
}

const SOURCE_BINDING_KEYS = [
  "schemaVersion", "projectId", "generationSetId", "candidateIndex", "sourceKind",
  "sourceCandidateId", "ultimateS1CandidateId", "ultimateS1AssetId", "selectedAssetKind",
  "selectedAssetId", "selectedSha256", "selectedByteSize", "selectedWidth", "selectedHeight",
  "selectedPixelCount", "selectedDecodedRgbaBytes", "s1CompilerVersion", "s1DirectionKey",
  "s1CanonicalInputHash", "s1PromptHash", "s1Provider", "s1ImageModelSnapshot",
  "confirmedBriefVersionId", "confirmedBriefContentHash", "s2InputVersionId", "s2InputBindingHash",
  "s2QaRunId", "s2SourceQaResultId", "s2QaModelSnapshot", "s2RepairAttemptId", "s2ReQaResultId",
  "s2DerivedCandidateId", "s2RepairInputHash", "s2RepairPromptHash", "s2RepairModelSnapshot",
  "eligibilityResultId", "eligibilityStatus", "eligibilityVerdict",
] as const;

function sourceBinding(value: unknown): void {
  const item = record(value, SOURCE_BINDING_KEYS);
  enumValue(item.schemaVersion, ["s3-source-binding-v1"]);
  uuid(item.projectId); uuid(item.generationSetId); integer(item.candidateIndex, 1);
  if (![1, 2, 3, 4].includes(item.candidateIndex as number)) return invalid();
  enumValue(item.sourceKind, ["s1_original", "s2_repaired"]);
  uuid(item.sourceCandidateId); uuid(item.ultimateS1CandidateId); uuid(item.ultimateS1AssetId);
  enumValue(item.selectedAssetKind, ["s1_concept_asset", "s2_derived_candidate"]);
  uuid(item.selectedAssetId); sha(item.selectedSha256); integer(item.selectedByteSize, 1);
  integer(item.selectedWidth, 1); integer(item.selectedHeight, 1); integer(item.selectedPixelCount, 1);
  integer(item.selectedDecodedRgbaBytes, 1); enumValue(item.s1CompilerVersion, ["g2-booth-v1"]);
  enumValue(item.s1DirectionKey, ["modular-clarity", "brand-theatre", "open-demo", "hospitality-consultation"]);
  sha(item.s1CanonicalInputHash); sha(item.s1PromptHash); enumValue(item.s1Provider, ["openai"]);
  enumValue(item.s1ImageModelSnapshot, ["gpt-image-2-2026-04-21"]);
  uuid(item.confirmedBriefVersionId); sha(item.confirmedBriefContentHash); uuid(item.s2InputVersionId);
  sha(item.s2InputBindingHash); uuid(item.s2QaRunId); uuid(item.s2SourceQaResultId);
  enumValue(item.s2QaModelSnapshot, ["gpt-5.4-mini-2026-03-17"]);
  nullableUuid(item.s2RepairAttemptId); nullableUuid(item.s2ReQaResultId); nullableUuid(item.s2DerivedCandidateId);
  nullableSha(item.s2RepairInputHash); nullableSha(item.s2RepairPromptHash);
  if (item.s2RepairModelSnapshot !== null) enumValue(item.s2RepairModelSnapshot, ["gpt-image-2-2026-04-21"]);
  uuid(item.eligibilityResultId); enumValue(item.eligibilityStatus, ["pass", "warning"]);
  enumValue(item.eligibilityVerdict, ["PASS", "WARNING"]);
}

function source(value: unknown): void {
  const item = record(value, [
    "sourceSnapshotId", "sourceRootRevisionId", "projectId", "generationSetId", "candidateIndex",
    "sourceKind", "canonicalSourceBinding", "sourceBindingHash", "selectedAssetKind", "selectedAssetId",
    "selectedStorageKey", "selectedSha256", "selectedByteSize", "selectedWidth", "selectedHeight",
    "selectedPixelCount", "selectedDecodedRgbaBytes", "confirmedBriefVersionId", "confirmedBriefContentHash",
    "s2InputVersionId", "s2InputBindingHash", "geometrySnapshot", "geometryHash", "canonicalRequirements",
    "requirementHash", "designRulesVersion", "designRuleSnapshot", "designRuleSnapshotHash", "createdAt",
  ]);
  uuid(item.sourceSnapshotId); uuid(item.sourceRootRevisionId); uuid(item.projectId); uuid(item.generationSetId);
  integer(item.candidateIndex, 1); if (![1, 2, 3, 4].includes(item.candidateIndex as number)) return invalid();
  enumValue(item.sourceKind, ["s1_original", "s2_repaired"]); sourceBinding(item.canonicalSourceBinding);
  sha(item.sourceBindingHash); enumValue(item.selectedAssetKind, ["s1_concept_asset", "s2_derived_candidate"]);
  uuid(item.selectedAssetId); stringValue(item.selectedStorageKey, 2000); sha(item.selectedSha256);
  integer(item.selectedByteSize, 1); integer(item.selectedWidth, 1); integer(item.selectedHeight, 1);
  integer(item.selectedPixelCount, 1); integer(item.selectedDecodedRgbaBytes, 1); uuid(item.confirmedBriefVersionId);
  sha(item.confirmedBriefContentHash); uuid(item.s2InputVersionId); sha(item.s2InputBindingHash);
  geometry(item.geometrySnapshot); sha(item.geometryHash); array(item.canonicalRequirements).forEach(requirement);
  sha(item.requirementHash); enumValue(item.designRulesVersion, ["s2-design-rules-v1"]);
  array(item.designRuleSnapshot).forEach(designRule); sha(item.designRuleSnapshotHash); timestamp(item.createdAt);
}

function selection(value: unknown): void {
  const item = record(value, [
    "selectionStateId", "projectId", "generationSetId", "confirmedBriefVersionId", "confirmedBriefContentHash",
    "s2InputVersionId", "s2InputBindingHash", "geometrySnapshot", "geometryHash", "activeRevisionId",
    "lineageRootRevisionId", "selectionVersion", "cycleSlotsConsumed", "successfulRefinementCount",
    "createdAt", "updatedAt",
  ]);
  uuid(item.selectionStateId); uuid(item.projectId); uuid(item.generationSetId); uuid(item.confirmedBriefVersionId);
  sha(item.confirmedBriefContentHash); uuid(item.s2InputVersionId); sha(item.s2InputBindingHash);
  geometry(item.geometrySnapshot); sha(item.geometryHash); nullableUuid(item.activeRevisionId); nullableUuid(item.lineageRootRevisionId);
  integer(item.selectionVersion, 1); integer(item.cycleSlotsConsumed, 0); integer(item.successfulRefinementCount, 0);
  if (![0, 1, 2].includes(item.cycleSlotsConsumed as number) || ![0, 1, 2].includes(item.successfulRefinementCount as number)) return invalid();
  timestamp(item.createdAt); timestamp(item.updatedAt);
}

function selectionEvent(value: unknown): void {
  const item = record(value, [
    "eventId", "projectId", "selectionStateId", "kind", "fromRevisionId", "toRevisionId", "sourceSnapshotId",
    "cycleId", "assessmentId", "expectedSelectionVersion", "resultingSelectionVersion",
    "resultingSuccessfulRefinementCount", "idempotencyKey", "requestReferenceId", "at",
  ]);
  uuid(item.eventId); uuid(item.projectId); uuid(item.selectionStateId);
  enumValue(item.kind, ["select_source", "reselect_source", "activate_refinement", "rollback"]);
  nullableUuid(item.fromRevisionId); uuid(item.toRevisionId); uuid(item.sourceSnapshotId);
  nullableUuid(item.cycleId); nullableUuid(item.assessmentId); integer(item.expectedSelectionVersion, 0);
  integer(item.resultingSelectionVersion, 1); integer(item.resultingSuccessfulRefinementCount, 0);
  if (![0, 1, 2].includes(item.resultingSuccessfulRefinementCount as number)) return invalid();
  nullableUuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.at);
}

function imageMetadata(value: unknown): void {
  const item = record(value, ["provider", "api", "model", "modelSnapshot", "providerRequestId", "inputTokens", "outputTokens", "totalTokens", "receivedAt"]);
  enumValue(item.provider, ["openai"]); enumValue(item.api, ["images"]); enumValue(item.model, ["gpt-image-2"]);
  enumValue(item.modelSnapshot, ["gpt-image-2-2026-04-21"]); if (item.providerRequestId !== null) stringValue(item.providerRequestId, 200);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) if (item[key] !== null) integer(item[key], 0);
  timestamp(item.receivedAt);
}

function assessmentMetadata(value: unknown): void {
  const item = record(value, ["provider", "api", "model", "modelSnapshot", "providerRequestId", "inputTokens", "outputTokens", "totalTokens", "receivedAt"]);
  enumValue(item.provider, ["openai"]); enumValue(item.api, ["responses"]); enumValue(item.model, ["gpt-5.4-mini"]);
  enumValue(item.modelSnapshot, ["gpt-5.4-mini-2026-03-17"]); if (item.providerRequestId !== null) stringValue(item.providerRequestId, 200);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"]) if (item[key] !== null) integer(item[key], 0);
  timestamp(item.receivedAt);
}

const REVISION_COMMON_KEYS = [
  "revisionId", "projectId", "generationSetId", "confirmedBriefVersionId", "confirmedBriefContentHash",
  "geometrySnapshot", "geometryHash", "s2InputVersionId", "s2InputBindingHash", "sourceSnapshotId",
  "sourceBindingHash", "ultimateS1CandidateId", "sourceS2QaResultId", "sourceS2RepairAttemptId",
  "sourceS2ReQaResultId", "sourceS2DerivedCandidateId", "outputAssetId", "outputSha256", "outputByteSize",
  "outputWidth", "outputHeight", "outputPixelCount", "createdAt",
] as const;

function revisionCommon(value: RecordValue): void {
  uuid(value.revisionId); uuid(value.projectId); uuid(value.generationSetId); uuid(value.confirmedBriefVersionId);
  sha(value.confirmedBriefContentHash); geometry(value.geometrySnapshot); sha(value.geometryHash); uuid(value.s2InputVersionId);
  sha(value.s2InputBindingHash); uuid(value.sourceSnapshotId); sha(value.sourceBindingHash); uuid(value.ultimateS1CandidateId);
  uuid(value.sourceS2QaResultId); nullableUuid(value.sourceS2RepairAttemptId); nullableUuid(value.sourceS2ReQaResultId);
  nullableUuid(value.sourceS2DerivedCandidateId); uuid(value.outputAssetId); sha(value.outputSha256); integer(value.outputByteSize, 1);
  integer(value.outputWidth, 1); integer(value.outputHeight, 1); integer(value.outputPixelCount, 1); timestamp(value.createdAt);
}

function revision(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const kind = (value as RecordValue).kind;
  if (kind === "source_selection") {
    const item = record(value, [...REVISION_COMMON_KEYS, "kind", "lineageRootRevisionId", "parentRevisionId", "refinementCycleNumber", "refinementIntentText", "refinementIntentHash", "refinementInputHash", "compilerVersion", "promptHash", "providerMetadata", "outputAssetKind", "assessmentId"]);
    revisionCommon(item); uuid(item.lineageRootRevisionId); if (item.parentRevisionId !== null) return invalid();
    if (item.refinementCycleNumber !== 0) return invalid();
    if (item.refinementIntentText !== null || item.refinementIntentHash !== null || item.refinementInputHash !== null || item.compilerVersion !== null || item.promptHash !== null || item.providerMetadata !== null || item.assessmentId !== null) return invalid();
    enumValue(item.outputAssetKind, ["s1_concept_asset", "s2_derived_candidate"]);
  } else if (kind === "refinement") {
    const item = record(value, [...REVISION_COMMON_KEYS, "kind", "lineageRootRevisionId", "parentRevisionId", "refinementCycleNumber", "refinementIntentText", "refinementIntentHash", "refinementInputHash", "compilerVersion", "promptHash", "providerMetadata", "outputAssetKind", "assessmentId"]);
    revisionCommon(item); uuid(item.lineageRootRevisionId); uuid(item.parentRevisionId);
    if (item.refinementCycleNumber !== 1 && item.refinementCycleNumber !== 2) return invalid();
    stringValue(item.refinementIntentText, 600); sha(item.refinementIntentHash); sha(item.refinementInputHash);
    enumValue(item.compilerVersion, ["s3-refinement-v1"]); sha(item.promptHash); imageMetadata(item.providerMetadata);
    enumValue(item.outputAssetKind, ["s3_refinement_asset"]); uuid(item.assessmentId);
  } else return invalid();
}

function generatedAsset(value: unknown): void {
  const item = record(value, ["assetId", "projectId", "revisionId", "generationSetId", "mediaProfile", "providerOutputSha256", "providerOutputBytes", "detectedMime", "normalizedSha256", "normalizedBytes", "width", "height", "pixelCount", "hasAlpha", "storageKeyNormalized", "createdAt"]);
  uuid(item.assetId); uuid(item.projectId); uuid(item.revisionId); uuid(item.generationSetId); enumValue(item.mediaProfile, ["s2-media-v1"]);
  sha(item.providerOutputSha256); integer(item.providerOutputBytes, 1); enumValue(item.detectedMime, ["image/png"]);
  sha(item.normalizedSha256); integer(item.normalizedBytes, 1); if (item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864) return invalid();
  bool(item.hasAlpha); stringValue(item.storageKeyNormalized, 2000); timestamp(item.createdAt);
}

function cycle(value: unknown): void {
  const item = record(value, ["cycleId", "projectId", "selectionStateId", "generationSetId", "lineageRootRevisionId", "cycleNumber", "baseRevisionId", "baseSelectionVersion", "refinementIntentText", "refinementIntentHash", "refinementInputHash", "compilerVersion", "promptHash", "status", "retryState", "retryWaivedReason", "imageOperationIds", "outputRevisionId", "assessmentId", "assessmentAttemptIds", "createdAt", "admittedAt", "updatedAt", "terminalAt"]);
  uuid(item.cycleId); uuid(item.projectId); uuid(item.selectionStateId); uuid(item.generationSetId); uuid(item.lineageRootRevisionId);
  if (item.cycleNumber !== 1 && item.cycleNumber !== 2) return invalid(); uuid(item.baseRevisionId); integer(item.baseSelectionVersion, 1);
  stringValue(item.refinementIntentText, 600); sha(item.refinementIntentHash); sha(item.refinementInputHash); enumValue(item.compilerVersion, ["s3-refinement-v1"]); sha(item.promptHash);
  enumValue(item.status, ["image_queued", "image_running", "image_retry_available", "publication_pending", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived"]);
  enumValue(item.retryState, ["none", "image_available", "assessment_available", "waived"]);
  if (item.retryWaivedReason !== null) enumValue(item.retryWaivedReason, ["reselected", "rolled_back", "later_cycle_started"]);
  tupleOf(item.imageOperationIds, [1, 2], uuid); nullableUuid(item.outputRevisionId); nullableUuid(item.assessmentId); tupleOf(item.assessmentAttemptIds, [0, 1, 2], uuid);
  timestamp(item.createdAt); timestamp(item.admittedAt); timestamp(item.updatedAt); nullableTimestamp(item.terminalAt);
}

function claimFields(item: RecordValue, status: "queued" | "running" | "terminal"): void {
  if (item.claimedBy !== null) stringValue(item.claimedBy, 200);
  if (item.claimedProcessId !== null) integer(item.claimedProcessId, 1);
  nullableUuid(item.claimToken); nullableTimestamp(item.claimedAt); nullableTimestamp(item.startedAt); nullableTimestamp(item.completedAt);
  const dispatch = enumValue(item.providerDispatchState, ["not_started", "may_have_started", "consumed"]);
  if (status === "queued") {
    if (dispatch !== "not_started" || item.claimedBy !== null || item.claimedProcessId !== null || item.claimToken !== null || item.claimedAt !== null || item.startedAt !== null || item.completedAt !== null) return invalid();
  } else if (status === "running") {
    if (dispatch === "consumed" || item.claimedBy === null || item.claimedProcessId === null || item.claimToken === null || item.claimedAt === null || item.startedAt === null || item.completedAt !== null) return invalid();
  } else {
    // A deterministic failure proven before beginProviderDispatch may be
    // terminalized as failed/not_started. Invoked or ambiguous work must
    // retain consumed dispatch accounting.
    if ((dispatch !== "consumed" && dispatch !== "not_started") || item.claimedBy !== null || item.claimedProcessId !== null || item.claimToken !== null || item.claimedAt !== null || item.completedAt === null) return invalid();
  }
}

function imageOperation(value: unknown): void {
  const item = record(value, ["operationId", "projectId", "cycleId", "generationSetId", "baseRevisionId", "baseSelectionVersion", "attempt", "retryOfOperationId", "operationInputHash", "refinementInputHash", "promptHash", "requestReferenceId", "status", "claimedBy", "claimedProcessId", "claimToken", "claimedAt", "startedAt", "completedAt", "providerDispatchState", "providerMetadata", "failureCode", "publicationId", "outputRevisionId", "outputAssetId", "createdAt"]);
  uuid(item.operationId); uuid(item.projectId); uuid(item.cycleId); uuid(item.generationSetId); uuid(item.baseRevisionId); integer(item.baseSelectionVersion, 1);
  if (item.attempt !== 1 && item.attempt !== 2) return invalid(); nullableUuid(item.retryOfOperationId); sha(item.operationInputHash); sha(item.refinementInputHash); sha(item.promptHash); uuid(item.requestReferenceId);
  const status = enumValue(item.status, ["queued", "running", "succeeded", "failed"]) as "queued" | "running" | "succeeded" | "failed";
  claimFields(item, status === "queued" ? "queued" : status === "running" ? "running" : "terminal");
  if (item.providerMetadata !== null) imageMetadata(item.providerMetadata); if (item.failureCode !== null) stringValue(item.failureCode, 200);
  nullableUuid(item.publicationId); nullableUuid(item.outputRevisionId); nullableUuid(item.outputAssetId); timestamp(item.createdAt);
}

function assessment(value: unknown): void {
  const item = record(value, ["assessmentId", "projectId", "generationSetId", "sourceSnapshotId", "revisionId", "outputAssetId", "outputSha256", "outputByteSize", "outputWidth", "outputHeight", "outputPixelCount", "sourceS2QaResultId", "sourceS2ReQaResultId", "s2InputVersionId", "confirmedBriefVersionId", "confirmedBriefContentHash", "geometrySnapshot", "geometryHash", "canonicalRequirements", "requirementHash", "designRulesVersion", "designRuleSnapshot", "designRuleSnapshotHash", "sourceBindingHash", "refinementInputHash", "refinementIntentHash", "assessmentCompilerVersion", "assessmentSchema", "assessmentSchemaName", "assessmentInputHash", "assessmentPromptHash", "attemptIds", "latestAttemptId", "status", "retryState", "retryWaivedReason", "createdAt", "updatedAt"]);
  uuid(item.assessmentId); uuid(item.projectId); uuid(item.generationSetId); uuid(item.sourceSnapshotId); uuid(item.revisionId); uuid(item.outputAssetId); sha(item.outputSha256); integer(item.outputByteSize, 1);
  if (item.outputWidth !== 1536 || item.outputHeight !== 1024 || item.outputPixelCount !== 1_572_864) return invalid(); uuid(item.sourceS2QaResultId); nullableUuid(item.sourceS2ReQaResultId); uuid(item.s2InputVersionId); uuid(item.confirmedBriefVersionId); sha(item.confirmedBriefContentHash); geometry(item.geometrySnapshot); sha(item.geometryHash);
  array(item.canonicalRequirements).forEach(requirement); sha(item.requirementHash); enumValue(item.designRulesVersion, ["s2-design-rules-v1"]); array(item.designRuleSnapshot).forEach(designRule); sha(item.designRuleSnapshotHash); sha(item.sourceBindingHash); sha(item.refinementInputHash); sha(item.refinementIntentHash);
  enumValue(item.assessmentCompilerVersion, ["s3-assessment-v1"]); enumValue(item.assessmentSchema, ["s3-assessment-v1"]); enumValue(item.assessmentSchemaName, ["s3_assessment_v1"]); sha(item.assessmentInputHash); sha(item.assessmentPromptHash); tupleOf(item.attemptIds, [1, 2], uuid); uuid(item.latestAttemptId);
  enumValue(item.status, ["pending", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"]); enumValue(item.retryState, ["none", "available", "waived"]); if (item.retryWaivedReason !== null) enumValue(item.retryWaivedReason, ["reselected", "rolled_back", "later_cycle_started"]); timestamp(item.createdAt); timestamp(item.updatedAt);
}

function assessmentAttempt(value: unknown): void {
  const item = record(value, ["assessmentAttemptId", "assessmentId", "projectId", "revisionId", "outputAssetId", "outputSha256", "outputByteSize", "outputWidth", "outputHeight", "outputPixelCount", "attempt", "retryOfAttemptId", "operationInputHash", "assessmentInputHash", "assessmentPromptHash", "assessmentCompilerVersion", "assessmentSchema", "assessmentSchemaName", "requestReferenceId", "status", "disposition", "claimedBy", "claimedProcessId", "claimToken", "claimedAt", "startedAt", "completedAt", "providerDispatchState", "requirementObservations", "designObservations", "materialFindingIds", "warningFindingIds", "uncertainFindingIds", "failureCode", "providerMetadata", "createdAt"]);
  uuid(item.assessmentAttemptId); uuid(item.assessmentId); uuid(item.projectId); uuid(item.revisionId); uuid(item.outputAssetId); sha(item.outputSha256); integer(item.outputByteSize, 1); if (item.outputWidth !== 1536 || item.outputHeight !== 1024 || item.outputPixelCount !== 1_572_864) return invalid();
  if (item.attempt !== 1 && item.attempt !== 2) return invalid(); nullableUuid(item.retryOfAttemptId); sha(item.operationInputHash); sha(item.assessmentInputHash); sha(item.assessmentPromptHash); enumValue(item.assessmentCompilerVersion, ["s3-assessment-v1"]); enumValue(item.assessmentSchema, ["s3-assessment-v1"]); enumValue(item.assessmentSchemaName, ["s3_assessment_v1"]); uuid(item.requestReferenceId);
  const status = enumValue(item.status, ["queued", "running", "succeeded", "failed"]) as "queued" | "running" | "succeeded" | "failed";
  enumValue(item.disposition, ["pending", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"]); claimFields(item, status === "queued" ? "queued" : status === "running" ? "running" : "terminal");
  array(item.requirementObservations).forEach(requirementObservation); array(item.designObservations).forEach(designObservation); stringArray(item.materialFindingIds, 200); stringArray(item.warningFindingIds, 200); stringArray(item.uncertainFindingIds, 200); if (item.failureCode !== null) stringValue(item.failureCode, 200); if (item.providerMetadata !== null) assessmentMetadata(item.providerMetadata); timestamp(item.createdAt);
}

function publicationObject(value: unknown): void {
  const item = record(value, ["key", "sha256", "byteSize", "width", "height", "pixelCount"]);
  stringValue(item.key, 2000); sha(item.sha256); integer(item.byteSize, 1); if (item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864) return invalid();
}

function publication(value: unknown): void {
  const item = record(value, ["publicationId", "projectId", "cycleId", "operationId", "inputHash", "providerOutputSha256", "providerOutputBytes", "normalizedSha256", "normalizedBytes", "width", "height", "pixelCount", "hasAlpha", "intendedAssetId", "intendedRevisionId", "intendedAssessmentId", "intendedAssessmentAttemptId", "stagingObjects", "finalObjects", "ownerProcessId", "ownerClaimToken", "ownerClaimedAt", "state", "createdAt", "updatedAt"]);
  uuid(item.publicationId); uuid(item.projectId); uuid(item.cycleId); uuid(item.operationId); sha(item.inputHash); sha(item.providerOutputSha256); integer(item.providerOutputBytes, 1); sha(item.normalizedSha256); integer(item.normalizedBytes, 1); if (item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864) return invalid(); bool(item.hasAlpha); uuid(item.intendedAssetId); uuid(item.intendedRevisionId); uuid(item.intendedAssessmentId); uuid(item.intendedAssessmentAttemptId); tupleOf(item.stagingObjects, [1], publicationObject); tupleOf(item.finalObjects, [1], publicationObject); if (item.ownerProcessId !== null) integer(item.ownerProcessId, 1); nullableUuid(item.ownerClaimToken); nullableTimestamp(item.ownerClaimedAt); enumValue(item.state, ["staged", "promoted", "committed", "aborted"]); timestamp(item.createdAt); timestamp(item.updatedAt);
}

function transition(value: unknown): void {
  const item = record(value, ["transitionId", "projectId", "cycleId", "operationId", "assessmentId", "assessmentAttemptId", "publicationId", "phase", "attempt", "from", "to", "reason", "requestReferenceId", "at"]);
  uuid(item.transitionId); uuid(item.projectId); nullableUuid(item.cycleId); nullableUuid(item.operationId); nullableUuid(item.assessmentId); nullableUuid(item.assessmentAttemptId); nullableUuid(item.publicationId); enumValue(item.phase, ["selection", "cycle", "image", "publication", "assessment"]); if (item.attempt !== null && item.attempt !== 1 && item.attempt !== 2) return invalid();
  if (item.from !== null) stringValue(item.from, 100); stringValue(item.to, 100);
  if (item.reason !== null) { enumValue(item.reason, ["reselected", "rolled_back", "later_cycle_started"]); if (item.to !== "waived") return invalid(); }
  else if (item.to === "waived") return invalid();
  uuid(item.requestReferenceId); timestamp(item.at);
}

const VALIDATORS: Readonly<Record<string, (value: unknown) => void>> = {
  s3Sources: source,
  s3Selections: selection,
  s3SelectionEvents: selectionEvent,
  s3Revisions: revision,
  s3Assets: generatedAsset,
  s3Cycles: cycle,
  s3ImageOperations: imageOperation,
  s3Assessments: assessment,
  s3AssessmentAttempts: assessmentAttempt,
  s3Publications: publication,
  s3Transitions: transition,
};

export function validateS3Collections(parsed: RecordValue, merged: StoreState): void {
  if (Object.prototype.hasOwnProperty.call(parsed, "s3States") ||
      Object.prototype.hasOwnProperty.call(parsed, "s3Activations") ||
      Object.prototype.hasOwnProperty.call(parsed, "s3Idempotency")) return invalid();
  for (const [name, validate] of Object.entries(VALIDATORS)) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) array(parsed[name]).forEach(validate);
    if (!Array.isArray(merged[name as keyof StoreState])) return invalid();
  }
}

function uniqueIds(values: readonly unknown[], key: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "object" || value === null) return invalid();
    const id = (value as RecordValue)[key];
    if (typeof id !== "string" || seen.has(id)) return invalid();
    seen.add(id);
  }
}

/**
 * Cross-record S3 graph validation. The record validators above enforce the
 * closed persisted shape; this pass enforces ownership and immutable links.
 */
export function validateS3Graph(state: StoreState): void {
  for (const [name, validate] of Object.entries(VALIDATORS)) {
    const values = state[name as keyof StoreState];
    if (!Array.isArray(values)) return invalid();
    values.forEach(validate);
  }
  uniqueIds(state.s3Sources, "sourceSnapshotId"); uniqueIds(state.s3Selections, "selectionStateId"); uniqueIds(state.s3SelectionEvents, "eventId"); uniqueIds(state.s3Revisions, "revisionId"); uniqueIds(state.s3Assets, "assetId"); uniqueIds(state.s3Cycles, "cycleId"); uniqueIds(state.s3ImageOperations, "operationId"); uniqueIds(state.s3Assessments, "assessmentId"); uniqueIds(state.s3AssessmentAttempts, "assessmentAttemptId"); uniqueIds(state.s3Publications, "publicationId"); uniqueIds(state.s3Transitions, "transitionId");
  const projects = new Set(state.projects.map((item) => item.projectId));
  const sourceMap = new Map(state.s3Sources.map((item) => [item.sourceSnapshotId, item]));
  const revisionMap = new Map(state.s3Revisions.map((item) => [item.revisionId, item]));
  const selectionMap = new Map(state.s3Selections.map((item) => [item.selectionStateId, item]));
  const cycleMap = new Map(state.s3Cycles.map((item) => [item.cycleId, item]));
  const operationMap = new Map(state.s3ImageOperations.map((item) => [item.operationId, item]));
  const assessmentMap = new Map(state.s3Assessments.map((item) => [item.assessmentId, item]));
  const assetMap = new Map(state.s3Assets.map((item) => [item.assetId, item]));
  for (const item of state.s3Sources) {
    if (!projects.has(item.projectId) || item.canonicalSourceBinding.projectId !== item.projectId || item.canonicalSourceBinding.generationSetId !== item.generationSetId || item.canonicalSourceBinding.sourceKind !== item.sourceKind || item.canonicalSourceBinding.selectedAssetId !== item.selectedAssetId || item.canonicalSourceBinding.selectedSha256 !== item.selectedSha256) return invalid();
    const root = revisionMap.get(item.sourceRootRevisionId);
    if (!root || root.kind !== "source_selection" || root.sourceSnapshotId !== item.sourceSnapshotId || root.projectId !== item.projectId) return invalid();
  }
  for (const item of state.s3Selections) {
    if (!projects.has(item.projectId)) return invalid();
    if (item.activeRevisionId !== null) {
      const revision = revisionMap.get(item.activeRevisionId);
      if (!revision || revision.projectId !== item.projectId) return invalid();
    }
    if (item.lineageRootRevisionId !== null && !revisionMap.has(item.lineageRootRevisionId)) return invalid();
  }
  for (const item of state.s3Revisions) {
    const source = sourceMap.get(item.sourceSnapshotId);
    if (!source || source.projectId !== item.projectId || source.generationSetId !== item.generationSetId || source.sourceBindingHash !== item.sourceBindingHash) return invalid();
    if (item.kind === "source_selection") {
    if (item.lineageRootRevisionId !== item.revisionId) return invalid();
    } else {
      const parent = revisionMap.get(item.parentRevisionId);
      if (!parent || parent.projectId !== item.projectId || parent.generationSetId !== item.generationSetId || parent.sourceSnapshotId !== item.sourceSnapshotId || parent.lineageRootRevisionId !== item.lineageRootRevisionId || item.assessmentId === null) return invalid();
      const asset = assetMap.get(item.outputAssetId);
      if (!asset || asset.revisionId !== item.revisionId || asset.projectId !== item.projectId) return invalid();
    }
  }
  for (const item of state.s3Cycles) {
    const selection = selectionMap.get(item.selectionStateId);
    const root = revisionMap.get(item.lineageRootRevisionId);
    const base = revisionMap.get(item.baseRevisionId);
    if (!selection || selection.projectId !== item.projectId || !root || root.projectId !== item.projectId || !base || base.projectId !== item.projectId || base.lineageRootRevisionId !== item.lineageRootRevisionId) return invalid();
    for (const id of item.imageOperationIds) {
      const operation = operationMap.get(id);
      if (!operation || operation.cycleId !== item.cycleId || operation.projectId !== item.projectId) return invalid();
    }
    if (item.outputRevisionId !== null && !revisionMap.has(item.outputRevisionId)) return invalid();
    if (item.assessmentId !== null && !assessmentMap.has(item.assessmentId)) return invalid();
  }
  for (const item of state.s3ImageOperations) {
    const cycleValue = cycleMap.get(item.cycleId);
    if (!cycleValue || cycleValue.projectId !== item.projectId || item.generationSetId !== cycleValue.generationSetId || item.baseRevisionId !== cycleValue.baseRevisionId) return invalid();
    if (item.attempt === 1 && item.retryOfOperationId !== null) return invalid();
    if (item.attempt === 2 && item.retryOfOperationId === null) return invalid();
  }
  for (const item of state.s3Assets) {
    const revisionValue = revisionMap.get(item.revisionId);
    if (!revisionValue || revisionValue.kind !== "refinement" || revisionValue.outputAssetId !== item.assetId || revisionValue.projectId !== item.projectId) return invalid();
  }
  for (const item of state.s3Assessments) {
    const revisionValue = revisionMap.get(item.revisionId);
    if (!revisionValue || revisionValue.kind !== "refinement" || revisionValue.assessmentId !== item.assessmentId || revisionValue.outputAssetId !== item.outputAssetId || revisionValue.projectId !== item.projectId) return invalid();
    for (const id of item.attemptIds) {
      const attempt = state.s3AssessmentAttempts.find((value) => value.assessmentAttemptId === id);
      if (!attempt || attempt.assessmentId !== item.assessmentId || attempt.projectId !== item.projectId) return invalid();
    }
  }
  for (const item of state.s3AssessmentAttempts) {
    const assessmentValue = assessmentMap.get(item.assessmentId);
    if (!assessmentValue || assessmentValue.projectId !== item.projectId || assessmentValue.revisionId !== item.revisionId || assessmentValue.outputAssetId !== item.outputAssetId) return invalid();
    if (item.attempt === 1 && item.retryOfAttemptId !== null) return invalid();
    if (item.attempt === 2 && item.retryOfAttemptId === null) return invalid();
  }
  for (const item of state.s3Publications) {
    const cycleValue = cycleMap.get(item.cycleId);
    const operation = operationMap.get(item.operationId);
    if (!cycleValue || !operation || cycleValue.projectId !== item.projectId || operation.projectId !== item.projectId || operation.cycleId !== item.cycleId) return invalid();
  }
}
