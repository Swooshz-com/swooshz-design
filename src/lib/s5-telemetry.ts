import { jcs, sha256, uuidV4Pattern } from "./utils";
import type {
  GenerationOperation,
  GenerationSet,
  S2CandidateStatus,
  S2QaCandidateResult,
  S2QaRun,
  S2ReQaResult,
  S3Assessment,
  S3RefinementCycle,
  S3SelectionEvent,
  S4Assessment,
  S4EditAdmission,
  S4PreservationCheck,
  S5ApprovalEvent,
  S5Artifact,
  S5FrozenGenerationContext,
  StoreState,
  UUID,
} from "./types";

export type S5MetricValue<T> = { availability: "available" | "unavailable"; value: T | null; reason: string | null };
export type S5Metric = S5MetricValue<number>;
export type S5QaFailureCounts = { total: number; categories: Record<string, number> };
export type S5AcceptedRevisionMetricValue = { revisionId: UUID; revisionKind: S5FrozenGenerationContext["activeRevisionKind"]; lineageRootRevisionId: UUID; selectionVersion: number; quality: "PASS" | "WARNING" };
export type S5Telemetry = {
  conceptGenerationLatencyMs: S5Metric;
  queueInclusiveGenerationDurationMs: S5Metric;
  generationCount: S5Metric;
  regenerationCount: S5Metric;
  qaFailureCounts: S5MetricValue<S5QaFailureCounts>;
  s2RepairCount: S5Metric;
  refinementAdmittedCount: S5Metric;
  successfulRefinementCount: S5Metric;
  localEditCount: S5Metric;
  editSuccessCount: S5Metric;
  editFailureCount: S5Metric;
  editFailureCategories: S5MetricValue<Record<string, number>>;
  planFailureCount: S5Metric;
  planRetryCount: S5Metric;
  pdfFailureCount: S5Metric;
  pdfRetryCount: S5Metric;
  approvalCount: S5Metric;
  reopenCount: S5Metric;
  committedArtifactLatencyMs: S5Metric;
  terminalFailureLatencyMs: S5Metric;
  firstTimeToAcceptedConceptMs: S5Metric;
  acceptedRevision: S5MetricValue<S5AcceptedRevisionMetricValue>;
  providerCost: S5Metric;
  totalProjectGenerationCost: S5Metric;
  approvalToPlanMs: S5Metric;
  approvalToPdfMs: S5Metric;
  artifactFailureRate: S5Metric;
};

type UnknownRecord = Record<string, unknown>;
type ApprovedContextResolver = (approval: S5ApprovalEvent) => S5FrozenGenerationContext;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FAILURE_ARTIFACT_STATUSES = new Set(["failed_retryable", "failed_terminal", "aborted"]);
const TERMINAL_ARTIFACT_STATUSES = new Set(["committed", "failed_retryable", "failed_terminal", "aborted"]);


