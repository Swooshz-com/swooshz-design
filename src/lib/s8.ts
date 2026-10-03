import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { AppError, type S6ToS7Handoff, type S7ToS8Handoff, type S8Artifact, type S8ArtifactV3, type S8ExportJob, type S8ExportJobV3, type S8IdempotencyRecord, type S8SourceStamp, type S8ValidationReceipt, type S8ValidationReceiptBytesV1, type S8ValidationReceiptV3, type Timestamp, type UUID } from "./types";
import type { S8ProofProjection } from "./s8-native-proof";
import { buildS8WriterPayload, canonicalS8SourceJson, type S8WriterPayload } from "./s8-fbx-payload";
import { assertS8ReadbackProvenance, compareS8UfbxReadback, type S8SemanticResult, type S8UfbxReadback } from "./s8-fbx-semantic";
import { S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_EXPORTER_SETTINGS, S8_FBX_PROFILE, S8_LIMITS, S8_PROCESS_RUNNER_PIN, S8_PROTOCOL_VERSION, S8_RESOURCE_TABLE, S8_REUSE_FINGERPRINT_VERSION, S8_SEMANTIC_VERSION, S8_UFBX_PIN, S8_VALIDATOR_PIN, S8_WRITER_RECEIPT_VERSION, s8Sha256 } from "./s8-fbx-profile";
import { getS8Collections, sameS8Source, s8FinalPrefix, s8ObjectKey, s8ResourceLimitsHash, s8StagingPrefix, S8_OBJECT_NAMES, S8_STALE_CLAIM_MS } from "./s8-fbx-persistence";
import { JsonRepository, PrivateObjectStore } from "./store";
import { jcs, newUuid, nowUtc, sha256, uuidV4Pattern } from "./utils";
import { S6WorkflowService } from "./s6";
import { S7CadService } from "./s7-cad";
import { canonicalS8RunnerReceiptBytes, type S8CallerVerification, type S8RunnerEvidence, type S8WriterReceipt } from "./s8-fbx-worker";
import type { S8NativeWorkerConfig } from "./s8-fbx-config";
import type { S8RepositoryCommand, S8RepositoryCommandSession } from "./s8-native-proof";
import { beginS8NativeOperation, finalizeS8NativeAcceptance, finalizeS8NativeFailure, nativeOperationStartEvidence, s8NativeRequestConfigSha256, type S8NativeOperationClock, type S8NativeOperationContext, type S8SignedNativeRequest } from "./s8-native-protocol";
import { isRegisteredS8NativeWorkerClient, S8NativeWorkerClient, type S8NativeVerifiedFailureData, type S8NativeVerifiedResultData } from "./s8-native-worker-client";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./s8-native-admission";
import { S8_NATIVE_WORKER_PROTOCOL_VERSION } from "./s8-native-release";

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
  nativeWorkerConfig?: S8NativeWorkerConfig;
  nativeWorkerClient?: S8NativeWorkerClient;
  onPublicationPhase?: S8PublicationPhaseHook;
};

