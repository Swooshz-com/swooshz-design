import { AppError, type CanonicalSourceBinding, type ConceptAsset, type ConceptCandidate, type IdempotencyRecord, type S2DerivedCandidate, type S2InputVersion, type S2QaCandidateResult, type S2QaRun, type S2ReQaResult, type S2RepairAttempt, type S3Assessment, type S3AssessmentAttempt, type S3AssessmentAggregateStatus, type S3AssessmentProviderMetadata, type S3AssessmentRetryState, type S3CycleRetryState, type S3CycleStatus, type S3GeneratedAsset, type S3ImageOperation, type S3ImageOperationStatus, type S3ImageProviderMetadata, type S3OperationFailureCode, type S3Publication, type S3PublicationObject, type S3RefinementCycle, type S3RefinementRevision, type S3RetryWaivedReason, type S3SelectionEvent, type S3SelectionEventKind, type S3SelectionState, type S3SourceKind, type S3SourceSnapshot, type S3StateTransition, type S3TransitionValue, type S3Revision, type S3SourceRevision, type S4RetryWaivedReason, type StoreState, type UUID } from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { assertS2Png, inspectCanonicalS1Png } from "./s2-media";
import { latestSourceQaResults } from "./s2-lifecycle";
import { reduceS2Findings, S2_CONFIDENCE_THRESHOLD } from "./s2-findings";
import { ProviderFailure } from "./openai";
import { assertUuid, cloneJson, codePointLength, jcs, newUuid, nowUtc, privateStorageKey, sha256, uuidV4Pattern } from "./utils";
import { designRuleSnapshotHash, compileS3Assessment, compileS3Refinement, normalizeS3Intent, type S3AssessmentCompilerContext, type S3BaseAssetIdentity, type S3CanonicalAssessmentInput, type S3CanonicalRefinementInput, type S3RefinementCompilerContext } from "./s3-compiler";
import { decodeS3Rgba, inspectExactS3Png, s3PixelsChanged, type S3ExactPng } from "./s3-media";
import { OpenAIS3Provider, type S3AssessmentProviderInput, type S3AssessmentProviderResult, type S3ImageProviderInput, type S3ImageProviderResult, type S3ProviderContract } from "./s3-provider";
import { resolveVisualRevision } from "./revision-resolver";

export type PublicS3ScreenedCandidate = {
  candidateIndex: 1 | 2 | 3 | 4;
  sourceQaStatus: "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
  originalSourceId: UUID | null;
  repairedSourceIds: UUID[];
};

export type PublicS3Source = {
  sourceId: UUID;
  sourceKind: "s1_original" | "s2_repaired";
  candidateIndex: 1 | 2 | 3 | 4;
  sourceRevisionId: UUID;
  qaStatus: "PASS" | "WARNING";
  selected: boolean;
  eligible: boolean;
  previewAvailable: boolean;
};

export type PublicS3AssessmentStatus = "NOT_REQUIRED" | "PENDING" | "RUNNING" | "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";

export type PublicS3Revision = {
  revisionId: UUID;
  kind: "source_selection" | "refinement";
  parentRevisionId: UUID | null;
  cycleNumber: 0 | 1 | 2;
  sourceKind: "s1_original" | "s2_repaired";
  candidateIndex: 1 | 2 | 3 | 4;
  userIntentText: string | null;
  assessmentStatus: PublicS3AssessmentStatus;
  assessmentRetryAvailable: boolean;
  imageRetryAvailable: boolean;
  successfulSequence: 1 | 2 | null;
  activationState: "active_tip" | "usable_history" | "historical_non_activatable";
  active: boolean;
  usable: boolean;
  previewAvailable: boolean;
  createdAt: string;
};

export type PublicS3CycleStatus = "generating" | "image_retry_available" | "publication_pending" | "assessment_pending" | "assessment_running" | "assessment_retry_available" | "usable_pass" | "usable_warning" | "material_fail" | "qa_unavailable" | "image_failed" | "publication_failed" | "stale" | "waived";

export type PublicS3Cycle = {
  cycleId: UUID;
  cycleNumber: 1 | 2;
  status: PublicS3CycleStatus;
  baseRevisionId: UUID;
  outputRevisionId: UUID | null;
  assessmentStatus: "NOT_STARTED" | "PENDING" | "RUNNING" | "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
  imageRetryAvailable: boolean;
  assessmentRetryAvailable: boolean;
  slotConsumed: true;
};

export type PublicS3AssessmentSummary = {
  status: "PENDING" | "RUNNING" | "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
  materialFindingCount: number;
  warningFindingCount: number;
  uncertainFindingCount: number;
  retryAvailable: boolean;
};

export type PublicS3State = {
  projectId: UUID;
  generationSetId: UUID;
  selectionVersion: number;
  activeRevisionId: UUID | null;
  cycleSlotsConsumed: 0 | 1 | 2;
  cycleSlotsRemaining: 0 | 1 | 2;
  successfulRefinementCount: 0 | 1 | 2;
  screenedCandidates: PublicS3ScreenedCandidate[];
  sources: PublicS3Source[];
  revisions: PublicS3Revision[];
  cycles: PublicS3Cycle[];
};

export type PublicS3Mutation<T> = { replayed: boolean; result: T };
export type PublicS3SelectionResult = { selectionVersion: number; activeRevisionId: UUID; activeSourceId: UUID; eventKind: "select_source" | "reselect_source" | "rollback" | null };
export type PublicS3RefinementAdmission = { cycleId: UUID; cycleNumber: 1 | 2; status: "generating"; baseRevisionId: UUID; selectionVersion: number; cycleSlotsConsumed: 1 | 2 };
export type PublicS3RetryAdmission = { cycleId: UUID; status: "generating" | "assessment_pending"; imageRetryAvailable: false; assessmentRetryAvailable: false };
export type PublicS3CycleDetail = { cycle: PublicS3Cycle; revision: PublicS3Revision | null; assessment: PublicS3AssessmentSummary | null };
export type PublicS3RevisionDetail = { revision: PublicS3Revision; assessment: PublicS3AssessmentSummary | null };

export type S3DispatchPhase = "before-dispatch" | "after-dispatch-marked";
export type S3PublicationPhase = "before-publication-intent" | "after-publication-intent" | "after-publication-staged" | "after-final-promotion";

export type S3WorkflowServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  provider?: S3ProviderContract;
  clock?: () => string;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onProviderDispatchPhase?: (phase: S3DispatchPhase, operation: S3ImageOperation | S3AssessmentAttempt) => "interrupt" | void | Promise<"interrupt" | void>;
  onPublicationPhase?: (phase: S3PublicationPhase, publication: S3Publication) => "interrupt" | void | Promise<"interrupt" | void>;
};

type EligibleSource = {
  sourceCandidateId: UUID;
  candidate: ConceptCandidate;
  candidateIndex: 1 | 2 | 3 | 4;
  sourceKind: S3SourceKind;
  selectedAssetKind: "s1_concept_asset" | "s2_derived_candidate";
  selectedAssetId: UUID;
  selectedStorageKey: string;
  selectedSha256: string;
  selectedByteSize: number;
  selectedWidth: number;
  selectedHeight: number;
  selectedPixelCount: number;
  selectedDecodedRgbaBytes: number;
  sourceQaResult: S2QaCandidateResult;
  sourceS2RepairAttempt: S2RepairAttempt | null;
  sourceS2ReQaResult: S2ReQaResult | null;
  sourceS2DerivedCandidate: S2DerivedCandidate | null;
  input: S2InputVersion;
  qaRun: S2QaRun;
};

type SourceContext = { source: S3SourceSnapshot; revision: S3SourceRevision };
type ImageClaim = { operation: S3ImageOperation; token: UUID };
type AssessmentClaim = { attempt: S3AssessmentAttempt; token: UUID };
type AssessmentReduction = {
  status: "pass" | "warning" | "material_fail";
  requirements: StoreState["s3AssessmentAttempts"][number]["requirementObservations"];
  designRules: StoreState["s3AssessmentAttempts"][number]["designObservations"];
  material: string[];
  warning: string[];
  uncertain: string[];
};

const S3_CYCLE_SLOTS = 2 as const;
const S3_IMAGE_RETRYABLE = new Set<string>([
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_HTTP_ERROR", "PROVIDER_MALFORMED_RESPONSE", "IMAGE_EMPTY", "IMAGE_MALFORMED", "MEDIA_CORRUPT", "MEDIA_NORMALIZATION_FAILED", "S3_OUTPUT_DIMENSIONS_INVALID",
]);
const S3_ASSESSMENT_RETRYABLE = new Set<string>([
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_HTTP_ERROR", "QA_PROVIDER_EMPTY", "QA_PROVIDER_INCOMPLETE",
]);
const S3_FAILURE_CODES = new Set<string>([
  "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_HTTP_ERROR", "PROVIDER_MALFORMED_RESPONSE", "PROVIDER_NOT_CONFIGURED", "PROVIDER_CLIENT_ERROR", "PROVIDER_DISPATCH_UNCERTAIN", "IMAGE_EMPTY", "IMAGE_MALFORMED", "MEDIA_CORRUPT", "MEDIA_NORMALIZATION_FAILED", "S3_OUTPUT_DIMENSIONS_INVALID", "IMAGE_INPUT_INTEGRITY_MISMATCH", "MEDIA_TOO_LARGE", "MEDIA_ANIMATED_NOT_ALLOWED", "MEDIA_DIMENSIONS_EXCEEDED", "MEDIA_PIXEL_LIMIT_EXCEEDED", "MEDIA_SIGNATURE_MISMATCH", "PUBLICATION_FAILED", "PUBLICATION_OBJECT_MISMATCH", "S3_FENCE_STALE", "QA_PROVIDER_EMPTY", "QA_PROVIDER_INCOMPLETE", "QA_PROVIDER_REFUSED", "QA_SCHEMA_INVALID", "QA_RESULT_INCOMPLETE", "QA_INPUT_INTEGRITY_MISMATCH", "PERSISTENCE_FAILED",
]);

class ProcessInterruption extends Error {}

function fail(status: number, code: string, field = "request"): AppError {
  return new AppError(status, code, [{ field, code }]);
}

function operationHash(operation: string, projectId: UUID, input: unknown): string {
  return sha256(Buffer.from(jcs({ operation, projectId, input }), "utf8"));
}

function canonicalOperationHash(input: unknown): string {
  return sha256(Buffer.from(jcs(input), "utf8"));
}

function safeProviderRequestId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function failureCode(error: unknown): S3OperationFailureCode {
  const value = error instanceof ProviderFailure ? error.safeCode : error instanceof AppError ? error.code : "PERSISTENCE_FAILED";
  return (S3_FAILURE_CODES.has(value) ? value : "PERSISTENCE_FAILED") as S3OperationFailureCode;
}

function publicAssessmentStatus(value: S3AssessmentAggregateStatus | null): PublicS3AssessmentStatus {
  if (value === null) return "NOT_REQUIRED";
  if (value === "pending") return "PENDING";
  if (value === "running") return "RUNNING";
  if (value === "pass") return "PASS";
  if (value === "warning") return "WARNING";
  if (value === "material_fail") return "MATERIAL_FAIL";
  return "QA_UNAVAILABLE";
}

function publicCycleStatus(cycle: S3RefinementCycle, assessment: S3Assessment | null): PublicS3CycleStatus {
  switch (cycle.status) {
    case "image_queued":
    case "image_running": return "generating";
    case "completed": return assessment?.status === "warning" ? "usable_warning" : "usable_pass";
    case "qa_unavailable": return "qa_unavailable";
    case "material_fail": return "material_fail";
    default: return cycle.status;
  }
}

function asCount(value: number): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) throw new Error("invalid S3 count");
  return value as 0 | 1 | 2;
}

function cloneTuple<T>(value: readonly T[]): T[] {
  return Array.from(value);
}

export class S3WorkflowService {
  private readonly repository: JsonRepository;
  private readonly objects: PrivateObjectStore;
  private readonly provider: S3ProviderContract;
  private readonly clock: () => string;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly onProviderDispatchPhase: S3WorkflowServiceOptions["onProviderDispatchPhase"];
  private readonly onPublicationPhase: S3WorkflowServiceOptions["onPublicationPhase"];
  private readonly inFlight = new Set<string>();

  constructor(options: S3WorkflowServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.provider = options.provider ?? new OpenAIS3Provider();
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.workerId = options.workerId ?? `s3-worker-${this.processId}`;
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
    this.onProviderDispatchPhase = options.onProviderDispatchPhase;
    this.onPublicationPhase = options.onPublicationPhase;
    this.recover();
  }

  private state(): StoreState { return this.repository.state(); }

  private project(state: StoreState, projectId: UUID) {
    const project = state.projects.find((item) => item.projectId === projectId);
    if (!project) throw fail(404, "PROJECT_NOT_FOUND", "projectId");
    return project;
  }

  private generation(state: StoreState, projectId: UUID) {
    const project = this.project(state, projectId);
    if (!project.activeGenerationSetId || !project.confirmedBriefVersionId) throw fail(404, "S3_SOURCE_NOT_FOUND");
    const generationSet = state.generationSets.find((item) => item.generationSetId === project.activeGenerationSetId && item.projectId === projectId);
    if (!generationSet) throw fail(404, "S3_SOURCE_NOT_FOUND");
    return { project, generationSet };
  }

  private inputFor(state: StoreState, projectId: UUID, generationSetId: UUID): S2InputVersion {
    const input = state.s2Inputs.find((item) => item.projectId === projectId && item.sourceGenerationSetId === generationSetId);
    if (!input) throw fail(404, "S3_SOURCE_NOT_FOUND");
    return input;
  }

  private qaRunFor(state: StoreState, input: S2InputVersion): S2QaRun {
    const run = state.s2QaRuns.find((item) => item.id === input.qaRunId && item.projectId === input.projectId);
    if (!run) throw fail(404, "S3_SOURCE_NOT_FOUND");
    return run;
  }

  private idempotency(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string): IdempotencyRecord | null {
    const existing = state.idempotency.find((item) => item.key === key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.projectId !== projectId || existing.inputHash !== inputHash) throw fail(409, "IDEMPOTENCY_KEY_REUSE");
    return existing;
  }

  private remember(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string, result: Record<string, unknown>): void {
    state.idempotency.push({ key, operation, projectId, inputHash, result: cloneJson(result), createdAt: this.clock() });
  }

  private transition(state: StoreState, projectIdOrValues: UUID | {
    projectId: UUID;
    cycleId?: UUID | null;
    operationId?: UUID | null;
    assessmentId?: UUID | null;
    assessmentAttemptId?: UUID | null;
    publicationId?: UUID | null;
    phase: "selection" | "cycle" | "image" | "publication" | "assessment";
    attempt?: 1 | 2 | null;
    from: S3TransitionValue | null;
    to: S3TransitionValue;
    reason?: S3RetryWaivedReason | null;
    requestReferenceId: UUID;
  }, maybeValues?: {
    cycleId?: UUID | null;
    operationId?: UUID | null;
    assessmentId?: UUID | null;
    assessmentAttemptId?: UUID | null;
    publicationId?: UUID | null;
    phase: "selection" | "cycle" | "image" | "publication" | "assessment";
    attempt?: 1 | 2 | null;
    from: S3TransitionValue | null;
    to: S3TransitionValue;
    reason?: S3RetryWaivedReason | null;
    requestReferenceId: UUID;
  }): void {
    const values = typeof projectIdOrValues === "string"
      ? { projectId: projectIdOrValues, ...maybeValues! }
      : projectIdOrValues;
    const item: S3StateTransition = {
      transitionId: this.uuid(), projectId: values.projectId, cycleId: values.cycleId ?? null,
      operationId: values.operationId ?? null, assessmentId: values.assessmentId ?? null,
      assessmentAttemptId: values.assessmentAttemptId ?? null, publicationId: values.publicationId ?? null,
      phase: values.phase, attempt: values.attempt ?? null, from: values.from, to: values.to,
      reason: values.reason ?? null, requestReferenceId: values.requestReferenceId, at: this.clock(),
    };
    state.s3Transitions.push(item);
  }

