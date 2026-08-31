import {
  AppError,
  type BoothGeometrySnapshot,
  type S2InputVersion,
  type S4Assessment,
  type S4AssessmentAttempt,
  type S4DesignRuleSnapshot,
  type S4EditAdmission,
  type S4EditStatus,
  type S4FailureCode,
  type S4AssessmentProviderMetadata,
  type S4GeneratedAsset,
  type S4ImageOperation,
  type S4ImageProviderMetadata,
  type S4LocalEditRevision,
  type S4MaskRecord,
  type S4PreservationCheck,
  type S4Publication,
  type S4Requirement,
  type S4SourceQualityProof,
  type S4StageState,
  type S4StateTransition,
  type S4ToS5Handoff,
  type StoreState,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { assertUuid, cloneJson, jcs, newUuid, nowUtc, privateStorageKey, sha256 } from "./utils";
import {
  compileS4Assessment,
  compileS4LocalEdit,
  normalizeS4Instruction,
  reduceS4AssessmentPayload,
  type S4AssessmentCompilation,
  type S4EditCompilation,
} from "./s4-compiler";
import { materializeS4Mask, parseS4MaskRequest, type S4MaskMaterialization } from "./s4-mask";
import { evaluateS4Preservation, type S4PreservationRun } from "./s4-preservation";
import {
  OpenAIS4Provider,
  type S4AssessmentProviderInput,
  type S4AssessmentProviderResult,
  type S4ImageProviderInput,
  type S4ImageProviderResult,
  type S4ProviderContract,
} from "./s4-provider";
import {
  resolveActiveVisualRevision,
  resolveVisualRevision,
  type ResolvedVisualRevision,
} from "./revision-resolver";
import { ProviderFailure } from "./openai";
import { inspectExactS3Png } from "./s3-media";

export type PublicS4StageStatus = "not_started" | "started";
export type PublicS4RevisionKind = "s3" | "s4";
export type PublicS4PreservationStatus = "NOT_STARTED" | "RUNNING" | "PASS" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
export type PublicS4AssessmentStatus = "NOT_STARTED" | "PENDING" | "RUNNING" | "PASS" | "WARNING" | "MATERIAL_FAIL" | "QA_UNAVAILABLE";
export type PublicS4EditStatus =
  | "preparing_mask" | "generating" | "image_retry_available" | "publication_pending"
  | "preservation_running" | "assessment_pending" | "assessment_running"
  | "assessment_retry_available" | "usable_pass" | "usable_warning"
  | "material_fail" | "qa_unavailable" | "image_failed" | "publication_failed"
  | "stale" | "waived";
export type PublicS4ActivationState = "active_tip" | "usable_history" | "historical_non_activatable";

export type PublicS4AssessmentSummary = {
  status: PublicS4AssessmentStatus;
  requestedEditSatisfaction: "satisfied" | "not_satisfied" | "uncertain" | "not_verifiable" | null;
  overallRequirementResult: "satisfied" | "not_satisfied" | "uncertain" | "not_verifiable" | null;
  overallBuildabilityResult: "buildable" | "not_buildable" | "uncertain" | "not_verifiable" | null;
  materialFindingCount: number;
  warningFindingCount: number;
  uncertainFindingCount: number;
  retryAvailable: boolean;
};

export type PublicS4Edit = {
  editId: UUID;
  cycleNumber: 1 | 2;
  baseRevisionId: UUID;
  baseRevisionKind: PublicS4RevisionKind;
  status: PublicS4EditStatus;
  instructionText: string;
  maskReady: boolean;
  primitiveCount: number;
  editablePixelCount: number;
  comparisonPixelCount: number;
  outputRevisionId: UUID | null;
  preservationStatus: PublicS4PreservationStatus;
  assessment: PublicS4AssessmentSummary | null;
  imageRetryAvailable: boolean;
  assessmentRetryAvailable: boolean;
  activationState: PublicS4ActivationState;
  previewAvailable: boolean;
  createdAt: string;
  terminalAt: string | null;
};

export type PublicS4State = {
  projectId: UUID;
  generationSetId: UUID;
  selectionVersion: number;
  activeRevisionId: UUID | null;
  activeRevisionKind: PublicS4RevisionKind | null;
  activeQuality: "PASS" | "WARNING" | null;
  activePreviewAvailable: boolean;
  stageStatus: PublicS4StageStatus;
  s3RefinementClosed: boolean;
  cyclesConsumed: 0 | 1 | 2;
  cyclesRemaining: 0 | 1 | 2;
  edits: PublicS4Edit[];
};

export type PublicS4Mutation<T> = { replayed: boolean; result: T };
export type PublicS4EditAdmission = {
  editId: UUID;
  cycleNumber: 1 | 2;
  status: "preparing_mask";
  maskReady: false;
  baseRevisionId: UUID;
  selectionVersion: number;
  cyclesConsumed: 1 | 2;
};
export type PublicS4RetryAdmission = {
  editId: UUID;
  status: "generating" | "assessment_pending";
  imageRetryAvailable: false;
  assessmentRetryAvailable: false;
};

export type S4DispatchPhase = "before-dispatch" | "after-dispatch-marked";
export type S4PublicationPhase = "before-publication-intent" | "after-publication-intent" | "after-publication-staged" | "after-final-promotion";
export type S4WorkflowServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  provider?: S4ProviderContract;
  clock?: () => string;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onProviderDispatchPhase?: (phase: S4DispatchPhase, operation: S4ImageOperation | S4AssessmentAttempt) => "interrupt" | void | Promise<"interrupt" | void>;
  onPublicationPhase?: (phase: S4PublicationPhase, publication: S4Publication) => "interrupt" | void | Promise<"interrupt" | void>;
};

const S4_CYCLE_LIMIT = 2 as const;
const S4_IMAGE_RETRYABLE = new Set<string>([
  "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "PROVIDER_MALFORMED_RESPONSE",
  "IMAGE_EMPTY", "IMAGE_MALFORMED", "MEDIA_CORRUPT", "MEDIA_NORMALIZATION_FAILED",
  "S4_OUTPUT_DIMENSIONS_INVALID",
]);
const S4_ASSESSMENT_RETRYABLE = new Set<string>([
  "PROVIDER_RATE_LIMIT", "PROVIDER_SERVER_ERROR", "QA_PROVIDER_EMPTY", "QA_PROVIDER_INCOMPLETE",
]);
const S4_FAILURE_CODES = new Set<string>([
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
]);

class ProcessInterruption extends Error {}

function fail(status: number, code: string, field = "request"): AppError {
  return new AppError(status, code, [{ field, code }]);
}

function operationHash(operation: string, projectId: UUID, input: unknown): string {
  return sha256(Buffer.from(jcs({ operation, projectId, input }), "utf8"));
}

function canonicalHash(value: unknown): string {
  return sha256(Buffer.from(jcs(value), "utf8"));
}

function failureCode(error: unknown): S4FailureCode {
  const value = error instanceof ProviderFailure
    ? error.safeCode
    : error instanceof AppError
      ? error.code
      : "PERSISTENCE_FAILED";
  const normalized = value === "S3_OUTPUT_DIMENSIONS_INVALID" ? "S4_OUTPUT_DIMENSIONS_INVALID" : value;
  return (S4_FAILURE_CODES.has(normalized) ? normalized : "PERSISTENCE_FAILED") as S4FailureCode;
}

function asCount(value: number): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) throw new Error("invalid S4 count");
  return value as 0 | 1 | 2;
}

function clearClaim(value: { claimedBy: string | null; claimedProcessId: number | null; claimToken: UUID | null; claimedAt: string | null }): void {
  value.claimedBy = null;
  value.claimedProcessId = null;
  value.claimToken = null;
  value.claimedAt = null;
}

function dispatchInLineage(
  state: StoreState,
  item: { projectId: UUID; generationSetId: UUID; selectionStateId: UUID; editId: UUID; providerDispatchState: string },
  context: { projectId: UUID; generationSetId: UUID; selectionStateId: UUID; lineageRootRevisionId: UUID },
): boolean {
  const edit = state.s4Edits.find((candidate) => candidate.editId === item.editId);
  return item.projectId === context.projectId &&
    item.generationSetId === context.generationSetId &&
    item.selectionStateId === context.selectionStateId &&
    edit?.lineageRootRevisionId === context.lineageRootRevisionId &&
    item.providerDispatchState !== "not_started";
}

function objectIdentity(objects: PrivateObjectStore, key: string, expectedSha: string, expectedBytes: number): Buffer {
  try {
    const bytes = objects.read(key);
    if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha) throw new Error("object identity");
    return bytes;
  } catch {
    throw fail(500, "S4_INTERNAL_ERROR");
  }
}

function publicPreservationStatus(check: S4PreservationCheck | null): PublicS4PreservationStatus {
  if (!check || check.status === "pending") return "NOT_STARTED";
  if (check.status === "running") return "RUNNING";
  return check.status;
}

function publicAssessmentStatus(assessment: S4Assessment | null): PublicS4AssessmentStatus {
  if (!assessment || assessment.status === "not_started") return "NOT_STARTED";
  if (assessment.status === "pending") return "PENDING";
  if (assessment.status === "running") return "RUNNING";
  if (assessment.status === "pass") return "PASS";
  if (assessment.status === "warning") return "WARNING";
  if (assessment.status === "material_fail" || assessment.status === "skipped_preservation_fail") return "MATERIAL_FAIL";
  return "QA_UNAVAILABLE";
}

function publicEditStatus(edit: S4EditAdmission, assessment: S4Assessment | null): PublicS4EditStatus {
  switch (edit.status) {
    case "mask_materialization_pending": return "preparing_mask";
    case "image_queued":
    case "image_running": return "generating";
    case "image_retry_available": return "image_retry_available";
    case "publication_pending": return "publication_pending";
    case "preservation_pending":
    case "preservation_running": return "preservation_running";
    case "assessment_pending": return "assessment_pending";
    case "assessment_running": return "assessment_running";
    case "assessment_retry_available": return "assessment_retry_available";
    case "completed": return assessment?.status === "warning" ? "usable_warning" : "usable_pass";
    case "material_fail": return "material_fail";
    case "qa_unavailable": return "qa_unavailable";
    case "image_failed": return "image_failed";
    case "publication_failed": return "publication_failed";
    case "stale": return "stale";
    case "waived": return "waived";
    default: return "qa_unavailable";
  }
}

function publicAssessmentSummary(assessment: S4Assessment | null, attempts: readonly S4AssessmentAttempt[]): PublicS4AssessmentSummary | null {
  if (!assessment) return null;
  const latest = assessment.latestAttemptId
    ? attempts.find((item) => item.assessmentAttemptId === assessment.latestAttemptId)
    : undefined;
  return {
    status: publicAssessmentStatus(assessment),
    requestedEditSatisfaction: assessment.requestedEditSatisfaction,
    overallRequirementResult: assessment.overallRequirementResult,
    overallBuildabilityResult: assessment.overallBuildabilityResult,
    materialFindingCount: latest?.materialFindingIds.length ?? 0,
    warningFindingCount: latest?.warningFindingIds.length ?? 0,
    uncertainFindingCount: latest?.uncertainFindingIds.length ?? 0,
    retryAvailable: assessment.retryState === "available",
  };
}

export class S4WorkflowService {
  private readonly repository: JsonRepository;
  private readonly objects: PrivateObjectStore;
  private readonly provider: S4ProviderContract;
  private readonly clock: () => string;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly onProviderDispatchPhase: S4WorkflowServiceOptions["onProviderDispatchPhase"];
  private readonly onPublicationPhase: S4WorkflowServiceOptions["onPublicationPhase"];
  private readonly inFlight = new Set<string>();

  constructor(options: S4WorkflowServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.provider = options.provider ?? new OpenAIS4Provider();
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.workerId = options.workerId ?? "s4-worker-" + String(this.processId);
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
    this.onProviderDispatchPhase = options.onProviderDispatchPhase;
    this.onPublicationPhase = options.onPublicationPhase;
    this.recover();
  }

  private state(): StoreState {
    return this.repository.state();
  }

  private project(state: StoreState, projectId: UUID) {
    const project = state.projects.find((item) => item.projectId === projectId);
    if (!project) throw fail(404, "S4_SOURCE_NOT_FOUND", "projectId");
    return project;
  }

  private generation(state: StoreState, projectId: UUID) {
    const project = this.project(state, projectId);
    if (!project.activeGenerationSetId || !project.confirmedBriefVersionId) throw fail(404, "S4_NOT_AVAILABLE");
    const generationSet = state.generationSets.find((item) =>
      item.projectId === projectId && item.generationSetId === project.activeGenerationSetId);
    const selection = state.s3Selections.find((item) =>
      item.projectId === projectId && item.generationSetId === project.activeGenerationSetId);
    if (!generationSet || !selection) throw fail(404, "S4_SOURCE_NOT_FOUND");
    return { project, generationSet, selection };
  }

  private idempotency(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string) {
    const existing = state.idempotency.find((item) => item.key === key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.projectId !== projectId || existing.inputHash !== inputHash) {
      throw fail(409, "S4_IDEMPOTENCY_KEY_REUSE");
    }
    return existing;
  }

  private remember(state: StoreState, key: UUID, operation: string, projectId: UUID, inputHash: string, result: Record<string, unknown>): void {
    state.idempotency.push({ key, operation, projectId, inputHash, result: cloneJson(result), createdAt: this.clock() });
  }

  private transition(state: StoreState, values: S4StateTransition): void {
    state.s4Transitions.push(values);
  }

  private sourceAndInput(state: StoreState, projectId: UUID, resolved: ResolvedVisualRevision): {
    source: StoreState["s3Sources"][number];
    input: S2InputVersion;
  } {
    const source = state.s3Sources.find((item) =>
      item.projectId === projectId && item.sourceSnapshotId === resolved.sourceSnapshotId);
    if (!source) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
    const input = state.s2Inputs.find((item) => item.projectId === projectId && item.id === source.s2InputVersionId);
    if (!input) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
    return { source, input };
  }

  private qualityProof(state: StoreState, resolved: ResolvedVisualRevision, source: StoreState["s3Sources"][number]): S4SourceQualityProof {
    if (resolved.kind === "s4") {
      return {
        kind: "s4_local_edit",
        sourceSnapshotId: resolved.sourceSnapshotId,
        sourceRevisionId: resolved.revisionId,
        preservationCheckId: resolved.preservationCheckId,
        assessmentId: resolved.assessmentId,
        status: resolved.quality,
        verdictRecordId: resolved.assessmentId,
      };
    }
    if (resolved.revisionId === resolved.lineageRootRevisionId) {
      return {
        kind: "s3_source",
        sourceSnapshotId: source.sourceSnapshotId,
        sourceRevisionId: resolved.revisionId,
        sourceBindingHash: source.sourceBindingHash,
        status: resolved.quality,
        verdictRecordId: source.canonicalSourceBinding.eligibilityResultId,
      };
    }
    const revision = state.s3Revisions.find((item) => item.revisionId === resolved.revisionId);
    const assessment = revision && revision.kind === "refinement"
      ? state.s3Assessments.find((item) => item.assessmentId === revision.assessmentId)
      : undefined;
    if (!revision || revision.kind !== "refinement" || !assessment) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
    return {
      kind: "s3_refinement",
      sourceSnapshotId: source.sourceSnapshotId,
      sourceRevisionId: resolved.revisionId,
      sourceBindingHash: source.sourceBindingHash,
      assessmentId: assessment.assessmentId,
      status: resolved.quality,
      verdictRecordId: assessment.assessmentId,
    };
  }

  private s4Requirements(input: S2InputVersion): S4Requirement[] {
    return cloneJson(input.canonicalRequirements) as S4Requirement[];
  }

  private s4Rules(input: S2InputVersion): S4DesignRuleSnapshot[] {
    return cloneJson(input.designRuleSnapshot) as S4DesignRuleSnapshot[];
  }

  private sourceRevisionDescriptor(state: StoreState, resolved: ResolvedVisualRevision) {
    if (resolved.kind === "s4") {
      const revision = state.s4Revisions.find((item) => item.revisionId === resolved.revisionId);
      if (!revision) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
      return {
        kind: "s4" as const,
        revisionId: revision.revisionId,
        parentRevisionId: revision.parentRevisionId,
        parentRevisionKind: revision.parentRevisionKind,
      };
    }
    const revision = state.s3Revisions.find((item) => item.revisionId === resolved.revisionId);
    if (!revision) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
    return {
      kind: "s3" as const,
      revisionId: revision.revisionId,
      parentRevisionId: revision.parentRevisionId,
      parentRevisionKind: revision.kind === "source_selection" ? null : "s3" as const,
    };
  }

  private editCompilation(
    state: StoreState,
    projectId: UUID,
    selection: StoreState["s3Selections"][number],
    resolved: ResolvedVisualRevision,
    source: StoreState["s3Sources"][number],
    input: S2InputVersion,
    cycleNumber: 1 | 2,
    instructionText: string,
    mask: S4MaskMaterialization,
  ): S4EditCompilation {
    return compileS4LocalEdit({
      projectId,
      generationSetId: selection.generationSetId,
      selectionStateId: selection.selectionStateId,
      selectionVersion: selection.selectionVersion,
      sourceSnapshotId: source.sourceSnapshotId,
      lineageRootRevisionId: selection.lineageRootRevisionId!,
      sourceRevision: this.sourceRevisionDescriptor(state, resolved),
      sourceAsset: {
        assetId: resolved.assetId,
        sha256: resolved.sha256,
        byteSize: resolved.byteSize,
        width: 1536,
        height: 1024,
        pixelCount: 1_572_864,
        mediaProfile: "s2-media-v1",
      },
      sourceQuality: this.qualityProof(state, resolved, source),
      confirmedBriefVersionId: selection.confirmedBriefVersionId,
      confirmedBriefContentHash: selection.confirmedBriefContentHash,
      geometrySnapshot: cloneJson(input.geometrySnapshot) as BoothGeometrySnapshot,
      geometryHash: input.geometryHash,
      canonicalRequirements: this.s4Requirements(input),
      requirementHash: input.requirementHash,
      designRulesVersion: "s2-design-rules-v1",
      designRuleSnapshot: this.s4Rules(input),
      designRuleSnapshotHash: canonicalHash(input.designRuleSnapshot),
      cycleNumber,
      mask: {
        schemaVersion: "s4-mask-raster-v1",
        width: 1536,
        height: 1024,
        protectedValue: 0,
        editableValue: 255,
        layout: "row-major-top-left-one-byte-per-pixel",
        primitives: cloneJson(mask.primitives),
        primitiveHash: mask.primitiveHash,
        rasterSha256: mask.rasterSha256,
        editablePixelCount: mask.editablePixelCount,
        comparisonPixelCount: mask.comparisonPixelCount,
        maskIdentityHash: mask.maskIdentityHash,
        providerPngVersion: "s4-mask-png-v1",
        providerPngSha256: mask.providerPngSha256,
      },
      instructionText,
    });
  }

