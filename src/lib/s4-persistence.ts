import type { StoreState, UUID } from "./types";
import { uuidV4Pattern } from "./utils";

type AnyRecord = Record<string, unknown>;

const COLLECTIONS = [
  "s4Stages", "s4Masks", "s4Edits", "s4Revisions", "s4Assets",
  "s4ImageOperations", "s4PreservationChecks", "s4Assessments",
  "s4AssessmentAttempts", "s4Publications", "s4Transitions",
] as const;

const FORBIDDEN = ["s4Selections", "s4Activations", "s4Idempotency", "s4Sources"];
const SHA = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAILURE = [
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR",
  "PROVIDER_HTTP_ERROR", "PROVIDER_MALFORMED_RESPONSE", "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_CLIENT_ERROR", "PROVIDER_DISPATCH_UNCERTAIN", "IMAGE_EMPTY", "IMAGE_MALFORMED",
  "MEDIA_CORRUPT", "MEDIA_NORMALIZATION_FAILED", "S4_OUTPUT_DIMENSIONS_INVALID",
  "S4_IMAGE_INPUT_INTEGRITY_MISMATCH", "MEDIA_TOO_LARGE", "MEDIA_ANIMATED_NOT_ALLOWED",
  "MEDIA_DIMENSIONS_EXCEEDED", "MEDIA_PIXEL_LIMIT_EXCEEDED", "MEDIA_SIGNATURE_MISMATCH",
  "PUBLICATION_FAILED", "PUBLICATION_OBJECT_MISMATCH", "S4_FENCE_STALE", "S4_MASK_INVALID",
  "S4_MASK_COMPARISON_TOO_SMALL", "S4_PRESERVATION_DECODE_FAILED", "S4_NOOP_OUTPUT",
  "QA_PROVIDER_EMPTY", "QA_PROVIDER_INCOMPLETE", "QA_PROVIDER_REFUSED", "QA_SCHEMA_INVALID",
  "QA_RESULT_INCOMPLETE", "QA_INPUT_INTEGRITY_MISMATCH", "PERSISTENCE_FAILED",
] as const;

