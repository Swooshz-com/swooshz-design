import type { S2DesignRuleSnapshot, S2Requirement, S5ApprovalEvent, S5Artifact, S5FrozenGenerationContext, S5LayoutRequirement, StoreState } from "./types";
import { uuidV4Pattern, jcs, sha256 } from "./utils";

type RecordValue = Record<string, unknown>;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalid(): never { throw new Error("invalid S5 persisted state"); }
function record(value: unknown, keys: readonly string[]): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const actual = Object.keys(value as object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as RecordValue;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : invalid(); }
function stringValue(value: unknown, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) return invalid();
  return value;
}
function codePointString(value: unknown, max = 4096, allowEmpty = false): string {
  const result = stringValue(value, max, allowEmpty);
  if (Array.from(result).length > max || /[\u0000-\u001f\u007f]/u.test(result)) return invalid();
  return result;
}
function uuid(value: unknown): string { if (typeof value !== "string" || !uuidV4Pattern.test(value)) return invalid(); return value; }
function sha(value: unknown): string { if (typeof value !== "string" || !SHA256.test(value)) return invalid(); return value; }
function timestamp(value: unknown): string { if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return invalid(); return value; }
function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return invalid(); return value; }
function numberValue(value: unknown, minimum = Number.NEGATIVE_INFINITY): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return invalid(); return value; }
function enumValue(value: unknown, allowed: readonly string[]): string { const result = stringValue(value); if (!allowed.includes(result)) return invalid(); return result; }
function nullableUuid(value: unknown): void { if (value !== null) uuid(value); }
function nullableSha(value: unknown): void { if (value !== null) sha(value); }
function nullableTimestamp(value: unknown): void { if (value !== null) timestamp(value); }
function pathValue(value: unknown): string {
  const result = stringValue(value, 1024);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some((part) => !part || part === "." || part === "..")) return invalid();
  return result;
}

const GEOMETRY_KEYS = ["widthMm", "depthMm", "openSides", "maxHeightMm"] as const;
function validateGeometry(value: unknown): void {
  const item = record(value, GEOMETRY_KEYS); numberValue(item.widthMm, 1); numberValue(item.depthMm, 1);
  const sides = array(item.openSides); if (sides.length < 1 || sides.length > 4 || new Set(sides).size !== sides.length) return invalid();
  sides.forEach((side) => enumValue(side, ["north", "east", "south", "west"]));
  if (item.maxHeightMm !== null) numberValue(item.maxHeightMm, 1);
}

const REQUIREMENT_KEYS = ["requirementId", "category", "expected", "expectedCount", "expectedValue", "criticality", "source", "text"] as const;
function validateRequirement(value: unknown): void {
  const item = record(value, REQUIREMENT_KEYS); codePointString(item.requirementId, 160); enumValue(item.category, ["geometry", "functional", "mandatory", "prohibited", "free_text"]);
  const expected = enumValue(item.expected, ["present", "absent", "exact_count"]);
  if (item.expectedCount !== null) integer(item.expectedCount, 0);
  if (expected === "exact_count" && item.expectedCount === null) return invalid();
  if (expected !== "exact_count" && item.expectedCount !== null) return invalid();
  if (item.expectedValue !== null && !["string", "number", "boolean"].includes(typeof item.expectedValue)) return invalid();
  enumValue(item.criticality, ["material", "warning"]); enumValue(item.source, ["confirmed_brief", "geometry_snapshot"]); codePointString(item.text, 4096);
}

const LAYOUT_REQUIREMENT_KEYS = ["requirementId", "name", "details", "mandatory", "count", "countIsExact"] as const;
function validateLayoutRequirement(value: unknown): void {
  const item = record(value, LAYOUT_REQUIREMENT_KEYS); const id = codePointString(item.requirementId, 160);
  if (!/^brief\.functional\.\d{3}$/u.test(id)) return invalid();
  codePointString(item.name, 80); if (item.details !== null) codePointString(item.details, 400);
  if (typeof item.mandatory !== "boolean" || typeof item.countIsExact !== "boolean") return invalid();
  if (item.count !== null) integer(item.count, 0);
  if (item.countIsExact && item.count === null) return invalid();
}

