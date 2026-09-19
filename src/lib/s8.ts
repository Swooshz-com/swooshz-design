import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { AppError, type S6ToS7Handoff, type S7ToS8Handoff, type S8Artifact, type S8ExportJob, type S8IdempotencyRecord, type S8SourceStamp, type S8ValidationReceipt, type Timestamp, type UUID } from "./types";
import { buildS8WriterPayload, canonicalS8Json, canonicalS8SourceJson, type S8WriterPayload } from "./s8-fbx-payload";
import { compareS8UfbxReadback, type S8SemanticResult, type S8UfbxReadback } from "./s8-fbx-semantic";
import { S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_EXPORTER_SETTINGS, S8_FBX_PROFILE, S8_LIMITS, S8_PROCESS_RUNNER_PIN, S8_PROTOCOL_VERSION, S8_RESOURCE_TABLE, S8_REUSE_FINGERPRINT_VERSION, S8_SEMANTIC_VERSION, S8_UFBX_PIN, S8_VALIDATOR_PIN, S8_WRITER_RECEIPT_VERSION, s8Sha256 } from "./s8-fbx-profile";
import { getS8Collections, sameS8Source, s8FinalKey, s8FinalPrefix, s8ObjectKey, s8ResourceLimitsHash, s8StagingKey, s8StagingPrefix, S8_OBJECT_NAMES, S8_STALE_CLAIM_MS } from "./s8-fbx-persistence";
import { JsonRepository, PrivateObjectStore } from "./store";
import { jcs, newUuid, nowUtc, sha256, uuidV4Pattern } from "./utils";
import { S6WorkflowService } from "./s6";
import { S7CadService } from "./s7-cad";
import { runS8BlenderWriter, runS8NativeValidator, type S8WorkerConfig, type S8WriterReceipt, type S8WriterResult } from "./s8-fbx-worker";

export type S8PreparedExport = {
  profile: typeof S8_FBX_PROFILE;
  semanticVersion: typeof S8_SEMANTIC_VERSION;
  sourceRevisionId: string;
  sourceRevisionHash: string;
  objectNames: string[];
  payloadBytes: Buffer;
  payloadSha256: string;
};

export type S8PublicArtifact = Omit<S8Artifact, "privateStagingPrefix" | "privateFinalPrefix">;

export type S8ExportResult = {
  replayed: boolean;
  export: S8PublicArtifact;
  job: Pick<S8ExportJob, "jobId" | "status" | "attempt">;
};

export type S8DownloadResult = {
  bytes: Buffer;
  contentType: "application/octet-stream";
  fileName: "swooshz-s8-scene.fbx";
};

export type S8NativeValidationResult = {
  readback: S8UfbxReadback;
  readbackBytes?: Buffer;
  validatorIdentity?: string;
  runnerIdentity?: string;
  appliedLimits?: Record<string, number | string>;
  stdout?: string;
  stderr?: string;
};

export type S8AdapterContext = {
  projectId: UUID;
  jobId: UUID;
  artifactId: UUID;
  source: S8SourceStamp;
  payload: S8WriterPayload;
  onHeartbeat: () => void;
};

export type S8ExportAdapters = {
  writer?: (payloadBytes: Buffer, context: S8AdapterContext) => S8WriterResult;
  nativeValidator?: (artifact: Buffer, context: S8AdapterContext) => S8NativeValidationResult;
  semanticValidator?: (s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback) => S8SemanticResult;
};

export type S8PublicationPhaseHook = (phase: S8ExportJob["publicationPhase"], context: { projectId: UUID; jobId: UUID; artifactId: UUID }) => void;

export type S8ExportServiceOptions = {
  repository: JsonRepository;
  objects: PrivateObjectStore;
  s6: S6WorkflowService;
  s7: S7CadService;
  clock?: () => Timestamp;
  uuid?: () => UUID;
  ownerId?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  adapters?: S8ExportAdapters;
  writerConfig?: S8WorkerConfig;
  onPublicationPhase?: S8PublicationPhaseHook;
};

type AdmittedSource = { s6: S6ToS7Handoff; s7: S7ToS8Handoff; stamp: S8SourceStamp; prepared: ReturnType<typeof buildS8WriterPayload> };
type PublicationIdentity = {
  fingerprintVersion: typeof S8_REUSE_FINGERPRINT_VERSION;
  source: S8SourceStamp;
  profile: typeof S8_FBX_PROFILE;
  protocol: typeof S8_PROTOCOL_VERSION;
  semanticVersion: typeof S8_SEMANTIC_VERSION;
  writerReceiptVersion: typeof S8_WRITER_RECEIPT_VERSION;
  writerRuntime: unknown;
  exporterPatch: { identity: string; manifest: string; privateExporterSha256: string; manifestSha256: string };
  settingsHash: string;
  validator: { identity: string; ufbx: typeof S8_UFBX_PIN };
  runner: { identity: string; platform: string; childProcesses: number };
  resourceLimitsHash: string;
  payloadSha256: string;
  artifactSha256: string;
  artifactByteSize: number;
  receiptHashes: { writer: string; native: string; semantic: string };
  storage: { finalPrefix: string; objectNames: readonly string[] };
  publicationReceiptBodyHash: string;
};

const PHASE_ORDER: S8ExportJob["publicationPhase"][] = ["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"];

function fail(status: number, code: string, field = "s8"): never {
  throw new AppError(status, code, [{ field, code }]);
}

function assertOpaqueKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes("\\")) fail(400, "S8_INVALID_REQUEST", "Idempotency-Key");
}