  admitEdit(projectId: UUID, body: unknown, key: UUID, referenceId: UUID): PublicS4Mutation<PublicS4EditAdmission> {
    assertUuid(projectId, "projectId");
    assertUuid(key, "Idempotency-Key");
    assertUuid(referenceId, "x-request-id");
    const parsed = parseS4MaskRequest(body);
    let instructionText: string;
    try { instructionText = normalizeS4Instruction(parsed.instructionText); }
    catch { throw fail(400, "S4_INSTRUCTION_INVALID", "instructionText"); }
    const requestInput = {
      baseRevisionId: parsed.baseRevisionId,
      expectedSelectionVersion: parsed.expectedSelectionVersion,
      primitives: cloneJson(parsed.primitives),
      instructionText,
    };
    const requestHash = operationHash("s4_edit_admission", projectId, requestInput);
    let materialized: S4MaskMaterialization;
    try { materialized = materializeS4Mask(parsed.primitives); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw fail(400, "S4_MASK_INVALID", "primitives");
    }

    const result = this.repository.transact((state) => {
      const { selection } = this.generation(state, projectId);
      const replay = this.idempotency(state, key, "s4_edit_admission", projectId, requestHash);
      if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS4EditAdmission };
      if (selection.selectionVersion !== parsed.expectedSelectionVersion) throw fail(409, "S4_SELECTION_VERSION_CONFLICT");
      if (!selection.activeRevisionId || selection.activeRevisionId !== parsed.baseRevisionId ||
          !selection.lineageRootRevisionId) throw fail(409, "S4_STALE_SOURCE");
      let resolved: ResolvedVisualRevision;
      try { resolved = resolveVisualRevision(state, projectId, parsed.baseRevisionId, this.objects); }
      catch { throw fail(409, "S4_SOURCE_NOT_ELIGIBLE"); }
      const source = state.s3Sources.find((item) =>
        item.projectId === projectId && item.sourceSnapshotId === resolved.sourceSnapshotId);
      const input = source && state.s2Inputs.find((item) =>
        item.projectId === projectId && item.id === source.s2InputVersionId);
      if (!source || !input) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
      const stage = state.s4Stages.find((item) =>
        item.projectId === projectId && item.generationSetId === selection.generationSetId &&
        item.selectionStateId === selection.selectionStateId && item.sourceSnapshotId === source.sourceSnapshotId &&
        item.lineageRootRevisionId === selection.lineageRootRevisionId);
      const edits = state.s4Edits.filter((item) =>
        item.projectId === projectId && item.generationSetId === selection.generationSetId &&
        item.selectionStateId === selection.selectionStateId && item.lineageRootRevisionId === selection.lineageRootRevisionId);
      if (edits.some((item) => [
        "mask_materialization_pending", "image_queued", "image_running", "publication_pending",
        "preservation_pending", "preservation_running", "assessment_pending", "assessment_running",
      ].includes(item.status))) throw fail(409, "S4_EDIT_IN_PROGRESS");
      const cycleNumber = ((stage?.cyclesConsumed ?? 0) + 1) as 1 | 2;
      if (cycleNumber > S4_CYCLE_LIMIT) throw fail(409, "S4_BUDGET_EXHAUSTED");
      const instructionHash = canonicalHash({ schemaVersion: "s4-instruction-v1", instructionText });
      if (edits.some((item) =>
        item.baseRevisionId === parsed.baseRevisionId &&
        item.baseSelectionVersion === parsed.expectedSelectionVersion &&
        item.cycleNumber === cycleNumber &&
        item.maskIdentityHash === materialized.maskIdentityHash &&
        item.instructionHash === instructionHash)) throw fail(409, "S4_DUPLICATE_EDIT");

      for (const old of edits) {
        if (old.retryState === "none") continue;
        const previous = old.status;
        old.retryState = "waived";
        old.retryWaivedReason = "later_cycle_started";
        old.status = "waived";
        old.updatedAt = this.clock();
        if (old.assessmentId) {
          const assessment = state.s4Assessments.find((item) => item.assessmentId === old.assessmentId);
          if (assessment?.retryState === "available") {
            assessment.retryState = "waived";
            assessment.retryWaivedReason = "later_cycle_started";
            assessment.updatedAt = this.clock();
          }
        }
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId,
          generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId,
          editId: old.editId, operationId: null, publicationId: null,
          preservationCheckId: old.preservationCheckId, assessmentId: old.assessmentId,
          assessmentAttemptId: null, phase: "edit", attempt: null,
          from: previous === "assessment_retry_available" ? "assessment_retry_available" : "image_retry_available",
          to: "waived", reason: "retry_waived", priorRevisionId: old.baseRevisionId,
          resultingRevisionId: old.outputRevisionId, expectedSelectionVersion: selection.selectionVersion,
          resultingSelectionVersion: selection.selectionVersion, requestReferenceId: referenceId,
        });
      }