const RULE_KEYS = ["ruleId", "applicability", "materiality", "repairable"] as const;
function validateRule(value: unknown): void { const item = record(value, RULE_KEYS); codePointString(item.ruleId, 160); enumValue(item.applicability, ["applicable", "not_applicable"]); enumValue(item.materiality, ["material", "warning"]); if (typeof item.repairable !== "boolean") return invalid(); }

const FACT_KEYS = ["projectName", "clientName", "eventName", "venueName", "eventLocation", "eventStartDate", "eventEndDate"] as const;
function validateFacts(value: unknown): void { const item = record(value, FACT_KEYS); codePointString(item.projectName, 200); for (const key of FACT_KEYS.slice(1)) if (item[key] !== null) codePointString(item[key], 240); }

function validateSourceQualityEvidence(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "s3_source") {
    const item = record(value, ["kind", "sourceSnapshotId", "sourceRevisionId", "sourceBindingHash", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); sha(item.sourceBindingHash); enumValue(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  if (kind === "s3_refinement") {
    const item = record(value, ["kind", "sourceSnapshotId", "sourceRevisionId", "sourceBindingHash", "assessmentId", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); sha(item.sourceBindingHash); uuid(item.assessmentId); enumValue(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  if (kind === "s4_local_edit") {
    const item = record(value, ["kind", "sourceSnapshotId", "sourceRevisionId", "preservationCheckId", "assessmentId", "status", "verdictRecordId"]);
    uuid(item.sourceSnapshotId); uuid(item.sourceRevisionId); uuid(item.preservationCheckId); uuid(item.assessmentId); enumValue(item.status, ["PASS", "WARNING"]); uuid(item.verdictRecordId); return;
  }
  return invalid();
}
const CONTEXT_KEYS = [
  "schemaVersion", "projectId", "generationSetId", "selectionStateId", "selectionVersion", "approvalEventId", "approvalGeneration", "eventSequence",
  "activeRevisionId", "activeRevisionKind", "sourceSnapshotId", "lineageRootRevisionId", "sourceBindingHash", "quality", "sourceQualityEvidence", "activeAssetId", "activeAssetStorageKey",
  "activeAssetSha256", "activeAssetByteSize", "activeAssetWidth", "activeAssetHeight", "activeAssetPixelCount", "confirmedBriefVersionId", "briefContentHash",
  "geometrySnapshot", "geometryHash", "canonicalRequirements", "requirementHash", "layoutRequirements", "layoutRequirementsHash", "designRulesVersion",
  "designRuleSnapshot", "designRuleSnapshotHash", "presentationFacts", "presentationFactsHash", "layoutRendererVersion", "svgRendererVersion", "pdfRendererVersion",
] as const;
function validateContext(value: unknown): void {
  const item = record(value, CONTEXT_KEYS); enumValue(item.schemaVersion, ["s5-generation-context-v1"]);
  uuid(item.projectId); uuid(item.generationSetId); uuid(item.selectionStateId); integer(item.selectionVersion, 1); uuid(item.approvalEventId); integer(item.approvalGeneration, 1); integer(item.eventSequence, 1);
  uuid(item.activeRevisionId); enumValue(item.activeRevisionKind, ["s3_source", "s3_refinement", "s4_local_edit"]); uuid(item.sourceSnapshotId); uuid(item.lineageRootRevisionId); sha(item.sourceBindingHash); enumValue(item.quality, ["PASS", "WARNING"]); validateSourceQualityEvidence(item.sourceQualityEvidence); if ((item.sourceQualityEvidence as RecordValue).status !== item.quality) return invalid();
  uuid(item.activeAssetId); pathValue(item.activeAssetStorageKey); sha(item.activeAssetSha256); integer(item.activeAssetByteSize, 0); if (item.activeAssetWidth !== 1536 || item.activeAssetHeight !== 1024 || item.activeAssetPixelCount !== 1572864) return invalid();
  uuid(item.confirmedBriefVersionId); sha(item.briefContentHash); validateGeometry(item.geometrySnapshot); sha(item.geometryHash);
  const requirements = array(item.canonicalRequirements); if (requirements.length > 128) return invalid(); requirements.forEach(validateRequirement); sha(item.requirementHash);
  const layout = array(item.layoutRequirements); if (layout.length > 64) return invalid(); layout.forEach(validateLayoutRequirement); sha(item.layoutRequirementsHash);
  enumValue(item.designRulesVersion, ["s2-design-rules-v1"]); const rules = array(item.designRuleSnapshot); if (rules.length > 128) return invalid(); rules.forEach(validateRule); sha(item.designRuleSnapshotHash);
  validateFacts(item.presentationFacts); sha(item.presentationFactsHash); enumValue(item.layoutRendererVersion, ["s5-concept-layout-v1"]); enumValue(item.svgRendererVersion, ["s5-layout-svg-v1"]); enumValue(item.pdfRendererVersion, ["s5-presentation-pdf-v1"]);
}

const APPROVAL_KEYS = [
  "schemaVersion", "eventId", "projectId", "generationSetId", "selectionStateId", "eventSequence", "approvalId", "priorApprovalEventId", "approvalGeneration",
  "observedSelectionVersion", "observedActiveRevisionId", "observedLineageRootRevisionId", "kind", "reopenReason", "generationContext", "generationContextHash",
  "idempotencyKey", "requestReferenceId", "occurredAt",
] as const;
function validateApprovalEvent(value: unknown): void {
  const item = record(value, APPROVAL_KEYS); enumValue(item.schemaVersion, ["s5-approval-event-v1"]); uuid(item.eventId); uuid(item.projectId); uuid(item.generationSetId); uuid(item.selectionStateId);
  integer(item.eventSequence, 1); uuid(item.approvalId); nullableUuid(item.priorApprovalEventId); integer(item.approvalGeneration, 1); integer(item.observedSelectionVersion, 1); uuid(item.observedActiveRevisionId); uuid(item.observedLineageRootRevisionId);
  const kind = enumValue(item.kind, ["approved", "reopened"]); if (item.reopenReason !== null) enumValue(item.reopenReason, ["user_requested", "upstream_change_detected", "artifact_invalidated"]);
  if (kind === "approved") { if (item.reopenReason !== null || item.generationContext === null || item.priorApprovalEventId !== null || item.approvalId !== item.eventId) return invalid(); validateContext(item.generationContext); if (item.generationContextHash !== sha256(jcs(item.generationContext))) return invalid(); }
  else if (item.reopenReason === null || item.generationContext !== null || item.priorApprovalEventId === null || item.approvalId !== item.priorApprovalEventId) return invalid();
  sha(item.generationContextHash); uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.occurredAt);
}

const ARTIFACT_KEYS = [
  "schemaVersion", "artifactId", "artifactGroupId", "projectId", "generationSetId", "selectionStateId", "selectionVersion", "activeRevisionId", "approvalEventId", "approvalGeneration", "generationContextHash", "planHash",
  "kind", "rendererVersion", "mimeType", "fileExtension", "fileName", "sourceLayoutGroupId", "artifactKey", "stagingKey", "outputSha256", "outputByteSize", "pageCount", "attempt", "retryOfArtifactId", "status", "publicationPhase",
  "workerId", "processId", "claimToken", "claimedAt", "startedAt", "stagedAt", "promotedAt", "completedAt", "terminalAt", "failureCode", "idempotencyKey", "requestReferenceId", "createdAt", "updatedAt",
] as const;
function validateArtifact(value: unknown): void {
  const item = record(value, ARTIFACT_KEYS); enumValue(item.schemaVersion, ["s5-artifact-v1"]); uuid(item.artifactId); uuid(item.artifactGroupId); uuid(item.projectId); uuid(item.generationSetId); uuid(item.selectionStateId); integer(item.selectionVersion, 1); uuid(item.activeRevisionId); uuid(item.approvalEventId); integer(item.approvalGeneration, 1); sha(item.generationContextHash); sha(item.planHash);
  const kind = enumValue(item.kind, ["plan_json", "plan_svg", "presentation_pdf"]); const renderer = enumValue(item.rendererVersion, ["s5-concept-layout-v1", "s5-layout-svg-v1", "s5-presentation-pdf-v1"]); const mime = enumValue(item.mimeType, ["application/json", "image/svg+xml", "application/pdf"]); const extension = enumValue(item.fileExtension, [".json", ".svg", ".pdf"]);
  const expected = kind === "plan_json" ? ["s5-concept-layout-v1", "application/json", ".json", "swooshz-concept-layout-plan.json"] : kind === "plan_svg" ? ["s5-layout-svg-v1", "image/svg+xml", ".svg", "swooshz-concept-layout-plan.svg"] : ["s5-presentation-pdf-v1", "application/pdf", ".pdf", "swooshz-concept-presentation.pdf"];
  if (renderer !== expected[0] || mime !== expected[1] || extension !== expected[2] || item.fileName !== expected[3]) return invalid();
  if (kind === "presentation_pdf" ? item.sourceLayoutGroupId === null : item.sourceLayoutGroupId !== null) return invalid(); nullableUuid(item.sourceLayoutGroupId); pathValue(item.artifactKey); pathValue(item.stagingKey); nullableSha(item.outputSha256); if (item.outputByteSize !== null) integer(item.outputByteSize, 0); if (item.pageCount !== null) integer(item.pageCount, 1); integer(item.attempt, 1); if (item.attempt !== 1 && item.attempt !== 2) return invalid(); nullableUuid(item.retryOfArtifactId);
  const status = enumValue(item.status, ["queued", "running", "staged", "committed", "failed_retryable", "failed_terminal", "aborted"]); const phase = enumValue(item.publicationPhase, ["none", "staged", "promoted", "committed", "aborted"]);
  if (item.workerId !== null) stringValue(item.workerId, 200); if (item.processId !== null) integer(item.processId, 1); nullableUuid(item.claimToken); nullableTimestamp(item.claimedAt); nullableTimestamp(item.startedAt); nullableTimestamp(item.stagedAt); nullableTimestamp(item.promotedAt); nullableTimestamp(item.completedAt); nullableTimestamp(item.terminalAt); if (item.failureCode !== null) stringValue(item.failureCode, 120); uuid(item.idempotencyKey); uuid(item.requestReferenceId); timestamp(item.createdAt); timestamp(item.updatedAt);
  if (status === "queued" && (phase !== "none" || item.claimToken !== null || item.workerId !== null || item.processId !== null)) return invalid();
  if (status === "running" && phase !== "none") return invalid();
  if (status === "staged" && (phase !== "staged" && phase !== "promoted" || item.outputSha256 === null || item.outputByteSize === null)) return invalid();
  if (status === "committed" && (phase !== "committed" || item.outputSha256 === null || item.outputByteSize === null || item.completedAt === null || item.terminalAt !== null || item.claimToken !== null || item.workerId !== null || item.processId !== null)) return invalid();
  if ((status === "failed_retryable" || status === "failed_terminal" || status === "aborted") && (item.terminalAt === null || phase !== "aborted")) return invalid();
  if (status !== "failed_retryable" && status !== "failed_terminal" && status !== "aborted" && item.terminalAt !== null) return invalid();
  const pageCount = item.pageCount;
  if (kind === "presentation_pdf" && pageCount !== null && (typeof pageCount !== "number" || pageCount < 5 || pageCount > 12)) return invalid();
}

export function validateS5Collections(parsedRecord: Record<string, unknown>, state: StoreState): void {
  if (Object.prototype.hasOwnProperty.call(parsedRecord, "s5ApprovalEvents")) array(state.s5ApprovalEvents).forEach(validateApprovalEvent);
  else if (!Array.isArray(state.s5ApprovalEvents)) return invalid();
  if (Object.prototype.hasOwnProperty.call(parsedRecord, "s5Artifacts")) array(state.s5Artifacts).forEach(validateArtifact);
  else if (!Array.isArray(state.s5Artifacts)) return invalid();
}

function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) return invalid(); }
function sameContextIdentity(event: S5ApprovalEvent, context: S5FrozenGenerationContext): void {
  if (context.projectId !== event.projectId || context.generationSetId !== event.generationSetId || context.selectionStateId !== event.selectionStateId || context.selectionVersion !== event.observedSelectionVersion || context.approvalEventId !== event.eventId || context.approvalGeneration !== event.approvalGeneration || context.eventSequence !== event.eventSequence || context.activeRevisionId !== event.observedActiveRevisionId || context.lineageRootRevisionId !== event.observedLineageRootRevisionId) return invalid();
}

function historicalSelectionObservationExists(state: StoreState, event: S5ApprovalEvent): boolean {
  const selection = state.s3Selections.find((item) => item.selectionStateId === event.selectionStateId && item.projectId === event.projectId && item.generationSetId === event.generationSetId);
  if (!selection) return false;
  if (selection.selectionVersion === event.observedSelectionVersion && selection.activeRevisionId === event.observedActiveRevisionId && selection.lineageRootRevisionId === event.observedLineageRootRevisionId) return true;
  if (state.s3SelectionEvents.some((item) => item.projectId === event.projectId && item.selectionStateId === event.selectionStateId && item.resultingSelectionVersion === event.observedSelectionVersion && item.toRevisionId === event.observedActiveRevisionId)) return true;
  return state.s4Transitions.some((item) => item.projectId === event.projectId && item.selectionStateId === event.selectionStateId && item.resultingSelectionVersion === event.observedSelectionVersion && item.resultingRevisionId === event.observedActiveRevisionId);
}

function validateSourceQualityGraph(state: StoreState, event: S5ApprovalEvent, context: S5FrozenGenerationContext): void {
  const evidence = context.sourceQualityEvidence;
  if (evidence.status !== context.quality || evidence.sourceSnapshotId !== context.sourceSnapshotId || evidence.sourceRevisionId !== context.activeRevisionId) return invalid();
  const expectedKind = evidence.kind === "s3_source" ? "s3_source" : evidence.kind === "s3_refinement" ? "s3_refinement" : "s4_local_edit";
  if (context.activeRevisionKind !== expectedKind) return invalid();
  const source = state.s3Sources.find((item) => item.projectId === event.projectId && item.sourceSnapshotId === evidence.sourceSnapshotId && item.generationSetId === event.generationSetId);
  if (!source || source.sourceRootRevisionId !== context.lineageRootRevisionId || source.sourceBindingHash !== context.sourceBindingHash || sha256(jcs(source.canonicalSourceBinding)) !== source.sourceBindingHash || source.canonicalSourceBinding.eligibilityVerdict !== (source.canonicalSourceBinding.eligibilityStatus === "pass" ? "PASS" : "WARNING")) return invalid();
  if (evidence.kind === "s3_source") {
    const revision = state.s3Revisions.find((item) => item.projectId === event.projectId && item.revisionId === evidence.sourceRevisionId);
    if (!revision || revision.kind !== "source_selection" || revision.generationSetId !== event.generationSetId || revision.lineageRootRevisionId !== revision.revisionId || revision.revisionId !== context.activeRevisionId || revision.sourceSnapshotId !== source.sourceSnapshotId || revision.sourceBindingHash !== source.sourceBindingHash || revision.outputAssetId !== context.activeAssetId || revision.outputSha256 !== context.activeAssetSha256 || revision.outputByteSize !== context.activeAssetByteSize || evidence.sourceBindingHash !== source.sourceBindingHash || evidence.verdictRecordId !== source.canonicalSourceBinding.eligibilityResultId || evidence.status !== source.canonicalSourceBinding.eligibilityVerdict) return invalid();
    return;
  }
  if (evidence.kind === "s3_refinement") {
    const revision = state.s3Revisions.find((item) => item.projectId === event.projectId && item.revisionId === evidence.sourceRevisionId);
    const assessment = state.s3Assessments.find((item) => item.projectId === event.projectId && item.assessmentId === evidence.assessmentId && item.revisionId === evidence.sourceRevisionId);
    if (!revision || revision.kind !== "refinement" || revision.generationSetId !== event.generationSetId || revision.lineageRootRevisionId !== context.lineageRootRevisionId || revision.revisionId !== context.activeRevisionId || revision.sourceSnapshotId !== source.sourceSnapshotId || revision.sourceBindingHash !== source.sourceBindingHash || revision.assessmentId !== evidence.assessmentId || revision.outputAssetId !== context.activeAssetId || revision.outputSha256 !== context.activeAssetSha256 || revision.outputByteSize !== context.activeAssetByteSize || !assessment || assessment.generationSetId !== event.generationSetId || assessment.sourceSnapshotId !== source.sourceSnapshotId || assessment.sourceBindingHash !== source.sourceBindingHash || assessment.outputAssetId !== context.activeAssetId || assessment.outputSha256 !== context.activeAssetSha256 || (assessment.status !== "pass" && assessment.status !== "warning") || evidence.sourceBindingHash !== source.sourceBindingHash || evidence.verdictRecordId !== assessment.assessmentId || evidence.status !== (assessment.status === "pass" ? "PASS" : "WARNING")) return invalid();
    return;
  }
  const revision = state.s4Revisions.find((item) => item.projectId === event.projectId && item.revisionId === evidence.sourceRevisionId);
  const preservation = state.s4PreservationChecks.find((item) => item.projectId === event.projectId && item.preservationCheckId === evidence.preservationCheckId && item.revisionId === evidence.sourceRevisionId);
  const assessment = state.s4Assessments.find((item) => item.projectId === event.projectId && item.assessmentId === evidence.assessmentId && item.revisionId === evidence.sourceRevisionId);
  if (!revision || revision.kind !== "s4_local_edit" || revision.generationSetId !== event.generationSetId || revision.selectionStateId !== event.selectionStateId || revision.lineageRootRevisionId !== context.lineageRootRevisionId || revision.revisionId !== context.activeRevisionId || revision.sourceSnapshotId !== source.sourceSnapshotId || revision.preservationCheckId !== evidence.preservationCheckId || revision.assessmentId !== evidence.assessmentId || revision.outputAssetId !== context.activeAssetId || revision.outputSha256 !== context.activeAssetSha256 || revision.outputByteSize !== context.activeAssetByteSize || !preservation || preservation.generationSetId !== event.generationSetId || preservation.selectionStateId !== event.selectionStateId || preservation.editId !== revision.editId || preservation.outputAssetId !== context.activeAssetId || preservation.outputSha256 !== context.activeAssetSha256 || preservation.status !== "PASS" || preservation.completedAt === null || !assessment || assessment.generationSetId !== event.generationSetId || assessment.selectionStateId !== event.selectionStateId || assessment.editId !== revision.editId || assessment.outputAssetId !== context.activeAssetId || assessment.outputSha256 !== context.activeAssetSha256 || (assessment.status !== "pass" && assessment.status !== "warning") || evidence.verdictRecordId !== assessment.assessmentId || evidence.status !== (assessment.status === "pass" ? "PASS" : "WARNING")) return invalid();
}
export function validateS5Graph(state: StoreState): void {
  unique(state.s5ApprovalEvents.map((item) => item.eventId)); unique(state.s5Artifacts.map((item) => item.artifactId));
  const eventsByProject = new Map<string, S5ApprovalEvent[]>();
  for (const event of state.s5ApprovalEvents) { const values = eventsByProject.get(event.projectId) ?? []; values.push(event); eventsByProject.set(event.projectId, values); }
  for (const [projectId, events] of eventsByProject) {
    const ordered = events.slice().sort((left, right) => left.eventSequence - right.eventSequence);
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index]; if (event.eventSequence !== index + 1 || event.projectId !== projectId) return invalid();
      const previous = ordered[index - 1];
      if (index === 0) {
        if (event.kind !== "approved" || event.approvalGeneration !== 1 || event.approvalId !== event.eventId || event.priorApprovalEventId !== null || event.generationContext === null) return invalid();
      } else if (event.kind === "reopened") {
        const prior = event.priorApprovalEventId === null ? null : state.s5ApprovalEvents.find((candidate) => candidate.eventId === event.priorApprovalEventId);
        if (!previous || previous.kind !== "approved" || !prior || prior.eventId !== previous.eventId || prior.projectId !== event.projectId || prior.generationSetId !== event.generationSetId || prior.selectionStateId !== event.selectionStateId || prior.approvalId !== event.approvalId || prior.approvalGeneration !== event.approvalGeneration || prior.observedSelectionVersion !== event.observedSelectionVersion || prior.observedActiveRevisionId !== event.observedActiveRevisionId || prior.observedLineageRootRevisionId !== event.observedLineageRootRevisionId || event.approvalGeneration !== previous.approvalGeneration || event.approvalId !== previous.approvalId || event.generationContext !== null || event.generationContextHash !== previous.generationContextHash || event.reopenReason === null) return invalid();
      } else if (!previous || previous.kind !== "reopened" || event.approvalGeneration !== previous.approvalGeneration + 1 || event.approvalId !== event.eventId || event.priorApprovalEventId !== null || event.generationContext === null) return invalid();
      const project = state.projects.find((item) => item.projectId === projectId); if (!project || !historicalSelectionObservationExists(state, event)) return invalid();
      if (event.kind === "approved") { if (!event.generationContext) return invalid(); sameContextIdentity(event, event.generationContext); if (event.generationContextHash !== sha256(jcs(event.generationContext))) return invalid(); validateSourceQualityGraph(state, event, event.generationContext); }
    }
  }
  const groups = new Map<string, S5Artifact[]>();
  for (const artifact of state.s5Artifacts) {
    const event = state.s5ApprovalEvents.find((item) => item.eventId === artifact.approvalEventId && item.projectId === artifact.projectId); if (!event || event.generationSetId !== artifact.generationSetId || event.selectionStateId !== artifact.selectionStateId || event.observedSelectionVersion !== artifact.selectionVersion || event.observedActiveRevisionId !== artifact.activeRevisionId || event.approvalGeneration !== artifact.approvalGeneration || event.generationContextHash !== artifact.generationContextHash) return invalid();
    const groupKey = artifact.projectId + ":" + artifact.artifactGroupId; const values = groups.get(groupKey) ?? []; values.push(artifact); groups.set(groupKey, values);
    if (["queued", "running", "staged"].includes(artifact.status) && values.filter((item) => item.kind === artifact.kind && ["queued", "running", "staged"].includes(item.status)).length > 1) return invalid();
    if (artifact.retryOfArtifactId !== null) { const prior = state.s5Artifacts.find((item) => item.artifactId === artifact.retryOfArtifactId); if (!prior || prior.artifactGroupId !== artifact.artifactGroupId || prior.kind !== artifact.kind || prior.attempt !== 1 || artifact.attempt !== 2 || prior.status === "queued" || prior.status === "running" || prior.status === "staged") return invalid(); }
  }
  for (const values of groups.values()) {
    const kinds = new Set(values.map((item) => item.kind));
    if (kinds.has("plan_json") || kinds.has("plan_svg")) {
      if (!kinds.has("plan_json") || !kinds.has("plan_svg") || kinds.has("presentation_pdf")) return invalid();
      const json = values.find((item) => item.kind === "plan_json")!; const svg = values.find((item) => item.kind === "plan_svg")!;
      const jsonKeyParts = json.artifactKey.split("/"); const svgKeyParts = svg.artifactKey.split("/");
      if (json.planHash !== svg.planHash || json.generationContextHash !== svg.generationContextHash || jsonKeyParts.length < 3 || svgKeyParts.length < 3 || jsonKeyParts.slice(0, -2).join("/") !== svgKeyParts.slice(0, -2).join("/") || jsonKeyParts.at(-2) !== "s5-concept-layout-v1" || jsonKeyParts.at(-1) !== "plan_json" || svgKeyParts.at(-2) !== "s5-layout-svg-v1" || svgKeyParts.at(-1) !== "plan_svg") return invalid();
    } else if (kinds.has("presentation_pdf")) {
      if (kinds.size !== 1) return invalid(); const pdf = values[0]; const source = state.s5Artifacts.filter((item) => item.projectId === pdf.projectId && item.artifactGroupId === pdf.sourceLayoutGroupId && (item.kind === "plan_json" || item.kind === "plan_svg"));
      if (!source.length || source.some((item) => item.generationSetId !== pdf.generationSetId || item.approvalEventId !== pdf.approvalEventId || item.planHash !== pdf.planHash || item.generationContextHash !== pdf.generationContextHash)) return invalid();
    }
  }
}