  private clearClaim(value: { claimedBy: string | null; claimedProcessId: number | null; claimToken: UUID | null; claimedAt: string | null }): void {
    value.claimedBy = null; value.claimedProcessId = null; value.claimToken = null; value.claimedAt = null;
  }

  private imageClaimMatches(operation: S3ImageOperation, token: UUID): boolean {
    return operation.status === "running" && operation.claimedBy === this.workerId && operation.claimedProcessId === this.processId && operation.claimToken === token;
  }

  private assessmentClaimMatches(attempt: S3AssessmentAttempt, token: UUID): boolean {
    return attempt.status === "running" && attempt.claimedBy === this.workerId && attempt.claimedProcessId === this.processId && attempt.claimToken === token;
  }

  private async notifyDispatch(phase: S3DispatchPhase, operation: S3ImageOperation | S3AssessmentAttempt): Promise<void> {
    if ((await this.onProviderDispatchPhase?.(phase, cloneJson(operation))) === "interrupt") throw new ProcessInterruption();
  }

  private async notifyPublication(phase: S3PublicationPhase, publication: S3Publication): Promise<void> {
    if ((await this.onPublicationPhase?.(phase, cloneJson(publication))) === "interrupt") throw new ProcessInterruption();
  }

  private async sourceObject(source: EligibleSource): Promise<void> {
    let bytes: Buffer;
    try { bytes = this.objects.read(source.selectedStorageKey); }
    catch { throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH"); }
    if (bytes.byteLength !== source.selectedByteSize || sha256(bytes) !== source.selectedSha256) throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH");
    try {
      if (source.sourceKind === "s1_original") await inspectCanonicalS1Png(bytes);
      else assertS2Png(bytes);
    } catch { throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH"); }
  }

  private storedSourceIsValid(option: EligibleSource, validateS2Media: boolean): boolean {
    try {
      const bytes = this.objects.read(option.selectedStorageKey);
      if (bytes.byteLength !== option.selectedByteSize || sha256(bytes) !== option.selectedSha256) return false;
      if (validateS2Media) {
        assertS2Png(bytes);
        if (bytes.readUInt32BE(16) !== option.selectedWidth || bytes.readUInt32BE(20) !== option.selectedHeight) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private repairedSourceOption(
    state: StoreState,
    projectId: UUID,
    generationSetId: UUID,
    input: S2InputVersion,
    run: S2QaRun,
    source: S2InputVersion["sourceCandidates"][number] | undefined,
    candidate: ConceptCandidate | undefined,
    qa: S2QaCandidateResult | undefined,
    candidateIndex: 1 | 2 | 3 | 4,
    repair: S2RepairAttempt,
  ): EligibleSource | null {
    if (!source || !candidate || !qa) return null;
    if (candidate.projectId !== projectId || candidate.generationSetId !== generationSetId) return null;
    if (input.projectId !== projectId || input.sourceGenerationSetId !== generationSetId) return null;
    if (run.projectId !== projectId || run.inputVersionId !== input.id || run.sourceGenerationSetId !== generationSetId) return null;
    if (qa.qaRunId !== run.id || qa.inputVersionId !== input.id || qa.candidateId !== candidate.candidateId || qa.candidateIndex !== candidateIndex) return null;
    if (qa.sourceAssetId !== source.sourceAssetId || qa.sourceByteSize !== source.sourceByteSize || qa.sourceSha256 !== source.sourceSha256 || qa.repairAttemptId !== repair.id) return null;
    if (repair.projectId !== projectId || repair.qaRunId !== run.id || repair.inputVersionId !== input.id || repair.candidateId !== candidate.candidateId) return null;
    if (repair.sourceAssetId !== source.sourceAssetId || repair.sourceByteSize !== source.sourceByteSize || repair.sourceSha256 !== source.sourceSha256) return null;
    if (repair.status !== "re_qa_pass" && repair.status !== "re_qa_warning") return null;
    if (!repair.derivedCandidateId || !repair.reQaCandidateResultId || !repair.outputSha256) return null;

    const derived = state.s2DerivedCandidates.find((item) => item.id === repair.derivedCandidateId);
    const reQa = state.s2ReQaResults.find((item) => item.id === repair.reQaCandidateResultId);
    if (!derived || !reQa) return null;
    if (derived.projectId !== projectId || derived.sourceGenerationSetId !== generationSetId || derived.inputVersionId !== input.id || derived.qaRunId !== run.id) return null;
    if (derived.sourceCandidateId !== candidate.candidateId || derived.repairAttemptId !== repair.id || derived.sourceAssetId !== source.sourceAssetId) return null;
    if (derived.sourceByteSize !== source.sourceByteSize || derived.sourceSha256 !== source.sourceSha256 || derived.outputSha256 !== repair.outputSha256) return null;
    if (derived.storageKeyNormalized !== `projects/${projectId}/s2/repairs/${repair.id}/output.png`) return null;
    if (reQa.qaRunId !== run.id || reQa.inputVersionId !== input.id || reQa.candidateId !== candidate.candidateId || reQa.candidateIndex !== candidateIndex) return null;
    if (reQa.sourceAssetId !== source.sourceAssetId || reQa.sourceByteSize !== source.sourceByteSize || reQa.sourceSha256 !== source.sourceSha256) return null;
    if (reQa.derivedCandidateId !== derived.id || reQa.repairAttemptId !== repair.id || reQa.phase !== "re_qa") return null;
    if (reQa.status !== "pass" && reQa.status !== "warning") return null;

    const option: EligibleSource = {
      sourceCandidateId: candidate.candidateId, candidate, candidateIndex, sourceKind: "s2_repaired",
      selectedAssetKind: "s2_derived_candidate", selectedAssetId: derived.id, selectedStorageKey: derived.storageKeyNormalized,
      selectedSha256: derived.outputSha256, selectedByteSize: derived.normalizedBytes, selectedWidth: derived.width,
      selectedHeight: derived.height, selectedPixelCount: derived.width * derived.height, selectedDecodedRgbaBytes: derived.width * derived.height * 4,
      sourceQaResult: qa, sourceS2RepairAttempt: repair, sourceS2ReQaResult: reQa, sourceS2DerivedCandidate: derived, input, qaRun: run,
    };
    return this.storedSourceIsValid(option, true) ? option : null;
  }

  private sourceOptions(state: StoreState, projectId: UUID): { input: S2InputVersion; run: S2QaRun; options: EligibleSource[]; screened: PublicS3ScreenedCandidate[] } {
    const { generationSet } = this.generation(state, projectId);
    const input = this.inputFor(state, projectId, generationSet.generationSetId);
    const run = this.qaRunFor(state, input);
    const latest = latestSourceQaResults(run.candidateResults);
    const options: EligibleSource[] = [];
    const screened: PublicS3ScreenedCandidate[] = [];
    for (const index of [1, 2, 3, 4] as const) {
      const source = input.sourceCandidates.find((item) => item.candidateIndex === index);
      const candidate = state.candidates.find((item) => item.candidateId === source?.candidateId && item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
      const qa = latest.find((item) => item.candidateIndex === index && item.candidateId === source?.candidateId);
      const sourceQaStatus: PublicS3ScreenedCandidate["sourceQaStatus"] = qa?.status === "pass" ? "PASS" : qa?.status === "warning" ? "WARNING" : qa?.status === "material_fail" ? "MATERIAL_FAIL" : "QA_UNAVAILABLE";
      const originalSourceId = qa && (qa.status === "pass" || qa.status === "warning") && source && candidate ? candidate.candidateId : null;
      const repairedSourceIds: UUID[] = [];
      if (source && candidate && qa) {
        const repairs = state.s2Repairs.filter((item) => item.projectId === projectId && item.candidateId === candidate.candidateId && (item.status === "re_qa_pass" || item.status === "re_qa_warning"));
        for (const repair of repairs) {
          const option = this.repairedSourceOption(state, projectId, generationSet.generationSetId, input, run, source, candidate, qa, index, repair);
          if (!option) continue;
          options.push(option); repairedSourceIds.push(option.selectedAssetId);
        }
      }
      if (source && candidate && qa && (qa.status === "pass" || qa.status === "warning")) {
        const concept = state.conceptAssets.find((item) => item.assetId === candidate.assetId && item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
        if (concept) {
          const option: EligibleSource = {
            sourceCandidateId: candidate.candidateId, candidate, candidateIndex: index, sourceKind: "s1_original",
            selectedAssetKind: "s1_concept_asset", selectedAssetId: concept.assetId, selectedStorageKey: concept.storageKey,
            selectedSha256: concept.sha256, selectedByteSize: concept.byteSize, selectedWidth: source.sourceWidth,
            selectedHeight: source.sourceHeight, selectedPixelCount: source.sourcePixelCount, selectedDecodedRgbaBytes: source.sourceDecodedRgbaBytes,
            sourceQaResult: qa, sourceS2RepairAttempt: null, sourceS2ReQaResult: null, sourceS2DerivedCandidate: null, input, qaRun: run,
          };
          if (this.storedSourceIsValid(option, false)) options.push(option);
        }
      }
      screened.push({ candidateIndex: index, sourceQaStatus, originalSourceId, repairedSourceIds });
    }
    return { input, run, options, screened };
  }

  private sourceOptionsSync(state: StoreState, projectId: UUID): { input: S2InputVersion; run: S2QaRun; options: EligibleSource[]; screened: PublicS3ScreenedCandidate[] } {
    return this.sourceOptions(state, projectId);
  }

  private findSourceTarget(state: StoreState, projectId: UUID, targetId: UUID): EligibleSource | null {
    const resolved = this.sourceOptionsSync(state, projectId).options.find((item) => item.sourceCandidateId === targetId || item.selectedAssetId === targetId);
    return resolved ?? null;
  }

  private sourceBinding(option: EligibleSource, sourceSnapshotId: UUID): CanonicalSourceBinding {
    const compiler = option.candidate.compilerMetadata;
    const repair = option.sourceS2RepairAttempt;
    const eligibility = option.sourceS2ReQaResult ?? option.sourceQaResult;
    return {
      schemaVersion: "s3-source-binding-v1", projectId: option.candidate.projectId, generationSetId: option.input.sourceGenerationSetId,
      candidateIndex: option.candidateIndex, sourceKind: option.sourceKind, sourceCandidateId: option.sourceCandidateId,
      ultimateS1CandidateId: option.sourceCandidateId, ultimateS1AssetId: option.candidate.assetId, selectedAssetKind: option.selectedAssetKind,
      selectedAssetId: option.selectedAssetId, selectedSha256: option.selectedSha256, selectedByteSize: option.selectedByteSize,
      selectedWidth: option.selectedWidth, selectedHeight: option.selectedHeight, selectedPixelCount: option.selectedPixelCount,
      selectedDecodedRgbaBytes: option.selectedDecodedRgbaBytes, s1CompilerVersion: compiler.compilerVersion, s1DirectionKey: compiler.directionKey,
      s1CanonicalInputHash: compiler.canonicalInputHash, s1PromptHash: compiler.promptHash, s1Provider: "openai",
      s1ImageModelSnapshot: "gpt-image-2-2026-04-21", confirmedBriefVersionId: option.input.confirmedBriefVersionId,
      confirmedBriefContentHash: option.input.confirmedBriefContentHash, s2InputVersionId: option.input.id, s2InputBindingHash: option.input.bindingHash,
      s2QaRunId: option.qaRun.id, s2SourceQaResultId: option.sourceQaResult.id, s2QaModelSnapshot: "gpt-5.4-mini-2026-03-17",
      s2RepairAttemptId: repair?.id ?? null, s2ReQaResultId: option.sourceS2ReQaResult?.id ?? null, s2DerivedCandidateId: option.sourceS2DerivedCandidate?.id ?? null,
      s2RepairInputHash: repair?.repairInputHash ?? null, s2RepairPromptHash: repair?.repairPromptHash ?? null,
      s2RepairModelSnapshot: repair ? "gpt-image-2-2026-04-21" : null, eligibilityResultId: eligibility.id,
      eligibilityStatus: eligibility.status === "warning" ? "warning" : "pass",
      eligibilityVerdict: eligibility.status === "warning" ? "WARNING" : "PASS",
    };
  }

  private createSourceContext(state: StoreState, option: EligibleSource): SourceContext {
    const sourceSnapshotId = this.uuid();
    const sourceRootRevisionId = this.uuid();
    const binding = this.sourceBinding(option, sourceSnapshotId);
    const source: S3SourceSnapshot = {
      sourceSnapshotId, sourceRootRevisionId, projectId: option.candidate.projectId, generationSetId: option.input.sourceGenerationSetId,
      candidateIndex: option.candidateIndex, sourceKind: option.sourceKind, canonicalSourceBinding: binding, sourceBindingHash: sha256(Buffer.from(jcs(binding), "utf8")),
      selectedAssetKind: option.selectedAssetKind, selectedAssetId: option.selectedAssetId, selectedStorageKey: option.selectedStorageKey,
      selectedSha256: option.selectedSha256, selectedByteSize: option.selectedByteSize, selectedWidth: option.selectedWidth,
      selectedHeight: option.selectedHeight, selectedPixelCount: option.selectedPixelCount, selectedDecodedRgbaBytes: option.selectedDecodedRgbaBytes,
      confirmedBriefVersionId: option.input.confirmedBriefVersionId, confirmedBriefContentHash: option.input.confirmedBriefContentHash,
      s2InputVersionId: option.input.id, s2InputBindingHash: option.input.bindingHash, geometrySnapshot: cloneJson(option.input.geometrySnapshot),
      geometryHash: option.input.geometryHash, canonicalRequirements: cloneJson(option.input.canonicalRequirements), requirementHash: option.input.requirementHash,
      designRulesVersion: "s2-design-rules-v1", designRuleSnapshot: cloneJson(option.input.designRuleSnapshot), designRuleSnapshotHash: designRuleSnapshotHash(option.input.designRuleSnapshot), createdAt: this.clock(),
    };
    const revision: S3SourceRevision = {
      revisionId: sourceRootRevisionId, projectId: option.candidate.projectId, generationSetId: option.input.sourceGenerationSetId,
      confirmedBriefVersionId: option.input.confirmedBriefVersionId, confirmedBriefContentHash: option.input.confirmedBriefContentHash,
      geometrySnapshot: cloneJson(option.input.geometrySnapshot), geometryHash: option.input.geometryHash, s2InputVersionId: option.input.id,
      s2InputBindingHash: option.input.bindingHash, sourceSnapshotId, sourceBindingHash: source.sourceBindingHash,
      ultimateS1CandidateId: option.sourceCandidateId, sourceS2QaResultId: option.sourceQaResult.id,
      sourceS2RepairAttemptId: option.sourceS2RepairAttempt?.id ?? null, sourceS2ReQaResultId: option.sourceS2ReQaResult?.id ?? null,
      sourceS2DerivedCandidateId: option.sourceS2DerivedCandidate?.id ?? null, outputAssetId: option.selectedAssetId,
      outputSha256: option.selectedSha256, outputByteSize: option.selectedByteSize, outputWidth: option.selectedWidth,
      outputHeight: option.selectedHeight, outputPixelCount: option.selectedPixelCount, createdAt: this.clock(), kind: "source_selection",
      lineageRootRevisionId: sourceRootRevisionId, parentRevisionId: null, refinementCycleNumber: 0, refinementIntentText: null,
      refinementIntentHash: null, refinementInputHash: null, compilerVersion: null, promptHash: null, providerMetadata: null,
      outputAssetKind: option.selectedAssetKind, assessmentId: null,
    };
    return { source, revision };
  }

  private sourceByRevision(state: StoreState, revisionId: UUID): SourceContext | null {
    const revision = state.s3Revisions.find((item) => item.revisionId === revisionId && item.kind === "source_selection") as S3SourceRevision | undefined;
    if (!revision) return null;
    const source = state.s3Sources.find((item) => item.sourceSnapshotId === revision.sourceSnapshotId);
    return source ? { source, revision } : null;
  }

  private selection(state: StoreState, projectId: UUID): S3SelectionState | null {
    const { generationSet } = this.generation(state, projectId);
    return state.s3Selections.find((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId) ?? null;
  }

  private sourceForSelection(state: StoreState, selection: S3SelectionState): S3SourceSnapshot {
    const active = selection.activeRevisionId ? state.s3Revisions.find((item) => item.revisionId === selection.activeRevisionId) : undefined;
    const source = active ? state.s3Sources.find((item) => item.sourceSnapshotId === active.sourceSnapshotId) : undefined;
    if (!source) throw fail(500, "S3_INTERNAL_ERROR");
    return source;
  }

  private waiveRetries(state: StoreState, selectionStateId: UUID, reason: S3RetryWaivedReason, referenceId: UUID): void {
    for (const cycle of state.s3Cycles.filter((item) => item.selectionStateId === selectionStateId && (item.status === "image_retry_available" || item.status === "assessment_retry_available"))) {
      const prior = cycle.retryState;
      cycle.retryState = "waived"; cycle.retryWaivedReason = reason; cycle.status = "waived"; cycle.updatedAt = this.clock(); cycle.terminalAt = cycle.terminalAt ?? this.clock();
      this.transition(state, cycle.projectId, { cycleId: cycle.cycleId, phase: "cycle", from: prior, to: "waived", reason, requestReferenceId: referenceId });
      if (cycle.assessmentId) {
        const assessment = state.s3Assessments.find((item) => item.assessmentId === cycle.assessmentId);
        if (assessment && assessment.retryState === "available") {
          assessment.status = "qa_unavailable_terminal";
          assessment.retryState = "waived"; assessment.retryWaivedReason = reason; assessment.updatedAt = this.clock();
          this.transition(state, cycle.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, phase: "assessment", from: "available", to: "waived", reason, requestReferenceId: referenceId });
        }
      }
    }
  }

  private s4StageForSelection(state: StoreState, selection: S3SelectionState) {
    return state.s4Stages.find((item) => item.projectId === selection.projectId &&
      item.generationSetId === selection.generationSetId &&
      item.selectionStateId === selection.selectionStateId &&
      item.lineageRootRevisionId === selection.lineageRootRevisionId);
  }

  private s4RollbackInProgress(state: StoreState, selectionStateId: UUID): boolean {
    const liveEditStatuses = new Set([
      "mask_materialization_pending", "image_queued", "image_running", "publication_pending",
      "preservation_pending", "preservation_running", "assessment_pending", "assessment_running",
    ]);
    if (state.s4Edits.some((item) => item.selectionStateId === selectionStateId && liveEditStatuses.has(item.status))) return true;
    if (state.s4ImageOperations.some((item) => item.selectionStateId === selectionStateId &&
        (item.status === "queued" || item.status === "running" || item.claimedBy !== null || item.claimedProcessId !== null || item.claimToken !== null))) return true;
    if (state.s4AssessmentAttempts.some((item) => item.selectionStateId === selectionStateId &&
        (item.status === "queued" || item.status === "running" || item.claimedBy !== null || item.claimedProcessId !== null || item.claimToken !== null))) return true;
    if (state.s4PreservationChecks.some((item) => item.selectionStateId === selectionStateId &&
        (item.status === "pending" || item.status === "running" || item.claimedBy !== null || item.claimedProcessId !== null || item.claimToken !== null))) return true;
    return state.s4Publications.some((item) => item.selectionStateId === selectionStateId &&
      (item.state === "staged" || item.state === "promoted" || item.ownerProcessId !== null || item.ownerClaimToken !== null));
  }

  private waiveS4Retries(state: StoreState, selection: S3SelectionState, reason: S4RetryWaivedReason, referenceId: UUID): void {
    for (const edit of state.s4Edits.filter((item) => item.selectionStateId === selection.selectionStateId &&
        (item.status === "image_retry_available" || item.status === "assessment_retry_available"))) {
      const previous = edit.status;
      edit.status = "waived";
      edit.retryState = "waived";
      edit.retryWaivedReason = reason;
      edit.terminalAt = edit.terminalAt ?? this.clock();
      edit.updatedAt = this.clock();
      if (edit.assessmentId) {
        const assessment = state.s4Assessments.find((item) => item.assessmentId === edit.assessmentId);
        if (assessment?.retryState === "available") {
          assessment.retryState = "waived";
          assessment.retryWaivedReason = reason;
          assessment.updatedAt = this.clock();
        }
      }
      state.s4Transitions.push({
        transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
        generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
        editId: edit.editId, operationId: null, publicationId: null,
        preservationCheckId: edit.preservationCheckId, assessmentId: edit.assessmentId,
        assessmentAttemptId: null, phase: "edit", attempt: null,
        from: previous, to: "waived", reason: "retry_waived",
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: edit.outputRevisionId,
        expectedSelectionVersion: selection.selectionVersion,
        resultingSelectionVersion: selection.selectionVersion, requestReferenceId: referenceId,
      });
    }
  }

  private recordS4Rollback(
    state: StoreState,
    selection: S3SelectionState,
    fromRevisionId: UUID,
    toRevisionId: UUID,
    expectedSelectionVersion: number,
    resultingSelectionVersion: number,
    targetRevisionKind: "s3" | "s4",
    referenceId: UUID,
  ): void {
    const currentS4 = state.s4Revisions.find((item) => item.revisionId === fromRevisionId);
    const targetS4 = state.s4Revisions.find((item) => item.revisionId === toRevisionId);
    const s4Revision = targetRevisionKind === "s4" ? targetS4 : currentS4;
    const edit = s4Revision ? state.s4Edits.find((item) => item.editId === s4Revision.editId) : undefined;
    state.s4Transitions.push({
      transitionId: this.uuid(), at: this.clock(), projectId: selection.projectId,
      generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId,
      editId: edit?.editId ?? null, operationId: null, publicationId: null,
      preservationCheckId: edit?.preservationCheckId ?? null, assessmentId: edit?.assessmentId ?? null,
      assessmentAttemptId: null, phase: "rollback", attempt: null,
      from: "activation", to: "rollback", reason: "rollback",
      priorRevisionId: fromRevisionId, resultingRevisionId: toRevisionId,
      expectedSelectionVersion, resultingSelectionVersion, requestReferenceId: referenceId,
    });
  }

  private activeTip(state: StoreState, selection: S3SelectionState): UUID | null {
    const events = state.s3SelectionEvents.filter((item) => item.selectionStateId === selection.selectionStateId && item.kind === "activate_refinement");
    return events.sort((left, right) => right.resultingSuccessfulRefinementCount - left.resultingSuccessfulRefinementCount)[0]?.toRevisionId ?? null;
  }

  private revisionAssessment(state: StoreState, revision: S3Revision): S3Assessment | null {
    return revision.kind === "refinement" ? state.s3Assessments.find((item) => item.assessmentId === revision.assessmentId) ?? null : null;
  }

  private sourceStatusForRevision(source: S3SourceSnapshot): "PASS" | "WARNING" {
    return source.canonicalSourceBinding.eligibilityVerdict;
  }

  private publicStateFrom(state: StoreState, projectId: UUID): PublicS3State {
    const { generationSet } = this.generation(state, projectId);
    const selection = state.s3Selections.find((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId) ?? null;
    let activeSourceSnapshotId: UUID | null = null;
    if (selection?.activeRevisionId) {
      try { activeSourceSnapshotId = resolveVisualRevision(state, projectId, selection.activeRevisionId, this.objects).sourceSnapshotId; }
      catch { activeSourceSnapshotId = null; }
    }
    const screened = this.sourceOptionsSync(state, projectId).screened;
    const sources: PublicS3Source[] = state.s3Sources.filter((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId).map((source) => ({
      sourceId: source.sourceSnapshotId, sourceKind: source.sourceKind, candidateIndex: source.candidateIndex, sourceRevisionId: source.sourceRootRevisionId,
      qaStatus: this.sourceStatusForRevision(source), selected: activeSourceSnapshotId === source.sourceSnapshotId,
      eligible: true, previewAvailable: this.objects.exists(source.selectedStorageKey),
    }));
    const activated = new Map<UUID, 1 | 2>();
    for (const event of state.s3SelectionEvents.filter((item) => item.projectId === projectId && item.kind === "activate_refinement")) activated.set(event.toRevisionId, event.resultingSuccessfulRefinementCount as 1 | 2);
    const revisions: PublicS3Revision[] = state.s3Revisions.filter((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((revision) => {
      const source = state.s3Sources.find((item) => item.sourceSnapshotId === revision.sourceSnapshotId)!;
      const assessment = this.revisionAssessment(state, revision);
      const relatedCycles = state.s3Cycles.filter((item) => item.outputRevisionId === revision.revisionId);
      const imageRetryAvailable = relatedCycles.some((item) => item.status === "image_retry_available");
      const assessmentRetryAvailable = relatedCycles.some((item) => item.status === "assessment_retry_available");
      const active = selection?.activeRevisionId === revision.revisionId;
      const wasActivated = activated.has(revision.revisionId);
      const usable = revision.kind === "source_selection" ? wasActivated || active : wasActivated || active;
      return {
        revisionId: revision.revisionId, kind: revision.kind, parentRevisionId: revision.parentRevisionId, cycleNumber: revision.refinementCycleNumber,
        sourceKind: source.sourceKind, candidateIndex: source.candidateIndex, userIntentText: revision.refinementIntentText,
        assessmentStatus: publicAssessmentStatus(assessment?.status ?? null), assessmentRetryAvailable, imageRetryAvailable,
        successfulSequence: activated.get(revision.revisionId) ?? null, activationState: active ? "active_tip" : usable ? "usable_history" : "historical_non_activatable",
        active, usable, previewAvailable: revision.kind === "source_selection" ? this.objects.exists(source.selectedStorageKey) : Boolean(state.s3Assets.find((item) => item.assetId === revision.outputAssetId) && this.objects.exists(state.s3Assets.find((item) => item.assetId === revision.outputAssetId)!.storageKeyNormalized)), createdAt: revision.createdAt,
      };
    });
    const cycles: PublicS3Cycle[] = state.s3Cycles.filter((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId).sort((a, b) => a.cycleNumber - b.cycleNumber).map((cycle) => {
      const assessment = cycle.assessmentId ? state.s3Assessments.find((item) => item.assessmentId === cycle.assessmentId) ?? null : null;
      return { cycleId: cycle.cycleId, cycleNumber: cycle.cycleNumber, status: publicCycleStatus(cycle, assessment), baseRevisionId: cycle.baseRevisionId, outputRevisionId: cycle.outputRevisionId, assessmentStatus: publicAssessmentStatus(assessment?.status ?? null) as PublicS3Cycle["assessmentStatus"], imageRetryAvailable: cycle.status === "image_retry_available", assessmentRetryAvailable: cycle.status === "assessment_retry_available", slotConsumed: true };
    });
    const consumed = selection?.cycleSlotsConsumed ?? 0;
    return { projectId, generationSetId: generationSet.generationSetId, selectionVersion: selection?.selectionVersion ?? 0, activeRevisionId: selection?.activeRevisionId ?? null, cycleSlotsConsumed: asCount(consumed), cycleSlotsRemaining: asCount(S3_CYCLE_SLOTS - consumed), successfulRefinementCount: asCount(selection?.successfulRefinementCount ?? 0), screenedCandidates: screened, sources, revisions, cycles };
  }

  getState(projectId: UUID): PublicS3State {
    return this.publicStateFrom(this.state(), projectId);
  }

  private publicAssessment(assessment: S3Assessment | null): PublicS3AssessmentSummary | null {
    if (!assessment) return null;
    const attempt = this.state().s3AssessmentAttempts.find((item) => item.assessmentAttemptId === assessment.latestAttemptId);
    return { status: publicAssessmentStatus(assessment.status) as PublicS3AssessmentSummary["status"], materialFindingCount: attempt?.materialFindingIds.length ?? 0, warningFindingCount: attempt?.warningFindingIds.length ?? 0, uncertainFindingCount: attempt?.uncertainFindingIds.length ?? 0, retryAvailable: assessment.retryState === "available" };
  }

  getCycle(projectId: UUID, cycleId: UUID): PublicS3CycleDetail {
    const state = this.state(); this.generation(state, projectId);
    const cycle = state.s3Cycles.find((item) => item.cycleId === cycleId && item.projectId === projectId);
    if (!cycle) throw fail(404, "S3_CYCLE_NOT_FOUND");
    const publicState = this.publicStateFrom(state, projectId);
    return { cycle: publicState.cycles.find((item) => item.cycleId === cycleId)!, revision: cycle.outputRevisionId ? publicState.revisions.find((item) => item.revisionId === cycle.outputRevisionId) ?? null : null, assessment: cycle.assessmentId ? this.publicAssessment(state.s3Assessments.find((item) => item.assessmentId === cycle.assessmentId) ?? null) : null };
  }

  getRevision(projectId: UUID, revisionId: UUID): PublicS3RevisionDetail {
    const state = this.state(); this.generation(state, projectId);
    const revision = state.s3Revisions.find((item) => item.revisionId === revisionId && item.projectId === projectId);
    if (!revision) throw fail(404, "S3_REVISION_NOT_FOUND");
    const publicState = this.publicStateFrom(state, projectId);
    return { revision: publicState.revisions.find((item) => item.revisionId === revisionId)!, assessment: this.publicAssessment(this.revisionAssessment(state, revision)) };
  }

  async getPreview(projectId: UUID, revisionId: UUID): Promise<{ bytes: Buffer; contentLength: number }> {
    const state = this.state(); this.generation(state, projectId);
    const known = state.s3Revisions.some((item) => item.revisionId === revisionId && item.projectId === projectId) ||
      state.s4Revisions.some((item) => item.revisionId === revisionId && item.projectId === projectId);
    if (!known) throw fail(404, "S3_REVISION_NOT_FOUND");
    try {
      const resolved = resolveVisualRevision(state, projectId, revisionId, this.objects);
      const bytes = this.objects.read(resolved.storageKey);
      if (bytes.byteLength !== resolved.byteSize || sha256(bytes) !== resolved.sha256) throw new Error("identity");
      await inspectExactS3Png(bytes);
      return { bytes, contentLength: bytes.byteLength };
    } catch {
      throw fail(500, "S3_INTERNAL_ERROR");
    }
  }

  selectSource(projectId: UUID, targetKind: "source_root" | "revision", targetId: UUID, expectedSelectionVersion: number, key: UUID, referenceId: UUID): PublicS3Mutation<PublicS3SelectionResult> {
    assertUuid(targetId, "targetId"); if (!Number.isSafeInteger(expectedSelectionVersion) || expectedSelectionVersion < 0) throw fail(400, "INVALID_REQUEST", "expectedSelectionVersion");
    const requestHash = operationHash("s3_selection_request", projectId, { targetKind, targetId, expectedSelectionVersion });
    const result = this.repository.transact((state) => {
      const { generationSet } = this.generation(state, projectId);
      const replay = this.idempotency(state, key, "s3_selection", projectId, requestHash);
      if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS3SelectionResult };
      const current = state.s3Selections.find((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId) ?? null;
      if (!current) {
        if (targetKind !== "source_root" || expectedSelectionVersion !== 0) throw fail(409, "S3_SELECTION_VERSION_CONFLICT");
        const sourceTarget = this.findSourceTarget(state, projectId, targetId);
        if (!sourceTarget) throw fail(409, "S3_SOURCE_NOT_ELIGIBLE");
        const context = this.createSourceContext(state, sourceTarget); const selectionStateId = this.uuid();
        state.s3Sources.push(context.source); state.s3Revisions.push(context.revision);
        const selection: S3SelectionState = { selectionStateId, projectId, generationSetId: generationSet.generationSetId, confirmedBriefVersionId: sourceTarget.input.confirmedBriefVersionId, confirmedBriefContentHash: sourceTarget.input.confirmedBriefContentHash, s2InputVersionId: sourceTarget.input.id, s2InputBindingHash: sourceTarget.input.bindingHash, geometrySnapshot: cloneJson(sourceTarget.input.geometrySnapshot), geometryHash: sourceTarget.input.geometryHash, activeRevisionId: context.revision.revisionId, lineageRootRevisionId: context.revision.revisionId, selectionVersion: 1, cycleSlotsConsumed: 0, successfulRefinementCount: 0, createdAt: this.clock(), updatedAt: this.clock() };
        state.s3Selections.push(selection);
        state.s3SelectionEvents.push({ eventId: this.uuid(), projectId, selectionStateId, kind: "select_source", fromRevisionId: null, toRevisionId: context.revision.revisionId, sourceSnapshotId: context.source.sourceSnapshotId, cycleId: null, assessmentId: null, expectedSelectionVersion: 0, resultingSelectionVersion: 1, resultingSuccessfulRefinementCount: 0, idempotencyKey: key, requestReferenceId: referenceId, at: this.clock() });
        const response: PublicS3SelectionResult = { selectionVersion: 1, activeRevisionId: context.revision.revisionId, activeSourceId: context.source.sourceSnapshotId, eventKind: "select_source" };
        this.remember(state, key, "s3_selection", projectId, requestHash, response as unknown as Record<string, unknown>);
        return { replayed: false, result: response };
      }
      if (current.selectionVersion !== expectedSelectionVersion) throw fail(409, "S3_SELECTION_VERSION_CONFLICT");
      if (targetKind === "source_root") {
        if (this.s4StageForSelection(state, current)) throw fail(409, "S3_LINEAGE_CONFLICT");
        if (current.successfulRefinementCount > 0) throw fail(409, "S3_SOURCE_RESELECTION_CLOSED");
        const oldRevision = current.activeRevisionId ? state.s3Revisions.find((item) => item.revisionId === current.activeRevisionId) : null;
        const existingSource = state.s3Sources.find((item) => item.sourceSnapshotId === oldRevision?.sourceSnapshotId);
        const sourceTarget = state.s3Sources.find((item) => item.sourceSnapshotId === targetId || item.sourceRootRevisionId === targetId)
          ? null
          : this.findSourceTarget(state, projectId, targetId);
        if (!sourceTarget) {
          const targetSource = state.s3Sources.find((item) => item.sourceSnapshotId === targetId || item.sourceRootRevisionId === targetId);
          if (!targetSource || targetSource.projectId !== projectId || targetSource.generationSetId !== generationSet.generationSetId) throw fail(409, "S3_SOURCE_NOT_ELIGIBLE");
          if (existingSource?.sourceSnapshotId === targetSource.sourceSnapshotId) {
            const response: PublicS3SelectionResult = { selectionVersion: current.selectionVersion, activeRevisionId: current.activeRevisionId!, activeSourceId: targetSource.sourceSnapshotId, eventKind: null };
            this.remember(state, key, "s3_selection", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
          }
          throw fail(409, "S3_SOURCE_NOT_ELIGIBLE");
        }
        if (state.s3Cycles.some((item) => item.selectionStateId === current.selectionStateId && ["image_queued", "image_running", "publication_pending", "assessment_pending", "assessment_running"].includes(item.status))) throw fail(409, "S3_REFINEMENT_IN_PROGRESS");
        const context = this.createSourceContext(state, sourceTarget); this.waiveRetries(state, current.selectionStateId, "reselected", referenceId);
        state.s3Sources.push(context.source); state.s3Revisions.push(context.revision);
        const fromRevisionId = current.activeRevisionId; const expected = current.selectionVersion; current.activeRevisionId = context.revision.revisionId; current.lineageRootRevisionId = context.revision.revisionId; current.selectionVersion += 1; current.updatedAt = this.clock();
        state.s3SelectionEvents.push({ eventId: this.uuid(), projectId, selectionStateId: current.selectionStateId, kind: "reselect_source", fromRevisionId, toRevisionId: context.revision.revisionId, sourceSnapshotId: context.source.sourceSnapshotId, cycleId: null, assessmentId: null, expectedSelectionVersion: expected, resultingSelectionVersion: current.selectionVersion, resultingSuccessfulRefinementCount: current.successfulRefinementCount, idempotencyKey: key, requestReferenceId: referenceId, at: this.clock() });
        const response: PublicS3SelectionResult = { selectionVersion: current.selectionVersion, activeRevisionId: context.revision.revisionId, activeSourceId: context.source.sourceSnapshotId, eventKind: "reselect_source" }; this.remember(state, key, "s3_selection", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
      }
      if (this.s4RollbackInProgress(state, current.selectionStateId)) throw fail(409, "S4_ROLLBACK_IN_PROGRESS");
      const targetS3 = state.s3Revisions.find((item) => item.revisionId === targetId && item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
      const targetS4 = state.s4Revisions.find((item) => item.revisionId === targetId && item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
      if ((targetS3 ? 1 : 0) + (targetS4 ? 1 : 0) !== 1) throw fail(409, "S3_SELECTION_TARGET_INVALID");
      let currentResolved;
      let targetResolved;
      try {
        currentResolved = resolveVisualRevision(state, projectId, current.activeRevisionId!, this.objects);
        targetResolved = resolveVisualRevision(state, projectId, targetId, this.objects);
      } catch {
        throw fail(409, "S3_SELECTION_TARGET_INVALID");
      }
      if (targetResolved.lineageRootRevisionId !== currentResolved.lineageRootRevisionId) throw fail(409, "S3_LINEAGE_CONFLICT");
      const source = state.s3Sources.find((item) => item.sourceSnapshotId === targetResolved.sourceSnapshotId &&
        item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
      if (!source) throw fail(409, "S3_SELECTION_TARGET_INVALID");
      if (state.s3Cycles.some((item) => item.selectionStateId === current.selectionStateId && ["image_queued", "image_running", "publication_pending", "assessment_pending", "assessment_running"].includes(item.status))) throw fail(409, "S3_REFINEMENT_IN_PROGRESS");
      this.waiveRetries(state, current.selectionStateId, "rolled_back", referenceId);
      this.waiveS4Retries(state, current, "rolled_back", referenceId);
      const fromRevisionId = current.activeRevisionId;
      const expected = current.selectionVersion;
      current.activeRevisionId = targetResolved.revisionId;
      current.selectionVersion += 1;
      current.updatedAt = this.clock();
      if (currentResolved.kind === "s4" || targetResolved.kind === "s4") {
        this.recordS4Rollback(state, current, fromRevisionId!, targetResolved.revisionId, expected, current.selectionVersion, targetResolved.kind, referenceId);
      }
      state.s3SelectionEvents.push({ eventId: this.uuid(), projectId, selectionStateId: current.selectionStateId, kind: "rollback", fromRevisionId, toRevisionId: targetResolved.revisionId, sourceSnapshotId: source.sourceSnapshotId, cycleId: null, assessmentId: targetResolved.kind === "s3" && targetS3?.kind === "refinement" ? targetS3.assessmentId : targetResolved.kind === "s4" ? targetResolved.assessmentId : null, expectedSelectionVersion: expected, resultingSelectionVersion: current.selectionVersion, resultingSuccessfulRefinementCount: current.successfulRefinementCount, idempotencyKey: key, requestReferenceId: referenceId, at: this.clock() });
      const response: PublicS3SelectionResult = { selectionVersion: current.selectionVersion, activeRevisionId: targetResolved.revisionId, activeSourceId: source.sourceSnapshotId, eventKind: "rollback" }; this.remember(state, key, "s3_selection", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
    });
    return result;
  }

  refine(projectId: UUID, baseRevisionId: UUID, expectedSelectionVersion: number, intentText: unknown, key: UUID, referenceId: UUID): PublicS3Mutation<PublicS3RefinementAdmission> {
    assertUuid(baseRevisionId, "baseRevisionId"); if (!Number.isSafeInteger(expectedSelectionVersion) || expectedSelectionVersion < 1) throw fail(400, "INVALID_REQUEST", "expectedSelectionVersion");
    let normalized: string; try { normalized = normalizeS3Intent(intentText); } catch { throw fail(400, "S3_INTENT_INVALID", "intentText"); }
    const requestHash = operationHash("s3_refinement_request", projectId, { baseRevisionId, expectedSelectionVersion, intentText: normalized });
    const result = this.repository.transact((state) => {
      const { generationSet } = this.generation(state, projectId); const selection = state.s3Selections.find((item) => item.projectId === projectId && item.generationSetId === generationSet.generationSetId);
      if (!selection) throw fail(409, "S3_SOURCE_NOT_FOUND");
      const replay = this.idempotency(state, key, "s3_refinement", projectId, requestHash); if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS3RefinementAdmission };
      if (this.s4StageForSelection(state, selection)) throw fail(409, "S3_LINEAGE_CONFLICT");
      if (selection.selectionVersion !== expectedSelectionVersion) throw fail(409, "S3_SELECTION_VERSION_CONFLICT");
      if (selection.activeRevisionId !== baseRevisionId) throw fail(409, "S3_LINEAGE_CONFLICT");
      const activeTip = this.activeTip(state, selection); if (selection.successfulRefinementCount > 0 && activeTip !== baseRevisionId) throw fail(409, "S3_LINEAGE_CONFLICT");
      const live = state.s3Cycles.find((item) => item.selectionStateId === selection.selectionStateId && ["image_queued", "image_running", "publication_pending", "assessment_pending", "assessment_running"].includes(item.status));
      if (live) throw fail(409, "S3_REFINEMENT_IN_PROGRESS");
      if (selection.cycleSlotsConsumed >= S3_CYCLE_SLOTS) throw fail(409, "S3_REFINEMENT_BUDGET_EXHAUSTED");
      for (const old of state.s3Cycles.filter((item) => item.selectionStateId === selection.selectionStateId && (item.status === "image_retry_available" || item.status === "assessment_retry_available"))) {
        this.waiveRetries(state, selection.selectionStateId, "later_cycle_started", referenceId); break;
      }
      const source = state.s3Sources.find((item) => item.sourceSnapshotId === state.s3Revisions.find((rev) => rev.revisionId === baseRevisionId)?.sourceSnapshotId);
      const base = state.s3Revisions.find((item) => item.revisionId === baseRevisionId);
      if (!source || !base) throw fail(409, "S3_LINEAGE_CONFLICT");
      if (state.s3Cycles.some((item) => item.selectionStateId === selection.selectionStateId && item.baseRevisionId === baseRevisionId && item.refinementIntentText === normalized)) throw fail(409, "S3_DUPLICATE_REFINEMENT");
      const cycleNumber = (selection.cycleSlotsConsumed + 1) as 1 | 2;
      const baseAsset = this.baseAsset(state, base, source); const compilation = this.compileRefinement(selection, source, base, baseAsset, normalized);
      const cycleId = this.uuid(); const operationId = this.uuid(); const inputHash = canonicalOperationHash({ schemaVersion: "s3-refinement-operation-v1", projectId, generationSetId: generationSet.generationSetId, selectionStateId: selection.selectionStateId, sourceSnapshotId: source.sourceSnapshotId, sourceRootRevisionId: source.sourceRootRevisionId, cycleNumber, baseRevisionId, baseSelectionVersion: selection.selectionVersion, intentHash: compilation.canonicalInput.intentHash, refinementInputHash: compilation.refinementInputHash });
      const cycle: S3RefinementCycle = { cycleId, projectId, selectionStateId: selection.selectionStateId, generationSetId: generationSet.generationSetId, lineageRootRevisionId: selection.lineageRootRevisionId!, cycleNumber, baseRevisionId, baseSelectionVersion: selection.selectionVersion, refinementIntentText: normalized, refinementIntentHash: compilation.canonicalInput.intentHash, refinementInputHash: compilation.refinementInputHash, compilerVersion: "s3-refinement-v1", promptHash: compilation.promptHash, status: "image_queued", retryState: "none", retryWaivedReason: null, imageOperationIds: [operationId], outputRevisionId: null, assessmentId: null, assessmentAttemptIds: [], createdAt: this.clock(), admittedAt: this.clock(), updatedAt: this.clock(), terminalAt: null };
      const operation: S3ImageOperation = { operationId, projectId, cycleId, generationSetId: generationSet.generationSetId, baseRevisionId, baseSelectionVersion: selection.selectionVersion, attempt: 1, retryOfOperationId: null, operationInputHash: inputHash, refinementInputHash: compilation.refinementInputHash, promptHash: compilation.promptHash, requestReferenceId: referenceId, status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", providerMetadata: null, failureCode: null, publicationId: null, outputRevisionId: null, outputAssetId: null, createdAt: this.clock() };
      state.s3Cycles.push(cycle); state.s3ImageOperations.push(operation); selection.cycleSlotsConsumed = cycleNumber; selection.updatedAt = this.clock();
      this.transition(state, projectId, { cycleId, phase: "cycle", from: null, to: "image_queued", requestReferenceId: referenceId }); this.transition(state, projectId, { cycleId, operationId, phase: "image", attempt: 1, from: null, to: "queued", requestReferenceId: referenceId });
      const response: PublicS3RefinementAdmission = { cycleId, cycleNumber, status: "generating", baseRevisionId, selectionVersion: selection.selectionVersion, cycleSlotsConsumed: cycleNumber }; this.remember(state, key, "s3_refinement", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
    });
    if (!result.replayed) this.startImageOperation(result.result.cycleId);
    return result;
  }

  private baseAsset(state: StoreState, revision: S3Revision, source: S3SourceSnapshot): S3BaseAssetIdentity {
    if (revision.kind === "source_selection") return { assetKind: revision.outputAssetKind, assetId: revision.outputAssetId, sha256: revision.outputSha256, byteSize: revision.outputByteSize, width: revision.outputWidth, height: revision.outputHeight, pixelCount: revision.outputPixelCount };
    const asset = state.s3Assets.find((item) => item.assetId === revision.outputAssetId); if (!asset) throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH");
    return { assetKind: "s3_refinement_asset", assetId: asset.assetId, sha256: asset.normalizedSha256, byteSize: asset.normalizedBytes, width: asset.width, height: asset.height, pixelCount: asset.pixelCount };
  }

  private compileRefinement(selection: S3SelectionState, source: S3SourceSnapshot, base: S3Revision, baseAsset: S3BaseAssetIdentity, intentText: string) {
    const context: S3RefinementCompilerContext = { projectId: selection.projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, s2InputVersionId: source.s2InputVersionId, s2InputBindingHash: source.s2InputBindingHash, geometrySnapshot: source.geometrySnapshot, geometryHash: source.geometryHash, canonicalRequirements: source.canonicalRequirements, requirementHash: source.requirementHash, designRuleSnapshot: source.designRuleSnapshot, sourceSnapshotId: source.sourceSnapshotId, sourceBindingHash: source.sourceBindingHash, baseRevisionId: base.revisionId, baseSelectionVersion: selection.selectionVersion, baseAsset, intentText };
    return compileS3Refinement(context);
  }

  private revisionSource(state: StoreState, revision: S3Revision): S3SourceSnapshot {
    const source = state.s3Sources.find((item) => item.sourceSnapshotId === revision.sourceSnapshotId);
    if (!source || source.projectId !== revision.projectId || source.generationSetId !== revision.generationSetId) throw fail(409, "S3_LINEAGE_CONFLICT");
    return source;
  }

  private readRevisionBytes(state: StoreState, revision: S3Revision, source: S3SourceSnapshot): Buffer {
    const asset = revision.kind === "source_selection"
      ? { key: source.selectedStorageKey, sha: revision.outputSha256, bytes: revision.outputByteSize }
      : (() => {
        const generated = state.s3Assets.find((item) => item.assetId === revision.outputAssetId);
        if (!generated) throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH");
        return { key: generated.storageKeyNormalized, sha: generated.normalizedSha256, bytes: generated.normalizedBytes };
      })();
    try {
      const value = this.objects.read(asset.key);
      if (value.byteLength !== asset.bytes || sha256(value) !== asset.sha) throw new Error("object identity");
      return value;
    } catch { throw fail(409, "S3_SOURCE_INTEGRITY_MISMATCH"); }
  }

  private imageDispatchInput(state: StoreState, operation: S3ImageOperation): { input: S3ImageProviderInput; compilation: ReturnType<typeof compileS3Refinement> } {
    const cycle = state.s3Cycles.find((item) => item.cycleId === operation.cycleId);
    const base = state.s3Revisions.find((item) => item.revisionId === operation.baseRevisionId);
    if (!cycle || !base || cycle.projectId !== operation.projectId || cycle.baseRevisionId !== base.revisionId || cycle.baseSelectionVersion !== operation.baseSelectionVersion || cycle.refinementInputHash !== operation.refinementInputHash || cycle.promptHash !== operation.promptHash) throw fail(409, "S3_FENCE_STALE");
    const source = this.revisionSource(state, base);
    const bytes = this.readRevisionBytes(state, base, source);
    const baseAsset = this.baseAsset(state, base, source);
    const selection = state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId);
    if (!selection || selection.projectId !== operation.projectId || selection.generationSetId !== operation.generationSetId || selection.lineageRootRevisionId !== cycle.lineageRootRevisionId || selection.selectionVersion !== operation.baseSelectionVersion || selection.activeRevisionId !== operation.baseRevisionId) throw fail(409, "S3_FENCE_STALE");
    const compilation = this.compileRefinement(selection, source, base, baseAsset, cycle.refinementIntentText);
    if (compilation.refinementInputHash !== operation.refinementInputHash || compilation.promptHash !== operation.promptHash) throw fail(409, "S3_FENCE_STALE");
    return { input: { promptText: compilation.promptText, sourceBytes: bytes }, compilation };
  }

  private claimImage(operationId: UUID): ImageClaim | null {
    return this.repository.transact((state) => {
      const operation = state.s3ImageOperations.find((item) => item.operationId === operationId);
      const cycle = operation ? state.s3Cycles.find((item) => item.cycleId === operation.cycleId) : undefined;
      if (!operation || !cycle || operation.status !== "queued" || cycle.status !== "image_queued") return null;
      const token = this.uuid(); operation.status = "running"; operation.claimedBy = this.workerId; operation.claimedProcessId = this.processId; operation.claimToken = token; operation.claimedAt = this.clock(); operation.startedAt = this.clock();
      const previous = cycle.status; cycle.status = "image_running"; cycle.updatedAt = this.clock();
      this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId, phase: "cycle", attempt: operation.attempt, from: previous, to: "image_running", requestReferenceId: operation.requestReferenceId });
      this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId, phase: "image", attempt: operation.attempt, from: "queued", to: "running", requestReferenceId: operation.requestReferenceId });
      return { operation: cloneJson(operation), token };
    });
  }

  private beginImageDispatch(operationId: UUID, token: UUID): S3ImageOperation | null {
    return this.repository.transact((state) => {
      const operation = state.s3ImageOperations.find((item) => item.operationId === operationId);
      if (!operation || !this.imageClaimMatches(operation, token) || operation.providerDispatchState !== "not_started") return null;
      const cycle = state.s3Cycles.find((item) => item.cycleId === operation.cycleId);
      if (!cycle || cycle.status !== "image_running") return null;
      this.imageDispatchInput(state, operation);
      operation.providerDispatchState = "may_have_started";
      return cloneJson(operation);
    });
  }

  private imageMetadata(result: S3ImageProviderResult): S3ImageProviderMetadata {
    return {
      provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21",
      providerRequestId: safeProviderRequestId(result.providerRequestId), inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null, totalTokens: result.usage?.totalTokens ?? null, receivedAt: this.clock(),
    };
  }

  private assessmentMetadata(result: S3AssessmentProviderResult): S3AssessmentProviderMetadata {
    return {
      provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17",
      providerRequestId: safeProviderRequestId(result.providerRequestId), inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null, totalTokens: result.usage?.totalTokens ?? null, receivedAt: this.clock(),
    };
  }

  private publicationObject(key: string, media: S3ExactPng): S3PublicationObject {
    return { key, sha256: media.sha256, byteSize: media.byteSize, width: 1536, height: 1024, pixelCount: 1_572_864 };
  }

  private createPublicationBundle(state: StoreState, claim: ImageClaim, media: S3ExactPng, metadata: S3ImageProviderMetadata): { publication: S3Publication; asset: S3GeneratedAsset; revision: S3RefinementRevision; assessment: S3Assessment; attempt: S3AssessmentAttempt } {
    const operation = state.s3ImageOperations.find((item) => item.operationId === claim.operation.operationId);
    const cycle = operation ? state.s3Cycles.find((item) => item.cycleId === operation.cycleId) : undefined;
    const base = operation ? state.s3Revisions.find((item) => item.revisionId === operation.baseRevisionId) : undefined;
    if (!operation || !cycle || !base) throw fail(500, "S3_INTERNAL_ERROR");
    const source = this.revisionSource(state, base);
    const selection = state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId);
    if (!selection) throw fail(500, "S3_INTERNAL_ERROR");
    const assetId = this.uuid(); const revisionId = this.uuid(); const assessmentId = this.uuid(); const assessmentAttemptId = this.uuid(); const publicationId = this.uuid();
    const finalKey = privateStorageKey("projects", operation.projectId, "s3", "refinements", assetId, "normalized.png");
    const stagingKey = privateStorageKey("projects", operation.projectId, "s3", "staging", cycle.cycleId, operation.operationId, "normalized.png");
    const revision: S3RefinementRevision = {
      revisionId, projectId: operation.projectId, generationSetId: operation.generationSetId, confirmedBriefVersionId: source.confirmedBriefVersionId,
      confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: cloneJson(source.geometrySnapshot), geometryHash: source.geometryHash,
      s2InputVersionId: source.s2InputVersionId, s2InputBindingHash: source.s2InputBindingHash, sourceSnapshotId: source.sourceSnapshotId,
      sourceBindingHash: source.sourceBindingHash, ultimateS1CandidateId: source.canonicalSourceBinding.ultimateS1CandidateId, sourceS2QaResultId: source.canonicalSourceBinding.s2SourceQaResultId,
      sourceS2RepairAttemptId: source.canonicalSourceBinding.s2RepairAttemptId, sourceS2ReQaResultId: source.canonicalSourceBinding.s2ReQaResultId,
      sourceS2DerivedCandidateId: source.canonicalSourceBinding.s2DerivedCandidateId, outputAssetId: assetId, outputSha256: media.sha256, outputByteSize: media.byteSize,
      outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, createdAt: this.clock(), kind: "refinement", lineageRootRevisionId: cycle.lineageRootRevisionId,
      parentRevisionId: operation.baseRevisionId, refinementCycleNumber: cycle.cycleNumber, refinementIntentText: cycle.refinementIntentText,
      refinementIntentHash: cycle.refinementIntentHash, refinementInputHash: cycle.refinementInputHash, compilerVersion: "s3-refinement-v1", promptHash: cycle.promptHash,
      providerMetadata: metadata, outputAssetKind: "s3_refinement_asset", assessmentId,
    };
    const asset: S3GeneratedAsset = { assetId, projectId: operation.projectId, revisionId, generationSetId: operation.generationSetId, mediaProfile: "s2-media-v1", providerOutputSha256: media.sha256, providerOutputBytes: media.byteSize, width: 1536, height: 1024, pixelCount: 1_572_864, detectedMime: "image/png", normalizedSha256: media.sha256, normalizedBytes: media.byteSize, hasAlpha: media.hasAlpha, storageKeyNormalized: finalKey, createdAt: this.clock() };
    const assessmentContext: S3AssessmentCompilerContext = { projectId: operation.projectId, generationSetId: operation.generationSetId, revisionId, sourceSnapshotId: source.sourceSnapshotId, outputAssetId: assetId, outputSha256: media.sha256, outputByteSize: media.byteSize, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, s2InputVersionId: source.s2InputVersionId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: source.geometrySnapshot, geometryHash: source.geometryHash, canonicalRequirements: source.canonicalRequirements, requirementHash: source.requirementHash, designRuleSnapshot: source.designRuleSnapshot, designRuleSnapshotHash: source.designRuleSnapshotHash, sourceBindingHash: source.sourceBindingHash, intentHash: cycle.refinementIntentHash, refinementInputHash: cycle.refinementInputHash };
    const assessmentCompilation = compileS3Assessment(assessmentContext);
    const attempt: S3AssessmentAttempt = { assessmentAttemptId, assessmentId, projectId: operation.projectId, revisionId, outputAssetId: assetId, outputSha256: media.sha256, outputByteSize: media.byteSize, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, attempt: 1, retryOfAttemptId: null, operationInputHash: operation.operationInputHash, assessmentInputHash: assessmentCompilation.assessmentInputHash, assessmentPromptHash: assessmentCompilation.assessmentPromptHash, assessmentCompilerVersion: "s3-assessment-v1", assessmentSchema: "s3-assessment-v1", assessmentSchemaName: "s3_assessment_v1", requestReferenceId: operation.requestReferenceId, status: "queued", disposition: "pending", claimedBy: null, claimedProcessId: null, claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", requirementObservations: [], designObservations: [], materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [], failureCode: null, providerMetadata: null, createdAt: this.clock() };
    const assessment: S3Assessment = { assessmentId, projectId: operation.projectId, generationSetId: operation.generationSetId, sourceSnapshotId: source.sourceSnapshotId, revisionId, outputAssetId: assetId, outputSha256: media.sha256, outputByteSize: media.byteSize, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, sourceS2QaResultId: source.canonicalSourceBinding.s2SourceQaResultId, sourceS2ReQaResultId: source.canonicalSourceBinding.s2ReQaResultId, s2InputVersionId: source.s2InputVersionId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: cloneJson(source.geometrySnapshot), geometryHash: source.geometryHash, canonicalRequirements: cloneJson(source.canonicalRequirements), requirementHash: source.requirementHash, designRulesVersion: "s2-design-rules-v1", designRuleSnapshot: cloneJson(source.designRuleSnapshot), designRuleSnapshotHash: source.designRuleSnapshotHash, sourceBindingHash: source.sourceBindingHash, refinementInputHash: cycle.refinementInputHash, refinementIntentHash: cycle.refinementIntentHash, assessmentCompilerVersion: "s3-assessment-v1", assessmentSchema: "s3-assessment-v1", assessmentSchemaName: "s3_assessment_v1", assessmentInputHash: assessmentCompilation.assessmentInputHash, assessmentPromptHash: assessmentCompilation.assessmentPromptHash, attemptIds: [assessmentAttemptId], latestAttemptId: assessmentAttemptId, status: "pending", retryState: "none", retryWaivedReason: null, createdAt: this.clock(), updatedAt: this.clock() };
    const publication: S3Publication = { publicationId, projectId: operation.projectId, cycleId: cycle.cycleId, operationId: operation.operationId, inputHash: operation.operationInputHash, providerOutputSha256: media.sha256, providerOutputBytes: media.byteSize, normalizedSha256: media.sha256, normalizedBytes: media.byteSize, width: 1536, height: 1024, pixelCount: 1_572_864, hasAlpha: media.hasAlpha, intendedAssetId: assetId, intendedRevisionId: revisionId, intendedAssessmentId: assessmentId, intendedAssessmentAttemptId: assessmentAttemptId, stagingObjects: [this.publicationObject(stagingKey, media)], finalObjects: [this.publicationObject(finalKey, media)], ownerProcessId: this.processId, ownerClaimToken: claim.token, ownerClaimedAt: this.clock(), state: "staged", createdAt: this.clock(), updatedAt: this.clock() };
    return { publication, asset, revision, assessment, attempt };
  }

  private insertPublicationIntent(bundle: ReturnType<S3WorkflowService["createPublicationBundle"]>, claim: ImageClaim): void {
    this.repository.transact((state) => {
      const operation = state.s3ImageOperations.find((item) => item.operationId === claim.operation.operationId);
      const cycle = operation ? state.s3Cycles.find((item) => item.cycleId === operation.cycleId) : undefined;
      const selection = cycle ? state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId) : undefined;
      if (!operation || !cycle || !selection || !this.imageClaimMatches(operation, claim.token) || cycle.status !== "image_running" || cycle.generationSetId !== operation.generationSetId || selection.projectId !== operation.projectId || selection.generationSetId !== operation.generationSetId || selection.lineageRootRevisionId !== cycle.lineageRootRevisionId || selection.selectionVersion !== operation.baseSelectionVersion || selection.activeRevisionId !== operation.baseRevisionId) throw fail(409, "S3_FENCE_STALE");
      operation.providerMetadata = cloneJson(bundle.revision.providerMetadata);
      operation.publicationId = bundle.publication.publicationId; operation.outputRevisionId = bundle.revision.revisionId; operation.outputAssetId = bundle.asset.assetId;
      state.s3Publications.push(cloneJson(bundle.publication));
      const previous = cycle.status; cycle.status = "publication_pending"; cycle.updatedAt = this.clock();
      this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId: operation.operationId, publicationId: bundle.publication.publicationId, phase: "cycle", attempt: operation.attempt, from: previous, to: "publication_pending", requestReferenceId: operation.requestReferenceId });
      this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId: operation.operationId, publicationId: bundle.publication.publicationId, phase: "publication", attempt: operation.attempt, from: null, to: "staged", requestReferenceId: operation.requestReferenceId });
    });
  }

  private verifyObject(object: S3PublicationObject): Buffer {
    try { const bytes = this.objects.read(object.key); if (bytes.byteLength !== object.byteSize || sha256(bytes) !== object.sha256) throw new Error("object mismatch"); return bytes; } catch { throw fail(500, "S3_INTERNAL_ERROR"); }
  }

  private markPublication(publicationId: UUID, stateValue: "promoted" | "committed" | "aborted"): void {
    this.repository.transact((state) => { const publication = state.s3Publications.find((item) => item.publicationId === publicationId); if (publication && publication.state !== "committed" && publication.state !== "aborted") { publication.state = stateValue; publication.updatedAt = this.clock(); } });
  }

  private commitPublicationInState(state: StoreState, publication: S3Publication, requestReferenceId: UUID): UUID | null {
    const operation = state.s3ImageOperations.find((item) => item.operationId === publication.operationId);
    const cycle = state.s3Cycles.find((item) => item.cycleId === publication.cycleId);
    if (!operation || !cycle) throw fail(500, "S3_INTERNAL_ERROR");
    // The intended revision is deliberately absent during the recovery
    // transaction. Bind the reconstruction through the immutable cycle base
    // revision instead of attempting a mutable project/source lookup.
    const baseRevision = state.s3Revisions.find((item) => item.revisionId === cycle.baseRevisionId);
    const source = state.s3Sources.find((item) => item.sourceSnapshotId === baseRevision?.sourceSnapshotId);
    if (!source) throw fail(500, "S3_INTERNAL_ERROR");
    const existingRevision = state.s3Revisions.find((item) => item.revisionId === publication.intendedRevisionId);
    if (!existingRevision) {
      if (!baseRevision) throw fail(500, "S3_INTERNAL_ERROR");
      const metadata = operation.providerMetadata; if (!metadata) throw fail(500, "S3_INTERNAL_ERROR");
      const revision: S3RefinementRevision = { revisionId: publication.intendedRevisionId, projectId: publication.projectId, generationSetId: operation.generationSetId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: cloneJson(source.geometrySnapshot), geometryHash: source.geometryHash, s2InputVersionId: source.s2InputVersionId, s2InputBindingHash: source.s2InputBindingHash, sourceSnapshotId: source.sourceSnapshotId, sourceBindingHash: source.sourceBindingHash, ultimateS1CandidateId: source.canonicalSourceBinding.ultimateS1CandidateId, sourceS2QaResultId: source.canonicalSourceBinding.s2SourceQaResultId, sourceS2RepairAttemptId: source.canonicalSourceBinding.s2RepairAttemptId, sourceS2ReQaResultId: source.canonicalSourceBinding.s2ReQaResultId, sourceS2DerivedCandidateId: source.canonicalSourceBinding.s2DerivedCandidateId, outputAssetId: publication.intendedAssetId, outputSha256: publication.normalizedSha256, outputByteSize: publication.normalizedBytes, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, createdAt: this.clock(), kind: "refinement", lineageRootRevisionId: cycle.lineageRootRevisionId, parentRevisionId: cycle.baseRevisionId, refinementCycleNumber: cycle.cycleNumber, refinementIntentText: cycle.refinementIntentText, refinementIntentHash: cycle.refinementIntentHash, refinementInputHash: cycle.refinementInputHash, compilerVersion: "s3-refinement-v1", promptHash: cycle.promptHash, providerMetadata: cloneJson(metadata), outputAssetKind: "s3_refinement_asset", assessmentId: publication.intendedAssessmentId };
      const asset: S3GeneratedAsset = { assetId: publication.intendedAssetId, projectId: publication.projectId, revisionId: revision.revisionId, generationSetId: operation.generationSetId, mediaProfile: "s2-media-v1", providerOutputSha256: publication.providerOutputSha256, providerOutputBytes: publication.providerOutputBytes, normalizedSha256: publication.normalizedSha256, normalizedBytes: publication.normalizedBytes, width: 1536, height: 1024, pixelCount: 1_572_864, detectedMime: "image/png", hasAlpha: publication.hasAlpha, storageKeyNormalized: publication.finalObjects[0].key, createdAt: this.clock() };
      const assessmentContext: S3AssessmentCompilerContext = { projectId: publication.projectId, generationSetId: operation.generationSetId, revisionId: revision.revisionId, sourceSnapshotId: source.sourceSnapshotId, outputAssetId: asset.assetId, outputSha256: asset.normalizedSha256, outputByteSize: asset.normalizedBytes, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, s2InputVersionId: source.s2InputVersionId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: source.geometrySnapshot, geometryHash: source.geometryHash, canonicalRequirements: source.canonicalRequirements, requirementHash: source.requirementHash, designRuleSnapshot: source.designRuleSnapshot, designRuleSnapshotHash: source.designRuleSnapshotHash, sourceBindingHash: source.sourceBindingHash, intentHash: cycle.refinementIntentHash, refinementInputHash: cycle.refinementInputHash };
      const compiled = compileS3Assessment(assessmentContext);
      const attempt: S3AssessmentAttempt = { assessmentAttemptId: publication.intendedAssessmentAttemptId, assessmentId: publication.intendedAssessmentId, projectId: publication.projectId, revisionId: revision.revisionId, outputAssetId: asset.assetId, outputSha256: asset.normalizedSha256, outputByteSize: asset.normalizedBytes, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, attempt: 1, retryOfAttemptId: null, operationInputHash: operation.operationInputHash, assessmentInputHash: compiled.assessmentInputHash, assessmentPromptHash: compiled.assessmentPromptHash, assessmentCompilerVersion: "s3-assessment-v1", assessmentSchema: "s3-assessment-v1", assessmentSchemaName: "s3_assessment_v1", requestReferenceId: operation.requestReferenceId, status: "queued", disposition: "pending", claimedBy: null, claimedProcessId: null, claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", requirementObservations: [], designObservations: [], materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [], failureCode: null, providerMetadata: null, createdAt: this.clock() };
      const assessment: S3Assessment = { assessmentId: publication.intendedAssessmentId, projectId: publication.projectId, generationSetId: operation.generationSetId, sourceSnapshotId: source.sourceSnapshotId, revisionId: revision.revisionId, outputAssetId: asset.assetId, outputSha256: asset.normalizedSha256, outputByteSize: asset.normalizedBytes, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, sourceS2QaResultId: source.canonicalSourceBinding.s2SourceQaResultId, sourceS2ReQaResultId: source.canonicalSourceBinding.s2ReQaResultId, s2InputVersionId: source.s2InputVersionId, confirmedBriefVersionId: source.confirmedBriefVersionId, confirmedBriefContentHash: source.confirmedBriefContentHash, geometrySnapshot: cloneJson(source.geometrySnapshot), geometryHash: source.geometryHash, canonicalRequirements: cloneJson(source.canonicalRequirements), requirementHash: source.requirementHash, designRulesVersion: "s2-design-rules-v1", designRuleSnapshot: cloneJson(source.designRuleSnapshot), designRuleSnapshotHash: source.designRuleSnapshotHash, sourceBindingHash: source.sourceBindingHash, refinementInputHash: cycle.refinementInputHash, refinementIntentHash: cycle.refinementIntentHash, assessmentCompilerVersion: "s3-assessment-v1", assessmentSchema: "s3-assessment-v1", assessmentSchemaName: "s3_assessment_v1", assessmentInputHash: compiled.assessmentInputHash, assessmentPromptHash: compiled.assessmentPromptHash, attemptIds: [attempt.assessmentAttemptId], latestAttemptId: attempt.assessmentAttemptId, status: "pending", retryState: "none", retryWaivedReason: null, createdAt: this.clock(), updatedAt: this.clock() };
      state.s3Assets.push(asset); state.s3Revisions.push(revision); state.s3Assessments.push(assessment); state.s3AssessmentAttempts.push(attempt);
    }
    const storedCycle = state.s3Cycles.find((item) => item.cycleId === publication.cycleId)!; const storedPublication = state.s3Publications.find((item) => item.publicationId === publication.publicationId)!; const storedOperation = state.s3ImageOperations.find((item) => item.operationId === publication.operationId)!;
    storedCycle.outputRevisionId = publication.intendedRevisionId; storedCycle.assessmentId = publication.intendedAssessmentId; storedCycle.assessmentAttemptIds = [publication.intendedAssessmentAttemptId]; storedCycle.status = "assessment_pending"; storedCycle.retryState = "none"; storedCycle.updatedAt = this.clock(); storedPublication.state = "committed"; storedPublication.updatedAt = this.clock(); storedOperation.status = "succeeded"; storedOperation.providerDispatchState = "consumed"; storedOperation.completedAt = this.clock(); this.clearClaim(storedOperation);
    this.transition(state, publication.projectId, { cycleId: storedCycle.cycleId, operationId: publication.operationId, publicationId: publication.publicationId, phase: "publication", attempt: storedOperation.attempt, from: "promoted", to: "committed", requestReferenceId });
    this.transition(state, publication.projectId, { cycleId: storedCycle.cycleId, operationId: publication.operationId, assessmentId: publication.intendedAssessmentId, assessmentAttemptId: publication.intendedAssessmentAttemptId, publicationId: publication.publicationId, phase: "cycle", attempt: storedOperation.attempt, from: "publication_pending", to: "assessment_pending", requestReferenceId });
    return publication.intendedAssessmentAttemptId;
  }

  private async runImage(operationId: UUID): Promise<void> {
    const claim = this.claimImage(operationId); if (!claim) return;
    let publication: S3Publication | null = null;
    try {
      const initial = this.state(); const dispatch = this.imageDispatchInput(initial, claim.operation);
      if (!this.provider.runS3ImageEdit) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      await this.notifyDispatch("before-dispatch", claim.operation);
      const marked = this.beginImageDispatch(operationId, claim.token); if (!marked) return;
      await this.notifyDispatch("after-dispatch-marked", marked);
      const response = await this.provider.runS3ImageEdit(dispatch.input);
      if (!(response.pngBytes instanceof Uint8Array) || response.pngBytes.byteLength === 0) throw new ProviderFailure("IMAGE_MALFORMED");
      const media = await inspectExactS3Png(response.pngBytes);
      await s3PixelsChanged(dispatch.input.sourceBytes, media.bytes);
      const current = this.state(); const bundle = this.createPublicationBundle(current, claim, media, this.imageMetadata(response)); publication = bundle.publication;
      await this.notifyPublication("before-publication-intent", publication); this.insertPublicationIntent(bundle, claim); await this.notifyPublication("after-publication-intent", publication);
      this.objects.put(publication.stagingObjects[0].key, media.bytes); this.verifyObject(publication.stagingObjects[0]); await this.notifyPublication("after-publication-staged", publication);
      this.objects.promote(publication.stagingObjects[0].key, publication.finalObjects[0].key); this.verifyObject(publication.finalObjects[0]); this.markPublication(publication.publicationId, "promoted"); await this.notifyPublication("after-final-promotion", publication);
      const assessmentAttemptId = this.repository.transact((state) => { const stored = state.s3Publications.find((item) => item.publicationId === publication!.publicationId); if (!stored || stored.state !== "promoted") throw fail(500, "S3_INTERNAL_ERROR"); const operation = state.s3ImageOperations.find((item) => item.operationId === operationId); if (!operation || !this.imageClaimMatches(operation, claim.token)) throw fail(409, "S3_FENCE_STALE"); return this.commitPublicationInState(state, stored, operation.requestReferenceId); });
      this.objects.remove(publication.stagingObjects[0].key); if (assessmentAttemptId) this.startAssessmentAttempt(assessmentAttemptId);
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      const publicationIsDurable = publication
        ? this.state().s3Publications.some((item) => item.publicationId === publication!.publicationId)
        : false;
      if (publication && publicationIsDurable) {
        try { this.repository.transact((state) => { const stored = state.s3Publications.find((item) => item.publicationId === publication!.publicationId); if (stored && stored.state !== "committed") { const previousPublicationState = stored.state; stored.state = "aborted"; stored.updatedAt = this.clock(); const cycle = state.s3Cycles.find((item) => item.cycleId === stored.cycleId); const op = state.s3ImageOperations.find((item) => item.operationId === stored.operationId); if (cycle) { const priorCycle = cycle.status; cycle.status = "publication_failed"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock(); this.transition(state, stored.projectId, { cycleId: stored.cycleId, operationId: stored.operationId, publicationId: stored.publicationId, phase: "cycle", attempt: op?.attempt ?? null, from: priorCycle, to: "publication_failed", requestReferenceId: op?.requestReferenceId ?? this.uuid() }); } if (op) { op.status = "failed"; op.providerDispatchState = "consumed"; op.failureCode = "PUBLICATION_FAILED"; op.completedAt = this.clock(); this.clearClaim(op); } this.transition(state, stored.projectId, { cycleId: stored.cycleId, operationId: stored.operationId, publicationId: stored.publicationId, phase: "publication", attempt: op?.attempt ?? null, from: previousPublicationState, to: "aborted", requestReferenceId: op?.requestReferenceId ?? this.uuid() }); } }); } catch { /* preserve the last durable state */ }
        this.objects.remove(publication.stagingObjects[0].key);
      } else this.failImage(operationId, claim.token, error);
    }
  }

  private failImage(operationId: UUID, token: UUID, error: unknown): void {
    try { this.repository.transact((state) => { const operation = state.s3ImageOperations.find((item) => item.operationId === operationId); const cycle = operation ? state.s3Cycles.find((item) => item.cycleId === operation.cycleId) : undefined; if (!operation || !cycle || !this.imageClaimMatches(operation, token)) return; const code = failureCode(error); const retryable = operation.attempt === 1 && S3_IMAGE_RETRYABLE.has(code); const prior = cycle.status; operation.status = "failed"; operation.providerDispatchState = operation.providerDispatchState === "not_started" ? "not_started" : "consumed"; operation.failureCode = code; operation.completedAt = this.clock(); this.clearClaim(operation); cycle.status = retryable ? "image_retry_available" : "image_failed"; cycle.retryState = retryable ? "image_available" : "none"; cycle.retryWaivedReason = null; cycle.terminalAt = retryable ? null : this.clock(); cycle.updatedAt = this.clock(); this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId, phase: "cycle", attempt: operation.attempt, from: prior, to: cycle.status, requestReferenceId: operation.requestReferenceId }); this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId, phase: "image", attempt: operation.attempt, from: "running", to: "failed", requestReferenceId: operation.requestReferenceId }); }); } catch { /* conservative recovery leaves the operation non-successful */ }
  }

  private startImageOperation(cycleId: UUID): void {
    const operation = this.state().s3ImageOperations.find((item) => item.cycleId === cycleId && item.status === "queued"); if (!operation) return;
    const key = "s3-image:" + operation.operationId; if (this.inFlight.has(key)) return; this.inFlight.add(key);
    void this.runImage(operation.operationId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  imageRetry(projectId: UUID, cycleId: UUID, key: UUID, referenceId: UUID): PublicS3Mutation<PublicS3RetryAdmission> {
    assertUuid(cycleId, "cycleId");
    const requestHash = operationHash("s3_image_retry_request", projectId, { cycleId, attemptNumber: 2 });
    const result = this.repository.transact((state) => {
      const cycle = state.s3Cycles.find((item) => item.cycleId === cycleId && item.projectId === projectId);
      if (!cycle) throw fail(404, "S3_CYCLE_NOT_FOUND");
      const replay = this.idempotency(state, key, "s3_image_retry", projectId, requestHash);
      if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS3RetryAdmission };
      if (cycle.retryState === "waived" || cycle.status === "waived") throw fail(409, "S3_RETRY_WAIVED");
      const selection = state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId);
      const operation = state.s3ImageOperations.find((item) => item.operationId === cycle.imageOperationIds[0]);
      if (!selection || !operation || cycle.status !== "image_retry_available" || cycle.retryState !== "image_available" || operation.status !== "failed" || !S3_IMAGE_RETRYABLE.has(operation.failureCode ?? "") || selection.selectionVersion !== cycle.baseSelectionVersion || selection.activeRevisionId !== cycle.baseRevisionId) throw fail(409, "S3_IMAGE_RETRY_NOT_AVAILABLE");
      if (cycle.imageOperationIds.length !== 1 || state.s3Cycles.some((item) => item.selectionStateId === selection.selectionStateId && item.cycleNumber > cycle.cycleNumber)) throw fail(409, "S3_DUPLICATE_IMAGE_RETRY");
      const source = this.revisionSource(state, state.s3Revisions.find((item) => item.revisionId === cycle.baseRevisionId)!);
      const retryOperationId = this.uuid();
      const retryHash = canonicalOperationHash({ schemaVersion: "s3-image-retry-operation-v1", projectId, generationSetId: cycle.generationSetId, selectionStateId: selection.selectionStateId, sourceSnapshotId: source.sourceSnapshotId, cycleId, cycleNumber: cycle.cycleNumber, baseRevisionId: cycle.baseRevisionId, baseSelectionVersion: cycle.baseSelectionVersion, intentHash: cycle.refinementIntentHash, refinementInputHash: cycle.refinementInputHash, attemptNumber: 2 });
      const retry: S3ImageOperation = { ...cloneJson(operation), operationId: retryOperationId, attempt: 2, retryOfOperationId: operation.operationId, operationInputHash: retryHash, requestReferenceId: referenceId, status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", providerMetadata: null, failureCode: null, publicationId: null, outputRevisionId: null, outputAssetId: null, createdAt: this.clock() };
      state.s3ImageOperations.push(retry); cycle.imageOperationIds = [operation.operationId, retryOperationId]; cycle.retryState = "none"; cycle.retryWaivedReason = null; cycle.status = "image_queued"; cycle.terminalAt = null; cycle.updatedAt = this.clock();
      this.transition(state, projectId, { cycleId, operationId: retryOperationId, phase: "cycle", attempt: 2, from: "image_retry_available", to: "image_queued", requestReferenceId: referenceId }); this.transition(state, projectId, { cycleId, operationId: retryOperationId, phase: "image", attempt: 2, from: null, to: "queued", requestReferenceId: referenceId });
      const response: PublicS3RetryAdmission = { cycleId, status: "generating", imageRetryAvailable: false, assessmentRetryAvailable: false }; this.remember(state, key, "s3_image_retry", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
    });
    if (!result.replayed) this.startImageOperation(cycleId);
    return result;
  }

  private assessmentDispatchInput(state: StoreState, attempt: S3AssessmentAttempt): { input: S3AssessmentProviderInput; compiled: ReturnType<typeof compileS3Assessment>; assessment: S3Assessment; revision: S3RefinementRevision; source: S3SourceSnapshot; bytes: Buffer } {
    const assessment = state.s3Assessments.find((item) => item.assessmentId === attempt.assessmentId);
    const revision = state.s3Revisions.find((item) => item.revisionId === attempt.revisionId);
    if (!assessment || !revision || revision.kind !== "refinement" || assessment.revisionId !== revision.revisionId || assessment.outputAssetId !== attempt.outputAssetId) throw fail(409, "QA_INPUT_INTEGRITY_MISMATCH");
    const source = this.revisionSource(state, revision); const bytes = this.readRevisionBytes(state, revision, source);
    const compiled = compileS3Assessment({ projectId: assessment.projectId, generationSetId: assessment.generationSetId, revisionId: revision.revisionId, sourceSnapshotId: source.sourceSnapshotId, outputAssetId: assessment.outputAssetId, outputSha256: assessment.outputSha256, outputByteSize: assessment.outputByteSize, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864, s2InputVersionId: assessment.s2InputVersionId, confirmedBriefVersionId: assessment.confirmedBriefVersionId, confirmedBriefContentHash: assessment.confirmedBriefContentHash, geometrySnapshot: assessment.geometrySnapshot, geometryHash: assessment.geometryHash, canonicalRequirements: assessment.canonicalRequirements, requirementHash: assessment.requirementHash, designRuleSnapshot: assessment.designRuleSnapshot, designRuleSnapshotHash: assessment.designRuleSnapshotHash, sourceBindingHash: assessment.sourceBindingHash, intentHash: assessment.refinementIntentHash, refinementInputHash: assessment.refinementInputHash });
    if (compiled.assessmentInputHash !== assessment.assessmentInputHash || compiled.assessmentPromptHash !== assessment.assessmentPromptHash || compiled.assessmentInputHash !== attempt.assessmentInputHash || compiled.assessmentPromptHash !== attempt.assessmentPromptHash || bytes.byteLength !== attempt.outputByteSize || sha256(bytes) !== attempt.outputSha256) throw fail(409, "QA_INPUT_INTEGRITY_MISMATCH");
    return { input: { promptText: compiled.promptText, outputBytes: bytes, requirements: assessment.canonicalRequirements, designRules: assessment.designRuleSnapshot }, compiled, assessment, revision, source, bytes };
  }

  private claimAssessment(assessmentAttemptId: UUID): AssessmentClaim | null {
    return this.repository.transact((state) => {
      const attempt = state.s3AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
      const assessment = attempt ? state.s3Assessments.find((item) => item.assessmentId === attempt.assessmentId) : undefined;
      const cycle = assessment ? state.s3Cycles.find((item) => item.assessmentId === assessment.assessmentId) : undefined;
      if (!attempt || !assessment || !cycle || attempt.status !== "queued" || assessment.status !== "pending" || cycle.status !== "assessment_pending") return null;
      const token = this.uuid(); attempt.status = "running"; attempt.disposition = "running"; attempt.claimedBy = this.workerId; attempt.claimedProcessId = this.processId; attempt.claimToken = token; attempt.claimedAt = this.clock(); attempt.startedAt = this.clock(); assessment.status = "running"; assessment.updatedAt = this.clock(); const previous = cycle.status; cycle.status = "assessment_running"; cycle.updatedAt = this.clock();
      this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: previous, to: "assessment_running", requestReferenceId: attempt.requestReferenceId }); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: "pending", to: "running", requestReferenceId: attempt.requestReferenceId });
      return { attempt: cloneJson(attempt), token };
    });
  }

  private assessmentFenceCurrent(state: StoreState, assessment: S3Assessment, revision: S3RefinementRevision): boolean {
    const cycle = state.s3Cycles.find((item) => item.assessmentId === assessment.assessmentId); const selection = cycle ? state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId) : undefined;
    return Boolean(cycle && selection && selection.projectId === assessment.projectId && selection.selectionVersion === cycle.baseSelectionVersion && selection.activeRevisionId === cycle.baseRevisionId && selection.lineageRootRevisionId === cycle.lineageRootRevisionId && revision.parentRevisionId === cycle.baseRevisionId && revision.sourceSnapshotId === assessment.sourceSnapshotId);
  }

  private beginAssessmentDispatch(assessmentAttemptId: UUID, token: UUID): S3AssessmentAttempt | null {
    return this.repository.transact((state) => {
      const attempt = state.s3AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId); if (!attempt || !this.assessmentClaimMatches(attempt, token) || attempt.providerDispatchState !== "not_started") return null;
      const dispatch = this.assessmentDispatchInput(state, attempt); if (!this.assessmentFenceCurrent(state, dispatch.assessment, dispatch.revision)) throw fail(409, "S3_FENCE_STALE");
      attempt.providerDispatchState = "may_have_started"; return cloneJson(attempt);
    });
  }

  private validateAssessmentPayload(payload: unknown, assessment: S3Assessment): AssessmentReduction {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ProviderFailure("QA_SCHEMA_INVALID");
    const value = payload as Record<string, unknown>; const topKeys = Object.keys(value); if (topKeys.length !== 2 || !topKeys.includes("requirements") || !topKeys.includes("designRules") || !Array.isArray(value.requirements) || !Array.isArray(value.designRules)) throw new ProviderFailure("QA_SCHEMA_INVALID");
    const expectedRequirements = new Map(assessment.canonicalRequirements.map((item) => [item.requirementId, item])); const expectedRules = new Map(assessment.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => [item.ruleId, item]));
    const requirementIds = new Set<string>(); const requirements = [] as S3AssessmentAttempt["requirementObservations"];
    for (const raw of value.requirements) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProviderFailure("QA_SCHEMA_INVALID"); const item = raw as Record<string, unknown>; const keys = Object.keys(item); const expectedKeys = ["requirementId", "expected", "expectedCount", "observed", "observedCount", "confidence", "evidence"];
      if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) throw new ProviderFailure("QA_SCHEMA_INVALID");
      if (typeof item.requirementId !== "string" || item.requirementId.length < 1 || item.requirementId.length > 128 || requirementIds.has(item.requirementId)) throw new ProviderFailure("QA_SCHEMA_INVALID"); requirementIds.add(item.requirementId);
      const expected = expectedRequirements.get(item.requirementId); if (!expected) throw new ProviderFailure("QA_SCHEMA_INVALID");
      if (item.expected !== expected.expected || item.expectedCount !== expected.expectedCount || !["present", "absent", "exact_count"].includes(String(item.expected))) throw new ProviderFailure("QA_SCHEMA_INVALID");
      if (!(["present", "absent", "uncertain", "not_verifiable"] as string[]).includes(String(item.observed)) || (item.observedCount !== null && (!Number.isSafeInteger(item.observedCount) || (item.observedCount as number) < 0)) || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || typeof item.evidence !== "string" || codePointLength(item.evidence) > 400) throw new ProviderFailure("QA_SCHEMA_INVALID");
      const judgedExact = expected.expected === "exact_count" &&
        (item.observed === "present" || item.observed === "absent") &&
        item.confidence >= S2_CONFIDENCE_THRESHOLD;
      if ((expected.expected === "exact_count" && judgedExact && item.observedCount === null) ||
          (expected.expected !== "exact_count" && item.observedCount !== null)) throw new ProviderFailure("QA_SCHEMA_INVALID");
      requirements.push({ requirementId: expected.requirementId, expected: expected.expected, expectedCount: expected.expectedCount, expectedValue: expected.expectedValue, observed: item.observed as S3AssessmentAttempt["requirementObservations"][number]["observed"], observedCount: item.observedCount as number | null, confidence: item.confidence, evidence: item.evidence });
    }
    if (requirements.length !== expectedRequirements.size) throw new ProviderFailure("QA_RESULT_INCOMPLETE");
    const ruleIds = new Set<string>(); const designRules = [] as S3AssessmentAttempt["designObservations"];
    for (const raw of value.designRules) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProviderFailure("QA_SCHEMA_INVALID"); const item = raw as Record<string, unknown>; const keys = Object.keys(item); const expectedKeys = ["ruleId", "observed", "confidence", "evidence"];
      if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) throw new ProviderFailure("QA_SCHEMA_INVALID");
      if (typeof item.ruleId !== "string" || item.ruleId.length < 1 || item.ruleId.length > 128 || ruleIds.has(item.ruleId)) throw new ProviderFailure("QA_SCHEMA_INVALID"); ruleIds.add(item.ruleId);
      const expected = expectedRules.get(item.ruleId); if (!expected || !(["compliant", "non_compliant", "uncertain", "not_verifiable"] as string[]).includes(String(item.observed)) || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || typeof item.evidence !== "string" || codePointLength(item.evidence) > 400) throw new ProviderFailure("QA_SCHEMA_INVALID");
      designRules.push({ ruleId: expected.ruleId, observed: item.observed as S3AssessmentAttempt["designObservations"][number]["observed"], confidence: item.confidence, evidence: item.evidence });
    }
    if (designRules.length !== expectedRules.size) throw new ProviderFailure("QA_RESULT_INCOMPLETE");
    let reduced: ReturnType<typeof reduceS2Findings>;
    try { reduced = reduceS2Findings({ canonicalRequirements: assessment.canonicalRequirements, designRuleSnapshot: assessment.designRuleSnapshot } as S2InputVersion, requirements, designRules); } catch { throw new ProviderFailure("QA_RESULT_INCOMPLETE"); }
    return { status: reduced.verdict === "PASS" ? "pass" : reduced.verdict === "WARNING" ? "warning" : "material_fail", requirements, designRules, material: reduced.materialFindingIds, warning: reduced.warningFindingIds, uncertain: reduced.uncertainFindingIds };
  }

  private completeAssessment(assessmentAttemptId: UUID, token: UUID, result: AssessmentReduction, metadata: S3AssessmentProviderMetadata): void {
    this.repository.transact((state) => {
      const attempt = state.s3AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId); const assessment = attempt ? state.s3Assessments.find((item) => item.assessmentId === attempt.assessmentId) : undefined; const cycle = assessment ? state.s3Cycles.find((item) => item.assessmentId === assessment.assessmentId) : undefined; const revision = assessment ? state.s3Revisions.find((item) => item.revisionId === assessment.revisionId) : undefined;
      if (!attempt || !assessment || !cycle || !revision || revision.kind !== "refinement" || !this.assessmentClaimMatches(attempt, token)) return;
      const status = result.status === "pass" ? "pass" : result.status === "warning" ? "warning" : "material_fail"; const publicStatus = status === "pass" || status === "warning" ? status : "material_fail";
      attempt.status = "succeeded"; attempt.disposition = status; attempt.providerDispatchState = "consumed"; attempt.requirementObservations = cloneJson(result.requirements); attempt.designObservations = cloneJson(result.designRules); attempt.materialFindingIds = result.material; attempt.warningFindingIds = result.warning; attempt.uncertainFindingIds = result.uncertain; attempt.providerMetadata = cloneJson(metadata); attempt.completedAt = this.clock(); this.clearClaim(attempt); assessment.status = publicStatus; assessment.retryState = "none"; assessment.retryWaivedReason = null; assessment.latestAttemptId = attempt.assessmentAttemptId; assessment.updatedAt = this.clock();
      const current = this.assessmentFenceCurrent(state, assessment, revision); const priorCycle = cycle.status;
      if (status === "pass" || status === "warning") {
        if (current) {
          const selection = state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId); if (!selection || selection.successfulRefinementCount >= 2) { cycle.status = "stale"; cycle.terminalAt = this.clock(); } else { const resultingCount = (selection.successfulRefinementCount + 1) as 1 | 2; const expectedVersion = selection.selectionVersion; selection.activeRevisionId = revision.revisionId; selection.selectionVersion += 1; selection.successfulRefinementCount = resultingCount; selection.updatedAt = this.clock(); cycle.status = "completed"; cycle.terminalAt = this.clock(); cycle.retryState = "none"; state.s3SelectionEvents.push({ eventId: this.uuid(), projectId: assessment.projectId, selectionStateId: selection.selectionStateId, kind: "activate_refinement", fromRevisionId: cycle.baseRevisionId, toRevisionId: revision.revisionId, sourceSnapshotId: assessment.sourceSnapshotId, cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, expectedSelectionVersion: expectedVersion, resultingSelectionVersion: selection.selectionVersion, resultingSuccessfulRefinementCount: resultingCount, idempotencyKey: null, requestReferenceId: attempt.requestReferenceId, at: this.clock() }); this.transition(state, assessment.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "selection", attempt: attempt.attempt, from: "assessment_running", to: "activate_refinement", requestReferenceId: attempt.requestReferenceId }); } }
        else { cycle.status = "stale"; cycle.terminalAt = this.clock(); }
      } else { cycle.status = "material_fail"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); }
      cycle.updatedAt = this.clock();
      this.transition(state, assessment.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: "running", to: status, requestReferenceId: attempt.requestReferenceId }); this.transition(state, assessment.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: priorCycle, to: cycle.status, requestReferenceId: attempt.requestReferenceId });
    });
  }

  private failAssessment(assessmentAttemptId: UUID, token: UUID, error: unknown): void {
    try { this.repository.transact((state) => { const attempt = state.s3AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId); const assessment = attempt ? state.s3Assessments.find((item) => item.assessmentId === attempt.assessmentId) : undefined; const cycle = assessment ? state.s3Cycles.find((item) => item.assessmentId === assessment.assessmentId) : undefined; if (!attempt || !assessment || !cycle || !this.assessmentClaimMatches(attempt, token)) return; const code = failureCode(error); const stale = code === "S3_FENCE_STALE"; const retryable = attempt.attempt === 1 && !stale && S3_ASSESSMENT_RETRYABLE.has(code); const prior = cycle.status; attempt.status = "failed"; attempt.disposition = retryable ? "qa_unavailable_retryable" : "qa_unavailable_terminal"; attempt.providerDispatchState = attempt.providerDispatchState === "not_started" ? "not_started" : "consumed"; attempt.failureCode = code; attempt.completedAt = this.clock(); this.clearClaim(attempt); assessment.status = retryable ? "qa_unavailable_retryable" : "qa_unavailable_terminal"; assessment.retryState = retryable ? "available" : "none"; assessment.retryWaivedReason = null; assessment.updatedAt = this.clock(); cycle.status = stale ? "stale" : retryable ? "assessment_retry_available" : "qa_unavailable"; cycle.retryState = retryable ? "assessment_available" : "none"; cycle.retryWaivedReason = null; cycle.terminalAt = retryable ? null : this.clock(); cycle.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: "running", to: attempt.disposition, requestReferenceId: attempt.requestReferenceId }); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: prior, to: cycle.status, requestReferenceId: attempt.requestReferenceId }); }); } catch { /* retain conservative durable state */ }
  }

  private async runAssessment(assessmentAttemptId: UUID): Promise<void> {
    const claim = this.claimAssessment(assessmentAttemptId); if (!claim) return;
    try {
      const initial = this.state(); const dispatch = this.assessmentDispatchInput(initial, claim.attempt); if (!this.assessmentFenceCurrent(initial, dispatch.assessment, dispatch.revision)) throw new ProviderFailure("S3_FENCE_STALE");
      if (!this.provider.runS3Assessment) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
      await this.notifyDispatch("before-dispatch", claim.attempt); const marked = this.beginAssessmentDispatch(assessmentAttemptId, claim.token); if (!marked) return; await this.notifyDispatch("after-dispatch-marked", marked);
      const response = await this.provider.runS3Assessment(dispatch.input); const reduced = this.validateAssessmentPayload(response.payload, dispatch.assessment); this.completeAssessment(assessmentAttemptId, claim.token, reduced, this.assessmentMetadata(response));
    } catch (error) {
      if (error instanceof ProcessInterruption) throw error;
      this.failAssessment(assessmentAttemptId, claim.token, error);
    }
  }

  private startAssessmentAttempt(assessmentAttemptId: UUID): void {
    const key = "s3-assessment:" + assessmentAttemptId; if (this.inFlight.has(key)) return; this.inFlight.add(key);
    void this.runAssessment(assessmentAttemptId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  assessmentRetry(projectId: UUID, cycleId: UUID, key: UUID, referenceId: UUID): PublicS3Mutation<PublicS3RetryAdmission> {
    assertUuid(cycleId, "cycleId"); const requestHash = operationHash("s3_assessment_retry_request", projectId, { cycleId, attemptNumber: 2 });
    const result = this.repository.transact((state) => {
      const cycle = state.s3Cycles.find((item) => item.cycleId === cycleId && item.projectId === projectId); if (!cycle) throw fail(404, "S3_CYCLE_NOT_FOUND"); const replay = this.idempotency(state, key, "s3_assessment_retry", projectId, requestHash); if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS3RetryAdmission };
      if (cycle.retryState === "waived" || cycle.status === "waived") throw fail(409, "S3_RETRY_WAIVED");
      const assessment = cycle.assessmentId ? state.s3Assessments.find((item) => item.assessmentId === cycle.assessmentId) : undefined; const firstId = assessment?.attemptIds[0]; const first = firstId ? state.s3AssessmentAttempts.find((item) => item.assessmentAttemptId === firstId) : undefined; const selection = state.s3Selections.find((item) => item.selectionStateId === cycle.selectionStateId); const revision = assessment ? state.s3Revisions.find((item) => item.revisionId === assessment.revisionId) : undefined;
      if (!assessment || !first || !selection || !revision || revision.kind !== "refinement" || cycle.status !== "assessment_retry_available" || cycle.retryState !== "assessment_available" || assessment.status !== "qa_unavailable_retryable" || assessment.retryState !== "available" || first.status !== "failed" || selection.selectionVersion !== cycle.baseSelectionVersion || selection.activeRevisionId !== cycle.baseRevisionId) throw fail(409, "S3_ASSESSMENT_RETRY_NOT_AVAILABLE");
      if (assessment.attemptIds.length !== 1 || state.s3Cycles.some((item) => item.selectionStateId === selection.selectionStateId && item.cycleNumber > cycle.cycleNumber)) throw fail(409, "S3_DUPLICATE_ASSESSMENT_RETRY");
      const source = this.revisionSource(state, revision); const generated = state.s3Assets.find((item) => item.assetId === assessment.outputAssetId); if (!generated) throw fail(409, "S3_ASSESSMENT_RETRY_NOT_AVAILABLE");
      const retryAttemptId = this.uuid(); const retryHash = canonicalOperationHash({ schemaVersion: "s3-assessment-retry-operation-v1", projectId, generationSetId: assessment.generationSetId, selectionStateId: selection.selectionStateId, sourceSnapshotId: source.sourceSnapshotId, cycleId, revisionId: revision.revisionId, outputAssetId: assessment.outputAssetId, outputSha256: assessment.outputSha256, outputByteSize: assessment.outputByteSize, outputWidth: assessment.outputWidth, outputHeight: assessment.outputHeight, outputPixelCount: assessment.outputPixelCount, assessmentInputHash: assessment.assessmentInputHash, assessmentPromptHash: assessment.assessmentPromptHash, attemptNumber: 2 });
      const retry: S3AssessmentAttempt = { ...cloneJson(first), assessmentAttemptId: retryAttemptId, attempt: 2, retryOfAttemptId: first.assessmentAttemptId, operationInputHash: retryHash, requestReferenceId: referenceId, status: "queued", disposition: "pending", claimedBy: null, claimedProcessId: null, claimToken: null, claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started", requirementObservations: [], designObservations: [], materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [], failureCode: null, providerMetadata: null, createdAt: this.clock() };
      state.s3AssessmentAttempts.push(retry); assessment.attemptIds = [first.assessmentAttemptId, retryAttemptId]; assessment.latestAttemptId = retryAttemptId; assessment.status = "pending"; assessment.retryState = "none"; assessment.retryWaivedReason = null; assessment.updatedAt = this.clock(); cycle.assessmentAttemptIds = [first.assessmentAttemptId, retryAttemptId]; cycle.status = "assessment_pending"; cycle.retryState = "none"; cycle.retryWaivedReason = null; cycle.terminalAt = null; cycle.updatedAt = this.clock();
      this.transition(state, projectId, { cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId: retryAttemptId, phase: "cycle", attempt: 2, from: "assessment_retry_available", to: "assessment_pending", requestReferenceId: referenceId }); this.transition(state, projectId, { cycleId, assessmentId: assessment.assessmentId, assessmentAttemptId: retryAttemptId, phase: "assessment", attempt: 2, from: null, to: "queued", requestReferenceId: referenceId });
      const response: PublicS3RetryAdmission = { cycleId, status: "assessment_pending", imageRetryAvailable: false, assessmentRetryAvailable: false }; this.remember(state, key, "s3_assessment_retry", projectId, requestHash, response as unknown as Record<string, unknown>); return { replayed: false, result: response };
    });
    if (!result.replayed) { const state = this.state(); const cycle = state.s3Cycles.find((item) => item.cycleId === cycleId); const assessment = cycle?.assessmentId ? state.s3Assessments.find((item) => item.assessmentId === cycle.assessmentId) : undefined; if (assessment) this.startAssessmentAttempt(assessment.latestAttemptId); }
    return result;
  }

  private ownerDead(processId: number | null): boolean {
    if (processId === null) return true;
    try { return this.isProcessAlive(processId) === false; } catch { return false; }
  }

  private objectMatches(object: S3PublicationObject): boolean {
    try { const bytes = this.objects.read(object.key); return bytes.byteLength === object.byteSize && sha256(bytes) === object.sha256; } catch { return false; }
  }

  private abortRecoveredPublication(publicationId: UUID): void {
    try {
      this.repository.transact((state) => {
        const publication = state.s3Publications.find((item) => item.publicationId === publicationId);
        if (!publication || publication.state === "committed" || publication.state === "aborted") return;
        const previousPublicationState = publication.state;
        const cycle = state.s3Cycles.find((item) => item.cycleId === publication.cycleId);
        const operation = state.s3ImageOperations.find((item) => item.operationId === publication.operationId);
        publication.state = "aborted"; publication.updatedAt = this.clock();
        if (cycle) {
          const previousCycleStatus = cycle.status;
          cycle.status = "publication_failed"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock();
          this.transition(state, publication.projectId, { cycleId: publication.cycleId, operationId: publication.operationId, publicationId, phase: "cycle", attempt: operation?.attempt ?? null, from: previousCycleStatus, to: "publication_failed", requestReferenceId: operation?.requestReferenceId ?? this.uuid() });
        }
        if (operation) {
          const previousOperationStatus = operation.status;
          operation.status = "failed"; operation.providerDispatchState = "consumed"; operation.failureCode = "PUBLICATION_FAILED"; operation.completedAt = this.clock(); this.clearClaim(operation);
          if (previousOperationStatus !== "failed") this.transition(state, publication.projectId, { cycleId: publication.cycleId, operationId: publication.operationId, publicationId, phase: "image", attempt: operation.attempt, from: previousOperationStatus, to: "failed", requestReferenceId: operation.requestReferenceId });
        }
        this.transition(state, publication.projectId, { cycleId: publication.cycleId, operationId: publication.operationId, publicationId, phase: "publication", attempt: operation?.attempt ?? null, from: previousPublicationState, to: "aborted", requestReferenceId: operation?.requestReferenceId ?? this.uuid() });
      });
    } catch { /* uncertainty stays non-successful */ }
  }

  private recoverPublications(): void {
    for (const publication of this.state().s3Publications.filter((item) => item.state === "staged" || item.state === "promoted")) {
      if (!this.ownerDead(publication.ownerProcessId)) continue;
      try {
        const stagingReady = publication.stagingObjects.every((item) => this.objectMatches(item));
        let finalReady = publication.finalObjects.every((item) => this.objectMatches(item));
        if (!finalReady && stagingReady) {
          for (let index = 0; index < publication.stagingObjects.length; index += 1) {
            const finalObject = publication.finalObjects[index];
            if (!this.objects.exists(finalObject.key)) this.objects.promote(publication.stagingObjects[index].key, finalObject.key);
          }
          finalReady = publication.finalObjects.every((item) => this.objectMatches(item));
        }
        if (!finalReady) { this.abortRecoveredPublication(publication.publicationId); publication.stagingObjects.forEach((item) => this.objects.remove(item.key)); continue; }
        const attemptId = this.repository.transact((state) => {
          const stored = state.s3Publications.find((item) => item.publicationId === publication.publicationId);
          if (!stored || stored.state === "committed" || stored.state === "aborted") return null;
          stored.state = "promoted";
          return this.commitPublicationInState(state, stored, state.s3ImageOperations.find((item) => item.operationId === stored.operationId)?.requestReferenceId ?? this.uuid());
        });
        publication.stagingObjects.forEach((item) => this.objects.remove(item.key)); if (attemptId) this.startAssessmentAttempt(attemptId);
      } catch { /* leave durable intent for a later conservative recovery */ }
    }
  }

  private recover(): void {
    this.recoverPublications();
    const work = this.repository.transact((state) => {
      const imageIds: UUID[] = []; const assessmentIds: UUID[] = [];
      for (const operation of state.s3ImageOperations) {
        const cycle = state.s3Cycles.find((item) => item.cycleId === operation.cycleId);
        if (operation.status === "running" && this.ownerDead(operation.claimedProcessId)) {
          if (operation.providerDispatchState === "not_started") {
            operation.status = "queued"; operation.startedAt = null; operation.completedAt = null; this.clearClaim(operation);
            if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "image_queued"; cycle.updatedAt = this.clock(); this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId: operation.operationId, phase: "cycle", attempt: operation.attempt, from: previousCycleStatus, to: "image_queued", requestReferenceId: operation.requestReferenceId }); }
            this.transition(state, operation.projectId, { cycleId: operation.cycleId, operationId: operation.operationId, phase: "image", attempt: operation.attempt, from: "running", to: "queued", requestReferenceId: operation.requestReferenceId });
            imageIds.push(operation.operationId);
          } else {
            operation.status = "failed"; operation.providerDispatchState = "consumed"; operation.failureCode = "PROVIDER_DISPATCH_UNCERTAIN"; operation.completedAt = this.clock(); this.clearClaim(operation);
            if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "image_failed"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock(); this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId: operation.operationId, phase: "cycle", attempt: operation.attempt, from: previousCycleStatus, to: "image_failed", requestReferenceId: operation.requestReferenceId }); }
            this.transition(state, operation.projectId, { cycleId: operation.cycleId, operationId: operation.operationId, phase: "image", attempt: operation.attempt, from: "running", to: "failed", requestReferenceId: operation.requestReferenceId });
          }
        }
        if (operation.status === "queued" && operation.providerDispatchState === "not_started") imageIds.push(operation.operationId);
        if (operation.status === "queued" && operation.providerDispatchState === "may_have_started") { operation.status = "failed"; operation.providerDispatchState = "consumed"; operation.failureCode = "PROVIDER_DISPATCH_UNCERTAIN"; operation.completedAt = this.clock(); if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "image_failed"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock(); this.transition(state, operation.projectId, { cycleId: cycle.cycleId, operationId: operation.operationId, phase: "cycle", attempt: operation.attempt, from: previousCycleStatus, to: "image_failed", requestReferenceId: operation.requestReferenceId }); } this.transition(state, operation.projectId, { cycleId: operation.cycleId, operationId: operation.operationId, phase: "image", attempt: operation.attempt, from: "queued", to: "failed", requestReferenceId: operation.requestReferenceId }); }
      }
      for (const attempt of state.s3AssessmentAttempts) {
        const assessment = state.s3Assessments.find((item) => item.assessmentId === attempt.assessmentId); const cycle = assessment ? state.s3Cycles.find((item) => item.assessmentId === assessment.assessmentId) : undefined;
        if (attempt.status === "running" && this.ownerDead(attempt.claimedProcessId)) {
          if (attempt.providerDispatchState === "not_started") { attempt.status = "queued"; attempt.disposition = "pending"; attempt.startedAt = null; attempt.completedAt = null; this.clearClaim(attempt); if (assessment) { assessment.status = "pending"; assessment.updatedAt = this.clock(); } if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "assessment_pending"; cycle.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: attempt.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: previousCycleStatus, to: "assessment_pending", requestReferenceId: attempt.requestReferenceId }); } this.transition(state, attempt.projectId, { cycleId: cycle?.cycleId ?? null, assessmentId: attempt.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: "running", to: "queued", requestReferenceId: attempt.requestReferenceId }); assessmentIds.push(attempt.assessmentAttemptId); }
          else { attempt.status = "failed"; attempt.disposition = "qa_unavailable_terminal"; attempt.providerDispatchState = "consumed"; attempt.failureCode = "PROVIDER_DISPATCH_UNCERTAIN"; attempt.completedAt = this.clock(); this.clearClaim(attempt); if (assessment) { const previousAssessmentStatus = assessment.status; assessment.status = "qa_unavailable_terminal"; assessment.retryState = "none"; assessment.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle?.cycleId ?? null, assessmentId: assessment.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: previousAssessmentStatus, to: "qa_unavailable_terminal", requestReferenceId: attempt.requestReferenceId }); } if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "qa_unavailable"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: attempt.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: previousCycleStatus, to: "qa_unavailable", requestReferenceId: attempt.requestReferenceId }); } }
        }
        if (attempt.status === "queued" && attempt.providerDispatchState === "not_started") assessmentIds.push(attempt.assessmentAttemptId);
        if (attempt.status === "queued" && attempt.providerDispatchState === "may_have_started") { attempt.status = "failed"; attempt.disposition = "qa_unavailable_terminal"; attempt.providerDispatchState = "consumed"; attempt.failureCode = "PROVIDER_DISPATCH_UNCERTAIN"; attempt.completedAt = this.clock(); if (assessment) { const previousAssessmentStatus = assessment.status; assessment.status = "qa_unavailable_terminal"; assessment.retryState = "none"; assessment.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle?.cycleId ?? null, assessmentId: assessment.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: previousAssessmentStatus, to: "qa_unavailable_terminal", requestReferenceId: attempt.requestReferenceId }); } if (cycle) { const previousCycleStatus = cycle.status; cycle.status = "qa_unavailable"; cycle.retryState = "none"; cycle.terminalAt = this.clock(); cycle.updatedAt = this.clock(); this.transition(state, attempt.projectId, { cycleId: cycle.cycleId, assessmentId: attempt.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "cycle", attempt: attempt.attempt, from: previousCycleStatus, to: "qa_unavailable", requestReferenceId: attempt.requestReferenceId }); } this.transition(state, attempt.projectId, { cycleId: cycle?.cycleId ?? null, assessmentId: attempt.assessmentId, assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt, from: "queued", to: "failed", requestReferenceId: attempt.requestReferenceId }); }
      }
      return { imageIds, assessmentIds };
    });
    for (const operationId of new Set(work.imageIds)) { const operation = this.state().s3ImageOperations.find((item) => item.operationId === operationId); if (operation) this.startImageOperation(operation.cycleId); }
    for (const attemptId of new Set(work.assessmentIds)) this.startAssessmentAttempt(attemptId);
  }
}
