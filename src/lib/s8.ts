import { AppError, type S6ToS7Handoff, type S7ToS8Handoff, type S8Artifact, type S8ExportJob, type S8IdempotencyRecord, type S8SourceStamp, type S8ValidationReceipt, type Timestamp, type UUID } from "./types";
import { buildS8WriterPayload, canonicalS8SourceJson, type S8WriterPayload } from "./s8-fbx-payload";
import { compareS8UfbxReadback, type S8SemanticResult, type S8UfbxReadback } from "./s8-fbx-semantic";
import { S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_EXPORTER_SETTINGS, S8_FBX_PROFILE, S8_LIMITS, S8_PROCESS_RUNNER_PIN, S8_PROTOCOL_VERSION, S8_RESOURCE_TABLE, S8_REUSE_FINGERPRINT_VERSION, S8_SEMANTIC_VERSION, S8_UFBX_PIN, S8_VALIDATOR_PIN, S8_WRITER_RECEIPT_VERSION, s8Sha256 } from "./s8-fbx-profile";
import { getS8Collections, sameS8Source, s8FinalPrefix, s8ObjectKey, s8ResourceLimitsHash, s8StagingPrefix, S8_OBJECT_NAMES, S8_STALE_CLAIM_MS } from "./s8-fbx-persistence";
import { JsonRepository, PrivateObjectStore } from "./store";
import { jcs, newUuid, nowUtc, sha256, uuidV4Pattern } from "./utils";
import { S6WorkflowService } from "./s6";
import { S7CadService } from "./s7-cad";
import { runS8BlenderWriter, runS8NativeValidator, type S8CallerVerification, type S8NativeValidatorResult, type S8RunnerEvidence, type S8WorkerConfig, type S8WriterReceipt, type S8WriterResult } from "./s8-fbx-worker";

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
export type S8ExportResult = { replayed: boolean; export: S8PublicArtifact; job: Pick<S8ExportJob, "jobId" | "status" | "attempt"> };
export type S8DownloadResult = { bytes: Buffer; contentType: "application/octet-stream"; fileName: "swooshz-s8-scene.fbx" };
export type S8NativeValidationResult = S8NativeValidatorResult;

export type S8AdapterContext = { projectId: UUID; jobId: UUID; artifactId: UUID; source: S8SourceStamp; payload: S8WriterPayload; onHeartbeat: () => void };
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

type RunnerExpectation = { addressSpaceBytes: number; fileBytes: number; timeoutMs: number; stdoutBytes: number; stderrBytes: number; maxChildren: 0 };
type AdmittedSource = { s6: S6ToS7Handoff; s7: S7ToS8Handoff; source: S8SourceStamp; prepared: ReturnType<typeof buildS8WriterPayload> };
type S8ObjectName = (typeof S8_OBJECT_NAMES)[number];
type PublicationObjects = { artifactSha256: string; artifactByteSize: number; writerReceiptSha256: string; nativeReadbackSha256: string; semanticReceiptSha256: string; publicationReceiptSha256: null };
type PublicationIdentity = {
  fingerprintVersion: typeof S8_REUSE_FINGERPRINT_VERSION;
  source: S8SourceStamp;
  profile: typeof S8_FBX_PROFILE;
  protocol: typeof S8_PROTOCOL_VERSION;
  semanticVersion: typeof S8_SEMANTIC_VERSION;
  writerReceiptVersion: typeof S8_WRITER_RECEIPT_VERSION;
  implementation: {
    blender: typeof S8_BLENDER_PIN;
    exporterPatch: typeof S8_EXPORTER_PATCH_PIN;
    exporterSettingsHash: string;
    ufbx: typeof S8_UFBX_PIN;
    validatorContract: typeof S8_VALIDATOR_PIN;
    resourceLimitsHash: string;
  };
  validatorIdentity: string;
  runner: { writer: S8RunnerEvidence; validator: S8RunnerEvidence };
  payloadSha256: string;
  artifactSha256: string;
  artifactByteSize: number;
  receiptHashes: { writer: string; native: string; semantic: string };
  storage: { finalPrefix: string; objectNames: readonly S8ObjectName[] };
};

const PHASES: S8ExportJob["publicationPhase"][] = ["source_admission", "claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"];
const HEX64 = /^[0-9a-f]{64}$/u;

function fail(status: number, code: string, field = "s8"): never {
  throw new AppError(status, code, [{ field, code }]);
}

function assertOpaqueKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes("\\")) fail(400, "S8_INVALID_REQUEST", "Idempotency-Key");
}

function assertReference(value: UUID | undefined): void {
  if (value !== undefined && !uuidV4Pattern.test(value)) fail(400, "S8_INVALID_REQUEST", "requestReferenceId");
}

function publicArtifact(value: S8Artifact): S8PublicArtifact {
  const { privateStagingPrefix: _staging, privateFinalPrefix: _final, ...safe } = value;
  return { ...safe };
}

function phaseIndex(phase: S8ExportJob["publicationPhase"]): number {
  return PHASES.indexOf(phase);
}

