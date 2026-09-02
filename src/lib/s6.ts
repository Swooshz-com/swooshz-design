import { Buffer } from "node:buffer";
import {
  AppError,
  type Project,
  type S5ToS6Projection,
  type S6AcceptanceEvent,
  type S6AcceptanceResult,
  type S6ConcurrencyToken,
  type S6CorrectionEvent,
  type S6CorrectionOperation,
  type S6IdempotencyOperation,
  type S6IdempotencyState,
  type S6JobState,
  type S6MutationResult,
  type S6PublicRevision,
  type S6PublicSpatialModel,
  type S6PublicState,
  type S6RenderResult,
  type S6RevisionSummary,
  type S6SpatialModelRecord,
  type S6SupersessionEvent,
  type S6Telemetry,
  type S6ToS7Handoff,
  type S6ValidationReceipt,
  type S6ViewArtifact,
  type S6ViewId,
  type S6ViewPreservationReceipt,
  type S6ViewSummary,
  type Sha256,
  type StoreState,
  type Timestamp,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { assertUuid, cloneJson, newUuid, nowUtc, sha256 } from "./utils";
import {
  canonicalS6Json,
  hashS6Model,
  S6_MAX_REVISIONS_PER_PROJECT,
  S6_RENDERER_VERSION,
} from "./s6-canonical";
import { compileS6Draft } from "./s6-compiler";
import { applyS6Corrections, canonicalS6CorrectionOperations } from "./s6-correction";
import { buildS6Cameras } from "./s6-camera";
import { renderS6View } from "./s6-renderer";
import { checkS6ViewPreservation } from "./s6-preservation";
import { validateS6Model } from "./s6-validation";
import { type S6SourceReader } from "./s6-source";
import {
  canonicalS6ModelBytes,
  promoteS6Exact,
  readS6CommittedExact,
  s6ModelStorageKeys,
  s6ViewFileName,
  s6ViewStorageKeys,
} from "./s6-publication";
import { buildS6Telemetry } from "./s6-telemetry";
import { buildS6ToS7Handoff } from "./s6-handoff";

export type S6PublicationPhaseHook = (phase: string, artifact: S6ViewArtifact) => void;

export type S6WorkflowServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  sourceReader: S6SourceReader;
  clock?: () => Timestamp;
  uuid?: () => UUID;
  workerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onPublicationPhase?: S6PublicationPhaseHook;
};

const VIEW_IDS: readonly S6ViewId[] = [
  "perspective-northwest",
  "perspective-southeast",
  "top-orthographic",
];

function fail(status: number, code: string, field = "request"): never {
  throw new AppError(status, code, [{ field, code }]);
}

function projectIn(state: StoreState, projectId: UUID): Project {
  if (!state.projects.some((item) => item.projectId === projectId)) return fail(404, "S6_UNAUTHORIZED_OR_NOT_FOUND");
  return state.projects.find((item) => item.projectId === projectId)!;
}

function sameNullable(left: UUID | Sha256 | null, right: UUID | Sha256 | null): boolean {
  return left === right;
}

function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.message.split(":")[0] ?? "S6_INTERNAL_ERROR";
  return "S6_INTERNAL_ERROR";
}

function mapError(error: unknown, fallbackCode: string, fallbackStatus = 422): never {
  if (error instanceof AppError) throw error;
  const code = errorCode(error);
  const known: Record<string, number> = {
    S6_SOURCE_NOT_READY: 409,
    S6_SOURCE_STALE: 409,
    S6_REVISION_CONFLICT: 409,
    S6_ACCEPTANCE_CONFLICT: 409,
    S6_IDEMPOTENCY_KEY_REUSE: 409,
    S6_CLAIM_FENCED: 409,
    S6_PUBLICATION_BUSY: 409,
    S6_STALE_ARTIFACT: 409,
    S6_RETRY_EXHAUSTED: 409,
    S6_UNSUPPORTED_FORM: 422,
    S6_DESIGN_FORM_UNREVIEWED: 422,
    S6_GEOMETRY_UNRESOLVED: 422,
    S6_PROFILE_INVALID: 422,
    S6_PROFILE_SELF_INTERSECTION: 422,
    S6_PROFILE_TOO_COMPLEX: 422,
    S6_CORRECTION_INVALID: 422,
    S6_CORRECTION_GEOMETRY_NOT_ALLOWED: 422,
    S6_HARD_FACT_IMMUTABLE: 422,
    S6_OBJECT_NOT_FOUND: 404,
    S6_UNKNOWN_NOT_FOUND: 404,
    PAYLOAD_TOO_LARGE: 422,
    PERSISTENCE_FAILED: 500,
    PUBLICATION_OBJECT_MISMATCH: 500,
    S6_PUBLICATION_FAILED: 500,
    S6_VIEW_RENDER_FAILURE: 500,
  };
  return fail(known[code] ?? fallbackStatus, known[code] === undefined ? fallbackCode : code);
}

function modelFor(state: StoreState, projectId: UUID, revisionId: UUID): S6SpatialModelRecord {
  const model = state.s6SpatialModels.find((item) => item.projectId === projectId && item.modelRevisionId === revisionId);
  if (!model) return fail(404, "S6_UNAUTHORIZED_OR_NOT_FOUND", "revisionId");
  return model;
}

function currentAccepted(state: StoreState, projectId: UUID, sourceFingerprint: Sha256): S6SpatialModelRecord | null {
  return state.s6SpatialModels.find((item) =>
    item.projectId === projectId &&
    item.status === "accepted_current" &&
    item.sourceS5Fingerprint === sourceFingerprint,
  ) ?? null;
}

function latestEditable(state: StoreState, projectId: UUID, sourceFingerprint: Sha256): S6SpatialModelRecord | null {
  return state.s6SpatialModels
    .filter((item) =>
      item.projectId === projectId &&
      item.sourceS5Fingerprint === sourceFingerprint &&
      (item.status === "generated_draft" || item.status === "corrected_draft"),
    )
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
}