function assertRequestReference(value: UUID): void {
  if (!uuidV4Pattern.test(value)) fail(400, "S8_INVALID_REQUEST", "requestReferenceId");
}

function publicArtifact(value: S8Artifact): S8PublicArtifact {
  const { privateStagingPrefix: _staging, privateFinalPrefix: _final, ...safe } = value;
  return { ...safe };
}

function jsonBytes(value: unknown, maximum: number, code: string): Buffer {
  const bytes = Buffer.from(jcs(value), "utf8");
  if (bytes.length > maximum) fail(422, code);
  return bytes;
}

function parseJson(bytes: Buffer, code: string): Record<string, unknown> {
  if (bytes.length === 0) fail(422, code);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(422, code);
    return value as Record<string, unknown>;
  } catch {
    fail(422, code);
  }
}

function stampFromSource(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8SourceStamp {
  return {
    projectId: s6.projectId,
    sourceRevisionId: s6.acceptedRevisionId,
    sourceRevisionHash: s6.acceptedRevisionHash,
    sourceS5Fingerprint: s6.sourceS5Fingerprint,
    s6ValidationReceiptId: s6.validationReceipt.receiptId,
    s6ValidationHash: s6.validationReceipt.validationHash,
    s6HandoffDigest: sha256(canonicalS8SourceJson(s6)),
    s7ArtifactId: s7.s7ArtifactId,
    s7ArtifactHash: s7.s7ArtifactHash,
    s7ReadbackHash: s7.readbackHash,
    s7ManifestId: s7.manifestId,
    s7ManifestHash: s7.manifestHash,
    s8Profile: S8_FBX_PROFILE,
    s8ProtocolVersion: S8_PROTOCOL_VERSION,
  };
}

function sourceError(error: unknown): AppError {
  if (error instanceof AppError && (error.code === "S8_SOURCE_STALE" || error.code === "S7_SOURCE_STALE" || error.code === "S6_SOURCE_STALE")) return new AppError(409, "S8_SOURCE_STALE", [{ field: "source", code: "S8_SOURCE_STALE" }]);
  if (error instanceof AppError && error.code.startsWith("S8_")) return error;
  return new AppError(409, "S8_SOURCE_NOT_READY", [{ field: "source", code: "S8_SOURCE_NOT_READY" }]);
}

function ownerIsAliveDefault(processId: number): boolean {
  try { process.kill(processId, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function phaseIndex(phase: S8ExportJob["publicationPhase"]): number { return PHASE_ORDER.indexOf(phase); }

function sourceAndArtifactEqual(left: S8Artifact, right: S8Artifact): boolean {
  return left.projectId === right.projectId && left.artifactId === right.artifactId && left.inputHash === right.inputHash && sameS8Source(left.source, right.source);
}

export function prepareS8Export(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8PreparedExport {
  const generated = buildS8WriterPayload(s6, s7);
  return { profile: S8_FBX_PROFILE, semanticVersion: S8_SEMANTIC_VERSION, sourceRevisionId: s6.acceptedRevisionId, sourceRevisionHash: s6.acceptedRevisionHash, objectNames: generated.payload.objects.map((object) => object.name), payloadBytes: generated.bytes, payloadSha256: generated.sha256 };
}

export function validateS8Readback(s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback): S8SemanticResult {
  return compareS8UfbxReadback(s6, s7, readback);
}

export class S8ExportService {
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly s6: S6WorkflowService;
  readonly s7: S7CadService;
  private readonly clock: () => Timestamp;
  private readonly uuid: () => UUID;
  private readonly ownerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly adapters: S8ExportAdapters;
  private readonly writerConfig: S8WorkerConfig | undefined;
  private readonly onPublicationPhase: S8PublicationPhaseHook | undefined;

  constructor(options: S8ExportServiceOptions) {
    this.repository = options.repository;
    this.objects = options.objects;
    this.s6 = options.s6;
    this.s7 = options.s7;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.ownerId = options.ownerId ?? `s8-process-${process.pid}-${randomUUID()}`;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? ownerIsAliveDefault;
    this.adapters = options.adapters ?? {};
    this.writerConfig = options.writerConfig;
    this.onPublicationPhase = options.onPublicationPhase;
  }

  private projectExists(projectId: UUID): void {
    if (!this.repository.state().projects.some((project) => project.projectId === projectId)) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "project");
  }

  private admitSource(projectId: UUID): AdmittedSource {
    this.projectExists(projectId);
    try {
      const s6 = this.s6.getS7Handoff(projectId);
      const s7 = this.s7.getHandoff(projectId);
      if (s6.projectId !== projectId || s7.projectId !== projectId || s7.sourceRevisionId !== s6.acceptedRevisionId || s7.sourceRevisionHash !== s6.acceptedRevisionHash || s7.sourceS5Fingerprint !== s6.sourceS5Fingerprint) throw new Error("source binding");
      if (s6.eligibility.currentAccepted !== true || s6.eligibility.sourceCurrent !== true || s6.eligibility.stale !== false) throw new AppError(409, "S8_SOURCE_STALE");
      const prepared = buildS8WriterPayload(s6, s7);
      return { s6, s7, stamp: stampFromSource(s6, s7), prepared };
    } catch (error) {
      if (error instanceof AppError && error.code === "S8_SOURCE_STALE") throw error;
      throw sourceError(error);
    }
  }

  private requireCurrentSource(projectId: UUID, expected: S8SourceStamp): AdmittedSource {
    const current = this.admitSource(projectId);
    if (!sameS8Source(current.stamp, expected)) fail(409, "S8_SOURCE_STALE", "source");
    return current;
  }

  private emitPhase(phase: S8ExportJob["publicationPhase"], job: S8ExportJob): void {
    try { this.onPublicationPhase?.(phase, { projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }); } catch { fail(500, "S8_PUBLICATION_FAILED"); }
  }

  private updatePhase(jobId: UUID, claimToken: UUID, phase: S8ExportJob["publicationPhase"], status: S8ExportJob["status"]): S8ExportJob {
    return this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerId !== this.ownerId || phaseIndex(phase) < phaseIndex(job.publicationPhase) || phaseIndex(phase) > phaseIndex(job.publicationPhase) + 1) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock();
      job.publicationPhase = phase; job.status = status; job.heartbeatAt = at; job.updatedAt = at;
      artifact.publicationPhase = phase; artifact.status = status; artifact.updatedAt = at;
      return { ...job };
    });
  }

  private updateHeartbeat(jobId: UUID, claimToken: UUID, expected: S8SourceStamp): void {
    this.requireCurrentSource(expected.projectId, expected);
    this.repository.transact((state) => {
      const job = getS8Collections(state).jobs.find((item) => item.jobId === jobId);
      if (!job || job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.status === "stale" || job.status === "committed") fail(409, "S8_CLAIM_FENCED");
      const at = this.clock(); job.heartbeatAt = at; job.updatedAt = at;
      const artifact = getS8Collections(state).artifacts.find((item) => item.artifactId === job.artifactId);
      if (artifact) artifact.updatedAt = at;
    });
  }

  private claim(jobId: UUID): { job: S8ExportJob; artifact: S8Artifact; source: AdmittedSource; claimToken: UUID } {
    const snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "job");
    const source = this.admitSource(snapshot.projectId);
    const claimToken = this.uuid();
    const claimed = this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.status !== "queued" || !sameS8Source(job.source, source.stamp)) fail(409, "S8_SOURCE_STALE");
      const at = this.clock();
      job.status = "running"; job.publicationPhase = "claim"; job.claimToken = claimToken; job.ownerId = this.ownerId; job.ownerProcessId = this.processId; job.claimedAt = at; job.heartbeatAt = at; job.updatedAt = at;
      artifact.status = "running"; artifact.publicationPhase = "claim"; artifact.privateStagingPrefix = s8StagingPrefix(job.projectId, job.artifactId, claimToken); artifact.updatedAt = at;
      return { job: { ...job }, artifact: { ...artifact } };
    });
    this.emitPhase("claim", claimed.job);
    this.requireCurrentSource(snapshot.projectId, source.stamp);
    return { ...claimed, source, claimToken };
  }

  private writer(payload: Buffer, context: S8AdapterContext): S8WriterResult {
    if (this.adapters.writer) return this.adapters.writer(payload, context);
    if (!this.writerConfig) fail(503, "S8_TOOLING_UNAVAILABLE");
    return runS8BlenderWriter(payload, this.writerConfig, context.onHeartbeat);
  }

  private nativeValidator(artifact: Buffer, context: S8AdapterContext): S8NativeValidationResult {
    if (this.adapters.nativeValidator) return this.adapters.nativeValidator(artifact, context);
    if (!this.writerConfig?.nativeValidatorExecutable) fail(503, "S8_NATIVE_VALIDATOR_UNAVAILABLE");
    return runS8NativeValidator(artifact, this.writerConfig, context.onHeartbeat);
  }

  private semanticValidator(s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback): S8SemanticResult {
    return this.adapters.semanticValidator ? this.adapters.semanticValidator(s6, s7, readback) : compareS8UfbxReadback(s6, s7, readback);
  }

  private validateWriterReceipt(receipt: S8WriterReceipt, payloadSha256: string, artifact: Buffer): void {
    if (!receipt || receipt.schemaVersion !== S8_WRITER_RECEIPT_VERSION || receipt.profile !== S8_FBX_PROFILE || receipt.payloadSha256 !== payloadSha256 || receipt.artifactSha256 !== s8Sha256(artifact) || receipt.artifactByteSize !== artifact.length || !receipt.runtime) fail(422, "S8_WRITER_RECEIPT_INVALID");
    if (artifact.length <= 27 || artifact.length > S8_LIMITS.artifactBytes) fail(422, "S8_ARTIFACT_RESOURCE_LIMIT");
  }

  private identityBase(source: S8SourceStamp, payloadSha256: string, artifactSha256: string, artifactByteSize: number, writer: S8WriterReceipt, writerHash: string, nativeHash: string, semanticHash: string, finalPrefix: string, publicationReceiptBodyHash: string, native: S8NativeValidationResult): PublicationIdentity {
    return {
      fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION,
      source,
      profile: S8_FBX_PROFILE,
      protocol: S8_PROTOCOL_VERSION,
      semanticVersion: S8_SEMANTIC_VERSION,
      writerReceiptVersion: S8_WRITER_RECEIPT_VERSION,
      writerRuntime: writer.runtime,
      exporterPatch: { identity: S8_EXPORTER_PATCH_PIN.identity, manifest: S8_EXPORTER_PATCH_PIN.manifest, privateExporterSha256: String(((writer.runtime as Record<string, unknown> | undefined)?.privateExporterPatch as Record<string, unknown> | undefined)?.privateExporterSha256 ?? ""), manifestSha256: String(((writer.runtime as Record<string, unknown> | undefined)?.privateExporterPatch as Record<string, unknown> | undefined)?.manifestSha256 ?? "") },
      settingsHash: sha256(jcs(S8_EXPORTER_SETTINGS)),
      validator: { identity: native.validatorIdentity ?? S8_VALIDATOR_PIN.identity, ufbx: S8_UFBX_PIN },
      runner: { identity: native.runnerIdentity ?? S8_PROCESS_RUNNER_PIN.identity, platform: S8_PROCESS_RUNNER_PIN.platform, childProcesses: S8_PROCESS_RUNNER_PIN.childProcesses },
      resourceLimitsHash: s8ResourceLimitsHash(S8_RESOURCE_TABLE),
      payloadSha256,
      artifactSha256,
      artifactByteSize,
      receiptHashes: { writer: writerHash, native: nativeHash, semantic: semanticHash },
      storage: { finalPrefix, objectNames: S8_OBJECT_NAMES },
      publicationReceiptBodyHash,
    };
  }

  private fingerprint(identity: PublicationIdentity): string {
    return sha256(jcs({ fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, identity }));
  }

  private publicationBytes(source: S8SourceStamp, identity: PublicationIdentity, objects: { artifactSha256: string; artifactByteSize: number; writerReceiptSha256: string; nativeReadbackSha256: string; semanticReceiptSha256: string; publicationReceiptSha256: string }, fingerprint: string): Buffer {
    const body = { schemaVersion: "s8-publication-receipt-v2", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, source, identity, objects, complete: true };
    const bodyForHash = { ...body, identity: { ...identity, publicationReceiptBodyHash: "" } };
    if (sha256(jcs(bodyForHash)) !== identity.publicationReceiptBodyHash) fail(500, "S8_PUBLICATION_OBJECT_MISMATCH");
    return jsonBytes({ ...body, immutableReuseFingerprint: fingerprint }, S8_LIMITS.readbackBytes, "S8_PUBLICATION_RECEIPT_LIMIT");
  }

  private stage(keyPrefix: string, objects: ReadonlyMap<(typeof S8_OBJECT_NAMES)[number], Buffer>): void {
    for (const [name, bytes] of objects) this.objects.putExact(s8ObjectKey(keyPrefix, name), bytes);
  }

  private promote(keyFrom: string, keyTo: string, bytes: Buffer): void {
    this.objects.promoteExact(keyFrom, keyTo, bytes);
  }

  private markFailure(jobId: UUID, claimToken: UUID | null, error: unknown): void {
    const code = error instanceof AppError ? error.code : "S8_PUBLICATION_FAILED";
    try {
      this.repository.transact((state) => {
        const collections = getS8Collections(state);
        const job = collections.jobs.find((item) => item.jobId === jobId);
        const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
        if (!job || !artifact || (claimToken !== null && (job.claimToken !== claimToken || job.ownerId !== this.ownerId))) return;
        const stale = code === "S8_SOURCE_STALE";
        const at = this.clock();
        job.status = stale ? "stale" : "failed_terminal"; job.failureCode = code; job.terminalAt = at; job.updatedAt = at; job.claimToken = null; job.ownerId = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
        artifact.status = job.status; artifact.failureCode = code; artifact.staleAt = stale ? at : artifact.staleAt; artifact.updatedAt = at;
      });
    } catch { /* preserve the original failure; the repository remains authoritative */ }
  }

  private cleanupStaging(prefix: string): void {
    for (const name of S8_OBJECT_NAMES) this.objects.remove(s8ObjectKey(prefix, name));
  }

  private verifyPublishedObjects(artifact: S8Artifact, includePublication: boolean): Map<(typeof S8_OBJECT_NAMES)[number], Buffer> {
    if (!artifact.objectHashes) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    const names = includePublication ? S8_OBJECT_NAMES : S8_OBJECT_NAMES.slice(0, 4);
    const bytes = new Map<(typeof S8_OBJECT_NAMES)[number], Buffer>();
    for (const name of names) {
      const value = this.objects.read(s8ObjectKey(artifact.privateFinalPrefix, name));
      if (name === "artifact.fbx" && (value.length !== artifact.objectHashes.artifactByteSize || s8Sha256(value) !== artifact.objectHashes.artifactSha256)) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      if (name === "writer-receipt.json" && s8Sha256(value) !== artifact.objectHashes.writerReceiptSha256) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      if (name === "native-readback.json" && s8Sha256(value) !== artifact.objectHashes.nativeReadbackSha256) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      if (name === "semantic-validation-receipt.json" && s8Sha256(value) !== artifact.objectHashes.semanticReceiptSha256) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      if (name === "publication-receipt.json" && s8Sha256(value) !== artifact.objectHashes.publicationReceiptSha256) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      bytes.set(name, value);
    }
    return bytes;
  }

  private verifyPublicationState(projectId: UUID, artifact: S8Artifact): { bytes: Buffer; receipt: S8ValidationReceipt; objectHashes: NonNullable<S8Artifact["objectHashes"]>; fingerprint: string } {
    try {
      if (artifact.projectId !== projectId || !artifact.objectHashes || !artifact.validationReceiptId || !artifact.validationReceiptHash || !artifact.immutableReuseFingerprint || !artifact.payloadSha256) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const current = this.requireCurrentSource(projectId, artifact.source);
      const expected = artifact.objectHashes;
      const stored = this.verifyPublishedObjects(artifact, true);
      const publication = parseJson(stored.get("publication-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (publication.complete !== true || publication.fingerprintVersion !== S8_REUSE_FINGERPRINT_VERSION || publication.immutableReuseFingerprint !== artifact.immutableReuseFingerprint || !sameS8Source(publication.source as S8SourceStamp, artifact.source) || !sameS8Source(publication.source as S8SourceStamp, current.stamp)) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const identity = publication.identity as PublicationIdentity;
      const publicationObjects = publication.objects as Record<string, unknown>;
      if (publicationObjects.artifactSha256 !== expected.artifactSha256 || publicationObjects.artifactByteSize !== expected.artifactByteSize || publicationObjects.writerReceiptSha256 !== expected.writerReceiptSha256 || publicationObjects.nativeReadbackSha256 !== expected.nativeReadbackSha256 || publicationObjects.semanticReceiptSha256 !== expected.semanticReceiptSha256 || publicationObjects.publicationReceiptSha256 !== "0".repeat(64)) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const body = { schemaVersion: "s8-publication-receipt-v2", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, source: publication.source, identity, objects: publication.objects, complete: true };
      const bodyForHash = { ...body, identity: { ...identity, publicationReceiptBodyHash: "" } };
      const storage = identity.storage;
      if (identity.profile !== S8_FBX_PROFILE || identity.protocol !== S8_PROTOCOL_VERSION || identity.semanticVersion !== S8_SEMANTIC_VERSION || identity.payloadSha256 !== artifact.payloadSha256 || identity.artifactSha256 !== expected.artifactSha256 || identity.artifactByteSize !== expected.artifactByteSize || identity.receiptHashes.writer !== expected.writerReceiptSha256 || identity.receiptHashes.native !== expected.nativeReadbackSha256 || identity.receiptHashes.semantic !== expected.semanticReceiptSha256 || storage.finalPrefix !== artifact.privateFinalPrefix || jcs(storage.objectNames) !== jcs(S8_OBJECT_NAMES) || sha256(jcs(bodyForHash)) !== identity.publicationReceiptBodyHash || this.fingerprint(identity) !== artifact.immutableReuseFingerprint) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const receipt = getS8Collections(this.repository.state()).receipts.find((item) => item.receiptId === artifact.validationReceiptId);
      if (!receipt || receipt.projectId !== artifact.projectId || receipt.artifactId !== artifact.artifactId || !sameS8Source(receipt.source, artifact.source) || receipt.receiptHash !== artifact.validationReceiptHash || receipt.payloadSha256 !== artifact.payloadSha256 || receipt.artifactSha256 !== expected.artifactSha256 || receipt.artifactByteSize !== expected.artifactByteSize || receipt.writerReceiptHash !== expected.writerReceiptSha256 || receipt.nativeReadbackHash !== expected.nativeReadbackSha256 || receipt.semanticReceiptHash !== expected.semanticReceiptSha256 || receipt.immutableReuseFingerprint !== artifact.immutableReuseFingerprint || sha256(jcs({ ...receipt, receiptHash: "" })) !== receipt.receiptHash) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const writer = parseJson(stored.get("writer-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (writer.payloadSha256 !== artifact.payloadSha256 || writer.artifactSha256 !== expected.artifactSha256 || writer.artifactByteSize !== expected.artifactByteSize) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const native = parseJson(stored.get("native-readback.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (native.schemaVersion !== "s8-ufbx-readback-v1") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const semantic = parseJson(stored.get("semantic-validation-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (semantic.schemaVersion !== "s8-semantic-validation-receipt-v2" || semantic.outcome !== "pass") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      return { bytes: stored.get("artifact.fbx")!, receipt, objectHashes: expected, fingerprint: artifact.immutableReuseFingerprint };
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    }
  }

  private verifyReuse(projectId: UUID, artifact: S8Artifact): Buffer {
    if (artifact.projectId !== projectId || artifact.status !== "committed" || artifact.publicationPhase !== "commit") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    return this.verifyPublicationState(projectId, artifact).bytes;
  }

  private runClaimedExport(jobId: UUID): S8Artifact {
    const claimed = this.claim(jobId);
    const { job, source, claimToken } = claimed;
    try {
      const payload = source.prepared;
      const context: S8AdapterContext = { projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId, source: job.source, payload: payload.payload, onHeartbeat: () => this.updateHeartbeat(job.jobId, claimToken, job.source) };
      this.updateHeartbeat(job.jobId, claimToken, job.source);
      const written = this.writer(payload.bytes, context);
      this.validateWriterReceipt(written.receipt, payload.sha256, written.artifact);
      const artifactSha256 = s8Sha256(written.artifact);
      const writerReceiptBytes = jsonBytes(written.receipt, S8_LIMITS.receiptBytes, "S8_WRITER_RECEIPT_LIMIT");
      this.updateHeartbeat(job.jobId, claimToken, job.source);
      const finalPrefix = s8FinalPrefix(job.projectId, job.source.sourceRevisionHash, artifactSha256);
      const stagingPrefix = s8StagingPrefix(job.projectId, job.artifactId, claimToken);
      this.repository.transact((state) => {
        const currentJob = getS8Collections(state).jobs.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? getS8Collections(state).artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== claimToken || currentJob.ownerId !== this.ownerId) fail(409, "S8_CLAIM_FENCED");
        currentArtifact.payloadSha256 = payload.sha256; currentArtifact.privateFinalPrefix = finalPrefix; currentArtifact.privateStagingPrefix = stagingPrefix; currentArtifact.updatedAt = this.clock();
      });
      this.stage(stagingPrefix, new Map([["artifact.fbx", written.artifact], ["writer-receipt.json", writerReceiptBytes]]));
      const stagedJob = this.updatePhase(job.jobId, claimToken, "private_staging", "staged");
      this.emitPhase("private_staging", stagedJob);
      this.requireCurrentSource(job.projectId, job.source);

      this.updateHeartbeat(job.jobId, claimToken, job.source);
      const native = this.nativeValidator(written.artifact, context);
      const readbackBytes = native.readbackBytes ?? jsonBytes(native.readback, S8_LIMITS.readbackBytes, "S8_NATIVE_READBACK_LIMIT");
      if (readbackBytes.length > S8_LIMITS.readbackBytes) fail(422, "S8_NATIVE_READBACK_LIMIT");
      const nativeHash = s8Sha256(readbackBytes);
      this.updateHeartbeat(job.jobId, claimToken, job.source);
      const semantic = this.semanticValidator(source.s6, source.s7, native.readback);
      if (semantic.outcome !== "pass") fail(422, "S8_SEMANTIC_VALIDATION_FAILED");
      const semanticBytes = jsonBytes({ schemaVersion: "s8-semantic-validation-receipt-v2", outcome: semantic.outcome, source: job.source, result: semantic }, S8_LIMITS.readbackBytes, "S8_SEMANTIC_RECEIPT_LIMIT");
      const semanticHash = s8Sha256(semanticBytes);
      this.stage(stagingPrefix, new Map([["native-readback.json", readbackBytes], ["semantic-validation-receipt.json", semanticBytes]]));
      const validatedJob = this.updatePhase(job.jobId, claimToken, "independent_validation", "validated");
      this.emitPhase("independent_validation", validatedJob);
      this.requireCurrentSource(job.projectId, job.source);
      const rechecked = this.updatePhase(job.jobId, claimToken, "source_claim_recheck", "validated");
      this.emitPhase("source_claim_recheck", rechecked);

      const objectHashes = { artifactSha256, artifactByteSize: written.artifact.length, writerReceiptSha256: s8Sha256(writerReceiptBytes), nativeReadbackSha256: nativeHash, semanticReceiptSha256: semanticHash, publicationReceiptSha256: "0".repeat(64) };
      const publicationBodyWithoutHash = { schemaVersion: "s8-publication-receipt-v2", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, source: job.source, objects: objectHashes, complete: true };
      const bodyHashPlaceholderIdentity = this.identityBase(job.source, payload.sha256, artifactSha256, written.artifact.length, written.receipt, objectHashes.writerReceiptSha256, nativeHash, semanticHash, finalPrefix, "", native);
      const bodyForHash = { ...publicationBodyWithoutHash, identity: { ...bodyHashPlaceholderIdentity, publicationReceiptBodyHash: "" } };
      const publicationBodyHash = sha256(jcs(bodyForHash));
      const identity = this.identityBase(job.source, payload.sha256, artifactSha256, written.artifact.length, written.receipt, objectHashes.writerReceiptSha256, nativeHash, semanticHash, finalPrefix, publicationBodyHash, native);
      const fingerprint = this.fingerprint(identity);
      const publicationBytes = this.publicationBytes(job.source, identity, objectHashes, fingerprint);
      const publicationHash = s8Sha256(publicationBytes);
      const validationWithoutHash: Omit<S8ValidationReceipt, "receiptHash"> = { schemaVersion: "s8-validation-receipt-v2", receiptId: this.uuid(), projectId: job.projectId, artifactId: job.artifactId, source: job.source, payloadSha256: payload.sha256, artifactSha256, artifactByteSize: written.artifact.length, writerReceiptHash: objectHashes.writerReceiptSha256, nativeReadbackHash: nativeHash, semanticReceiptHash: semanticHash, nativeOutcome: "pass", semanticOutcome: "pass", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, immutableReuseFingerprint: fingerprint, resourceLimitsHash: s8ResourceLimitsHash(S8_RESOURCE_TABLE), checkedAt: this.clock() };
      const validationReceipt: S8ValidationReceipt = { ...validationWithoutHash, receiptHash: sha256(jcs({ ...validationWithoutHash, receiptHash: "" })) };
      const completedObjectHashes = { ...objectHashes, publicationReceiptSha256: publicationHash };
      this.requireCurrentSource(job.projectId, job.source);
      this.repository.transact((state) => {
        const collections = getS8Collections(state);
        const currentJob = collections.jobs.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? collections.artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== claimToken || currentJob.ownerId !== this.ownerId) fail(409, "S8_CLAIM_FENCED");
        if (collections.receipts.some((item) => item.receiptId === validationReceipt.receiptId)) fail(500, "S8_PERSISTENCE_INVALID");
        currentArtifact.objectHashes = completedObjectHashes; currentArtifact.writerReceiptHash = objectHashes.writerReceiptSha256; currentArtifact.nativeReadbackHash = nativeHash; currentArtifact.semanticReceiptHash = semanticHash; currentArtifact.publicationReceiptHash = publicationHash; currentArtifact.validationReceiptId = validationReceipt.receiptId; currentArtifact.validationReceiptHash = validationReceipt.receiptHash; currentArtifact.immutableReuseFingerprint = fingerprint; currentArtifact.updatedAt = this.clock();
        collections.receipts.push(validationReceipt);
      });
      this.stage(stagingPrefix, new Map([["publication-receipt.json", publicationBytes]]));
      const promoted = this.updatePhase(job.jobId, claimToken, "immutable_promotion", "promoted");
      this.emitPhase("immutable_promotion", promoted);
      this.requireCurrentSource(job.projectId, job.source);
      for (const name of S8_OBJECT_NAMES) this.promote(s8ObjectKey(stagingPrefix, name), s8ObjectKey(finalPrefix, name), this.objects.read(s8ObjectKey(stagingPrefix, name)));
      const artifactSnapshot = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      if (!artifactSnapshot) fail(500, "S8_PERSISTENCE_INVALID");
      this.verifyPublishedObjects(artifactSnapshot, true);
      this.requireCurrentSource(job.projectId, job.source);
      const verified = this.updatePhase(job.jobId, claimToken, "verified_readback", "promoted");
      this.emitPhase("verified_readback", verified);
      const committed = this.commit(job, claimToken, source.stamp, validationReceipt, completedObjectHashes, fingerprint, finalPrefix);
      return committed;
    } catch (error) {
      this.markFailure(jobId, claimToken, error);
      throw error;
    }
  }

  private commit(job: S8ExportJob, claimToken: UUID, source: S8SourceStamp, receipt: S8ValidationReceipt, objectHashes: S8Artifact["objectHashes"], fingerprint: string, finalPrefix: string): S8Artifact {
    const current = this.requireCurrentSource(job.projectId, source);
    return this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const currentJob = collections.jobs.find((item) => item.jobId === job.jobId);
      const artifact = currentJob ? collections.artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
      if (!currentJob || !artifact || currentJob.claimToken !== claimToken || currentJob.ownerId !== this.ownerId || !sameS8Source(current.stamp, currentJob.source)) fail(409, "S8_SOURCE_STALE");
      if (!objectHashes || objectHashes.publicationReceiptSha256 === "0".repeat(64)) fail(500, "S8_PUBLICATION_OBJECT_MISMATCH");
      const at = this.clock();
      const existingReceipt = collections.receipts.find((item) => item.receiptId === receipt.receiptId);
      if (existingReceipt) {
        if (existingReceipt.receiptHash !== receipt.receiptHash || existingReceipt.artifactId !== artifact.artifactId || existingReceipt.immutableReuseFingerprint !== fingerprint) fail(500, "S8_PERSISTENCE_INVALID");
      } else collections.receipts.push(receipt);
      artifact.objectHashes = objectHashes; artifact.privateFinalPrefix = finalPrefix; artifact.validationReceiptId = receipt.receiptId; artifact.validationReceiptHash = receipt.receiptHash; artifact.publicationReceiptHash = objectHashes.publicationReceiptSha256; artifact.immutableReuseFingerprint = fingerprint; artifact.status = "committed"; artifact.publicationPhase = "commit"; artifact.committedAt = at; artifact.updatedAt = at;
      currentJob.status = "committed"; currentJob.publicationPhase = "commit"; currentJob.terminalAt = at; currentJob.updatedAt = at; currentJob.claimToken = null; currentJob.ownerId = null; currentJob.ownerProcessId = null; currentJob.claimedAt = null; currentJob.heartbeatAt = null;
      return { ...artifact };
    });
  }

  private reclaimPromoted(jobId: UUID, previousClaimToken: UUID): { job: S8ExportJob; claimToken: UUID } {
    const claimToken = this.uuid();
    const job = this.repository.transact((state) => {
      const current = getS8Collections(state).jobs.find((item) => item.jobId === jobId);
      if (!current || current.claimToken !== previousClaimToken || current.ownerProcessId === null || !["promoted", "verified_readback"].includes(current.status)) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock();
      current.claimToken = claimToken; current.ownerId = this.ownerId; current.ownerProcessId = this.processId; current.claimedAt = at; current.heartbeatAt = at; current.updatedAt = at;
      return { ...current };
    });
    return { job, claimToken };
  }

  createExport(projectId: UUID, idempotencyKey: string, requestReferenceId: UUID): S8ExportResult {
    assertOpaqueKey(idempotencyKey); assertRequestReference(requestReferenceId);
    const admitted = this.admitSource(projectId);
    const inputHash = sha256(jcs({ operation: "s8-export", projectId, source: admitted.stamp, profile: S8_FBX_PROFILE, protocol: S8_PROTOCOL_VERSION }));
    const existing = getS8Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputHash !== inputHash || !sameS8Source(existing.source, admitted.stamp)) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === existing.artifactId);
      const job = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === existing.jobId);
      if (!artifact || !job) fail(500, "S8_PERSISTENCE_INVALID");
      if (artifact.status === "committed") this.verifyReuse(projectId, artifact);
      const current = artifact.status === "queued" ? this.runClaimedExport(job.jobId) : artifact;
      return { replayed: true, export: publicArtifact(current), job: { jobId: job.jobId, status: current.status, attempt: 1 } };
    }
    const artifactId = this.uuid(); const jobId = this.uuid(); const at = this.clock();
    const source = admitted.stamp;
    const artifact: S8Artifact = { schemaVersion: "s8-artifact-v2", artifactId, projectId, jobId, source, inputHash, profile: S8_FBX_PROFILE, format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx", status: "queued", publicationPhase: "source_admission", payloadSha256: null, objectHashes: null, writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null, validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null, privateStagingPrefix: s8StagingPrefix(projectId, artifactId, "unclaimed"), privateFinalPrefix: s8FinalPrefix(projectId, source.sourceRevisionHash, "pending"), attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: at, updatedAt: at, committedAt: null, staleAt: null };
    const job: S8ExportJob = { schemaVersion: "s8-export-job-v2", jobId, projectId, artifactId, source, inputHash, idempotencyKey, status: "queued", publicationPhase: "source_admission", attempt: 1, claimToken: null, ownerId: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null, failureCode: null };
    const idempotency: S8IdempotencyRecord = { schemaVersion: "s8-idempotency-v2", projectId, operation: "export", idempotencyKey, inputHash, source, jobId, artifactId, createdAt: at };
    const created = this.repository.transact((state) => {
      const current = this.admitSource(projectId);
      if (!sameS8Source(current.stamp, source)) fail(409, "S8_SOURCE_STALE");
      const collections = getS8Collections(state);
      const collision = collections.idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
      if (collision) return { replayed: true as const, jobId: collision.jobId };
      collections.jobs.push(job); collections.artifacts.push(artifact); collections.idempotency.push(idempotency);
      return { replayed: false as const, jobId };
    });
    if (created.replayed) {
      const existingJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === created.jobId);
      if (!existingJob) fail(500, "S8_PERSISTENCE_INVALID");
      const current = this.runClaimedExport(existingJob.jobId);
      return { replayed: true, export: publicArtifact(current), job: { jobId: current.jobId, status: current.status, attempt: 1 } };
    }
    const result = this.runClaimedExport(jobId);
    const latestJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId)!;
    return { replayed: false, export: publicArtifact(result), job: { jobId, status: latestJob.status, attempt: 1 } };
  }

  getExport(projectId: UUID, artifactId: UUID): S8PublicArtifact {
    const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    if (artifact.status === "committed") this.verifyReuse(projectId, artifact);
    return publicArtifact(artifact);
  }

  download(projectId: UUID, artifactId: UUID): S8DownloadResult {
    const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    const bytes = this.verifyReuse(projectId, artifact);
    return { bytes, contentType: "application/octet-stream", fileName: "swooshz-s8-scene.fbx" };
  }

  getHandoff(projectId: UUID): Omit<S8PreparedExport, "payloadBytes"> {
    const source = this.admitSource(projectId);
    return { profile: S8_FBX_PROFILE, semanticVersion: S8_SEMANTIC_VERSION, sourceRevisionId: source.s6.acceptedRevisionId, sourceRevisionHash: source.s6.acceptedRevisionHash, objectNames: source.prepared.payload.objects.map((object) => object.name), payloadSha256: source.prepared.sha256 };
  }

  recoverPending(): number {
    const candidates = getS8Collections(this.repository.state()).jobs.filter((job) => job.claimToken !== null && job.ownerProcessId !== null && ["running", "staged", "validated", "promoted", "verified_readback"].includes(job.status));
    let recovered = 0;
    for (const job of candidates) {
      const heartbeat = job.heartbeatAt ? Date.parse(job.heartbeatAt) : 0;
      const now = Date.parse(this.clock());
      if (!Number.isFinite(now) || now - heartbeat <= S8_STALE_CLAIM_MS) continue;
      let alive: boolean;
      try { alive = this.isProcessAlive(job.ownerProcessId!); } catch { alive = true; }
      if (alive) fail(409, "S8_CONTROLLER_REQUIRED");
      const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      if (!artifact) continue;
      if (phaseIndex(job.publicationPhase) >= phaseIndex("immutable_promotion")) {
        let claimToken: UUID | null = null;
        try {
          const reclaimed = this.reclaimPromoted(job.jobId, job.claimToken!);
          claimToken = reclaimed.claimToken;
          const promotedArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
          if (!promotedArtifact) fail(500, "S8_PERSISTENCE_INVALID");
          const verified = this.verifyPublicationState(job.projectId, promotedArtifact);
          this.commit(reclaimed.job, reclaimed.claimToken, promotedArtifact.source, verified.receipt, verified.objectHashes, verified.fingerprint, promotedArtifact.privateFinalPrefix);
        } catch (error) {
          this.markFailure(job.jobId, claimToken ?? job.claimToken, error);
        }
        recovered += 1;
      } else {
        this.cleanupStaging(artifact.privateStagingPrefix);
        this.repository.transact((state) => {
          const current = getS8Collections(state).jobs.find((item) => item.jobId === job.jobId);
          const currentArtifact = current ? getS8Collections(state).artifacts.find((item) => item.artifactId === current.artifactId) : undefined;
          if (current && currentArtifact && current.claimToken === job.claimToken) {
            if (currentArtifact.validationReceiptId !== null) {
              const receiptIndex = getS8Collections(state).receipts.findIndex((item) => item.receiptId === currentArtifact.validationReceiptId);
              if (receiptIndex >= 0) getS8Collections(state).receipts.splice(receiptIndex, 1);
            }
            current.status = "queued"; current.publicationPhase = "source_admission"; current.claimToken = null; current.ownerId = null; current.ownerProcessId = null; current.claimedAt = null; current.heartbeatAt = null; current.terminalAt = null; current.failureCode = null; current.updatedAt = this.clock();
            currentArtifact.status = "queued"; currentArtifact.publicationPhase = "source_admission"; currentArtifact.payloadSha256 = null; currentArtifact.objectHashes = null; currentArtifact.writerReceiptHash = null; currentArtifact.nativeReadbackHash = null; currentArtifact.semanticReceiptHash = null; currentArtifact.publicationReceiptHash = null; currentArtifact.validationReceiptId = null; currentArtifact.validationReceiptHash = null; currentArtifact.immutableReuseFingerprint = null; currentArtifact.privateStagingPrefix = s8StagingPrefix(current.projectId, current.artifactId, "unclaimed"); currentArtifact.privateFinalPrefix = s8FinalPrefix(current.projectId, current.source.sourceRevisionHash, "pending"); currentArtifact.failureCode = null; currentArtifact.committedAt = null; currentArtifact.updatedAt = this.clock();
          }
        });
        try { this.runClaimedExport(job.jobId); } catch { /* failure is durably recorded by the production path */ }
        recovered += 1;
      }
    }
    return recovered;
  }
}
