import { Buffer } from "node:buffer";
import {
  AppError,
  type S6ToS7Handoff,
  type S7CadExport,
  type S7CadJob,
  type S7CadReadbackReceipt,
  type S7CadPublicExport,
  type S7SourceStamp,
  type S7Telemetry,
  type S7ToS8Handoff,
  type S7PublicState,
  type Timestamp,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { S6WorkflowService } from "./s6";
import { decodeS7Manifest, parseS7Dxf } from "./s7-dxf-readback";
import { writeS7Dxf } from "./s7-dxf-writer";
import {
  S7_DXF_VERSION,
  S7_FIXED_DOWNLOAD_NAME,
  S7_MAX_DXF_BYTES,
  S7_MAX_MANIFEST_BYTES,
  S7_MAX_RECOVERY_ITEMS,
  S7_READBACK_VERSION,
  S7_RECEIPT_VERSION,
  S7_WORLD_TO_PLAN_VERSION,
  getS7Collections,
  hashS7ReadbackReceipt,
  sameS7Source,
  s7FinalDxfStorageKey,
  s7FinalManifestStorageKey,
  s7StagingDxfStorageKey,
  s7StagingManifestStorageKey,
  validateS7Graph,
} from "./s7-persistence";
import { buildS7Telemetry } from "./s7-telemetry";
import { jcs, newUuid, nowUtc, sha256, uuidV4Pattern } from "./utils";

type PublicationPhase = "admission" | "projection" | "generation" | "staging" | "promotion" | "commit";

export type S7PublicationPhaseHook = (phase: PublicationPhase, context: { projectId: UUID; jobId: UUID; artifactId: UUID; attempt: 1 | 2 }) => void;

export type S7CadServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  s6: S6WorkflowService;
  clock?: () => Timestamp;
  uuid?: () => UUID;
  ownerProcessId?: string;
  isOwnerProcessAlive?: (ownerProcessId: string) => boolean;
  onPublicationPhase?: S7PublicationPhaseHook;
};

export type S7ExportResult = {
  replayed: boolean;
  export: S7CadPublicExport;
  job: Pick<S7CadJob, "jobId" | "status" | "attempt">;
};

export type S7DownloadResult = {
  bytes: Buffer;
  contentType: "application/dxf";
  fileName: typeof S7_FIXED_DOWNLOAD_NAME;
};

const OPAQUE_KEY_MAX = 240;
const INPUT = {} as const;

function fail(status: number, code: string, field = "s7"): never {
  throw new AppError(status, code, [{ field, code }]);
}

function assertOpaqueKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > OPAQUE_KEY_MAX || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes("\\")) fail(400, "INVALID_REQUEST", "Idempotency-Key");
}

function assertRequestReference(value: UUID | undefined): void {
  if (value !== undefined && !uuidV4Pattern.test(value)) fail(400, "INVALID_REQUEST", "requestReferenceId");
}

function publicExport(value: S7CadExport): S7CadPublicExport {
  const { privateFinalStorageKey: _final, privateStagingStorageKey: _staging, ...safe } = value;
  return safe;
}

function stampFromHandoff(handoff: S6ToS7Handoff): S7SourceStamp {
  return {
    sourceRevisionId: handoff.acceptedRevisionId,
    sourceRevisionHash: handoff.acceptedRevisionHash,
    sourceS5Fingerprint: handoff.sourceS5Fingerprint,
    validationReceiptId: handoff.validationReceipt.receiptId,
    validationHash: handoff.validationReceipt.validationHash,
    s6HandoffSchemaVersion: handoff.schemaVersion,
    handoffDigest: sha256(jcs(handoff)),
  };
}

function sourceError(error: unknown): AppError {
  if (error instanceof AppError && (error.code === "S7_SOURCE_STALE" || error.code === "S6_SOURCE_STALE")) return new AppError(409, "S7_SOURCE_STALE", [{ field: "source", code: "S7_SOURCE_STALE" }]);
  return new AppError(409, "S7_SOURCE_NOT_READY", [{ field: "source", code: "S7_SOURCE_NOT_READY" }]);
}