type RunnerExpectation = { addressSpaceBytes: number; fileBytes: number; timeoutMs: number; stdoutBytes: number; stderrBytes: number; maxChildren: 0 };
type AdmittedSource = { s6: S6ToS7Handoff; s7: S7ToS8Handoff; source: S8SourceStamp; prepared: ReturnType<typeof buildS8WriterPayload> };
type S8ObjectName = (typeof S8_OBJECT_NAMES)[number];
type PublicationObjects = { artifactSha256: string; artifactByteSize: number; writerReceiptSha256: string; nativeReadbackSha256: string; semanticReceiptSha256: string; publicationReceiptSha256: null };
type PublicationIdentity = {
  fingerprintVersion: "s8-immutable-reuse-fingerprint-v3";
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
function hashValue(value: unknown): value is string { return typeof value === "string" && HEX64.test(value); }
function canonicalNonceValue(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function responseObservedAtUnixMs(startedAtUnixMs: number, witness: Readonly<{ responseWallUnixMs: number; responseMonotonicElapsedNs: string; responsePriorEffectiveUnixMs: number }>): number {
  const monotonic = BigInt(startedAtUnixMs) + (BigInt(witness.responseMonotonicElapsedNs) + 999999n) / 1000000n;
  const observed = [BigInt(witness.responseWallUnixMs), monotonic, BigInt(witness.responsePriorEffectiveUnixMs)]
    .reduce((left, right) => left > right ? left : right);
  const value = Number(observed);
  if (!Number.isSafeInteger(value)) throw new AppError(422, "S8_NATIVE_CLOCK_INVALID");
  return value;
}

function signNativeEvidence(config: S8NativeWorkerConfig, domainName: string, body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const domain = Buffer.concat([Buffer.from(domainName, "ascii"), Buffer.from([0])]);
  const signature = sign(null, Buffer.concat([domain, Buffer.from(jcs(body), "utf8")]), createPrivateKey(config.appSigningPrivateKeyPem)).toString("base64url");
  return Object.freeze({ body, signature, receiptSha256: sha256(jcs({ body, signature })) });
}

function signAcceptance(config: S8NativeWorkerConfig, body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return signNativeEvidence(config, "S8-NATIVE-ACCEPTANCE-V1", body);
}

function signRetryEvidence(config: S8NativeWorkerConfig, body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return signNativeEvidence(config, "S8-NATIVE-RETRY-EVIDENCE-V1", body);
}

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
  const envelopeKeys = ["schemaVersion", "status", "preLaunchSha256", "postLaunchSha256", "runnerReportedSelfSha256", "outerExitStatus", "outerSignal", "observedStdoutBytes", "observedStderrBytes", "receiptSha256"];
  if (!envelope || Object.keys(envelope).length !== envelopeKeys.length || envelopeKeys.some((key) => !Object.hasOwn(envelope, key)) || envelope.status !== "VERIFIED_BY_CALLER" || envelope.schemaVersion !== "s8-runner-caller-verification-v2" || !HEX64.test(envelope.preLaunchSha256) || envelope.preLaunchSha256 !== envelope.postLaunchSha256 || envelope.postLaunchSha256 !== envelope.runnerReportedSelfSha256 || envelope.runnerReportedSelfSha256 !== value.runnerBinary?.selfSha256 || envelope.outerExitStatus !== value.result?.code || envelope.outerSignal !== null || !Number.isSafeInteger(envelope.observedStdoutBytes) || envelope.observedStdoutBytes !== value.result?.stdoutBytes || !Number.isSafeInteger(envelope.observedStderrBytes) || envelope.observedStderrBytes !== value.result?.stderrBytes || !HEX64.test(envelope.receiptSha256)) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  if (s8Sha256(canonicalS8RunnerReceiptBytes(value)) !== envelope.receiptSha256) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
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
  if (evidence.runnerParentVerification?.status !== "PASS" || evidence.runnerParentVerification.mismatchCode !== null || evidence.result?.code !== 0 || evidence.result.name !== "S8_RUNNER_SUCCESS" || evidence.result.terminationClass !== "target-exit-zero" || evidence.result.targetExit !== 0 || evidence.result.targetSignal !== null || evidence.result.setupStage !== null || evidence.result.evidenceCode !== null || !Number.isSafeInteger(evidence.result.stdoutBytes) || evidence.result.stdoutBytes < 0 || evidence.result.stdoutBytes > expected.stdoutBytes || !Number.isSafeInteger(evidence.result.stderrBytes) || evidence.result.stderrBytes < 0 || evidence.result.stderrBytes > expected.stderrBytes || !HEX64.test(evidence.runnerBinary?.selfSha256 ?? "")) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
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
  readonly #commandSession: S8RepositoryCommandSession;
  readonly repository: JsonRepository;
  readonly objects: PrivateObjectStore;
  readonly s6: S6WorkflowService;
  readonly s7: S7CadService;
  private readonly clock: () => Timestamp;
  private readonly uuid: () => UUID;
  private readonly ownerId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly nativeWorkerConfig: S8NativeWorkerConfig | undefined;
  private readonly nativeWorkerClient: S8NativeWorkerClient | null;
  private readonly onPublicationPhase: S8PublicationPhaseHook | undefined;
  private readonly nativeOperations = new Map<string, { clock: S8NativeOperationClock; context: S8NativeOperationContext }>();

  constructor(options: S8ExportServiceOptions) {
    this.repository = options.repository;
    this.#commandSession = options.repository.createS8CommandSession();
    this.objects = options.objects;
    this.s6 = options.s6;
    this.s7 = options.s7;
    this.clock = options.clock ?? nowUtc;
    this.uuid = options.uuid ?? newUuid;
    this.ownerId = options.ownerId ?? `s8-process-${String(options.processId ?? process.pid)}-${this.uuid()}`;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? ownerIsAliveDefault;
    this.nativeWorkerConfig = options.nativeWorkerConfig;
    this.nativeWorkerClient = options.nativeWorkerClient ?? (options.nativeWorkerConfig ? new S8NativeWorkerClient(options.nativeWorkerConfig) : null);
    this.onPublicationPhase = options.onPublicationPhase;
  }

  private command<T>(command: S8RepositoryCommand, mutation: (state: import("./types").StoreState) => T): T {
    return this.repository.runS8Command(this.#commandSession, command, mutation);
  }

  private requireNativeWorker(): S8NativeWorkerClient {
    if (!isRegisteredS8NativeWorkerClient(this.nativeWorkerClient) || !this.nativeWorkerConfig ||
        !this.nativeWorkerClient.isBoundTo(this.nativeWorkerConfig)) fail(503, "S8_TOOLING_UNAVAILABLE");
    return this.nativeWorkerClient;
  }

  private beginNativeAttempt(jobValue: S8ExportJob, operation: "WRITER" | "VALIDATOR", input: Buffer): { attemptId: UUID; clock: S8NativeOperationClock; context: S8NativeOperationContext } {
    const client = this.requireNativeWorker();
    const projection = this.repository.readS8(jobValue.projectId, jobValue.artifactId);
    const expectedLifecycle = operation === "WRITER" ? "running" : "staged";
    if (projection.lifecycle() !== expectedLifecycle) fail(409, "S8_PROOF_REQUIRED");
    if (projection.sourceDisposition() === "STALE") fail(409, "S8_SOURCE_STALE", "source");
    if (projection.sourceDisposition() !== "CURRENT") fail(409, "S8_SOURCE_NOT_READY", "source");
    const current = projection.applicationArtifact();
    const expectedNativeClaim = operation === "WRITER" ? null : jobValue.nativeClaimToken ?? null;
    if (current.jobId !== jobValue.jobId || current.artifactId !== jobValue.artifactId ||
        current.source === undefined || jcs(current.source) !== jcs(jobValue.source) ||
        operation === "WRITER" && s8Sha256(input) !== jobValue.inputHash ||
        operation === "VALIDATOR" && (!expectedNativeClaim || jobValue.nativeClaimToken !== expectedNativeClaim)) fail(409, "S8_PROOF_REQUIRED");
    const attempts = this.repository.state().s8NativeOperationAttempts ?? [];
    const writer = attempts.find((item) => item.jobId === jobValue.jobId && item.attempt === jobValue.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
    let nativeClaimToken = expectedNativeClaim as UUID | null;
    let releaseManifestSha256 = client.configuredReleaseManifestSha256();
    if (operation === "VALIDATOR") {
      const acceptance = writer?.acceptanceReceipt as { body?: Record<string, unknown> } | null;
      if (!writer || writer.state !== "SUCCEEDED" || !acceptance?.body ||
          acceptance.body.outputSha256 !== s8Sha256(input) || acceptance.body.outputBytes !== input.byteLength ||
          !canonicalNonceValue(acceptance.body.releaseHandle) || !hashValue(acceptance.body.releaseManifestSha256)) fail(409, "S8_PROOF_REQUIRED");
      releaseManifestSha256 = String(acceptance.body.releaseManifestSha256);
    }
    nativeClaimToken ??= this.uuid();
    const attemptId = this.uuid();
    const clock = beginS8NativeOperation(operation);
    const start = nativeOperationStartEvidence(clock);
    const context: S8NativeOperationContext = { projectId: jobValue.projectId, jobId: jobValue.jobId,
      artifactId: jobValue.artifactId, attempt: jobValue.attempt, source: jobValue.source };
    const at = this.clock();
    const attempt: Record<string, unknown> = {
      schemaVersion: "s8-native-operation-attempt-v2", attemptId, projectId: jobValue.projectId, jobId: jobValue.jobId,
      artifactId: jobValue.artifactId, claimToken: nativeClaimToken, attempt: jobValue.attempt, operation, state: "DISPATCHING",
      acceptedSourceDigest: sha256(jcs(jobValue.source)), profile: S8_FBX_PROFILE, protocolVersion: S8_NATIVE_WORKER_PROTOCOL_VERSION,
      configSha256: s8NativeRequestConfigSha256(), resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
      operationStartedAtUnixMs: start.operationStartedAtUnixMs, deadlineUnixMs: start.deadlineUnixMs,
      clockModelVersion: start.clockModelVersion, processClockEpoch: start.processClockEpoch,
      operationStartMonotonicNs: start.operationStartMonotonicNs, inputSha256: s8Sha256(input), inputBytes: input.byteLength,
      requestSha256: null, requestNonce: null, signedRequest: null, responseSha256: null, signedResponse: null,
      releaseManifestSha256, acceptanceReceipt: null, retryEvidence: null, failureClass: null, failureCode: null,
      disposalState: "NOT_STARTED", createdAt: at, updatedAt: at, completedAt: null,
    };
    this.command({ kind: "beginNativeAttempt", projectId: jobValue.projectId, jobId: jobValue.jobId, artifactId: jobValue.artifactId }, (state) => {
      const jobs = state.s8ExportJobs ?? [];
      const job = jobs.find((item) => item.jobId === jobValue.jobId) as S8ExportJobV3 | undefined;
      const artifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === jobValue.artifactId) as S8ArtifactV3 | undefined;
      if (!job || !artifact || job.claimToken !== jobValue.claimToken || job.ownerId !== this.ownerId ||
          job.ownerProcessId !== this.processId || job.status !== expectedLifecycle) fail(409, "S8_CLAIM_FENCED");
      state.s8NativeOperationAttempts ??= [];
      if (operation === "WRITER") {
        if (job.nativeClaimToken !== null) fail(409, "S8_PROOF_REQUIRED");
        job.nativeClaimToken = nativeClaimToken;
        artifact.privateStagingPrefix = s8StagingPrefix(job.projectId, artifact.artifactId, nativeClaimToken);
      } else if (job.nativeClaimToken !== nativeClaimToken) fail(409, "S8_PROOF_REQUIRED");
      job.updatedAt = at; artifact.updatedAt = at;
      state.s8NativeOperationAttempts.push(attempt as import("./types").S8NativeAttemptV2);
    });
    this.nativeOperations.set(attemptId, { clock, context });
    return { attemptId, clock, context };
  }

  private prepareNativeAttempt(job: S8ExportJob, attemptId: UUID, requestSha256: string, requestNonce: string,
    releaseManifestSha256: string, clock: S8NativeOperationClock, signedRequest: S8SignedNativeRequest): void {
    const operation = this.nativeOperations.get(attemptId);
    if (!operation || operation.clock !== clock || operation.context.jobId !== job.jobId) fail(500, "S8_PROOF_REQUIRED");
    const at = this.clock();
    this.command({ kind: "prepareNativeAttempt", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
      const attempt = (state.s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
      if (!attempt || attempt.state !== "DISPATCHING" || attempt.requestSha256 !== null ||
          attempt.releaseManifestSha256 !== releaseManifestSha256 || attempt.operation !== signedRequest.body.operation ||
          attempt.deadlineUnixMs !== signedRequest.body.deadlineUnixMs) fail(409, "S8_PROOF_REQUIRED");
      attempt.requestSha256 = requestSha256; attempt.requestNonce = requestNonce;
      attempt.signedRequest = signedRequest; attempt.disposalState = "UNKNOWN"; attempt.updatedAt = at;
    });
  }

  private persistNativeAcceptance(job: S8ExportJob, attemptId: UUID, clock: S8NativeOperationClock,
    data: S8NativeVerifiedResultData): void {
    const operation = this.nativeOperations.get(attemptId);
    if (!operation || operation.clock !== clock || operation.context.jobId !== job.jobId) fail(500, "S8_PROOF_REQUIRED");
    const state = this.repository.state();
    const attempt = (state.s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
    if (!attempt || data.operation !== attempt.operation) fail(500, "S8_PROOF_REQUIRED");
    const acceptanceReceipt = this.acceptanceReceipt(attempt, clock, data);
    const body = acceptanceReceipt.body as Record<string, unknown>;
    const at = new Date(Number(body.logicalAcceptedAtUnixMs)).toISOString();
    this.command({ kind: "persistNativeAcceptance", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (candidate) => {
      const current = (candidate.s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
      if (!current || current.state !== "DISPATCHING" || current.requestSha256 !== data.requestSha256) fail(409, "S8_PROOF_REQUIRED");
      current.state = "SUCCEEDED"; current.responseSha256 = data.responseSha256; current.signedResponse = data.response;
      current.acceptanceReceipt = acceptanceReceipt; current.disposalState = "REAPED_REMOVED"; current.completedAt = at; current.updatedAt = at;
    });
    this.nativeOperations.delete(attemptId);
  }

  private acceptanceReceipt(attempt: Record<string, unknown>, clock: S8NativeOperationClock, data: S8NativeVerifiedResultData): Readonly<Record<string, unknown>> {
    const config = this.nativeWorkerConfig;
    if (!config || data.operation !== attempt.operation || data.response.body.requestSha256 !== attempt.requestSha256) fail(500, "S8_PROOF_REQUIRED");
    const started = nativeOperationStartEvidence(clock);
    const finalized = finalizeS8NativeAcceptance(clock, (logicalAcceptedAtUnixMs, clockWitness) => {
      const body: Record<string, unknown> = {
        schemaVersion: "s8-native-acceptance-v1", acceptanceId: this.uuid(), keyId: config.appSigningKeyId,
        operationStartedAtUnixMs: started.operationStartedAtUnixMs, deadlineUnixMs: started.deadlineUnixMs,
        responseObservedAtUnixMs: responseObservedAtUnixMs(started.operationStartedAtUnixMs, clockWitness),
        logicalAcceptedAtUnixMs, clockModelVersion: started.clockModelVersion, processClockEpoch: started.processClockEpoch,
        clockWitness, attemptId: attempt.attemptId, projectId: attempt.projectId, jobId: attempt.jobId,
        artifactId: attempt.artifactId, attempt: attempt.attempt, operation: attempt.operation, claimToken: attempt.claimToken,
        acceptedSourceDigest: attempt.acceptedSourceDigest, profile: attempt.profile, protocolVersion: attempt.protocolVersion,
        configSha256: attempt.configSha256, requestSha256: attempt.requestSha256, requestNonce: attempt.requestNonce,
        inputSha256: attempt.inputSha256, inputBytes: attempt.inputBytes, responseSha256: data.responseSha256,
        outputSha256: sha256(data.output), outputBytes: data.output.length,
        auxiliarySha256: sha256(data.auxiliary), auxiliaryBytes: data.auxiliary.length,
        releaseManifestSha256: data.releaseManifestSha256, resourcePolicySha256: attempt.resourcePolicySha256,
        imageDigest: data.response.body.imageDigest, containerId: data.response.body.containerId,
        runnerBinarySha256: data.runnerEvidence.runnerBinary.selfSha256,
        runnerEvidenceSha256: sha256(jcs(data.runnerEvidence)), releaseHandle: data.releaseHandle ?? null,
        validatorIdentity: data.validatorIdentity ?? null, disposalState: "REAPED_REMOVED", nativeOutcome: "EXIT_0",
      };
      return signAcceptance(config, body);
    });
    return finalized.event;
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

  private emit(phase: S8ExportJob["publicationPhase"], projectId: UUID, jobId: UUID, artifactId: UUID): void {
    try { this.onPublicationPhase?.(phase, { projectId, jobId, artifactId }); } catch { throw new AppError(500, "S8_PUBLICATION_FAILED"); }
  }

  private emitAdmission(projectId: UUID, jobId: UUID, artifactId: UUID, expected: S8SourceStamp): void {
    this.requireCurrentSource(projectId, expected);
    this.emit("source_admission", projectId, jobId, artifactId);
    this.requireCurrentSource(projectId, expected);
  }

  private updateHeartbeat(jobId: UUID, claimToken: UUID, expected: S8SourceStamp): void {
    this.requireCurrentSource(expected.projectId, expected);
    const linked = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!linked || linked.projectId !== expected.projectId) fail(409, "S8_CLAIM_FENCED");
    this.command({ kind: "claimQueued", action: "heartbeat", projectId: linked.projectId, jobId, artifactId: linked.artifactId }, (state) => {
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
    const artifactSnapshot = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === snapshot.artifactId);
    if (!artifactSnapshot || artifactSnapshot.jobId !== snapshot.jobId) fail(500, "S8_PERSISTENCE_INVALID");
    const claimToken = this.uuid();
    const claimed = this.command({ kind: "claimQueued", action: "claim", projectId: snapshot.projectId, jobId, artifactId: snapshot.artifactId }, (state) => {
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
      if (this.objects.exists(to)) {
        if (!this.objects.read(to).equals(expected)) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      } else {
        this.objects.putExact(to, expected);
      }
    }
  }

  private reconcilePreparedAttempt(jobId: UUID, attemptId: UUID): void {
    const snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot) fail(404, "S8_UNAUTHORIZED_OR_NOT_FOUND", "job");
    const at = this.clock();
    this.command({ kind: "reconcilePreparedAttempt", projectId: snapshot.projectId, jobId, artifactId: snapshot.artifactId }, (state) => {
      const attempt = (state.s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
      if (!attempt || attempt.state !== "DISPATCHING" || attempt.jobId !== jobId) fail(409, "S8_PROOF_REQUIRED");
      attempt.state = "UNKNOWN"; attempt.failureClass = "UNCERTAIN"; attempt.failureCode = "RECONCILIATION_REQUIRED";
      attempt.disposalState = "UNKNOWN"; attempt.updatedAt = at; attempt.completedAt = at;
    });
    this.nativeOperations.delete(attemptId);
  }

  private persistVerifiedNativeFailure(job: S8ExportJob, attemptId: UUID, data: S8NativeVerifiedFailureData): void {
    const operation = this.nativeOperations.get(attemptId);
    const config = this.nativeWorkerConfig;
    if (!operation || !config || data.operation === "WRITER" && data.response.body.operation !== "WRITER" ||
        data.operation === "VALIDATOR" && data.response.body.operation !== "VALIDATOR" ||
        data.response.body.requestSha256 !== data.requestSha256 || data.responseSha256 !== sha256(jcs(data.response)) ||
        data.response.body.exitClass === "EXIT_0" || data.response.body.disposalState !== "REAPED_REMOVED") fail(500, "S8_PROOF_REQUIRED");
    const attempt = (this.repository.state().s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
    if (!attempt || attempt.state !== "DISPATCHING" || attempt.requestSha256 !== data.requestSha256 || attempt.operation !== data.operation) fail(409, "S8_PROOF_REQUIRED");
    const start = nativeOperationStartEvidence(operation.clock);
    const transient = data.failureClass === "TRANSIENT";
    const finalized = finalizeS8NativeFailure(operation.clock, (acceptedAt, witness) => {
      if (!transient) return null;
      const binding: Record<string, unknown> = {};
      for (const key of ["attemptId", "projectId", "jobId", "artifactId", "claimToken", "attempt", "operation",
        "acceptedSourceDigest", "profile", "protocolVersion", "configSha256", "resourcePolicySha256",
        "operationStartedAtUnixMs", "deadlineUnixMs", "clockModelVersion", "processClockEpoch",
        "operationStartMonotonicNs", "inputSha256", "inputBytes", "requestSha256", "requestNonce",
        "releaseManifestSha256"] as const) binding[key] = attempt[key];
      const body = {
        schemaVersion: "s8-native-retry-evidence-v1", decisionId: this.uuid(), keyId: config.appSigningKeyId,
        attemptBindingSha256: sha256(jcs(binding)), responseSha256: data.responseSha256,
        responseObservedAtUnixMs: responseObservedAtUnixMs(start.operationStartedAtUnixMs, witness),
        failureAcceptedAtUnixMs: acceptedAt, clockWitness: witness,
        nativeOutcome: "TRANSIENT_INFRASTRUCTURE_FAILURE", disposalState: "REAPED_REMOVED",
      };
      return signRetryEvidence(config, body);
    });
    const failureAt = new Date(finalized.acceptedAtUnixMs).toISOString();
    const retryEvidence = finalized.event;
    this.command({ kind: "persistNativeFailure", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
      const current = (state.s8NativeOperationAttempts ?? []).find((item) => item.attemptId === attemptId) as Record<string, unknown> | undefined;
      if (!current || current.state !== "DISPATCHING" || current.requestSha256 !== data.requestSha256) fail(409, "S8_PROOF_REQUIRED");
      current.state = "FAILED"; current.responseSha256 = data.responseSha256; current.signedResponse = data.response;
      current.failureClass = data.failureClass; current.failureCode = transient ? "TRANSIENT_INFRASTRUCTURE" : "NATIVE_OR_RESOURCE";
      current.retryEvidence = retryEvidence; current.disposalState = "REAPED_REMOVED";
      current.updatedAt = failureAt; current.completedAt = failureAt;
    });
    this.nativeOperations.delete(attemptId);
  }

  private scheduleNativeRetry(jobId: UUID, claimToken: UUID): boolean {
    const snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot || snapshot.attempt !== 1 || snapshot.claimToken !== claimToken || snapshot.ownerId !== this.ownerId ||
        snapshot.ownerProcessId !== this.processId || !["running", "staged"].includes(snapshot.status)) return false;
    this.requireCurrentSource(snapshot.projectId, snapshot.source);
    const attempt = ((this.repository.state().s8NativeOperationAttempts ?? []) as unknown as Record<string, unknown>[]).find((item) =>
      item.jobId === jobId && item.attempt === 1 && item.state === "FAILED" && item.failureClass === "TRANSIENT" && item.retryEvidence !== null) as Record<string, unknown> | undefined;
    const evidence = attempt?.retryEvidence as { body?: { decisionId?: unknown } } | null | undefined;
    if (typeof evidence?.body?.decisionId !== "string" || !uuidV4Pattern.test(evidence.body.decisionId)) return false;
    const at = this.clock();
    this.command({ kind: "scheduleRetry", projectId: snapshot.projectId, jobId, artifactId: snapshot.artifactId }, (state) => {
      const job = (state.s8ExportJobs ?? []).find((item) => item.jobId === jobId) as S8ExportJobV3 | undefined;
      const artifact = job ? (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined : undefined;
      if (!job || !artifact || job.status !== snapshot.status || job.attempt !== 1 || job.claimToken !== claimToken ||
          job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId || !sameS8Source(job.source, snapshot.source)) fail(409, "S8_CLAIM_FENCED");
      job.attempt = 2; job.status = "failed_retryable"; job.publicationPhase = "source_admission";
      job.failureCode = "S8_NATIVE_TRANSIENT_FAILURE"; job.retryDecisionId = evidence.body!.decisionId as UUID;
      job.claimToken = null; job.nativeClaimToken = null; job.ownerId = null; job.ownerProcessId = null;
      job.claimedAt = null; job.heartbeatAt = null; job.headCheckpointSha256 = null; job.terminalAt = at; job.updatedAt = at;
      artifact.attempt = 2; artifact.status = "failed_retryable"; artifact.publicationPhase = "source_admission";
      artifact.failureCode = "S8_NATIVE_TRANSIENT_FAILURE"; artifact.payloadSha256 = null; artifact.objectHashes = null;
      artifact.writerReceiptHash = null; artifact.nativeReadbackHash = null; artifact.semanticReceiptHash = null;
      artifact.publicationReceiptHash = null; artifact.validationReceiptId = null; artifact.validationReceiptHash = null;
      artifact.immutableReuseFingerprint = null; artifact.privateStagingPrefix = s8StagingPrefix(artifact.projectId, artifact.artifactId, "unclaimed");
      artifact.privateFinalPrefix = s8FinalPrefix(artifact.projectId, artifact.source.sourceRevisionHash, "0".repeat(64));
      artifact.headCheckpointSha256 = null; artifact.updatedAt = at;
    });
    return true;
  }

  private markFailure(jobId: UUID, claimToken: UUID | null, error: unknown, activeAttemptId?: UUID | null): "retry" | void {
    let code = error instanceof AppError ? error.code : "S8_PUBLICATION_FAILED";
    let snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot) return;
    const attempts = this.repository.state().s8NativeOperationAttempts ?? [];
    const active = activeAttemptId ? attempts.find((item) => item.attemptId === activeAttemptId) :
      attempts.find((item) => item.jobId === jobId && item.attempt === snapshot!.attempt && item.state === "DISPATCHING");
    if (active && active.state === "DISPATCHING") {
      const operation = this.nativeOperations.get(String(active.attemptId));
      let persistedFailure = false;
      if (operation && isRegisteredS8NativeWorkerClient(this.nativeWorkerClient)) {
        try {
          const verifiedFailure = this.nativeWorkerClient.consumeVerifiedFailure(error, active.operation as "WRITER" | "VALIDATOR", operation.context, operation.clock);
          this.persistVerifiedNativeFailure(snapshot, active.attemptId as UUID, verifiedFailure);
          persistedFailure = true;
        } catch {
          persistedFailure = false;
        }
      }
      if (!persistedFailure) {
        const current = (this.repository.state().s8NativeOperationAttempts ?? []).find((item) => item.attemptId === active.attemptId);
        if (current?.state === "DISPATCHING") {
          this.reconcilePreparedAttempt(jobId, active.attemptId as UUID);
          if (code !== "S8_SOURCE_STALE" && code !== "S8_SOURCE_NOT_READY") {
            code = "S8_NATIVE_RECONCILIATION_REQUIRED";
          }
        }
      }
      snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
      if (!snapshot) return;
      const durableAttempt = (this.repository.state().s8NativeOperationAttempts ?? []).find((item) => item.attemptId === active.attemptId) as Record<string, unknown> | undefined;
      if (persistedFailure && durableAttempt?.failureClass === "TRANSIENT" && claimToken !== null && snapshot.attempt === 1) {
        try { if (this.scheduleNativeRetry(jobId, claimToken)) return "retry"; }
        catch (retryError) { code = retryError instanceof AppError ? retryError.code : "S8_NATIVE_RECONCILIATION_REQUIRED"; }
      }
    }
    snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot) return;
    const at = this.clock();
    this.command({ kind: "recordTerminalFailure", projectId: snapshot.projectId, jobId, artifactId: snapshot.artifactId }, (state) => {
      const job = (state.s8ExportJobs ?? []).find((item) => item.jobId === jobId) as S8ExportJobV3 | undefined;
      const artifact = job ? (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined : undefined;
      if (!job || !artifact || claimToken !== null && (job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId)) fail(409, "S8_CLAIM_FENCED");
      job.failureCode = code; artifact.failureCode = code; job.updatedAt = at; artifact.updatedAt = at;
    });
  }

  private requirePrefix(prefix: string | null): string {
    if (typeof prefix !== "string" || prefix.length === 0) fail(500, "S8_PERSISTENCE_INVALID");
    return prefix;
  }
  private cleanupStaging(prefix: string): void {
    for (const name of S8_OBJECT_NAMES) this.objects.remove(s8ObjectKey(prefix, name));
  }

  private verifyPublishedObjects(artifact: S8Artifact): Map<S8ObjectName, Buffer> {
    if (!artifact.objectHashes || artifact.objectHashes.publicationReceiptSha256 === null) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    const expected: Record<S8ObjectName, string> = { "artifact.fbx": artifact.objectHashes.artifactSha256, "writer-receipt.json": artifact.objectHashes.writerReceiptSha256, "native-readback.json": artifact.objectHashes.nativeReadbackSha256, "semantic-validation-receipt.json": artifact.objectHashes.semanticReceiptSha256, "publication-receipt.json": artifact.objectHashes.publicationReceiptSha256 };
    const result = new Map<S8ObjectName, Buffer>();
    for (const name of S8_OBJECT_NAMES) {
      const bytes = this.objects.read(s8ObjectKey(this.requirePrefix(artifact.privateFinalPrefix), name));
      if ((name === "artifact.fbx" && bytes.length !== artifact.objectHashes.artifactByteSize) || s8Sha256(bytes) !== expected[name]) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      result.set(name, bytes);
    }
    return result;
  }

  private verifyReuse(projectId: UUID, projection: S8ProofProjection): Buffer {
    if (projection.lifecycle() !== "committed" || projection.sourceDisposition() !== "CURRENT") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    const artifact = projection.applicationArtifact() as unknown as S8Artifact;
    if (artifact.projectId !== projectId || artifact.status !== "committed" || artifact.publicationPhase !== "commit" ||
        !projection.validationReceipt()) fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    return this.verifyPublishedObjects(artifact).get("artifact.fbx")!;
  }

  private projectedResult(projectId: UUID, artifactId: UUID, replayed: boolean): S8ExportResult {
    const projection = this.repository.readS8(projectId, artifactId);
    if (projection.lifecycle() === "committed") this.verifyReuse(projectId, projection);
    const artifact = projection.publicArtifact() as S8PublicArtifact;
    const job = projection.publicJob() as unknown as S8ExportJob;
    return { replayed, export: artifact, job: { jobId: job.jobId, status: job.status, attempt: job.attempt } };
  }

  private commit(jobId: UUID, claimToken: UUID, source: S8SourceStamp): void {
    this.requireCurrentSource(source.projectId, source);
    const snapshot = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === jobId);
    if (!snapshot || snapshot.claimToken !== claimToken || snapshot.ownerId !== this.ownerId || snapshot.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
    const promoted = this.repository.readS8(source.projectId, snapshot.artifactId);
    if (promoted.lifecycle() !== "promoted" || promoted.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
    this.verifyPublishedObjects(promoted.applicationArtifact() as unknown as S8Artifact);
    const at = this.clock();
    this.command({ kind: "commitPromoted", projectId: source.projectId, jobId, artifactId: snapshot.artifactId }, (state) => {
      const job = (state.s8ExportJobs ?? []).find((item) => item.jobId === jobId) as S8ExportJobV3 | undefined;
      const artifact = job ? (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined : undefined;
      if (!job || !artifact || job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId || job.status !== "promoted") fail(409, "S8_CLAIM_FENCED");
      job.updatedAt = at; artifact.updatedAt = at;
    });
    const committed = this.repository.readS8(source.projectId, snapshot.artifactId);
    if (committed.lifecycle() !== "committed" || committed.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
    this.verifyPublishedObjects(committed.applicationArtifact() as unknown as S8Artifact);
  }

  private async runClaimedExport(jobId: UUID): Promise<void> {
    let claimToken: UUID | null = null;
    let activeAttemptId: UUID | null = null;
    try {
      const claimed = this.claim(jobId);
      if (!claimed.acquired || !claimed.claimToken) return;
      const activeClaimToken = claimed.claimToken;
      claimToken = activeClaimToken;
      const { job, source } = claimed;
      const payload = source.prepared;
      const heartbeat = () => this.updateHeartbeat(job.jobId, activeClaimToken, job.source);
      heartbeat();
      const client = this.requireNativeWorker();

      const writerStart = this.beginNativeAttempt(job, "WRITER", payload.bytes);
      activeAttemptId = writerStart.attemptId;
      const writerCapability = await client.runWriter(payload.bytes, writerStart.context, heartbeat, writerStart.clock,
        (requestSha256, requestNonce, releaseHash, _deadline, clock, request) =>
          this.prepareNativeAttempt(job, writerStart.attemptId, requestSha256, requestNonce, releaseHash, clock, request));
      const writerData = client.consumeVerifiedResult(writerCapability, "WRITER", writerStart.context, writerStart.clock);
      this.persistNativeAcceptance(job, writerStart.attemptId, writerStart.clock, writerData);
      activeAttemptId = null;

      const writerReceiptBytes = Buffer.from(writerData.auxiliary);
      const writerReceipt = parseJson(writerReceiptBytes, "S8_WRITER_RECEIPT_INVALID");
      if (!Buffer.from(jcs(writerReceipt), "utf8").equals(writerReceiptBytes)) fail(422, "S8_WRITER_RECEIPT_INVALID");
      this.validateWriterReceipt(writerReceipt, payload.sha256, writerData.output);
      assertRunnerEvidence(writerData.runnerEvidence, expectedWriter());
      const writerRecord = this.repository.state().s8NativeOperationAttempts!.find((item) => item.attemptId === writerStart.attemptId) as unknown as Record<string, unknown>;
      const writerAcceptance = writerRecord.acceptanceReceipt as { body: Record<string, unknown>; receiptSha256: string };
      if (writerAcceptance.body.outputSha256 !== s8Sha256(writerData.output) ||
          writerAcceptance.body.outputBytes !== writerData.output.byteLength ||
          writerAcceptance.body.auxiliarySha256 !== s8Sha256(writerReceiptBytes) ||
          writerAcceptance.body.auxiliaryBytes !== writerReceiptBytes.byteLength) fail(409, "S8_PROOF_REQUIRED");

      const stagedArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      const stagingPrefix = this.requirePrefix(stagedArtifact?.privateStagingPrefix ?? null);
      this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([["artifact.fbx", writerData.output], ["writer-receipt.json", writerReceiptBytes]]));
      if (!this.objects.read(s8ObjectKey(stagingPrefix, "artifact.fbx")).equals(writerData.output) ||
          !this.objects.read(s8ObjectKey(stagingPrefix, "writer-receipt.json")).equals(writerReceiptBytes)) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      const stagedAt = this.clock();
      this.command({ kind: "stageAcceptedWriter", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
        const currentJob = (state.s8ExportJobs ?? []).find((item) => item.jobId === job.jobId) as S8ExportJobV3 | undefined;
        const artifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined;
        if (!currentJob || !artifact || currentJob.claimToken !== activeClaimToken ||
            currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
        artifact.payloadSha256 = payload.sha256;
        currentJob.updatedAt = stagedAt; currentJob.heartbeatAt = stagedAt; artifact.updatedAt = stagedAt;
      });
      this.emit("private_staging", job.projectId, job.jobId, job.artifactId);

      const currentJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === job.jobId);
      if (!currentJob) fail(500, "S8_PERSISTENCE_INVALID");
      const validationInput = this.objects.read(s8ObjectKey(stagingPrefix, "artifact.fbx"));
      if (validationInput.byteLength !== writerAcceptance.body.outputBytes ||
          s8Sha256(validationInput) !== writerAcceptance.body.outputSha256) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      const releaseHandle = writerAcceptance.body.releaseHandle;
      if (!canonicalNonceValue(releaseHandle)) fail(409, "S8_PROOF_REQUIRED");
      const validatorStart = this.beginNativeAttempt(currentJob, "VALIDATOR", validationInput);
      activeAttemptId = validatorStart.attemptId;
      const validatorCapability = await client.runValidator(validationInput, validatorStart.context, releaseHandle, heartbeat,
        validatorStart.clock, String(writerAcceptance.body.releaseManifestSha256),
        (requestSha256, requestNonce, releaseHash, _deadline, clock, request) =>
          this.prepareNativeAttempt(currentJob, validatorStart.attemptId, requestSha256, requestNonce, releaseHash, clock, request));
      const validatorData = client.consumeVerifiedResult(validatorCapability, "VALIDATOR", validatorStart.context, validatorStart.clock);
      this.persistNativeAcceptance(currentJob, validatorStart.attemptId, validatorStart.clock, validatorData);
      activeAttemptId = null;
      assertRunnerEvidence(validatorData.runnerEvidence, expectedValidator());
      if (!validatorData.validatorIdentity || validatorData.auxiliary.byteLength !== 0) fail(422, "S8_PROCESS_RUNNER_EVIDENCE_INVALID");
      const nativeReadbackBytes = Buffer.from(validatorData.output);
      if (nativeReadbackBytes.length === 0 || nativeReadbackBytes.length > S8_LIMITS.readbackBytes) fail(422, "S8_NATIVE_READBACK_LIMIT");
      const parsedReadback = parseJson(nativeReadbackBytes, "S8_NATIVE_READBACK_INVALID");
      if (parsedReadback.schemaVersion !== "s8-ufbx-readback-v1" ||
          !Buffer.from(jcs(parsedReadback), "utf8").equals(nativeReadbackBytes)) fail(422, "S8_NATIVE_READBACK_INVALID");
      const admittedReadback = parsedReadback as unknown as S8UfbxReadback;
      assertS8ReadbackProvenance(source.s6, admittedReadback);
      const semantic = compareS8UfbxReadback(source.s6, source.s7, admittedReadback);
      if (semantic.outcome !== "pass") fail(422, "S8_SEMANTIC_VALIDATION_FAILED");
      const semanticBytes = jsonBytes({ schemaVersion: "s8-semantic-validation-receipt-v2", source: job.source,
        outcome: semantic.outcome, result: semantic }, S8_LIMITS.readbackBytes, "S8_SEMANTIC_RECEIPT_LIMIT");
      this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([
        ["native-readback.json", nativeReadbackBytes], ["semantic-validation-receipt.json", semanticBytes],
      ]));
      for (const [name, expectedBytes] of [
        ["artifact.fbx", validationInput], ["writer-receipt.json", writerReceiptBytes],
        ["native-readback.json", nativeReadbackBytes], ["semantic-validation-receipt.json", semanticBytes],
      ] as const) {
        if (!this.objects.read(s8ObjectKey(stagingPrefix, name)).equals(expectedBytes)) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      }

      const durable = this.repository.state();
      const writerAttempt = durable.s8NativeOperationAttempts!.find((item) => item.attemptId === writerStart.attemptId) as unknown as Record<string, unknown>;
      const validatorAttempt = durable.s8NativeOperationAttempts!.find((item) => item.attemptId === validatorStart.attemptId) as unknown as Record<string, unknown>;
      const durableWriterAcceptance = writerAttempt.acceptanceReceipt as { body: Record<string, unknown>; receiptSha256: string };
      const validatorAcceptance = validatorAttempt.acceptanceReceipt as { body: Record<string, unknown>; receiptSha256: string };
      const stagedProjection = this.repository.readS8(job.projectId, job.artifactId);
      if (stagedProjection.lifecycle() !== "staged" || stagedProjection.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
      const stagedCheckpointSha256 = stagedProjection.applicationArtifact().headCheckpointSha256;
      if (!hashValue(stagedCheckpointSha256)) fail(409, "S8_PROOF_REQUIRED");

      const artifactSha256 = s8Sha256(writerData.output);
      const writerReceiptHash = s8Sha256(writerReceiptBytes);
      const nativeReadbackHash = s8Sha256(nativeReadbackBytes);
      const semanticReceiptHash = s8Sha256(semanticBytes);
      const checkedAt = this.clock();
      const resourceLimitsHash = s8ResourceLimitsHash(S8_RESOURCE_TABLE);
      const releaseManifestSha256 = durableWriterAcceptance.body.releaseManifestSha256;
      const resourcePolicySha256 = durableWriterAcceptance.body.resourcePolicySha256;
      if (!hashValue(releaseManifestSha256) || !hashValue(resourcePolicySha256)) fail(409, "S8_PROOF_REQUIRED");
      const fingerprintVersion = "s8-immutable-reuse-fingerprint-v3" as const;
      const fingerprintBody = {
        fingerprintVersion, source: job.source, payloadSha256: payload.sha256,
        writerAcceptanceSha256: durableWriterAcceptance.receiptSha256,
        validatorAcceptanceSha256: validatorAcceptance.receiptSha256,
        releaseManifestSha256: durableWriterAcceptance.body.releaseManifestSha256,
        resourcePolicySha256: durableWriterAcceptance.body.resourcePolicySha256,
        resourceLimitsHash, artifactSha256, artifactByteSize: writerData.output.byteLength,
        writerReceiptHash, writerReceiptBytes: writerReceiptBytes.byteLength,
        nativeReadbackHash, nativeReadbackBytes: nativeReadbackBytes.byteLength,
        semanticReceiptHash, semanticReceiptBytes: semanticBytes.byteLength,
      };
      const fingerprint = sha256(jcs(fingerprintBody));
      const receiptBody: Omit<S8ValidationReceiptV3, "receiptHash"> = {
        schemaVersion: "s8-validation-receipt-v3", receiptId: this.uuid(), projectId: job.projectId, jobId: job.jobId,
        artifactId: job.artifactId, attempt: job.attempt, nativeClaimToken: currentJob.nativeClaimToken!, source: job.source,
        acceptedSourceDigest: sha256(jcs(job.source)), payloadSha256: payload.sha256, artifactSha256,
        artifactByteSize: writerData.output.byteLength, writerReceiptHash, writerReceiptBytes: writerReceiptBytes.byteLength,
        nativeReadbackHash, nativeReadbackBytes: nativeReadbackBytes.byteLength, semanticReceiptHash,
        semanticReceiptBytes: semanticBytes.byteLength, nativeOutcome: "pass", semanticOutcome: "pass", fingerprintVersion,
        immutableReuseFingerprint: fingerprint, resourceLimitsHash, checkedAt,
        writerAttemptId: writerStart.attemptId, writerAcceptanceSha256: durableWriterAcceptance.receiptSha256,
        validatorAttemptId: validatorStart.attemptId, validatorAcceptanceSha256: validatorAcceptance.receiptSha256,
        stagedCheckpointSha256, releaseManifestSha256, resourcePolicySha256,
      };
      const validationReceipt: S8ValidationReceiptV3 = { ...receiptBody, receiptHash: sha256(jcs(receiptBody)) };
      const validationReceiptBytes = Buffer.from(jcs(validationReceipt), "utf8");
      const validationReceiptByteRecord: S8ValidationReceiptBytesV1 = {
        schemaVersion: "s8-validation-receipt-bytes-v1", receiptId: validationReceipt.receiptId,
        canonicalBase64url: validationReceiptBytes.toString("base64url"), byteSize: validationReceiptBytes.byteLength,
        sha256: s8Sha256(validationReceiptBytes),
      };
      const validAt = this.clock();
      this.requireCurrentSource(job.projectId, job.source);
      this.emit("source_claim_recheck", job.projectId, job.jobId, job.artifactId);
      this.requireCurrentSource(job.projectId, job.source);
      this.command({ kind: "validateAcceptedPair", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
        const currentJob = (state.s8ExportJobs ?? []).find((item) => item.jobId === job.jobId) as S8ExportJobV3 | undefined;
        const artifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined;
        if (!currentJob || !artifact || currentJob.claimToken !== activeClaimToken ||
            currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId ||
            currentJob.status !== "staged") fail(409, "S8_CLAIM_FENCED");
        state.s8ValidationReceipts ??= []; state.s8ValidationReceiptBytes ??= [];
        if (state.s8ValidationReceipts.some((item) => item.receiptId === validationReceipt.receiptId)) fail(500, "S8_PERSISTENCE_INVALID");
        artifact.payloadSha256 = payload.sha256;
        artifact.objectHashes = {
          artifactSha256, artifactByteSize: writerData.output.byteLength, writerReceiptSha256: writerReceiptHash,
          nativeReadbackSha256: nativeReadbackHash, semanticReceiptSha256: semanticReceiptHash, publicationReceiptSha256: null,
        };
        artifact.writerReceiptHash = writerReceiptHash; artifact.nativeReadbackHash = nativeReadbackHash;
        artifact.semanticReceiptHash = semanticReceiptHash; artifact.publicationReceiptHash = null;
        artifact.validationReceiptId = validationReceipt.receiptId as UUID;
        artifact.validationReceiptHash = validationReceipt.receiptHash as string;
        artifact.immutableReuseFingerprint = fingerprint;
        currentJob.updatedAt = validAt; currentJob.heartbeatAt = validAt; artifact.updatedAt = validAt;
        state.s8ValidationReceipts.push(validationReceipt);
        state.s8ValidationReceiptBytes.push(validationReceiptByteRecord);
      });
      this.emit("independent_validation", job.projectId, job.jobId, job.artifactId);

      this.requireCurrentSource(job.projectId, job.source);
      const publicationJob = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === job.jobId);
      if (!publicationJob || publicationJob.claimToken !== activeClaimToken || !publicationJob.nativeClaimToken ||
          publicationJob.ownerId !== this.ownerId || publicationJob.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
      const publicationClaim = {
        claimToken: activeClaimToken, ownerId: this.ownerId, ownerProcessId: this.processId,
        claimedAt: publicationJob.claimedAt,
      };
      const finalRoot = "private/projects/" + job.projectId + "/s8/committed/" + job.source.sourceRevisionHash;
      const finalBase = finalRoot + "/" + artifactSha256 + "/" + job.artifactId + "/" + job.attempt + "/" + activeClaimToken;
      const finalObjectRefs = [
        { name: "artifact.fbx", contentType: "application/octet-stream", key: finalBase + "/artifact.fbx", sha256: artifactSha256, byteSize: writerData.output.byteLength },
        { name: "writer-receipt.json", contentType: "application/json", key: finalBase + "/writer-receipt.json", sha256: writerReceiptHash, byteSize: writerReceiptBytes.byteLength },
        { name: "native-readback.json", contentType: "application/json", key: finalBase + "/native-readback.json", sha256: nativeReadbackHash, byteSize: nativeReadbackBytes.byteLength },
        { name: "semantic-validation-receipt.json", contentType: "application/json", key: finalBase + "/semantic-validation-receipt.json", sha256: semanticReceiptHash, byteSize: semanticBytes.byteLength },
      ];
      const validatedArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      if (!validatedArtifact?.headCheckpointSha256) fail(409, "S8_PROOF_REQUIRED");
      const publicationBody = {
        schemaVersion: "s8-publication-receipt-v3", projectId: job.projectId, jobId: job.jobId,
        artifactId: job.artifactId, attempt: job.attempt, nativeClaimToken: publicationJob.nativeClaimToken,
        publicationClaim, source: job.source, validatedCheckpointSha256: validatedArtifact.headCheckpointSha256,
        writerAcceptanceSha256: durableWriterAcceptance.receiptSha256,
        validatorAcceptanceSha256: validatorAcceptance.receiptSha256,
        validationReceiptId: validationReceipt.receiptId, validationReceiptHash: validationReceipt.receiptHash,
        immutableReuseFingerprint: fingerprint, finalPrefix: finalBase, objects: finalObjectRefs,
        createdAt: checkedAt, complete: true,
      };
      const publicationBytes = jsonBytes(publicationBody, S8_LIMITS.readbackBytes, "S8_PUBLICATION_RECEIPT_LIMIT");
      const publicationReceiptHash = s8Sha256(publicationBytes);
      const objectHashes = {
        artifactSha256, artifactByteSize: writerData.output.byteLength, writerReceiptSha256: writerReceiptHash,
        nativeReadbackSha256: nativeReadbackHash, semanticReceiptSha256: semanticReceiptHash, publicationReceiptSha256: publicationReceiptHash,
      };
      const promotingAt = this.clock();
      const currentArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === job.artifactId);
      const currentStagingPrefix = this.requirePrefix(currentArtifact?.privateStagingPrefix ?? null);
      this.stage(currentStagingPrefix, new Map<S8ObjectName, Buffer>([["publication-receipt.json", publicationBytes]]));
      this.emit("immutable_promotion", job.projectId, job.jobId, job.artifactId);
      this.requireCurrentSource(job.projectId, job.source);
      this.promote(currentStagingPrefix, finalBase);
      this.command({ kind: "promoteValidated", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
        const currentJob = (state.s8ExportJobs ?? []).find((item) => item.jobId === job.jobId) as S8ExportJobV3 | undefined;
        const artifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined;
        if (!currentJob || !artifact || currentJob.claimToken !== activeClaimToken ||
            currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId ||
            currentJob.status !== "validated") fail(409, "S8_CLAIM_FENCED");
        currentJob.updatedAt = promotingAt; currentJob.heartbeatAt = promotingAt;
        artifact.privateFinalPrefix = finalBase; artifact.objectHashes = objectHashes;
        artifact.publicationReceiptHash = publicationReceiptHash; artifact.updatedAt = promotingAt;
      });
      const promoted = this.repository.readS8(job.projectId, job.artifactId);
      if (promoted.lifecycle() !== "promoted" || promoted.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
      this.verifyPublishedObjects(promoted.applicationArtifact() as unknown as S8Artifact);
      this.emit("verified_readback", job.projectId, job.jobId, job.artifactId);
      this.requireCurrentSource(job.projectId, job.source);
      this.commit(job.jobId, activeClaimToken, job.source);
      this.emit("commit", job.projectId, job.jobId, job.artifactId);
      this.cleanupStaging(currentStagingPrefix);
    } catch (error) {
      const outcome = claimToken !== null ? this.markFailure(jobId, claimToken, error, activeAttemptId) : undefined;
      if (outcome === "retry") return this.runClaimedExport(jobId);
      throw error;
    }
  }
  private createRecords(projectId: UUID, idempotencyKey: string, source: S8SourceStamp, inputHash: string): { job: S8ExportJob; artifact: S8Artifact; idempotency: S8IdempotencyRecord } {
    const at = this.clock(); const jobId = this.uuid(); const artifactId = this.uuid(); const pendingHash = "0".repeat(64);
    const artifact: S8ArtifactV3 = { schemaVersion: "s8-artifact-v3", artifactId, projectId, jobId, source, inputHash, profile: S8_FBX_PROFILE, format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx", status: "queued", publicationPhase: "source_admission", payloadSha256: null, objectHashes: null, writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null, validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null, privateStagingPrefix: s8StagingPrefix(projectId, artifactId, "unclaimed"), privateFinalPrefix: s8FinalPrefix(projectId, source.sourceRevisionHash, pendingHash), attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: at, updatedAt: at, committedAt: null, staleAt: null, headCheckpointSha256: null, terminalOutcomeId: null, quarantineId: null };
    const job: S8ExportJobV3 = { schemaVersion: "s8-export-job-v3", jobId, projectId, artifactId, source, inputHash, idempotencyKey, status: "queued", publicationPhase: "source_admission", attempt: 1, claimToken: null, ownerId: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null, createdAt: at, updatedAt: at, terminalAt: null, failureCode: null, nativeClaimToken: null, headCheckpointSha256: null, terminalOutcomeId: null, quarantineId: null, retryDecisionId: null };
    const idempotency: S8IdempotencyRecord = { schemaVersion: "s8-idempotency-v2", projectId, operation: "export", idempotencyKey, inputHash, source, jobId, artifactId, createdAt: at };
    return { job, artifact, idempotency };
  }

  async createExport(projectId: UUID, idempotencyKey: string, requestReferenceId?: UUID): Promise<S8ExportResult> {
    assertOpaqueKey(idempotencyKey); assertReference(requestReferenceId);
    const admitted = this.admitSource(projectId);
    const inputHash = admitted.prepared.sha256;
    const existing = getS8Collections(this.repository.state()).idempotency.find((item) => item.projectId === projectId && item.operation === "export" && item.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.inputHash !== inputHash || !sameS8Source(existing.source, admitted.source)) fail(409, "S8_IDEMPOTENCY_CONFLICT", "Idempotency-Key");
      const job = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === existing.jobId);
      const artifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === existing.artifactId);
      if (!job || !artifact || job.artifactId !== artifact.artifactId || artifact.jobId !== job.jobId || artifact.status !== job.status) fail(500, "S8_PERSISTENCE_INVALID");
      if (artifact.status === "queued") {
        await this.runClaimedExport(job.jobId);
      }
      return this.projectedResult(projectId, artifact.artifactId, true);
    }

    const records = this.createRecords(projectId, idempotencyKey, admitted.source, inputHash);
    try {
      this.emitAdmission(projectId, records.job.jobId, records.artifact.artifactId, admitted.source);
      const admission = this.command({ kind: "createQueued", projectId, jobId: records.job.jobId, artifactId: records.artifact.artifactId }, (state) => {
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
        if (artifact.status === "queued") await this.runClaimedExport(job.jobId);
        return this.projectedResult(projectId, artifact.artifactId, true);
      }
    } catch (error) {
      this.markFailure(records.job.jobId, null, error);
      throw error;
    }
    await this.runClaimedExport(records.job.jobId);
    return this.projectedResult(projectId, records.artifact.artifactId, false);
  }

  getHandoff(projectId: UUID): S8PreparedExport & { source: S8SourceStamp } {
    const value = this.admitSource(projectId);
    return { profile: S8_FBX_PROFILE, semanticVersion: S8_SEMANTIC_VERSION, sourceRevisionId: value.s6.acceptedRevisionId, sourceRevisionHash: value.s6.acceptedRevisionHash, objectNames: value.prepared.payload.objects.map((item) => item.name), payloadBytes: value.prepared.bytes, payloadSha256: value.prepared.sha256, source: value.source };
  }

  getExport(projectId: UUID, artifactId: UUID): S8PublicArtifact {
    const projection = this.repository.readS8(projectId, artifactId);
    if (projection.sourceDisposition() === "NOT_READY") fail(409, "S8_SOURCE_NOT_READY", "source");
    if (projection.sourceDisposition() === "STALE") fail(409, "S8_SOURCE_STALE", "source");
    if (projection.lifecycle() === "committed") this.verifyReuse(projectId, projection);
    return projection.publicArtifact() as S8PublicArtifact;
  }

  download(projectId: UUID, artifactId: UUID): S8DownloadResult {
    const projection = this.repository.readS8(projectId, artifactId);
    if (projection.lifecycle() !== "committed" || projection.sourceDisposition() !== "CURRENT") fail(409, "S8_REUSE_FINGERPRINT_INVALID");
    const bytes = this.verifyReuse(projectId, projection);
    return { bytes, contentType: "application/octet-stream", fileName: "swooshz-s8-scene.fbx" };
  }

  private promoteValidated(jobId: UUID, claimToken: UUID): void {
    const collections = getS8Collections(this.repository.state());
    const job = collections.jobs.find((item) => item.jobId === jobId) as S8ExportJobV3 | undefined;
    const artifact = job ? collections.artifacts.find((item) => item.artifactId === job.artifactId) as S8ArtifactV3 | undefined : undefined;
    if (!job || !artifact || job.status !== "validated" || artifact.status !== "validated" ||
        job.claimToken !== claimToken || job.ownerId !== this.ownerId || job.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
    const projection = this.repository.readS8(job.projectId, artifact.artifactId);
    if (projection.lifecycle() !== "validated" || projection.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
    this.requireCurrentSource(job.projectId, job.source);
    const validationReceipt = projection.validationReceipt() as S8ValidationReceiptV3 | null;
    const nativeAttempts = this.repository.state().s8NativeOperationAttempts ?? [];
    const writer = nativeAttempts.find((item) => item.jobId === jobId && item.attempt === job.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
    const validator = nativeAttempts.find((item) => item.jobId === jobId && item.attempt === job.attempt && item.operation === "VALIDATOR") as Record<string, unknown> | undefined;
    const writerAcceptance = writer?.acceptanceReceipt as { body?: Record<string, unknown>; receiptSha256?: string } | null | undefined;
    const validatorAcceptance = validator?.acceptanceReceipt as { body?: Record<string, unknown>; receiptSha256?: string } | null | undefined;
    if (!validationReceipt || !writer || writer.state !== "SUCCEEDED" || !writerAcceptance?.body || !writerAcceptance.receiptSha256 ||
        !validator || validator.state !== "SUCCEEDED" || !validatorAcceptance?.body || !validatorAcceptance.receiptSha256 ||
        !artifact.headCheckpointSha256) fail(409, "S8_PROOF_REQUIRED");
    const stagingPrefix = this.requirePrefix(artifact.privateStagingPrefix);
    const staged = new Map<S8ObjectName, Buffer>();
    const stagedExpected: ReadonlyArray<readonly [S8ObjectName, string, number]> = [
      ["artifact.fbx", validationReceipt.artifactSha256, validationReceipt.artifactByteSize],
      ["writer-receipt.json", validationReceipt.writerReceiptHash, validationReceipt.writerReceiptBytes],
      ["native-readback.json", validationReceipt.nativeReadbackHash, validationReceipt.nativeReadbackBytes],
      ["semantic-validation-receipt.json", validationReceipt.semanticReceiptHash, validationReceipt.semanticReceiptBytes],
    ];
    for (const [name, expectedHash, expectedBytes] of stagedExpected) {
      const bytes = this.objects.read(s8ObjectKey(stagingPrefix, name));
      if (bytes.byteLength !== expectedBytes || s8Sha256(bytes) !== expectedHash) fail(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      staged.set(name, bytes);
    }
    const publicationClaim = { claimToken, ownerId: this.ownerId, ownerProcessId: this.processId, claimedAt: job.claimedAt };
    if (!publicationClaim.claimedAt) fail(409, "S8_CLAIM_FENCED");
    const finalRoot = `private/projects/${job.projectId}/s8/committed/${job.source.sourceRevisionHash}`;
    const finalBase = `${finalRoot}/${validationReceipt.artifactSha256}/${artifact.artifactId}/${artifact.attempt}/${claimToken}`;
    const finalObjectRefs = stagedExpected.map(([name, hash, byteSize]) => ({
      name, contentType: name === "artifact.fbx" ? "application/octet-stream" : "application/json",
      key: `${finalBase}/${name}`, sha256: hash, byteSize,
    }));
    const checkedAt = this.clock();
    const publicationBody = {
      schemaVersion: "s8-publication-receipt-v3", projectId: job.projectId, jobId: job.jobId,
      artifactId: artifact.artifactId, attempt: artifact.attempt, nativeClaimToken: job.nativeClaimToken,
      publicationClaim, source: job.source, validatedCheckpointSha256: artifact.headCheckpointSha256,
      writerAcceptanceSha256: writerAcceptance.receiptSha256, validatorAcceptanceSha256: validatorAcceptance.receiptSha256,
      validationReceiptId: validationReceipt.receiptId, validationReceiptHash: validationReceipt.receiptHash,
      immutableReuseFingerprint: validationReceipt.immutableReuseFingerprint, finalPrefix: finalBase,
      objects: finalObjectRefs, createdAt: checkedAt, complete: true,
    };
    const publicationBytes = jsonBytes(publicationBody, S8_LIMITS.readbackBytes, "S8_PUBLICATION_RECEIPT_LIMIT");
    const publicationReceiptHash = s8Sha256(publicationBytes);
    const objectHashes = {
      artifactSha256: validationReceipt.artifactSha256, artifactByteSize: validationReceipt.artifactByteSize,
      writerReceiptSha256: validationReceipt.writerReceiptHash, nativeReadbackSha256: validationReceipt.nativeReadbackHash,
      semanticReceiptSha256: validationReceipt.semanticReceiptHash, publicationReceiptSha256: publicationReceiptHash,
    };
    this.stage(stagingPrefix, new Map<S8ObjectName, Buffer>([["publication-receipt.json", publicationBytes]]));
    this.emit("immutable_promotion", job.projectId, job.jobId, artifact.artifactId);
    this.requireCurrentSource(job.projectId, job.source);
    this.promote(stagingPrefix, finalBase);
    const promotingAt = this.clock();
    this.command({ kind: "promoteValidated", projectId: job.projectId, jobId, artifactId: artifact.artifactId }, (state) => {
      const currentJob = (state.s8ExportJobs ?? []).find((item) => item.jobId === jobId) as S8ExportJobV3 | undefined;
      const currentArtifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === artifact.artifactId) as S8ArtifactV3 | undefined;
      if (!currentJob || !currentArtifact || currentJob.status !== "validated" || currentJob.claimToken !== claimToken ||
          currentJob.ownerId !== this.ownerId || currentJob.ownerProcessId !== this.processId) fail(409, "S8_CLAIM_FENCED");
      currentJob.updatedAt = promotingAt; currentJob.heartbeatAt = promotingAt;
      currentArtifact.privateFinalPrefix = finalBase; currentArtifact.objectHashes = objectHashes;
      currentArtifact.publicationReceiptHash = publicationReceiptHash; currentArtifact.updatedAt = promotingAt;
    });
    const promoted = this.repository.readS8(job.projectId, artifact.artifactId);
    if (promoted.lifecycle() !== "promoted" || promoted.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
    this.verifyPublishedObjects(promoted.applicationArtifact() as unknown as S8Artifact);
    this.requireCurrentSource(job.projectId, job.source);
    this.commit(jobId, claimToken, job.source);
    this.emit("commit", job.projectId, jobId, artifact.artifactId);
    this.cleanupStaging(stagingPrefix);
  }

  private reclaim(job: S8ExportJob): { job: S8ExportJob; claimToken: UUID } {
    if (!job.claimToken || !job.ownerId || job.ownerProcessId === null) fail(409, "S8_CLAIM_FENCED");
    const heartbeatAt = job.heartbeatAt ? Date.parse(job.heartbeatAt) : Number.NaN;
    const now = Date.parse(this.clock());
    let alive = true;
    try { alive = this.isProcessAlive(job.ownerProcessId); } catch { alive = true; }
    if (!Number.isFinite(now) || !Number.isFinite(heartbeatAt) || now - heartbeatAt <= S8_STALE_CLAIM_MS || alive) fail(409, "S8_CLAIM_FENCED");
    this.requireCurrentSource(job.projectId, job.source);
    const previousToken = job.claimToken;
    let claimToken = this.uuid();
    if (claimToken === previousToken) claimToken = this.uuid();
    if (claimToken === previousToken) fail(500, "S8_PERSISTENCE_INVALID");
    const reclaimed = this.command({ kind: "reclaimPublication", projectId: job.projectId, jobId: job.jobId, artifactId: job.artifactId }, (state) => {
      const collections = getS8Collections(state);
      const current = collections.jobs.find((item) => item.jobId === job.jobId) as S8ExportJobV3 | undefined;
      const artifact = current ? collections.artifacts.find((item) => item.artifactId === current.artifactId) as S8ArtifactV3 | undefined : undefined;
      if (!current || !artifact || current.claimToken !== previousToken || current.ownerId !== job.ownerId ||
          current.ownerProcessId !== job.ownerProcessId || artifact.status !== current.status) fail(409, "S8_CLAIM_FENCED");
      const at = this.clock();
      current.claimToken = claimToken; current.ownerId = this.ownerId; current.ownerProcessId = this.processId;
      current.claimedAt = at; current.heartbeatAt = at; current.updatedAt = at; artifact.updatedAt = at;
      return { ...current };
    });
    return { job: reclaimed, claimToken };
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
      let recoveryClaim: UUID | null = null;
      try {
        const currentArtifact = getS8Collections(this.repository.state()).artifacts.find((item) => item.artifactId === candidate.artifactId);
        if (!currentArtifact) continue;
        const projection = this.repository.readS8(candidate.projectId, currentArtifact.artifactId);
        if (projection.sourceDisposition() !== "CURRENT") {
          this.markFailure(candidate.jobId, null, new AppError(409, projection.sourceDisposition() === "STALE" ? "S8_SOURCE_STALE" : "S8_SOURCE_NOT_READY"));
          recovered += 1; continue;
        }
        if (candidate.status === "validated" || candidate.status === "promoted") {
          const reclaimed = this.reclaim(candidate);
          recoveryClaim = reclaimed.claimToken;
          const staging = currentArtifact.privateStagingPrefix;
          if (candidate.status === "validated") this.promoteValidated(candidate.jobId, reclaimed.claimToken);
          else {
            const promoted = this.repository.readS8(candidate.projectId, currentArtifact.artifactId);
            if (promoted.lifecycle() !== "promoted" || promoted.sourceDisposition() !== "CURRENT") fail(409, "S8_PROOF_REQUIRED");
            this.verifyPublishedObjects(promoted.applicationArtifact() as unknown as S8Artifact);
            this.requireCurrentSource(candidate.projectId, candidate.source);
            this.commit(candidate.jobId, reclaimed.claimToken, candidate.source);
            this.emit("commit", candidate.projectId, candidate.jobId, currentArtifact.artifactId);
            if (staging !== null) this.cleanupStaging(staging);
          }
        } else {
          this.markFailure(candidate.jobId, null, new AppError(409, "S8_NATIVE_RECONCILIATION_REQUIRED"));
        }
      } catch (error) {
        const current = getS8Collections(this.repository.state()).jobs.find((item) => item.jobId === candidate.jobId);
        if (current && current.claimToken === (recoveryClaim ?? candidate.claimToken) &&
            current.status === candidate.status && current.artifactId === candidate.artifactId) {
          this.markFailure(candidate.jobId, recoveryClaim, error);
        }
      }
      recovered += 1;
    }
    return recovered;
  }
}
