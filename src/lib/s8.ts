import { Buffer } from "node:buffer";
import {
  AppError,
  type S6PublicRevision,
  type S6ToS7Handoff,
  type S7ToS8Handoff,
  type S8MaxExport,
  type S8MaxExportResult,
  type S8MaxGenerationReceipt,
  type S8MaxHandoff,
  type S8MaxJob,
  type S8MaxManifestRecord,
  type S8MaxPublicExport,
  type S8MaxPublicState,
  type S8MaxProviderMetadata,
  type S8MaxReadback,
  type S8MaxTelemetry,
  type S8MaxValidationReceipt,
  type S8SemanticBinding,
  type S8SourceStampV1,
  type S8StoreState,
  type Sha256,
  type Timestamp,
  type UUID,
} from "./types";
import { JsonRepository, PrivateObjectStore } from "./store";
import { S6WorkflowService } from "./s6";
import { S7CadService } from "./s7-cad";
import { decodeS7Manifest } from "./s7-dxf-readback";
import { getS7Collections, hashS7ReadbackReceipt, s7FinalManifestStorageKey } from "./s7-persistence";
import {
  S8_MAX_CANDIDATE_ATTEMPTS,
  S8_MAX_GENERATION_RECEIPT_BYTES,
  S8_MAX_MANIFEST_BYTES,
  S8_MAX_NATIVE_BYTES,
  S8_MAX_PROVIDER_ATTEMPTS,
  S8_MAX_RECOVERY_HEARTBEAT_SECONDS,
  S8_MAX_READBACK_BYTES,
  S8_NATIVE_FILE_NAME,
  S8_TRANSPORT_FILE_NAME,
  buildS8Payload,
  sourceStampDigest,
  sourceStampFromParts,
  sourceStampsEqual,
  type S8CanonicalPayload,
  S8PayloadError,
} from "./s8-payload";
import { buildS8SemanticManifest, compareS8SemanticManifest, validateS8SemanticBinding } from "./s8-semantic";
import {
  getS8Collections,
  hashS8GenerationReceipt,
  hashS8ValidationReceipt,
  sameS8Source,
  s8FinalManifestStorageKey,
  s8FinalMaxStorageKey,
  s8StagingMaxStorageKey,
  s8StagingPayloadStorageKey,
} from "./s8-persistence";
import {
  ApsOssV2DirectS3Provider,
  classifyS8ProviderFailure,
  S8MaxProviderError,
  type S8MaxProvider,
  type S8MaxProviderGenerationOutput,
  type S8MaxProviderInput,
  type S8MaxProviderStage,
  type S8MaxProviderValidationOutput,
} from "./s8-max-provider";
import { cloneJson, jcs, newUuid, nowUtc, sha256, uuidV4Pattern } from "./utils";

export type S8PublicationPhase =
  | "admission"
  | "payload"
  | "provider-submit"
  | "provider-result"
  | "staging"
  | "promotion"
  | "validation"
  | "commit"
  | "retry"
  | "download";

export type S8PublicationPhaseHook = (phase: S8PublicationPhase, context: { projectId: UUID; jobId: UUID; artifactId: UUID; candidateAttempt: 1 | 2 }) => void;
export type S8ClaimPhaseHook = (phase: "before-claim-cas" | "claim-decision", context: { jobId: UUID; acquired: boolean; claimToken: UUID | null; ownerProcessId: string | null }) => void;

export type S8MaxServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  s6: S6WorkflowService;
  s7: S7CadService;
  provider?: S8MaxProvider;
  clock?: () => Timestamp;
  uuid?: () => UUID;
  ownerProcessId?: string;
  isOwnerProcessAlive?: (ownerProcessId: string) => boolean;
  onPublicationPhase?: S8PublicationPhaseHook;
  onClaimPhase?: S8ClaimPhaseHook;
};

export type S8DownloadResult = {
  bytes: Buffer;
  contentType: "application/octet-stream";
  fileName: typeof S8_NATIVE_FILE_NAME;
};

type S8SourceAdmission = {
  s6Handoff: S6ToS7Handoff;
  s7Handoff: S7ToS8Handoff;
  revision: S6PublicRevision;
  stamp: S8SourceStampV1;
  payload: S8CanonicalPayload;
};

type ClaimResult = {
  acquired: boolean;
  job: S8MaxJob;
  artifact: S8MaxExport;
  claimToken: UUID | null;
  previousStagingKey: string;
};

const OPAQUE_KEY_MAX = 240;
const RECOVERY_MAX = 256;
const INPUT_OPERATION = "s8-max-export-v1";
const RETRY_OPERATION = "s8-max-retry-v1";

function requireS8State(state: import("./types").StoreState): S8StoreState {
  const candidate = state as S8StoreState;
  if (!Array.isArray(candidate.s8MaxExports) || !Array.isArray(candidate.s8MaxJobs) || !Array.isArray(candidate.s8MaxIdempotency) || !Array.isArray(candidate.s8MaxManifests) || !Array.isArray(candidate.s8MaxGenerationReceipts) || !Array.isArray(candidate.s8MaxValidationReceipts) || !Array.isArray(candidate.s8MaxProviderMetadata)) {
    throw new AppError(500, "S8_PERSISTENCE_INVALID");
  }
  return candidate;
}

function fail(status: number, code: string, field = "s8"): never {
  throw new AppError(status, code, [{ field, code }]);
}

function assertOpaqueKey(value: string, field = "Idempotency-Key"): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > OPAQUE_KEY_MAX || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes("\\")) fail(400, "INVALID_REQUEST", field);
}

function publicExport(value: S8MaxExport): S8MaxPublicExport {
  const { privateFinalStorageKey: _final, privateStagingStorageKey: _staging, privatePayloadStorageKey: _payload, ...safe } = value;
  return cloneJson(safe);
}

function sourceFailure(error: unknown): AppError {
  if (error instanceof AppError && ["S6_SOURCE_STALE", "S7_SOURCE_STALE", "SOURCE_STALE", "S8_SOURCE_STALE"].includes(error.code)) {
    return new AppError(409, "SOURCE_STALE", [{ field: "source", code: "SOURCE_STALE" }]);
  }
  return new AppError(409, "S8_SOURCE_NOT_READY", [{ field: "source", code: "S8_SOURCE_NOT_READY" }]);
}

function cloneStamp(stamp: S8SourceStampV1): S8SourceStampV1 {
  return cloneJson(stamp);
}

function clearClaim(job: S8MaxJob): void {
  job.claimToken = null;
  job.ownerProcessId = null;
  job.claimedAt = null;
  job.heartbeatAt = null;
}

function isSourceBoundaryError(error: unknown): boolean {
  return error instanceof AppError && ["SOURCE_STALE", "S8_SOURCE_NOT_READY", "S8_CLAIM_FENCED"].includes(error.code);
}

function failureCode(error: unknown): string {
  if (error instanceof S8MaxProviderError) return error.code;
  if (error instanceof S8PayloadError) return error.code;
  if (error instanceof Error && /^S8_[A-Z0-9_]+$/u.test(error.message.split(":", 1)[0]!)) return error.message.split(":", 1)[0]!;
  if (error instanceof AppError) return error.code;
  return "APS_WORKITEM_FAILED";
}

function manifestBytes(document: import("./types").S8MaxSemanticManifestDocument): Buffer {
  return Buffer.from(jcs(document), "utf8");
}

function inputHash(projectId: UUID, stamp: S8SourceStampV1, payloadSha256: Sha256): Sha256 {
  return sha256(jcs({ operation: INPUT_OPERATION, projectId, sourceStampDigest: sourceStampDigest(stamp), payloadSha256 }));
}