      const compilation = this.editCompilation(state, projectId, selection, resolved, source, input, cycleNumber, instructionText, materialized);
      const stageId = stage?.stageId ?? this.uuid();
      const editId = this.uuid();
      const maskId = this.uuid();
      const createdAt = this.clock();
      const mask: S4MaskRecord = {
        maskId, editId, projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId,
        sourceRevisionId: resolved.revisionId, sourceAssetId: resolved.assetId, schemaVersion: "s4-mask-raster-v1",
        width: 1536, height: 1024, pixelCount: 1_572_864, protectedValue: 0, editableValue: 255,
        layout: "row-major-top-left-one-byte-per-pixel", primitives: cloneJson(materialized.primitives),
        primitiveCount: materialized.primitives.length,
        brushPointCount: materialized.primitives.reduce((count, item) => count + (item.kind === "brush" ? item.points.length : 0), 0),
        primitiveHash: materialized.primitiveHash, rasterSha256: materialized.rasterSha256, rasterBytes: 1_572_864,
        rasterStorageKey: privateStorageKey("projects", projectId, "s4", "edits", editId, "mask", maskId, "raster.bin"),
        providerPngVersion: "s4-mask-png-v1", providerPngSha256: materialized.providerPngSha256,
        providerPngBytes: materialized.providerPng.byteLength,
        providerPngStorageKey: privateStorageKey("projects", projectId, "s4", "edits", editId, "mask", maskId, "provider.png"),
        editablePixelCount: materialized.editablePixelCount, protectedPixelCount: materialized.protectedPixelCount,
        comparisonPixelCount: materialized.comparisonPixelCount, maskIdentityHash: materialized.maskIdentityHash, createdAt,
      };
      const edit: S4EditAdmission = {
        editId, projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId,
        sourceSnapshotId: source.sourceSnapshotId, lineageRootRevisionId: selection.lineageRootRevisionId,
        cycleNumber, baseRevisionId: resolved.revisionId, baseRevisionKind: resolved.kind,
        baseSelectionVersion: selection.selectionVersion, maskId, maskIdentityHash: materialized.maskIdentityHash,
        maskMaterializationStatus: "pending", instructionText, instructionHash: compilation.canonicalInput.instructionHash,
        compilerVersion: "s4-local-edit-v1", editInputHash: compilation.editInputHash, promptHash: compilation.promptHash,
        providerRequestHash: compilation.providerRequestHash, imageOperationIds: [], outputRevisionId: null,
        preservationCheckId: null, assessmentId: null, assessmentAttemptIds: [], status: "mask_materialization_pending",
        retryState: "none", retryWaivedReason: null, createdAt, admittedAt: createdAt, updatedAt: createdAt, terminalAt: null,
      };
      if (!stage) {
        state.s4Stages.push({
          stageId, projectId, generationSetId: selection.generationSetId, selectionStateId: selection.selectionStateId,
          sourceSnapshotId: source.sourceSnapshotId, lineageRootRevisionId: selection.lineageRootRevisionId,
          status: "started", s3RefinementClosed: true, cyclesConsumed: cycleNumber, firstEditId: editId,
          createdAt, startedAt: createdAt, updatedAt: createdAt,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId, generationSetId: selection.generationSetId,
          selectionStateId: selection.selectionStateId, editId, operationId: null, publicationId: null,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null, phase: "stage", attempt: null,
          from: null, to: "started", reason: "admitted", priorRevisionId: selection.activeRevisionId,
          resultingRevisionId: null, expectedSelectionVersion: selection.selectionVersion,
          resultingSelectionVersion: selection.selectionVersion, requestReferenceId: referenceId,
        });
      } else {
        stage.cyclesConsumed = cycleNumber;
        stage.updatedAt = createdAt;
      }
      state.s4Masks.push(mask);
      state.s4Edits.push(edit);
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId, generationSetId: selection.generationSetId,
        selectionStateId: selection.selectionStateId, editId, operationId: null, publicationId: null,
        preservationCheckId: null, assessmentId: null, assessmentAttemptId: null, phase: "edit", attempt: null,
        from: null, to: "mask_materialization_pending", reason: "admitted", priorRevisionId: resolved.revisionId,
        resultingRevisionId: null, expectedSelectionVersion: selection.selectionVersion,
        resultingSelectionVersion: selection.selectionVersion, requestReferenceId: referenceId,
      });
      const response: PublicS4EditAdmission = {
        editId, cycleNumber, status: "preparing_mask", maskReady: false,
        baseRevisionId: resolved.revisionId, selectionVersion: selection.selectionVersion, cyclesConsumed: cycleNumber,
      };
      this.remember(state, key, "s4_edit_admission", projectId, requestHash, response as unknown as Record<string, unknown>);
      return { replayed: false, result: response };
    });
    if (!result.replayed) void this.materializeMask(result.result.editId);
    return result;
  }

  private verifyMaskObject(mask: S4MaskRecord): { raster: Buffer; providerPng: Buffer } {
    return {
      raster: objectIdentity(this.objects, mask.rasterStorageKey, mask.rasterSha256, mask.rasterBytes),
      providerPng: objectIdentity(this.objects, mask.providerPngStorageKey, mask.providerPngSha256, mask.providerPngBytes),
    };
  }

  private markMaskFailure(editId: UUID, code: S4FailureCode): void {
    try {
      this.repository.transact((state) => {
        const edit = state.s4Edits.find((item) => item.editId === editId);
        if (!edit || edit.maskMaterializationStatus !== "pending") return;
        const previous = edit.status;
        edit.status = "qa_unavailable";
        edit.retryState = "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = this.clock();
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId, operationId: null, publicationId: null, preservationCheckId: null, assessmentId: null,
          assessmentAttemptId: null, phase: "edit", attempt: null, from: previous, to: "qa_unavailable",
          reason: code === "S4_MASK_INVALID" ? "fence_stale" : "publication_aborted",
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: null, resultingSelectionVersion: null, requestReferenceId: this.uuid(),
        });
      });
    } catch {
      // A failed transaction remains recoverable from the committed pending intent.
    }
  }

  private async materializeMask(editId: UUID): Promise<void> {
    const initial = this.state();
    const edit = initial.s4Edits.find((item) => item.editId === editId);
    const mask = edit ? initial.s4Masks.find((item) => item.maskId === edit.maskId) : undefined;
    if (!edit || !mask || edit.maskMaterializationStatus !== "pending") return;
    try {
      const materialized = materializeS4Mask(mask.primitives);
      if (materialized.maskIdentityHash !== mask.maskIdentityHash ||
          materialized.rasterSha256 !== mask.rasterSha256 ||
          materialized.providerPngSha256 !== mask.providerPngSha256 ||
          materialized.editablePixelCount !== mask.editablePixelCount ||
          materialized.comparisonPixelCount !== mask.comparisonPixelCount) {
        throw new AppError(500, "S4_MASK_INVALID");
      }
      this.objects.putExact(mask.rasterStorageKey, materialized.raster);
      this.objects.putExact(mask.providerPngStorageKey, materialized.providerPng);
      this.verifyMaskObject(mask);
      const operationId = this.repository.transact((state) => {
        const currentEdit = state.s4Edits.find((item) => item.editId === editId);
        const currentMask = currentEdit ? state.s4Masks.find((item) => item.maskId === currentEdit.maskId) : undefined;
        const selection = currentEdit ? state.s3Selections.find((item) => item.selectionStateId === currentEdit.selectionStateId) : undefined;
        if (!currentEdit || !currentMask || !selection || currentEdit.maskMaterializationStatus !== "pending") return null;
        if (selection.selectionVersion !== currentEdit.baseSelectionVersion ||
            selection.activeRevisionId !== currentEdit.baseRevisionId) {
          currentEdit.status = "stale";
          currentEdit.terminalAt = this.clock();
          currentEdit.updatedAt = this.clock();
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: currentEdit.projectId,
            generationSetId: currentEdit.generationSetId, selectionStateId: currentEdit.selectionStateId,
            editId, operationId: null, publicationId: null, preservationCheckId: null, assessmentId: null,
            assessmentAttemptId: null, phase: "edit", attempt: null, from: "mask_materialization_pending",
            to: "stale", reason: "fence_stale", priorRevisionId: currentEdit.baseRevisionId,
            resultingRevisionId: null, expectedSelectionVersion: currentEdit.baseSelectionVersion,
            resultingSelectionVersion: selection.selectionVersion, requestReferenceId: this.uuid(),
          });
          return null;
        }
        this.verifyMaskObject(currentMask);
        const operationId = this.uuid();
        const operationInputHash = canonicalHash({
          schemaVersion: "s4-image-operation-v1", projectId: currentEdit.projectId,
          generationSetId: currentEdit.generationSetId, selectionStateId: currentEdit.selectionStateId,
          editId: currentEdit.editId, baseRevisionId: currentEdit.baseRevisionId,
          baseSelectionVersion: currentEdit.baseSelectionVersion, attempt: 1,
          editInputHash: currentEdit.editInputHash, promptHash: currentEdit.promptHash,
          providerRequestHash: currentEdit.providerRequestHash, maskIdentityHash: currentMask.maskIdentityHash,
        });
        const operation: S4ImageOperation = {
          operationId, projectId: currentEdit.projectId, editId: currentEdit.editId,
          generationSetId: currentEdit.generationSetId, selectionStateId: currentEdit.selectionStateId,
          baseRevisionId: currentEdit.baseRevisionId, baseSelectionVersion: currentEdit.baseSelectionVersion,
          attempt: 1, retryOfOperationId: null, operationInputHash,
          editInputHash: currentEdit.editInputHash, promptHash: currentEdit.promptHash,
          providerRequestHash: currentEdit.providerRequestHash, requestReferenceId: this.uuid(),
          status: "queued", claimedBy: null, claimedProcessId: null, claimToken: null,
          claimedAt: null, startedAt: null, completedAt: null, providerDispatchState: "not_started",
          providerMetadata: null, failureCode: null, publicationId: null,
          outputRevisionId: null, outputAssetId: null, createdAt: this.clock(),
        };
        state.s4ImageOperations.push(operation);
        currentEdit.maskMaterializationStatus = "ready";
        currentEdit.imageOperationIds = [operationId];
        currentEdit.status = "image_queued";
        currentEdit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: currentEdit.projectId,
          generationSetId: currentEdit.generationSetId, selectionStateId: currentEdit.selectionStateId,
          editId, operationId, publicationId: null, preservationCheckId: null, assessmentId: null,
          assessmentAttemptId: null, phase: "edit", attempt: 1, from: "mask_materialization_pending",
          to: "image_queued", reason: "mask_materialization_verified", priorRevisionId: currentEdit.baseRevisionId,
          resultingRevisionId: null, expectedSelectionVersion: currentEdit.baseSelectionVersion,
          resultingSelectionVersion: currentEdit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: currentEdit.projectId,
          generationSetId: currentEdit.generationSetId, selectionStateId: currentEdit.selectionStateId,
          editId, operationId, publicationId: null, preservationCheckId: null, assessmentId: null,
          assessmentAttemptId: null, phase: "image", attempt: 1, from: null, to: "queued", reason: null,
          priorRevisionId: currentEdit.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: currentEdit.baseSelectionVersion,
          resultingSelectionVersion: currentEdit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
        return operationId;
      });
      if (operationId) this.startImageOperation(operationId);
    } catch (error) {
      this.markMaskFailure(editId, failureCode(error));
    }
  }

  private activationState(state: StoreState, edit: S4EditAdmission, activeRevisionId: UUID | null): PublicS4ActivationState {
    if (activeRevisionId === edit.outputRevisionId && activeRevisionId !== null) return "active_tip";
    if (edit.outputRevisionId === null) return "historical_non_activatable";
    try {
      resolveVisualRevision(state, edit.projectId, edit.outputRevisionId, this.objects);
      return "usable_history";
    } catch {
      return "historical_non_activatable";
    }
  }

  private publicEdit(state: StoreState, edit: S4EditAdmission, activeRevisionId: UUID | null): PublicS4Edit {
    const mask = state.s4Masks.find((item) => item.maskId === edit.maskId);
    const preservation = edit.preservationCheckId
      ? state.s4PreservationChecks.find((item) => item.preservationCheckId === edit.preservationCheckId) ?? null
      : null;
    const assessment = edit.assessmentId
      ? state.s4Assessments.find((item) => item.assessmentId === edit.assessmentId) ?? null
      : null;
    const previewAvailable = edit.outputRevisionId !== null && (() => {
      try {
        const resolved = resolveVisualRevision(state, edit.projectId, edit.outputRevisionId!, this.objects);
        return resolved.kind === "s4" && resolved.revisionId === edit.outputRevisionId;
      } catch {
        return false;
      }
    })();
    return {
      editId: edit.editId, cycleNumber: edit.cycleNumber, baseRevisionId: edit.baseRevisionId,
      baseRevisionKind: edit.baseRevisionKind, status: publicEditStatus(edit, assessment),
      instructionText: edit.instructionText, maskReady: edit.maskMaterializationStatus === "ready",
      primitiveCount: mask?.primitiveCount ?? 0, editablePixelCount: mask?.editablePixelCount ?? 0,
      comparisonPixelCount: mask?.comparisonPixelCount ?? 0, outputRevisionId: edit.outputRevisionId,
      preservationStatus: publicPreservationStatus(preservation),
      assessment: publicAssessmentSummary(
        assessment,
        state.s4AssessmentAttempts.filter((item) => item.assessmentId === assessment?.assessmentId),
      ),
      imageRetryAvailable: edit.retryState === "image_available",
      assessmentRetryAvailable: edit.retryState === "assessment_available",
      activationState: this.activationState(state, edit, activeRevisionId),
      previewAvailable, createdAt: edit.createdAt, terminalAt: edit.terminalAt,
    };
  }

  getState(projectId: UUID): PublicS4State {
    assertUuid(projectId, "projectId");
    const state = this.state();
    const { generationSet, selection } = this.generation(state, projectId);
    const active =
      selection.activeRevisionId === null
        ? null
        : resolveActiveVisualRevision(state, projectId, this.objects);
    const stage = state.s4Stages.find((item) =>
      item.projectId === projectId && item.generationSetId === generationSet.generationSetId &&
      item.selectionStateId === selection.selectionStateId && item.lineageRootRevisionId === selection.lineageRootRevisionId);
    const edits = state.s4Edits
      .filter((item) =>
        item.projectId === projectId && item.generationSetId === generationSet.generationSetId &&
        item.selectionStateId === selection.selectionStateId && item.lineageRootRevisionId === selection.lineageRootRevisionId)
      .sort((left, right) => left.cycleNumber - right.cycleNumber)
      .map((edit) => this.publicEdit(state, edit, selection.activeRevisionId));
    return {
      projectId, generationSetId: generationSet.generationSetId, selectionVersion: selection.selectionVersion,
      activeRevisionId: selection.activeRevisionId, activeRevisionKind: active?.kind ?? null,
      activeQuality: active?.quality ?? null,
      activePreviewAvailable: Boolean(active && this.objects.exists(active.storageKey)),
      stageStatus: stage ? "started" : "not_started", s3RefinementClosed: Boolean(stage),
      cyclesConsumed: asCount(stage?.cyclesConsumed ?? 0),
      cyclesRemaining: asCount(S4_CYCLE_LIMIT - (stage?.cyclesConsumed ?? 0)), edits,
    };
  }

  toS5Handoff(projectId: UUID): S4ToS5Handoff {
    assertUuid(projectId, "projectId");
    const state = this.state();
    const { generationSet, selection } = this.generation(state, projectId);
    const active = resolveActiveVisualRevision(state, projectId, this.objects);
    if (!active) throw fail(409, "S4_SOURCE_NOT_ELIGIBLE");
    const { input } = this.sourceAndInput(state, projectId, active);
    const stage = state.s4Stages.find((item) =>
      item.projectId === projectId &&
      item.generationSetId === generationSet.generationSetId &&
      item.selectionStateId === selection.selectionStateId &&
      item.lineageRootRevisionId === selection.lineageRootRevisionId);
    return {
      projectId,
      generationSetId: generationSet.generationSetId,
      selectionStateId: selection.selectionStateId,
      selectionVersion: selection.selectionVersion,
      activeRevisionId: active.revisionId,
      activeRevisionKind: active.kind,
      sourceSnapshotId: active.sourceSnapshotId,
      lineageRootRevisionId: active.lineageRootRevisionId,
      activeAssetId: active.assetId,
      activeAssetSha256: active.sha256,
      activeAssetByteSize: active.byteSize,
      activeAssetStorageKey: active.storageKey,
      width: 1536,
      height: 1024,
      pixelCount: 1_572_864,
      quality: active.quality,
      confirmedBriefVersionId: input.confirmedBriefVersionId,
      confirmedBriefContentHash: input.confirmedBriefContentHash,
      geometrySnapshot: cloneJson(input.geometrySnapshot) as BoothGeometrySnapshot,
      geometryHash: input.geometryHash,
      canonicalRequirements: this.s4Requirements(input),
      requirementHash: input.requirementHash,
      designRulesVersion: "s2-design-rules-v1",
      designRuleSnapshot: this.s4Rules(input),
      designRuleSnapshotHash: canonicalHash(input.designRuleSnapshot),
      s4StageStatus: stage ? "started" : "not_started",
      s4CyclesConsumed: asCount(stage?.cyclesConsumed ?? 0),
    };
  }

  getEdit(projectId: UUID, editId: UUID): PublicS4Edit {
    assertUuid(projectId, "projectId");
    assertUuid(editId, "editId");
    const state = this.state();
    const { selection } = this.generation(state, projectId);
    const edit = state.s4Edits.find((item) =>
      item.projectId === projectId && item.editId === editId && item.selectionStateId === selection.selectionStateId);
    if (!edit) throw fail(404, "S4_EDIT_NOT_FOUND", "editId");
    return this.publicEdit(state, edit, selection.activeRevisionId);
  }

  private async notifyDispatch(phase: S4DispatchPhase, value: S4ImageOperation | S4AssessmentAttempt): Promise<void> {
    if ((await this.onProviderDispatchPhase?.(phase, cloneJson(value))) === "interrupt") {
      throw new ProcessInterruption();
    }
  }

  private async notifyPublication(phase: S4PublicationPhase, value: S4Publication): Promise<void> {
    if ((await this.onPublicationPhase?.(phase, cloneJson(value))) === "interrupt") {
      throw new ProcessInterruption();
    }
  }

  private assertImageDispatchReady(): void {
    if (typeof this.provider.runS4ImageEdit !== "function") throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
    this.provider.assertS4ImageEditReady?.();
  }

  private assertAssessmentDispatchReady(): void {
    if (typeof this.provider.runS4Assessment !== "function") throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
    this.provider.assertS4AssessmentReady?.();
  }

  private requeueImageBeforeDispatch(operationId: UUID, token: UUID): void {
    try {
      this.repository.transact((state) => {
        const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
        const edit = operation && state.s4Edits.find((item) => item.editId === operation.editId);
        if (!operation || !edit || !this.claimMatches(operation, token) || operation.providerDispatchState !== "not_started") return;
        const previousOperation = operation.status;
        const previousEdit = edit.status;
        operation.status = "queued";
        operation.startedAt = null;
        operation.completedAt = null;
        operation.failureCode = null;
        clearClaim(operation);
        edit.status = "image_queued";
        edit.retryState = "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = null;
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
          generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
          editId: edit.editId, operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "image", attempt: operation.attempt, from: previousOperation, to: "queued", reason: null,
          priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: operation.baseSelectionVersion,
          resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "edit", attempt: operation.attempt, from: previousEdit, to: "image_queued", reason: null,
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
      });
    } catch {
      // Keep the unmarked claim conservative if the requeue transaction itself fails.
    }
  }

  private requeueAssessmentBeforeDispatch(assessmentAttemptId: UUID, token: UUID): void {
    try {
      this.repository.transact((state) => {
        const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
        const assessment = attempt && state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
        const edit = attempt && state.s4Edits.find((item) => item.editId === attempt.editId);
        if (!attempt || !assessment || !edit || !this.claimMatches(attempt, token) || attempt.providerDispatchState !== "not_started") return;
        const previousAttempt = attempt.status;
        const previousAssessment = assessment.status;
        const previousEdit = edit.status;
        attempt.status = "queued";
        attempt.disposition = "pending";
        attempt.startedAt = null;
        attempt.completedAt = null;
        attempt.failureCode = null;
        clearClaim(attempt);
        assessment.status = "pending";
        assessment.retryState = "none";
        assessment.retryWaivedReason = null;
        assessment.updatedAt = this.clock();
        edit.status = "assessment_pending";
        edit.retryState = "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = null;
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: attempt.projectId,
          generationSetId: attempt.generationSetId, selectionStateId: attempt.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
          from: previousAttempt, to: "queued", reason: null,
          priorRevisionId: attempt.revisionId, resultingRevisionId: attempt.revisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId, phase: "edit", attempt: attempt.attempt,
          from: previousEdit, to: "assessment_pending", reason: null,
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: assessment.projectId,
          generationSetId: assessment.generationSetId, selectionStateId: assessment.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
          from: previousAssessment, to: "pending", reason: null,
          priorRevisionId: attempt.revisionId, resultingRevisionId: attempt.revisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
      });
    } catch {
      // Keep the unmarked claim conservative if the requeue transaction itself fails.
    }
  }

  private claimMatches(operation: {
    status: string;
    claimedBy: string | null;
    claimedProcessId: number | null;
    claimToken: UUID | null;
  }, token: UUID): boolean {
    return operation.status === "running" &&
      operation.claimedBy === this.workerId &&
      operation.claimedProcessId === this.processId &&
      operation.claimToken === token;
  }

  private claimImage(operationId: UUID): { operation: S4ImageOperation; token: UUID } | null {
    return this.repository.transact((state) => {
      const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
      const edit = operation ? state.s4Edits.find((item) => item.editId === operation.editId) : undefined;
      if (!operation || !edit || operation.status !== "queued" || edit.status !== "image_queued") return null;
      const token = this.uuid();
      operation.status = "running";
      operation.claimedBy = this.workerId;
      operation.claimedProcessId = this.processId;
      operation.claimToken = token;
      operation.claimedAt = this.clock();
      operation.startedAt = this.clock();
      const previous = edit.status;
      edit.status = "image_running";
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
        generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
        editId: edit.editId, operationId, publicationId: null, preservationCheckId: null,
        assessmentId: null, assessmentAttemptId: null, phase: "edit", attempt: operation.attempt,
        from: previous, to: "image_running", reason: "image_started",
        priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
        expectedSelectionVersion: operation.baseSelectionVersion,
        resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
        generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
        editId: edit.editId, operationId, publicationId: null, preservationCheckId: null,
        assessmentId: null, assessmentAttemptId: null, phase: "image", attempt: operation.attempt,
        from: "queued", to: "running", reason: "image_started",
        priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
        expectedSelectionVersion: operation.baseSelectionVersion,
        resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
      });
      return { operation: cloneJson(operation), token };
    });
  }

  private readRevisionBytes(state: StoreState, revisionId: UUID, revisionKind: "s3" | "s4", assetId: UUID, expectedSha: string, expectedBytes: number): Buffer {
    let key: string | null = null;
    if (revisionKind === "s4") {
      key = state.s4Assets.find((item) => item.assetId === assetId)?.storageKeyNormalized ?? null;
    } else {
      const revision = state.s3Revisions.find((item) => item.revisionId === revisionId);
      if (revision?.kind === "source_selection") {
        key = state.s3Sources.find((item) => item.sourceSnapshotId === revision.sourceSnapshotId)?.selectedStorageKey ?? null;
      } else {
        key = state.s3Assets.find((item) => item.assetId === assetId)?.storageKeyNormalized ?? null;
      }
    }
    if (!key) throw fail(500, "S4_INTERNAL_ERROR");
    return objectIdentity(this.objects, key, expectedSha, expectedBytes);
  }

  private imageDispatchInput(state: StoreState, operation: S4ImageOperation): {
    input: S4ImageProviderInput;
    edit: S4EditAdmission;
    mask: S4MaskRecord;
    compilation: S4EditCompilation;
  } {
    const edit = state.s4Edits.find((item) => item.editId === operation.editId);
    const mask = edit && state.s4Masks.find((item) => item.maskId === edit.maskId);
    const selection = state.s3Selections.find((item) => item.selectionStateId === operation.selectionStateId);
    if (!edit || !mask || !selection || edit.maskMaterializationStatus !== "ready" ||
        operation.baseRevisionId !== edit.baseRevisionId ||
        operation.baseSelectionVersion !== edit.baseSelectionVersion ||
        selection.selectionVersion !== operation.baseSelectionVersion ||
        selection.activeRevisionId !== operation.baseRevisionId) throw fail(409, "S4_FENCE_STALE");
    if (state.s4ImageOperations.filter((item) => dispatchInLineage(state, item, {
      projectId: operation.projectId,
      generationSetId: operation.generationSetId,
      selectionStateId: operation.selectionStateId,
      lineageRootRevisionId: edit.lineageRootRevisionId,
    })).length >= 4) throw fail(409, "S4_FENCE_STALE");
    let resolved: ResolvedVisualRevision;
    try { resolved = resolveVisualRevision(state, operation.projectId, operation.baseRevisionId, this.objects); }
    catch { throw fail(409, "S4_FENCE_STALE"); }
    if (resolved.kind !== edit.baseRevisionKind || resolved.sourceSnapshotId !== edit.sourceSnapshotId ||
        resolved.lineageRootRevisionId !== edit.lineageRootRevisionId ||
        resolved.assetId !== mask.sourceAssetId) throw fail(409, "S4_FENCE_STALE");
    const source = state.s3Sources.find((item) =>
      item.projectId === operation.projectId && item.sourceSnapshotId === resolved.sourceSnapshotId);
    const inputVersion = source && state.s2Inputs.find((item) =>
      item.projectId === operation.projectId && item.id === source.s2InputVersionId);
    if (!source || !inputVersion) throw fail(409, "S4_FENCE_STALE");
    const materialized = materializeS4Mask(mask.primitives);
    if (materialized.maskIdentityHash !== mask.maskIdentityHash ||
        materialized.rasterSha256 !== mask.rasterSha256 ||
        materialized.providerPngSha256 !== mask.providerPngSha256) throw fail(409, "S4_FENCE_STALE");
    const objects = this.verifyMaskObject(mask);
    const compilation = this.editCompilation(
      state, operation.projectId, selection, resolved, source, inputVersion,
      edit.cycleNumber, edit.instructionText, materialized,
    );
    if (compilation.editInputHash !== operation.editInputHash ||
        compilation.promptHash !== operation.promptHash ||
        compilation.providerRequestHash !== operation.providerRequestHash) throw fail(409, "S4_FENCE_STALE");
    const sourceBytes = this.readRevisionBytes(
      state, resolved.revisionId, resolved.kind, resolved.assetId, resolved.sha256, resolved.byteSize,
    );
    if (sourceBytes.byteLength !== resolved.byteSize) throw fail(409, "S4_FENCE_STALE");
    return {
      input: { promptText: compilation.promptText, sourceBytes, maskBytes: objects.providerPng },
      edit, mask, compilation,
    };
  }

  private beginImageDispatch(operationId: UUID, token: UUID): S4ImageOperation | null {
    return this.repository.transact((state) => {
      const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
      if (!operation || !this.claimMatches(operation, token) || operation.providerDispatchState !== "not_started") return null;
      const edit = state.s4Edits.find((item) => item.editId === operation.editId);
      if (!edit) return null;
      if (state.s4ImageOperations.filter((item) => dispatchInLineage(state, item, {
        projectId: operation.projectId,
        generationSetId: operation.generationSetId,
        selectionStateId: operation.selectionStateId,
        lineageRootRevisionId: edit.lineageRootRevisionId,
      })).length >= 4) {
        operation.status = "failed";
        operation.failureCode = "S4_FENCE_STALE";
        operation.completedAt = this.clock();
        clearClaim(operation);
        edit.status = "image_failed";
        edit.retryState = "none";
        edit.terminalAt = this.clock();
        edit.updatedAt = this.clock();
        return null;
      }
      operation.providerDispatchState = "may_have_started";
      return cloneJson(operation);
    });
  }

  private markImageConsumed(operationId: UUID, token: UUID, metadata: S4ImageProviderMetadata): boolean {
    return this.repository.transact((state) => {
      const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
      if (!operation || !this.claimMatches(operation, token)) return false;
      operation.providerDispatchState = "consumed";
      operation.providerMetadata = cloneJson(metadata);
      return true;
    });
  }

  private imageMetadata(result: S4ImageProviderResult): S4ImageProviderMetadata {
    return {
      provider: "openai",
      api: "images",
      model: "gpt-image-2",
      modelSnapshot: "gpt-image-2-2026-04-21",
      providerRequestId: result.providerRequestId,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      receivedAt: this.clock(),
    };
  }

  private createPublicationIntent(
    operationId: UUID,
    token: UUID,
    inspected: Awaited<ReturnType<typeof inspectExactS3Png>>,
  ): S4Publication | null {
    return this.repository.transact((state) => {
      const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
      const edit = operation ? state.s4Edits.find((item) => item.editId === operation.editId) : undefined;
      if (!operation || !edit || !this.claimMatches(operation, token) ||
          operation.providerDispatchState !== "consumed") return null;
      if (operation.publicationId !== null) {
        return state.s4Publications.find((item) => item.publicationId === operation.publicationId) ?? null;
      }
      const publicationId = this.uuid();
      const intendedAssetId = this.uuid();
      const intendedRevisionId = this.uuid();
      const intendedPreservationCheckId = this.uuid();
      const intendedAssessmentId = this.uuid();
      const stagingKey = privateStorageKey(
        "projects", edit.projectId, "s4", "staging", edit.editId, operation.operationId, "output.png",
      );
      const finalKey = privateStorageKey(
        "projects", edit.projectId, "s4", "edits", edit.editId, "revisions", intendedRevisionId, "normalized.png",
      );
      const publication: S4Publication = {
        publicationId,
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId,
        editId: edit.editId,
        operationId,
        inputHash: operation.operationInputHash,
        providerOutputSha256: inspected.sha256,
        providerOutputBytes: inspected.byteSize,
        normalizedSha256: inspected.sha256,
        normalizedBytes: inspected.byteSize,
        width: 1536,
        height: 1024,
        pixelCount: 1_572_864,
        intendedAssetId,
        intendedRevisionId,
        intendedPreservationCheckId,
        intendedAssessmentId,
        stagingObjects: [{ key: stagingKey, sha256: inspected.sha256, byteSize: inspected.byteSize }],
        finalObjects: [{ key: finalKey, sha256: inspected.sha256, byteSize: inspected.byteSize }],
        ownerProcessId: this.processId,
        ownerClaimToken: this.uuid(),
        ownerClaimedAt: this.clock(),
        state: "staged",
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      state.s4Publications.push(publication);
      operation.publicationId = publicationId;
      edit.status = "publication_pending";
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
        generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
        editId: edit.editId, operationId, publicationId,
        preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
         phase: "publication", attempt: operation.attempt, from: null, to: "publication_pending",
        reason: "publication_started", priorRevisionId: edit.baseRevisionId,
        resultingRevisionId: publication.intendedRevisionId,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion,
        requestReferenceId: operation.requestReferenceId,
      });
      return cloneJson(publication);
    });
  }

  private commitPublication(publicationId: UUID, token: UUID): { preservationCheckId: UUID; assessmentId: UUID } | null {
    return this.repository.transact((state) => {
      const publication = state.s4Publications.find((item) => item.publicationId === publicationId);
      const operation = publication && state.s4ImageOperations.find((item) => item.operationId === publication.operationId);
      const edit = publication && state.s4Edits.find((item) => item.editId === publication.editId);
      const mask = edit && state.s4Masks.find((item) => item.maskId === edit.maskId);
      if (!publication || !operation || !edit || !mask || publication.state === "committed") return null;
      if (publication.state !== "staged" && publication.state !== "promoted") return null;
      if (!this.claimMatches(operation, token) || operation.providerDispatchState !== "consumed") return null;
      const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
      if (!selection || selection.selectionVersion !== edit.baseSelectionVersion ||
          selection.activeRevisionId !== edit.baseRevisionId) throw fail(409, "S4_FENCE_STALE");
      let resolved: ResolvedVisualRevision;
      try { resolved = resolveVisualRevision(state, edit.projectId, edit.baseRevisionId, this.objects); }
      catch { throw fail(409, "S4_FENCE_STALE"); }
      if (resolved.kind !== edit.baseRevisionKind || resolved.assetId !== mask.sourceAssetId ||
          resolved.sourceSnapshotId !== edit.sourceSnapshotId ||
          resolved.lineageRootRevisionId !== edit.lineageRootRevisionId) throw fail(409, "S4_FENCE_STALE");
      const source = state.s3Sources.find((item) =>
        item.projectId === edit.projectId && item.sourceSnapshotId === edit.sourceSnapshotId);
      const input = source && state.s2Inputs.find((item) =>
        item.projectId === edit.projectId && item.id === source.s2InputVersionId);
      if (!source || !input) throw fail(409, "S4_SOURCE_INTEGRITY_MISMATCH");
      const materialized = materializeS4Mask(mask.primitives);
      const compilation = this.editCompilation(
        state, edit.projectId, selection, resolved, source, input, edit.cycleNumber,
        edit.instructionText, materialized,
      );
      if (compilation.editInputHash !== edit.editInputHash ||
          compilation.promptHash !== edit.promptHash ||
          compilation.providerRequestHash !== edit.providerRequestHash) throw fail(409, "S4_FENCE_STALE");
      const finalObject = publication.finalObjects[0];
      this.verifyPublicationObject(finalObject);
      const asset: S4GeneratedAsset = {
        assetId: publication.intendedAssetId,
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        revisionId: publication.intendedRevisionId,
        mediaProfile: "s2-media-v1",
        providerOutputSha256: publication.providerOutputSha256,
        providerOutputBytes: publication.providerOutputBytes,
        detectedMime: "image/png",
        normalizedSha256: publication.normalizedSha256,
        normalizedBytes: publication.normalizedBytes,
        width: 1536,
        height: 1024,
        pixelCount: 1_572_864,
        hasAlpha: true,
        storageKeyNormalized: finalObject.key,
        createdAt: this.clock(),
      };
      const revision: S4LocalEditRevision = {
        revisionId: publication.intendedRevisionId,
        kind: "s4_local_edit",
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId,
        sourceSnapshotId: edit.sourceSnapshotId,
        lineageRootRevisionId: edit.lineageRootRevisionId,
        parentRevisionId: edit.baseRevisionId,
        parentRevisionKind: edit.baseRevisionKind,
        cycleNumber: edit.cycleNumber,
        editId: edit.editId,
        maskId: mask.maskId,
        maskIdentityHash: mask.maskIdentityHash,
        instructionText: edit.instructionText,
        instructionHash: edit.instructionHash,
        compilerVersion: "s4-local-edit-v1",
        editInputHash: edit.editInputHash,
        promptHash: edit.promptHash,
        providerRequestHash: edit.providerRequestHash,
        sourceQuality: compilation.canonicalInput.sourceQuality,
        sourceAssetId: resolved.assetId,
        sourceSha256: resolved.sha256,
        sourceByteSize: resolved.byteSize,
        sourceWidth: 1536,
        sourceHeight: 1024,
        sourcePixelCount: 1_572_864,
        outputAssetId: asset.assetId,
        outputSha256: asset.normalizedSha256,
        outputByteSize: asset.normalizedBytes,
        outputWidth: 1536,
        outputHeight: 1024,
        outputPixelCount: 1_572_864,
        outputMediaProfile: "s2-media-v1",
        preservationCheckId: publication.intendedPreservationCheckId,
        assessmentId: publication.intendedAssessmentId,
        createdAt: this.clock(),
      };
      const check: S4PreservationCheck = {
        preservationCheckId: publication.intendedPreservationCheckId,
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId,
        editId: edit.editId,
        revisionId: revision.revisionId,
        sourceRevisionId: edit.baseRevisionId,
        sourceAssetId: resolved.assetId,
        sourceSha256: resolved.sha256,
        outputAssetId: asset.assetId,
        outputSha256: asset.normalizedSha256,
        maskId: mask.maskId,
        maskIdentityHash: mask.maskIdentityHash,
        decoderProfile: "s4-rgba-v1",
        width: 1536,
        height: 1024,
        pixelCount: 1_572_864,
        guardRadiusPx: 6,
        rgbChannelTolerance: 8,
        alphaTolerance: 8,
        comparisonPixelMinimum: 65_536,
        comparedPixelCount: 0,
        differingPixelCount: 0,
        rgbDifferingPixelCount: 0,
        alphaDifferingPixelCount: 0,
        maxRgbDelta: 0,
        maxAlphaDelta: 0,
        aggregateDelta: 0,
        meanAggregateDeltaQ16: 0,
        componentCount: 0,
        largestComponentPixelCount: 0,
        severity: "none",
        noOpDetected: null,
        status: "pending",
        failureCode: null,
        evidenceObject: null,
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        createdAt: this.clock(),
        startedAt: null,
        completedAt: null,
      };
      const assessment: S4Assessment = {
        assessmentId: publication.intendedAssessmentId,
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId,
        editId: edit.editId,
        revisionId: revision.revisionId,
        sourceRevisionId: edit.baseRevisionId,
        outputAssetId: asset.assetId,
        sourceSha256: resolved.sha256,
        outputSha256: asset.normalizedSha256,
        maskId: mask.maskId,
        maskIdentityHash: mask.maskIdentityHash,
        instructionHash: edit.instructionHash,
        sourceQuality: compilation.canonicalInput.sourceQuality,
        confirmedBriefVersionId: compilation.canonicalInput.confirmedBriefVersionId,
        confirmedBriefContentHash: compilation.canonicalInput.confirmedBriefContentHash,
        geometrySnapshot: cloneJson(compilation.canonicalInput.geometrySnapshot),
        geometryHash: compilation.canonicalInput.geometryHash,
        canonicalRequirements: cloneJson(compilation.canonicalInput.canonicalRequirements),
        requirementHash: compilation.canonicalInput.requirementHash,
        designRulesVersion: "s2-design-rules-v1",
        designRuleSnapshot: cloneJson(compilation.canonicalInput.designRuleSnapshot),
        designRuleSnapshotHash: compilation.canonicalInput.designRuleSnapshotHash,
        assessmentCompilerVersion: "s4-assessment-v1",
        assessmentSchema: "s4-assessment-v1",
        assessmentSchemaName: "s4_local_edit_assessment_v1",
        assessmentInputHash: "",
        assessmentPromptHash: "",
        attemptIds: [],
        latestAttemptId: null,
        noOpDetected: false,
        requestedEditSatisfaction: null,
        overallRequirementResult: null,
        overallBuildabilityResult: null,
        status: "not_started",
        retryState: "none",
        retryWaivedReason: null,
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      const assessmentCompilation = compileS4Assessment({
        projectId: edit.projectId,
        generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId,
        editId: edit.editId,
        revisionId: revision.revisionId,
        sourceRevisionId: edit.baseRevisionId,
        sourceRevisionKind: edit.baseRevisionKind,
        sourceAssetId: resolved.assetId,
        sourceSha256: resolved.sha256,
        sourceByteSize: resolved.byteSize,
        sourceWidth: 1536,
        sourceHeight: 1024,
        sourcePixelCount: 1_572_864,
        editedAssetId: asset.assetId,
        editedSha256: asset.normalizedSha256,
        editedByteSize: asset.normalizedBytes,
        editedWidth: 1536,
        editedHeight: 1024,
        editedPixelCount: 1_572_864,
        mask: {
          maskIdentityHash: mask.maskIdentityHash,
          primitiveHash: mask.primitiveHash,
          rasterSha256: mask.rasterSha256,
          providerPngSha256: mask.providerPngSha256,
          editablePixelCount: mask.editablePixelCount,
          comparisonPixelCount: mask.comparisonPixelCount,
          polarity: "transparent-editable-opaque-protected",
        },
        instructionText: edit.instructionText,
        instructionHash: edit.instructionHash,
        sourceQuality: compilation.canonicalInput.sourceQuality,
        confirmedBriefVersionId: compilation.canonicalInput.confirmedBriefVersionId,
        confirmedBriefContentHash: compilation.canonicalInput.confirmedBriefContentHash,
        geometrySnapshot: cloneJson(compilation.canonicalInput.geometrySnapshot),
        geometryHash: compilation.canonicalInput.geometryHash,
        canonicalRequirements: cloneJson(compilation.canonicalInput.canonicalRequirements),
        requirementHash: compilation.canonicalInput.requirementHash,
        designRulesVersion: "s2-design-rules-v1",
        designRuleSnapshot: cloneJson(compilation.canonicalInput.designRuleSnapshot),
        designRuleSnapshotHash: compilation.canonicalInput.designRuleSnapshotHash,
        preservationCheckId: check.preservationCheckId,
        preservationStatus: "PASS",
        noOpDetected: false,
      });
      assessment.assessmentInputHash = assessmentCompilation.assessmentInputHash;
      assessment.assessmentPromptHash = assessmentCompilation.assessmentPromptHash;
      state.s4Assets.push(asset);
      state.s4Revisions.push(revision);
      state.s4PreservationChecks.push(check);
      state.s4Assessments.push(assessment);
      operation.status = "succeeded";
      operation.completedAt = this.clock();
      operation.outputRevisionId = revision.revisionId;
      operation.outputAssetId = asset.assetId;
      clearClaim(operation);
      edit.outputRevisionId = revision.revisionId;
      edit.preservationCheckId = check.preservationCheckId;
      edit.assessmentId = assessment.assessmentId;
      edit.status = "preservation_pending";
      edit.updatedAt = this.clock();
      publication.state = "committed";
      publication.ownerProcessId = null;
      publication.ownerClaimToken = null;
      publication.ownerClaimedAt = null;
      publication.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
        generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
         editId: edit.editId, operationId: operation.operationId, publicationId, preservationCheckId: check.preservationCheckId,
        assessmentId: assessment.assessmentId, assessmentAttemptId: null, phase: "publication",
         attempt: operation.attempt, from: "publication_pending", to: "completed", reason: "publication_committed",
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: revision.revisionId,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
        generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
         editId: edit.editId, operationId: operation.operationId, publicationId, preservationCheckId: check.preservationCheckId,
        assessmentId: assessment.assessmentId, assessmentAttemptId: null, phase: "image",
        attempt: operation.attempt, from: "running", to: "succeeded", reason: "image_succeeded",
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: revision.revisionId,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
        generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
         editId: edit.editId, operationId: operation.operationId, publicationId, preservationCheckId: check.preservationCheckId,
        assessmentId: assessment.assessmentId, assessmentAttemptId: null, phase: "preservation",
        attempt: null, from: null, to: "pending", reason: null,
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: revision.revisionId,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
      });
      return { preservationCheckId: check.preservationCheckId, assessmentId: assessment.assessmentId };
    });
  }

  private failImageOperation(operationId: UUID, token: UUID, error: unknown): void {
    try {
      this.repository.transact((state) => {
        const operation = state.s4ImageOperations.find((item) => item.operationId === operationId);
        const edit = operation && state.s4Edits.find((item) => item.editId === operation.editId);
        if (!operation || !edit || !this.claimMatches(operation, token)) return;
        const code = failureCode(error);
        const ambiguous = operation.providerDispatchState === "may_have_started" &&
          (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE" || error instanceof ProcessInterruption);
        if (ambiguous) {
          operation.failureCode = "PROVIDER_DISPATCH_UNCERTAIN";
          operation.status = "failed";
          operation.completedAt = this.clock();
          clearClaim(operation);
          edit.status = "image_failed";
          edit.retryState = "none";
          edit.retryWaivedReason = null;
          edit.terminalAt = this.clock();
          edit.updatedAt = this.clock();
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
            generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
            editId: edit.editId, operationId, publicationId: operation.publicationId,
            preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
            phase: "image", attempt: operation.attempt, from: "running", to: "failed",
            reason: "image_failed", priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
            expectedSelectionVersion: edit.baseSelectionVersion,
            resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
          });
          return;
        }
        const retryable = operation.attempt === 1 && operation.providerDispatchState === "consumed" && S4_IMAGE_RETRYABLE.has(code);
        operation.status = "failed";
        operation.failureCode = code;
        operation.completedAt = this.clock();
        clearClaim(operation);
        if (operation.publicationId) {
          const publication = state.s4Publications.find((item) => item.publicationId === operation.publicationId);
          if (publication && publication.state !== "committed") {
            publication.state = "aborted";
            publication.ownerProcessId = null;
            publication.ownerClaimToken = null;
            publication.ownerClaimedAt = null;
            publication.updatedAt = this.clock();
          }
        }
        const previous = edit.status;
        edit.status = retryable ? "image_retry_available" : code === "PUBLICATION_FAILED" || code === "PUBLICATION_OBJECT_MISMATCH"
          ? "publication_failed" : "image_failed";
        edit.retryState = retryable ? "image_available" : "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = retryable ? null : this.clock();
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "edit", attempt: operation.attempt, from: previous,
          to: edit.status, reason: retryable ? "image_failed" : code === "S4_FENCE_STALE" ? "fence_stale" : "image_failed",
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "image", attempt: operation.attempt, from: "running", to: "failed",
          reason: retryable ? "image_failed" : "image_failed", priorRevisionId: edit.baseRevisionId,
          resultingRevisionId: null, expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
      });
    } catch {
      // A durable claim is conservative until a later restart classifies it.
    }
  }

  private async runImage(operationId: UUID): Promise<void> {
    const claim = this.claimImage(operationId);
    if (!claim) return;
    try {
      const initial = this.state();
      const dispatch = this.imageDispatchInput(initial, claim.operation);
      await this.notifyDispatch("before-dispatch", claim.operation);
      try {
        this.assertImageDispatchReady();
      } catch {
        this.requeueImageBeforeDispatch(operationId, claim.token);
        return;
      }
      const marked = this.beginImageDispatch(operationId, claim.token);
      if (!marked) return;
      await this.notifyDispatch("after-dispatch-marked", marked);
      let response: S4ImageProviderResult;
      try {
        if (!this.provider.runS4ImageEdit) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
        response = await this.provider.runS4ImageEdit(dispatch.input);
      } catch (error) {
        if (error instanceof ProcessInterruption) throw error;
        const code = failureCode(error);
        if (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE") throw error;
        const metadata: S4ImageProviderMetadata = {
          provider: "openai", api: "images", model: "gpt-image-2",
          modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null,
          inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: this.clock(),
        };
        if (this.markImageConsumed(operationId, claim.token, metadata)) this.failImageOperation(operationId, claim.token, error);
        return;
      }
      const metadata = this.imageMetadata(response);
      if (!this.markImageConsumed(operationId, claim.token, metadata)) return;
      let inspected: Awaited<ReturnType<typeof inspectExactS3Png>>;
      try { inspected = await inspectExactS3Png(response.pngBytes); }
      catch (error) {
        this.failImageOperation(operationId, claim.token, error);
        return;
      }
      const publication = this.createPublicationIntent(operationId, claim.token, inspected);
      if (!publication) return;
      await this.notifyPublication("before-publication-intent", publication);
      await this.notifyPublication("after-publication-intent", publication);
      this.putPublicationObject(publication.stagingObjects[0], Buffer.from(response.pngBytes));
      await this.notifyPublication("after-publication-staged", publication);
      this.promotePublicationObject(
        publication.stagingObjects[0],
        publication.finalObjects[0],
        Buffer.from(response.pngBytes),
      );
      await this.notifyPublication("after-final-promotion", publication);
      const committed = this.commitPublication(publication.publicationId, claim.token);
      this.objects.remove(publication.stagingObjects[0].key);
      if (committed) this.startPreservation(committed.preservationCheckId);
    } catch (error) {
      if (error instanceof ProcessInterruption) return;
      this.failImageOperation(operationId, claim.token, error);
    }
  }

  private startImageOperation(operationId: UUID): void {
    const key = "s4-image:" + operationId;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.runImage(operationId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  private objectMatches(object: { key: string; sha256: string; byteSize: number }): boolean {
    try {
      const bytes = this.objects.read(object.key);
      return bytes.byteLength === object.byteSize && sha256(bytes) === object.sha256;
    } catch {
      return false;
    }
  }

  private publicationObjectState(
    object: { key: string; sha256: string; byteSize: number },
    expectedBytes?: Uint8Array,
  ): "exact" | "mismatch" | "missing" | "unavailable" {
    if (!this.objects.exists(object.key)) return "missing";
    let actual: Buffer;
    try { actual = this.objects.read(object.key); } catch { return "unavailable"; }
    if (actual.byteLength !== object.byteSize || sha256(actual) !== object.sha256) return "mismatch";
    if (expectedBytes !== undefined && !actual.equals(Buffer.from(expectedBytes))) return "mismatch";
    return "exact";
  }

  private verifyPublicationObject(object: { key: string; sha256: string; byteSize: number }): void {
    const state = this.publicationObjectState(object);
    if (state === "mismatch") throw fail(500, "PUBLICATION_OBJECT_MISMATCH");
    if (state !== "exact") throw fail(500, "PUBLICATION_FAILED");
  }

  private putPublicationObject(
    object: { key: string; sha256: string; byteSize: number },
    bytes: Uint8Array,
  ): void {
    if (this.objects.exists(object.key)) {
      this.verifyPublicationObject(object);
      return;
    }
    try {
      this.objects.putExact(object.key, bytes);
    } catch {
      throw fail(500, "PUBLICATION_FAILED");
    }
    this.verifyPublicationObject(object);
  }

  private promotePublicationObject(
    staging: { key: string; sha256: string; byteSize: number },
    final: { key: string; sha256: string; byteSize: number },
    bytes: Uint8Array,
  ): void {
    const before = this.publicationObjectState(final, bytes);
    if (before === "exact") return;
    if (before === "mismatch") throw fail(500, "PUBLICATION_OBJECT_MISMATCH");
    if (before === "unavailable") throw fail(500, "PUBLICATION_FAILED");
    try {
      this.objects.promoteExact(staging.key, final.key, bytes);
    } catch {
      const afterFailure = this.publicationObjectState(final, bytes);
      if (afterFailure === "exact") return;
      if (afterFailure === "mismatch") throw fail(500, "PUBLICATION_OBJECT_MISMATCH");
      throw fail(500, "PUBLICATION_FAILED");
    }
    const afterPromotion = this.publicationObjectState(final, bytes);
    if (afterPromotion === "exact") return;
    if (afterPromotion === "mismatch") throw fail(500, "PUBLICATION_OBJECT_MISMATCH");
    throw fail(500, "PUBLICATION_FAILED");
  }

  private claimPreservation(preservationCheckId: UUID): { check: S4PreservationCheck; token: UUID } | null {
    return this.repository.transact((state) => {
      const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheckId);
      const edit = check && state.s4Edits.find((item) => item.editId === check.editId);
      if (!check || !edit || check.status !== "pending") return null;
      const token = this.uuid();
      check.status = "running";
      check.claimedBy = this.workerId;
      check.claimedProcessId = this.processId;
      check.claimToken = token;
      check.claimedAt = this.clock();
      check.startedAt = this.clock();
      const previous = edit.status;
      edit.status = "preservation_running";
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
        generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
        editId: check.editId, operationId: null, publicationId: null,
        preservationCheckId, assessmentId: edit.assessmentId, assessmentAttemptId: null,
        phase: "preservation", attempt: null, from: "pending", to: "running",
        reason: "preservation_started", priorRevisionId: check.sourceRevisionId,
        resultingRevisionId: check.revisionId, expectedSelectionVersion: null,
        resultingSelectionVersion: null, requestReferenceId: this.uuid(),
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
        generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
        editId: check.editId, operationId: null, publicationId: null,
        preservationCheckId, assessmentId: edit.assessmentId, assessmentAttemptId: null,
        phase: "edit", attempt: null, from: previous, to: "preservation_running",
        reason: "preservation_started", priorRevisionId: check.sourceRevisionId,
        resultingRevisionId: check.revisionId, expectedSelectionVersion: null,
        resultingSelectionVersion: null, requestReferenceId: this.uuid(),
      });
      return { check: cloneJson(check), token };
    });
  }

  private preservationInputs(state: StoreState, check: S4PreservationCheck): {
    sourceBytes: Buffer;
    outputBytes: Buffer;
    maskRaster: Buffer;
  } {
    const edit = state.s4Edits.find((item) => item.editId === check.editId);
    const revision = state.s4Revisions.find((item) => item.revisionId === check.revisionId);
    const mask = state.s4Masks.find((item) => item.maskId === check.maskId);
    const asset = state.s4Assets.find((item) => item.assetId === check.outputAssetId);
    if (!edit || !revision || !mask || !asset) throw fail(500, "S4_INTERNAL_ERROR");
    const sourceBytes = this.readRevisionBytes(
      state, check.sourceRevisionId, edit.baseRevisionKind,
      check.sourceAssetId, check.sourceSha256, revision.sourceByteSize,
    );
    const outputBytes = objectIdentity(this.objects, asset.storageKeyNormalized, check.outputSha256, asset.normalizedBytes);
    const maskRaster = objectIdentity(this.objects, mask.rasterStorageKey, mask.rasterSha256, mask.rasterBytes);
    return { sourceBytes, outputBytes, maskRaster };
  }

  private assessmentAttempt(
    state: StoreState,
    assessment: S4Assessment,
    edit: S4EditAdmission,
    attemptId: UUID,
    requestReferenceId: UUID,
  ): S4AssessmentAttempt {
    const operationInputHash = canonicalHash({
      schemaVersion: "s4-assessment-operation-v1",
      projectId: assessment.projectId,
      generationSetId: assessment.generationSetId,
      selectionStateId: assessment.selectionStateId,
      editId: edit.editId,
      revisionId: assessment.revisionId,
      sourceRevisionId: assessment.sourceRevisionId,
      outputAssetId: assessment.outputAssetId,
      sourceSha256: assessment.sourceSha256,
      outputSha256: assessment.outputSha256,
      maskIdentityHash: assessment.maskIdentityHash,
      instructionHash: assessment.instructionHash,
      assessmentInputHash: assessment.assessmentInputHash,
      assessmentPromptHash: assessment.assessmentPromptHash,
      attempt: 1,
    });
    return {
      assessmentAttemptId: attemptId,
      assessmentId: assessment.assessmentId,
      projectId: assessment.projectId,
      generationSetId: assessment.generationSetId,
      selectionStateId: assessment.selectionStateId,
      editId: edit.editId,
      revisionId: assessment.revisionId,
      outputAssetId: assessment.outputAssetId,
      sourceSha256: assessment.sourceSha256,
      outputSha256: assessment.outputSha256,
      maskIdentityHash: assessment.maskIdentityHash,
      instructionHash: assessment.instructionHash,
      assessmentInputHash: assessment.assessmentInputHash,
      assessmentPromptHash: assessment.assessmentPromptHash,
      assessmentCompilerVersion: "s4-assessment-v1",
      assessmentSchema: "s4-assessment-v1",
      assessmentSchemaName: "s4_local_edit_assessment_v1",
      operationInputHash,
      attempt: 1,
      retryOfAttemptId: null,
      requestReferenceId,
      status: "queued",
      disposition: "pending",
      claimedBy: null,
      claimedProcessId: null,
      claimToken: null,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      providerDispatchState: "not_started",
      requirementObservations: [],
      designObservations: [],
      requestedEditSatisfaction: null,
      overallRequirementResult: null,
      overallBuildabilityResult: null,
      materialFindingIds: [],
      warningFindingIds: [],
      uncertainFindingIds: [],
      failureCode: null,
      providerMetadata: null,
      evidenceObject: null,
      createdAt: this.clock(),
    };
  }

  private completePreservation(
    preservationCheckId: UUID,
    token: UUID,
    run: S4PreservationRun,
  ): UUID | null {
    return this.repository.transact((state) => {
      const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheckId);
      const edit = check && state.s4Edits.find((item) => item.editId === check.editId);
      const assessment = edit?.assessmentId
        ? state.s4Assessments.find((item) => item.assessmentId === edit.assessmentId)
        : undefined;
      if (!check || !edit || !assessment ||
          check.status !== "running" || check.claimToken !== token ||
          check.claimedBy !== this.workerId || check.claimedProcessId !== this.processId) return null;
      check.comparedPixelCount = run.comparedPixelCount;
      check.differingPixelCount = run.differingPixelCount;
      check.rgbDifferingPixelCount = run.rgbDifferingPixelCount;
      check.alphaDifferingPixelCount = run.alphaDifferingPixelCount;
      check.maxRgbDelta = run.maxRgbDelta;
      check.maxAlphaDelta = run.maxAlphaDelta;
      check.aggregateDelta = run.aggregateDelta;
      check.meanAggregateDeltaQ16 = run.meanAggregateDeltaQ16;
      check.componentCount = run.componentCount;
      check.largestComponentPixelCount = run.largestComponentPixelCount;
      check.severity = run.severity;
      check.noOpDetected = run.noOpDetected;
      check.status = run.status;
      check.failureCode = run.failureCode;
      check.completedAt = this.clock();
      clearClaim(check);
      const evidenceKey = privateStorageKey(
        "projects", check.projectId, "s4", "edits", edit.editId,
        "revisions", check.revisionId, "preservation", check.preservationCheckId, "evidence.json",
      );
      if (!this.objectMatches({ key: evidenceKey, sha256: sha256(run.evidenceBytes), byteSize: run.evidenceBytes.byteLength })) {
        throw fail(500, "S4_INTERNAL_ERROR");
      }
      check.evidenceObject = {
        key: evidenceKey,
        sha256: sha256(run.evidenceBytes),
        byteSize: run.evidenceBytes.byteLength,
      };
      const requestReferenceId = state.s4ImageOperations.find((item) =>
        item.editId === edit.editId && item.attempt === 1)?.requestReferenceId ?? this.uuid();
      const previousEditStatus = edit.status;
      if (run.status === "PASS" && !run.noOpDetected) {
        const attemptId = this.uuid();
        const attempt = this.assessmentAttempt(state, assessment, edit, attemptId, requestReferenceId);
        state.s4AssessmentAttempts.push(attempt);
        assessment.attemptIds = [attemptId];
        assessment.latestAttemptId = attemptId;
        assessment.status = "pending";
        assessment.retryState = "none";
        assessment.updatedAt = this.clock();
        edit.assessmentAttemptIds = [attemptId];
        edit.status = "assessment_pending";
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
          generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId, assessmentId: assessment.assessmentId, assessmentAttemptId: null,
          phase: "preservation", attempt: null, from: "running", to: "PASS",
          reason: "preservation_pass", priorRevisionId: check.sourceRevisionId,
          resultingRevisionId: check.revisionId, expectedSelectionVersion: null,
          resultingSelectionVersion: null, requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
          generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId, assessmentId: assessment.assessmentId, assessmentAttemptId: attemptId,
          phase: "assessment", attempt: 1, from: null, to: "queued",
          reason: "assessment_started", priorRevisionId: check.sourceRevisionId,
          resultingRevisionId: check.revisionId, expectedSelectionVersion: null,
          resultingSelectionVersion: null, requestReferenceId,
        });
        return attemptId;
      }
      const unavailable = run.status === "QA_UNAVAILABLE";
      assessment.status = run.noOpDetected ? "material_fail" : "skipped_preservation_fail";
      assessment.retryState = "none";
      assessment.updatedAt = this.clock();
      edit.status = unavailable ? "qa_unavailable" : "material_fail";
      edit.retryState = "none";
      edit.retryWaivedReason = null;
      edit.terminalAt = this.clock();
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
        generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
        editId: edit.editId, operationId: null, publicationId: null,
        preservationCheckId, assessmentId: assessment.assessmentId, assessmentAttemptId: null,
        phase: "preservation", attempt: null, from: "running", to: run.status,
        reason: run.noOpDetected ? "no_op" : unavailable ? "preservation_unavailable" : "preservation_material_fail",
        priorRevisionId: check.sourceRevisionId, resultingRevisionId: check.revisionId,
        expectedSelectionVersion: null, resultingSelectionVersion: null, requestReferenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
        generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
        editId: edit.editId, operationId: null, publicationId: null,
        preservationCheckId, assessmentId: assessment.assessmentId, assessmentAttemptId: null,
        phase: "edit", attempt: null, from: previousEditStatus, to: edit.status,
        reason: run.noOpDetected ? "no_op" : unavailable ? "preservation_unavailable" : "preservation_material_fail",
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: edit.outputRevisionId,
        expectedSelectionVersion: null, resultingSelectionVersion: null, requestReferenceId,
      });
      return null;
    });
  }

  private async runPreservation(preservationCheckId: UUID): Promise<void> {
    const claim = this.claimPreservation(preservationCheckId);
    if (!claim) return;
    try {
      const state = this.state();
      const inputs = this.preservationInputs(state, claim.check);
      const run = await evaluateS4Preservation({
        preservationCheckId,
        editId: claim.check.editId,
        sourceBytes: inputs.sourceBytes,
        outputBytes: inputs.outputBytes,
        sourceSha256: claim.check.sourceSha256,
        outputSha256: claim.check.outputSha256,
        maskRaster: inputs.maskRaster,
        maskIdentityHash: claim.check.maskIdentityHash,
      });
      const evidenceKey = privateStorageKey(
        "projects", claim.check.projectId, "s4", "edits", claim.check.editId,
        "revisions", claim.check.revisionId, "preservation", claim.check.preservationCheckId, "evidence.json",
      );
      this.objects.putExact(evidenceKey, run.evidenceBytes);
      this.completePreservation(preservationCheckId, claim.token, run);
      const after = this.state();
      const check = after.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheckId);
      const edit = check && after.s4Edits.find((item) => item.editId === check.editId);
      if (edit?.assessmentAttemptIds.length) this.startAssessmentAttempt(edit.assessmentAttemptIds[0]);
    } catch (error) {
      this.failPreservation(preservationCheckId, claim.token, failureCode(error));
    }
  }

  private startPreservation(preservationCheckId: UUID): void {
    const key = "s4-preservation:" + preservationCheckId;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.runPreservation(preservationCheckId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  private failPreservation(preservationCheckId: UUID, token: UUID, code: S4FailureCode): void {
    try {
      this.repository.transact((state) => {
        const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheckId);
        const edit = check && state.s4Edits.find((item) => item.editId === check.editId);
        const assessment = edit?.assessmentId
          ? state.s4Assessments.find((item) => item.assessmentId === edit.assessmentId)
          : undefined;
        if (!check || !edit || !assessment || check.status !== "running" || check.claimToken !== token ||
            check.claimedBy !== this.workerId || check.claimedProcessId !== this.processId) return;
        check.status = "QA_UNAVAILABLE";
        check.failureCode = code;
        check.noOpDetected = false;
        check.completedAt = this.clock();
        clearClaim(check);
        assessment.status = "skipped_preservation_fail";
        assessment.retryState = "none";
        assessment.retryWaivedReason = null;
        assessment.updatedAt = this.clock();
        edit.status = "qa_unavailable";
        edit.retryState = "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = this.clock();
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: check.projectId,
          generationSetId: check.generationSetId, selectionStateId: check.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null, preservationCheckId,
          assessmentId: assessment.assessmentId, assessmentAttemptId: null, phase: "preservation",
          attempt: null, from: "running", to: "QA_UNAVAILABLE", reason: "preservation_unavailable",
          priorRevisionId: check.sourceRevisionId, resultingRevisionId: check.revisionId,
          expectedSelectionVersion: null, resultingSelectionVersion: null, requestReferenceId: this.uuid(),
        });
      });
    } catch {
      // Keep the deterministic work recoverable on a conservative restart.
    }
  }

  private claimAssessment(assessmentAttemptId: UUID): { attempt: S4AssessmentAttempt; token: UUID } | null {
    return this.repository.transact((state) => {
      const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
      const assessment = attempt && state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
      const edit = attempt && state.s4Edits.find((item) => item.editId === attempt.editId);
      if (!attempt || !assessment || !edit || attempt.status !== "queued" ||
          attempt.disposition !== "pending" || assessment.status !== "pending" ||
          edit.status !== "assessment_pending") return null;
      const token = this.uuid();
      attempt.status = "running";
      attempt.disposition = "running";
      attempt.claimedBy = this.workerId;
      attempt.claimedProcessId = this.processId;
      attempt.claimToken = token;
      attempt.claimedAt = this.clock();
      attempt.startedAt = this.clock();
      const previous = assessment.status;
      assessment.status = "running";
      assessment.updatedAt = this.clock();
      edit.status = "assessment_running";
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: attempt.projectId,
        generationSetId: attempt.generationSetId, selectionStateId: attempt.selectionStateId,
        editId: edit.editId, operationId: null, publicationId: null, preservationCheckId: edit.preservationCheckId,
        assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "assessment",
        attempt: attempt.attempt, from: previous, to: "running", reason: "assessment_started",
        priorRevisionId: attempt.revisionId, resultingRevisionId: attempt.revisionId,
        expectedSelectionVersion: null, resultingSelectionVersion: null,
        requestReferenceId: attempt.requestReferenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId: attempt.projectId,
        generationSetId: attempt.generationSetId, selectionStateId: attempt.selectionStateId,
        editId: edit.editId, operationId: null, publicationId: null, preservationCheckId: edit.preservationCheckId,
        assessmentId: assessment.assessmentId, assessmentAttemptId, phase: "edit",
        attempt: attempt.attempt, from: "assessment_pending", to: "assessment_running",
        reason: "assessment_started", priorRevisionId: attempt.revisionId,
        resultingRevisionId: attempt.revisionId, expectedSelectionVersion: null,
        resultingSelectionVersion: null, requestReferenceId: attempt.requestReferenceId,
      });
      return { attempt: cloneJson(attempt), token };
    });
  }

  private assessmentCompilation(state: StoreState, assessment: S4Assessment, edit: S4EditAdmission): S4AssessmentCompilation {
    const revision = state.s4Revisions.find((item) => item.revisionId === assessment.revisionId);
    const mask = state.s4Masks.find((item) => item.maskId === assessment.maskId);
    const asset = state.s4Assets.find((item) => item.assetId === assessment.outputAssetId);
    if (!revision || !mask || !asset) throw fail(409, "S4_FENCE_STALE");
    return compileS4Assessment({
      projectId: assessment.projectId,
      generationSetId: assessment.generationSetId,
      selectionStateId: assessment.selectionStateId,
      editId: edit.editId,
      revisionId: revision.revisionId,
      sourceRevisionId: assessment.sourceRevisionId,
      sourceRevisionKind: edit.baseRevisionKind,
      sourceAssetId: revision.sourceAssetId,
      sourceSha256: assessment.sourceSha256,
      sourceByteSize: revision.sourceByteSize,
      sourceWidth: 1536,
      sourceHeight: 1024,
      sourcePixelCount: 1_572_864,
      editedAssetId: asset.assetId,
      editedSha256: assessment.outputSha256,
      editedByteSize: asset.normalizedBytes,
      editedWidth: 1536,
      editedHeight: 1024,
      editedPixelCount: 1_572_864,
      mask: {
        maskIdentityHash: mask.maskIdentityHash,
        primitiveHash: mask.primitiveHash,
        rasterSha256: mask.rasterSha256,
        providerPngSha256: mask.providerPngSha256,
        editablePixelCount: mask.editablePixelCount,
        comparisonPixelCount: mask.comparisonPixelCount,
        polarity: "transparent-editable-opaque-protected",
      },
      instructionText: edit.instructionText,
      instructionHash: edit.instructionHash,
      sourceQuality: assessment.sourceQuality,
      confirmedBriefVersionId: assessment.confirmedBriefVersionId,
      confirmedBriefContentHash: assessment.confirmedBriefContentHash,
      geometrySnapshot: cloneJson(assessment.geometrySnapshot),
      geometryHash: assessment.geometryHash,
      canonicalRequirements: cloneJson(assessment.canonicalRequirements),
      requirementHash: assessment.requirementHash,
      designRulesVersion: "s2-design-rules-v1",
      designRuleSnapshot: cloneJson(assessment.designRuleSnapshot),
      designRuleSnapshotHash: assessment.designRuleSnapshotHash,
      preservationCheckId: revision.preservationCheckId,
      preservationStatus: "PASS",
      noOpDetected: false,
    });
  }

  private assessmentDispatchInput(state: StoreState, attempt: S4AssessmentAttempt): {
    input: S4AssessmentProviderInput;
    assessment: S4Assessment;
    edit: S4EditAdmission;
    compilation: S4AssessmentCompilation;
  } {
    const assessment = state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
    const edit = assessment && state.s4Edits.find((item) => item.editId === assessment.editId);
    const selection = edit && state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
    if (!assessment || !edit || !selection || selection.selectionVersion !== edit.baseSelectionVersion ||
        selection.activeRevisionId !== edit.baseRevisionId) throw fail(409, "S4_FENCE_STALE");
    let resolved: ResolvedVisualRevision;
    try { resolved = resolveVisualRevision(state, attempt.projectId, edit.baseRevisionId, this.objects); }
    catch { throw fail(409, "S4_FENCE_STALE"); }
    if (resolved.assetId !== (state.s4Revisions.find((item) => item.revisionId === assessment.revisionId)?.sourceAssetId ?? "") ||
        resolved.sha256 !== assessment.sourceSha256) {
      throw fail(409, "S4_FENCE_STALE");
    }
    const mask = state.s4Masks.find((item) => item.maskId === assessment.maskId);
    const asset = state.s4Assets.find((item) => item.assetId === assessment.outputAssetId);
    if (!mask || !asset) throw fail(409, "S4_FENCE_STALE");
    const materialized = materializeS4Mask(mask.primitives);
    if (materialized.maskIdentityHash !== mask.maskIdentityHash ||
        materialized.rasterSha256 !== mask.rasterSha256 ||
        materialized.providerPngSha256 !== mask.providerPngSha256) throw fail(409, "S4_FENCE_STALE");
    const compilation = this.assessmentCompilation(state, assessment, edit);
    if (compilation.assessmentInputHash !== assessment.assessmentInputHash ||
        compilation.assessmentPromptHash !== assessment.assessmentPromptHash ||
        compilation.assessmentInputHash !== attempt.assessmentInputHash ||
        compilation.assessmentPromptHash !== attempt.assessmentPromptHash) throw fail(409, "S4_FENCE_STALE");
    const sourceBytes = this.readRevisionBytes(
      state, assessment.sourceRevisionId, edit.baseRevisionKind,
      state.s4Revisions.find((item) => item.revisionId === assessment.revisionId)!.sourceAssetId,
      assessment.sourceSha256,
      state.s4Revisions.find((item) => item.revisionId === assessment.revisionId)!.sourceByteSize,
    );
    const outputBytes = objectIdentity(this.objects, asset.storageKeyNormalized, assessment.outputSha256, asset.normalizedBytes);
    const maskBytes = objectIdentity(this.objects, mask.providerPngStorageKey, mask.providerPngSha256, mask.providerPngBytes);
    return {
      input: { promptText: compilation.promptText, sourceBytes, outputBytes, maskBytes },
      assessment, edit, compilation,
    };
  }

  private beginAssessmentDispatch(assessmentAttemptId: UUID, token: UUID): S4AssessmentAttempt | null {
    return this.repository.transact((state) => {
      const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
      if (!attempt || !this.claimMatches(attempt, token) || attempt.providerDispatchState !== "not_started") return null;
      const assessment = state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
      const edit = assessment && state.s4Edits.find((item) => item.editId === assessment.editId);
      if (!assessment || !edit) return null;
      const count = state.s4AssessmentAttempts.filter((item) => dispatchInLineage(state, item, {
        projectId: attempt.projectId,
        generationSetId: attempt.generationSetId,
        selectionStateId: attempt.selectionStateId,
        lineageRootRevisionId: edit.lineageRootRevisionId,
      })).length;
      if (count >= 4) {
        attempt.status = "failed";
        attempt.disposition = "qa_unavailable_terminal";
        attempt.failureCode = "PERSISTENCE_FAILED";
        attempt.completedAt = this.clock();
        clearClaim(attempt);
        assessment.status = "qa_unavailable_terminal";
        assessment.retryState = "none";
        assessment.updatedAt = this.clock();
        edit.status = "qa_unavailable";
        edit.retryState = "none";
        edit.terminalAt = this.clock();
        edit.updatedAt = this.clock();
        return null;
      }
      attempt.providerDispatchState = "may_have_started";
      return cloneJson(attempt);
    });
  }

  private assessmentMetadata(result: S4AssessmentProviderResult): S4AssessmentProviderMetadata {
    return {
      provider: "openai",
      api: "responses",
      model: "gpt-5.4-mini",
      modelSnapshot: "gpt-5.4-mini-2026-03-17",
      providerRequestId: result.providerRequestId,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
    };
  }

  private markAssessmentConsumed(assessmentAttemptId: UUID, token: UUID, metadata: S4AssessmentProviderMetadata): boolean {
    return this.repository.transact((state) => {
      const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
      if (!attempt || !this.claimMatches(attempt, token)) return false;
      attempt.providerDispatchState = "consumed";
      attempt.providerMetadata = cloneJson(metadata);
      return true;
    });
  }

  private assessmentEvidenceBytes(
    attempt: S4AssessmentAttempt,
    reduction: ReturnType<typeof reduceS4AssessmentPayload>,
  ): Buffer {
    return Buffer.from(jcs({
      schemaVersion: "s4-assessment-evidence-v1",
      assessmentAttemptId: attempt.assessmentAttemptId,
      assessmentId: attempt.assessmentId,
      assessmentInputHash: attempt.assessmentInputHash,
      assessmentPromptHash: attempt.assessmentPromptHash,
      attempt: attempt.attempt,
      result: reduction,
    }), "utf8");
  }

  private activationIdentityMatches(
    state: StoreState,
    edit: S4EditAdmission,
    assessment: S4Assessment,
    attempt: S4AssessmentAttempt,
    reduction: ReturnType<typeof reduceS4AssessmentPayload>,
  ): boolean {
    try {
      const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
      if (!selection || selection.projectId !== edit.projectId ||
          selection.generationSetId !== edit.generationSetId ||
          selection.selectionVersion !== edit.baseSelectionVersion ||
          selection.activeRevisionId !== edit.baseRevisionId) return false;
      const base = resolveVisualRevision(state, edit.projectId, edit.baseRevisionId, this.objects);
      const revision = state.s4Revisions.find((item) => item.revisionId === attempt.revisionId);
      const asset = state.s4Assets.find((item) => item.assetId === attempt.outputAssetId);
      const mask = state.s4Masks.find((item) => item.maskId === edit.maskId);
      const operation = state.s4ImageOperations.find((item) =>
        item.editId === edit.editId && item.outputRevisionId === attempt.revisionId &&
        item.outputAssetId === attempt.outputAssetId && item.status === "succeeded");
      const publication = operation?.publicationId
        ? state.s4Publications.find((item) => item.publicationId === operation.publicationId)
        : undefined;
      const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === edit.preservationCheckId);
      if (!revision || !asset || !mask || !operation || !publication || !check) return false;
      if (base.revisionId !== edit.baseRevisionId || base.kind !== edit.baseRevisionKind ||
          base.sourceSnapshotId !== edit.sourceSnapshotId ||
          base.lineageRootRevisionId !== edit.lineageRootRevisionId ||
          base.assetId !== revision.sourceAssetId ||
          base.sha256 !== revision.sourceSha256 ||
          base.byteSize !== revision.sourceByteSize) return false;
      if (revision.projectId !== edit.projectId || revision.generationSetId !== edit.generationSetId ||
          revision.selectionStateId !== edit.selectionStateId ||
          revision.sourceSnapshotId !== edit.sourceSnapshotId ||
          revision.lineageRootRevisionId !== edit.lineageRootRevisionId ||
          revision.parentRevisionId !== edit.baseRevisionId ||
          revision.parentRevisionKind !== edit.baseRevisionKind ||
          revision.cycleNumber !== edit.cycleNumber ||
          revision.editId !== edit.editId || revision.maskId !== mask.maskId ||
          revision.maskIdentityHash !== edit.maskIdentityHash ||
          revision.instructionHash !== edit.instructionHash ||
          revision.editInputHash !== edit.editInputHash ||
          revision.promptHash !== edit.promptHash ||
          revision.providerRequestHash !== edit.providerRequestHash ||
          revision.outputAssetId !== asset.assetId ||
          revision.outputSha256 !== asset.normalizedSha256 ||
          revision.outputByteSize !== asset.normalizedBytes) return false;
      if (mask.editId !== edit.editId || mask.sourceRevisionId !== edit.baseRevisionId ||
          mask.sourceAssetId !== base.assetId || mask.maskIdentityHash !== edit.maskIdentityHash) return false;
      if (asset.projectId !== edit.projectId || asset.generationSetId !== edit.generationSetId ||
          asset.revisionId !== revision.revisionId ||
          asset.providerOutputSha256 !== asset.normalizedSha256 ||
          asset.providerOutputBytes !== asset.normalizedBytes ||
          asset.width !== 1536 || asset.height !== 1024 || asset.pixelCount !== 1_572_864) return false;
      if (operation.projectId !== edit.projectId || operation.generationSetId !== edit.generationSetId ||
          operation.selectionStateId !== edit.selectionStateId ||
          operation.baseRevisionId !== edit.baseRevisionId ||
          operation.baseSelectionVersion !== edit.baseSelectionVersion ||
          operation.editInputHash !== edit.editInputHash ||
          operation.promptHash !== edit.promptHash ||
          operation.providerRequestHash !== edit.providerRequestHash ||
          operation.providerDispatchState !== "consumed" ||
          operation.publicationId !== publication.publicationId ||
          operation.outputRevisionId !== revision.revisionId ||
          operation.outputAssetId !== asset.assetId ||
          operation.claimedBy !== null || operation.claimedProcessId !== null ||
          operation.claimToken !== null) return false;
      if (publication.projectId !== edit.projectId || publication.generationSetId !== edit.generationSetId ||
          publication.selectionStateId !== edit.selectionStateId ||
          publication.editId !== edit.editId || publication.operationId !== operation.operationId ||
          publication.inputHash !== operation.operationInputHash ||
          publication.intendedAssetId !== asset.assetId ||
          publication.intendedRevisionId !== revision.revisionId ||
          publication.intendedPreservationCheckId !== check.preservationCheckId ||
          publication.intendedAssessmentId !== assessment.assessmentId ||
          publication.state !== "committed" ||
          publication.finalObjects.length !== 1 ||
          publication.finalObjects[0].sha256 !== asset.normalizedSha256 ||
          publication.finalObjects[0].byteSize !== asset.normalizedBytes ||
          !this.objectMatches(publication.finalObjects[0])) return false;
      if (check.projectId !== edit.projectId || check.generationSetId !== edit.generationSetId ||
          check.selectionStateId !== edit.selectionStateId || check.editId !== edit.editId ||
          check.revisionId !== revision.revisionId || check.sourceRevisionId !== edit.baseRevisionId ||
          check.sourceAssetId !== base.assetId || check.sourceSha256 !== base.sha256 ||
          check.outputAssetId !== asset.assetId || check.outputSha256 !== asset.normalizedSha256 ||
          check.maskId !== mask.maskId || check.maskIdentityHash !== mask.maskIdentityHash ||
          check.status !== "PASS" || check.noOpDetected !== false || !check.evidenceObject ||
          !this.objectMatches(check.evidenceObject)) return false;
      if (assessment.projectId !== edit.projectId || assessment.generationSetId !== edit.generationSetId ||
          assessment.selectionStateId !== edit.selectionStateId || assessment.editId !== edit.editId ||
          assessment.revisionId !== revision.revisionId || assessment.sourceRevisionId !== edit.baseRevisionId ||
          assessment.outputAssetId !== asset.assetId || assessment.sourceSha256 !== base.sha256 ||
          assessment.outputSha256 !== asset.normalizedSha256 || assessment.maskId !== mask.maskId ||
          assessment.maskIdentityHash !== mask.maskIdentityHash || assessment.instructionHash !== edit.instructionHash ||
          assessment.assessmentInputHash !== attempt.assessmentInputHash ||
          assessment.assessmentPromptHash !== attempt.assessmentPromptHash ||
          assessment.latestAttemptId !== attempt.assessmentAttemptId ||
          !Array.from(assessment.attemptIds).includes(attempt.assessmentAttemptId) ||
          assessment.noOpDetected || assessment.retryState !== "none" ||
          assessment.retryWaivedReason !== null ||
          assessment.requestedEditSatisfaction !== reduction.requestedEditSatisfaction ||
          assessment.overallRequirementResult !== reduction.overallRequirementResult ||
          assessment.overallBuildabilityResult !== reduction.overallBuildabilityResult) return false;
      if (attempt.assessmentId !== assessment.assessmentId || attempt.projectId !== edit.projectId ||
          attempt.generationSetId !== edit.generationSetId || attempt.selectionStateId !== edit.selectionStateId ||
          attempt.editId !== edit.editId || attempt.revisionId !== revision.revisionId ||
          attempt.outputAssetId !== asset.assetId || attempt.sourceSha256 !== base.sha256 ||
          attempt.outputSha256 !== asset.normalizedSha256 ||
          attempt.maskIdentityHash !== mask.maskIdentityHash ||
          attempt.instructionHash !== edit.instructionHash ||
          attempt.assessmentInputHash !== assessment.assessmentInputHash ||
          attempt.assessmentPromptHash !== assessment.assessmentPromptHash ||
          attempt.status !== "succeeded" || attempt.providerDispatchState !== "consumed" ||
          attempt.claimedBy !== null || attempt.claimedProcessId !== null ||
          attempt.claimToken !== null || attempt.evidenceObject === null ||
          !this.objectMatches(attempt.evidenceObject)) return false;
      const expectedDisposition = reduction.status === "pass" ? "pass" : reduction.status === "warning" ? "warning" : null;
      if (expectedDisposition === null || attempt.disposition !== expectedDisposition ||
          attempt.requestedEditSatisfaction !== reduction.requestedEditSatisfaction ||
          attempt.overallRequirementResult !== reduction.overallRequirementResult ||
          attempt.overallBuildabilityResult !== reduction.overallBuildabilityResult ||
          attempt.failureCode !== null || edit.retryWaivedReason !== null ||
          edit.retryState !== "none" || edit.outputRevisionId !== revision.revisionId ||
          edit.preservationCheckId !== check.preservationCheckId ||
          edit.assessmentId !== assessment.assessmentId) return false;
      return true;
    } catch {
      return false;
    }
  }

  private completeAssessment(
    assessmentAttemptId: UUID,
    token: UUID,
    reduction: ReturnType<typeof reduceS4AssessmentPayload>,
    metadata: S4AssessmentProviderMetadata,
  ): void {
    const stateBefore = this.state();
    const attemptBefore = stateBefore.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
    if (!attemptBefore) return;
    const editBefore = stateBefore.s4Edits.find((item) => item.editId === attemptBefore.editId);
    if (!editBefore) return;
    const evidence = this.assessmentEvidenceBytes(attemptBefore, reduction);
    const evidenceKey = privateStorageKey(
      "projects", attemptBefore.projectId, "s4", "edits", attemptBefore.editId,
      "revisions", attemptBefore.revisionId, "assessment", attemptBefore.assessmentId,
      "attempts", attemptBefore.assessmentAttemptId, "evidence.json",
    );
    try {
      this.objects.putExact(evidenceKey, evidence);
      this.repository.transact((state) => {
        const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
        const assessment = attempt && state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
        const edit = attempt && state.s4Edits.find((item) => item.editId === attempt.editId);
        if (!attempt || !assessment || !edit || !this.claimMatches(attempt, token)) return;
        attempt.status = "succeeded";
        attempt.disposition = reduction.status === "pass" ? "pass" :
          reduction.status === "warning" ? "warning" :
            reduction.status === "material_fail" ? "material_fail" : "qa_unavailable_terminal";
        attempt.requirementObservations = cloneJson(reduction.requirementObservations);
        attempt.designObservations = cloneJson(reduction.designObservations);
        attempt.requestedEditSatisfaction = reduction.requestedEditSatisfaction;
        attempt.overallRequirementResult = reduction.overallRequirementResult;
        attempt.overallBuildabilityResult = reduction.overallBuildabilityResult;
        attempt.materialFindingIds = cloneJson(reduction.materialFindingIds);
        attempt.warningFindingIds = cloneJson(reduction.warningFindingIds);
        attempt.uncertainFindingIds = cloneJson(reduction.uncertainFindingIds);
        attempt.providerMetadata = cloneJson(metadata);
        attempt.evidenceObject = { key: evidenceKey, sha256: sha256(evidence), byteSize: evidence.byteLength };
        attempt.completedAt = this.clock();
        attempt.providerDispatchState = "consumed";
        clearClaim(attempt);
        assessment.latestAttemptId = attempt.assessmentAttemptId;
        assessment.requestedEditSatisfaction = reduction.requestedEditSatisfaction;
        assessment.overallRequirementResult = reduction.overallRequirementResult;
        assessment.overallBuildabilityResult = reduction.overallBuildabilityResult;
        assessment.status = reduction.status === "pass" ? "pass" :
          reduction.status === "warning" ? "warning" :
            reduction.status === "material_fail" ? "material_fail" : "qa_unavailable_terminal";
        assessment.retryState = "none";
        assessment.retryWaivedReason = null;
        assessment.updatedAt = this.clock();
        const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
        const check = edit.preservationCheckId
          ? state.s4PreservationChecks.find((item) => item.preservationCheckId === edit.preservationCheckId)
          : undefined;
        const identityReady = this.activationIdentityMatches(state, edit, assessment, attempt, reduction);
        const current = Boolean(identityReady && selection && selection.selectionVersion === edit.baseSelectionVersion &&
          selection.activeRevisionId === edit.baseRevisionId && check?.status === "PASS" &&
          check.noOpDetected === false && (reduction.status === "pass" || reduction.status === "warning") &&
          reduction.requestedEditSatisfaction === "satisfied");
        const previous = edit.status;
        if (reduction.status === "pass" || reduction.status === "warning") {
          if (current && selection) {
            const expectedVersion = selection.selectionVersion;
            selection.activeRevisionId = attempt.revisionId;
            selection.selectionVersion += 1;
            selection.updatedAt = this.clock();
            edit.status = "completed";
            edit.retryState = "none";
            edit.retryWaivedReason = null;
            edit.terminalAt = this.clock();
            edit.updatedAt = this.clock();
            this.transition(state, {
              transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
              generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
              editId: edit.editId, operationId: null, publicationId: null,
              preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
              assessmentAttemptId, phase: "activation", attempt: attempt.attempt,
              from: "assessment_running", to: "activation", reason: "activation",
              priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
              expectedSelectionVersion: expectedVersion,
              resultingSelectionVersion: selection.selectionVersion, requestReferenceId: attempt.requestReferenceId,
            });
          } else {
            edit.status = "stale";
            edit.retryState = "none";
            edit.retryWaivedReason = null;
            edit.terminalAt = this.clock();
            edit.updatedAt = this.clock();
            this.transition(state, {
              transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
              generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
              editId: edit.editId, operationId: null, publicationId: null,
              preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
              assessmentAttemptId, phase: "activation", attempt: attempt.attempt,
              from: "assessment_running", to: "stale", reason: "activation_stale",
              priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
              expectedSelectionVersion: selection?.selectionVersion ?? null,
              resultingSelectionVersion: selection?.selectionVersion ?? null, requestReferenceId: attempt.requestReferenceId,
            });
          }
        } else {
          edit.status = reduction.status === "qa_unavailable" ? "qa_unavailable" : "material_fail";
          edit.retryState = "none";
          edit.retryWaivedReason = null;
          edit.terminalAt = this.clock();
          edit.updatedAt = this.clock();
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
            generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
            editId: edit.editId, operationId: null, publicationId: null,
            preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
            assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
            from: "running", to: attempt.disposition, reason: reduction.status === "qa_unavailable"
              ? "assessment_unavailable" : "assessment_material_fail",
            priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
            expectedSelectionVersion: selection?.selectionVersion ?? null,
            resultingSelectionVersion: selection?.selectionVersion ?? null, requestReferenceId: attempt.requestReferenceId,
          });
        }
        if (previous !== edit.status) {
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
            generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
            editId: edit.editId, operationId: null, publicationId: null,
            preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
            assessmentAttemptId, phase: "edit", attempt: attempt.attempt,
            from: previous, to: edit.status, reason: null, priorRevisionId: edit.baseRevisionId,
            resultingRevisionId: attempt.revisionId,
            expectedSelectionVersion: selection?.selectionVersion ?? null,
            resultingSelectionVersion: selection?.selectionVersion ?? null, requestReferenceId: attempt.requestReferenceId,
          });
        }
      });
    } catch {
      // The private evidence cannot make the assessment usable without its commit.
    }
  }

  private failAssessment(assessmentAttemptId: UUID, token: UUID, error: unknown): void {
    try {
      this.repository.transact((state) => {
        const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === assessmentAttemptId);
        const assessment = attempt && state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
        const edit = attempt && state.s4Edits.find((item) => item.editId === attempt.editId);
        if (!attempt || !assessment || !edit || !this.claimMatches(attempt, token)) return;
        const code = failureCode(error);
        const ambiguous = attempt.providerDispatchState === "may_have_started" &&
          (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE" || error instanceof ProcessInterruption);
        const retryable = !ambiguous && attempt.providerDispatchState === "consumed" &&
          attempt.attempt === 1 && S4_ASSESSMENT_RETRYABLE.has(code);
        attempt.status = "failed";
        attempt.disposition = retryable ? "qa_unavailable_retryable" : "qa_unavailable_terminal";
        attempt.failureCode = ambiguous ? "PROVIDER_DISPATCH_UNCERTAIN" : code;
        attempt.completedAt = this.clock();
        clearClaim(attempt);
        assessment.status = retryable ? "qa_unavailable_retryable" : "qa_unavailable_terminal";
        assessment.retryState = retryable ? "available" : "none";
        assessment.retryWaivedReason = null;
        assessment.latestAttemptId = attempt.assessmentAttemptId;
        assessment.updatedAt = this.clock();
        edit.status = retryable ? "assessment_retry_available" : "qa_unavailable";
        edit.retryState = retryable ? "assessment_available" : "none";
        edit.retryWaivedReason = null;
        edit.terminalAt = retryable ? null : this.clock();
        edit.updatedAt = this.clock();
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
          from: "running", to: attempt.disposition,
          reason: ambiguous ? "assessment_unavailable" : retryable ? "assessment_unavailable" : "assessment_unavailable",
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: edit.outputRevisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId, phase: "edit", attempt: attempt.attempt,
          from: "assessment_running", to: edit.status,
          reason: retryable ? "assessment_unavailable" : "assessment_unavailable",
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: edit.outputRevisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
      });
    } catch {
      // A consumed operation is terminally conservative until a later restart audit.
    }
  }

  private async runAssessment(assessmentAttemptId: UUID): Promise<void> {
    const claim = this.claimAssessment(assessmentAttemptId);
    if (!claim) return;
    try {
      const initial = this.state();
      const dispatch = this.assessmentDispatchInput(initial, claim.attempt);
      await this.notifyDispatch("before-dispatch", claim.attempt);
      try {
        this.assertAssessmentDispatchReady();
      } catch {
        this.requeueAssessmentBeforeDispatch(assessmentAttemptId, claim.token);
        return;
      }
      const marked = this.beginAssessmentDispatch(assessmentAttemptId, claim.token);
      if (!marked) return;
      await this.notifyDispatch("after-dispatch-marked", marked);
      let response: S4AssessmentProviderResult;
      try {
        if (!this.provider.runS4Assessment) throw new ProviderFailure("PROVIDER_NOT_CONFIGURED");
        response = await this.provider.runS4Assessment(dispatch.input);
      } catch (error) {
        if (error instanceof ProcessInterruption) throw error;
        const code = failureCode(error);
        if (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE") throw error;
        const metadata: S4AssessmentProviderMetadata = {
          provider: "openai", api: "responses", model: "gpt-5.4-mini",
          modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null,
          inputTokens: null, outputTokens: null, totalTokens: null,
        };
        if (this.markAssessmentConsumed(assessmentAttemptId, claim.token, metadata)) {
          this.failAssessment(assessmentAttemptId, claim.token, error);
        }
        return;
      }
      const metadata = this.assessmentMetadata(response);
      if (!this.markAssessmentConsumed(assessmentAttemptId, claim.token, metadata)) return;
      let reduction: ReturnType<typeof reduceS4AssessmentPayload>;
      try {
        reduction = reduceS4AssessmentPayload(
          response.payload,
          dispatch.assessment.canonicalRequirements,
          dispatch.assessment.designRuleSnapshot,
        );
      } catch (error) {
        this.failAssessment(assessmentAttemptId, claim.token, error);
        return;
      }
      this.completeAssessment(assessmentAttemptId, claim.token, reduction, metadata);
    } catch (error) {
      if (error instanceof ProcessInterruption) return;
      this.failAssessment(assessmentAttemptId, claim.token, error);
    }
  }

  private startAssessmentAttempt(assessmentAttemptId: UUID): void {
    const key = "s4-assessment:" + assessmentAttemptId;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.runAssessment(assessmentAttemptId).catch(() => undefined).finally(() => this.inFlight.delete(key));
  }

  imageRetry(projectId: UUID, editId: UUID, key: UUID, referenceId: UUID): PublicS4Mutation<PublicS4RetryAdmission> {
    assertUuid(projectId, "projectId");
    assertUuid(editId, "editId");
    assertUuid(key, "Idempotency-Key");
    assertUuid(referenceId, "x-request-id");
    const requestHash = operationHash("s4_image_retry", projectId, { editId, attemptNumber: 2 });
    const result = this.repository.transact((state) => {
      const edit = state.s4Edits.find((item) => item.projectId === projectId && item.editId === editId);
      if (!edit) throw fail(404, "S4_EDIT_NOT_FOUND", "editId");
      const replay = this.idempotency(state, key, "s4_image_retry", projectId, requestHash);
      if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS4RetryAdmission };
      if (edit.retryState === "waived" || edit.status === "waived") throw fail(409, "S4_RETRY_WAIVED");
      const firstId = edit.imageOperationIds[0];
      const first = firstId && state.s4ImageOperations.find((item) => item.operationId === firstId);
      const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
      if (!first || edit.imageOperationIds.length !== 1 ||
          edit.status !== "image_retry_available" || edit.retryState !== "image_available" ||
          first.status !== "failed" || first.attempt !== 1 ||
          first.providerDispatchState !== "consumed" || !first.failureCode ||
          !S4_IMAGE_RETRYABLE.has(first.failureCode) ||
          !selection || selection.selectionVersion !== edit.baseSelectionVersion ||
          selection.activeRevisionId !== edit.baseRevisionId ||
          state.s4Edits.some((item) => item.selectionStateId === edit.selectionStateId && item.cycleNumber > edit.cycleNumber)) {
        throw fail(409, "S4_IMAGE_RETRY_NOT_AVAILABLE");
      }
      const operationId = this.uuid();
      const retryHash = canonicalHash({
        schemaVersion: "s4-image-operation-v1",
        projectId, generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
        editId, baseRevisionId: edit.baseRevisionId, baseSelectionVersion: edit.baseSelectionVersion,
        attempt: 2, retryOfOperationId: first.operationId, editInputHash: edit.editInputHash,
        promptHash: edit.promptHash, providerRequestHash: edit.providerRequestHash,
        maskIdentityHash: edit.maskIdentityHash,
      });
      const retry: S4ImageOperation = {
        ...cloneJson(first),
        operationId,
        retryOfOperationId: first.operationId,
        attempt: 2,
        operationInputHash: retryHash,
        requestReferenceId: referenceId,
        status: "queued",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        providerDispatchState: "not_started",
        providerMetadata: null,
        failureCode: null,
        publicationId: null,
        outputRevisionId: null,
        outputAssetId: null,
        createdAt: this.clock(),
      };
      state.s4ImageOperations.push(retry);
      edit.imageOperationIds = [first.operationId, operationId];
      edit.status = "image_queued";
      edit.retryState = "none";
      edit.retryWaivedReason = null;
      edit.terminalAt = null;
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId, generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId, editId, operationId, publicationId: null,
        preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
        phase: "edit", attempt: 2, from: "image_retry_available", to: "image_queued",
        reason: "image_retry_admitted", priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: referenceId,
      });
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId, generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId, editId, operationId, publicationId: null,
        preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
        phase: "image", attempt: 2, from: null, to: "queued", reason: "image_retry_admitted",
        priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
        expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: referenceId,
      });
      const response: PublicS4RetryAdmission = {
        editId, status: "generating", imageRetryAvailable: false, assessmentRetryAvailable: false,
      };
      this.remember(state, key, "s4_image_retry", projectId, requestHash, response as unknown as Record<string, unknown>);
      return { replayed: false, result: response };
    });
    if (!result.replayed) this.startImageOperation(result.result.editId && (
      this.state().s4Edits.find((item) => item.editId === result.result.editId)?.imageOperationIds.at(-1) ?? result.result.editId
    ));
    return result;
  }

  assessmentRetry(projectId: UUID, editId: UUID, key: UUID, referenceId: UUID): PublicS4Mutation<PublicS4RetryAdmission> {
    assertUuid(projectId, "projectId");
    assertUuid(editId, "editId");
    assertUuid(key, "Idempotency-Key");
    assertUuid(referenceId, "x-request-id");
    const requestHash = operationHash("s4_assessment_retry", projectId, { editId, attemptNumber: 2 });
    const result = this.repository.transact((state) => {
      const edit = state.s4Edits.find((item) => item.projectId === projectId && item.editId === editId);
      if (!edit) throw fail(404, "S4_EDIT_NOT_FOUND", "editId");
      const replay = this.idempotency(state, key, "s4_assessment_retry", projectId, requestHash);
      if (replay) return { replayed: true, result: cloneJson(replay.result) as unknown as PublicS4RetryAdmission };
      if (edit.retryState === "waived" || edit.status === "waived") throw fail(409, "S4_RETRY_WAIVED");
       const assessment = edit.assessmentId ? state.s4Assessments.find((item) => item.assessmentId === edit.assessmentId) : undefined;
      const firstId = assessment?.attemptIds[0];
      const first = firstId && state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === firstId);
      const selection = state.s3Selections.find((item) => item.selectionStateId === edit.selectionStateId);
      if (!assessment || !first || assessment.attemptIds.length !== 1 ||
          edit.assessmentAttemptIds.length !== 1 ||
          edit.status !== "assessment_retry_available" || edit.retryState !== "assessment_available" ||
          assessment.status !== "qa_unavailable_retryable" || assessment.retryState !== "available" ||
          first.status !== "failed" || first.attempt !== 1 ||
          first.providerDispatchState !== "consumed" ||
          !selection || selection.selectionVersion !== edit.baseSelectionVersion ||
          selection.activeRevisionId !== edit.baseRevisionId ||
          state.s4Edits.some((item) => item.selectionStateId === edit.selectionStateId && item.cycleNumber > edit.cycleNumber)) {
        throw fail(409, "S4_ASSESSMENT_RETRY_NOT_AVAILABLE");
      }
      const attemptId = this.uuid();
      const retryHash = canonicalHash({
        schemaVersion: "s4-assessment-operation-v1",
        projectId, generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
        editId, revisionId: first.revisionId, outputAssetId: first.outputAssetId,
        sourceSha256: first.sourceSha256, outputSha256: first.outputSha256,
        maskIdentityHash: first.maskIdentityHash, instructionHash: first.instructionHash,
        assessmentInputHash: first.assessmentInputHash, assessmentPromptHash: first.assessmentPromptHash,
        attempt: 2, retryOfAttemptId: first.assessmentAttemptId,
      });
      const retry: S4AssessmentAttempt = {
        ...cloneJson(first),
        assessmentAttemptId: attemptId,
        attempt: 2,
        retryOfAttemptId: first.assessmentAttemptId,
        operationInputHash: retryHash,
        requestReferenceId: referenceId,
        status: "queued",
        disposition: "pending",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        providerDispatchState: "not_started",
        requirementObservations: [],
        designObservations: [],
        requestedEditSatisfaction: null,
        overallRequirementResult: null,
        overallBuildabilityResult: null,
        materialFindingIds: [],
        warningFindingIds: [],
        uncertainFindingIds: [],
        failureCode: null,
        providerMetadata: null,
        evidenceObject: null,
        createdAt: this.clock(),
      };
      state.s4AssessmentAttempts.push(retry);
      assessment.attemptIds = [first.assessmentAttemptId, attemptId];
      assessment.latestAttemptId = attemptId;
      assessment.status = "pending";
      assessment.retryState = "none";
      assessment.retryWaivedReason = null;
      assessment.updatedAt = this.clock();
      edit.assessmentAttemptIds = [first.assessmentAttemptId, attemptId];
      edit.status = "assessment_pending";
      edit.retryState = "none";
      edit.retryWaivedReason = null;
      edit.terminalAt = null;
      edit.updatedAt = this.clock();
      this.transition(state, {
        transitionId: this.uuid(), at: this.clock(), projectId, generationSetId: edit.generationSetId,
        selectionStateId: edit.selectionStateId, editId, operationId: null, publicationId: null,
        preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
        assessmentAttemptId: attemptId, phase: "assessment", attempt: 2, from: null, to: "queued",
        reason: "assessment_retry_admitted", priorRevisionId: edit.baseRevisionId,
        resultingRevisionId: edit.outputRevisionId, expectedSelectionVersion: edit.baseSelectionVersion,
        resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: referenceId,
      });
      const response: PublicS4RetryAdmission = {
        editId, status: "assessment_pending", imageRetryAvailable: false, assessmentRetryAvailable: false,
      };
      this.remember(state, key, "s4_assessment_retry", projectId, requestHash, response as unknown as Record<string, unknown>);
      return { replayed: false, result: response };
    });
    if (!result.replayed) {
      const state = this.state();
      const edit = state.s4Edits.find((item) => item.editId === result.result.editId);
      const attemptId = edit?.assessmentAttemptIds.at(-1);
      if (attemptId) this.startAssessmentAttempt(attemptId);
    }
    return result;
  }

  private ownerDead(processId: number | null): boolean {
    if (processId === null) return false;
    try { return this.isProcessAlive(processId) === false; }
    catch { return false; }
  }

  private abortRecoveredPublication(publicationId: UUID, code: S4FailureCode = "PUBLICATION_FAILED"): void {
    try {
      this.repository.transact((state) => {
        const publication = state.s4Publications.find((item) => item.publicationId === publicationId);
        const operation = publication && state.s4ImageOperations.find((item) => item.operationId === publication.operationId);
        const edit = operation && state.s4Edits.find((item) => item.editId === operation.editId);
        if (!publication || publication.state === "committed" || publication.state === "aborted") return;
        const previousPublication = publication.state;
        publication.state = "aborted";
        publication.ownerProcessId = null;
        publication.ownerClaimToken = null;
        publication.ownerClaimedAt = null;
        publication.updatedAt = this.clock();
        if (operation) {
          const previousOperation = operation.status;
          operation.status = "failed";
          operation.failureCode = code;
          operation.completedAt = this.clock();
          clearClaim(operation);
          if (edit) {
            const previousEdit = edit.status;
            edit.status = code === "PERSISTENCE_FAILED" ? "image_failed" : "publication_failed";
            edit.retryState = "none";
            edit.retryWaivedReason = null;
            edit.terminalAt = this.clock();
            edit.updatedAt = this.clock();
            this.transition(state, {
              transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
              generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
              editId: edit.editId, operationId: operation.operationId, publicationId,
              preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
              phase: "edit", attempt: operation.attempt, from: previousEdit, to: edit.status,
              reason: code === "PERSISTENCE_FAILED" ? "image_failed" : "publication_aborted",
              priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
              expectedSelectionVersion: edit.baseSelectionVersion,
              resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
            });
          }
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
            generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
            editId: operation.editId, operationId: operation.operationId, publicationId,
            preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
            phase: "image", attempt: operation.attempt, from: previousOperation, to: "failed",
            reason: "image_failed", priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
            expectedSelectionVersion: operation.baseSelectionVersion,
            resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
          });
        }
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: publication.projectId,
          generationSetId: publication.generationSetId, selectionStateId: publication.selectionStateId,
          editId: publication.editId, operationId: publication.operationId, publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "publication", attempt: operation?.attempt ?? null, from: "publication_pending",
          to: "failed", reason: "publication_aborted", priorRevisionId: null, resultingRevisionId: null,
          expectedSelectionVersion: null, resultingSelectionVersion: null,
          requestReferenceId: operation?.requestReferenceId ?? this.uuid(),
        });
      });
    } catch {
      // Leave the durable intent for a later conservative recovery sweep.
    }
  }

  private recoverPublications(): void {
    const publications = this.state().s4Publications.filter((item) => item.state === "staged" || item.state === "promoted");
    for (const publication of publications) {
      if (!this.ownerDead(publication.ownerProcessId)) continue;
      try {
        const staging = publication.stagingObjects[0];
        const final = publication.finalObjects[0];
        const finalState = this.publicationObjectState(final);
        if (finalState === "mismatch") {
          this.abortRecoveredPublication(publication.publicationId, "PUBLICATION_OBJECT_MISMATCH");
          this.objects.remove(staging.key);
          continue;
        }
        if (finalState === "unavailable") {
          this.abortRecoveredPublication(publication.publicationId, "PERSISTENCE_FAILED");
          this.objects.remove(staging.key);
          continue;
        }
        const stagingReady = this.objectMatches(staging);
        let finalReady = finalState === "exact";
        if (!finalReady && stagingReady) {
          const bytes = this.objects.read(staging.key);
          try {
            this.objects.promoteExact(staging.key, final.key, bytes);
          } catch (error) {
            const afterFailure = this.publicationObjectState(final, bytes);
            if (afterFailure === "mismatch") {
              this.abortRecoveredPublication(publication.publicationId, "PUBLICATION_OBJECT_MISMATCH");
              this.objects.remove(staging.key);
              continue;
            }
            if (afterFailure === "exact") finalReady = true;
            else throw error;
          }
          if (!finalReady) {
            const afterPromotion = this.publicationObjectState(final, bytes);
            if (afterPromotion === "mismatch") {
              this.abortRecoveredPublication(publication.publicationId, "PUBLICATION_OBJECT_MISMATCH");
              this.objects.remove(staging.key);
              continue;
            }
            finalReady = afterPromotion === "exact";
          }
        }
        if (!finalReady) {
          this.abortRecoveredPublication(publication.publicationId);
          this.objects.remove(staging.key);
          continue;
        }
        const token = this.repository.transact((state) => {
          const stored = state.s4Publications.find((item) => item.publicationId === publication.publicationId);
          const operation = stored && state.s4ImageOperations.find((item) => item.operationId === stored.operationId);
          if (!stored || !operation || (stored.state !== "staged" && stored.state !== "promoted") ||
              operation.status !== "running" || operation.providerDispatchState !== "consumed" ||
              !this.ownerDead(stored.ownerProcessId)) return null;
          const claimToken = this.uuid();
          operation.claimedBy = this.workerId;
          operation.claimedProcessId = this.processId;
          operation.claimToken = claimToken;
          operation.claimedAt = this.clock();
          stored.state = "promoted";
          stored.ownerProcessId = this.processId;
          stored.ownerClaimToken = claimToken;
          stored.ownerClaimedAt = this.clock();
          stored.updatedAt = this.clock();
          return claimToken;
        });
        if (token) {
          const committed = this.commitPublication(publication.publicationId, token);
          this.objects.remove(staging.key);
          if (committed) this.startPreservation(committed.preservationCheckId);
        }
      } catch {
        this.abortRecoveredPublication(publication.publicationId, "PERSISTENCE_FAILED");
        this.objects.remove(publication.stagingObjects[0].key);
      }
    }
  }

  private recoverImageTerminal(
    state: StoreState,
    operation: S4ImageOperation,
    edit: S4EditAdmission,
    code: S4FailureCode,
  ): void {
    const previousOperation = operation.status;
    const previousEdit = edit.status;
    operation.status = "failed";
    operation.failureCode = code;
    operation.completedAt = this.clock();
    clearClaim(operation);
    edit.status = "image_failed";
    edit.retryState = "none";
    edit.retryWaivedReason = null;
    edit.terminalAt = this.clock();
    edit.updatedAt = this.clock();
    this.transition(state, {
      transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
      generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
      editId: edit.editId, operationId: operation.operationId, publicationId: operation.publicationId,
      preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
      phase: "image", attempt: operation.attempt, from: previousOperation, to: "failed",
      reason: "image_failed", priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
      expectedSelectionVersion: operation.baseSelectionVersion,
      resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
    });
    this.transition(state, {
      transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
      generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
      editId: edit.editId, operationId: operation.operationId, publicationId: operation.publicationId,
      preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
      phase: "edit", attempt: operation.attempt, from: previousEdit, to: "image_failed",
      reason: "image_failed", priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
      expectedSelectionVersion: edit.baseSelectionVersion,
      resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
    });
  }

  private recoverAssessmentTerminal(
    state: StoreState,
    attempt: S4AssessmentAttempt,
    assessment: S4Assessment,
    edit: S4EditAdmission,
    code: S4FailureCode,
  ): void {
    const previousAttempt = attempt.status;
    const previousAssessment = assessment.status;
    const previousEdit = edit.status;
    attempt.status = "failed";
    attempt.disposition = "qa_unavailable_terminal";
    attempt.failureCode = code;
    attempt.requirementObservations = [];
    attempt.designObservations = [];
    attempt.requestedEditSatisfaction = null;
    attempt.overallRequirementResult = null;
    attempt.overallBuildabilityResult = null;
    attempt.materialFindingIds = [];
    attempt.warningFindingIds = [];
    attempt.uncertainFindingIds = [];
    attempt.completedAt = this.clock();
    clearClaim(attempt);
    assessment.status = "qa_unavailable_terminal";
    assessment.retryState = "none";
    assessment.retryWaivedReason = null;
    assessment.latestAttemptId = attempt.assessmentAttemptId;
    assessment.requestedEditSatisfaction = null;
    assessment.overallRequirementResult = null;
    assessment.overallBuildabilityResult = null;
    assessment.updatedAt = this.clock();
    edit.status = "qa_unavailable";
    edit.retryState = "none";
    edit.retryWaivedReason = null;
    edit.terminalAt = this.clock();
    edit.updatedAt = this.clock();
    this.transition(state, {
      transitionId: this.uuid(), at: this.clock(), projectId: attempt.projectId,
      generationSetId: attempt.generationSetId, selectionStateId: attempt.selectionStateId,
      editId: edit.editId, operationId: null, publicationId: null,
      preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
      assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
      from: previousAttempt, to: "failed", reason: "assessment_unavailable",
      priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
      expectedSelectionVersion: edit.baseSelectionVersion,
      resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
    });
    this.transition(state, {
      transitionId: this.uuid(), at: this.clock(), projectId: assessment.projectId,
      generationSetId: assessment.generationSetId, selectionStateId: assessment.selectionStateId,
      editId: edit.editId, operationId: null, publicationId: null,
      preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
      assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
      from: previousAssessment, to: "qa_unavailable_terminal", reason: "assessment_unavailable",
      priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
      expectedSelectionVersion: edit.baseSelectionVersion,
      resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
    });
    this.transition(state, {
      transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
      generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
      editId: edit.editId, operationId: null, publicationId: null,
      preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
      assessmentAttemptId: attempt.assessmentAttemptId, phase: "edit", attempt: attempt.attempt,
      from: previousEdit, to: "qa_unavailable", reason: "assessment_unavailable",
      priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
      expectedSelectionVersion: edit.baseSelectionVersion,
      resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
    });
  }

  private recoverImage(
    state: StoreState,
    operation: S4ImageOperation,
    edit: S4EditAdmission,
    imageIds: UUID[],
  ): void {
    const dead = this.ownerDead(operation.claimedProcessId);
    const noClaim = operation.claimedBy === null && operation.claimedProcessId === null && operation.claimToken === null;
    if (operation.providerDispatchState === "not_started" &&
        ((operation.status === "running" && dead) || operation.status === "queued")) {
      const previousOperation = operation.status;
      const previousEdit = edit.status;
      operation.status = "queued";
      operation.startedAt = null;
      operation.completedAt = null;
      operation.failureCode = null;
      clearClaim(operation);
      edit.status = "image_queued";
      edit.terminalAt = null;
      edit.updatedAt = this.clock();
      if (previousOperation !== "queued") {
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: operation.projectId,
          generationSetId: operation.generationSetId, selectionStateId: operation.selectionStateId,
          editId: edit.editId, operationId: operation.operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "image", attempt: operation.attempt, from: previousOperation, to: "queued", reason: null,
          priorRevisionId: operation.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: operation.baseSelectionVersion,
          resultingSelectionVersion: operation.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId: operation.operationId, publicationId: operation.publicationId,
          preservationCheckId: null, assessmentId: null, assessmentAttemptId: null,
          phase: "edit", attempt: operation.attempt, from: previousEdit, to: "image_queued", reason: null,
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: null,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: operation.requestReferenceId,
        });
      }
      imageIds.push(operation.operationId);
      return;
    }
    if (operation.providerDispatchState === "may_have_started" &&
        ((operation.status === "running" && dead) || (operation.status === "queued" && dead))) {
      this.recoverImageTerminal(state, operation, edit, "PROVIDER_DISPATCH_UNCERTAIN");
      return;
    }
    if (operation.providerDispatchState === "consumed" && operation.status === "running" &&
        (dead || noClaim)) {
      const publication = operation.publicationId
        ? state.s4Publications.find((item) => item.publicationId === operation.publicationId)
        : undefined;
      if (publication && publication.state !== "committed" && publication.state !== "aborted" &&
          !this.ownerDead(publication.ownerProcessId)) return;
      if (publication && publication.state !== "committed" && publication.state !== "aborted") {
        publication.state = "aborted";
        publication.ownerProcessId = null;
        publication.ownerClaimToken = null;
        publication.ownerClaimedAt = null;
        publication.updatedAt = this.clock();
      }
      this.recoverImageTerminal(state, operation, edit, "PERSISTENCE_FAILED");
    }
  }

  private recoverAssessment(
    state: StoreState,
    attempt: S4AssessmentAttempt,
    assessment: S4Assessment,
    edit: S4EditAdmission,
    assessmentIds: UUID[],
  ): void {
    const dead = this.ownerDead(attempt.claimedProcessId);
    const noClaim = attempt.claimedBy === null && attempt.claimedProcessId === null && attempt.claimToken === null;
    if (attempt.providerDispatchState === "not_started" &&
        ((attempt.status === "running" && dead) || attempt.status === "queued")) {
      const previousAttempt = attempt.status;
      const previousAssessment = assessment.status;
      const previousEdit = edit.status;
      attempt.status = "queued";
      attempt.disposition = "pending";
      attempt.startedAt = null;
      attempt.completedAt = null;
      attempt.failureCode = null;
      clearClaim(attempt);
      assessment.status = "pending";
      assessment.updatedAt = this.clock();
      edit.status = "assessment_pending";
      edit.terminalAt = null;
      edit.updatedAt = this.clock();
      if (previousAttempt !== "queued") {
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: attempt.projectId,
          generationSetId: attempt.generationSetId, selectionStateId: attempt.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
          from: previousAttempt, to: "queued", reason: "assessment_started",
          priorRevisionId: attempt.revisionId, resultingRevisionId: attempt.revisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
        this.transition(state, {
          transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
          generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
          editId: edit.editId, operationId: null, publicationId: null,
          preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
          assessmentAttemptId: attempt.assessmentAttemptId, phase: "edit", attempt: attempt.attempt,
          from: previousEdit, to: "assessment_pending", reason: "assessment_started",
          priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
          expectedSelectionVersion: edit.baseSelectionVersion,
          resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
        });
        if (previousAssessment !== "pending") {
          this.transition(state, {
            transitionId: this.uuid(), at: this.clock(), projectId: assessment.projectId,
            generationSetId: assessment.generationSetId, selectionStateId: assessment.selectionStateId,
            editId: edit.editId, operationId: null, publicationId: null,
            preservationCheckId: edit.preservationCheckId, assessmentId: assessment.assessmentId,
            assessmentAttemptId: attempt.assessmentAttemptId, phase: "assessment", attempt: attempt.attempt,
            from: previousAssessment, to: "pending", reason: "assessment_started",
            priorRevisionId: edit.baseRevisionId, resultingRevisionId: attempt.revisionId,
            expectedSelectionVersion: edit.baseSelectionVersion,
            resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: attempt.requestReferenceId,
          });
        }
      }
      assessmentIds.push(attempt.assessmentAttemptId);
      return;
    }
    if (attempt.providerDispatchState === "may_have_started" &&
        ((attempt.status === "running" && dead) || (attempt.status === "queued" && dead))) {
      this.recoverAssessmentTerminal(state, attempt, assessment, edit, "PROVIDER_DISPATCH_UNCERTAIN");
      return;
    }
    if (attempt.providerDispatchState === "consumed" &&
        attempt.status === "running" && (dead || noClaim)) {
      this.recoverAssessmentTerminal(state, attempt, assessment, edit, "PERSISTENCE_FAILED");
    }
  }

  private recover(): void {
    this.recoverPublications();
    let work: { maskIds: UUID[]; imageIds: UUID[]; preservationIds: UUID[]; assessmentIds: UUID[] };
    try {
      work = this.repository.transact((state) => {
        const maskIds: UUID[] = [];
        const imageIds: UUID[] = [];
        const preservationIds: UUID[] = [];
        const assessmentIds: UUID[] = [];
        for (const edit of state.s4Edits) {
          if (edit.maskMaterializationStatus === "pending") maskIds.push(edit.editId);
        }
        for (const check of state.s4PreservationChecks) {
          const edit = state.s4Edits.find((item) => item.editId === check.editId);
          if (check.status === "pending") {
            preservationIds.push(check.preservationCheckId);
            continue;
          }
          if (check.status !== "running" || !this.ownerDead(check.claimedProcessId)) continue;
          check.status = "pending";
          check.failureCode = null;
          check.noOpDetected = null;
          check.startedAt = null;
          check.completedAt = null;
          clearClaim(check);
          if (edit) {
            const previous = edit.status;
            edit.status = "preservation_pending";
            edit.terminalAt = null;
            edit.updatedAt = this.clock();
            this.transition(state, {
              transitionId: this.uuid(), at: this.clock(), projectId: edit.projectId,
              generationSetId: edit.generationSetId, selectionStateId: edit.selectionStateId,
              editId: edit.editId, operationId: null, publicationId: null,
              preservationCheckId: check.preservationCheckId, assessmentId: edit.assessmentId,
              assessmentAttemptId: null, phase: "preservation", attempt: null,
              from: previous, to: "preservation_pending", reason: "preservation_started",
              priorRevisionId: check.sourceRevisionId, resultingRevisionId: check.revisionId,
              expectedSelectionVersion: edit.baseSelectionVersion,
              resultingSelectionVersion: edit.baseSelectionVersion, requestReferenceId: this.uuid(),
            });
          }
          preservationIds.push(check.preservationCheckId);
        }
        for (const operation of state.s4ImageOperations) {
          const edit = state.s4Edits.find((item) => item.editId === operation.editId);
          if (edit) this.recoverImage(state, operation, edit, imageIds);
        }
        for (const attempt of state.s4AssessmentAttempts) {
          const assessment = state.s4Assessments.find((item) => item.assessmentId === attempt.assessmentId);
          const edit = state.s4Edits.find((item) => item.editId === attempt.editId);
          if (assessment && edit) this.recoverAssessment(state, attempt, assessment, edit, assessmentIds);
        }
        return { maskIds, imageIds, preservationIds, assessmentIds };
      });
    } catch {
      return;
    }
    for (const editId of new Set(work.maskIds)) void this.materializeMask(editId);
    for (const checkId of new Set(work.preservationIds)) this.startPreservation(checkId);
    for (const operationId of new Set(work.imageIds)) this.startImageOperation(operationId);
    for (const attemptId of new Set(work.assessmentIds)) this.startAssessmentAttempt(attemptId);
  }

}