function revisionSummary(model: S6SpatialModelRecord, receipts: readonly S6ValidationReceipt[]): S6RevisionSummary {
  const receipt = receipts
    .filter((item) => item.revisionId === model.modelRevisionId && item.revisionHash === model.modelHash)
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0] ?? null;
  return {
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    parentRevisionId: model.parentRevisionId,
    status: model.status,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    objectCount: model.objects.length,
    zoneCount: model.zones.length,
    unknownCount: model.unknowns.length,
    validationOutcome: receipt?.outcome ?? null,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function viewSummary(artifact: S6ViewArtifact, receipts: readonly S6ViewPreservationReceipt[]): S6ViewSummary {
  const receipt = artifact.preservationReceiptId === null
    ? null
    : receipts.find((item) => item.receiptId === artifact.preservationReceiptId) ?? null;
  return {
    viewId: artifact.viewId,
    revisionId: artifact.revisionId,
    revisionHash: artifact.revisionHash,
    purpose: artifact.purpose,
    status: artifact.status,
    rendererVersion: artifact.rendererVersion,
    preservationOutcome: receipt?.outcome ?? null,
    outputSha256: artifact.outputSha256,
    outputByteSize: artifact.outputByteSize,
  };
}

function modelPublic(model: S6SpatialModelRecord): S6PublicSpatialModel {
  const value = cloneJson(model) as S6PublicSpatialModel;
  value.modelArtifact = {
    sha256: model.modelArtifact.sha256,
    byteSize: model.modelArtifact.byteSize,
    status: model.modelArtifact.status,
  };
  return value;
}

function operationHash(operation: S6IdempotencyOperation, projectId: UUID, sourceFingerprint: Sha256, input: unknown): Sha256 {
  return sha256(canonicalS6Json({ operation, projectId, sourceFingerprint, input }));
}

function jobBase(
  projectId: UUID,
  jobId: UUID,
  kind: S6JobState["kind"],
  revisionId: UUID | null,
  viewId: S6ViewId | null,
  sourceFingerprint: Sha256,
  inputHash: Sha256,
  idempotencyKey: UUID,
  requestReferenceId: UUID,
  at: Timestamp,
): S6JobState {
  return {
    schemaVersion: "s6-job-state-v1",
    jobId,
    projectId,
    kind,
    revisionId,
    viewId,
    sourceS5Fingerprint: sourceFingerprint,
    inputHash,
    attempt: 1,
    retryOfJobId: null,
    status: "running",
    publicationPhase: "none",
    artifactId: null,
    workerId: null,
    processId: null,
    claimToken: null,
    claimedAt: null,
    startedAt: null,
    stagedAt: null,
    promotedAt: null,
    completedAt: null,
    terminalAt: null,
    failureCode: null,
    idempotencyKey,
    requestReferenceId,
    createdAt: at,
    updatedAt: at,
  };
}

function activePublicationJob(state: StoreState, artifactId: UUID): S6JobState | null {
  return state.s6Jobs
    .filter((item) =>
      item.kind === "publication" &&
      item.artifactId === artifactId &&
      (item.status === "queued" || item.status === "running" || item.status === "staged" || item.status === "promoted"),
    )
    .sort((left, right) => right.attempt - left.attempt || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function cloneWithHash(model: S6SpatialModelRecord): S6SpatialModelRecord {
  const hashed = hashS6Model(model);
  return { ...model, modelHash: hashed.modelHash, canonicalByteSize: hashed.canonicalByteSize };
}

function hasUnsupportedFormBlock(model: S6SpatialModelRecord): boolean {
  return model.designFormReview.status === "unsupported" ||
    model.unknowns.some((item) => item.kind === "design_form" && item.status === "unresolved" && item.question.includes("S6_UNSUPPORTED_FORM"));
}

function reviewReady(model: S6SpatialModelRecord): boolean {
  return model.designFormReview.status === "complete" &&
    model.designFormReview.acceptedByUser &&
    model.designFormReview.unresolvedUnknownIds.length === 0 &&
    !model.unknowns.some((item) => item.kind === "design_form" && item.status === "unresolved") &&
    !hasUnsupportedFormBlock(model);
}

function fixedViewId(value: S6ViewId): S6ViewId {
  if (!VIEW_IDS.includes(value)) return fail(400, "S6_INVALID_REQUEST", "viewId");
  return value;
}

export class S6WorkflowService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly sourceReader: S6SourceReader;
  private readonly clock: () => Timestamp;
  private readonly uuid: () => UUID;
  private readonly workerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly onPublicationPhase: S6PublicationPhaseHook | undefined;

  constructor(options: S6WorkflowServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.sourceReader = options.sourceReader;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.processId = options.processId ?? process.pid;
    this.workerId = options.workerId ?? "s6-process-" + String(this.processId) + "-" + this.uuid();
    this.isProcessAlive = options.isProcessAlive ?? (() => true);
    this.onPublicationPhase = options.onPublicationPhase;
    this.recoverPending();
  }

  private source(projectId: UUID): S5ToS6Projection {
    try {
      return this.sourceReader.readReady(projectId);
    } catch (error) {
      if (error instanceof AppError && (error.code === "S6_SOURCE_NOT_READY" || error.code === "S6_SOURCE_STALE")) throw error;
      return fail(409, "S6_SOURCE_NOT_READY");
    }
  }

  private currentSource(projectId: UUID, fingerprint: Sha256): S5ToS6Projection {
    try {
      return this.sourceReader.assertCurrent(projectId, fingerprint);
    } catch (error) {
      if (error instanceof AppError && (error.code === "S6_SOURCE_NOT_READY" || error.code === "S6_SOURCE_STALE")) throw error;
      return fail(409, "S6_SOURCE_STALE");
    }
  }

  private sourceState(projectId: UUID): S6PublicState["source"] {
    try {
      const source = this.sourceReader.readReady(projectId);
      return {
        readiness: "ready",
        sourceS5Fingerprint: source.sourceFingerprint,
        approvalEventId: source.approvalEventId,
        approvalGeneration: source.approvalGeneration,
      };
    } catch {
      return { readiness: "not_ready", sourceS5Fingerprint: null, approvalEventId: null, approvalGeneration: null };
    }
  }

  private idempotencyIn(state: StoreState, key: UUID, operation: S6IdempotencyOperation, projectId: UUID, inputHash: Sha256): S6IdempotencyState | null {
    const existing = state.s6Idempotency.find((item) => item.key === key);
    if (!existing) return null;
    if (existing.operation !== operation || existing.projectId !== projectId || existing.inputHash !== inputHash) return fail(409, "S6_IDEMPOTENCY_KEY_REUSE");
    return existing;
  }

  private remember(state: StoreState, key: UUID, operation: S6IdempotencyOperation, projectId: UUID, sourceFingerprint: Sha256, inputHash: Sha256, result: S6IdempotencyState["result"]): void {
    state.s6Idempotency.push({
      schemaVersion: "s6-idempotency-v1",
      key,
      operation,
      projectId,
      inputHash,
      sourceS5Fingerprint: sourceFingerprint,
      result: cloneJson(result),
      createdAt: this.clock(),
    });
  }

  private tokenFor(state: StoreState, model: S6SpatialModelRecord, sourceFingerprint: Sha256): S6ConcurrencyToken {
    const accepted = currentAccepted(state, model.projectId, sourceFingerprint);
    return {
      expectedRevisionId: model.modelRevisionId,
      expectedRevisionHash: model.modelHash,
      expectedParentRevisionId: model.parentRevisionId,
      expectedParentHash: model.parentRevisionHash,
      expectedCurrentAcceptedRevisionId: accepted?.modelRevisionId ?? null,
      expectedCurrentAcceptedHash: accepted?.modelHash ?? null,
      expectedSourceFingerprint: sourceFingerprint,
    };
  }

  private assertToken(state: StoreState, model: S6SpatialModelRecord, token: S6ConcurrencyToken, sourceFingerprint: Sha256, acceptanceSensitive = false): void {
    if (token.expectedSourceFingerprint !== sourceFingerprint || model.sourceS5Fingerprint !== sourceFingerprint) return fail(409, "S6_SOURCE_STALE", "expectedSourceFingerprint");
    if (token.expectedRevisionId !== model.modelRevisionId || token.expectedRevisionHash !== model.modelHash || !sameNullable(token.expectedParentRevisionId, model.parentRevisionId) || !sameNullable(token.expectedParentHash, model.parentRevisionHash)) return fail(409, "S6_REVISION_CONFLICT", "expectedRevisionHash");
    const accepted = currentAccepted(state, model.projectId, sourceFingerprint);
    if (!sameNullable(token.expectedCurrentAcceptedRevisionId, accepted?.modelRevisionId ?? null) || !sameNullable(token.expectedCurrentAcceptedHash, accepted?.modelHash ?? null)) return fail(409, acceptanceSensitive ? "S6_ACCEPTANCE_CONFLICT" : "S6_REVISION_CONFLICT", "expectedCurrentAcceptedRevisionId");
  }

  private publicMutation(state: StoreState, model: S6SpatialModelRecord, sourceFingerprint: Sha256, replayed = false): S6MutationResult {
    const accepted = currentAccepted(state, model.projectId, sourceFingerprint);
    return {
      replayed,
      revisionId: model.modelRevisionId,
      revisionHash: model.modelHash,
      status: model.status,
      sourceS5Fingerprint: sourceFingerprint,
      currentAcceptedRevisionId: accepted?.modelRevisionId ?? null,
      currentAcceptedRevisionHash: accepted?.modelHash ?? null,
      concurrency: this.tokenFor(state, model, sourceFingerprint),
    };
  }

  private revisionPublic(state: StoreState, projectId: UUID, revisionId: UUID): S6PublicRevision {
    const model = modelFor(state, projectId, revisionId);
    const receipts = state.s6ValidationReceipts.filter((item) => item.revisionId === revisionId && item.revisionHash === model.modelHash);
    const views = state.s6ViewArtifacts.filter((item) => item.revisionId === revisionId).map((item) => viewSummary(item, state.s6ViewPreservationReceipts));
    return { revision: modelPublic(model), validation: receipts.sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0] ?? null, views };
  }

  getState(projectId: UUID): S6PublicState {
    const state = this.repository.state();
    projectIn(state, projectId);
    const source = this.sourceState(projectId);
    const fingerprint = source.sourceS5Fingerprint;
    const revisions = fingerprint === null
      ? []
      : state.s6SpatialModels.filter((item) => item.projectId === projectId && item.sourceS5Fingerprint === fingerprint);
    const accepted = fingerprint === null ? null : currentAccepted(state, projectId, fingerprint);
    const editable = fingerprint === null ? null : latestEditable(state, projectId, fingerprint);
    const views = state.s6ViewArtifacts.filter((item) => item.projectId === projectId && (fingerprint === null || item.sourceS5Fingerprint === fingerprint)).map((item) => viewSummary(item, state.s6ViewPreservationReceipts));
    return {
      projectId,
      source,
      currentAcceptedRevisionId: accepted?.modelRevisionId ?? null,
      currentAcceptedRevisionHash: accepted?.modelHash ?? null,
      editableRevision: editable ? revisionSummary(editable, state.s6ValidationReceipts) : null,
      revisions: revisions.sort((left, right) => left.revisionNumber - right.revisionNumber).map((item) => revisionSummary(item, state.s6ValidationReceipts)),
      views: fingerprint === null ? [] : views,
      concurrency: editable ? this.tokenFor(state, editable, fingerprint!) : accepted ? this.tokenFor(state, accepted, fingerprint!) : null,
    };
  }

  getRevision(projectId: UUID, revisionId: UUID): S6PublicRevision {
    const state = this.repository.state();
    projectIn(state, projectId);
    const model = modelFor(state, projectId, revisionId);
    this.currentSource(projectId, model.sourceS5Fingerprint);
    return this.revisionPublic(state, projectId, revisionId);
  }

  private writeModel(model: S6SpatialModelRecord): Buffer {
    return canonicalS6ModelBytes(model);
  }

  private async createChild(
    parent: S6SpatialModelRecord,
    operations: S6CorrectionOperation[],
    key: UUID,
    referenceId: UUID,
    actorSubjectId: string,
    source: S5ToS6Projection,
    operation: "correction" | "reopen",
  ): Promise<S6MutationResult> {
    const state = this.repository.state();
    const normalizedOperations = canonicalS6CorrectionOperations(operations);
    const inputHash = operationHash(operation, parent.projectId, source.sourceFingerprint, {
      token: this.tokenFor(state, parent, source.sourceFingerprint),
      operations: normalizedOperations,
    });
    const existing = this.idempotencyIn(state, key, operation, parent.projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6MutationResult), replayed: true };
    const childRevisionId = this.uuid();
    const eventId = this.uuid();
    const childJobId = this.uuid();
    const claimToken = this.uuid();
    try {
      const applied = applyS6Corrections(parent, operations, {
        childRevisionId,
        clock: this.clock,
        actorSubjectId,
        correctionEventId: eventId,
        idempotencyKey: key,
        requestReferenceId: referenceId,
      });
      let child = applied.model;
      const event: S6CorrectionEvent = applied.event;
      child.cameras = buildS6Cameras(child);
      child = cloneWithHash(child);
      event.childRevisionHash = child.modelHash;
      const keys = s6ModelStorageKeys(parent.projectId, childRevisionId, childJobId, claimToken);
      child.modelArtifact = { artifactKey: keys.artifactKey, stagingKey: keys.stagingKey, sha256: null, byteSize: null, status: "not_written" };
      const bytes = this.writeModel(child);
      this.currentSource(parent.projectId, source.sourceFingerprint);
      this.objects.putExact(keys.stagingKey, bytes);
      promoteS6Exact(this.objects, keys.stagingKey, keys.artifactKey, bytes);
      child.modelArtifact.sha256 = sha256(bytes);
      child.modelArtifact.byteSize = bytes.byteLength;
      child.modelArtifact.status = "committed";
      const result = this.repository.transact((nextState) => {
        const currentParent = modelFor(nextState, parent.projectId, parent.modelRevisionId);
        this.assertToken(nextState, currentParent, this.tokenFor(state, parent, source.sourceFingerprint), source.sourceFingerprint);
        if (operation === "reopen") {
          if (currentParent.status !== "accepted_current" || currentAccepted(nextState, parent.projectId, source.sourceFingerprint)?.modelRevisionId !== currentParent.modelRevisionId) return fail(409, "S6_ACCEPTANCE_CONFLICT");
        } else if (currentParent.status !== "generated_draft" && currentParent.status !== "corrected_draft") {
          return fail(409, "S6_REVISION_CONFLICT");
        }
        if (nextState.s6SpatialModels.some((item) => item.parentRevisionId === currentParent.modelRevisionId && item.status !== "stale" && item.status !== "aborted" && item.status !== "rejected")) return fail(409, "S6_REVISION_CONFLICT");
        if (nextState.s6SpatialModels.filter((item) => item.projectId === parent.projectId).length >= S6_MAX_REVISIONS_PER_PROJECT) return fail(422, "S6_SPATIAL_SCHEMA_INVALID");
        nextState.s6SpatialModels.push(child);
        nextState.s6CorrectionEvents.push(event);
        const value = this.publicMutation(nextState, child, source.sourceFingerprint);
        this.remember(nextState, key, operation, parent.projectId, source.sourceFingerprint, inputHash, value);
        return value;
      });
      this.objects.remove(keys.stagingKey);
      return result;
    } catch (error) {
      return mapError(error, "S6_GEOMETRY_INVALID");
    }
  }

  async generate(projectId: UUID, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const inputHash = operationHash("generation", projectId, source.sourceFingerprint, { request: {}, actorIndependent: true });
    const firstState = this.repository.state();
    projectIn(firstState, projectId);
    const existing = this.idempotencyIn(firstState, key, "generation", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6MutationResult), replayed: true };
    if (typeof actorSubjectId !== "string" || !actorSubjectId.trim()) return fail(400, "S6_INVALID_REQUEST", "actorSubjectId");
    if (currentAccepted(firstState, projectId, source.sourceFingerprint) || latestEditable(firstState, projectId, source.sourceFingerprint)) return fail(409, "S6_REVISION_CONFLICT");
    const revisionId = this.uuid();
    const jobId = this.uuid();
    const claimToken = this.uuid();
    try {
      let model = compileS6Draft({ source, revisionId, parentRevisionId: null, clock: this.clock });
      model.cameras = buildS6Cameras(model);
      model = cloneWithHash(model);
      const keys = s6ModelStorageKeys(projectId, revisionId, jobId, claimToken);
      model.modelArtifact = { artifactKey: keys.artifactKey, stagingKey: keys.stagingKey, sha256: null, byteSize: null, status: "not_written" };
      const at = this.clock();
      const job = jobBase(projectId, jobId, "generation", revisionId, null, source.sourceFingerprint, inputHash, key, referenceId, at);
      job.workerId = this.workerId;
      job.processId = this.processId;
      job.claimToken = claimToken;
      job.claimedAt = at;
      job.startedAt = at;
      this.repository.transact((state) => {
        projectIn(state, projectId);
        if (currentAccepted(state, projectId, source.sourceFingerprint) || latestEditable(state, projectId, source.sourceFingerprint)) return fail(409, "S6_REVISION_CONFLICT");
        state.s6SpatialModels.push(model);
        state.s6Jobs.push(job);
      });
      const bytes = this.writeModel(model);
      this.objects.putExact(keys.stagingKey, bytes);
      this.repository.transact((state) => {
        const currentModel = modelFor(state, projectId, revisionId);
        const currentJob = state.s6Jobs.find((item) => item.jobId === jobId);
        if (!currentJob || currentJob.claimToken !== claimToken) return fail(409, "S6_CLAIM_FENCED");
        currentModel.modelArtifact.sha256 = sha256(bytes);
        currentModel.modelArtifact.byteSize = bytes.byteLength;
        currentModel.modelArtifact.status = "staged";
        currentJob.status = "staged";
        currentJob.publicationPhase = "staged";
        currentJob.stagedAt = this.clock();
        currentJob.updatedAt = this.clock();
      });
      this.currentSource(projectId, source.sourceFingerprint);
      promoteS6Exact(this.objects, keys.stagingKey, keys.artifactKey, bytes);
      const result = this.repository.transact((state) => {
        const currentModel = modelFor(state, projectId, revisionId);
        const currentJob = state.s6Jobs.find((item) => item.jobId === jobId);
        if (!currentJob || currentJob.claimToken !== claimToken) return fail(409, "S6_CLAIM_FENCED");
        currentModel.modelArtifact.status = "committed";
        currentJob.status = "committed";
        currentJob.publicationPhase = "committed";
        currentJob.promotedAt = this.clock();
        currentJob.completedAt = this.clock();
        currentJob.claimToken = null;
        currentJob.workerId = null;
        currentJob.processId = null;
        currentJob.claimedAt = null;
        currentJob.updatedAt = this.clock();
        const value = this.publicMutation(state, currentModel, source.sourceFingerprint);
        this.remember(state, key, "generation", projectId, source.sourceFingerprint, inputHash, value);
        return value;
      });
      this.objects.remove(keys.stagingKey);
      return result;
    } catch (error) {
      return mapError(error, "S6_INTERNAL_ERROR", 500);
    }
  }

  async reopen(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const state = this.repository.state();
    projectIn(state, projectId);
    const parent = modelFor(state, projectId, revisionId);
    const inputHash = operationHash("reopen", projectId, source.sourceFingerprint, { token, operations: [] });
    const existing = this.idempotencyIn(state, key, "reopen", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6MutationResult), replayed: true };
    this.assertToken(state, parent, token, source.sourceFingerprint, true);
    if (parent.status !== "accepted_current" || currentAccepted(state, projectId, source.sourceFingerprint)?.modelRevisionId !== parent.modelRevisionId) return fail(409, "S6_ACCEPTANCE_CONFLICT");
    return this.createChild(parent, [], key, referenceId, actorSubjectId, source, "reopen");
  }

  async correct(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, operations: S6CorrectionOperation[], key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const state = this.repository.state();
    projectIn(state, projectId);
    const parent = modelFor(state, projectId, revisionId);
    const inputHash = operationHash("correction", projectId, source.sourceFingerprint, { token, operations: canonicalS6CorrectionOperations(operations) });
    const existing = this.idempotencyIn(state, key, "correction", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6MutationResult), replayed: true };
    this.assertToken(state, parent, token, source.sourceFingerprint);
    if (parent.status !== "generated_draft" && parent.status !== "corrected_draft") return fail(409, "S6_REVISION_CONFLICT");
    return this.createChild(parent, operations, key, referenceId, actorSubjectId, source, "correction");
  }

  async validate(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<S6ValidationReceipt> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const initial = this.repository.state();
    projectIn(initial, projectId);
    const model = modelFor(initial, projectId, revisionId);
    const inputHash = operationHash("validation", projectId, source.sourceFingerprint, { token });
    const existing = this.idempotencyIn(initial, key, "validation", projectId, inputHash);
    if (existing) return cloneJson(existing.result) as S6ValidationReceipt;
    this.assertToken(initial, model, token, source.sourceFingerprint);
    try {
      const priorModels = initial.s6SpatialModels.filter((item) => item.projectId === projectId).sort((left, right) => left.revisionNumber - right.revisionNumber);
      const receipt = validateS6Model(model, { source, priorModels, expectedSourceFingerprint: source.sourceFingerprint });
      receipt.receiptId = this.uuid();
      receipt.checkedAt = this.clock();
      receipt.validationHash = sha256(canonicalS6Json({ ...receipt, validationHash: "" }));
      const jobId = this.uuid();
      const at = this.clock();
      const job = jobBase(projectId, jobId, "validation", revisionId, null, source.sourceFingerprint, inputHash, key, referenceId, at);
      job.status = "committed";
      job.completedAt = at;
      const result = this.repository.transact((state) => {
        const current = modelFor(state, projectId, revisionId);
        this.assertToken(state, current, token, source.sourceFingerprint);
        current.validationReceiptId = receipt.receiptId;
        current.updatedAt = this.clock();
        state.s6ValidationReceipts.push(receipt);
        state.s6Jobs.push(job);
        this.remember(state, key, "validation", projectId, source.sourceFingerprint, inputHash, receipt);
        return receipt;
      });
      return cloneJson(result);
    } catch (error) {
      return mapError(error, "S6_GEOMETRY_INVALID");
    }
  }

  private acceptanceGate(model: S6SpatialModelRecord, receipt: S6ValidationReceipt | null): void {
    if (!receipt || receipt.revisionHash !== model.modelHash || (receipt.outcome !== "pass" && receipt.outcome !== "pass_with_warnings") || receipt.errors.length > 0) return fail(422, "S6_GEOMETRY_INVALID");
    if (!reviewReady(model)) {
      if (hasUnsupportedFormBlock(model)) return fail(422, "S6_UNSUPPORTED_FORM");
      return fail(422, "S6_DESIGN_FORM_UNREVIEWED");
    }
  }

  async accept(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6AcceptanceResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const initial = this.repository.state();
    projectIn(initial, projectId);
    const model = modelFor(initial, projectId, revisionId);
    const inputHash = operationHash("acceptance", projectId, source.sourceFingerprint, { token });
    const existing = this.idempotencyIn(initial, key, "acceptance", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6AcceptanceResult), replayed: true };
    if (typeof actorSubjectId !== "string" || !actorSubjectId.trim()) return fail(400, "S6_INVALID_REQUEST", "actorSubjectId");
    this.assertToken(initial, model, token, source.sourceFingerprint, true);
    if (model.status !== "generated_draft" && model.status !== "corrected_draft") return fail(409, "S6_ACCEPTANCE_CONFLICT");
    const receipt = model.validationReceiptId === null ? null : initial.s6ValidationReceipts.find((item) => item.receiptId === model.validationReceiptId) ?? null;
    this.acceptanceGate(model, receipt);
    try {
      const acceptanceEventId = this.uuid();
      const supersessionEventId = this.uuid();
      const at = this.clock();
      const result = this.repository.transact((state) => {
        const candidate = modelFor(state, projectId, revisionId);
        this.assertToken(state, candidate, token, source.sourceFingerprint, true);
        if (candidate.status !== "generated_draft" && candidate.status !== "corrected_draft") return fail(409, "S6_ACCEPTANCE_CONFLICT");
        const candidateReceipt = candidate.validationReceiptId === null ? null : state.s6ValidationReceipts.find((item) => item.receiptId === candidate.validationReceiptId) ?? null;
        this.acceptanceGate(candidate, candidateReceipt);
        const prior = currentAccepted(state, projectId, source.sourceFingerprint);
        candidate.status = "accepted_current";
        candidate.acceptanceEventId = acceptanceEventId;
        candidate.acceptedAt = at;
        candidate.updatedAt = at;
        const acceptance: S6AcceptanceEvent = {
          schemaVersion: "s6-acceptance-event-v1",
          acceptanceEventId,
          projectId,
          revisionId,
          revisionHash: candidate.modelHash,
          sourceS5Fingerprint: source.sourceFingerprint,
          priorAcceptedRevisionId: prior?.modelRevisionId ?? null,
          priorAcceptedRevisionHash: prior?.modelHash ?? null,
          actorSubjectId,
          expectedCurrentAcceptedRevisionId: token.expectedCurrentAcceptedRevisionId,
          expectedCurrentAcceptedHash: token.expectedCurrentAcceptedHash,
          idempotencyKey: key,
          requestReferenceId: referenceId,
          occurredAt: at,
        };
        state.s6AcceptanceEvents.push(acceptance);
        if (prior) {
          prior.status = "superseded";
          prior.supersededAt = at;
          prior.updatedAt = at;
          const supersession: S6SupersessionEvent = {
            schemaVersion: "s6-supersession-event-v1",
            supersessionEventId,
            projectId,
            supersededRevisionId: prior.modelRevisionId,
            supersededRevisionHash: prior.modelHash,
            replacementRevisionId: candidate.modelRevisionId,
            replacementRevisionHash: candidate.modelHash,
            sourceS5Fingerprint: source.sourceFingerprint,
            acceptanceEventId,
            actorSubjectId,
            requestReferenceId: referenceId,
            occurredAt: at,
          };
          state.s6SupersessionEvents.push(supersession);
        }
        const mutation = this.publicMutation(state, candidate, source.sourceFingerprint);
        const value: S6AcceptanceResult = { ...mutation, acceptanceEventId };
        this.remember(state, key, "acceptance", projectId, source.sourceFingerprint, inputHash, value);
        return value;
      });
      return result;
    } catch (error) {
      return mapError(error, "S6_ACCEPTANCE_CONFLICT", 409) as never;
    }
  }

  async render(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<S6RenderResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const source = this.source(projectId);
    const initial = this.repository.state();
    projectIn(initial, projectId);
    const model = modelFor(initial, projectId, revisionId);
    this.assertToken(initial, model, token, source.sourceFingerprint);
    if (model.status !== "accepted_current" && model.status !== "generated_draft" && model.status !== "corrected_draft") return fail(409, "S6_REVISION_CONFLICT");
    const purpose: S6ViewArtifact["purpose"] = model.status === "accepted_current" ? "accepted_view" : "draft_preview";
    if (purpose === "accepted_view" && !reviewReady(model)) {
      if (hasUnsupportedFormBlock(model)) return fail(422, "S6_UNSUPPORTED_FORM");
      return fail(422, "S6_DESIGN_FORM_UNREVIEWED");
    }
    const inputHash = operationHash("render", projectId, source.sourceFingerprint, { token, purpose });
    const existing = this.idempotencyIn(initial, key, "render", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as S6RenderResult), replayed: true };
    try {
      const cameras = buildS6Cameras(model);
      const cameraByView = new Map(cameras.map((camera) => [camera.viewId, camera]));
      const rendered = VIEW_IDS.map((viewId) => {
        const camera = cameraByView.get(viewId);
        if (!camera) return fail(500, "S6_VIEW_RENDER_FAILURE");
        const value = renderS6View(model, camera);
        const preservation = checkS6ViewPreservation(model, camera, value);
        if (preservation.outcome !== "pass") return fail(422, "S6_VIEW_PRESERVATION_FAILED");
        return { camera, value, preservation };
      });
      const outputBytes = rendered.reduce((total, item) => total + item.value.svgBytes.byteLength, 0);
      if (outputBytes > 6_000_000) return fail(422, "S6_VIEW_RENDER_FAILURE");
      const artifactGroupId = this.uuid();
      const records = rendered.map((item) => {
        const artifactId = this.uuid();
        const jobId = this.uuid();
        const claimToken = this.uuid();
        const keys = s6ViewStorageKeys(projectId, revisionId, item.value.viewId, jobId, claimToken);
        const at = this.clock();
        const artifact: S6ViewArtifact = {
          schemaVersion: "s6-view-artifact-v1",
          artifactId,
          artifactGroupId,
          projectId,
          revisionId,
          revisionHash: model.modelHash,
          sourceS5Fingerprint: source.sourceFingerprint,
          viewId: item.value.viewId,
          purpose,
          rendererVersion: S6_RENDERER_VERSION,
          format: "svg",
          mimeType: "image/svg+xml",
          fileExtension: ".svg",
          fileName: s6ViewFileName(item.value.viewId),
          artifactKey: keys.artifactKey,
          stagingKey: keys.stagingKey,
          outputSha256: null,
          outputByteSize: null,
          cameraHash: item.camera.cameraHash,
          sceneHash: null,
          preservationReceiptId: item.preservation.receiptId,
          attempt: 1,
          retryOfArtifactId: null,
          status: "running",
          publicationPhase: "none",
          workerId: this.workerId,
          processId: this.processId,
          claimToken,
          claimedAt: at,
          startedAt: at,
          stagedAt: null,
          promotedAt: null,
          completedAt: null,
          terminalAt: null,
          failureCode: null,
          idempotencyKey: key,
          requestReferenceId: referenceId,
          createdAt: at,
          updatedAt: at,
        };
        const job = jobBase(projectId, jobId, "render", revisionId, item.value.viewId, source.sourceFingerprint, inputHash, key, referenceId, at);
        job.artifactId = artifactId;
        job.workerId = this.workerId;
        job.processId = this.processId;
        job.claimToken = claimToken;
        job.claimedAt = at;
        job.startedAt = at;
        return { artifact, job, bytes: Buffer.from(item.value.svgBytes), preservation: item.preservation };
      });
      this.repository.transact((state) => {
        const current = modelFor(state, projectId, revisionId);
        this.assertToken(state, current, token, source.sourceFingerprint);
        if (purpose === "accepted_view" && (current.status !== "accepted_current" || !reviewReady(current))) return fail(422, "S6_DESIGN_FORM_UNREVIEWED");
        for (const record of records) {
          state.s6ViewPreservationReceipts.push(record.preservation);
          state.s6ViewArtifacts.push(record.artifact);
          state.s6Jobs.push(record.job);
        }
      });
      for (const record of records) this.objects.putExact(record.artifact.stagingKey, record.bytes);
      this.currentSource(projectId, source.sourceFingerprint);
      const result = this.repository.transact((state) => {
        const current = modelFor(state, projectId, revisionId);
        this.assertToken(state, current, token, source.sourceFingerprint);
        const outputViews: S6ViewSummary[] = [];
        for (const record of records) {
          const artifact = state.s6ViewArtifacts.find((item) => item.artifactId === record.artifact.artifactId);
          const job = state.s6Jobs.find((item) => item.artifactId === record.artifact.artifactId);
          if (!artifact || !job || artifact.claimToken !== record.artifact.claimToken) return fail(409, "S6_CLAIM_FENCED");
          artifact.outputSha256 = sha256(record.bytes);
          artifact.outputByteSize = record.bytes.byteLength;
          artifact.sceneHash = record.preservation.sceneHash;
          artifact.status = "staged";
          artifact.publicationPhase = "staged";
          artifact.stagedAt = this.clock();
          artifact.updatedAt = this.clock();
          job.status = "staged";
          job.publicationPhase = "staged";
          job.stagedAt = artifact.stagedAt;
          job.updatedAt = artifact.updatedAt;
          outputViews.push(viewSummary(artifact, state.s6ViewPreservationReceipts));
        }
        const value: S6RenderResult = {
          replayed: false,
          revisionId,
          revisionHash: current.modelHash,
          sourceS5Fingerprint: source.sourceFingerprint,
          artifactGroupId,
          views: outputViews,
        };
        this.remember(state, key, "render", projectId, source.sourceFingerprint, inputHash, value);
        return value;
      });
      return result;
    } catch (error) {
      return mapError(error, "S6_VIEW_RENDER_FAILURE", 500);
    }
  }

  async publish(projectId: UUID, revisionId: UUID, viewId: S6ViewId, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<import("./types").S6PublicationResult> {
    assertUuid(key, "idempotencyKey");
    assertUuid(referenceId, "referenceId");
    const safeViewId = fixedViewId(viewId);
    const source = this.source(projectId);
    const initial = this.repository.state();
    projectIn(initial, projectId);
    const model = modelFor(initial, projectId, revisionId);
    this.assertToken(initial, model, token, source.sourceFingerprint, true);
    if (model.status !== "accepted_current" || currentAccepted(initial, projectId, source.sourceFingerprint)?.modelRevisionId !== revisionId) return fail(409, "S6_ACCEPTANCE_CONFLICT");
    if (!reviewReady(model)) return fail(422, "S6_DESIGN_FORM_UNREVIEWED");
    const inputHash = operationHash("publication", projectId, source.sourceFingerprint, { token, viewId: safeViewId });
    const existing = this.idempotencyIn(initial, key, "publication", projectId, inputHash);
    if (existing) return { ...(cloneJson(existing.result) as import("./types").S6PublicationResult), replayed: true };
    try {
      const artifact = initial.s6ViewArtifacts.find((item) => item.projectId === projectId && item.revisionId === revisionId && item.viewId === safeViewId && item.purpose === "accepted_view");
      if (!artifact) return fail(409, "S6_STALE_ARTIFACT");
      const preservation = artifact.preservationReceiptId === null ? null : initial.s6ViewPreservationReceipts.find((item) => item.receiptId === artifact.preservationReceiptId) ?? null;
      if (!preservation || preservation.outcome !== "pass") return fail(422, "S6_VIEW_PRESERVATION_FAILED");
      if (artifact.status === "committed" && artifact.publicationPhase === "committed") {
        const bytes = readS6CommittedExact(this.objects, artifact);
        if (sha256(bytes) !== artifact.outputSha256) return fail(409, "S6_STALE_ARTIFACT");
        const value: import("./types").S6PublicationResult = { replayed: false, artifactId: artifact.artifactId, revisionId, revisionHash: artifact.revisionHash, sourceS5Fingerprint: source.sourceFingerprint, view: viewSummary(artifact, initial.s6ViewPreservationReceipts) };
        this.repository.transact((state) => this.remember(state, key, "publication", projectId, source.sourceFingerprint, inputHash, value));
        return value;
      }
      if (artifact.status !== "staged" && artifact.status !== "promoted") return fail(409, "S6_PUBLICATION_BUSY");
      let publicationJob = activePublicationJob(initial, artifact.artifactId);
      if (publicationJob?.status === "running") return fail(409, "S6_PUBLICATION_BUSY");
      if (!publicationJob) {
        const prior = initial.s6Jobs
          .filter((item) =>
            item.kind === "publication" &&
            item.artifactId === artifact.artifactId &&
            (item.status === "failed_retryable" || item.status === "failed_terminal" || item.status === "aborted"),
          )
          .sort((left, right) => right.attempt - left.attempt || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
        if (prior?.attempt === 2) return fail(409, "S6_RETRY_EXHAUSTED");
        const at = this.clock();
        const created = jobBase(
          projectId,
          this.uuid(),
          "publication",
          revisionId,
          safeViewId,
          source.sourceFingerprint,
          inputHash,
          key,
          referenceId,
          at,
        );
        created.artifactId = artifact.artifactId;
        created.workerId = this.workerId;
        created.processId = this.processId;
        created.claimToken = this.uuid();
        created.claimedAt = at;
        created.startedAt = at;
        if (prior) {
          created.attempt = 2;
          created.retryOfJobId = prior.jobId;
        }
        publicationJob = this.repository.transact((state) => {
          const currentArtifact = state.s6ViewArtifacts.find((item) => item.artifactId === artifact.artifactId);
          const currentModel = modelFor(state, projectId, revisionId);
          this.assertToken(state, currentModel, token, source.sourceFingerprint, true);
          if (!currentArtifact || (currentArtifact.status !== "staged" && currentArtifact.status !== "promoted")) return fail(409, "S6_PUBLICATION_BUSY");
          const existingJob = activePublicationJob(state, artifact.artifactId);
          if (existingJob) return existingJob;
          state.s6Jobs.push(created);
          return created;
        });
      }
      if (publicationJob.status === "queued") {
        const claimToken = this.uuid();
        publicationJob = this.repository.transact((state) => {
          const current = state.s6Jobs.find((item) => item.jobId === publicationJob!.jobId);
          if (!current) return fail(409, "S6_CLAIM_FENCED");
          if (current.status !== "queued") return current;
          const at = this.clock();
          current.status = "running";
          current.publicationPhase = "none";
          current.workerId = this.workerId;
          current.processId = this.processId;
          current.claimToken = claimToken;
          current.claimedAt = at;
          current.startedAt = at;
          current.updatedAt = at;
          return current;
        });
      }
      if (publicationJob.claimToken === null) return fail(409, "S6_CLAIM_FENCED");
      const bytes = artifact.publicationPhase === "promoted" ? this.objects.read(artifact.artifactKey) : this.objects.read(artifact.stagingKey);
      if (artifact.outputSha256 === null || artifact.outputByteSize === null || sha256(bytes) !== artifact.outputSha256 || bytes.byteLength !== artifact.outputByteSize) return fail(500, "S6_PUBLICATION_FAILED");
      this.currentSource(projectId, source.sourceFingerprint);
      if (artifact.publicationPhase === "staged") {
        promoteS6Exact(this.objects, artifact.stagingKey, artifact.artifactKey, bytes);
        this.repository.transact((state) => {
          const currentArtifact = state.s6ViewArtifacts.find((item) => item.artifactId === artifact.artifactId);
          const currentJob = state.s6Jobs.find((item) => item.jobId === publicationJob!.jobId);
          const currentModel = modelFor(state, projectId, revisionId);
          this.assertToken(state, currentModel, token, source.sourceFingerprint, true);
          if (!currentArtifact || currentArtifact.claimToken !== artifact.claimToken || !currentJob || currentJob.claimToken !== publicationJob!.claimToken) return fail(409, "S6_CLAIM_FENCED");
          currentArtifact.status = "promoted";
          currentArtifact.publicationPhase = "promoted";
          currentArtifact.promotedAt = this.clock();
          currentArtifact.updatedAt = this.clock();
          if (currentJob) {
            currentJob.status = "promoted";
            currentJob.publicationPhase = "promoted";
            currentJob.promotedAt = currentArtifact.promotedAt;
            currentJob.updatedAt = currentArtifact.updatedAt;
          }
          this.onPublicationPhase?.("promoted", currentArtifact);
        });
      }
      this.currentSource(projectId, source.sourceFingerprint);
      const result = this.repository.transact((state) => {
        const currentArtifact = state.s6ViewArtifacts.find((item) => item.artifactId === artifact.artifactId);
        const currentJob = state.s6Jobs.find((item) => item.jobId === publicationJob!.jobId);
        const renderJob = state.s6Jobs.find((item) => item.artifactId === artifact.artifactId && item.kind === "render");
        const currentModel = modelFor(state, projectId, revisionId);
        this.assertToken(state, currentModel, token, source.sourceFingerprint, true);
        if (!currentArtifact || !currentJob || currentJob.claimToken !== publicationJob!.claimToken || currentArtifact.status !== "promoted" || currentArtifact.publicationPhase !== "promoted") return fail(409, "S6_CLAIM_FENCED");
        currentArtifact.status = "committed";
        currentArtifact.publicationPhase = "committed";
        currentArtifact.completedAt = this.clock();
        currentArtifact.updatedAt = this.clock();
        if (currentJob) {
          currentJob.status = "committed";
          currentJob.publicationPhase = "committed";
          currentJob.completedAt = currentArtifact.completedAt;
          currentJob.updatedAt = currentArtifact.updatedAt;
          currentJob.claimToken = null;
          currentJob.workerId = null;
          currentJob.processId = null;
          currentJob.claimedAt = null;
        }
        if (renderJob) {
          renderJob.status = "committed";
          renderJob.publicationPhase = "committed";
          renderJob.completedAt = currentArtifact.completedAt;
          renderJob.updatedAt = currentArtifact.updatedAt;
          renderJob.claimToken = null;
          renderJob.workerId = null;
          renderJob.processId = null;
          renderJob.claimedAt = null;
        }
        const value: import("./types").S6PublicationResult = {
          replayed: false,
          artifactId: currentArtifact.artifactId,
          revisionId,
          revisionHash: currentArtifact.revisionHash,
          sourceS5Fingerprint: source.sourceFingerprint,
          view: viewSummary(currentArtifact, state.s6ViewPreservationReceipts),
        };
        this.remember(state, key, "publication", projectId, source.sourceFingerprint, inputHash, value);
        this.onPublicationPhase?.("committed", currentArtifact);
        return value;
      });
      this.objects.remove(artifact.stagingKey);
      return result;
    } catch (error) {
      return mapError(error, "S6_PUBLICATION_FAILED", 500);
    }
  }

  private committedArtifact(
    projectId: UUID,
    revisionId: UUID,
    viewId: S6ViewId,
  ): { model: S6SpatialModelRecord; artifact: S6ViewArtifact; source: S5ToS6Projection } {
    const state = this.repository.state();
    projectIn(state, projectId);
    const model = modelFor(state, projectId, revisionId);
    const source = this.currentSource(projectId, model.sourceS5Fingerprint);
    const artifact = state.s6ViewArtifacts.find((item) =>
      item.projectId === projectId &&
      item.revisionId === revisionId &&
      item.viewId === viewId &&
      item.status === "committed"
    );
    if (!artifact) return fail(404, "S6_UNAUTHORIZED_OR_NOT_FOUND", "viewId");
    if (model.sourceS5Fingerprint !== source.sourceFingerprint || artifact.revisionHash !== model.modelHash) return fail(409, "S6_STALE_ARTIFACT");
    if (artifact.purpose === "accepted_view") {
      if (model.status !== "accepted_current" || currentAccepted(state, projectId, source.sourceFingerprint)?.modelRevisionId !== model.modelRevisionId) return fail(409, "S6_STALE_ARTIFACT");
    } else if (model.status !== "generated_draft" && model.status !== "corrected_draft") {
      return fail(409, "S6_STALE_ARTIFACT");
    }
    const receipt = artifact.preservationReceiptId === null
      ? null
      : state.s6ViewPreservationReceipts.find((item) => item.receiptId === artifact.preservationReceiptId) ?? null;
    if (!receipt || receipt.outcome !== "pass") return fail(409, "S6_STALE_ARTIFACT");
    return { model, artifact, source };
  }

  getView(projectId: UUID, revisionId: UUID, viewId: S6ViewId): import("./types").S6PublicViewArtifact {
    const safeViewId = fixedViewId(viewId);
    const state = this.repository.state();
    const access = this.committedArtifact(projectId, revisionId, safeViewId);
    const bytes = readS6CommittedExact(this.objects, access.artifact);
    const receipt = access.artifact.preservationReceiptId === null
      ? null
      : state.s6ViewPreservationReceipts.find((item) => item.receiptId === access.artifact.preservationReceiptId) ?? null;
    if (!receipt || access.artifact.sceneHash === null) return fail(409, "S6_STALE_ARTIFACT");
    return {
      ...viewSummary(access.artifact, state.s6ViewPreservationReceipts),
      artifactId: access.artifact.artifactId,
      artifactGroupId: access.artifact.artifactGroupId,
      cameraHash: access.artifact.cameraHash,
      sceneHash: access.artifact.sceneHash,
      preservationReceiptId: receipt.receiptId,
      downloadPath: "/projects/" + projectId + "/s6/revisions/" + revisionId + "/views/" + safeViewId + "/download",
      outputSha256: sha256(bytes),
      outputByteSize: bytes.byteLength,
    };
  }

  getViewDownload(projectId: UUID, revisionId: UUID, viewId: S6ViewId): { bytes: Buffer; contentType: "image/svg+xml"; fileName: string } {
    const safeViewId = fixedViewId(viewId);
    const access = this.committedArtifact(projectId, revisionId, safeViewId);
    const bytes = readS6CommittedExact(this.objects, access.artifact);
    return { bytes, contentType: "image/svg+xml", fileName: access.artifact.fileName };
  }

  getTelemetry(projectId: UUID): S6Telemetry {
    const state = this.repository.state();
    projectIn(state, projectId);
    return buildS6Telemetry(state, projectId, this.sourceState(projectId));
  }

  getS7Handoff(projectId: UUID): S6ToS7Handoff {
    const source = this.source(projectId);
    const state = this.repository.state();
    projectIn(state, projectId);
    const model = currentAccepted(state, projectId, source.sourceFingerprint);
    if (!model) return fail(409, "S6_ACCEPTANCE_CONFLICT");
    const receipt = model.validationReceiptId === null
      ? null
      : state.s6ValidationReceipts.find((item) => item.receiptId === model.validationReceiptId) ?? null;
    if (!receipt) return fail(409, "S6_ACCEPTANCE_CONFLICT");
    return buildS6ToS7Handoff(model, receipt, source);
  }

  private ownerIsLive(job: S6JobState): boolean {
    if (job.status !== "running") return false;
    if (job.processId === null || job.claimToken === null) return true;
    try {
      return this.isProcessAlive(job.processId);
    } catch {
      return true;
    }
  }

  private recoverPending(): void {
    const pending = this.repository.state().s6Jobs.filter((item) => item.status === "running" || item.status === "staged" || item.status === "promoted");
    for (const job of pending) {
      if (job.status === "running") {
        if (this.ownerIsLive(job)) continue;
        this.repository.transact((state) => {
          const current = state.s6Jobs.find((item) => item.jobId === job.jobId && item.claimToken === job.claimToken);
          if (!current || current.status !== "running") return;
          const at = this.clock();
          current.status = current.attempt === 1 ? "failed_retryable" : "failed_terminal";
          current.publicationPhase = "aborted";
          current.failureCode = "S6_PUBLICATION_UNCERTAIN";
          current.terminalAt = at;
          current.updatedAt = at;
          current.claimToken = null;
          current.workerId = null;
          current.processId = null;
          current.claimedAt = null;
          if (current.attempt === 1) {
            state.s6Jobs.push({
              ...cloneJson(current),
              jobId: this.uuid(),
              attempt: 2,
              retryOfJobId: current.jobId,
              status: "queued",
              publicationPhase: "none",
              failureCode: null,
              terminalAt: null,
              updatedAt: this.clock(),
            });
          }
        });
        continue;
      }
      if (job.kind !== "publication") continue;
      const artifact = job.artifactId === null
        ? null
        : this.repository.state().s6ViewArtifacts.find((item) => item.artifactId === job.artifactId) ?? null;
      if (!artifact) continue;
      this.recoverViewJob(job, artifact);
    }
  }

  private recoverViewJob(job: S6JobState, artifact: S6ViewArtifact): void {
    try {
      const source = this.currentSource(job.projectId, job.sourceS5Fingerprint);
      const state = this.repository.state();
      const model = modelFor(state, job.projectId, job.revisionId!);
      if (model.status !== "accepted_current" || currentAccepted(state, job.projectId, source.sourceFingerprint)?.modelRevisionId !== model.modelRevisionId) throw new Error("S6_SOURCE_STALE");
      if (artifact.outputSha256 === null || artifact.outputByteSize === null) throw new Error("S6_PUBLICATION_UNCERTAIN");
      const bytes = artifact.publicationPhase === "promoted" ? this.objects.read(artifact.artifactKey) : this.objects.read(artifact.stagingKey);
      if (sha256(bytes) !== artifact.outputSha256 || bytes.byteLength !== artifact.outputByteSize) throw new Error("S6_PUBLICATION_UNCERTAIN");
      if (artifact.publicationPhase === "staged") promoteS6Exact(this.objects, artifact.stagingKey, artifact.artifactKey, bytes);
      this.repository.transact((nextState) => {
        const currentArtifact = nextState.s6ViewArtifacts.find((item) => item.artifactId === artifact.artifactId);
        const currentJob = nextState.s6Jobs.find((item) => item.jobId === job.jobId);
        const renderJob = nextState.s6Jobs.find((item) => item.artifactId === artifact.artifactId && item.kind === "render");
        if (!currentArtifact || !currentJob) return fail(409, "S6_CLAIM_FENCED");
        currentArtifact.status = "committed";
        currentArtifact.publicationPhase = "committed";
        currentArtifact.promotedAt = this.clock();
        currentArtifact.completedAt = this.clock();
        currentArtifact.updatedAt = this.clock();
        currentJob.status = "committed";
        currentJob.publicationPhase = "committed";
        currentJob.promotedAt = currentArtifact.promotedAt;
        currentJob.completedAt = currentArtifact.completedAt;
        currentJob.updatedAt = currentArtifact.updatedAt;
        currentJob.claimToken = null;
        currentJob.workerId = null;
        currentJob.processId = null;
        currentJob.claimedAt = null;
        if (renderJob) {
          renderJob.status = "committed";
          renderJob.publicationPhase = "committed";
          renderJob.promotedAt = currentArtifact.promotedAt;
          renderJob.completedAt = currentArtifact.completedAt;
          renderJob.updatedAt = currentArtifact.updatedAt;
          renderJob.claimToken = null;
          renderJob.workerId = null;
          renderJob.processId = null;
          renderJob.claimedAt = null;
        }
      });
      this.objects.remove(artifact.stagingKey);
    } catch (error) {
      const code = errorCode(error);
      this.repository.transact((state) => {
        const currentArtifact = state.s6ViewArtifacts.find((item) => item.artifactId === artifact.artifactId);
        const currentJob = state.s6Jobs.find((item) => item.jobId === job.jobId);
        if (currentArtifact && currentArtifact.status !== "committed") {
          currentArtifact.status = "failed_terminal";
          currentArtifact.publicationPhase = "aborted";
          currentArtifact.failureCode = code === "S6_SOURCE_STALE" ? "S6_SOURCE_STALE" : "S6_PUBLICATION_UNCERTAIN";
          currentArtifact.terminalAt = this.clock();
          currentArtifact.updatedAt = this.clock();
        }
        if (currentJob && currentJob.status !== "committed") {
          currentJob.status = "failed_terminal";
          currentJob.publicationPhase = "aborted";
          currentJob.failureCode = code === "S6_SOURCE_STALE" ? "S6_SOURCE_STALE" : "S6_PUBLICATION_UNCERTAIN";
          currentJob.terminalAt = this.clock();
          currentJob.updatedAt = this.clock();
        }
      });
    }
  }

  async recover(): Promise<void> {
    this.recoverPending();
  }
}