function providerBindingFallback(stamp: S8SourceStampV1, payloadSha256: Sha256, stage: S8MaxProviderStage, provider: S8MaxProvider["providerKind"]): S8SemanticBinding {
  const generationId = "swooshz-s8-max-generation-v1";
  const validationId = "swooshz-s8-max-validation-v1";
  const generationVersion = provider === "unavailable" ? "unbound" : "mock-oss-v2-1";
  const validationVersion = provider === "unavailable" ? "unbound" : "mock-oss-v2-1";
  return {
    sourceStampDigest: sourceStampDigest(stamp), payloadSha256,
    generationAppBundleId: generationId, generationAppBundleVersion: generationVersion, generationAppBundleHash: sha256(`s8:${generationId}:${generationVersion}`),
    generationActivityId: generationId, generationActivityVersion: generationVersion, generationActivityHash: sha256(`s8:activity:${generationId}:${generationVersion}`),
    validatorAppBundleId: validationId, validatorAppBundleVersion: validationVersion, validatorAppBundleHash: sha256(`s8:${validationId}:${validationVersion}`),
    validatorActivityId: validationId, validatorActivityVersion: validationVersion, validatorActivityHash: sha256(`s8:activity:${validationId}:${validationVersion}`),
    engineId: provider === "unavailable" ? "unbound" : "mock-3dsmax", productVersion: provider === "unavailable" ? "unbound" : "mock", engineVersion: provider === "unavailable" ? "unbound" : "mock-oss-v2-1",
    constructionAlgorithmVersion: "s8-max-scene-construction-v1", semanticAlgorithmVersion: "s8-max-semantic-v1",
  };
}