function available<T>(value: T): S5MetricValue<T> { return { availability: "available", value, reason: null }; }
function unavailable<T>(reason: string): S5MetricValue<T> { return { availability: "unavailable", value: null, reason }; }
function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("source_record_invalid");
  return value as UnknownRecord;
}
function array(state: StoreState, name: string): unknown[] {
  const value = record(state as unknown)[name];
  if (!Array.isArray(value)) throw new Error("source_collection_invalid");
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) throw new Error("timestamp_invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp_invalid");
  return parsed;
}
function optionalTimestamp(value: unknown): number | null { return value === null ? null : timestamp(value); }
function uuidValue(value: unknown): string {
  if (typeof value !== "string" || !uuidV4Pattern.test(value)) throw new Error("id_invalid");
  return value;
}
function shaValue(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("hash_invalid"); return value; }
function projectValue(value: unknown, projectId: UUID): boolean { return typeof value === "string" && value === projectId; }
function interval(start: unknown, end: unknown): S5Metric {
  try {
    const left = timestamp(start); const right = timestamp(end);
    if (right < left) return unavailable("malformed_interval");
    return available(right - left);
  } catch { return unavailable("timestamp_invalid"); }
}
function idsUnique(items: readonly UnknownRecord[], field: string): void {
  const ids = new Set<string>();
  for (const item of items) { const id = uuidValue(item[field]); if (ids.has(id)) throw new Error("duplicate_id"); ids.add(id); }
}
function generationSets(state: StoreState, projectId: UUID): GenerationSet[] {
  const sets = array(state, "generationSets").filter((item) => projectValue(record(item).projectId, projectId)) as GenerationSet[];
  idsUnique(sets.map((item) => record(item)), "generationSetId");
  for (const value of sets) {
    const item = record(value);
    uuidValue(item.generationSetId); uuidValue(item.projectId); uuidValue(item.confirmedBriefVersionId); uuidValue(item.generationRequestId);
    if (item.retryOfGenerationSetId !== null) uuidValue(item.retryOfGenerationSetId);
    if (!["queued", "running", "succeeded", "failed"].includes(String(item.status))) throw new Error("generation_set_status_invalid");
    if (item.attempt !== 1 && item.attempt !== 2) throw new Error("attempt_invalid");
    if (item.expectedCandidateCount !== 4) throw new Error("candidate_count_invalid");
    timestamp(item.createdAt); if (item.completedAt !== null) timestamp(item.completedAt);
    if ((item.status === "succeeded" || item.status === "failed") !== (item.completedAt !== null)) throw new Error("generation_terminal_shape");
    if (item.attempt === 1 && item.retryOfGenerationSetId !== null) throw new Error("generation_retry_shape");
    if (item.attempt === 2 && item.retryOfGenerationSetId === null) throw new Error("generation_retry_shape");
    if ((item.status === "queued" || item.status === "running") && item.completedAt !== null) throw new Error("generation_terminal_shape");
  }
  for (const value of sets) {
    const item = record(value);
    if (item.retryOfGenerationSetId !== null) {
      const prior = sets.find((candidate) => candidate.generationSetId === item.retryOfGenerationSetId);
      if (!prior || prior.attempt !== 1) throw new Error("generation_retry_link_invalid");
    }
  }
  return sets;
}
function generationOperations(state: StoreState, projectId: UUID): GenerationOperation[] {
  const operations = array(state, "generationOperations").filter((item) => projectValue(record(item).projectId, projectId)) as GenerationOperation[];
  idsUnique(operations.map((item) => record(item)), "generationSetId");
  for (const value of operations) {
    const item = record(value); uuidValue(item.generationSetId); uuidValue(item.projectId);
    if (item.attempt !== 1 && item.attempt !== 2) throw new Error("attempt_invalid");
    if (!["queued", "running", "succeeded", "failed"].includes(String(item.status))) throw new Error("operation_status_invalid");
    timestamp(item.createdAt); optionalTimestamp(item.startedAt); optionalTimestamp(item.completedAt);
    if (item.status === "queued" && (item.startedAt !== null || item.completedAt !== null)) throw new Error("operation_queued_shape");
    if (item.status === "running" && (item.startedAt === null || item.completedAt !== null)) throw new Error("operation_running_shape");
    if ((item.status === "succeeded" || item.status === "failed") && (item.startedAt === null || item.completedAt === null)) throw new Error("generation_operation_incomplete");
  }
  return operations;
}
function generationMetrics(state: StoreState, projectId: UUID): { count: S5Metric; retries: S5Metric; latency: S5Metric; queue: S5Metric } {
  let sets: GenerationSet[];
  try { sets = generationSets(state, projectId); } catch { return { count: unavailable("generation_set_source_invalid"), retries: unavailable("generation_set_source_invalid"), latency: unavailable("generation_set_source_invalid"), queue: unavailable("generation_set_source_invalid") }; }
  const count = available(sets.length);
  const retries = available(sets.filter((item) => item.attempt === 2).length);
  let queue: S5Metric;
  try {
    const completedSets = sets.filter((item) => item.completedAt !== null).sort((left, right) => timestamp(right.completedAt) - timestamp(left.completedAt));
    const queueIntervals = completedSets.map((item) => interval(item.createdAt, item.completedAt));
    const malformedQueue = queueIntervals.find((item) => item.availability === "unavailable");
    queue = malformedQueue ?? (completedSets.length ? queueIntervals[0]! : unavailable("no_completed_generation_set"));
  } catch { queue = unavailable("generation_set_source_invalid"); }
  let latency: S5Metric;
  try {
    const operations = generationOperations(state, projectId);
    for (const operation of operations) {
      const set = sets.find((candidate) => candidate.generationSetId === operation.generationSetId);
      if (!set || set.attempt !== operation.attempt) throw new Error("operation_generation_set_missing");
    }
    const completedOperations = operations.filter((item) => item.status === "succeeded" || item.status === "failed").sort((left, right) => timestamp(right.completedAt) - timestamp(left.completedAt));
    const malformed = completedOperations.map((item) => interval(item.startedAt, item.completedAt)).find((item) => item.availability === "unavailable");
    latency = malformed ?? (completedOperations.length ? interval(completedOperations[0]!.startedAt, completedOperations[0]!.completedAt) : unavailable("no_completed_generation_operation"));
  } catch { latency = unavailable("generation_operation_source_invalid"); }
  return { count, retries, latency, queue };
}
function candidateFailureStatus(status: unknown): string | null {
  if (status === "warning") return "warning";
  if (status === "material_fail") return "material_fail";
  if (status === "qa_unavailable_retryable" || status === "qa_unavailable_terminal" || status === "re_qa_unavailable") return "qa_unavailable";
  return null;
}
function qaFailureMetrics(state: StoreState, projectId: UUID): S5MetricValue<S5QaFailureCounts> {
  try {
    const allRuns = array(state, "s2QaRuns") as S2QaRun[];
    const runs = allRuns.filter((item) => projectValue(record(item).projectId, projectId));
    const reQa = (array(state, "s2ReQaResults") as S2ReQaResult[]).filter((item) => {
      const raw = record(item);
      const run = allRuns.find((candidate) => record(candidate).id === raw.qaRunId);
      if (!run) throw new Error("qa_run_link_invalid");
      return projectValue(record(run).projectId, projectId);
    });
    idsUnique(runs.map((item) => record(item)), "id"); idsUnique(reQa.map((item) => record(item)), "id");
    const latestCandidates = new Map<string, { attempt: number; status: S2CandidateStatus | "re_qa_unavailable" }>();
    const resultIds = new Set<string>(); const candidateAttempts = new Set<string>(); const reQaCandidateAttempts = new Set<string>();
    for (const runValue of runs) {
      const run = record(runValue); if (!["queued", "running", "completed"].includes(String(run.status))) throw new Error("qa_run_status_invalid");
      timestamp(run.createdAt); optionalTimestamp(run.startedAt); optionalTimestamp(run.completedAt);
      if (run.status !== "completed") throw new Error("qa_source_incomplete");
      if (!Array.isArray(run.candidateResults)) throw new Error("qa_results_invalid");
      for (const resultValue of run.candidateResults as S2QaCandidateResult[]) {
        const result = record(resultValue); const resultId = uuidValue(result.id); uuidValue(result.candidateId); uuidValue(result.qaRunId); uuidValue(result.inputVersionId); uuidValue(result.sourceAssetId); if (resultIds.has(resultId)) throw new Error("duplicate_qa_result"); resultIds.add(resultId); if (result.qaRunId !== run.id) throw new Error("qa_run_link_invalid");
        if (result.attempt !== 1 && result.attempt !== 2) throw new Error("qa_attempt_invalid");
        const status = result.status as S2CandidateStatus; if (!["queued", "running", "pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(String(status))) throw new Error("qa_status_invalid");
        optionalTimestamp(result.startedAt); optionalTimestamp(result.completedAt);
        if (status === "queued" || status === "running" || result.completedAt === null) throw new Error("qa_source_incomplete");
        const key = String(result.candidateId); const candidateAttempt = key + ":" + String(result.attempt); if (candidateAttempts.has(candidateAttempt)) throw new Error("duplicate_qa_attempt"); candidateAttempts.add(candidateAttempt); const prior = latestCandidates.get(key);
        if (!prior || result.attempt >= prior.attempt) latestCandidates.set(key, { attempt: result.attempt, status });
      }
    }
    for (const resultValue of reQa) {
      const result = record(resultValue); const resultId = uuidValue(result.id); uuidValue(result.candidateId); uuidValue(result.qaRunId); uuidValue(result.inputVersionId); uuidValue(result.sourceAssetId); uuidValue(result.derivedCandidateId); uuidValue(result.repairAttemptId); if (resultIds.has(resultId)) throw new Error("duplicate_qa_result"); resultIds.add(resultId); if (result.phase !== "re_qa") throw new Error("re_qa_phase_invalid");
      if (result.attempt !== 1 && result.attempt !== 2) throw new Error("qa_attempt_invalid");
      if (result.status !== "re_qa_unavailable" && !["pass", "warning", "material_fail"].includes(String(result.status))) throw new Error("qa_status_invalid");
      optionalTimestamp(result.startedAt); optionalTimestamp(result.completedAt);
      if (result.completedAt === null) throw new Error("qa_source_incomplete");
      const key = String(result.candidateId); const candidateAttempt = key + ":" + String(result.attempt); if (reQaCandidateAttempts.has(candidateAttempt)) throw new Error("duplicate_re_qa_attempt"); reQaCandidateAttempts.add(candidateAttempt); const prior = latestCandidates.get(key);
      if (!prior || result.attempt >= prior.attempt) latestCandidates.set(key, { attempt: result.attempt, status: result.status as S2CandidateStatus | "re_qa_unavailable" });
    }
    const categories: Record<string, number> = {};

    const add = (category: string): void => { categories[category] = (categories[category] ?? 0) + 1; };
    for (const result of latestCandidates.values()) { const category = candidateFailureStatus(result.status); if (category) add("s2." + category); }
    const assessments = array(state, "s3Assessments").filter((item) => projectValue(record(item).projectId, projectId)) as S3Assessment[];
    idsUnique(assessments.map((item) => record(item)), "assessmentId");
    for (const value of assessments) {
      const item = record(value); timestamp(item.createdAt); timestamp(item.updatedAt);
      if (item.status === "pending" || item.status === "running") throw new Error("s3_source_incomplete");
      if (!["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(String(item.status))) throw new Error("s3_status_invalid");
      const category = item.status === "warning" ? "warning" : item.status === "material_fail" ? "material_fail" : String(item.status).startsWith("qa_unavailable") ? "qa_unavailable" : null;
      if (category) add("s3." + category);
    }
    const preservation = array(state, "s4PreservationChecks").filter((item) => projectValue(record(item).projectId, projectId)) as S4PreservationCheck[];
    idsUnique(preservation.map((item) => record(item)), "preservationCheckId");
    for (const value of preservation) {
      const item = record(value); timestamp(item.createdAt); optionalTimestamp(item.completedAt);
      if (item.status === "pending" || item.status === "running") throw new Error("s4_source_incomplete");
      if (!["PASS", "MATERIAL_FAIL", "QA_UNAVAILABLE"].includes(String(item.status))) throw new Error("s4_preservation_status_invalid");
      if (item.status === "MATERIAL_FAIL") add("s4.preservation.material_fail");
      if (item.status === "QA_UNAVAILABLE") add("s4.preservation.qa_unavailable");
    }
    const s4Assessments = array(state, "s4Assessments").filter((item) => projectValue(record(item).projectId, projectId)) as S4Assessment[];
    idsUnique(s4Assessments.map((item) => record(item)), "assessmentId");
    for (const value of s4Assessments) {
      const item = record(value); timestamp(item.createdAt); timestamp(item.updatedAt);
      if (item.status === "not_started" || item.status === "pending" || item.status === "running") throw new Error("s4_source_incomplete");
      if (!["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal", "skipped_preservation_fail"].includes(String(item.status))) throw new Error("s4_assessment_status_invalid");
      if (item.status === "warning") add("s4.assessment.warning");
      if (item.status === "material_fail" || item.status === "skipped_preservation_fail") add("s4.assessment.material_fail");
      if (item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal") add("s4.assessment.qa_unavailable");
    }
    return available({ total: Object.values(categories).reduce((sum, value) => sum + value, 0), categories });
  } catch { return unavailable("qa_source_invalid"); }
}

function repairCount(state: StoreState, projectId: UUID): S5Metric {
  try {
    const repairs = array(state, "s2Repairs").filter((item) => projectValue(record(item).projectId, projectId));
    idsUnique(repairs.map((item) => record(item)), "id");
    for (const value of repairs) {
      const item = record(value); uuidValue(item.id); uuidValue(item.projectId); uuidValue(item.qaRunId); uuidValue(item.inputVersionId); uuidValue(item.candidateId); uuidValue(item.sourceAssetId);
      if (item.attempt !== 1) throw new Error("repair_attempt_invalid");
      if (!["not_eligible", "eligible", "queued", "running", "failed", "derived_ready", "re_qa_running", "re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable"].includes(String(item.status))) throw new Error("repair_status_invalid");
      timestamp(item.createdAt); optionalTimestamp(item.startedAt); optionalTimestamp(item.completedAt);
      if (item.derivedCandidateId !== null) uuidValue(item.derivedCandidateId); if (item.reQaCandidateResultId !== null) uuidValue(item.reQaCandidateResultId);
    }
    return available(repairs.length);
  } catch { return unavailable("s2Repairs_source_invalid"); }
}
function refinementMetrics(state: StoreState, projectId: UUID): { admitted: S5Metric; successful: S5Metric } {
  let cycles: S3RefinementCycle[] = [];
  let admitted: S5Metric;
  try {
    cycles = array(state, "s3Cycles").filter((item) => projectValue(record(item).projectId, projectId)) as S3RefinementCycle[];
    idsUnique(cycles.map((item) => record(item)), "cycleId");
    const operationIds = new Set<string>(); const assessmentAttemptIds = new Set<string>();
    for (const value of cycles) {
      const item = record(value); uuidValue(item.cycleId); uuidValue(item.projectId); uuidValue(item.selectionStateId); uuidValue(item.generationSetId); uuidValue(item.lineageRootRevisionId); uuidValue(item.baseRevisionId);
      if (item.cycleNumber !== 1 && item.cycleNumber !== 2) throw new Error("cycle_number_invalid");
      if (typeof item.baseSelectionVersion !== "number" || !Number.isSafeInteger(item.baseSelectionVersion) || item.baseSelectionVersion < 1) throw new Error("cycle_selection_version_invalid");
      if (!["image_queued", "image_running", "image_retry_available", "publication_pending", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived"].includes(String(item.status))) throw new Error("cycle_status_invalid");
      if (!["none", "image_available", "assessment_available", "waived"].includes(String(item.retryState))) throw new Error("cycle_retry_state_invalid");
      if (item.retryWaivedReason !== null && !["rolled_back", "later_cycle_started", "selection_moved"].includes(String(item.retryWaivedReason))) throw new Error("cycle_retry_reason_invalid");
      timestamp(item.createdAt); timestamp(item.admittedAt); timestamp(item.updatedAt); optionalTimestamp(item.terminalAt);
      if (!Array.isArray(item.imageOperationIds) || item.imageOperationIds.length < 1 || item.imageOperationIds.length > 2) throw new Error("cycle_operations_invalid");
      for (const operationId of item.imageOperationIds) { const id = uuidValue(operationId); if (operationIds.has(id)) throw new Error("duplicate_cycle_operation"); operationIds.add(id); }
      if (item.outputRevisionId !== null) uuidValue(item.outputRevisionId); if (item.assessmentId !== null) uuidValue(item.assessmentId);
      if (!Array.isArray(item.assessmentAttemptIds) || item.assessmentAttemptIds.length > 2) throw new Error("cycle_assessments_invalid");
      for (const attemptId of item.assessmentAttemptIds) { const id = uuidValue(attemptId); if (assessmentAttemptIds.has(id)) throw new Error("duplicate_cycle_assessment"); assessmentAttemptIds.add(id); }
    }
    admitted = available(cycles.length);
  } catch { admitted = unavailable("s3Cycles_source_invalid"); }
  if (admitted.availability !== "available") return { admitted, successful: unavailable("s3Cycles_source_invalid") };
  try {
    const values = array(state, "s3SelectionEvents").filter((item) => projectValue(record(item).projectId, projectId));
    idsUnique(values.map((item) => record(item)), "eventId");
    const cycleById = new Map(cycles.map((cycle) => [cycle.cycleId, cycle]));
    const revisions = array(state, "s3Revisions").filter((item) => projectValue(record(item).projectId, projectId));
    const assessments = array(state, "s3Assessments").filter((item) => projectValue(record(item).projectId, projectId));
    const activatedRevisionIds = new Set<string>();
    for (const value of values) {
      const raw = record(value); const event = value as S3SelectionEvent;
      uuidValue(raw.eventId); uuidValue(raw.projectId); uuidValue(raw.selectionStateId); uuidValue(raw.toRevisionId); uuidValue(raw.sourceSnapshotId); if (raw.fromRevisionId !== null) uuidValue(raw.fromRevisionId); if (raw.cycleId !== null) uuidValue(raw.cycleId); if (raw.assessmentId !== null) uuidValue(raw.assessmentId); if (raw.idempotencyKey !== null) uuidValue(raw.idempotencyKey); uuidValue(raw.requestReferenceId); timestamp(raw.at);
      if (!["select_source", "reselect_source", "activate_refinement", "rollback"].includes(String(raw.kind))) throw new Error("selection_event_kind_invalid");
      const expected = raw.expectedSelectionVersion; const resulting = raw.resultingSelectionVersion; const successfulCount = raw.resultingSuccessfulRefinementCount;
      if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || typeof resulting !== "number" || !Number.isSafeInteger(resulting) || resulting < 1 || typeof successfulCount !== "number" || !Number.isSafeInteger(successfulCount) || successfulCount < 0 || successfulCount > 2) throw new Error("selection_event_shape");
      if (event.kind !== "activate_refinement") continue;
      if (event.cycleId === null || event.assessmentId === null || activatedRevisionIds.has(event.toRevisionId)) throw new Error("activation_source_invalid");
      const cycle = cycleById.get(event.cycleId); const revision = revisions.find((candidate) => record(candidate).revisionId === event.toRevisionId); const assessment = assessments.find((candidate) => record(candidate).assessmentId === event.assessmentId);
      const revisionRecord = revision ? record(revision) : null; const assessmentRecord = assessment ? record(assessment) : null;
      if (!cycle || cycle.projectId !== projectId || cycle.selectionStateId !== event.selectionStateId || cycle.generationSetId !== (revisionRecord?.generationSetId as UUID) || cycle.outputRevisionId !== event.toRevisionId || cycle.assessmentId !== event.assessmentId || !revisionRecord || revisionRecord.kind !== "refinement" || revisionRecord.projectId !== projectId || revisionRecord.generationSetId !== cycle.generationSetId || revisionRecord.assessmentId !== event.assessmentId || !assessmentRecord || assessmentRecord.projectId !== projectId || assessmentRecord.revisionId !== event.toRevisionId || (assessmentRecord.status !== "pass" && assessmentRecord.status !== "warning")) throw new Error("activation_source_invalid");
      activatedRevisionIds.add(event.toRevisionId);
    }
    return { admitted, successful: available(activatedRevisionIds.size) };
  } catch { return { admitted, successful: unavailable("s3_activation_source_invalid") }; }
}
function editMetrics(state: StoreState, projectId: UUID): { count: S5Metric; success: S5Metric; failure: S5Metric; categories: S5MetricValue<Record<string, number>> } {
  try {
    const edits = array(state, "s4Edits").filter((item) => projectValue(record(item).projectId, projectId)) as S4EditAdmission[];
    idsUnique(edits.map((item) => record(item)), "editId");
    const categories: Record<string, number> = {}; let successes = 0; let failures = 0;
    const terminalStatuses = new Set(["completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived"]);
    for (const value of edits) {
      const item = record(value); uuidValue(item.editId); uuidValue(item.projectId); uuidValue(item.generationSetId); uuidValue(item.selectionStateId); uuidValue(item.sourceSnapshotId); uuidValue(item.lineageRootRevisionId); uuidValue(item.baseRevisionId); uuidValue(item.maskId);
      if (item.cycleNumber !== 1 && item.cycleNumber !== 2) throw new Error("edit_cycle_invalid");
      if (typeof item.baseSelectionVersion !== "number" || !Number.isSafeInteger(item.baseSelectionVersion) || item.baseSelectionVersion < 1) throw new Error("edit_selection_version_invalid");
      if (!["pending", "ready"].includes(String(item.maskMaterializationStatus))) throw new Error("edit_mask_status_invalid");
      if (!Array.isArray(item.imageOperationIds) || item.imageOperationIds.length > 2 || !Array.isArray(item.assessmentAttemptIds) || item.assessmentAttemptIds.length > 2) throw new Error("edit_operation_shape_invalid");
      for (const id of [...item.imageOperationIds, ...item.assessmentAttemptIds]) uuidValue(id);
      if (item.outputRevisionId !== null) uuidValue(item.outputRevisionId); if (item.preservationCheckId !== null) uuidValue(item.preservationCheckId); if (item.assessmentId !== null) uuidValue(item.assessmentId);
      if (!["mask_materialization_pending", "image_queued", "image_running", "image_retry_available", "publication_pending", "preservation_pending", "preservation_running", "assessment_pending", "assessment_running", "assessment_retry_available", "completed", "material_fail", "qa_unavailable", "image_failed", "publication_failed", "stale", "waived"].includes(String(item.status))) throw new Error("edit_status_invalid");
      if (!["none", "image_available", "assessment_available", "waived"].includes(String(item.retryState))) throw new Error("edit_retry_state_invalid");
      if (item.retryWaivedReason !== null && !["rolled_back", "later_cycle_started", "selection_moved"].includes(String(item.retryWaivedReason))) throw new Error("edit_retry_reason_invalid");
      timestamp(item.createdAt); timestamp(item.admittedAt); timestamp(item.updatedAt); optionalTimestamp(item.terminalAt);
      const terminal = terminalStatuses.has(String(item.status)); if (terminal !== (item.terminalAt !== null)) throw new Error("edit_terminal_shape");
      if (item.status === "completed") {
        if (item.outputRevisionId === null || item.preservationCheckId === null || item.assessmentId === null) throw new Error("edit_success_incomplete");
        const revision = state.s4Revisions.find((candidate) => candidate.projectId === projectId && candidate.revisionId === item.outputRevisionId);
        const preservation = state.s4PreservationChecks.find((candidate) => candidate.projectId === projectId && candidate.preservationCheckId === item.preservationCheckId);
        const assessment = state.s4Assessments.find((candidate) => candidate.projectId === projectId && candidate.assessmentId === item.assessmentId);
        if (!revision || revision.editId !== item.editId || revision.outputAssetId === revision.sourceAssetId || !preservation || preservation.editId !== item.editId || preservation.revisionId !== item.outputRevisionId || preservation.status !== "PASS" || preservation.completedAt === null || !assessment || assessment.editId !== item.editId || assessment.revisionId !== item.outputRevisionId || !["pass", "warning"].includes(String(assessment.status)) || assessment.latestAttemptId === null || !assessment.attemptIds.some((id) => id === assessment.latestAttemptId)) throw new Error("edit_success_source_invalid");
        successes += 1;
      } else if (terminal) {
        failures += 1; const category = String(item.status); categories[category] = (categories[category] ?? 0) + 1;
      }
    }
    return { count: available(edits.length), success: available(successes), failure: available(failures), categories: available(categories) };
  } catch { return { count: unavailable("s4_edit_source_invalid"), success: unavailable("s4_edit_source_invalid"), failure: unavailable("s4_edit_source_invalid"), categories: unavailable("s4_edit_source_invalid") }; }
}
function artifactMetrics(state: StoreState, projectId: UUID): { planFailures: S5Metric; planRetries: S5Metric; pdfFailures: S5Metric; pdfRetries: S5Metric; committedLatency: S5Metric; terminalFailureLatency: S5Metric; approvalToPlan: S5Metric; approvalToPdf: S5Metric; failureRate: S5Metric } {
  try {
    const artifacts = array(state, "s5Artifacts").filter((item) => projectValue(record(item).projectId, projectId)) as S5Artifact[];
    idsUnique(artifacts.map((item) => record(item)), "artifactId");
    for (const value of artifacts) {
      const item = record(value); uuidValue(item.artifactId); uuidValue(item.artifactGroupId); uuidValue(item.projectId); uuidValue(item.generationSetId); uuidValue(item.selectionStateId); uuidValue(item.activeRevisionId); uuidValue(item.approvalEventId); shaValue(item.generationContextHash); shaValue(item.planHash); if (item.outputSha256 !== null) shaValue(item.outputSha256); if (item.retryOfArtifactId !== null) uuidValue(item.retryOfArtifactId); if (item.sourceLayoutGroupId !== null) uuidValue(item.sourceLayoutGroupId);
      const kind = String(item.kind); const expected = kind === "plan_json" ? ["s5-concept-layout-v1", "application/json", ".json", "swooshz-concept-layout-plan.json"] : kind === "plan_svg" ? ["s5-layout-svg-v1", "image/svg+xml", ".svg", "swooshz-concept-layout-plan.svg"] : kind === "presentation_pdf" ? ["s5-presentation-pdf-v1", "application/pdf", ".pdf", "swooshz-concept-presentation.pdf"] : null;
      if (!expected || item.rendererVersion !== expected[0] || item.mimeType !== expected[1] || item.fileExtension !== expected[2] || item.fileName !== expected[3] || (kind === "presentation_pdf") !== (item.sourceLayoutGroupId !== null)) throw new Error("artifact_identity_invalid");
      if (item.outputByteSize !== null && (typeof item.outputByteSize !== "number" || !Number.isSafeInteger(item.outputByteSize) || item.outputByteSize < 0)) throw new Error("artifact_output_size_invalid");
      if (item.pageCount !== null && (typeof item.pageCount !== "number" || !Number.isSafeInteger(item.pageCount) || item.pageCount < 1 || (kind === "presentation_pdf" && (item.pageCount < 5 || item.pageCount > 12)))) throw new Error("artifact_page_count_invalid");
      if (item.attempt !== 1 && item.attempt !== 2) throw new Error("artifact_attempt_invalid");
      if (!["queued", "running", "staged", "committed", "failed_retryable", "failed_terminal", "aborted"].includes(String(item.status))) throw new Error("artifact_status_invalid");
      timestamp(item.createdAt); timestamp(item.updatedAt);
      if (item.completedAt !== null) timestamp(item.completedAt);
      if (item.terminalAt !== null) timestamp(item.terminalAt);
      if (item.status === "committed" && (item.completedAt === null || item.outputSha256 === null || item.outputByteSize === null || item.terminalAt !== null)) throw new Error("artifact_completion_missing");
      if (item.status === "staged" && (item.outputSha256 === null || item.outputByteSize === null)) throw new Error("artifact_staging_missing");
      if (FAILURE_ARTIFACT_STATUSES.has(String(item.status)) && item.terminalAt === null) throw new Error("artifact_terminal_missing");
      if (!FAILURE_ARTIFACT_STATUSES.has(String(item.status)) && item.terminalAt !== null) throw new Error("artifact_terminal_shape");
      if (item.attempt === 1 && item.retryOfArtifactId !== null || item.attempt === 2 && item.retryOfArtifactId === null) throw new Error("artifact_retry_shape");
    }
    const groups = new Map<string, S5Artifact[]>();
    for (const artifact of artifacts) groups.set(artifact.artifactGroupId, [...(groups.get(artifact.artifactGroupId) ?? []), artifact]);
    const planGroups = [...groups.values()].filter((group) => group.some((item) => item.kind === "plan_json" || item.kind === "plan_svg"));
    const pdfGroups = [...groups.values()].filter((group) => group.some((item) => item.kind === "presentation_pdf"));
    const failureGroups = (values: S5Artifact[]): number => new Set(values.filter((item) => FAILURE_ARTIFACT_STATUSES.has(item.status)).map((item) => item.artifactGroupId)).size;
    const retryGroups = (values: S5Artifact[]): number => new Set(values.filter((item) => item.attempt === 2).map((item) => item.artifactGroupId)).size;
    const latestCommitted = artifacts.filter((item) => item.status === "committed" && item.completedAt !== null).sort((left, right) => timestamp(right.completedAt) - timestamp(left.completedAt))[0];
    const latestFailure = artifacts.filter((item) => FAILURE_ARTIFACT_STATUSES.has(item.status) && item.terminalAt !== null).sort((left, right) => timestamp(right.terminalAt) - timestamp(left.terminalAt))[0];
    const approved = (array(state, "s5ApprovalEvents").filter((item) => projectValue(record(item).projectId, projectId)) as S5ApprovalEvent[]).filter((item) => item.kind === "approved").sort((left, right) => right.eventSequence - left.eventSequence)[0];
    const duration = (kind: S5Artifact["kind"]): S5Metric => {
      if (!approved) return unavailable("no_approval");
      const artifact = artifacts.filter((item) => item.kind === kind && item.status === "committed" && item.approvalEventId === approved.eventId && item.completedAt !== null).sort((left, right) => timestamp(right.completedAt) - timestamp(left.completedAt))[0];
      return artifact ? interval(approved.occurredAt, artifact.completedAt) : unavailable("artifact_not_committed");
    };
    const terminal = artifacts.filter((item) => TERMINAL_ARTIFACT_STATUSES.has(item.status));
    const failed = artifacts.filter((item) => FAILURE_ARTIFACT_STATUSES.has(item.status));
    return {
      planFailures: available(failureGroups(planGroups.flat())),
      planRetries: available(retryGroups(planGroups.flat())),
      pdfFailures: available(failureGroups(pdfGroups.flat())),
      pdfRetries: available(retryGroups(pdfGroups.flat())),
      committedLatency: latestCommitted ? interval(latestCommitted.createdAt, latestCommitted.completedAt) : unavailable("no_committed_artifact"),
      terminalFailureLatency: latestFailure ? interval(latestFailure.createdAt, latestFailure.terminalAt) : unavailable("no_terminal_failure"),
      approvalToPlan: duration("plan_json"),
      approvalToPdf: duration("presentation_pdf"),
      failureRate: terminal.length ? available(failed.length / terminal.length) : unavailable("no_terminal_artifacts"),
    };
  } catch { return { planFailures: unavailable("artifact_source_invalid"), planRetries: unavailable("artifact_source_invalid"), pdfFailures: unavailable("artifact_source_invalid"), pdfRetries: unavailable("artifact_source_invalid"), committedLatency: unavailable("artifact_source_invalid"), terminalFailureLatency: unavailable("artifact_source_invalid"), approvalToPlan: unavailable("artifact_source_invalid"), approvalToPdf: unavailable("artifact_source_invalid"), failureRate: unavailable("artifact_source_invalid") }; }
}

function approvalChain(state: StoreState, projectId: UUID): S5ApprovalEvent[] {
  const events = array(state, "s5ApprovalEvents").filter((item) => projectValue(record(item).projectId, projectId)) as S5ApprovalEvent[];
  idsUnique(events.map((item) => record(item)), "eventId");
  const ordered = events.slice().sort((left, right) => left.eventSequence - right.eventSequence);
  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index]!; const raw = record(event);
    uuidValue(raw.eventId); uuidValue(raw.projectId); uuidValue(raw.generationSetId); uuidValue(raw.selectionStateId); uuidValue(raw.approvalId); if (raw.priorApprovalEventId !== null) uuidValue(raw.priorApprovalEventId); uuidValue(raw.observedActiveRevisionId); uuidValue(raw.observedLineageRootRevisionId); uuidValue(raw.idempotencyKey); uuidValue(raw.requestReferenceId); shaValue(raw.generationContextHash); timestamp(raw.occurredAt);
    if (typeof raw.eventSequence !== "number" || !Number.isSafeInteger(raw.eventSequence) || raw.eventSequence !== index + 1 || typeof raw.approvalGeneration !== "number" || !Number.isSafeInteger(raw.approvalGeneration) || raw.approvalGeneration < 1 || typeof raw.observedSelectionVersion !== "number" || !Number.isSafeInteger(raw.observedSelectionVersion) || raw.observedSelectionVersion < 1) throw new Error("approval_sequence_invalid");
    const previous = ordered[index - 1];
    if (index === 0) {
      if (event.kind !== "approved" || event.approvalGeneration !== 1 || event.approvalId !== event.eventId || event.priorApprovalEventId !== null || event.generationContext === null) throw new Error("approval_chain_invalid");
    } else if (event.kind === "reopened") {
      const prior = event.priorApprovalEventId === null ? null : events.find((candidate) => candidate.eventId === event.priorApprovalEventId);
      if (!previous || previous.kind !== "approved" || !prior || prior.eventId !== previous.eventId || prior.projectId !== event.projectId || prior.generationSetId !== event.generationSetId || prior.selectionStateId !== event.selectionStateId || prior.approvalId !== event.approvalId || prior.approvalGeneration !== event.approvalGeneration || prior.observedSelectionVersion !== event.observedSelectionVersion || prior.observedActiveRevisionId !== event.observedActiveRevisionId || prior.observedLineageRootRevisionId !== event.observedLineageRootRevisionId || event.approvalGeneration !== previous.approvalGeneration || event.approvalId !== previous.approvalId || event.generationContext !== null || event.generationContextHash !== previous.generationContextHash || event.reopenReason === null) throw new Error("approval_chain_invalid");
    } else if (!previous || previous.kind !== "reopened" || event.approvalGeneration !== previous.approvalGeneration + 1 || event.approvalId !== event.eventId || event.priorApprovalEventId !== null || event.generationContext === null) throw new Error("approval_chain_invalid");
    if (event.kind === "approved" && event.generationContext !== null) {
      const context = event.generationContext;
      if (context.projectId !== event.projectId || context.generationSetId !== event.generationSetId || context.selectionStateId !== event.selectionStateId || context.selectionVersion !== event.observedSelectionVersion || context.approvalEventId !== event.eventId || context.approvalGeneration !== event.approvalGeneration || context.eventSequence !== event.eventSequence || context.activeRevisionId !== event.observedActiveRevisionId || context.lineageRootRevisionId !== event.observedLineageRootRevisionId || event.generationContextHash !== shaValue(event.generationContextHash) || event.generationContextHash !== sha256(jcs(context))) throw new Error("approval_context_invalid");
    }
  }
  return ordered;
}
function approvalMetrics(state: StoreState, projectId: UUID, resolveCurrent: ApprovedContextResolver | undefined): { approvals: S5Metric; reopens: S5Metric; firstAcceptance: S5Metric; acceptedRevision: S5MetricValue<S5AcceptedRevisionMetricValue> } {
  try {
    const events = approvalChain(state, projectId);
    const approvals = events.filter((item) => item.kind === "approved");
    const reopens = events.filter((item) => item.kind === "reopened");
    const project = state.projects.find((item) => item.projectId === projectId);
    const first = approvals[0];
    const firstAcceptance: S5Metric = first && project ? interval(project.createdAt, first.occurredAt) : unavailable<number>("no_accepted_concept");
    const latest = events.at(-1);
    let acceptedRevision: S5MetricValue<S5AcceptedRevisionMetricValue> = unavailable("no_locked_approval");
    if (latest?.kind === "approved") {
      if (!resolveCurrent) acceptedRevision = unavailable("approval_validation_unavailable");
      else {
        try {
          const context = resolveCurrent(latest);
          acceptedRevision = available({ revisionId: context.activeRevisionId, revisionKind: context.activeRevisionKind, lineageRootRevisionId: context.lineageRootRevisionId, selectionVersion: context.selectionVersion, quality: context.quality });
        } catch { acceptedRevision = unavailable("S5_APPROVAL_STALE"); }
      }
    } else if (latest?.kind === "reopened") acceptedRevision = unavailable("approval_reopened");
    return { approvals: available(approvals.length), reopens: available(reopens.length), firstAcceptance, acceptedRevision };
  } catch { return { approvals: unavailable("approval_source_invalid"), reopens: unavailable("approval_source_invalid"), firstAcceptance: unavailable("approval_source_invalid"), acceptedRevision: unavailable("approval_source_invalid") }; }
}
export function buildS5Telemetry(state: StoreState, projectId: UUID, resolveCurrent?: ApprovedContextResolver): S5Telemetry {
  const generation = generationMetrics(state, projectId);
  const qa = qaFailureMetrics(state, projectId);
  const repair = repairCount(state, projectId);
  const refinement = refinementMetrics(state, projectId);
  const edits = editMetrics(state, projectId);
  const artifacts = artifactMetrics(state, projectId);
  const approvals = approvalMetrics(state, projectId, resolveCurrent);
  const unavailableCost = unavailable<number>("actual_billed_amount_unavailable");
  return {
    conceptGenerationLatencyMs: generation.latency,
    queueInclusiveGenerationDurationMs: generation.queue,
    generationCount: generation.count,
    regenerationCount: generation.retries,
    qaFailureCounts: qa,
    s2RepairCount: repair,
    refinementAdmittedCount: refinement.admitted,
    successfulRefinementCount: refinement.successful,
    localEditCount: edits.count,
    editSuccessCount: edits.success,
    editFailureCount: edits.failure,
    editFailureCategories: edits.categories,
    planFailureCount: artifacts.planFailures,
    planRetryCount: artifacts.planRetries,
    pdfFailureCount: artifacts.pdfFailures,
    pdfRetryCount: artifacts.pdfRetries,
    approvalCount: approvals.approvals,
    reopenCount: approvals.reopens,
    committedArtifactLatencyMs: artifacts.committedLatency,
    terminalFailureLatencyMs: artifacts.terminalFailureLatency,
    firstTimeToAcceptedConceptMs: approvals.firstAcceptance,
    acceptedRevision: approvals.acceptedRevision,
    providerCost: unavailableCost,
    totalProjectGenerationCost: unavailableCost,
    approvalToPlanMs: artifacts.approvalToPlan,
    approvalToPdfMs: artifacts.approvalToPdf,
    artifactFailureRate: artifacts.failureRate,
  };
}