const KEYS: Record<string, readonly string[]> = {
  s4Stages: ["stageId", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "status", "s3RefinementClosed", "cyclesConsumed", "firstEditId", "createdAt", "startedAt", "updatedAt"],
  s4Masks: ["maskId", "editId", "projectId", "generationSetId", "selectionStateId", "sourceRevisionId", "sourceAssetId", "schemaVersion", "width", "height", "pixelCount", "protectedValue", "editableValue", "layout", "primitives", "primitiveCount", "brushPointCount", "primitiveHash", "rasterSha256", "rasterBytes", "rasterStorageKey", "providerPngVersion", "providerPngSha256", "providerPngBytes", "providerPngStorageKey", "editablePixelCount", "protectedPixelCount", "comparisonPixelCount", "maskIdentityHash", "createdAt"],
  s4Edits: ["editId", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "cycleNumber", "baseRevisionId", "baseRevisionKind", "baseSelectionVersion", "maskId", "maskIdentityHash", "maskMaterializationStatus", "instructionText", "instructionHash", "compilerVersion", "editInputHash", "promptHash", "providerRequestHash", "imageOperationIds", "outputRevisionId", "preservationCheckId", "assessmentId", "assessmentAttemptIds", "status", "retryState", "retryWaivedReason", "createdAt", "admittedAt", "updatedAt", "terminalAt"],
  s4Revisions: ["revisionId", "kind", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "parentRevisionId", "parentRevisionKind", "cycleNumber", "editId", "maskId", "maskIdentityHash", "instructionText", "instructionHash", "compilerVersion", "editInputHash", "promptHash", "providerRequestHash", "sourceQuality", "sourceAssetId", "sourceSha256", "sourceByteSize", "sourceWidth", "sourceHeight", "sourcePixelCount", "outputAssetId", "outputSha256", "outputByteSize", "outputWidth", "outputHeight", "outputPixelCount", "outputMediaProfile", "preservationCheckId", "assessmentId", "createdAt"],
  s4Assets: ["assetId", "projectId", "generationSetId", "revisionId", "mediaProfile", "providerOutputSha256", "providerOutputBytes", "detectedMime", "normalizedSha256", "normalizedBytes", "width", "height", "pixelCount", "hasAlpha", "storageKeyNormalized", "createdAt"],
  s4ImageOperations: ["operationId", "projectId", "editId", "generationSetId", "selectionStateId", "baseRevisionId", "baseSelectionVersion", "attempt", "retryOfOperationId", "operationInputHash", "editInputHash", "promptHash", "providerRequestHash", "requestReferenceId", "status", "claimedBy", "claimedProcessId", "claimToken", "claimedAt", "startedAt", "completedAt", "providerDispatchState", "providerMetadata", "failureCode", "publicationId", "outputRevisionId", "outputAssetId", "createdAt"],
  s4PreservationChecks: ["preservationCheckId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "sourceRevisionId", "sourceAssetId", "sourceSha256", "outputAssetId", "outputSha256", "maskId", "maskIdentityHash", "decoderProfile", "width", "height", "pixelCount", "guardRadiusPx", "rgbChannelTolerance", "alphaTolerance", "comparisonPixelMinimum", "comparedPixelCount", "differingPixelCount", "rgbDifferingPixelCount", "alphaDifferingPixelCount", "maxRgbDelta", "maxAlphaDelta", "aggregateDelta", "meanAggregateDeltaQ16", "componentCount", "largestComponentPixelCount", "severity", "noOpDetected", "status", "failureCode", "evidenceObject", "claimedBy", "claimedProcessId", "claimToken", "claimedAt", "createdAt", "startedAt", "completedAt"],
  s4Assessments: ["assessmentId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "sourceRevisionId", "outputAssetId", "sourceSha256", "outputSha256", "maskId", "maskIdentityHash", "instructionHash", "sourceQuality", "confirmedBriefVersionId", "confirmedBriefContentHash", "geometrySnapshot", "geometryHash", "canonicalRequirements", "requirementHash", "designRulesVersion", "designRuleSnapshot", "designRuleSnapshotHash", "assessmentCompilerVersion", "assessmentSchema", "assessmentSchemaName", "assessmentInputHash", "assessmentPromptHash", "attemptIds", "latestAttemptId", "noOpDetected", "requestedEditSatisfaction", "overallRequirementResult", "overallBuildabilityResult", "status", "retryState", "retryWaivedReason", "createdAt", "updatedAt"],
  s4AssessmentAttempts: ["assessmentAttemptId", "assessmentId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "outputAssetId", "sourceSha256", "outputSha256", "maskIdentityHash", "instructionHash", "assessmentInputHash", "assessmentPromptHash", "assessmentCompilerVersion", "assessmentSchema", "assessmentSchemaName", "operationInputHash", "attempt", "retryOfAttemptId", "requestReferenceId", "status", "disposition", "claimedBy", "claimedProcessId", "claimToken", "claimedAt", "startedAt", "completedAt", "providerDispatchState", "requirementObservations", "designObservations", "requestedEditSatisfaction", "overallRequirementResult", "overallBuildabilityResult", "materialFindingIds", "warningFindingIds", "uncertainFindingIds", "failureCode", "providerMetadata", "evidenceObject", "createdAt"],
  s4Publications: ["publicationId", "projectId", "generationSetId", "selectionStateId", "editId", "operationId", "inputHash", "providerOutputSha256", "providerOutputBytes", "normalizedSha256", "normalizedBytes", "width", "height", "pixelCount", "intendedAssetId", "intendedRevisionId", "intendedPreservationCheckId", "intendedAssessmentId", "stagingObjects", "finalObjects", "ownerProcessId", "ownerClaimToken", "ownerClaimedAt", "state", "createdAt", "updatedAt"],
  s4Transitions: ["transitionId", "projectId", "generationSetId", "selectionStateId", "editId", "operationId", "publicationId", "preservationCheckId", "assessmentId", "assessmentAttemptId", "phase", "attempt", "from", "to", "reason", "priorRevisionId", "resultingRevisionId", "expectedSelectionVersion", "resultingSelectionVersion", "requestReferenceId", "at"],
};

function fail(): never { throw new Error("invalid S4 persisted state"); }
function rec(value: unknown): AnyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  return value as AnyRecord;
}
function exact(value: unknown, keys: readonly string[]): AnyRecord {
  const result = rec(value); const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return fail();
  return result;
}
function arr(value: unknown): unknown[] { return Array.isArray(value) ? value : fail(); }
function uuid(value: unknown): void { if (typeof value !== "string" || !uuidV4Pattern.test(value)) fail(); }
function nullableUuid(value: unknown): void { if (value !== null) uuid(value); }
function sha(value: unknown): void { if (typeof value !== "string" || !SHA.test(value)) fail(); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(); }
function finite(value: unknown): void { if (typeof value !== "number" || !Number.isFinite(value)) fail(); }
function text(value: unknown, max = 4096): void { if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(); }
function boolean(value: unknown): void { if (typeof value !== "boolean") fail(); }
function oneOf(value: unknown, values: readonly string[]): void { if (typeof value !== "string" || !values.includes(value)) fail(); }
function literal(value: unknown, expected: unknown): void { if (value !== expected) fail(); }
function time(value: unknown): void { if (typeof value !== "string" || !TIME.test(value)) fail(); }
function key(value: unknown): void { text(value, 512); if (typeof value !== "string" || !value.startsWith("projects/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) fail(); }

function quality(value: unknown): void {
  const candidate = rec(value);
  if (candidate.kind === "s3_source") {
    const item = exact(candidate, ["kind", "sourceSnapshotId", "sourceRevisionId", "sourceBindingHash", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); sha(item.sourceBindingHash); oneOf(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  if (candidate.kind === "s3_refinement") {
    const item = exact(candidate, ["kind", "sourceSnapshotId", "sourceRevisionId", "sourceBindingHash", "assessmentId", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); sha(item.sourceBindingHash); uuid(item.assessmentId); oneOf(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  if (candidate.kind === "s4_local_edit") {
    const item = exact(candidate, ["kind", "sourceSnapshotId", "sourceRevisionId", "preservationCheckId", "assessmentId", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); uuid(item.preservationCheckId); uuid(item.assessmentId); oneOf(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  fail();
}

function geometry(value: unknown): void {
  const item = exact(value, ["widthMm", "depthMm", "openSides", "maxHeightMm"]);
  finite(item.widthMm); finite(item.depthMm); arr(item.openSides).forEach((side) => oneOf(side, ["north", "east", "south", "west"])); if (item.maxHeightMm !== null) finite(item.maxHeightMm);
}

function requirement(value: unknown): void {
  const item = exact(value, ["requirementId", "category", "expected", "expectedCount", "expectedValue", "criticality", "source", "text"]);
  text(item.requirementId, 128); oneOf(item.category, ["geometry", "functional", "mandatory", "prohibited", "free_text"]); oneOf(item.expected, ["present", "absent", "exact_count"]); if (item.expectedCount !== null) integer(item.expectedCount); if (item.expectedValue !== null && !["string", "number", "boolean"].includes(typeof item.expectedValue)) fail(); oneOf(item.criticality, ["material", "warning"]); oneOf(item.source, ["confirmed_brief", "geometry_snapshot"]); text(item.text, 1024);
}

function rule(value: unknown): void {
  const item = exact(value, ["ruleId", "applicability", "materiality", "repairable"]);
  text(item.ruleId, 128); oneOf(item.applicability, ["applicable", "not_applicable"]); oneOf(item.materiality, ["material", "warning"]); boolean(item.repairable);
}

function primitive(value: unknown): void {
  const candidate = rec(value);
  if (candidate.kind === "rectangle") {
    const item = exact(candidate, ["kind", "xQ16", "yQ16", "widthQ16", "heightQ16"]); integer(item.xQ16, 0, 65536); integer(item.yQ16, 0, 65536); integer(item.widthQ16, 1, 65536); integer(item.heightQ16, 1, 65536);
    if ((item.xQ16 as number) + (item.widthQ16 as number) > 65536 || (item.yQ16 as number) + (item.heightQ16 as number) > 65536) fail(); return;
  }
  if (candidate.kind === "brush") {
    const item = exact(candidate, ["kind", "radiusQ8", "points"]); integer(item.radiusQ8, 64, 25600); const points = arr(item.points); if (points.length < 1 || points.length > 1024) fail();
    points.forEach((point) => { const p = exact(point, ["xQ16", "yQ16"]); integer(p.xQ16, 0, 65536); integer(p.yQ16, 0, 65536); }); return;
  }
  fail();
}

function evidence(value: unknown): void { const item = exact(value, ["key", "sha256", "byteSize"]); key(item.key); sha(item.sha256); integer(item.byteSize, 1); }
function provider(value: unknown, kind: "image" | "assessment"): void {
  const fields = kind === "image" ? ["provider", "api", "model", "modelSnapshot", "providerRequestId", "inputTokens", "outputTokens", "totalTokens", "receivedAt"] : ["provider", "api", "model", "modelSnapshot", "providerRequestId", "inputTokens", "outputTokens", "totalTokens"];
  const item = exact(value, fields); literal(item.provider, "openai"); literal(item.api, kind === "image" ? "images" : "responses"); literal(item.model, kind === "image" ? "gpt-image-2" : "gpt-5.4-mini"); literal(item.modelSnapshot, kind === "image" ? "gpt-image-2-2026-04-21" : "gpt-5.4-mini-2026-03-17");
  if (item.providerRequestId !== null) text(item.providerRequestId, 200); for (const field of ["inputTokens", "outputTokens", "totalTokens"]) if (item[field] !== null) finite(item[field]); if (kind === "image") time(item.receivedAt);
}

function common(item: AnyRecord, idFields: readonly string[], hashFields: readonly string[], timeFields: readonly string[]): void {
  for (const field of idFields) item[field] === null ? undefined : uuid(item[field]);
  for (const field of hashFields) sha(item[field]);
  for (const field of timeFields) if (item[field] !== null) time(item[field]);
}

function validateRecord(name: string, value: unknown): void {
  const item = exact(value, KEYS[name]);
  if (name === "s4Stages") {
    common(item, ["stageId", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "firstEditId"], [], ["createdAt", "startedAt", "updatedAt"]);
    literal(item.status, "started"); literal(item.s3RefinementClosed, true); integer(item.cyclesConsumed, 1, 2); return;
  }
  if (name === "s4Masks") {
    common(item, ["maskId", "editId", "projectId", "generationSetId", "selectionStateId", "sourceRevisionId", "sourceAssetId"], ["primitiveHash", "rasterSha256", "providerPngSha256", "maskIdentityHash"], ["createdAt"]);
    literal(item.schemaVersion, "s4-mask-raster-v1"); literal(item.width, 1536); literal(item.height, 1024); literal(item.pixelCount, 1572864); literal(item.protectedValue, 0); literal(item.editableValue, 255); literal(item.layout, "row-major-top-left-one-byte-per-pixel");
    const primitives = arr(item.primitives); if (primitives.length < 1 || primitives.length > 64) fail(); primitives.forEach(primitive);
    const primitiveIds = primitives.map((value) => JSON.stringify(value)); if (new Set(primitiveIds).size !== primitiveIds.length) fail();
    integer(item.primitiveCount, 1, 64); if (item.primitiveCount !== primitives.length) fail();
    const brushPointCount = primitives.reduce<number>((count, value) => count + (rec(value).kind === "brush" ? arr(rec(value).points).length : 0), 0);
    integer(item.brushPointCount, 0, 4096); if (item.brushPointCount !== brushPointCount) fail();
    literal(item.rasterBytes, 1572864);
    key(item.rasterStorageKey); key(item.providerPngStorageKey);
    literal(item.rasterStorageKey, "projects/" + String(item.projectId) + "/s4/edits/" + String(item.editId) + "/mask/" + String(item.maskId) + "/raster.bin");
    literal(item.providerPngStorageKey, "projects/" + String(item.projectId) + "/s4/edits/" + String(item.editId) + "/mask/" + String(item.maskId) + "/provider.png");
    literal(item.providerPngVersion, "s4-mask-png-v1"); integer(item.providerPngBytes, 1, 16777216);
    integer(item.editablePixelCount, 256, 1179648); integer(item.protectedPixelCount, 0, 1572864);
    integer(item.comparisonPixelCount, 65536, 1572864); if ((item.editablePixelCount as number) + (item.protectedPixelCount as number) !== 1572864) fail();
    return;
  }
  if (name === "s4Edits") {
    common(item, ["editId", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "baseRevisionId", "maskId"], ["maskIdentityHash", "instructionHash", "editInputHash", "promptHash", "providerRequestHash"], ["createdAt", "admittedAt", "updatedAt", "terminalAt"]);
    integer(item.cycleNumber, 1, 2); oneOf(item.baseRevisionKind, ["s3", "s4"]); integer(item.baseSelectionVersion); oneOf(item.maskMaterializationStatus, ["pending", "ready"]); text(item.instructionText, 600); literal(item.compilerVersion, "s4-local-edit-v1");
    const imageIds = arr(item.imageOperationIds); const assessmentIds = arr(item.assessmentAttemptIds);
    if (imageIds.length > 2 || assessmentIds.length > 2) fail(); imageIds.forEach(uuid); assessmentIds.forEach(uuid);
    nullableUuid(item.outputRevisionId); nullableUuid(item.preservationCheckId); nullableUuid(item.assessmentId);
    oneOf(item.status, ["mask_materialization_pending", "image_queued", "image_running", "image_retry_available", "publication_pending", "preservation_pending", "preservation_running", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived"]);
    oneOf(item.retryState, ["none", "image_available", "assessment_available", "waived"]); if (item.retryWaivedReason !== null) oneOf(item.retryWaivedReason, ["rolled_back", "later_cycle_started", "selection_moved"]);
    if (item.maskMaterializationStatus === "pending" && imageIds.length !== 0) fail();
    if (item.maskMaterializationStatus === "ready" && imageIds.length !== 1 && imageIds.length !== 2) fail();
    return;
  }
  if (name === "s4Revisions") {
    common(item, ["revisionId", "projectId", "generationSetId", "selectionStateId", "sourceSnapshotId", "lineageRootRevisionId", "parentRevisionId", "editId", "maskId", "sourceAssetId", "outputAssetId", "preservationCheckId", "assessmentId"], ["maskIdentityHash", "instructionHash", "editInputHash", "promptHash", "providerRequestHash", "sourceSha256", "outputSha256"], ["createdAt"]);
    literal(item.kind, "s4_local_edit"); oneOf(item.parentRevisionKind, ["s3", "s4"]); integer(item.cycleNumber, 1, 2); text(item.instructionText, 600); literal(item.compilerVersion, "s4-local-edit-v1"); quality(item.sourceQuality); integer(item.sourceByteSize, 1); literal(item.sourceWidth, 1536); literal(item.sourceHeight, 1024); literal(item.sourcePixelCount, 1572864); integer(item.outputByteSize, 1); literal(item.outputWidth, 1536); literal(item.outputHeight, 1024); literal(item.outputPixelCount, 1572864); literal(item.outputMediaProfile, "s2-media-v1"); return;
  }
  if (name === "s4Assets") {
    common(item, ["assetId", "projectId", "generationSetId", "revisionId"], ["providerOutputSha256", "normalizedSha256"], ["createdAt"]);
    literal(item.mediaProfile, "s2-media-v1"); integer(item.providerOutputBytes, 1); literal(item.detectedMime, "image/png"); integer(item.normalizedBytes, 1); literal(item.width, 1536); literal(item.height, 1024); literal(item.pixelCount, 1572864); boolean(item.hasAlpha); key(item.storageKeyNormalized); return;
  }
  if (name === "s4ImageOperations") {
    common(item, ["operationId", "projectId", "editId", "generationSetId", "selectionStateId", "baseRevisionId", "requestReferenceId"], ["operationInputHash", "editInputHash", "promptHash", "providerRequestHash"], ["createdAt", "claimedAt", "startedAt", "completedAt"]);
    integer(item.baseSelectionVersion); integer(item.attempt, 1, 2); nullableUuid(item.retryOfOperationId); oneOf(item.status, ["queued", "running", "succeeded", "failed"]); if (item.claimedBy !== null) text(item.claimedBy, 200); if (item.claimedProcessId !== null) integer(item.claimedProcessId, 1); nullableUuid(item.claimToken); oneOf(item.providerDispatchState, ["not_started", "may_have_started", "consumed"]); if (item.providerMetadata !== null) provider(item.providerMetadata, "image"); if (item.failureCode !== null) oneOf(item.failureCode, FAILURE); nullableUuid(item.publicationId); nullableUuid(item.outputRevisionId); nullableUuid(item.outputAssetId); return;
  }
  if (name === "s4PreservationChecks") {
    common(item, ["preservationCheckId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "sourceRevisionId", "sourceAssetId", "outputAssetId", "maskId"], ["sourceSha256", "outputSha256", "maskIdentityHash"], ["createdAt", "claimedAt", "startedAt", "completedAt"]);
    literal(item.decoderProfile, "s4-rgba-v1"); literal(item.width, 1536); literal(item.height, 1024); literal(item.pixelCount, 1572864); literal(item.guardRadiusPx, 6); literal(item.rgbChannelTolerance, 8); literal(item.alphaTolerance, 8); literal(item.comparisonPixelMinimum, 65536);
    for (const field of ["comparedPixelCount", "differingPixelCount", "rgbDifferingPixelCount", "alphaDifferingPixelCount", "maxRgbDelta", "maxAlphaDelta", "aggregateDelta", "meanAggregateDeltaQ16", "componentCount", "largestComponentPixelCount"]) integer(item[field]); oneOf(item.severity, ["none", "tiny", "material", "catastrophic"]); if (item.noOpDetected !== null) boolean(item.noOpDetected); oneOf(item.status, ["pending", "running", "PASS", "MATERIAL_FAIL", "QA_UNAVAILABLE"]); if (item.failureCode !== null) oneOf(item.failureCode, FAILURE); if (item.evidenceObject !== null) evidence(item.evidenceObject); if (item.claimedBy !== null) text(item.claimedBy, 200); if (item.claimedProcessId !== null) integer(item.claimedProcessId, 1); nullableUuid(item.claimToken); return;
  }
  if (name === "s4Assessments") {
    common(item, ["assessmentId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "sourceRevisionId", "outputAssetId", "maskId", "confirmedBriefVersionId"], ["sourceSha256", "outputSha256", "maskIdentityHash", "instructionHash", "confirmedBriefContentHash", "geometryHash", "requirementHash", "designRuleSnapshotHash", "assessmentInputHash", "assessmentPromptHash"], ["createdAt", "updatedAt"]);
    quality(item.sourceQuality); geometry(item.geometrySnapshot); arr(item.canonicalRequirements).forEach(requirement); arr(item.designRuleSnapshot).forEach(rule); literal(item.designRulesVersion, "s2-design-rules-v1"); literal(item.assessmentCompilerVersion, "s4-assessment-v1"); literal(item.assessmentSchema, "s4-assessment-v1"); literal(item.assessmentSchemaName, "s4_local_edit_assessment_v1"); const attempts = arr(item.attemptIds); if (attempts.length > 2) fail(); attempts.forEach(uuid); nullableUuid(item.latestAttemptId); boolean(item.noOpDetected); if (item.requestedEditSatisfaction !== null) oneOf(item.requestedEditSatisfaction, ["satisfied", "not_satisfied", "uncertain", "not_verifiable"]); if (item.overallRequirementResult !== null) oneOf(item.overallRequirementResult, ["satisfied", "not_satisfied", "uncertain", "not_verifiable"]); if (item.overallBuildabilityResult !== null) oneOf(item.overallBuildabilityResult, ["buildable", "not_buildable", "uncertain", "not_verifiable"]); oneOf(item.status, ["not_started", "pending", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal", "skipped_preservation_fail"]); oneOf(item.retryState, ["none", "available", "waived"]); if (item.retryWaivedReason !== null) oneOf(item.retryWaivedReason, ["rolled_back", "later_cycle_started", "selection_moved"]); return;
  }
  if (name === "s4AssessmentAttempts") {
    common(item, ["assessmentAttemptId", "assessmentId", "projectId", "generationSetId", "selectionStateId", "editId", "revisionId", "outputAssetId", "requestReferenceId"], ["sourceSha256", "outputSha256", "maskIdentityHash", "instructionHash", "assessmentInputHash", "assessmentPromptHash", "operationInputHash"], ["createdAt", "claimedAt", "startedAt", "completedAt"]);
    literal(item.assessmentCompilerVersion, "s4-assessment-v1"); literal(item.assessmentSchema, "s4-assessment-v1"); literal(item.assessmentSchemaName, "s4_local_edit_assessment_v1"); integer(item.attempt, 1, 2); nullableUuid(item.retryOfAttemptId); oneOf(item.status, ["queued", "running", "succeeded", "failed"]); oneOf(item.disposition, ["pending", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"]); if (item.claimedBy !== null) text(item.claimedBy, 200); if (item.claimedProcessId !== null) integer(item.claimedProcessId, 1); nullableUuid(item.claimToken); oneOf(item.providerDispatchState, ["not_started", "may_have_started", "consumed"]); arr(item.requirementObservations).forEach((value) => observation(value, "requirement")); arr(item.designObservations).forEach((value) => observation(value, "rule")); if (item.requestedEditSatisfaction !== null) oneOf(item.requestedEditSatisfaction, ["satisfied", "not_satisfied", "uncertain", "not_verifiable"]); if (item.overallRequirementResult !== null) oneOf(item.overallRequirementResult, ["satisfied", "not_satisfied", "uncertain", "not_verifiable"]); if (item.overallBuildabilityResult !== null) oneOf(item.overallBuildabilityResult, ["buildable", "not_buildable", "uncertain", "not_verifiable"]); for (const field of ["materialFindingIds", "warningFindingIds", "uncertainFindingIds"]) arr(item[field]).forEach((value) => text(value, 128)); if (item.failureCode !== null) oneOf(item.failureCode, FAILURE); if (item.providerMetadata !== null) provider(item.providerMetadata, "assessment"); if (item.evidenceObject !== null) evidence(item.evidenceObject); return;
  }
  if (name === "s4Publications") {
    common(item, ["publicationId", "projectId", "generationSetId", "selectionStateId", "editId", "operationId", "intendedAssetId", "intendedRevisionId", "intendedPreservationCheckId", "intendedAssessmentId"], ["inputHash", "providerOutputSha256", "normalizedSha256"], ["createdAt", "updatedAt"]);
    integer(item.providerOutputBytes, 1); integer(item.normalizedBytes, 1); literal(item.width, 1536); literal(item.height, 1024); literal(item.pixelCount, 1572864); const staging = arr(item.stagingObjects); const final = arr(item.finalObjects); if (staging.length !== 1 || final.length !== 1) fail(); staging.forEach(publicationObject); final.forEach(publicationObject); if (item.ownerProcessId !== null) integer(item.ownerProcessId, 1); nullableUuid(item.ownerClaimToken); if (item.ownerClaimedAt !== null) time(item.ownerClaimedAt); oneOf(item.state, ["staged", "promoted", "committed", "aborted"]); return;
  }
  if (name === "s4Transitions") {
    common(item, ["transitionId", "projectId", "generationSetId", "selectionStateId", "editId", "operationId", "publicationId", "preservationCheckId", "assessmentId", "assessmentAttemptId", "requestReferenceId"], [], ["at"]);
    oneOf(item.phase, ["stage", "edit", "image", "publication", "preservation", "assessment", "activation", "rollback"]);
    if (item.attempt !== null) integer(item.attempt, 1, 2);
    if (item.from !== null) oneOf(item.from, ["not_started", "started", "image_queued", "image_running", "image_retry_available", "publication_pending", "preservation_pending", "preservation_running", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived", "mask_materialization_pending", "queued", "running", "succeeded", "failed", "pending", "pass", "warning", "qa_unavailable_retryable", "qa_unavailable_terminal", "skipped_preservation_fail", "PASS", "WARNING", "MATERIAL_FAIL", "QA_UNAVAILABLE", "activation", "rollback"]);
    oneOf(item.to, ["not_started", "started", "image_queued", "image_running", "image_retry_available", "publication_pending", "preservation_pending", "preservation_running", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived", "mask_materialization_pending", "queued", "running", "succeeded", "failed", "pending", "pass", "warning", "qa_unavailable_retryable", "qa_unavailable_terminal", "skipped_preservation_fail", "PASS", "WARNING", "MATERIAL_FAIL", "QA_UNAVAILABLE", "activation", "rollback"]);
    if (item.reason !== null) oneOf(item.reason, ["admitted", "s3_closed", "image_started", "image_succeeded", "image_failed", "image_retry_admitted", "publication_started", "publication_committed", "publication_aborted", "mask_materialization_verified", "preservation_started", "preservation_pass", "preservation_material_fail", "preservation_unavailable", "assessment_started", "assessment_pass", "assessment_warning", "assessment_material_fail", "assessment_unavailable", "assessment_retry_admitted", "activation", "activation_stale", "rollback", "retry_waived", "fence_stale", "no_op"]);
    nullableUuid(item.priorRevisionId); nullableUuid(item.resultingRevisionId); if (item.expectedSelectionVersion !== null) integer(item.expectedSelectionVersion); if (item.resultingSelectionVersion !== null) integer(item.resultingSelectionVersion); return;
  }
  fail();
}

function observation(value: unknown, kind: "requirement" | "rule"): void {
  if (kind === "requirement") {
    const item = exact(value, ["requirementId", "expected", "expectedCount", "expectedValue", "observed", "observedCount", "confidence", "evidence"]);
    text(item.requirementId, 128); oneOf(item.expected, ["present", "absent", "exact_count"]); if (item.expectedCount !== null) integer(item.expectedCount); if (item.expectedValue !== null && !["string", "number", "boolean"].includes(typeof item.expectedValue)) fail(); oneOf(item.observed, ["present", "absent", "uncertain", "not_verifiable"]); if (item.observedCount !== null) integer(item.observedCount); finite(item.confidence); if ((item.confidence as number) < 0 || (item.confidence as number) > 1) fail(); text(item.evidence, 400); return;
  }
  const item = exact(value, ["ruleId", "observed", "confidence", "evidence"]); text(item.ruleId, 128); oneOf(item.observed, ["compliant", "non_compliant", "uncertain", "not_verifiable"]); finite(item.confidence); if ((item.confidence as number) < 0 || (item.confidence as number) > 1) fail(); text(item.evidence, 400);
}

function publicationObject(value: unknown): void { const item = exact(value, ["key", "sha256", "byteSize"]); key(item.key); sha(item.sha256); integer(item.byteSize, 1); }

export function validateS4Collections(parsed: Record<string, unknown>, state: StoreState): void {
  for (const name of FORBIDDEN) if (Object.prototype.hasOwnProperty.call(parsed, name)) fail();
  for (const name of COLLECTIONS) {
    if (Object.prototype.hasOwnProperty.call(parsed, name)) arr(parsed[name]).forEach((value) => validateRecord(name, value));
    if (!Array.isArray((state as unknown as Record<string, unknown>)[name])) fail();
  }
}

function recordBy(values: readonly unknown[], field: string, id: unknown): AnyRecord | undefined {
  const found = values.find((value) => typeof value === "object" && value !== null && !Array.isArray(value) && (value as AnyRecord)[field] === id);
  return found as AnyRecord | undefined;
}

function unique(values: readonly unknown[]): void {
  const ids = values.map((value) => String(value));
  if (new Set(ids).size !== ids.length) fail();
}

function contextEqual(left: AnyRecord, right: AnyRecord): boolean {
  return left.projectId === right.projectId &&
    left.generationSetId === right.generationSetId &&
    (left.selectionStateId === undefined || right.selectionStateId === undefined || left.selectionStateId === right.selectionStateId);
}

export function validateS4Graph(state: StoreState): void {
  unique(state.s4Stages.map((item) => item.stageId)); unique(state.s4Masks.map((item) => item.maskId)); unique(state.s4Edits.map((item) => item.editId));
  unique(state.s4Revisions.map((item) => item.revisionId)); unique(state.s4Assets.map((item) => item.assetId)); unique(state.s4ImageOperations.map((item) => item.operationId));
  unique(state.s4PreservationChecks.map((item) => item.preservationCheckId)); unique(state.s4Assessments.map((item) => item.assessmentId)); unique(state.s4AssessmentAttempts.map((item) => item.assessmentAttemptId)); unique(state.s4Publications.map((item) => item.publicationId)); unique(state.s4Transitions.map((item) => item.transitionId));
  unique([...state.s3Revisions.map((item) => item.revisionId), ...state.s4Revisions.map((item) => item.revisionId)]);
  unique([...state.s3Assets.map((item) => item.assetId), ...state.s4Assets.map((item) => item.assetId)]);
  unique(state.s4Stages.map((item) => [item.projectId, item.generationSetId, item.selectionStateId, item.lineageRootRevisionId].join("|")));

  for (const stage of state.s4Stages) {
    const selection = state.s3Selections.find((item) => item.selectionStateId === stage.selectionStateId);
    const source = state.s3Sources.find((item) => item.sourceSnapshotId === stage.sourceSnapshotId);
    const edits = state.s4Edits.filter((item) => item.projectId === stage.projectId && item.generationSetId === stage.generationSetId && item.selectionStateId === stage.selectionStateId && item.lineageRootRevisionId === stage.lineageRootRevisionId);
    const firstEdit = state.s4Edits.find((item) => item.editId === stage.firstEditId);
    const cycleNumbers = edits.map((item) => item.cycleNumber).sort((left, right) => left - right);
    if (!selection || !source || !contextEqual(stage as unknown as AnyRecord, selection as unknown as AnyRecord) || !contextEqual(stage as unknown as AnyRecord, source as unknown as AnyRecord) || selection.lineageRootRevisionId !== stage.lineageRootRevisionId) fail();
    if (edits.length !== stage.cyclesConsumed || edits.length < 1 || edits.length > 2 || cycleNumbers.some((value, index) => value !== index + 1) || !firstEdit || firstEdit.cycleNumber !== 1 || !contextEqual(firstEdit as unknown as AnyRecord, stage as unknown as AnyRecord)) fail();
  }
  for (const mask of state.s4Masks) {
    const edit = recordBy(state.s4Edits, "editId", mask.editId); const selection = state.s3Selections.find((item) => item.selectionStateId === mask.selectionStateId);
    const s3Base = recordBy(state.s3Revisions, "revisionId", mask.sourceRevisionId); const s4Base = recordBy(state.s4Revisions, "revisionId", mask.sourceRevisionId);
    const base = s3Base ?? s4Base;
    if (!edit || !selection || !base || !contextEqual(mask as unknown as AnyRecord, edit) || !contextEqual(mask as unknown as AnyRecord, selection as unknown as AnyRecord) || edit.maskId !== mask.maskId || edit.maskIdentityHash !== mask.maskIdentityHash || edit.baseRevisionId !== mask.sourceRevisionId || base.projectId !== mask.projectId || base.generationSetId !== mask.generationSetId || base.sourceSnapshotId !== edit.sourceSnapshotId || base.lineageRootRevisionId !== edit.lineageRootRevisionId || base.outputAssetId !== mask.sourceAssetId) fail();
  }
  for (const edit of state.s4Edits) {
    const stage = state.s4Stages.find((item) => item.projectId === edit.projectId && item.generationSetId === edit.generationSetId && item.selectionStateId === edit.selectionStateId && item.lineageRootRevisionId === edit.lineageRootRevisionId);
    const mask = recordBy(state.s4Masks, "maskId", edit.maskId); const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
    const s3Base = recordBy(state.s3Revisions, "revisionId", edit.baseRevisionId); const s4Base = recordBy(state.s4Revisions, "revisionId", edit.baseRevisionId);
    const base = s3Base ?? s4Base;
    if (!stage || !mask || !selection || !base || !contextEqual(edit as unknown as AnyRecord, stage as unknown as AnyRecord) || !contextEqual(edit as unknown as AnyRecord, mask) || !contextEqual(edit as unknown as AnyRecord, selection as unknown as AnyRecord) || stage.cyclesConsumed < edit.cycleNumber || edit.sourceSnapshotId !== base.sourceSnapshotId || edit.lineageRootRevisionId !== base.lineageRootRevisionId || edit.baseRevisionKind !== (s3Base ? "s3" : "s4") || edit.maskId !== mask.maskId || edit.maskIdentityHash !== mask.maskIdentityHash) fail();
    if (edit.baseRevisionKind === "s3" ? !s3Base || s4Base : !s4Base || s3Base) fail();
    for (const [index, id] of edit.imageOperationIds.entries()) {
      const operation = recordBy(state.s4ImageOperations, "operationId", id);
      const expectedAttempt = index + 1;
      if (!operation || operation.editId !== edit.editId || !contextEqual(operation, edit as unknown as AnyRecord) || operation.attempt !== expectedAttempt || (expectedAttempt === 1 ? operation.retryOfOperationId !== null : operation.retryOfOperationId !== edit.imageOperationIds[0])) fail();
    }
    for (const [index, id] of edit.assessmentAttemptIds.entries()) {
      const attempt = recordBy(state.s4AssessmentAttempts, "assessmentAttemptId", id);
      const expectedAttempt = index + 1;
      if (!attempt || attempt.editId !== edit.editId || !contextEqual(attempt, edit as unknown as AnyRecord) || attempt.attempt !== expectedAttempt || (expectedAttempt === 1 ? attempt.retryOfAttemptId !== null : attempt.retryOfAttemptId !== edit.assessmentAttemptIds[0])) fail();
    }
    const outputRevision = edit.outputRevisionId === null ? undefined : recordBy(state.s4Revisions, "revisionId", edit.outputRevisionId);
    const preservation = edit.preservationCheckId === null ? undefined : recordBy(state.s4PreservationChecks, "preservationCheckId", edit.preservationCheckId);
    const assessment = edit.assessmentId === null ? undefined : recordBy(state.s4Assessments, "assessmentId", edit.assessmentId);
    if (edit.outputRevisionId !== null && (!outputRevision || outputRevision.editId !== edit.editId || !contextEqual(outputRevision, edit as unknown as AnyRecord))) fail();
    if (edit.preservationCheckId !== null && (!preservation || preservation.editId !== edit.editId || !contextEqual(preservation, edit as unknown as AnyRecord))) fail();
    if (edit.assessmentId !== null && (!assessment || assessment.editId !== edit.editId || !contextEqual(assessment, edit as unknown as AnyRecord))) fail();
  }
  for (const revision of state.s4Revisions) {
    const edit = recordBy(state.s4Edits, "editId", revision.editId); const mask = recordBy(state.s4Masks, "maskId", revision.maskId); const asset = recordBy(state.s4Assets, "assetId", revision.outputAssetId);
    const parentS3 = recordBy(state.s3Revisions, "revisionId", revision.parentRevisionId); const parentS4 = recordBy(state.s4Revisions, "revisionId", revision.parentRevisionId);
    const parent = parentS3 ?? parentS4;
    const selection = state.s3Selections.find((item) => item.selectionStateId === revision.selectionStateId);
    if (!edit || !mask || !asset || !selection || !parent || !contextEqual(revision as unknown as AnyRecord, edit) || !contextEqual(revision as unknown as AnyRecord, mask) || !contextEqual(revision as unknown as AnyRecord, asset) || !contextEqual(revision as unknown as AnyRecord, selection as unknown as AnyRecord)) fail();
    if (revision.parentRevisionKind === "s3" ? !parentS3 || parentS4 : !parentS4 || parentS3) fail();
    if (revision.parentRevisionId === revision.revisionId || asset.revisionId !== revision.revisionId || edit.outputRevisionId !== revision.revisionId || revision.lineageRootRevisionId !== selection.lineageRootRevisionId || revision.sourceSnapshotId !== edit.sourceSnapshotId || revision.cycleNumber !== edit.cycleNumber || revision.parentRevisionId !== edit.baseRevisionId || revision.parentRevisionKind !== edit.baseRevisionKind || revision.maskId !== edit.maskId || revision.maskIdentityHash !== edit.maskIdentityHash || revision.instructionText !== edit.instructionText || revision.instructionHash !== edit.instructionHash || revision.editInputHash !== edit.editInputHash || revision.promptHash !== edit.promptHash || revision.providerRequestHash !== edit.providerRequestHash || revision.sourceAssetId !== parent.outputAssetId || revision.sourceSha256 !== parent.outputSha256 || revision.sourceByteSize !== parent.outputByteSize || revision.outputSha256 !== asset.normalizedSha256 || revision.outputByteSize !== asset.normalizedBytes) fail();
  }
  for (const asset of state.s4Assets) {
    const revision = recordBy(state.s4Revisions, "revisionId", asset.revisionId); if (!revision || !contextEqual(asset as unknown as AnyRecord, revision) || revision.outputAssetId !== asset.assetId || revision.outputSha256 !== asset.normalizedSha256 || revision.outputByteSize !== asset.normalizedBytes || asset.storageKeyNormalized !== "projects/" + String(asset.projectId) + "/s4/edits/" + String(revision.editId) + "/revisions/" + String(revision.revisionId) + "/normalized.png") fail();
  }
  for (const operation of state.s4ImageOperations) {
    const edit = state.s4Edits.find((item) => item.editId === operation.editId); const selection = state.s3Selections.find((item) => item.selectionStateId === operation.selectionStateId);
    const imageOperationIds = edit?.imageOperationIds as readonly UUID[] | undefined;
    const operationIndex = imageOperationIds?.indexOf(operation.operationId) ?? -1;
    if (!edit || !selection || operationIndex < 0 || !contextEqual(operation as unknown as AnyRecord, edit) || !contextEqual(operation as unknown as AnyRecord, selection as unknown as AnyRecord) || edit.baseRevisionId !== operation.baseRevisionId || edit.baseSelectionVersion !== operation.baseSelectionVersion || operation.attempt !== operationIndex + 1 || operation.editInputHash !== edit.editInputHash || operation.promptHash !== edit.promptHash || operation.providerRequestHash !== edit.providerRequestHash || (operation.attempt === 1 ? operation.retryOfOperationId !== null : operation.retryOfOperationId !== imageOperationIds?.[0])) fail();
    if (operation.publicationId !== null) {
      const publication = recordBy(state.s4Publications, "publicationId", operation.publicationId);
      if (!publication || publication.operationId !== operation.operationId || !contextEqual(publication, operation)) fail();
    }
    if (operation.outputRevisionId !== null || operation.outputAssetId !== null) {
      const revision = operation.outputRevisionId === null ? undefined : recordBy(state.s4Revisions, "revisionId", operation.outputRevisionId);
      const asset = operation.outputAssetId === null ? undefined : recordBy(state.s4Assets, "assetId", operation.outputAssetId);
      if (!revision || !asset || revision.editId !== edit.editId || revision.outputAssetId !== asset.assetId || edit.outputRevisionId !== revision.revisionId) fail();
    }
  }
  for (const check of state.s4PreservationChecks) {
    const edit = state.s4Edits.find((item) => item.editId === check.editId); const revision = state.s4Revisions.find((item) => item.revisionId === check.revisionId); const mask = state.s4Masks.find((item) => item.maskId === check.maskId);
    const sourceS3 = state.s3Revisions.find((item) => item.revisionId === check.sourceRevisionId); const sourceS4 = state.s4Revisions.find((item) => item.revisionId === check.sourceRevisionId); const source = sourceS3 ?? sourceS4;
    const outputAsset = state.s4Assets.find((item) => item.assetId === check.outputAssetId);
    if (!edit || !revision || !mask || !source || !outputAsset || !contextEqual(check as unknown as AnyRecord, edit) || !contextEqual(check as unknown as AnyRecord, revision) || edit.preservationCheckId !== check.preservationCheckId || revision.preservationCheckId !== check.preservationCheckId || check.outputAssetId !== revision.outputAssetId || check.sourceRevisionId !== edit.baseRevisionId || check.sourceAssetId !== source.outputAssetId || check.sourceSha256 !== source.outputSha256 || check.outputSha256 !== outputAsset.normalizedSha256 || check.maskIdentityHash !== mask.maskIdentityHash || !contextEqual(check as unknown as AnyRecord, outputAsset)) fail();
    if (check.evidenceObject !== null && check.evidenceObject.key !== "projects/" + String(check.projectId) + "/s4/edits/" + String(edit.editId) + "/revisions/" + String(revision.revisionId) + "/preservation/" + String(check.preservationCheckId) + "/evidence.json") fail();
  }
  for (const assessment of state.s4Assessments) {
    const edit = state.s4Edits.find((item) => item.editId === assessment.editId); const revision = state.s4Revisions.find((item) => item.revisionId === assessment.revisionId); const mask = state.s4Masks.find((item) => item.maskId === assessment.maskId);
    const sourceS3 = state.s3Revisions.find((item) => item.revisionId === assessment.sourceRevisionId); const sourceS4 = state.s4Revisions.find((item) => item.revisionId === assessment.sourceRevisionId); const source = sourceS3 ?? sourceS4;
    const outputAsset = state.s4Assets.find((item) => item.assetId === assessment.outputAssetId);
    const selection = state.s3Selections.find((item) => item.selectionStateId === assessment.selectionStateId);
    if (!edit || !revision || !mask || !source || !outputAsset || !selection || !contextEqual(assessment as unknown as AnyRecord, edit) || !contextEqual(assessment as unknown as AnyRecord, revision) || edit.assessmentId !== assessment.assessmentId || revision.assessmentId !== assessment.assessmentId || assessment.sourceRevisionId !== edit.baseRevisionId || assessment.sourceSha256 !== source.outputSha256 || assessment.outputAssetId !== revision.outputAssetId || assessment.outputSha256 !== outputAsset.normalizedSha256 || assessment.maskIdentityHash !== mask.maskIdentityHash || assessment.instructionHash !== edit.instructionHash || assessment.confirmedBriefVersionId !== selection.confirmedBriefVersionId || assessment.confirmedBriefContentHash !== selection.confirmedBriefContentHash || assessment.geometryHash !== selection.geometryHash || !contextEqual(assessment as unknown as AnyRecord, outputAsset)) fail();
    if (assessment.latestAttemptId !== null && assessment.latestAttemptId !== assessment.attemptIds[assessment.attemptIds.length - 1]) fail();
    if (assessment.attemptIds.length === 0 && assessment.latestAttemptId !== null) fail();
    if (assessment.attemptIds.length > 0 && (assessment.latestAttemptId === null || assessment.status === "not_started")) fail();
    const assessmentAttemptIds = edit.assessmentAttemptIds as readonly UUID[];
    const assessmentIds = assessment.attemptIds as readonly UUID[];
    if (assessmentAttemptIds.length !== assessmentIds.length || assessmentAttemptIds.some((id, index) => id !== assessmentIds[index])) fail();
    for (const id of assessment.attemptIds) { const attempt = recordBy(state.s4AssessmentAttempts, "assessmentAttemptId", id); if (!attempt || attempt.assessmentId !== assessment.assessmentId || !contextEqual(attempt, assessment as unknown as AnyRecord)) fail(); }
  }
  for (const attempt of state.s4AssessmentAttempts) {
    const assessment = state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId); if (!assessment || !contextEqual(attempt as unknown as AnyRecord, assessment as unknown as AnyRecord) || attempt.revisionId !== assessment.revisionId || attempt.outputAssetId !== assessment.outputAssetId) fail();
    const edit = assessment && state.s4Edits.find((item) => item.editId === assessment.editId);
    const firstAttempt = assessment && assessment.attemptIds[0] ? recordBy(state.s4AssessmentAttempts, "assessmentAttemptId", assessment.attemptIds[0]) : undefined;
    const assessmentIds = assessment.attemptIds as readonly UUID[];
    const editAssessmentAttemptIds = edit?.assessmentAttemptIds as readonly UUID[] | undefined;
    if (!edit || !editAssessmentAttemptIds?.includes(attempt.assessmentAttemptId) || attempt.sourceSha256 !== assessment.sourceSha256 || attempt.outputSha256 !== assessment.outputSha256 || attempt.maskIdentityHash !== assessment.maskIdentityHash || attempt.instructionHash !== assessment.instructionHash || attempt.assessmentInputHash !== assessment.assessmentInputHash || attempt.assessmentPromptHash !== assessment.assessmentPromptHash || attempt.attempt !== assessmentIds.indexOf(attempt.assessmentAttemptId) + 1 || (attempt.attempt === 1 ? attempt.retryOfAttemptId !== null : attempt.retryOfAttemptId !== assessmentIds[0]) || (attempt.attempt === 2 && (!firstAttempt || firstAttempt.attempt !== 1))) fail();
    if (attempt.evidenceObject !== null && attempt.evidenceObject.key !== "projects/" + String(attempt.projectId) + "/s4/edits/" + String(edit.editId) + "/revisions/" + String(attempt.revisionId) + "/assessment/" + String(assessment.assessmentId) + "/attempts/" + String(attempt.assessmentAttemptId) + "/evidence.json") fail();
  }
  for (const publication of state.s4Publications) {
    const edit = recordBy(state.s4Edits, "editId", publication.editId); const operation = recordBy(state.s4ImageOperations, "operationId", publication.operationId);
    if (!edit || !operation || !contextEqual(publication as unknown as AnyRecord, edit) || !contextEqual(publication as unknown as AnyRecord, operation) || operation.publicationId !== publication.publicationId || publication.inputHash !== operation.operationInputHash || publication.finalObjects[0].sha256 !== publication.normalizedSha256 || publication.finalObjects[0].byteSize !== publication.normalizedBytes || publication.stagingObjects[0].sha256 !== publication.normalizedSha256 || publication.stagingObjects[0].byteSize !== publication.normalizedBytes || publication.stagingObjects[0].key !== "projects/" + String(publication.projectId) + "/s4/staging/" + String(edit.editId) + "/" + String(operation.operationId) + "/output.png" || publication.finalObjects[0].key !== "projects/" + String(publication.projectId) + "/s4/edits/" + String(edit.editId) + "/revisions/" + String(publication.intendedRevisionId) + "/normalized.png") fail();
    if (publication.state === "committed") {
      const asset = recordBy(state.s4Assets, "assetId", publication.intendedAssetId); const revision = recordBy(state.s4Revisions, "revisionId", publication.intendedRevisionId); const check = recordBy(state.s4PreservationChecks, "preservationCheckId", publication.intendedPreservationCheckId); const assessment = recordBy(state.s4Assessments, "assessmentId", publication.intendedAssessmentId);
      if (!asset || !revision || !check || !assessment || asset.revisionId !== revision.revisionId || revision.outputAssetId !== asset.assetId || check.revisionId !== revision.revisionId || assessment.revisionId !== revision.revisionId || operation.outputRevisionId !== revision.revisionId || operation.outputAssetId !== asset.assetId) fail();
    }
  }
  for (const transition of state.s4Transitions) {
    const edit = transition.editId === null ? undefined : recordBy(state.s4Edits, "editId", transition.editId);
    const operation = transition.operationId === null ? undefined : recordBy(state.s4ImageOperations, "operationId", transition.operationId);
    const publication = transition.publicationId === null ? undefined : recordBy(state.s4Publications, "publicationId", transition.publicationId);
    const preservation = transition.preservationCheckId === null ? undefined : recordBy(state.s4PreservationChecks, "preservationCheckId", transition.preservationCheckId);
    const assessment = transition.assessmentId === null ? undefined : recordBy(state.s4Assessments, "assessmentId", transition.assessmentId);
    const attempt = transition.assessmentAttemptId === null ? undefined : recordBy(state.s4AssessmentAttempts, "assessmentAttemptId", transition.assessmentAttemptId);
    for (const value of [edit, operation, publication, preservation, assessment, attempt]) if (value && !contextEqual(value, transition as unknown as AnyRecord)) fail();
    if (transition.editId !== null && !edit || transition.operationId !== null && !operation || transition.publicationId !== null && !publication || transition.preservationCheckId !== null && !preservation || transition.assessmentId !== null && !assessment || transition.assessmentAttemptId !== null && !attempt) fail();
    if (operation && operation.editId !== transition.editId || publication && publication.operationId !== transition.operationId || preservation && preservation.editId !== transition.editId || assessment && assessment.editId !== transition.editId || attempt && attempt.assessmentId !== transition.assessmentId) fail();
    for (const revisionId of [transition.priorRevisionId, transition.resultingRevisionId]) {
      if (revisionId === null) continue;
      const revision = recordBy(state.s3Revisions, "revisionId", revisionId) ?? recordBy(state.s4Revisions, "revisionId", revisionId);
      const intendedPublicationRevision = publication && transition.phase === "publication" && publication.state !== "committed" && publication.state !== "aborted" && publication.intendedRevisionId === revisionId;
      if ((!revision && !intendedPublicationRevision) || revision && (revision.projectId !== transition.projectId || revision.generationSetId !== transition.generationSetId)) fail();
    }
  }
}