export class S8MaxService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly s6: S6WorkflowService;
  readonly s7: S7CadService;
  readonly provider: S8MaxProvider;
  private readonly clock: () => Timestamp;
  private readonly uuid: () => UUID;
  private readonly ownerProcessId: string;
  private readonly isOwnerProcessAlive: ((ownerProcessId: string) => boolean) | undefined;
  private readonly onPublicationPhase: S8PublicationPhaseHook | undefined;
  private readonly onClaimPhase: S8ClaimPhaseHook | undefined;

  constructor(options: S8MaxServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.s6 = options.s6;
    this.s7 = options.s7;
    this.provider = options.provider ?? new ApsOssV2DirectS3Provider();
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.ownerProcessId = options.ownerProcessId ?? `s8-process-${String(process.pid)}-${this.uuid()}`;
    this.isOwnerProcessAlive = options.isOwnerProcessAlive;
    this.onPublicationPhase = options.onPublicationPhase;
    this.onClaimPhase = options.onClaimPhase;
  }

  private projectExists(projectId: UUID): void {
    if (!this.repository.state().projects.some((project) => project.projectId === projectId)) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "project");
  }

  private state(): S8StoreState {
    return requireS8State(this.repository.state());
  }

  private assertS7CrossOutputEvidence(s6Handoff: S6ToS7Handoff, s7Handoff: S7ToS8Handoff): void {
    try {
      const s7Collections = getS7Collections(this.s7.repository.state());
      const exported = s7Collections.exports.find((item) => item.projectId === s7Handoff.projectId && item.artifactId === s7Handoff.s7ArtifactId && item.status === "committed");
      const manifestRecord = s7Collections.manifests.find((item) => item.projectId === s7Handoff.projectId && item.manifestId === s7Handoff.manifestId && item.artifactId === s7Handoff.s7ArtifactId);
      const readbackReceipt = s7Collections.receipts.find((item) => item.projectId === s7Handoff.projectId && item.artifactId === s7Handoff.s7ArtifactId && item.receiptId === s7Handoff.readbackReceiptId);
      if (!exported || exported.sha256 !== s7Handoff.s7ArtifactHash || exported.byteSize !== s7Handoff.s7ArtifactByteSize || exported.manifestHash !== s7Handoff.manifestHash || !manifestRecord || manifestRecord.privateManifestStorageKey !== s7FinalManifestStorageKey(s7Handoff.projectId, s7Handoff.manifestId) || !readbackReceipt || readbackReceipt.receiptHash !== s7Handoff.readbackHash || hashS7ReadbackReceipt(readbackReceipt) !== readbackReceipt.receiptHash || readbackReceipt.outcome !== "pass" || readbackReceipt.correspondenceResult !== "pass" || readbackReceipt.issues.length !== 0 || readbackReceipt.manifestId !== s7Handoff.manifestId || readbackReceipt.manifestHash !== s7Handoff.manifestHash || readbackReceipt.sha256 !== s7Handoff.s7ArtifactHash || readbackReceipt.byteSize !== s7Handoff.s7ArtifactByteSize) fail(409, "S7_CROSS_OUTPUT_MISMATCH", "s7");
      const manifestBytes = this.objects.read(manifestRecord.privateManifestStorageKey);
      if (sha256(manifestBytes) !== s7Handoff.manifestHash) fail(409, "S7_CROSS_OUTPUT_MISMATCH", "s7");
      const manifest = decodeS7Manifest(manifestBytes);
      if (manifest.projectId !== s7Handoff.projectId || manifest.artifactId !== s7Handoff.s7ArtifactId || manifest.manifestId !== s7Handoff.manifestId || manifest.source.sourceRevisionId !== s6Handoff.acceptedRevisionId || manifest.source.sourceRevisionHash !== s6Handoff.acceptedRevisionHash || manifest.source.sourceS5Fingerprint !== s6Handoff.sourceS5Fingerprint || manifest.source.validationReceiptId !== s6Handoff.validationReceipt.receiptId || manifest.source.validationHash !== s6Handoff.validationReceipt.validationHash) fail(409, "S7_CROSS_OUTPUT_MISMATCH", "s7.source");
      const sourceObjects = new Map(s6Handoff.objects.map((item) => [item.objectId, item]));
      const sourceEvidence = new Map<string, typeof manifest.entities[number]>();
      for (const entity of manifest.entities) {
        if (!sourceObjects.has(entity.sourceObjectId) || sourceEvidence.has(entity.sourceObjectId)) continue;
        sourceEvidence.set(entity.sourceObjectId, entity);
      }
      for (const object of s6Handoff.objects) {
        const evidence = sourceEvidence.get(object.objectId);
        if (!evidence || evidence.identityKey !== object.identityKey || evidence.parentObjectId !== object.parentObjectId || evidence.role !== object.role || evidence.geometryState !== object.geometry.geometryState) fail(409, "S7_CROSS_OUTPUT_MISMATCH", `s7.objects.${object.objectId}`);
      }
      const expectedLayers: Array<[string, string]> = [
        ["wall", "S7-WALLS-PARTITIONS"], ["partition", "S7-WALLS-PARTITIONS"], ["overhead_volume", "S7-OVERHEAD"], ["zone_region", "S7-ZONES"],
      ];
      for (const [objectType, layer] of expectedLayers) {
        for (const object of s6Handoff.objects.filter((item) => item.objectType === objectType)) {
          if (!manifest.entities.some((entity) => entity.sourceObjectId === object.objectId && entity.emittedLayer === layer)) fail(409, "S7_CROSS_OUTPUT_MISMATCH", `s7.layer.${object.objectId}`);
        }
      }
      const observedOpenSides = new Set(manifest.entities.filter((entity) => entity.identityKey.startsWith("booth-opening:") && entity.emittedLayer === "S7-BOOTH-OPENINGS").map((entity) => entity.identityKey.slice("booth-opening:".length)));
      const expectedOpenSides = new Set(s6Handoff.booth.openSides);
      if (observedOpenSides.size !== expectedOpenSides.size || [...expectedOpenSides].some((side) => !observedOpenSides.has(side))) fail(409, "S7_CROSS_OUTPUT_MISMATCH", "s7.booth.openSides");
    } catch (error) {
      if (error instanceof AppError && error.code === "S7_CROSS_OUTPUT_MISMATCH") throw error;
      fail(409, "S7_CROSS_OUTPUT_MISMATCH", "s7");
    }
  }

  private readSource(projectId: UUID): S8SourceAdmission {
    try {
      const s6Handoff = this.s6.getS7Handoff(projectId);
      const s7Handoff = this.s7.getHandoff(projectId);
      if (s6Handoff.projectId !== projectId || s7Handoff.projectId !== projectId || s7Handoff.sourceRevisionId !== s6Handoff.acceptedRevisionId || s7Handoff.sourceRevisionHash !== s6Handoff.acceptedRevisionHash || s7Handoff.sourceS5Fingerprint !== s6Handoff.sourceS5Fingerprint || s7Handoff.dxfIsNot3DAuthority !== true || s7Handoff.s8MustReadAcceptedS6Model !== true) fail(409, "S7_CROSS_OUTPUT_MISMATCH", "source");
      this.assertS7CrossOutputEvidence(s6Handoff, s7Handoff);
      const revision = this.s6.getRevision(projectId, s6Handoff.acceptedRevisionId);
      if (revision.revision.status !== "accepted_current" || revision.revision.modelHash !== s6Handoff.acceptedRevisionHash || revision.revision.sourceS5Fingerprint !== s6Handoff.sourceS5Fingerprint || revision.revision.sourceS5ApprovalEventId === undefined || revision.revision.sourceS5ApprovalGeneration === undefined) fail(409, "S8_SOURCE_NOT_READY", "source");
      const validation = revision.validation;
      if (!validation || validation.receiptId !== s6Handoff.validationReceipt.receiptId || validation.validationHash !== s6Handoff.validationReceipt.validationHash || !["pass", "pass_with_warnings"].includes(validation.outcome)) fail(409, "S8_SOURCE_NOT_READY", "source");
      const stamp = sourceStampFromParts({
        projectId,
        s6RevisionId: s6Handoff.acceptedRevisionId,
        s6RevisionHash: s6Handoff.acceptedRevisionHash,
        sourceS5Fingerprint: s6Handoff.sourceS5Fingerprint,
        sourceS5ApprovalEventId: revision.revision.sourceS5ApprovalEventId,
        sourceS5Generation: revision.revision.sourceS5ApprovalGeneration,
        s6ValidationReceiptId: s6Handoff.validationReceipt.receiptId,
        s6ValidationReceiptHash: s6Handoff.validationReceipt.validationHash,
        s6Handoff,
        s7ArtifactId: s7Handoff.s7ArtifactId,
        s7ArtifactHash: s7Handoff.s7ArtifactHash,
        s7ArtifactSize: s7Handoff.s7ArtifactByteSize,
        s7ManifestId: s7Handoff.manifestId,
        s7ManifestHash: s7Handoff.manifestHash,
        s7ReadbackReceiptId: s7Handoff.readbackReceiptId,
        s7ReadbackReceiptHash: s7Handoff.readbackHash,
      });
      const payload = buildS8Payload(stamp, s6Handoff);
      return { s6Handoff, s7Handoff, revision, stamp, payload };
    } catch (error) {
      if (error instanceof AppError && error.code === "S7_CROSS_OUTPUT_MISMATCH") throw error;
      throw sourceFailure(error);
    }
  }

  private reconcileSourceMovement(projectId: UUID, current: S8SourceStampV1): void {
    const at = this.clock();
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      for (const artifact of s8.s8MaxExports) {
        if (artifact.projectId !== projectId || sameS8Source(artifact.sourceStamp, current) || artifact.status === "superseded") continue;
        const job = s8.s8MaxJobs.find((item) => item.jobId === artifact.jobId);
        if (artifact.status === "committed") {
          artifact.status = "superseded";
          artifact.publicationPhase = "committed";
          artifact.supersededAt = at;
          artifact.updatedAt = at;
          artifact.controllerRequired = false;
          if (job) { job.status = "superseded"; job.terminalAt = at; job.updatedAt = at; job.controllerRequired = false; clearClaim(job); }
          continue;
        }
        artifact.status = "stale";
        artifact.publicationPhase = artifact.publicationPhase === "aborted" ? "none" : artifact.publicationPhase;
        artifact.failureCode = "SOURCE_STALE";
        artifact.staleAt = at;
        artifact.updatedAt = at;
        if (job) { job.status = "stale"; job.terminalAt = at; job.updatedAt = at; job.controllerRequired = false; clearClaim(job); }
      }
    });
  }

  private currentSource(projectId: UUID, expected: S8SourceStampV1): S8SourceAdmission {
    const current = this.readSource(projectId);
    if (!sameS8Source(current.stamp, expected)) {
      this.reconcileSourceMovement(projectId, current.stamp);
      fail(409, "SOURCE_STALE", "source");
    }
    return current;
  }

  private fence(projectId: UUID, expected: S8SourceStampV1, phase: S8PublicationPhase, job: S8MaxJob): S8SourceAdmission {
    this.onPublicationPhase?.(phase, { projectId, jobId: job.jobId, artifactId: job.artifactId, candidateAttempt: job.candidateAttempt });
    return this.currentSource(projectId, expected);
  }

  private providerInput(job: S8MaxJob, payload: S8CanonicalPayload): S8MaxProviderInput {
    return { projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId, payload: payload.payload, payloadBytes: payload.bytes, sourceStamp: cloneStamp(job.sourceStamp), sourceStampDigest: job.sourceStampDigest, payloadSha256: job.payloadSha256, attempt: job.candidateAttempt };
  }

  private snapshot(jobId: UUID): { job: S8MaxJob; artifact: S8MaxExport } {
    const collections = getS8Collections(this.state());
    const job = collections.jobs.find((item) => item.jobId === jobId);
    const artifact = job ? collections.exports.find((item) => item.artifactId === job.artifactId) : undefined;
    if (!job || !artifact) fail(500, "S8_PERSISTENCE_INVALID");
    return { job: cloneJson(job), artifact: cloneJson(artifact) };
  }

  private async claim(jobId: UUID): Promise<ClaimResult> {
    const before = this.snapshot(jobId);
    this.onClaimPhase?.("before-claim-cas", { jobId, acquired: false, claimToken: before.job.claimToken, ownerProcessId: before.job.ownerProcessId });
    if (!["queued", "provider_hold"].includes(before.job.status)) {
      this.onClaimPhase?.("claim-decision", { jobId, acquired: false, claimToken: null, ownerProcessId: null });
      return { acquired: false, job: before.job, artifact: before.artifact, claimToken: null, previousStagingKey: before.artifact.privateStagingStorageKey };
    }
    const result = this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const job = s8.s8MaxJobs.find((item) => item.jobId === jobId);
      const artifact = job ? s8.s8MaxExports.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact) fail(500, "S8_PERSISTENCE_INVALID");
      if (!["queued", "provider_hold"].includes(job.status) || job.claimToken !== null) return { acquired: false as const, job: cloneJson(job), artifact: cloneJson(artifact), claimToken: null, previousStagingKey: artifact.privateStagingStorageKey };
      const token = this.uuid(); const at = this.clock(); const previousStagingKey = artifact.privateStagingStorageKey;
      const resumedPhase = artifact.publicationPhase;
      const status = resumedPhase === "promoted" ? "validating" : resumedPhase === "staged" ? "staged" : "running";
      job.claimToken = token; job.ownerProcessId = this.ownerProcessId; job.claimedAt = at; job.heartbeatAt = at; job.status = status; job.stage = resumedPhase === "promoted" ? "validation" : "generation"; job.updatedAt = at;
      artifact.status = status; artifact.privateStagingStorageKey = resumedPhase === "none" ? s8StagingMaxStorageKey(artifact.projectId, job.jobId, token) : artifact.privateStagingStorageKey; artifact.privatePayloadStorageKey = resumedPhase === "none" ? s8StagingPayloadStorageKey(artifact.projectId, job.jobId, token) : artifact.privatePayloadStorageKey; artifact.updatedAt = at;
      return { acquired: true as const, job: cloneJson(job), artifact: cloneJson(artifact), claimToken: token, previousStagingKey };
    });
    this.onClaimPhase?.("claim-decision", { jobId, acquired: result.acquired, claimToken: result.claimToken, ownerProcessId: result.acquired ? this.ownerProcessId : null });
    return result;
  }

  private heartbeatState(jobId: UUID, claimToken: UUID): void {
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const job = s8.s8MaxJobs.find((item) => item.jobId === jobId);
      if (!job || job.claimToken !== claimToken || job.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      const artifact = s8.s8MaxExports.find((item) => item.artifactId === job.artifactId);
      if (!artifact) fail(500, "S8_PERSISTENCE_INVALID");
      const at = this.clock(); job.heartbeatAt = at; job.updatedAt = at; artifact.updatedAt = at;
    });
  }

  heartbeat(jobId: UUID, claimToken: UUID): void {
    const current = this.snapshot(jobId);
    if (current.job.claimToken !== claimToken || current.job.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
    this.currentSource(current.job.projectId, current.job.sourceStamp);
    this.heartbeatState(jobId, claimToken);
  }

  private async recordProviderMetadata(metadata: S8MaxProviderMetadata): Promise<void> {
    this.repository.transact((state) => {
      const s8 = requireS8State(state); if (!s8.s8MaxProviderMetadata.some((item) => item.metadataId === metadata.metadataId)) s8.s8MaxProviderMetadata.push(cloneJson(metadata));
    });
  }

  private failureMetadata(job: S8MaxJob, stage: S8MaxProviderStage, attempt: number, code: string, outcome: "hold" | "fail"): S8MaxProviderMetadata {
    const binding = providerBindingFallback(job.sourceStamp, job.payloadSha256, stage, this.provider.providerKind);
    return {
      schemaVersion: "s8-max-provider-metadata-v1", metadataId: this.uuid(), projectId: job.projectId, artifactId: job.artifactId, jobId: job.jobId, stage,
      provider: this.provider.providerKind, providerAttempt: attempt, outcome, failureCode: code as S8MaxProviderMetadata["failureCode"], engineId: binding.engineId, productVersion: binding.productVersion, engineVersion: binding.engineVersion,
      appBundleId: stage === "generation" ? binding.generationAppBundleId : binding.validatorAppBundleId,
      appBundleVersion: stage === "generation" ? binding.generationAppBundleVersion : binding.validatorAppBundleVersion,
      appBundleHash: stage === "generation" ? binding.generationAppBundleHash : binding.validatorAppBundleHash,
      activityId: stage === "generation" ? binding.generationActivityId : binding.validatorActivityId,
      activityVersion: stage === "generation" ? binding.generationActivityVersion : binding.validatorActivityVersion,
      activityHash: stage === "generation" ? binding.generationActivityHash : binding.validatorActivityHash,
      occurredAt: this.clock(),
    };
  }

  private async markFailure(jobId: UUID, claimToken: UUID | null, error: unknown): Promise<void> {
    const code = failureCode(error);
    const providerDisposition = error instanceof S8MaxProviderError
      ? classifyS8ProviderFailure(error.code, error.cause)
      : null;
    const providerFailure = providerDisposition?.classification === "provider_hold";
    const providerError = providerDisposition !== null;
    const snapshot = this.snapshot(jobId); const stage: S8MaxProviderStage = snapshot.job.stage === "validation" ? "validation" : "generation";
    if (providerError) {
      await this.recordProviderMetadata(error instanceof S8MaxProviderError
        ? errorMetadataFromProviderError(error, snapshot.job, this.provider.providerKind, this.clock, this.uuid)
        : this.failureMetadata(snapshot.job, stage, stage === "generation" ? Math.max(snapshot.job.generationProviderAttempts, 1) : Math.max(snapshot.job.validationProviderAttempts, 1), code, providerFailure ? "hold" : "fail"));
    }
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const job = s8.s8MaxJobs.find((item) => item.jobId === jobId);
      const artifact = job ? s8.s8MaxExports.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact) return;
      if (claimToken !== null && (job.claimToken !== claimToken || job.ownerProcessId !== this.ownerProcessId)) return;
      const at = this.clock(); artifact.failureCode = code; artifact.updatedAt = at; job.updatedAt = at;
      if (providerDisposition?.classification === "stale" || code === "SOURCE_STALE") {
        artifact.status = "stale"; artifact.staleAt = at; artifact.publicationPhase = artifact.publicationPhase === "aborted" ? "none" : artifact.publicationPhase; artifact.controllerRequired = false; job.status = "stale"; job.terminalAt = at; job.controllerRequired = false;
      } else if (providerFailure) {
        artifact.status = "provider_hold"; artifact.controllerRequired = providerDisposition?.controllerRequired ?? false; job.status = "provider_hold"; job.controllerRequired = providerDisposition?.controllerRequired ?? false; job.terminalAt = null;
      } else {
        const terminal = job.candidateAttempt === S8_MAX_CANDIDATE_ATTEMPTS;
        artifact.status = terminal ? "failed_terminal" : "failed_retryable"; artifact.publicationPhase = terminal ? "aborted" : artifact.publicationPhase; artifact.controllerRequired = false; job.status = artifact.status; job.controllerRequired = false; job.terminalAt = terminal ? at : null;
      }
      clearClaim(job);
    });
  }

  private async generation(job: S8MaxJob, artifact: S8MaxExport, claimToken: UUID, payload: S8CanonicalPayload): Promise<{ job: S8MaxJob; artifact: S8MaxExport; output: S8MaxProviderGenerationOutput; manifest: import("./types").S8MaxSemanticManifestDocument; manifestHash: Sha256; manifestBytes: Buffer }> {
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); const liveArtifact = liveJob ? s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId) : undefined;
      if (!liveJob || !liveArtifact || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      liveJob.status = "provider_pending"; liveArtifact.status = "provider_pending"; liveJob.generationProviderAttempts += 1; liveJob.updatedAt = this.clock(); liveArtifact.updatedAt = liveJob.updatedAt;
      if (liveJob.generationProviderAttempts > S8_MAX_PROVIDER_ATTEMPTS) fail(409, "S8_PROVIDER_ATTEMPTS_EXHAUSTED");
    });
    const running = this.snapshot(job.jobId).job;
    this.fence(job.projectId, job.sourceStamp, "provider-submit", running);
    let output: S8MaxProviderGenerationOutput;
    try {
      output = await this.provider.generate(this.providerInput(running, payload));
    } catch (error) {
      throw error;
    }
    this.fence(job.projectId, job.sourceStamp, "provider-result", running);
    if (output.artifactBytes.length === 0 || output.artifactBytes.length > S8_MAX_NATIVE_BYTES || output.nativeSaveOutcome !== "pass") throw new S8MaxProviderError("S8_NATIVE_SAVE_FAILED", "generation", false);
    if (output.binding.sourceStampDigest !== job.sourceStampDigest || output.binding.payloadSha256 !== job.payloadSha256) throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "generation", true, "binding", "transfer_defect");
    try { validateS8SemanticBinding(output.binding); } catch { throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "generation", true, "tool binding", "compatibility"); }
    const binding = output.binding;
    const manifest = buildS8SemanticManifest({ projectId: job.projectId, artifactId: job.artifactId, sourceStamp: job.sourceStamp, payloadSha256: job.payloadSha256, binding }, payload.payload);
    const bytes = manifestBytes(manifest);
    if (bytes.length > S8_MAX_MANIFEST_BYTES) throw new S8MaxProviderError("APS_OUTPUT_UPLOAD_FAILED", "generation", true, "manifest limit", "transfer_defect");
    return { job: this.snapshot(job.jobId).job, artifact: this.snapshot(job.jobId).artifact, output, manifest, manifestHash: sha256(bytes), manifestBytes: bytes };
  }

  private stage(job: S8MaxJob, artifact: S8MaxExport, claimToken: UUID, payload: S8CanonicalPayload, generated: Awaited<ReturnType<S8MaxService["generation"]>>): void {
    this.fence(job.projectId, job.sourceStamp, "staging", job);
    const artifactBytes = generated.output.artifactBytes;
    try {
      putExactOrThrow(this.objects, artifact.privatePayloadStorageKey, payload.bytes);
      putExactOrThrow(this.objects, artifact.privateStagingStorageKey, artifactBytes);
      putExactOrThrow(this.objects, s8FinalManifestStorageKey(job.projectId, artifact.manifestId), generated.manifestBytes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new S8MaxProviderError("APS_OUTPUT_UPLOAD_FAILED", "generation", true);
    }
    const generationWithoutHash: S8MaxGenerationReceipt = {
      schemaVersion: "s8-max-generation-receipt-v1", receiptId: this.uuid(), projectId: job.projectId, artifactId: artifact.artifactId,
      sourceStamp: cloneStamp(job.sourceStamp), sourceStampDigest: job.sourceStampDigest, payloadSha256: job.payloadSha256, binding: cloneJson(generated.output.binding), artifactSha256: sha256(artifactBytes), artifactByteSize: artifactBytes.length,
      manifestId: artifact.manifestId, manifestHash: generated.manifestHash, nativeSaveOutcome: generated.output.nativeSaveOutcome, outcome: "pass", checkedAt: this.clock(), receiptHash: "" as Sha256,
    };
    const receipt = { ...generationWithoutHash, receiptHash: hashS8GenerationReceipt(generationWithoutHash) };
    if (Buffer.byteLength(jcs(receipt), "utf8") > S8_MAX_GENERATION_RECEIPT_BYTES) throw new S8MaxProviderError("APS_OUTPUT_UPLOAD_FAILED", "generation", true, "receipt limit");
    this.fence(job.projectId, job.sourceStamp, "staging", job);
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); const liveArtifact = liveJob ? s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId) : undefined;
      if (!liveJob || !liveArtifact || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      if (!s8.s8MaxManifests.some((item) => item.manifestId === artifact.manifestId)) {
        const manifest: S8MaxManifestRecord = { schemaVersion: "s8-max-manifest-record-v1", manifestId: artifact.manifestId, projectId: job.projectId, artifactId: artifact.artifactId, sourceStamp: cloneStamp(job.sourceStamp), sourceStampDigest: job.sourceStampDigest, payloadSha256: job.payloadSha256, manifestHash: generated.manifestHash, manifestByteSize: generated.manifestBytes.length, document: cloneJson(generated.manifest), privateStorageKey: s8FinalManifestStorageKey(job.projectId, artifact.manifestId) };
        s8.s8MaxManifests.push(manifest);
      }
      if (!s8.s8MaxGenerationReceipts.some((item) => item.receiptId === receipt.receiptId)) s8.s8MaxGenerationReceipts.push(receipt);
      const at = this.clock(); liveArtifact.status = "staged"; liveArtifact.publicationPhase = "staged"; liveArtifact.generationReceiptId = receipt.receiptId; liveArtifact.artifactSha256 = receipt.artifactSha256; liveArtifact.artifactByteSize = receipt.artifactByteSize; liveArtifact.failureCode = null; liveArtifact.controllerRequired = false; liveArtifact.updatedAt = at; liveJob.status = "staged"; liveJob.stage = "generation"; liveJob.controllerRequired = false; liveJob.updatedAt = at; liveJob.heartbeatAt = at;
    });
  }

  private promote(job: S8MaxJob, artifact: S8MaxExport, claimToken: UUID): void {
    const staged = this.objects.read(artifact.privateStagingStorageKey);
    this.fence(job.projectId, job.sourceStamp, "promotion", job);
    this.objects.promoteExact(artifact.privateStagingStorageKey, artifact.privateFinalStorageKey, staged);
    this.fence(job.projectId, job.sourceStamp, "promotion", job);
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); const liveArtifact = liveJob ? s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId) : undefined;
      if (!liveJob || !liveArtifact || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock(); liveArtifact.status = "validating"; liveArtifact.publicationPhase = "promoted"; liveArtifact.controllerRequired = false; liveArtifact.updatedAt = at; liveJob.status = "validating"; liveJob.stage = "validation"; liveJob.controllerRequired = false; liveJob.updatedAt = at; liveJob.heartbeatAt = at;
    });
  }

  private async validateAndCommit(job: S8MaxJob, artifact: S8MaxExport, claimToken: UUID, payload: S8CanonicalPayload): Promise<void> {
    const current = this.snapshot(job.jobId); const manifestRecord = getS8Collections(this.repository.state()).manifests.find((item) => item.manifestId === current.artifact.manifestId);
    if (!manifestRecord) fail(500, "S8_PERSISTENCE_INVALID");
    const finalBytes = this.objects.read(current.artifact.privateFinalStorageKey); const artifactHash = sha256(finalBytes);
    if (current.artifact.artifactSha256 !== artifactHash || current.artifact.artifactByteSize !== finalBytes.length) throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "validation", true, "final artifact", "transfer_defect");
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); if (!liveJob || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      liveJob.validationProviderAttempts += 1; if (liveJob.validationProviderAttempts > S8_MAX_PROVIDER_ATTEMPTS) fail(409, "S8_PROVIDER_ATTEMPTS_EXHAUSTED"); liveJob.status = "provider_pending"; liveJob.updatedAt = this.clock();
      const liveArtifact = s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId); if (!liveArtifact) fail(500, "S8_PERSISTENCE_INVALID"); liveArtifact.status = "provider_pending"; liveArtifact.updatedAt = liveJob.updatedAt;
    });
    const running = this.snapshot(job.jobId).job; this.fence(job.projectId, job.sourceStamp, "validation", running);
    let output: S8MaxProviderValidationOutput;
    try {
      output = await this.provider.validate({ ...this.providerInput(running, payload), artifactBytes: finalBytes, artifactSha256: artifactHash, artifactByteSize: finalBytes.length, manifest: manifestRecord.document, binding: (getS8Collections(this.repository.state()).generationReceipts.find((item) => item.artifactId === artifact.artifactId)?.binding ?? providerBindingFallback(job.sourceStamp, job.payloadSha256, "validation", this.provider.providerKind)) });
    } catch (error) {
      throw error;
    }
    this.fence(job.projectId, job.sourceStamp, "validation", running);
    if (output.readback.artifactSha256 !== artifactHash || output.readback.artifactByteSize !== finalBytes.length || output.readback.sourceStampDigest !== job.sourceStampDigest || output.readback.payloadSha256 !== job.payloadSha256) throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "validation", true, "readback binding", "transfer_defect");
    const comparison = compareS8SemanticManifest(manifestRecord.document, output.readback);
    if (comparison.outcome !== "pass") throw new S8MaxProviderError("APS_VALIDATOR_FAILED", "validation", false, comparison.issues.join(","), "semantic");
    const checkedAt = this.clock();
    const receiptWithoutHash: S8MaxValidationReceipt = {
      schemaVersion: "s8-max-validation-receipt-v1", receiptId: this.uuid(), projectId: job.projectId, artifactId: artifact.artifactId, sourceStamp: cloneStamp(job.sourceStamp), sourceStampDigest: job.sourceStampDigest, payloadSha256: job.payloadSha256,
      binding: cloneJson(output.binding), manifestId: artifact.manifestId, manifestHash: manifestRecord.manifestHash, artifactSha256: artifactHash, artifactByteSize: finalBytes.length, readback: cloneJson(output.readback), readbackHash: output.readback.readbackHash, outcome: "pass", issues: [], checkedAt, receiptHash: "" as Sha256,
    };
    const validationReceipt = { ...receiptWithoutHash, receiptHash: hashS8ValidationReceipt(receiptWithoutHash) };
    if (Buffer.byteLength(jcs(validationReceipt), "utf8") > S8_MAX_READBACK_BYTES) throw new S8MaxProviderError("APS_VALIDATOR_FAILED", "validation", true, "receipt limit", "transfer_defect");
    await this.recordProviderMetadata(output.metadata);
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); const liveArtifact = liveJob ? s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId) : undefined;
      if (!liveJob || !liveArtifact || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      if (!s8.s8MaxValidationReceipts.some((item) => item.receiptId === validationReceipt.receiptId)) s8.s8MaxValidationReceipts.push(validationReceipt);
      const at = this.clock(); liveArtifact.validationReceiptId = validationReceipt.receiptId; liveArtifact.status = "validated"; liveArtifact.publicationPhase = "promoted"; liveArtifact.failureCode = null; liveArtifact.controllerRequired = false; liveArtifact.updatedAt = at; liveJob.status = "validated"; liveJob.stage = "validation"; liveJob.controllerRequired = false; liveJob.updatedAt = at; liveJob.heartbeatAt = at;
    });
    const validated = this.snapshot(job.jobId); this.fence(job.projectId, job.sourceStamp, "commit", validated.job);
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const liveJob = s8.s8MaxJobs.find((item) => item.jobId === job.jobId); const liveArtifact = liveJob ? s8.s8MaxExports.find((item) => item.artifactId === liveJob.artifactId) : undefined;
      if (!liveJob || !liveArtifact || liveJob.claimToken !== claimToken || liveJob.ownerProcessId !== this.ownerProcessId) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock(); liveArtifact.status = "committed"; liveArtifact.publicationPhase = "committed"; liveArtifact.committedAt = at; liveArtifact.updatedAt = at; liveArtifact.controllerRequired = false; liveJob.status = "committed"; liveJob.stage = "complete"; liveJob.terminalAt = at; liveJob.controllerRequired = false; liveJob.updatedAt = at; clearClaim(liveJob);
    });
    this.currentSource(job.projectId, job.sourceStamp);
  }

  private async processClaim(claim: ClaimResult, payload: S8CanonicalPayload): Promise<S8MaxExport> {
    const { job, artifact, claimToken } = claim; if (!claim.acquired || claimToken === null) return artifact;
    try {
      let currentJob = job; let currentArtifact = artifact;
      if (currentArtifact.publicationPhase === "none") {
        this.fence(job.projectId, job.sourceStamp, "payload", currentJob);
        this.objects.putExact(currentArtifact.privatePayloadStorageKey, payload.bytes);
        const generated = await this.generation(currentJob, currentArtifact, claimToken, payload);
        currentJob = generated.job; currentArtifact = generated.artifact;
        await this.recordProviderMetadata(generated.output.metadata);
        this.stage(currentJob, currentArtifact, claimToken, payload, generated);
      }
      currentJob = this.snapshot(job.jobId).job; currentArtifact = this.snapshot(job.jobId).artifact;
      if (currentArtifact.publicationPhase === "staged") {
        this.promote(currentJob, currentArtifact, claimToken);
      }
      currentJob = this.snapshot(job.jobId).job; currentArtifact = this.snapshot(job.jobId).artifact;
      if (currentArtifact.publicationPhase === "promoted") await this.validateAndCommit(currentJob, currentArtifact, claimToken, payload);
      return this.snapshot(job.jobId).artifact;
    } catch (error) {
      if (isSourceBoundaryError(error)) {
        await this.markFailure(job.jobId, claimToken, error);
        throw error;
      }
      await this.markFailure(job.jobId, claimToken, error);
      return this.snapshot(job.jobId).artifact;
    }
  }

  async process(jobId: UUID): Promise<S8MaxExport> {
    const before = this.snapshot(jobId);
    if (!["queued", "provider_hold"].includes(before.job.status)) return before.artifact;
    if (before.job.status === "provider_hold" && before.job.controllerRequired) return before.artifact;
    const providerAttempts = before.job.stage === "validation" ? before.job.validationProviderAttempts : before.job.generationProviderAttempts;
    if (before.job.status === "provider_hold" && providerAttempts >= S8_MAX_PROVIDER_ATTEMPTS) return before.artifact;
    const admitted = this.currentSource(before.job.projectId, before.job.sourceStamp);
    if (admitted.payload.sha256 !== before.job.payloadSha256) fail(409, "SOURCE_STALE", "source");
    const claim = await this.claim(jobId);
    if (!claim.acquired) return claim.artifact;
    return this.processClaim(claim, admitted.payload);
  }

  async createExport(projectId: UUID, idempotencyKey: string): Promise<S8MaxExportResult> {
    assertOpaqueKey(idempotencyKey); this.projectExists(projectId);
    const admitted = this.readSource(projectId);
    this.reconcileSourceMovement(projectId, admitted.stamp);
    const digest = sourceStampDigest(admitted.stamp); const operationInput = inputHash(projectId, admitted.stamp, admitted.payload.sha256);
    this.onPublicationPhase?.("admission", { projectId, jobId: admitted.s6Handoff.acceptedRevisionId, artifactId: admitted.s7Handoff.s7ArtifactId, candidateAttempt: 1 });
    this.fence(projectId, admitted.stamp, "payload", { jobId: admitted.s6Handoff.acceptedRevisionId, artifactId: admitted.s7Handoff.s7ArtifactId, projectId, sourceStamp: admitted.stamp, sourceStampDigest: digest, payloadSha256: admitted.payload.sha256, inputHash: operationInput, idempotencyKey, candidateAttempt: 1, retryOfJobId: null, stage: "generation", status: "queued", generationProviderAttempts: 0, validationProviderAttempts: 0, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, terminalAt: null, controllerRequired: false, createdAt: this.clock(), updatedAt: this.clock(), schemaVersion: "s8-max-job-v1" });
    const existing = getS8Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputHash !== operationInput || existing.sourceStampDigest !== digest) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const current = this.snapshot(existing.jobId); return { replayed: true, export: publicExport(current.artifact), job: { jobId: current.job.jobId, status: current.job.status, candidateAttempt: current.job.candidateAttempt, stage: current.job.stage } };
    }
    const at = this.clock(); const artifactId = this.uuid(); const jobId = this.uuid(); const manifestId = this.uuid();
    const artifact: S8MaxExport = { schemaVersion: "s8-max-export-v1", artifactId, projectId, jobId, sourceStamp: cloneStamp(admitted.stamp), sourceStampDigest: digest, payloadSha256: admitted.payload.sha256, payloadByteSize: admitted.payload.byteSize, inputHash: operationInput, status: "queued", publicationPhase: "none", candidateAttempt: 1, retryOfArtifactId: null, manifestId, generationReceiptId: null, validationReceiptId: null, artifactSha256: null, artifactByteSize: null, privateFinalStorageKey: s8FinalMaxStorageKey(projectId, artifactId), privateStagingStorageKey: s8StagingMaxStorageKey(projectId, jobId, "unclaimed"), privatePayloadStorageKey: s8StagingPayloadStorageKey(projectId, jobId, "unclaimed"), failureCode: null, controllerRequired: false, createdAt: at, updatedAt: at, committedAt: null, staleAt: null, supersededAt: null };
    const job: S8MaxJob = { schemaVersion: "s8-max-job-v1", jobId, projectId, artifactId, sourceStamp: cloneStamp(admitted.stamp), sourceStampDigest: digest, payloadSha256: admitted.payload.sha256, inputHash: operationInput, idempotencyKey, candidateAttempt: 1, retryOfJobId: null, stage: "generation", status: "queued", generationProviderAttempts: 0, validationProviderAttempts: 0, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null, controllerRequired: false };
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const collision = s8.s8MaxIdempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
      if (collision) { if (collision.inputHash !== operationInput || collision.sourceStampDigest !== digest) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key"); return; }
      s8.s8MaxExports.push(artifact); s8.s8MaxJobs.push(job); s8.s8MaxIdempotency.push({ schemaVersion: "s8-max-idempotency-v1", projectId, operation: "export", idempotencyKey, sourceStamp: cloneStamp(admitted.stamp), sourceStampDigest: digest, inputHash: operationInput, jobId, artifactId, createdAt: at });
    });
    const processed = await this.process(jobId); const latest = this.snapshot(processed.jobId); return { replayed: false, export: publicExport(processed), job: { jobId: latest.job.jobId, status: latest.job.status, candidateAttempt: latest.job.candidateAttempt, stage: latest.job.stage } };
  }

  async retryExport(projectId: UUID, artifactId: UUID, idempotencyKey = `s8-retry-${artifactId}`): Promise<S8MaxExportResult> {
    assertOpaqueKey(idempotencyKey); this.projectExists(projectId);
    const currentSource = this.readSource(projectId); const existingArtifact = getS8Collections(this.repository.state()).exports.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!existingArtifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    if (!sameS8Source(existingArtifact.sourceStamp, currentSource.stamp)) { this.reconcileSourceMovement(projectId, currentSource.stamp); fail(409, "SOURCE_STALE", "source"); }
    if (existingArtifact.status === "provider_hold" && existingArtifact.controllerRequired) fail(409, "S8_RETRY_NOT_AVAILABLE", "artifact");
    this.onPublicationPhase?.("retry", { projectId, jobId: existingArtifact.jobId, artifactId, candidateAttempt: existingArtifact.candidateAttempt });
    this.currentSource(projectId, currentSource.stamp);
    const existingRetry = getS8Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "retry" && item.idempotencyKey === idempotencyKey);
    if (existingRetry) {
      if (existingRetry.inputHash !== existingArtifact.inputHash || existingRetry.sourceStampDigest !== sourceStampDigest(currentSource.stamp)) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const target = this.snapshot(existingRetry.jobId); if (target.job.status === "provider_hold" || target.job.status === "queued") await this.process(target.job.jobId); const latest = this.snapshot(target.job.jobId); return { replayed: true, export: publicExport(latest.artifact), job: { jobId: latest.job.jobId, status: latest.job.status, candidateAttempt: latest.job.candidateAttempt, stage: latest.job.stage } };
    }
    let targetJobId = existingArtifact.jobId; let targetArtifactId = artifactId; let createdAttemptTwo = false;
    this.repository.transact((state) => {
      const s8 = requireS8State(state);
      const prior = s8.s8MaxExports.find((item) => item.projectId === projectId && item.artifactId === artifactId); const priorJob = prior ? s8.s8MaxJobs.find((item) => item.jobId === prior.jobId) : undefined;
      if (!prior || !priorJob) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
      if (!sameS8Source(prior.sourceStamp, currentSource.stamp) || priorJob.status !== prior.status) fail(409, "SOURCE_STALE", "source");
      if (prior.status === "provider_hold") {
        if (prior.controllerRequired || priorJob.controllerRequired) fail(409, "S8_RETRY_NOT_AVAILABLE", "artifact");
        s8.s8MaxIdempotency.push({ schemaVersion: "s8-max-idempotency-v1", projectId, operation: "retry", idempotencyKey, sourceStamp: cloneStamp(currentSource.stamp), sourceStampDigest: sourceStampDigest(currentSource.stamp), inputHash: prior.inputHash, jobId: priorJob.jobId, artifactId: prior.artifactId, createdAt: this.clock() });
        targetJobId = priorJob.jobId; targetArtifactId = prior.artifactId; return;
      }
      if (prior.status !== "failed_retryable" || prior.candidateAttempt !== 1 || prior.retryOfArtifactId !== null || priorJob.retryOfJobId !== null || s8.s8MaxExports.some((item) => item.retryOfArtifactId === prior.artifactId) || s8.s8MaxJobs.some((item) => item.retryOfJobId === priorJob.jobId)) fail(409, "S8_RETRY_NOT_AVAILABLE", "artifact");
      const at = this.clock(); targetArtifactId = this.uuid(); targetJobId = this.uuid(); const manifestId = this.uuid();
      const artifact: S8MaxExport = { ...cloneJson(prior), artifactId: targetArtifactId, jobId: targetJobId, sourceStamp: cloneStamp(currentSource.stamp), sourceStampDigest: sourceStampDigest(currentSource.stamp), status: "queued", publicationPhase: "none", candidateAttempt: 2, retryOfArtifactId: prior.artifactId, manifestId, generationReceiptId: null, validationReceiptId: null, artifactSha256: null, artifactByteSize: null, privateFinalStorageKey: s8FinalMaxStorageKey(projectId, targetArtifactId), privateStagingStorageKey: s8StagingMaxStorageKey(projectId, targetJobId, "unclaimed"), privatePayloadStorageKey: s8StagingPayloadStorageKey(projectId, targetJobId, "unclaimed"), failureCode: null, controllerRequired: false, createdAt: at, updatedAt: at, committedAt: null, staleAt: null, supersededAt: null };
      const job: S8MaxJob = { ...cloneJson(priorJob), jobId: targetJobId, artifactId: targetArtifactId, sourceStamp: cloneStamp(currentSource.stamp), sourceStampDigest: sourceStampDigest(currentSource.stamp), status: "queued", candidateAttempt: 2, retryOfJobId: priorJob.jobId, stage: "generation", generationProviderAttempts: 0, validationProviderAttempts: 0, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, terminalAt: null, controllerRequired: false, createdAt: at, updatedAt: at };
      s8.s8MaxExports.push(artifact); s8.s8MaxJobs.push(job); s8.s8MaxIdempotency.push({ schemaVersion: "s8-max-idempotency-v1", projectId, operation: "retry", idempotencyKey, sourceStamp: cloneStamp(currentSource.stamp), sourceStampDigest: sourceStampDigest(currentSource.stamp), inputHash: prior.inputHash, jobId: targetJobId, artifactId: targetArtifactId, createdAt: at });
      createdAttemptTwo = true;
    });
    const processed = await this.process(targetJobId); const latest = this.snapshot(targetJobId); return { replayed: !createdAttemptTwo, export: publicExport(processed), job: { jobId: latest.job.jobId, status: latest.job.status, candidateAttempt: latest.job.candidateAttempt, stage: latest.job.stage } };
  }

  recoverPending(): number {
    const state = this.state(); const pending = state.s8MaxJobs.filter((job) => ["running", "provider_pending", "provider_running", "staged", "validating", "validated"].includes(job.status) && job.ownerProcessId !== null);
    if (pending.length > RECOVERY_MAX) fail(500, "S8_RESOURCE_LIMIT", "recovery");
    const heartbeatTimeoutMs = S8_MAX_RECOVERY_HEARTBEAT_SECONDS * 1000;
    let recovered = 0;
    for (const pendingJob of pending) {
      const nowMs = Date.parse(this.clock()); const heartbeatMs = pendingJob.heartbeatAt === null ? Number.NaN : Date.parse(pendingJob.heartbeatAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs <= heartbeatTimeoutMs) continue;
      let ownerAlive: boolean;
      try { ownerAlive = this.isOwnerProcessAlive ? this.isOwnerProcessAlive(pendingJob.ownerProcessId!) : true; } catch { continue; }
      if (ownerAlive !== false) continue;
      try { this.currentSource(pendingJob.projectId, pendingJob.sourceStamp); } catch { continue; }
      let reclaimed = false;
      this.repository.transact((fresh) => {
        const s8 = requireS8State(fresh);
        const job = s8.s8MaxJobs.find((item) => item.jobId === pendingJob.jobId); const artifact = job ? s8.s8MaxExports.find((item) => item.artifactId === job.artifactId) : undefined;
        if (!job || !artifact || job.ownerProcessId !== pendingJob.ownerProcessId || job.heartbeatAt !== pendingJob.heartbeatAt || !["running", "provider_pending", "provider_running", "staged", "validating", "validated"].includes(job.status)) return;
        const freshNowMs = Date.parse(this.clock()); const freshHeartbeatMs = job.heartbeatAt === null ? Number.NaN : Date.parse(job.heartbeatAt);
        if (!Number.isFinite(freshNowMs) || !Number.isFinite(freshHeartbeatMs) || freshNowMs - freshHeartbeatMs <= heartbeatTimeoutMs) return;
        const at = this.clock(); const uncertainProvider = ["provider_pending", "provider_running", "staged", "validating", "validated"].includes(job.status);
        if (uncertainProvider) {
          job.status = "provider_hold"; job.controllerRequired = true; artifact.status = "provider_hold"; artifact.failureCode = "APS_WORKITEM_FAILED"; artifact.controllerRequired = true;
        } else {
          job.status = "queued"; job.controllerRequired = false; artifact.status = "queued"; artifact.publicationPhase = "none"; artifact.generationReceiptId = null; artifact.validationReceiptId = null; artifact.artifactSha256 = null; artifact.artifactByteSize = null; artifact.failureCode = null; artifact.controllerRequired = false; artifact.privateStagingStorageKey = s8StagingMaxStorageKey(artifact.projectId, job.jobId, "unclaimed"); artifact.privatePayloadStorageKey = s8StagingPayloadStorageKey(artifact.projectId, job.jobId, "unclaimed");
        }
        clearClaim(job); job.updatedAt = at; artifact.updatedAt = at; reclaimed = true;
      });
      if (!reclaimed) continue;
      try { this.currentSource(pendingJob.projectId, pendingJob.sourceStamp); } catch { /* source reconciliation is the safe post-recovery outcome */ }
      recovered += 1;
    }
    return recovered;
  }

  getState(projectId: UUID): S8MaxPublicState {
    this.projectExists(projectId); let source: S8SourceAdmission | null = null;
    try { source = this.readSource(projectId); this.reconcileSourceMovement(projectId, source.stamp); } catch { source = null; }
    const collections = getS8Collections(this.repository.state());
    return { projectId, source: source ? { readiness: "ready", sourceStampDigest: sourceStampDigest(source.stamp), s6RevisionId: source.stamp.s6RevisionId, s6RevisionHash: source.stamp.s6RevisionHash } : { readiness: "not_ready", sourceStampDigest: null, s6RevisionId: null, s6RevisionHash: null }, exports: collections.exports.filter((item) => item.projectId === projectId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(publicExport) };
  }

  getExport(projectId: UUID, artifactId: UUID): S8MaxPublicExport {
    this.projectExists(projectId); const artifact = getS8Collections(this.repository.state()).exports.find((item) => item.projectId === projectId && item.artifactId === artifactId); if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    const source = this.readSource(projectId); if (!sameS8Source(artifact.sourceStamp, source.stamp)) { this.reconcileSourceMovement(projectId, source.stamp); fail(409, "SOURCE_STALE", "source"); }
    if (artifact.status === "committed") this.download(projectId, artifactId);
    return publicExport(artifact);
  }

  download(projectId: UUID, artifactId: UUID): S8DownloadResult {
    this.projectExists(projectId); const artifact = getS8Collections(this.repository.state()).exports.find((item) => item.projectId === projectId && item.artifactId === artifactId); if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    const source = this.readSource(projectId); if (!sameS8Source(artifact.sourceStamp, source.stamp)) { this.reconcileSourceMovement(projectId, source.stamp); fail(409, "SOURCE_STALE", "source"); }
    if (artifact.status !== "committed" || artifact.artifactSha256 === null || artifact.artifactByteSize === null || artifact.validationReceiptId === null || artifact.generationReceiptId === null) fail(409, "S8_EXPORT_NOT_READY", "artifact");
    this.onPublicationPhase?.("download", { projectId, jobId: artifact.jobId, artifactId, candidateAttempt: artifact.candidateAttempt });
    this.currentSource(projectId, source.stamp);
    const bytes = this.objects.read(artifact.privateFinalStorageKey); if (bytes.length !== artifact.artifactByteSize || sha256(bytes) !== artifact.artifactSha256) fail(409, "S8_OUTPUT_INTEGRITY_MISMATCH", "artifact");
    const collections = getS8Collections(this.repository.state()); const manifest = collections.manifests.find((item) => item.manifestId === artifact.manifestId); const generation = collections.generationReceipts.find((item) => item.receiptId === artifact.generationReceiptId); const validation = collections.validationReceipts.find((item) => item.receiptId === artifact.validationReceiptId); if (!manifest || !generation || !validation || generation.artifactSha256 !== artifact.artifactSha256 || generation.artifactByteSize !== artifact.artifactByteSize || validation.artifactSha256 !== artifact.artifactSha256 || validation.artifactByteSize !== artifact.artifactByteSize || !sameS8Source(validation.sourceStamp, source.stamp)) fail(409, "S8_READBACK_FAILED", "artifact");
    const comparison = compareS8SemanticManifest(manifest.document, validation.readback); if (comparison.outcome !== "pass") fail(409, "S8_READBACK_FAILED", "artifact");
    this.currentSource(projectId, source.stamp);
    return { bytes, contentType: "application/octet-stream", fileName: S8_NATIVE_FILE_NAME };
  }

  getTelemetry(projectId: UUID): S8MaxTelemetry {
    this.projectExists(projectId); let sourceReadiness: "ready" | "not_ready" = "not_ready"; try { sourceReadiness = this.readSource(projectId) ? "ready" : "not_ready"; } catch { sourceReadiness = "not_ready"; }
    const items = getS8Collections(this.repository.state()).exports.filter((item) => item.projectId === projectId); const metric = <T>(value: T | null, available = true, reason: string | null = null) => ({ availability: available ? "available" as const : "unavailable" as const, value, reason });
    return { schemaVersion: "s8-max-telemetry-v1", projectId, sourceReadiness: metric(sourceReadiness), exportCount: metric(items.length), committedExportCount: metric(items.filter((item) => item.status === "committed").length), retryCount: metric(items.filter((item) => item.candidateAttempt === 2).length), providerHoldCount: metric(items.filter((item) => item.status === "provider_hold").length), staleCount: metric(items.filter((item) => item.status === "stale").length), supersededCount: metric(items.filter((item) => item.status === "superseded").length), failedCount: metric(items.filter((item) => ["failed_retryable", "failed_terminal"].includes(item.status)).length), validationPassCount: metric(items.filter((item) => item.validationReceiptId !== null).length), committedArtifactByteSize: metric(items.filter((item) => item.status === "committed").reduce((sum, item) => sum + (item.artifactByteSize ?? 0), 0)), generatedAt: this.clock() };
  }

  getHandoff(projectId: UUID): S8MaxHandoff {
    const source = this.readSource(projectId); return { schemaVersion: "s8-max-handoff-v1", projectId, sourceStamp: cloneStamp(source.stamp), sourceStampDigest: sourceStampDigest(source.stamp), payloadSha256: source.payload.sha256, payloadByteSize: source.payload.byteSize, transportFileName: S8_TRANSPORT_FILE_NAME, nativeOutputFileName: S8_NATIVE_FILE_NAME, construction: cloneJson(source.payload.payload.construction), s6Handoff: cloneJson(source.s6Handoff), eligibility: { sourceCurrent: true, s6Accepted: true, s7Committed: true, stale: false } };
  }
}