function cloneStamp(source: S7SourceStamp): S7SourceStamp {
  return { ...source };
}

export class S7CadService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly s6: S6WorkflowService;
  private readonly clock: () => Timestamp;
  private readonly uuid: () => UUID;
  private readonly ownerProcessId: string;
  private readonly isOwnerProcessAlive: ((ownerProcessId: string) => boolean) | undefined;
  private readonly onPublicationPhase: S7PublicationPhaseHook | undefined;

  constructor(options: S7CadServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.s6 = options.s6;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.ownerProcessId = options.ownerProcessId ?? `s7-process-${String(process.pid)}-${this.uuid()}`;
    this.isOwnerProcessAlive = options.isOwnerProcessAlive;
    this.onPublicationPhase = options.onPublicationPhase;
  }

  private source(projectId: UUID): { handoff: S6ToS7Handoff; stamp: S7SourceStamp } {
    try {
      const handoff = this.s6.getS7Handoff(projectId);
      if (handoff.projectId !== projectId) throw new Error("source project mismatch");
      const stamp = stampFromHandoff(handoff);
      if (handoff.eligibility.currentAccepted !== true || handoff.eligibility.sourceCurrent !== true || handoff.eligibility.stale !== false) throw new Error("source eligibility");
      return { handoff, stamp };
    } catch (error) {
      if (error instanceof AppError && error.code === "S7_SOURCE_STALE") throw error;
      throw sourceError(error);
    }
  }

  private currentSource(projectId: UUID, expected: S7SourceStamp): S6ToS7Handoff {
    let current: S6ToS7Handoff;
    try {
      current = this.s6.getS7Handoff(projectId);
      if (current.projectId !== projectId) throw new Error("source project mismatch");
    } catch (error) {
      throw sourceError(error);
    }
    const stamp = stampFromHandoff(current);
    if (!sameS7Source(stamp, expected)) throw new AppError(409, "S7_SOURCE_STALE", [{ field: "source", code: "S7_SOURCE_STALE" }]);
    return current;
  }

  private projectExists(projectId: UUID): void {
    if (!this.repository.state().projects.some((project) => project.projectId === projectId)) fail(404, "NOT_FOUND", "project");
  }

  private phase(phase: PublicationPhase, projectId: UUID, job: S7CadJob, artifact: S7CadExport): void {
    try {
      this.onPublicationPhase?.(phase, { projectId, jobId: job.jobId, artifactId: artifact.artifactId, attempt: job.attempt });
    } catch {
      throw new AppError(500, "S7_PUBLICATION_FAILED");
    }
  }

  private claimSnapshot(jobId: UUID, claimToken: UUID): { job: S7CadJob; artifact: S7CadExport } {
    const state = this.repository.state();
    const job = state.s7CadJobs?.find((item) => item.jobId === jobId);
    const artifact = job ? state.s7CadExports?.find((item) => item.artifactId === job.artifactId) : undefined;
    if (!job || !artifact || job.claimToken !== claimToken || artifact.status !== job.status || !job.ownerProcessId || job.ownerProcessId !== this.ownerProcessId) fail(409, "S7_CLAIM_FENCED");
    return { job, artifact };
  }

  private fence(projectId: UUID, source: S7SourceStamp, phase: PublicationPhase, jobId: UUID, claimToken: UUID): S6ToS7Handoff {
    const before = this.currentSource(projectId, source);
    const snapshot = this.claimSnapshot(jobId, claimToken);
    this.phase(phase, projectId, snapshot.job, snapshot.artifact);
    const after = this.currentSource(projectId, source);
    return after ?? before;
  }

  private updateHeartbeat(jobId: UUID, claimToken: UUID): void {
    const at = this.clock();
    this.repository.transact((state) => {
      const job = state.s7CadJobs?.find((item) => item.jobId === jobId);
      const artifact = job ? state.s7CadExports?.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerProcessId !== this.ownerProcessId || !["running", "staged", "promoted"].includes(job.status)) fail(409, "S7_CLAIM_FENCED");
      job.heartbeatAt = at; job.updatedAt = at; artifact.updatedAt = at;
    });
  }

  private claimQueued(jobId: UUID): { job: S7CadJob; artifact: S7CadExport; claimToken: UUID } {
    const state = this.repository.state();
    const existing = state.s7CadJobs?.find((item) => item.jobId === jobId);
    const existingArtifact = existing ? state.s7CadExports?.find((item) => item.artifactId === existing.artifactId) : undefined;
    if (!existing || !existingArtifact) fail(404, "NOT_FOUND", "job");
    if (existing.status !== "queued") return { job: existing, artifact: existingArtifact, claimToken: existing.claimToken! };
    const claimToken = this.uuid();
    const at = this.clock();
    const claimed = this.repository.transact((current) => {
      const job = current.s7CadJobs?.find((item) => item.jobId === jobId);
      const artifact = job ? current.s7CadExports?.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact) fail(404, "NOT_FOUND", "job");
      if (job.status !== "queued") return { job, artifact, claimToken: job.claimToken! };
      if (!sameS7Source(job.source, artifact.source)) fail(500, "S7_PERSISTENCE_INVALID");
      job.status = "running"; job.claimToken = claimToken; job.ownerProcessId = this.ownerProcessId; job.claimedAt = at; job.heartbeatAt = at; job.updatedAt = at;
      artifact.status = "running"; artifact.privateStagingStorageKey = s7StagingDxfStorageKey(artifact.projectId, job.jobId, claimToken); artifact.updatedAt = at;
      return { job, artifact, claimToken };
    });
    return claimed;
  }

  private markStale(jobId: UUID, claimToken: UUID | null, failureCode = "S7_SOURCE_STALE"): void {
    const at = this.clock();
    this.repository.transact((state) => {
      const job = state.s7CadJobs?.find((item) => item.jobId === jobId);
      const artifact = job ? state.s7CadExports?.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || (claimToken !== null && job.claimToken !== claimToken)) return;
      if (["committed", "superseded", "stale"].includes(job.status)) return;
      job.status = "stale"; job.terminalAt = at; job.updatedAt = at; job.claimToken = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
      artifact.status = "stale"; artifact.staleAt = at; artifact.failureCode = failureCode; artifact.updatedAt = at;
    });
  }

  private markFailure(jobId: UUID, claimToken: UUID | null, error: unknown): void {
    const failureCode = error instanceof AppError ? error.code : "S7_PUBLICATION_FAILED";
    const at = this.clock();
    this.repository.transact((state) => {
      const job = state.s7CadJobs?.find((item) => item.jobId === jobId);
      const artifact = job ? state.s7CadExports?.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || (claimToken !== null && job.claimToken !== claimToken) || ["committed", "superseded", "stale"].includes(job.status)) return;
      const retryable = job.attempt === 1;
      const status = retryable ? "failed_retryable" : "failed_terminal";
      job.status = status; job.updatedAt = at; job.claimToken = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null; job.terminalAt = retryable ? null : at;
      artifact.status = status; artifact.failureCode = failureCode; artifact.updatedAt = at; artifact.publicationPhase = job.status === "failed_terminal" ? "aborted" : artifact.publicationPhase;
    });
  }

  private asyncLikeProcess(jobId: UUID): S7CadExport {
    const claimed = this.claimQueued(jobId);
    if (claimed.job.status === "committed" || claimed.job.status === "superseded" || claimed.job.status === "stale" || claimed.job.status === "failed_retryable" || claimed.job.status === "failed_terminal") return claimed.artifact;
    if (!claimed.claimToken) fail(409, "S7_CLAIM_FENCED");
    const claimToken = claimed.claimToken;
    const job = claimed.job;
    const artifact = claimed.artifact;
    try {
      let handoff = this.fence(job.projectId, job.source, "projection", job.jobId, claimToken);
      handoff = this.fence(job.projectId, job.source, "generation", job.jobId, claimToken);
      const generated = writeS7Dxf(handoff, { artifactId: artifact.artifactId, manifestId: artifact.manifestId, source: cloneStamp(job.source) });
      if (generated.bytes.length > S7_MAX_DXF_BYTES || generated.manifestBytes.length > S7_MAX_MANIFEST_BYTES) fail(422, "S7_RESOURCE_LIMIT");
      this.fence(job.projectId, job.source, "staging", job.jobId, claimToken);
      this.updateHeartbeat(job.jobId, claimToken);
      this.objects.putExact(artifact.privateStagingStorageKey, generated.bytes);
      this.objects.putExact(s7StagingManifestStorageKey(job.projectId, job.jobId, claimToken), generated.manifestBytes);
      this.fence(job.projectId, job.source, "staging", job.jobId, claimToken);
      this.repository.transact((state) => {
        const currentJob = state.s7CadJobs?.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? state.s7CadExports?.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== claimToken || currentJob.ownerProcessId !== this.ownerProcessId) fail(409, "S7_CLAIM_FENCED");
        const at = this.clock();
        const manifestKey = s7FinalManifestStorageKey(job.projectId, artifact.manifestId);
        if (!state.s7CadManifests?.some((item) => item.manifestId === artifact.manifestId)) state.s7CadManifests?.push({ schemaVersion: "s7-cad-manifest-v1", manifestId: artifact.manifestId, projectId: job.projectId, artifactId: artifact.artifactId, source: cloneStamp(job.source), worldToPlanVersion: S7_WORLD_TO_PLAN_VERSION, dxfVersion: S7_DXF_VERSION, manifestHash: generated.manifestHash, manifestByteSize: generated.manifestBytes.length, privateManifestStorageKey: manifestKey });
        currentArtifact.status = "staged"; currentArtifact.publicationPhase = "staged"; currentArtifact.manifestHash = generated.manifestHash; currentArtifact.updatedAt = at; currentJob.status = "staged"; currentJob.updatedAt = at; currentJob.heartbeatAt = at;
      });
      handoff = this.fence(job.projectId, job.source, "promotion", job.jobId, claimToken);
      this.objects.promoteExact(artifact.privateStagingStorageKey, artifact.privateFinalStorageKey, generated.bytes);
      this.objects.promoteExact(s7StagingManifestStorageKey(job.projectId, job.jobId, claimToken), s7FinalManifestStorageKey(job.projectId, artifact.manifestId), generated.manifestBytes);
      this.fence(job.projectId, job.source, "promotion", job.jobId, claimToken);
      this.repository.transact((state) => {
        const currentJob = state.s7CadJobs?.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? state.s7CadExports?.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== claimToken || currentJob.ownerProcessId !== this.ownerProcessId) fail(409, "S7_CLAIM_FENCED");
        const at = this.clock(); currentArtifact.status = "promoted"; currentArtifact.publicationPhase = "promoted"; currentArtifact.updatedAt = at; currentJob.status = "promoted"; currentJob.updatedAt = at; currentJob.heartbeatAt = at;
      });
      const finalBytes = this.objects.read(artifact.privateFinalStorageKey);
      const finalManifestBytes = this.objects.read(s7FinalManifestStorageKey(job.projectId, artifact.manifestId));
      if (sha256(finalBytes) !== generated.sha256 || finalBytes.length !== generated.byteSize || sha256(finalManifestBytes) !== generated.manifestHash) fail(500, "S7_PUBLICATION_OBJECT_MISMATCH");
      const readback = parseS7Dxf(finalBytes, { expectedManifest: generated.manifest, expectedSource: job.source });
      this.fence(job.projectId, job.source, "commit", job.jobId, claimToken);
      const checkedAt = this.clock();
      const receiptWithoutHash: S7CadReadbackReceipt = { schemaVersion: S7_RECEIPT_VERSION, receiptId: this.uuid(), projectId: job.projectId, artifactId: artifact.artifactId, source: cloneStamp(job.source), manifestId: artifact.manifestId, manifestHash: generated.manifestHash, worldToPlanVersion: S7_WORLD_TO_PLAN_VERSION, dxfVersion: S7_DXF_VERSION, sha256: generated.sha256, byteSize: generated.byteSize, entityCount: readback.entityCount, correspondenceResult: readback.correspondenceResult === "pass" ? "pass" : "fail", outcome: readback.outcome, issues: readback.issues, checkedAt, receiptHash: "" as string, readbackVersion: S7_READBACK_VERSION };
      const receipt = { ...receiptWithoutHash, receiptHash: hashS7ReadbackReceipt(receiptWithoutHash) };
      this.repository.transact((state) => {
        const currentJob = state.s7CadJobs?.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? state.s7CadExports?.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== claimToken || currentJob.ownerProcessId !== this.ownerProcessId) fail(409, "S7_CLAIM_FENCED");
        const at = this.clock(); state.s7CadReadbackReceipts?.push(receipt); currentArtifact.status = "committed"; currentArtifact.publicationPhase = "committed"; currentArtifact.manifestHash = generated.manifestHash; currentArtifact.readbackReceiptId = receipt.receiptId; currentArtifact.readbackHash = receipt.receiptHash; currentArtifact.sha256 = generated.sha256; currentArtifact.byteSize = generated.byteSize; currentArtifact.committedAt = at; currentArtifact.updatedAt = at; currentJob.status = "committed"; currentJob.updatedAt = at; currentJob.terminalAt = at; currentJob.claimToken = null; currentJob.ownerProcessId = null; currentJob.claimedAt = null; currentJob.heartbeatAt = null;
      });
      return this.repository.state().s7CadExports!.find((item) => item.artifactId === artifact.artifactId)!;
    } catch (error) {
      if (error instanceof AppError && (error.code === "S7_SOURCE_STALE" || error.code === "S7_SOURCE_NOT_READY")) this.markStale(job.jobId, claimToken);
      else this.markFailure(job.jobId, claimToken, error);
      throw error;
    }
  }

  createExport(projectId: UUID, idempotencyKey: string, requestReferenceId?: UUID): S7ExportResult {
    assertOpaqueKey(idempotencyKey); assertRequestReference(requestReferenceId); this.projectExists(projectId);
    const admitted = this.source(projectId);
    const inputHash = sha256(jcs({ operation: "export", projectId, input: INPUT }));
    const existing = getS7Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputHash !== inputHash || !sameS7Source(existing.source, admitted.stamp)) fail(409, "S7_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const linked = getS7Collections(this.repository.state()).exports.find((item) => item.artifactId === existing.artifactId);
      const linkedJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === existing.jobId);
      if (!linked || !linkedJob) fail(500, "S7_PERSISTENCE_INVALID");
      if (linkedJob.status === "queued") this.process(linkedJob.jobId);
      const current = getS7Collections(this.repository.state()).exports.find((item) => item.artifactId === existing.artifactId)!;
      const currentJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === existing.jobId)!;
      return { replayed: true, export: publicExport(current), job: { jobId: currentJob.jobId, status: currentJob.status, attempt: currentJob.attempt } };
    }
    const at = this.clock(); const artifactId = this.uuid(); const jobId = this.uuid(); const manifestId = this.uuid();
    const artifact: S7CadExport = { schemaVersion: "s7-cad-export-v1", artifactId, projectId, jobId, source: cloneStamp(admitted.stamp), inputHash, dxfVersion: S7_DXF_VERSION, worldToPlanVersion: S7_WORLD_TO_PLAN_VERSION, format: "dxf", mimeType: "application/dxf", downloadFileName: S7_FIXED_DOWNLOAD_NAME, status: "queued", publicationPhase: "none", attempt: 1, retryOfArtifactId: null, manifestId, manifestHash: null, readbackReceiptId: null, readbackHash: null, sha256: null, byteSize: null, privateFinalStorageKey: s7FinalDxfStorageKey(projectId, artifactId), privateStagingStorageKey: s7StagingDxfStorageKey(projectId, jobId, "unclaimed"), failureCode: null, createdAt: at, updatedAt: at, committedAt: null, staleAt: null, supersededAt: null };
    const job: S7CadJob = { schemaVersion: "s7-cad-job-v1", jobId, projectId, artifactId, source: cloneStamp(admitted.stamp), inputHash, idempotencyKey, status: "queued", attempt: 1, retryOfJobId: null, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null };
    this.phase("admission", projectId, job, artifact);
    const admission = this.repository.transact((state) => {
      const collision = state.s7CadIdempotency?.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
      if (collision) {
        if (collision.inputHash !== inputHash || !sameS7Source(collision.source, admitted.stamp)) fail(409, "S7_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
        return { replayed: true as const, jobId: collision.jobId, artifactId: collision.artifactId };
      }
      let live: { stamp: S7SourceStamp };
      try { live = this.source(projectId); } catch (error) { throw sourceError(error); }
      if (!sameS7Source(admitted.stamp, live.stamp)) fail(409, "S7_SOURCE_STALE");
      state.s7CadExports?.push(artifact); state.s7CadJobs?.push(job); state.s7CadIdempotency?.push({ schemaVersion: "s7-cad-idempotency-v1", projectId, operation: "export", idempotencyKey, inputHash, source: cloneStamp(admitted.stamp), jobId, artifactId, createdAt: at });
      return { replayed: false as const, jobId, artifactId };
    });
    if (admission.replayed) {
      const linkedJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === admission.jobId);
      const linkedArtifact = getS7Collections(this.repository.state()).exports.find((item) => item.artifactId === admission.artifactId);
      if (!linkedJob || !linkedArtifact) fail(500, "S7_PERSISTENCE_INVALID");
      if (linkedJob.status === "queued") this.process(linkedJob.jobId);
      const current = getS7Collections(this.repository.state()).exports.find((item) => item.artifactId === admission.artifactId)!;
      const latestJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === admission.jobId)!;
      return { replayed: true, export: publicExport(current), job: { jobId: latestJob.jobId, status: latestJob.status, attempt: latestJob.attempt } };
    }
    const current = this.process(admission.jobId);
    const latestJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === current.jobId)!;
    return { replayed: false, export: publicExport(current), job: { jobId: latestJob.jobId, status: latestJob.status, attempt: latestJob.attempt } };
  }

  process(jobId: UUID): S7CadExport {
    return this.asyncLikeProcess(jobId);
  }

  heartbeat(jobId: UUID, claimToken: UUID): void {
    const current = this.claimSnapshot(jobId, claimToken);
    this.currentSource(current.job.projectId, current.job.source);
    this.updateHeartbeat(jobId, claimToken);
  }

  retryExport(artifactId: UUID): S7ExportResult {
    const initial = getS7Collections(this.repository.state());
    const priorArtifact = initial.exports.find((item) => item.artifactId === artifactId);
    const priorJob = priorArtifact ? initial.jobs.find((item) => item.jobId === priorArtifact.jobId) : undefined;
    if (!priorArtifact || !priorJob) fail(404, "NOT_FOUND", "artifact");
    if (priorArtifact.attempt !== 1 || priorArtifact.status !== "failed_retryable" || priorJob.status !== "failed_retryable") fail(409, "S7_RETRY_NOT_AVAILABLE");
    const source = this.source(priorArtifact.projectId);
    if (!sameS7Source(source.stamp, priorArtifact.source)) {
      this.markStale(priorJob.jobId, null);
      fail(409, "S7_SOURCE_STALE");
    }
    const at = this.clock(); const newArtifactId = this.uuid(); const newJobId = this.uuid(); const newManifestId = this.uuid();
    const artifact: S7CadExport = { ...priorArtifact, artifactId: newArtifactId, jobId: newJobId, status: "queued", publicationPhase: "none", attempt: 2, retryOfArtifactId: priorArtifact.artifactId, manifestId: newManifestId, manifestHash: null, readbackReceiptId: null, readbackHash: null, sha256: null, byteSize: null, privateFinalStorageKey: s7FinalDxfStorageKey(priorArtifact.projectId, newArtifactId), privateStagingStorageKey: s7StagingDxfStorageKey(priorArtifact.projectId, newJobId, "unclaimed"), failureCode: null, createdAt: at, updatedAt: at, committedAt: null, staleAt: null, supersededAt: null, source: cloneStamp(source.stamp) };
    const job: S7CadJob = { ...priorJob, jobId: newJobId, artifactId: newArtifactId, source: cloneStamp(source.stamp), status: "queued", attempt: 2, retryOfJobId: priorJob.jobId, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null };
    try {
      this.repository.transact((state) => {
        let live: { stamp: S7SourceStamp };
        try { live = this.source(priorArtifact!.projectId); } catch (error) { throw sourceError(error); }
        if (!sameS7Source(source.stamp, live.stamp)) fail(409, "S7_SOURCE_STALE");
        state.s7CadExports?.push(artifact); state.s7CadJobs?.push(job);
        const idempotency = state.s7CadIdempotency?.find((item) => item.projectId === job.projectId && item.idempotencyKey === job.idempotencyKey);
        if (!idempotency) fail(500, "S7_PERSISTENCE_INVALID");
        idempotency.source = cloneStamp(source.stamp); idempotency.jobId = newJobId; idempotency.artifactId = newArtifactId;
      });
    } catch (error) {
      if (error instanceof AppError && (error.code === "S7_SOURCE_STALE" || error.code === "S7_SOURCE_NOT_READY")) this.markStale(priorJob.jobId, null);
      throw error;
    }
    let result: S7CadExport;
    try { result = this.process(newJobId); } catch { result = getS7Collections(this.repository.state()).exports.find((item) => item.artifactId === newArtifactId)!; }
    const currentJob = getS7Collections(this.repository.state()).jobs.find((item) => item.jobId === result.jobId)!;
    return { replayed: false, export: publicExport(result), job: { jobId: currentJob.jobId, status: currentJob.status, attempt: currentJob.attempt } };
  }

  recoverPending(): number {
    const state = this.repository.state();
    const candidates = getS7Collections(state).jobs.filter((job) => ["running", "staged", "promoted"].includes(job.status) && job.ownerProcessId !== null);
    if (candidates.length > S7_MAX_RECOVERY_ITEMS) fail(500, "S7_RESOURCE_LIMIT", "recovery");
    let recovered = 0;
    for (const job of candidates) {
      let dead = false;
      try { dead = this.isOwnerProcessAlive ? this.isOwnerProcessAlive(job.ownerProcessId!) === false : false; } catch { dead = false; }
      if (!dead) continue;
      this.markFailure(job.jobId, job.claimToken, new AppError(500, "S7_OWNER_DEAD")); recovered += 1;
    }
    return recovered;
  }

  getState(projectId: UUID): S7PublicState {
    this.projectExists(projectId);
    const collections = getS7Collections(this.repository.state());
    let source: { stamp: S7SourceStamp } | null = null;
    try { source = this.source(projectId); } catch { source = null; }
    if (source) {
      const at = this.clock();
      this.repository.transact((state) => {
        for (const artifact of state.s7CadExports ?? []) if (artifact.projectId === projectId && artifact.status === "committed" && !sameS7Source(artifact.source, source!.stamp)) {
          artifact.status = "superseded"; artifact.supersededAt = at; artifact.updatedAt = at;
          const job = state.s7CadJobs?.find((item) => item.jobId === artifact.jobId);
          if (job) { job.status = "superseded"; job.terminalAt = at; job.updatedAt = at; }
        }
      });
      this.currentSource(projectId, source.stamp);
    }
    const exports = getS7Collections(this.repository.state()).exports.filter((item) => item.projectId === projectId).map(publicExport);
    return { projectId, source: source ? { readiness: "ready", sourceRevisionId: source.stamp.sourceRevisionId, sourceRevisionHash: source.stamp.sourceRevisionHash, sourceS5Fingerprint: source.stamp.sourceS5Fingerprint } : { readiness: "not_ready", sourceRevisionId: null, sourceRevisionHash: null, sourceS5Fingerprint: null }, exports };
  }

  getExport(projectId: UUID, artifactId: UUID): S7CadPublicExport {
    const source = this.source(projectId);
    const artifact = getS7Collections(this.repository.state()).exports.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "NOT_FOUND", "artifact");
    this.currentSource(projectId, artifact.source);
    if (artifact.status === "committed") this.download(projectId, artifactId);
    void source;
    return publicExport(artifact);
  }

  download(projectId: UUID, artifactId: UUID): S7DownloadResult {
    const artifact = getS7Collections(this.repository.state()).exports.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "NOT_FOUND", "artifact");
    const source = this.source(projectId);
    if (!sameS7Source(source.stamp, artifact.source)) fail(409, "S7_SOURCE_STALE");
    if (artifact.status !== "committed" || artifact.sha256 === null || artifact.byteSize === null || artifact.readbackReceiptId === null || artifact.readbackHash === null || artifact.manifestHash === null) fail(409, "S7_EXPORT_NOT_READY");
    const bytes = this.objects.read(artifact.privateFinalStorageKey);
    const manifestBytes = this.objects.read(s7FinalManifestStorageKey(projectId, artifact.manifestId));
    if (bytes.length !== artifact.byteSize || sha256(bytes) !== artifact.sha256) fail(409, "S7_PUBLICATION_OBJECT_MISMATCH");
    if (sha256(manifestBytes) !== artifact.manifestHash) fail(409, "S7_PUBLICATION_OBJECT_MISMATCH");
    const manifest = decodeS7Manifest(manifestBytes);
    if (manifest.manifestId !== artifact.manifestId || manifest.projectId !== projectId || manifest.artifactId !== artifact.artifactId) fail(409, "S7_PUBLICATION_OBJECT_MISMATCH");
    const readback = parseS7Dxf(bytes, { expectedManifest: manifest, expectedSource: source.stamp });
    const receipt = getS7Collections(this.repository.state()).receipts.find((item) => item.receiptId === artifact.readbackReceiptId);
    if (!receipt || receipt.receiptHash !== artifact.readbackHash || receipt.sha256 !== artifact.sha256 || receipt.byteSize !== artifact.byteSize || receipt.readbackVersion !== S7_READBACK_VERSION || receipt.worldToPlanVersion !== S7_WORLD_TO_PLAN_VERSION || receipt.dxfVersion !== S7_DXF_VERSION || receipt.manifestId !== artifact.manifestId || receipt.manifestHash !== artifact.manifestHash || !sameS7Source(receipt.source, source.stamp) || receipt.correspondenceResult !== "pass" || receipt.outcome !== "pass" || readback.outcome !== "pass") fail(409, "S7_READBACK_FAILED");
    this.currentSource(projectId, source.stamp);
    return { bytes, contentType: "application/dxf", fileName: S7_FIXED_DOWNLOAD_NAME };
  }

  getTelemetry(projectId: UUID): S7Telemetry {
    this.projectExists(projectId);
    let readiness: "ready" | "not_ready" = "not_ready";
    try { this.source(projectId); readiness = "ready"; } catch { /* telemetry remains privacy-safe and unavailable */ }
    return buildS7Telemetry(this.repository.state(), projectId, { readiness });
  }

  getHandoff(projectId: UUID): S7ToS8Handoff {
    const source = this.source(projectId);
    const committed = getS7Collections(this.repository.state()).exports.filter((item) => item.projectId === projectId && item.status === "committed" && sameS7Source(item.source, source.stamp)).sort((left, right) => {
      const leftAt = left.committedAt ?? "";
      const rightAt = right.committedAt ?? "";
      return leftAt < rightAt ? 1 : leftAt > rightAt ? -1 : 0;
    })[0];
    if (!committed || committed.sha256 === null || committed.byteSize === null || committed.manifestHash === null || committed.readbackReceiptId === null || committed.readbackHash === null) fail(409, "S7_HANDOFF_NOT_READY");
    this.download(projectId, committed.artifactId);
    this.currentSource(projectId, source.stamp);
    return { schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: source.stamp.sourceRevisionId, sourceRevisionHash: source.stamp.sourceRevisionHash, sourceS5Fingerprint: source.stamp.sourceS5Fingerprint, s7ArtifactId: committed.artifactId, s7ArtifactHash: committed.sha256, s7ArtifactByteSize: committed.byteSize, manifestId: committed.manifestId, manifestHash: committed.manifestHash, readbackReceiptId: committed.readbackReceiptId, readbackHash: committed.readbackHash, dxfVersion: S7_DXF_VERSION, worldToPlanVersion: S7_WORLD_TO_PLAN_VERSION, coordinateConvention: "booth-local-right-handed-v1", dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true };
  }
}