function sourceStamp(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8SourceStamp {
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
  if (error instanceof AppError && ["S6_SOURCE_STALE", "S7_SOURCE_STALE", "S8_SOURCE_STALE"].includes(error.code)) return new AppError(409, "S8_SOURCE_STALE", [{ field: "source", code: "S8_SOURCE_STALE" }]);
  if (error instanceof AppError && error.code.startsWith("S8_")) return error;
  return new AppError(409, "S8_SOURCE_NOT_READY", [{ field: "source", code: "S8_SOURCE_NOT_READY" }]);
}

function ownerIsAliveDefault(processId: number): boolean {
  try { process.kill(processId, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function jsonBytes(value: unknown, maximum = Number.POSITIVE_INFINITY, code = "S8_PUBLICATION_RECEIPT_LIMIT"): Buffer {
  const bytes = Buffer.from(jcs(value), "utf8");
  if (bytes.length > maximum) fail(422, code);
  return bytes;
}

function parseJson(bytes: Buffer, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(422, code);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(422, code);
  }
}

function receiptHashWithoutHash(value: S8ValidationReceipt | Omit<S8ValidationReceipt, "receiptHash">): string {
  const { receiptHash: _receiptHash, ...body } = value as S8ValidationReceipt;
  return sha256(jcs(body));
}

function callerEnvelope(value: S8RunnerEvidence): S8CallerVerification {
  const envelope = value.verifiedByCaller;
  if (!envelope || envelope.status !== "VERIFIED_BY_CALLER" || envelope.schemaVersion !== "s8-runner-caller-verification-v1" || !HEX64.test(envelope.preLaunchSha256) || envelope.preLaunchSha256 !== envelope.postLaunchSha256 || envelope.postLaunchSha256 !== envelope.runnerReportedSelfSha256 || envelope.runnerReportedSelfSha256 !== value.runnerBinary?.selfSha256 || !HEX64.test(envelope.receiptSha256)) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  return envelope;
}

function assertRunnerEvidence(value: unknown, expected: RunnerExpectation): S8RunnerEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const evidence = value as S8RunnerEvidence;
  if (evidence.schemaVersion !== S8_PROCESS_RUNNER_PIN.protocol || evidence.protocol !== S8_PROCESS_RUNNER_PIN.protocol || evidence.policyId !== S8_PROCESS_RUNNER_PIN.policy) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const requested = evidence.requested;
  const applied = evidence.appliedByChild;
  const observed = evidence.observedByRunnerParent;
  const cpu = Math.ceil(expected.timeoutMs / 1000) + 1;
  if (!requested || requested.rlimitAsBytes !== expected.addressSpaceBytes || requested.rlimitFsizeBytes !== expected.fileBytes || requested.rlimitCpuSeconds !== cpu || requested.rlimitNproc !== 64 || requested.wallTimeoutMs !== expected.timeoutMs || requested.stdoutBytes !== expected.stdoutBytes || requested.stderrBytes !== expected.stderrBytes || requested.maxChildren !== expected.maxChildren) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  if (!applied || !observed || applied.rlimitAsBytes !== requested.rlimitAsBytes || applied.rlimitFsizeBytes !== requested.rlimitFsizeBytes || applied.rlimitCpuSeconds !== requested.rlimitCpuSeconds || applied.rlimitNproc !== requested.rlimitNproc || applied.noNewPrivs !== 1 || applied.seccompMode !== 2 || observed.rlimitAsBytes !== applied.rlimitAsBytes || observed.rlimitFsizeBytes !== applied.rlimitFsizeBytes || observed.rlimitCpuSeconds !== applied.rlimitCpuSeconds || observed.rlimitNproc !== applied.rlimitNproc || observed.noNewPrivs !== 1 || observed.seccompMode !== 2) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  if (evidence.runnerParentVerification?.status !== "PASS" || evidence.runnerParentVerification.mismatchCode !== null || evidence.result?.code !== 0 || !HEX64.test(evidence.runnerBinary?.selfSha256 ?? "")) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  callerEnvelope(evidence);
  return evidence;
}

function implementationIdentity(_validatorIdentity: string): PublicationIdentity["implementation"] {
  return {
    blender: S8_BLENDER_PIN,
    exporterPatch: S8_EXPORTER_PATCH_PIN,
    exporterSettingsHash: sha256(jcs(S8_EXPORTER_SETTINGS)),
    ufbx: S8_UFBX_PIN,
    validatorContract: S8_VALIDATOR_PIN,
    resourceLimitsHash: s8ResourceLimitsHash(S8_RESOURCE_TABLE),
  };
}

function publicationFingerprint(identity: PublicationIdentity): string {
  return sha256(jcs({ fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, identity }));
}

function expectedWriter(): RunnerExpectation {
  return { addressSpaceBytes: S8_LIMITS.writerAddressSpaceBytes, fileBytes: S8_LIMITS.artifactBytes, timeoutMs: S8_LIMITS.timeoutMs, stdoutBytes: S8_LIMITS.stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 };
}

function expectedValidator(): RunnerExpectation {
  return { addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, fileBytes: S8_LIMITS.validatorTempBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, stdoutBytes: S8_LIMITS.readbackBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 };
}

export function prepareS8Export(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8PreparedExport {
  const built = buildS8WriterPayload(s6, s7);
  return { profile: S8_FBX_PROFILE, semanticVersion: S8_SEMANTIC_VERSION, sourceRevisionId: s6.acceptedRevisionId, sourceRevisionHash: s6.acceptedRevisionHash, objectNames: built.payload.objects.map((item) => item.name), payloadBytes: built.bytes, payloadSha256: built.sha256 };
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
    this.ownerId = options.ownerId ?? `s8-process-${String(options.processId ?? process.pid)}-${this.uuid()}`;
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
      if (s6.projectId !== projectId || s7.projectId !== projectId || s7.sourceRevisionId !== s6.acceptedRevisionId || s7.sourceRevisionHash !== s6.acceptedRevisionHash || s7.sourceS5Fingerprint !== s6.sourceS5Fingerprint) throw new AppError(409, "S8_SOURCE_STALE");
      if (s6.eligibility.currentAccepted !== true || s6.eligibility.sourceCurrent !== true || s6.eligibility.stale !== false) throw new AppError(409, "S8_SOURCE_STALE");
      const prepared = buildS8WriterPayload(s6, s7);
      return { s6, s7, source: sourceStamp(s6, s7), prepared };
    } catch (error) {
      throw sourceError(error);
    }
  }

  private requireCurrentSource(projectId: UUID, expected: S8SourceStamp): AdmittedSource {
    const current = this.admitSource(projectId);
    if (!sameS8Source(current.source, expected)) fail(409, "S8_SOURCE_STALE", "source");
    return current;
  }

  private reconcileCommittedSupersession(projectId: UUID, current: S8SourceStamp): void {
    const at = this.clock();
    this.repository.transact((state) => {
      const collections = getS8Collections(state);
      for (const artifact of collections.artifacts) {
        if (artifact.projectId !== projectId || artifact.status !== "committed" || sameS8Source(artifact.source, current)) continue;
        artifact.status = "stale"; artifact.staleAt = at; artifact.updatedAt = at;
        const job = collections.jobs.find((item) => item.jobId === artifact.jobId);
        if (job) { job.status = "stale"; job.terminalAt = at; job.updatedAt = at; }
      }
    });
  }

  private emit(phase: S8ExportJob["publicationPhase"], projectId: UUID, jobId: UUID, artifactId: UUID): void {
    try { this.onPublicationPhase?.(phase, { projectId, jobId, artifactId }); } catch { throw new AppError(500, "S8_PUBLICATION_FAILED"); }
  }

  private emitAdmission(projectId: UUID, jobId: UUID, artifactId: UUID, expected: S8SourceStamp): void {
    this.requireCurrentSource(projectId, expected);
    this.emit("source_admission", projectId, jobId, artifactId);
    this.requireCurrentSource(projectId, expected);
  }

  private advancePhase(jobId: UUID, claimToken: UUID, phase: S8ExportJob["publicationPhase"], status: S8ExportJob["status"]): { job: S8ExportJob; artifact: S8Artifact } {
    return this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId || artifact.status !== job.status || phaseIndex(phase) !== phaseIndex(job.publicationPhase) + 1) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock();
      job.publicationPhase = phase; job.status = status; job.heartbeatAt = at; job.updatedAt = at;
      artifact.publicationPhase = phase; artifact.status = status; artifact.updatedAt = at;
      return { job: { ...job }, artifact: { ...artifact } };
    });
  }

  private fence(projectId: UUID, source: S8SourceStamp, phase: S8ExportJob["publicationPhase"], status: S8ExportJob["status"], jobId: UUID, claimToken: UUID): AdmittedSource {
    this.requireCurrentSource(projectId, source);
    const snapshot = this.advancePhase(jobId, claimToken, phase, status);
    this.emit(phase, projectId, snapshot.job.jobId, snapshot.artifact.artifactId);
    return this.requireCurrentSource(projectId, source);
  }

  private updateHeartbeat(jobId: UUID, claimToken: UUID, expected: S8SourceStamp): void {
    this.requireCurrentSource(expected.projectId, expected);
    this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId || !["running", "staged", "validated", "promoted"].includes(job.status)) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock(); job.heartbeatAt = at; job.updatedAt = at; artifact.updatedAt = at;
    });
  }

  private claim(jobId: UUID): { acquired: boolean; job: S8ExportJob; artifact: S8Artifact; source: AdmittedSource; claimToken: UUID | null } {
    const snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "job");
    const source = this.admitSource(snapshot.projectId);
    const claimToken = this.uuid();
    const claimed = this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "job");
      if (job.status !== "queued") return { acquired: false as const, job: { ...job }, artifact: { ...artifact }, claimToken: null };
      if (!sameS8Source(job.source, source.source) || !sameS8Source(artifact.source, source.source) || artifact.status !== job.status) fail(409, "S8_SOURCE_STALE");
      const at = this.clock();
      job.status = "running"; job.publicationPhase = "claim"; job.claimToken = claimToken; job.ownerId = this.ownerId; job.ownerProcessId = this.processId; job.claimedAt = at; job.heartbeatAt = at; job.updatedAt = at;
      artifact.status = "running"; artifact.publicationPhase = "claim"; artifact.privateStagingPrefix = s8StagingPrefix(job.projectId, job.artifactId, claimToken); artifact.updatedAt = at;
      return { acquired: true as const, job: { ...job }, artifact: { ...artifact }, claimToken };
    });
    if (!claimed.acquired) return { ...claimed, source };
    try {
      this.emit("claim", claimed.job.projectId, claimed.job.jobId, claimed.artifact.artifactId);
      this.requireCurrentSource(claimed.job.projectId, source.source);
    } catch (error) {
      this.markFailure(claimed.job.jobId, claimToken, error);
      throw error;
    }
    return { ...claimed, source };
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

  private validateWriterReceipt(receipt: unknown, payloadSha256: string, artifact: Buffer): asserts receipt is S8WriterReceipt {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail(422, "S8_WRITER_RECEIPT_INVALID");
    const value = receipt as Record<string, unknown>;
    if (value.schemaVersion !== S8_WRITER_RECEIPT_VERSION || value.profile !== S8_FBX_PROFILE || value.payloadSha256 !== payloadSha256 || value.artifactSha256 !== s8Sha256(artifact) || value.artifactByteSize !== artifact.length || value.fbxHeaderVersion !== 7400 || !value.runtime || typeof value.runtime !== "object" || Array.isArray(value.runtime) || typeof value.writerScriptSha256 !== "string" || !HEX64.test(value.writerScriptSha256)) fail(422, "S8_WRITER_RECEIPT_INVALID");
    if (artifact.length <= 27 || artifact.length > S8_LIMITS.artifactBytes) fail(422, "S8_ARTIFACT_RESOURCE_LIMIT");
  }

  private stage(prefix: string, values: ReadonlyMap<S8ObjectName, Buffer>): void {
    for (const [name, bytes] of values) this.objects.putExact(s8ObjectKey(prefix, name), bytes);
  }

  private promote(prefixFrom: string, prefixTo: string): void {
    for (const name of S8_OBJECT_NAMES) {
      const from = s8ObjectKey(prefixFrom, name);
      const to = s8ObjectKey(prefixTo, name);
      const expected = this.objects.exists(from) ? this.objects.read(from) : this.objects.read(to);
      this.objects.promoteExact(from, to, expected);
    }
  }

  private markFailure(jobId: UUID, claimToken: UUID | null, error: unknown): void {
    const code = error instanceof AppError ? error.code : "S8_PUBLICATION_FAILED";
    try {
      this.repository.transact((state) => {
        const collections = getS8Collections(state);
        const job = collections.jobs.find((item) => item.jobId === jobId);
        const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
        if (!job || !artifact || (claimToken !== null && (job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId))) return;
        if (["committed", "stale", "failed_terminal"].includes(job.status)) return;
        const stale = code === "S8_SOURCE_STALE" || code === "S8_SOURCE_NOT_READY";
        const status: S8ExportJob["status"] = stale ? "stale" : "failed_terminal";
        const at = this.clock();
        job.status = status; job.failureCode = code; job.terminalAt = at; job.updatedAt = at; job.claimToken = null; job.ownerId = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
        artifact.status = status; artifact.failureCode = code; artifact.staleAt = stale ? at : artifact.staleAt; artifact.updatedAt = at;
      });
    } catch {
      // Preserve the original operation failure. The repository remains authoritative.
    }
  }

  private cleanupStaging(prefix: string): void {
    for (const name of S8_OBJECT_NAMES) this.objects.remove(s8ObjectKey(prefix, name));
  }

  private verifyPublishedObjects(artifact: S8Artifact): Map<S8ObjectName, Buffer> {
    if (!artifact.objectHashes) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    const expected: Record<S8ObjectName, string> = { "artifact.fbx": artifact.objectHashes.artifactSha256, "writer-receipt.json": artifact.objectHashes.writerReceiptSha256, "native-readback.json": artifact.objectHashes.nativeReadbackSha256, "semantic-validation-receipt.json": artifact.objectHashes.semanticReceiptSha256, "publication-receipt.json": artifact.objectHashes.publicationReceiptSha256 };
    const result = new Map<S8ObjectName, Buffer>();
    for (const name of S8_OBJECT_NAMES) {
      const bytes = this.objects.read(s8ObjectKey(artifact.privateFinalPrefix, name));
      if ((name === "artifact.fbx" && bytes.length !== artifact.objectHashes.artifactByteSize) || s8Sha256(bytes) !== expected[name]) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      result.set(name, bytes);
    }
    return result;
  }

  private verifyPublicationState(projectId: UUID, artifact: S8Artifact): { bytes: Buffer; receipt: S8ValidationReceipt; objectHashes: NonNullable<S8Artifact["objectHashes"]>; fingerprint: string } {
    try {
      if (artifact.projectId !== projectId || artifact.status !== "committed" || !artifact.objectHashes || !artifact.payloadSha256 || !artifact.validationReceiptId || !artifact.validationReceiptHash || !artifact.immutableReuseFingerprint || artifact.publicationPhase !== "commit") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const current = this.requireCurrentSource(projectId, artifact.source);
      const stored = this.verifyPublishedObjects(artifact);
      const publication = parseJson(stored.get("publication-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (publication.schemaVersion !== "s8-publication-receipt-v2" || publication.fingerprintVersion !== S8_REUSE_FINGERPRINT_VERSION || publication.complete !== true || publication.immutableReuseFingerprint !== artifact.immutableReuseFingerprint || publication.validationReceiptHash !== artifact.validationReceiptHash) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const identity = publication.identity as PublicationIdentity;
      if (!identity || !sameS8Source(identity.source, artifact.source) || !sameS8Source(identity.source, current.source) || identity.profile !== S8_FBX_PROFILE || identity.protocol !== S8_PROTOCOL_VERSION || identity.semanticVersion !== S8_SEMANTIC_VERSION || identity.payloadSha256 !== artifact.payloadSha256 || identity.artifactSha256 !== artifact.objectHashes.artifactSha256 || identity.artifactByteSize !== artifact.objectHashes.artifactByteSize || identity.validatorIdentity !== publication.validatorIdentity || identity.storage?.finalPrefix !== artifact.privateFinalPrefix || jcs(identity.storage?.objectNames) !== jcs(S8_OBJECT_NAMES)) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      if (jcs(identity.implementation) !== jcs(implementationIdentity(identity.validatorIdentity))) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const writerEvidence = assertRunnerEvidence(identity.runner?.writer, expectedWriter());
      const validatorEvidence = assertRunnerEvidence(identity.runner?.validator, expectedValidator());
      if (jcs(publication.writerCallerVerification) !== jcs(callerEnvelope(writerEvidence)) || jcs(publication.validatorCallerVerification) !== jcs(callerEnvelope(validatorEvidence))) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const receiptHashes = identity.receiptHashes;
      if (!receiptHashes || receiptHashes.writer !== artifact.objectHashes.writerReceiptSha256 || receiptHashes.native !== artifact.objectHashes.nativeReadbackSha256 || receiptHashes.semantic !== artifact.objectHashes.semanticReceiptSha256) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const objects = publication.objects as PublicationObjects;
      if (!objects || objects.artifactSha256 !== artifact.objectHashes.artifactSha256 || objects.artifactByteSize !== artifact.objectHashes.artifactByteSize || objects.writerReceiptSha256 !== artifact.objectHashes.writerReceiptSha256 || objects.nativeReadbackSha256 !== artifact.objectHashes.nativeReadbackSha256 || objects.semanticReceiptSha256 !== artifact.objectHashes.semanticReceiptSha256 || objects.publicationReceiptSha256 !== null) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      if (publicationFingerprint(identity) !== artifact.immutableReuseFingerprint) fail(409, "S8_REUSE_FINGERPRINT_INVALID");

      const writer = parseJson(stored.get("writer-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      this.validateWriterReceipt(writer, artifact.payloadSha256, stored.get("artifact.fbx")!);
      if (jcs(publication.writer) !== jcs(writer)) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const native = parseJson(stored.get("native-readback.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (native.schemaVersion !== "s8-ufbx-readback-v1") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const semantic = parseJson(stored.get("semantic-validation-receipt.json")!, "S8_REUSE_FINGERPRINT_INVALID");
      if (semantic.schemaVersion !== "s8-semantic-validation-receipt-v2" || semantic.outcome !== "pass") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      const receipt = getS8Collections(this.repository.state()).receipts.find((item) => item.receiptId === artifact.validationReceiptId);
      if (!receipt || receipt.projectId !== artifact.projectId || receipt.artifactId !== artifact.artifactId || !sameS8Source(receipt.source, artifact.source) || receipt.receiptHash !== artifact.validationReceiptHash || receipt.payloadSha256 !== artifact.payloadSha256 || receipt.artifactSha256 !== artifact.objectHashes.artifactSha256 || receipt.artifactByteSize !== artifact.objectHashes.artifactByteSize || receipt.writerReceiptHash !== artifact.objectHashes.writerReceiptSha256 || receipt.nativeReadbackHash !== artifact.objectHashes.nativeReadbackSha256 || receipt.semanticReceiptHash !== artifact.objectHashes.semanticReceiptSha256 || receipt.immutableReuseFingerprint !== artifact.immutableReuseFingerprint || receiptHashWithoutHash(receipt) !== receipt.receiptHash) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
      return { bytes: stored.get("artifact.fbx")!, receipt, objectHashes: artifact.objectHashes, fingerprint: artifact.immutableReuseFingerprint };
    } catch (error) {
      if (error instanceof AppError && ["S8_PUBLICATION_OBJECT_MISMATCH", "S8_SOURCE_STALE", "S8_SOURCE_NOT_READY", "S8_REUSE_FINGERPRINT_INVALID"].includes(error.code)) throw error;
      fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    }
  }

  private verifyReuse(projectId: UUID, artifact: S8Artifact): Buffer {
    if (artifact.projectId !== projectId || artifact.status !== "committed" || artifact.publicationPhase !== "commit") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    return this.verifyPublicationState(projectId, artifact).bytes;
  }

  private commit(jobId: UUID, claimToken: UUID, source: S8SourceStamp): S8Artifact {
    this.requireCurrentSource(source.projectId, source);
    return this.repository.transact((state) => {
      const collections = getS8Collections(state);
      const job = collections.jobs.find((item) => item.jobId === jobId);
      const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId || job.publicationPhase !== "commit" || artifact.publicationPhase !== "commit" || artifact.status !== "promoted") fail(409, "S8_CLAIM_FENCED");
      const at = this.clock();
      job.status = "committed"; job.terminalAt = at; job.updatedAt = at; job.claimToken = null; job.ownerId = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
      artifact.status = "committed"; artifact.committedAt = at; artifact.updatedAt = at;
      return { ...artifact };
    });
  }

  private runClaimedExport(jobId: UUID): S8Artifact {
    let claimToken: UUID | null = null;
    let stagingPrefix: string | null = null;
    try {
      const claimed = this.claim(jobId);
      if (!claimed.acquired) return claimed.artifact;
      const activeClaimToken = claimed.claimToken;
      if (activeClaimToken === null) fail(500, "S8_PERSISTENCE_INVALID");
      claimToken = activeClaimToken;
      stagingPrefix = claimed.artifact.privateStagingPrefix;
      const { job, source } = claimed;
      const payload = source.prepared;
      const context: S8AdapterContext = { projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId, source: job.source, payload: payload.payload, onHeartbeat: () => this.updateHeartbeat(job.jobId, activeClaimToken, job.source) };

      this.updateHeartbeat(job.jobId, activeClaimToken, job.source);
      const written = this.writer(payload.bytes, context);
      this.validateWriterReceipt(written.receipt, payload.sha256, written.artifact);
      const writerEvidence = assertRunnerEvidence(written.runnerEvidence, expectedWriter());
      const artifactSha256 = s8Sha256(written.artifact);
      const writerReceiptBytes = jsonBytes(written.receipt, S8_LIMITS.receiptBytes, "S8_WRITER_RECEIPT_LIMIT");
      const finalPrefix = s8FinalPrefix(job.projectId, job.source.sourceRevisionHash, artifactSha256);
      this.repository.transact((state) => {
        const collections = getS8Collections(state);
        const currentJob = collections.jobs.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? collections.artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== activeClaimToken || currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
        currentArtifact.payloadSha256 = payload.sha256; currentArtifact.privateFinalPrefix = finalPrefix; currentArtifact.updatedAt = this.clock();
      });
      this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([["artifact.fbx", written.artifact], ["writer-receipt.json", writerReceiptBytes]]));
      this.fence(job.projectId, job.source, "private_staging", "staged", job.jobId, activeClaimToken);

      this.updateHeartbeat(job.jobId, activeClaimToken, job.source);
      const native = this.nativeValidator(written.artifact, context);
      if (!native.validatorIdentity || typeof native.validatorIdentity !== "string") fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
      const validatorEvidence = assertRunnerEvidence(native.runnerEvidence, expectedValidator());
      const nativeReadbackBytes = Buffer.from(native.readbackBytes);
      if (nativeReadbackBytes.length === 0 || nativeReadbackBytes.length > S8_LIMITS.readbackBytes) fail(422, "S8_NATIVE_READBACK_LIMIT");
      const parsedReadback = parseJson(nativeReadbackBytes, "S8_NATIVE_READBACK_INVALID");
      if (parsedReadback.schemaVersion !== "s8-ufbx-readback-v1" || native.readback.schemaVersion !== "s8-ufbx-readback-v1") fail(422, "S8_NATIVE_READBACK_INVALID");
      const semantic = this.semanticValidator(source.s6, source.s7, native.readback);
      if (semantic.outcome !== "pass") fail(422, "S8_SEMANTIC_VALIDATION_FAILED");
      const semanticBytes = jsonBytes({ schemaVersion: "s8-semantic-validation-receipt-v2", source: job.source, outcome: semantic.outcome, result: semantic }, S8_LIMITS.readbackBytes, "S8_SEMANTIC_RECEIPT_LIMIT");
      const nativeReadbackHash = s8Sha256(nativeReadbackBytes);
      const semanticReceiptHash = s8Sha256(semanticBytes);
      this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([["native-readback.json", nativeReadbackBytes], ["semantic-validation-receipt.json", semanticBytes]]));
      this.fence(job.projectId, job.source, "independent_validation", "validated", job.jobId, activeClaimToken);
      this.fence(job.projectId, job.source, "source_claim_recheck", "validated", job.jobId, activeClaimToken);

      const writerReceiptHash = s8Sha256(writerReceiptBytes);
      const identity: PublicationIdentity = { fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, source: job.source, profile: S8_FBX_PROFILE, protocol: S8_PROTOCOL_VERSION, semanticVersion: S8_SEMANTIC_VERSION, writerReceiptVersion: S8_WRITER_RECEIPT_VERSION, implementation: implementationIdentity(native.validatorIdentity), validatorIdentity: native.validatorIdentity, runner: { writer: writerEvidence, validator: validatorEvidence }, payloadSha256: payload.sha256, artifactSha256, artifactByteSize: written.artifact.length, receiptHashes: { writer: writerReceiptHash, native: nativeReadbackHash, semantic: semanticReceiptHash }, storage: { finalPrefix, objectNames: S8_OBJECT_NAMES } };
      const fingerprint = publicationFingerprint(identity);
      const validationBody: Omit<S8ValidationReceipt, "receiptHash"> = { schemaVersion: "s8-validation-receipt-v2", receiptId: this.uuid(), projectId: job.projectId, artifactId: job.artifactId, source: job.source, payloadSha256: payload.sha256, artifactSha256, artifactByteSize: written.artifact.length, writerReceiptHash, nativeReadbackHash, semanticReceiptHash, nativeOutcome: "pass", semanticOutcome: "pass", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, immutableReuseFingerprint: fingerprint, resourceLimitsHash: s8ResourceLimitsHash(S8_RESOURCE_TABLE), checkedAt: this.clock() };
      const validationReceipt: S8ValidationReceipt = { ...validationBody, receiptHash: receiptHashWithoutHash(validationBody) };
      const publicationBody = { schemaVersion: "s8-publication-receipt-v2", fingerprintVersion: S8_REUSE_FINGERPRINT_VERSION, identity, objects: { artifactSha256, artifactByteSize: written.artifact.length, writerReceiptSha256: writerReceiptHash, nativeReadbackSha256: nativeReadbackHash, semanticReceiptSha256: semanticReceiptHash, publicationReceiptSha256: null }, writer: written.receipt, validatorIdentity: native.validatorIdentity, writerCallerVerification: callerEnvelope(writerEvidence), validatorCallerVerification: callerEnvelope(validatorEvidence), validationReceiptHash: validationReceipt.receiptHash, immutableReuseFingerprint: fingerprint, complete: true };
      const publicationBytes = jsonBytes(publicationBody, S8_LIMITS.readbackBytes, "S8_PUBLICATION_RECEIPT_LIMIT");
      const publicationReceiptHash = s8Sha256(publicationBytes);
      const objectHashes = { artifactSha256, artifactByteSize: written.artifact.length, writerReceiptSha256: writerReceiptHash, nativeReadbackSha256: nativeReadbackHash, semanticReceiptSha256: semanticReceiptHash, publicationReceiptSha256: publicationReceiptHash };
      this.repository.transact((state) => {
        const collections = getS8Collections(state);
        const currentJob = collections.jobs.find((item) => item.jobId === job.jobId);
        const currentArtifact = currentJob ? collections.artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
        if (!currentJob || !currentArtifact || currentJob.claimToken !== activeClaimToken || currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId || currentJob.publicationPhase !== "source_claim_recheck") fail(409, "S8_CLAIM_FENCED");
        if (collections.receipts.some((item) => item.receiptId === validationReceipt.receiptId)) fail(500, "S8_PERSISTENCE_INVALID");
        currentArtifact.objectHashes = objectHashes; currentArtifact.writerReceiptHash = writerReceiptHash; currentArtifact.nativeReadbackHash = nativeReadbackHash; currentArtifact.semanticReceiptHash = semanticReceiptHash; currentArtifact.publicationReceiptHash = publicationReceiptHash; currentArtifact.validationReceiptId = validationReceipt.receiptId; currentArtifact.validationReceiptHash = validationReceipt.receiptHash; currentArtifact.immutableReuseFingerprint = fingerprint; currentArtifact.updatedAt = this.clock();
        collections.receipts.push(validationReceipt);
      });
      this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([["publication-receipt.json", publicationBytes]]));
      this.fence(job.projectId, job.source, "immutable_promotion", "promoted", job.jobId, activeClaimToken);
      this.promote(stagingPrefix, finalPrefix);
      const promoted = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      if (!promoted) fail(500, "S8_PERSISTENCE_INVALID");
      this.verifyPublishedObjects(promoted);
      this.fence(job.projectId, job.source, "verified_readback", "promoted", job.jobId, activeClaimToken);
      this.fence(job.projectId, job.source, "commit", "promoted", job.jobId, activeClaimToken);
      const committed = this.commit(job.jobId, activeClaimToken, job.source);
      this.cleanupStaging(stagingPrefix);
      return committed;
    } catch (error) {
      if (claimToken !== null) this.markFailure(jobId, claimToken, error);
      if (stagingPrefix && error instanceof AppError && ["S8_SOURCE_STALE", "S8_SOURCE_NOT_READY"].includes(error.code)) this.cleanupStaging(stagingPrefix);
      throw error;
    }
  }

  private createRecords(projectId: UUID, idempotencyKey: string, source: S8SourceStamp, inputHash: string): { job: S8ExportJob; artifact: S8Artifact; idempotency: S8IdempotencyRecord } {
    const at = this.clock(); const jobId = this.uuid(); const artifactId = this.uuid(); const pendingHash = "0".repeat(64);
    const artifact: S8Artifact = { schemaVersion: "s8-artifact-v2", artifactId, projectId, jobId, source, inputHash, profile: S8_FBX_PROFILE, format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx", status: "queued", publicationPhase: "source_admission", payloadSha256: null, objectHashes: null, writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null, validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null, privateStagingPrefix: s8StagingPrefix(projectId, artifactId, "unclaimed"), privateFinalPrefix: s8FinalPrefix(projectId, source.sourceRevisionHash, pendingHash), attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: at, updatedAt: at, committedAt: null, staleAt: null };
    const job: S8ExportJob = { schemaVersion: "s8-export-job-v2", jobId, projectId, artifactId, source, inputHash, idempotencyKey, status: "queued", publicationPhase: "source_admission", attempt: 1, claimToken: null, ownerId: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null, failureCode: null };
    const idempotency: S8IdempotencyRecord = { schemaVersion: "s8-idempotency-v2", projectId, operation: "export", idempotencyKey, inputHash, source, jobId, artifactId, createdAt: at };
    return { job, artifact, idempotency };
  }

  createExport(projectId: UUID, idempotencyKey: string, requestReferenceId?: UUID): S8ExportResult {
    assertOpaqueKey(idempotencyKey); assertReference(requestReferenceId);
    const admitted = this.admitSource(projectId);
    this.reconcileCommittedSupersession(projectId, admitted.source);
    const inputHash = admitted.prepared.sha256;
    const existing = getS8Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputHash !== inputHash || !sameS8Source(existing.source, admitted.source)) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const job = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === existing.jobId);
      const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === existing.artifactId);
      if (!job || !artifact || job.artifactId !== artifact.artifactId || artifact.jobId !== job.jobId || artifact.status !== job.status) fail(500, "S8_PERSISTENCE_INVALID");
      if (artifact.status === "committed") { this.verifyReuse(projectId, artifact); return { replayed: true, export: publicArtifact(artifact), job: { jobId: job.jobId, status: job.status, attempt: job.attempt } }; }
      if (artifact.status === "queued") {
        const current = this.runClaimedExport(job.jobId); const latestJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === job.jobId)!;
        return { replayed: true, export: publicArtifact(current), job: { jobId: latestJob.jobId, status: latestJob.status, attempt: latestJob.attempt } };
      }
      return { replayed: true, export: publicArtifact(artifact), job: { jobId: job.jobId, status: job.status, attempt: job.attempt } };
    }

    const records = this.createRecords(projectId, idempotencyKey, admitted.source, inputHash);
    try {
      this.emitAdmission(projectId, records.job.jobId, records.artifact.artifactId, admitted.source);
      const admission = this.repository.transact((state) => {
        state.s8ExportJobs ??= []; state.s8Artifacts ??= []; state.s8ValidationReceipts ??= []; state.s8IdempotencyRecords ??= [];
        const collections = getS8Collections(state);
        const collision = collections.idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
        if (collision) return { replayed: true as const, jobId: collision.jobId, artifactId: collision.artifactId };
        collections.jobs.push(records.job); collections.artifacts.push(records.artifact); collections.idempotency.push(records.idempotency);
        return { replayed: false as const, jobId: records.job.jobId, artifactId: records.artifact.artifactId };
      });
      if (admission.replayed) {
        const job = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === admission.jobId);
        const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === admission.artifactId);
        if (!job || !artifact) fail(500, "S8_PERSISTENCE_INVALID");
        if (artifact.status === "committed") this.verifyReuse(projectId, artifact);
        if (artifact.status === "queued") this.runClaimedExport(job.jobId);
        const currentJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === job.jobId)!;
        const currentArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === artifact.artifactId)!;
        return { replayed: true, export: publicArtifact(currentArtifact), job: { jobId: currentJob.jobId, status: currentJob.status, attempt: currentJob.attempt } };
      }
    } catch (error) {
      this.markFailure(records.job.jobId, null, error);
      throw error;
    }
    const current = this.runClaimedExport(records.job.jobId); const latestJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === records.job.jobId);
    if (!latestJob) fail(500, "S8_PERSISTENCE_INVALID");
    return { replayed: false, export: publicArtifact(current), job: { jobId: latestJob.jobId, status: latestJob.status, attempt: latestJob.attempt } };
  }

  getHandoff(projectId: UUID): S8PreparedExport & { source: S8SourceStamp } {
    const value = this.admitSource(projectId);
    return { profile: S8_FBX_PROFILE, semanticVersion: S8_SEMANTIC_VERSION, sourceRevisionId: value.s6.acceptedRevisionId, sourceRevisionHash: value.s6.acceptedRevisionHash, objectNames: value.prepared.payload.objects.map((item) => item.name), payloadBytes: value.prepared.bytes, payloadSha256: value.prepared.sha256, source: value.source };
  }

  getExport(projectId: UUID, artifactId: UUID): S8PublicArtifact {
    const source = this.admitSource(projectId);
    const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    if (!sameS8Source(artifact.source, source.source)) fail(409, "S8_SOURCE_STALE", "source");
    if (artifact.status === "committed") this.verifyReuse(projectId, artifact);
    return publicArtifact(artifact);
  }

  download(projectId: UUID, artifactId: UUID): S8DownloadResult {
    const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.projectId === projectId && item.artifactId === artifactId);
    if (!artifact) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "artifact");
    const bytes = this.verifyReuse(projectId, artifact);
    return { bytes, contentType: "application/octet-stream", fileName: "swooshz-s8-scene.fbx" };
  }

  private reclaim(job: S8ExportJob): { job: S8ExportJob; claimToken: UUID } {
    if (!job.claimToken || !job.ownerId || job.ownerProcessId === null) fail(409, "S8_CLAIM_FENCED");
    const previousToken = job.claimToken; const claimToken = this.uuid();
    const reclaimed = this.repository.transact((state) => {
      const collections = getS8Collections(state); const current = collections.jobs.find((item) => item.jobId === job.jobId); const artifact = current ? collections.artifacts.find((item) => item.artifactId === current.artifactId) : undefined;
      if (!current || !artifact || current.claimToken !== previousToken || current.ownerId !== job.ownerId || current.ownerProcessId !== job.ownerProcessId || artifact.status !== current.status) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock(); current.claimToken = claimToken; current.ownerId = this.ownerId; current.ownerProcessId = this.processId; current.claimedAt = at; current.heartbeatAt = at; current.updatedAt = at;
      return { ...current };
    });
    return { job: reclaimed, claimToken };
  }

  private resetAfterDeadClaim(job: S8ExportJob): void {
    this.repository.transact((state) => {
      const collections = getS8Collections(state); const currentJob = collections.jobs.find((item) => item.jobId === job.jobId); const currentArtifact = currentJob ? collections.artifacts.find((item) => item.artifactId === currentJob.artifactId) : undefined;
      if (!currentJob || !currentArtifact || currentJob.claimToken !== job.claimToken || currentJob.ownerId !== job.ownerId || currentJob.ownerProcessId !== job.ownerProcessId) return;
      if (currentArtifact.validationReceiptId !== null) { const receiptIndex = collections.receipts.findIndex((item) => item.receiptId === currentArtifact.validationReceiptId); if (receiptIndex >= 0) collections.receipts.splice(receiptIndex, 1); }
      const at = this.clock();
      currentJob.status = "queued"; currentJob.publicationPhase = "source_admission"; currentJob.claimToken = null; currentJob.ownerId = null; currentJob.ownerProcessId = null; currentJob.claimedAt = null; currentJob.heartbeatAt = null; currentJob.terminalAt = null; currentJob.failureCode = null; currentJob.updatedAt = at;
      currentArtifact.status = "queued"; currentArtifact.publicationPhase = "source_admission"; currentArtifact.payloadSha256 = null; currentArtifact.objectHashes = null; currentArtifact.writerReceiptHash = null; currentArtifact.nativeReadbackHash = null; currentArtifact.semanticReceiptHash = null; currentArtifact.publicationReceiptHash = null; currentArtifact.validationReceiptId = null; currentArtifact.validationReceiptHash = null; currentArtifact.immutableReuseFingerprint = null; currentArtifact.privateStagingPrefix = s8StagingPrefix(currentArtifact.projectId, currentArtifact.artifactId, "unclaimed"); currentArtifact.privateFinalPrefix = s8FinalPrefix(currentArtifact.projectId, currentArtifact.source.sourceRevisionHash, "0".repeat(64)); currentArtifact.failureCode = null; currentArtifact.committedAt = null; currentArtifact.staleAt = null; currentArtifact.updatedAt = at;
    });
  }

  recoverPending(): number {
    const candidates = getS8Collections(this.repository.state()).jobs.filter((job) => ["running", "staged", "validated", "promoted"].includes(job.status) && job.claimToken !== null && job.ownerProcessId !== null);
    let recovered = 0;
    for (const candidate of candidates) {
      const heartbeat = candidate.heartbeatAt ? Date.parse(candidate.heartbeatAt) : 0; const now = Date.parse(this.clock());
      if (!Number.isFinite(now) || !Number.isFinite(heartbeat) || now - heartbeat <= S8_STALE_CLAIM_MS) continue;
      let alive = true; try { alive = this.isProcessAlive(candidate.ownerProcessId!); } catch { alive = true; }
      if (alive) continue;
      const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === candidate.artifactId); if (!artifact) continue;
      const oldStaging = artifact.privateStagingPrefix;
      if (phaseIndex(candidate.publicationPhase) >= phaseIndex("immutable_promotion")) {
        try {
          const reclaimed = this.reclaim(candidate);
          this.promote(artifact.privateStagingPrefix, artifact.privateFinalPrefix);
          const currentArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === artifact.artifactId); if (!currentArtifact) fail(500, "S8_PERSISTENCE_INVALID");
          const verified = this.verifyPublicationState(candidate.projectId, { ...currentArtifact, status: "committed", publicationPhase: "commit" });
          void verified;
          const currentJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === candidate.jobId);
          if (currentJob?.publicationPhase === "immutable_promotion") this.fence(candidate.projectId, candidate.source, "verified_readback", "promoted", candidate.jobId, reclaimed.claimToken);
          if (getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === candidate.jobId)?.publicationPhase !== "commit") this.fence(candidate.projectId, candidate.source, "commit", "promoted", candidate.jobId, reclaimed.claimToken);
          this.commit(candidate.jobId, reclaimed.claimToken, candidate.source); this.cleanupStaging(oldStaging);
        } catch (error) {
          this.markFailure(candidate.jobId, getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === candidate.jobId)?.claimToken ?? candidate.claimToken, error);
        }
        recovered += 1; continue;
      }
      this.cleanupStaging(oldStaging); this.resetAfterDeadClaim(candidate);
      try { this.runClaimedExport(candidate.jobId); } catch { /* failure is durably recorded by the production path */ }
      recovered += 1;
    }
    return recovered;
  }
}