function putExactOrThrow(objects: PrivateObjectStore, key: string, bytes: Uint8Array): void {
  if (objects.exists(key)) {
    const actual = objects.read(key); if (!actual.equals(Buffer.from(bytes))) throw new AppError(409, "S8_OUTPUT_EXISTS", [{ field: "storage", code: "S8_OUTPUT_EXISTS" }]);
    return;
  }
  objects.putExact(key, bytes);
}

function errorMetadataFromProviderError(error: S8MaxProviderError, job: S8MaxJob, provider: S8MaxProvider["providerKind"], clock: () => Timestamp, uuid: () => UUID): S8MaxProviderMetadata {
  const binding = providerBindingFallback(job.sourceStamp, job.payloadSha256, error.stage, provider);
  const attempt = error.stage === "generation" ? Math.max(job.generationProviderAttempts, 1) : Math.max(job.validationProviderAttempts, 1);
  const disposition = classifyS8ProviderFailure(error.code, error.cause);
  return { schemaVersion: "s8-max-provider-metadata-v1", metadataId: uuid(), projectId: job.projectId, artifactId: job.artifactId, jobId: job.jobId, stage: error.stage, provider, providerAttempt: Math.min(attempt, S8_MAX_PROVIDER_ATTEMPTS), outcome: disposition.classification === "provider_hold" && disposition.retryable ? "hold" : "fail", failureCode: error.code, engineId: binding.engineId, productVersion: binding.productVersion, engineVersion: binding.engineVersion, appBundleId: error.stage === "generation" ? binding.generationAppBundleId : binding.validatorAppBundleId, appBundleVersion: error.stage === "generation" ? binding.generationAppBundleVersion : binding.validatorAppBundleVersion, appBundleHash: error.stage === "generation" ? binding.generationAppBundleHash : binding.validatorAppBundleHash, activityId: error.stage === "generation" ? binding.generationActivityId : binding.validatorActivityId, activityVersion: error.stage === "generation" ? binding.generationActivityVersion : binding.validatorActivityVersion, activityHash: error.stage === "generation" ? binding.generationActivityHash : binding.validatorActivityHash, occurredAt: clock() };
}

export const createS8MaxService = (options: S8MaxServiceOptions): S8MaxService => new S8MaxService(options);
