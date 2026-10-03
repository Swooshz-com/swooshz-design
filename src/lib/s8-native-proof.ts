import { randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { AppError, type S8ArtifactV3, type S8Checkpoint, type S8ExportJobV3, type S8QuarantineV2,
  type S8TerminalOutcome, type S8ValidationReceiptV3, type StoreState } from "./types";
import { cloneJson, jcs, sha256, uuidV4Pattern } from "./utils";
import { emptyStoreState, isRegisteredS8RepositoryProofBinding } from "./store";

export type S8ImmutableApplicationTrust = Readonly<{
  currentKeyId: string | null;
  signingKey: KeyObject | null;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  keyDerIdentities: ReadonlyMap<string, string>;
  processBootstrapIdentity: object;
}>;

export type S8RepositoryProofBinding = object;
export type S8RepositoryLease = object;
export type S8RepositoryCommandSession = object;
export type S8RepositoryCommand = Readonly<{
  kind: "createQueued" | "claimQueued" | "beginNativeAttempt" | "prepareNativeAttempt" |
    "persistNativeAcceptance" | "persistNativeFailure" | "stageAcceptedWriter" | "validateAcceptedPair" |
    "promoteValidated" | "commitPromoted" | "recordTerminalFailure" | "scheduleRetry" |
    "reclaimPublication" | "reconcilePreparedAttempt";
  action?: "claim" | "heartbeat";
  projectId?: string;
  jobId?: string;
  artifactId?: string;
}>;
export type S8DerivedLifecycle =
  | "queued" | "running" | "staged" | "validated" | "promoted" | "committed"
  | "failed_retryable" | "failed_terminal" | "stale" | "aborted" | "quarantined"
  | "reconciliation_required";

export type S8ProofProjection = Readonly<{
  publicArtifact(): Readonly<Record<string, unknown>>;
  publicJob(): Readonly<Record<string, unknown>>;
  applicationArtifact(): Readonly<Record<string, unknown>>;
  validationReceipt(): Readonly<Record<string, unknown>> | null;
  lifecycle(): S8DerivedLifecycle;
  sourceDisposition(): "CURRENT" | "STALE" | "NOT_READY";
}>;

export type S8ValidatedGraph = object;
export type S8RepositoryProofAuthority = Readonly<{
  validateLocked(lease: S8RepositoryLease, graph: StoreState, baseline: StoreState): S8ValidatedGraph;
  projectLocked(lease: S8RepositoryLease, graph: S8ValidatedGraph, projectId: string, artifactId: string): S8ProofProjection;
  applyLocked(lease: S8RepositoryLease, baseline: StoreState, working: StoreState, command: object): void;
  migrateLocked(lease: S8RepositoryLease, decoded: Record<string, unknown>): StoreState;
}>;

type S8ProofBindingRecord = Readonly<{
  repositoryIdentity: object;
  canonicalRoot: string;
  objectRoot: string;
  trust: S8ImmutableApplicationTrust;
  readObjectExact: (reference: unknown) => Buffer;
  readSourceView: (state: StoreState, projectId: string) => unknown;
  assertLiveLease: (lease: S8RepositoryLease) => void;
}>;

type BoundBinding = S8RepositoryProofBinding & {
  resolveBindingRecord(): S8ProofBindingRecord;
};

const authorities = new WeakSet<object>();
const validatedGraphs = new WeakMap<object, { repositoryIdentity: object; state: StoreState; digest: string }>();
const projections = new WeakMap<object, {
  repositoryIdentity: object;
  projectId: string;
  artifactId: string;
  lifecycle: S8DerivedLifecycle;
  sourceDisposition: "CURRENT" | "STALE" | "NOT_READY";
  artifact: Readonly<Record<string, unknown>>;
  applicationArtifact: Readonly<Record<string, unknown>>;
  job: Readonly<Record<string, unknown>>;
  validationReceipt: Readonly<Record<string, unknown>> | null;
}>();

const COMMON_CHECKPOINT_KEYS = [
  "schemaVersion", "kind", "checkpointId", "keyId", "sequence", "previousCheckpointSha256",
  "projectId", "jobId", "artifactId", "attempt", "nativeClaimToken", "source",
  "acceptedSourceDigest", "payloadSha256", "writerAttemptId", "writerAcceptanceSha256",
  "releaseManifestSha256", "resourcePolicySha256", "issuedAt",
] as const;

function integrity(): never {
  throw new AppError(500, "S8_PROOF_INVALID");
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) return integrity();
  return item;
}

function string(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidV4Pattern.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) integrity();
}

function deepFreezePublic<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezePublic(child);
  return Object.freeze(value);
}

const EXPORT_STATUSES = new Set([
  "queued", "running", "staged", "validated", "promoted", "committed", "stale",
  "failed_retryable", "failed_terminal", "aborted",
]);
const PUBLICATION_PHASES = new Set([
  "source_admission", "claim", "private_staging", "independent_validation",
  "source_claim_recheck", "immutable_promotion", "verified_readback", "commit",
]);

function nullableUuid(value: unknown): value is string | null {
  return value === null || uuid(value);
}

function nullableHash(value: unknown): value is string | null {
  return value === null || hash(value);
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function ownerId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Array.from(value).length >= 1 &&
    Array.from(value).length <= 240 && !/\p{Cc}/u.test(value));
}

function validateSourceStamp(value: unknown, projectId?: string): asserts value is S8ExportJobV3["source"] {
  const source = exact(value, [
    "projectId", "sourceRevisionId", "sourceRevisionHash", "sourceS5Fingerprint",
    "s6ValidationReceiptId", "s6ValidationHash", "s6HandoffDigest", "s7ArtifactId",
    "s7ArtifactHash", "s7ReadbackHash", "s7ManifestId", "s7ManifestHash",
    "s8Profile", "s8ProtocolVersion",
  ]);
  if (!uuid(source.projectId) || (projectId !== undefined && source.projectId !== projectId) ||
      !uuid(source.sourceRevisionId) || !hash(source.sourceRevisionHash) || !hash(source.sourceS5Fingerprint) ||
      !uuid(source.s6ValidationReceiptId) || !hash(source.s6ValidationHash) || !hash(source.s6HandoffDigest) ||
      !uuid(source.s7ArtifactId) || !hash(source.s7ArtifactHash) || !hash(source.s7ReadbackHash) ||
      !uuid(source.s7ManifestId) || !hash(source.s7ManifestHash) ||
      source.s8Profile !== "swooshz-fbx-static-mesh-v1" ||
      source.s8ProtocolVersion !== "s8-end-to-end-executable-contract-v1") integrity();
}

const ATTEMPT_KEYS = [
  "schemaVersion", "attemptId", "projectId", "jobId", "artifactId", "claimToken", "attempt", "operation", "state",
  "acceptedSourceDigest", "profile", "protocolVersion", "configSha256", "resourcePolicySha256",
  "operationStartedAtUnixMs", "deadlineUnixMs", "clockModelVersion", "processClockEpoch", "operationStartMonotonicNs",
  "inputSha256", "inputBytes", "requestSha256", "requestNonce", "signedRequest", "responseSha256", "signedResponse",
  "releaseManifestSha256", "acceptanceReceipt", "retryEvidence", "failureClass", "failureCode", "disposalState",
  "createdAt", "updatedAt", "completedAt",
] as const;

const ACCEPTANCE_BODY_KEYS = [
  "schemaVersion", "acceptanceId", "keyId", "operationStartedAtUnixMs", "deadlineUnixMs",
  "responseObservedAtUnixMs", "logicalAcceptedAtUnixMs", "clockModelVersion", "processClockEpoch", "clockWitness",
  "attemptId", "projectId", "jobId", "artifactId", "attempt", "operation", "claimToken", "acceptedSourceDigest",
  "profile", "protocolVersion", "configSha256", "requestSha256", "requestNonce", "inputSha256", "inputBytes",
  "responseSha256", "outputSha256", "outputBytes", "auxiliarySha256", "auxiliaryBytes", "releaseManifestSha256",
  "resourcePolicySha256", "imageDigest", "containerId", "runnerBinarySha256", "runnerEvidenceSha256", "releaseHandle",
  "validatorIdentity", "disposalState", "nativeOutcome",
] as const;

function unixMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) &&
    value >= 0 && value <= 8640000000000000;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function monotonicNs(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  try { return BigInt(value) <= 18446744073709551615n; } catch { return false; }
}

function canonicalNonce(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 64 && decoded.toString("base64url") === value;
}

function verifySignedEnvelope(
  envelopeValue: unknown,
  bodyKeys: readonly string[],
  domain: string,
  trust: S8ImmutableApplicationTrust,
  digestKey: "receiptSha256" | "receiptHash",
): Record<string, unknown> {
  const envelope = exact(envelopeValue, ["body", "signature", digestKey]);
  const body = exact(envelope.body, bodyKeys);
  if (!canonicalSignature(envelope.signature) || !hash(envelope[digestKey]) ||
      sha256(jcs({ body, signature: envelope.signature })) !== envelope[digestKey]) integrity();
  if (typeof body.keyId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(body.keyId)) integrity();
  const key = trust.verificationKeys.get(body.keyId);
  if (!key) integrity();
  const signed = Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from([0]), Buffer.from(jcs(body), "utf8")]);
  if (!verify(null, signed, key, Buffer.from(envelope.signature, "base64url"))) integrity();
  return body;
}

function validateClockWitness(value: unknown, body: Record<string, unknown>, attempt: Record<string, unknown>): void {
  const witness = exact(value, [
    "operationStartMonotonicNs", "responseWallUnixMs", "responseMonotonicElapsedNs",
    "responsePriorEffectiveUnixMs", "decisionWallUnixMs", "decisionMonotonicElapsedNs",
    "decisionPriorEffectiveUnixMs",
  ]);
  if (!monotonicNs(witness.operationStartMonotonicNs) || !unixMs(witness.responseWallUnixMs) ||
      !monotonicNs(witness.responseMonotonicElapsedNs) || !unixMs(witness.responsePriorEffectiveUnixMs) ||
      !unixMs(witness.decisionWallUnixMs) || !monotonicNs(witness.decisionMonotonicElapsedNs) ||
      !unixMs(witness.decisionPriorEffectiveUnixMs) || !unixMs(body.operationStartedAtUnixMs) ||
      !unixMs(body.deadlineUnixMs) || !unixMs(body.responseObservedAtUnixMs) || !unixMs(body.logicalAcceptedAtUnixMs)) integrity();
  try {
    const start = BigInt(body.operationStartedAtUnixMs as number);
    const deadline = BigInt(body.deadlineUnixMs as number);
    const responseElapsed = BigInt(witness.responseMonotonicElapsedNs);
    const decisionElapsed = BigInt(witness.decisionMonotonicElapsedNs);
    const responseMono = start + (responseElapsed + 999999n) / 1000000n;
    const decisionMono = start + (decisionElapsed + 999999n) / 1000000n;
    const responseAt = [BigInt(witness.responseWallUnixMs), responseMono, BigInt(witness.responsePriorEffectiveUnixMs)]
      .reduce((a, b) => a > b ? a : b);
    const logicalAt = [BigInt(witness.decisionWallUnixMs), decisionMono, BigInt(witness.decisionPriorEffectiveUnixMs)]
      .reduce((a, b) => a > b ? a : b);
    if (witness.operationStartMonotonicNs !== attempt.operationStartMonotonicNs || responseElapsed > decisionElapsed ||
        BigInt(body.responseObservedAtUnixMs as number) !== responseAt ||
        BigInt(body.logicalAcceptedAtUnixMs as number) !== logicalAt ||
        start > responseAt || responseAt > logicalAt || logicalAt >= deadline ||
        responseAt > 8640000000000000n || logicalAt > 8640000000000000n) integrity();
  } catch { integrity(); }
}

function validateAcceptance(value: unknown, attempt: Record<string, unknown>, trust: S8ImmutableApplicationTrust): Record<string, unknown> {
  const body = verifySignedEnvelope(value, ACCEPTANCE_BODY_KEYS, "S8-NATIVE-ACCEPTANCE-V1", trust, "receiptSha256");
  if (body.schemaVersion !== "s8-native-acceptance-v1" || !uuid(body.acceptanceId) ||
      !unixMs(body.operationStartedAtUnixMs) || !unixMs(body.deadlineUnixMs) ||
      !unixMs(body.responseObservedAtUnixMs) || !unixMs(body.logicalAcceptedAtUnixMs) ||
      body.clockModelVersion !== "s8-effective-unix-ms-v1" || !uuid(body.processClockEpoch) ||
      !uuid(body.attemptId) || !uuid(body.projectId) || !uuid(body.jobId) || !uuid(body.artifactId) ||
      (body.attempt !== 1 && body.attempt !== 2) || (body.operation !== "WRITER" && body.operation !== "VALIDATOR") ||
      !uuid(body.claimToken) || !hash(body.acceptedSourceDigest) || body.profile !== "swooshz-fbx-static-mesh-v1" ||
      body.protocolVersion !== "s8-native-worker-v1" || !hash(body.configSha256) || !hash(body.requestSha256) ||
      !canonicalNonce(body.requestNonce) || !hash(body.inputSha256) || !safeInteger(body.inputBytes) ||
      !hash(body.responseSha256) || !hash(body.outputSha256) || !safeInteger(body.outputBytes) ||
      !hash(body.auxiliarySha256) || !safeInteger(body.auxiliaryBytes) || !hash(body.releaseManifestSha256) ||
      !hash(body.resourcePolicySha256) || typeof body.imageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(body.imageDigest) ||
      !hash(body.containerId) || !hash(body.runnerBinarySha256) || !hash(body.runnerEvidenceSha256) ||
      !canonicalNonce(body.releaseHandle) || body.disposalState !== "REAPED_REMOVED" || body.nativeOutcome !== "EXIT_0") integrity();
  validateClockWitness(body.clockWitness, body, attempt);
  for (const name of ["attemptId", "projectId", "jobId", "artifactId", "claimToken", "attempt", "operation",
    "acceptedSourceDigest", "profile", "protocolVersion", "configSha256", "requestSha256", "requestNonce",
    "inputSha256", "inputBytes", "responseSha256", "releaseManifestSha256"] as const) {
    if (body[name] !== attempt[name]) integrity();
  }
  if (body.operationStartedAtUnixMs !== attempt.operationStartedAtUnixMs || body.deadlineUnixMs !== attempt.deadlineUnixMs ||
      body.processClockEpoch !== attempt.processClockEpoch || body.operation !== attempt.operation ||
      body.responseSha256 !== attempt.responseSha256 || body.logicalAcceptedAtUnixMs >= body.deadlineUnixMs) integrity();
  if (body.operation === "WRITER" && (body.inputBytes < 1 || body.inputBytes > 268435456 ||
      body.outputBytes < 28 || body.outputBytes > 134217728 || body.auxiliaryBytes < 1 || body.auxiliaryBytes > 1048576 ||
      body.validatorIdentity !== null)) integrity();
  if (body.operation === "VALIDATOR" && (body.inputBytes < 28 || body.inputBytes > 134217728 ||
      body.outputBytes < 1 || body.outputBytes > 8388608 || body.auxiliaryBytes !== 0 ||
      typeof body.validatorIdentity !== "string" || !/^s8-validator-sha256:[0-9a-f]{64}$/u.test(body.validatorIdentity))) integrity();
  return body;
}

const RETRY_BODY_KEYS = [
  "schemaVersion", "decisionId", "keyId", "attemptBindingSha256", "responseSha256",
  "responseObservedAtUnixMs", "failureAcceptedAtUnixMs", "clockWitness", "nativeOutcome", "disposalState",
] as const;

const ATTEMPT_BINDING_KEYS = [
  "attemptId", "projectId", "jobId", "artifactId", "claimToken", "attempt", "operation",
  "acceptedSourceDigest", "profile", "protocolVersion", "configSha256", "resourcePolicySha256",
  "operationStartedAtUnixMs", "deadlineUnixMs", "clockModelVersion", "processClockEpoch",
  "operationStartMonotonicNs", "inputSha256", "inputBytes", "requestSha256", "requestNonce",
  "releaseManifestSha256",
] as const;

function validateRetryEvidence(value: unknown, attempt: Record<string, unknown>, trust: S8ImmutableApplicationTrust): string {
  const body = verifySignedEnvelope(value, RETRY_BODY_KEYS, "S8-NATIVE-RETRY-EVIDENCE-V1", trust, "receiptSha256");
  if (body.schemaVersion !== "s8-native-retry-evidence-v1" || !uuid(body.decisionId) ||
      !hash(body.attemptBindingSha256) || !hash(body.responseSha256) || !unixMs(body.responseObservedAtUnixMs) ||
      !unixMs(body.failureAcceptedAtUnixMs) || body.nativeOutcome !== "TRANSIENT_INFRASTRUCTURE_FAILURE" ||
      body.disposalState !== "REAPED_REMOVED" || attempt.requestSha256 === null || attempt.requestNonce === null ||
      attempt.responseSha256 === null || attempt.operation !== "WRITER" && attempt.operation !== "VALIDATOR") integrity();
  const binding: Record<string, unknown> = {};
  for (const key of ATTEMPT_BINDING_KEYS) binding[key] = attempt[key];
  if (ATTEMPT_BINDING_KEYS.some((key) => binding[key] === null || binding[key] === undefined) ||
      sha256(jcs(binding)) !== body.attemptBindingSha256 || attempt.responseSha256 !== body.responseSha256 ||
      body.failureAcceptedAtUnixMs < body.responseObservedAtUnixMs ||
      body.failureAcceptedAtUnixMs >= Number(attempt.deadlineUnixMs)) integrity();
  validateClockWitness(body.clockWitness, {
    operationStartedAtUnixMs: attempt.operationStartedAtUnixMs,
    deadlineUnixMs: attempt.deadlineUnixMs,
    responseObservedAtUnixMs: body.responseObservedAtUnixMs,
    logicalAcceptedAtUnixMs: body.failureAcceptedAtUnixMs,
  }, attempt);
  return String(body.decisionId);
}

function validateValidationReceipts(state: StoreState): Map<string, Record<string, unknown>> {
  const receiptKeys = [
    "schemaVersion", "receiptId", "projectId", "jobId", "artifactId", "attempt", "nativeClaimToken", "source",
    "acceptedSourceDigest", "payloadSha256", "writerAttemptId", "writerAcceptanceSha256", "validatorAttemptId",
    "validatorAcceptanceSha256", "stagedCheckpointSha256", "releaseManifestSha256", "resourcePolicySha256",
    "artifactSha256", "artifactByteSize", "writerReceiptHash", "writerReceiptBytes", "nativeReadbackHash",
    "nativeReadbackBytes", "semanticReceiptHash", "semanticReceiptBytes", "nativeOutcome", "semanticOutcome",
    "fingerprintVersion", "immutableReuseFingerprint", "resourceLimitsHash", "checkedAt", "receiptHash",
  ];
  const byteKeys = ["schemaVersion", "receiptId", "canonicalBase64url", "byteSize", "sha256"];
  const receipts = new Map<string, Record<string, unknown>>();
  const bytesById = new Map<string, Record<string, unknown>>();
  for (const raw of state.s8ValidationReceiptBytes!) {
    const item = exact(raw, byteKeys);
    if (item.schemaVersion !== "s8-validation-receipt-bytes-v1" || !uuid(item.receiptId) ||
        typeof item.canonicalBase64url !== "string" || !/^[A-Za-z0-9_-]+$/u.test(item.canonicalBase64url) ||
        !safeInteger(item.byteSize) || item.byteSize < 1 || item.byteSize > 8388608 || !hash(item.sha256) ||
        bytesById.has(String(item.receiptId))) integrity();
    const decoded = Buffer.from(item.canonicalBase64url, "base64url");
    if (decoded.toString("base64url") !== item.canonicalBase64url || decoded.byteLength !== item.byteSize ||
        sha256(decoded) !== item.sha256) integrity();
    bytesById.set(String(item.receiptId), item);
  }
  for (const raw of state.s8ValidationReceipts!) {
    const receipt = exact(raw, receiptKeys);
    if (receipt.schemaVersion !== "s8-validation-receipt-v3" || !uuid(receipt.receiptId) || !uuid(receipt.projectId) ||
        !uuid(receipt.jobId) || !uuid(receipt.artifactId) || (receipt.attempt !== 1 && receipt.attempt !== 2) ||
        !uuid(receipt.nativeClaimToken) || !hash(receipt.acceptedSourceDigest) || !hash(receipt.payloadSha256) ||
        !uuid(receipt.writerAttemptId) || !hash(receipt.writerAcceptanceSha256) || !uuid(receipt.validatorAttemptId) ||
        !hash(receipt.validatorAcceptanceSha256) || !hash(receipt.stagedCheckpointSha256) ||
        !hash(receipt.releaseManifestSha256) || !hash(receipt.resourcePolicySha256) || !hash(receipt.artifactSha256) ||
        !safeInteger(receipt.artifactByteSize) || receipt.artifactByteSize < 28 || receipt.artifactByteSize > 134217728 ||
        !hash(receipt.writerReceiptHash) || !safeInteger(receipt.writerReceiptBytes) || receipt.writerReceiptBytes < 1 || receipt.writerReceiptBytes > 1048576 ||
        !hash(receipt.nativeReadbackHash) || !safeInteger(receipt.nativeReadbackBytes) || receipt.nativeReadbackBytes < 1 || receipt.nativeReadbackBytes > 8388608 ||
        !hash(receipt.semanticReceiptHash) || !safeInteger(receipt.semanticReceiptBytes) || receipt.semanticReceiptBytes < 1 || receipt.semanticReceiptBytes > 8388608 ||
        receipt.nativeOutcome !== "pass" || receipt.semanticOutcome !== "pass" ||
        receipt.fingerprintVersion !== "s8-immutable-reuse-fingerprint-v3" || !hash(receipt.immutableReuseFingerprint) ||
        !hash(receipt.resourceLimitsHash) || !timestamp(receipt.checkedAt) || !hash(receipt.receiptHash) ||
        receipts.has(String(receipt.receiptId))) integrity();
    validateSourceStamp(receipt.source, String(receipt.projectId));
    if (receipt.acceptedSourceDigest !== sha256(jcs(receipt.source))) integrity();
    const withoutHash = { ...receipt };
    delete withoutHash.receiptHash;
    if (sha256(jcs(withoutHash)) !== receipt.receiptHash) integrity();
    const fingerprint = {
      fingerprintVersion: receipt.fingerprintVersion, source: receipt.source, payloadSha256: receipt.payloadSha256,
      writerAcceptanceSha256: receipt.writerAcceptanceSha256, validatorAcceptanceSha256: receipt.validatorAcceptanceSha256,
      releaseManifestSha256: receipt.releaseManifestSha256, resourcePolicySha256: receipt.resourcePolicySha256,
      resourceLimitsHash: receipt.resourceLimitsHash, artifactSha256: receipt.artifactSha256,
      artifactByteSize: receipt.artifactByteSize, writerReceiptHash: receipt.writerReceiptHash,
      writerReceiptBytes: receipt.writerReceiptBytes, nativeReadbackHash: receipt.nativeReadbackHash,
      nativeReadbackBytes: receipt.nativeReadbackBytes, semanticReceiptHash: receipt.semanticReceiptHash,
      semanticReceiptBytes: receipt.semanticReceiptBytes,
    };
    if (sha256(jcs(fingerprint)) !== receipt.immutableReuseFingerprint) integrity();
    const bytesRecord = bytesById.get(String(receipt.receiptId));
    const canonicalBytes = Buffer.from(jcs(receipt), "utf8");
    if (!bytesRecord || bytesRecord.byteSize !== canonicalBytes.byteLength || bytesRecord.sha256 !== sha256(canonicalBytes) ||
        !Buffer.from(String(bytesRecord.canonicalBase64url), "base64url").equals(canonicalBytes)) integrity();
    receipts.set(String(receipt.receiptId), receipt);
  }
  if (bytesById.size !== receipts.size) integrity();
  return receipts;
}

function validateNativeAttempt(value: unknown, trust: S8ImmutableApplicationTrust): { attempt: Record<string, unknown>; acceptanceId: string | null; retryId: string | null } {
  const attempt = exact(value, ATTEMPT_KEYS);
  if (attempt.schemaVersion !== "s8-native-operation-attempt-v2" || !uuid(attempt.attemptId) ||
      !uuid(attempt.projectId) || !uuid(attempt.jobId) || !uuid(attempt.artifactId) || !uuid(attempt.claimToken) ||
      (attempt.attempt !== 1 && attempt.attempt !== 2) || (attempt.operation !== "WRITER" && attempt.operation !== "VALIDATOR") ||
      !["DISPATCHING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(attempt.state)) ||
      !hash(attempt.acceptedSourceDigest) || attempt.profile !== "swooshz-fbx-static-mesh-v1" ||
      attempt.protocolVersion !== "s8-native-worker-v1" || !hash(attempt.configSha256) || !hash(attempt.resourcePolicySha256) ||
      !unixMs(attempt.operationStartedAtUnixMs) || !unixMs(attempt.deadlineUnixMs) ||
      attempt.clockModelVersion !== "s8-effective-unix-ms-v1" || !uuid(attempt.processClockEpoch) ||
      !monotonicNs(attempt.operationStartMonotonicNs) || !hash(attempt.inputSha256) || !safeInteger(attempt.inputBytes) ||
      attempt.inputBytes < 1 || attempt.inputBytes > 268435456 || !hash(attempt.releaseManifestSha256) ||
      !timestamp(attempt.createdAt) || !timestamp(attempt.updatedAt) || !nullableTimestamp(attempt.completedAt)) integrity();
  const expectedDuration = attempt.operation === "WRITER" ? 510000 : 330000;
  if (attempt.operationStartedAtUnixMs > 8640000000000000 - expectedDuration ||
      attempt.deadlineUnixMs - attempt.operationStartedAtUnixMs !== expectedDuration) integrity();
  const requestFields = [attempt.requestSha256, attempt.requestNonce, attempt.signedRequest];
  if (!(requestFields.every((item) => item === null) || requestFields.every((item) => item !== null))) integrity();
  const responseFields = [attempt.responseSha256, attempt.signedResponse];
  if (!(responseFields.every((item) => item === null) || responseFields.every((item) => item !== null))) integrity();
  if ((attempt.requestSha256 !== null && !hash(attempt.requestSha256)) ||
      (attempt.requestNonce !== null && !canonicalNonce(attempt.requestNonce)) ||
      (attempt.signedRequest !== null && (typeof attempt.signedRequest !== "object" || Array.isArray(attempt.signedRequest))) ||
      (attempt.responseSha256 !== null && !hash(attempt.responseSha256)) ||
      (attempt.signedResponse !== null && (typeof attempt.signedResponse !== "object" || Array.isArray(attempt.signedResponse)))) integrity();
  if (!["PERMANENT", "TRANSIENT", "UNCERTAIN", null].some((item) => item === attempt.failureClass) ||
      !["TIMEOUT", "CLOCK_INVALID", "SOURCE_OR_CLAIM_FENCED", "ADMISSION_CLOSED", "PROTOCOL_OR_SIGNATURE",
        "NATIVE_OR_RESOURCE", "TRANSIENT_INFRASTRUCTURE", "PERSISTENCE_UNCERTAIN", "RECONCILIATION_REQUIRED", null]
        .some((item) => item === attempt.failureCode) ||
      !["NOT_STARTED", "REAPED_REMOVED", "UNKNOWN"].includes(String(attempt.disposalState))) integrity();
  const isUnprepared = attempt.requestSha256 === null;
  const acceptance = attempt.acceptanceReceipt === null ? null : validateAcceptance(attempt.acceptanceReceipt, attempt, trust);
  const retryId = attempt.retryEvidence === null ? null : validateRetryEvidence(attempt.retryEvidence, attempt, trust);
  if (attempt.state === "DISPATCHING") {
    if (attempt.responseSha256 !== null || attempt.acceptanceReceipt !== null || attempt.retryEvidence !== null ||
        attempt.failureClass !== null || attempt.failureCode !== null || attempt.completedAt !== null ||
        attempt.disposalState !== (isUnprepared ? "NOT_STARTED" : "UNKNOWN")) integrity();
  } else if (attempt.state === "SUCCEEDED") {
    if (isUnprepared || attempt.responseSha256 === null || !acceptance || retryId !== null ||
        attempt.failureClass !== null || attempt.failureCode !== null || !timestamp(attempt.completedAt) ||
        attempt.disposalState !== "REAPED_REMOVED") integrity();
  } else if (attempt.state === "FAILED") {
    if (attempt.acceptanceReceipt !== null || !attempt.failureClass || !attempt.failureCode ||
        !timestamp(attempt.completedAt)) integrity();
    if (attempt.failureClass === "TRANSIENT") {
      if (isUnprepared || attempt.responseSha256 === null || !retryId ||
          attempt.failureCode !== "TRANSIENT_INFRASTRUCTURE" || attempt.disposalState !== "REAPED_REMOVED") integrity();
    } else if (retryId !== null || attempt.failureClass !== "PERMANENT" ||
        !["NOT_STARTED", "REAPED_REMOVED"].includes(String(attempt.disposalState))) integrity();
  } else if (attempt.state === "UNKNOWN") {
    if (attempt.acceptanceReceipt !== null || retryId !== null || attempt.failureClass !== "UNCERTAIN" ||
        !["PERSISTENCE_UNCERTAIN", "RECONCILIATION_REQUIRED"].includes(String(attempt.failureCode)) ||
        attempt.disposalState !== "UNKNOWN" || !timestamp(attempt.completedAt)) integrity();
  }
  return { attempt, acceptanceId: acceptance ? String(acceptance.acceptanceId) : null, retryId };
}

const LEGACY_JOB_KEYS = ["schemaVersion", "jobId", "projectId", "artifactId", "source", "inputHash", "idempotencyKey",
  "status", "publicationPhase", "attempt", "claimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt",
  "createdAt", "updatedAt", "terminalAt", "failureCode"] as const;
const LEGACY_ARTIFACT_KEYS = ["schemaVersion", "artifactId", "projectId", "jobId", "source", "inputHash", "profile",
  "format", "mimeType", "downloadFileName", "status", "publicationPhase", "payloadSha256", "objectHashes",
  "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "publicationReceiptHash", "validationReceiptId",
  "validationReceiptHash", "immutableReuseFingerprint", "privateStagingPrefix", "privateFinalPrefix", "attempt",
  "retryOfArtifactId", "failureCode", "createdAt", "updatedAt", "committedAt", "staleAt"] as const;
const LEGACY_RECEIPT_KEYS = ["schemaVersion", "receiptId", "projectId", "artifactId", "source", "payloadSha256",
  "artifactSha256", "artifactByteSize", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash",
  "nativeOutcome", "semanticOutcome", "fingerprintVersion", "immutableReuseFingerprint", "resourceLimitsHash",
  "checkedAt", "receiptHash"] as const;
const LEGACY_IDEMPOTENCY_KEYS = ["schemaVersion", "projectId", "operation", "idempotencyKey", "inputHash", "source",
  "jobId", "artifactId", "createdAt"] as const;
const LEGACY_V1_ATTEMPT_KEYS = ["schemaVersion", "attemptId", "projectId", "jobId", "artifactId", "claimToken", "attempt",
  "operation", "state", "inputSha256", "requestSha256", "requestNonce", "responseSha256", "releaseManifestSha256",
  "failureClass", "disposalState", "createdAt", "updatedAt", "completedAt"] as const;
const LEGACY_QUARANTINE_V1_KEYS = ["schemaVersion", "quarantineId", "reason", "migratedAt", "admissionBlock", "originalJob",
  "originalArtifact", "originalAttempts", "originalValidationReceipts"] as const;

function validateLegacyJob(value: unknown): Record<string, unknown> {
  const job = exact(value, LEGACY_JOB_KEYS);
  if (job.schemaVersion !== "s8-export-job-v2" || !uuid(job.jobId) || !uuid(job.projectId) || !uuid(job.artifactId) ||
      !hash(job.inputHash) || !string(job.idempotencyKey, 240) || !EXPORT_STATUSES.has(String(job.status)) ||
      !PUBLICATION_PHASES.has(String(job.publicationPhase)) || (job.attempt !== 1 && job.attempt !== 2) ||
      !nullableUuid(job.claimToken) || !ownerId(job.ownerId) ||
      !(job.ownerProcessId === null || (safeInteger(job.ownerProcessId) && Number(job.ownerProcessId) >= 1 && Number(job.ownerProcessId) <= 2147483647)) ||
      !nullableTimestamp(job.claimedAt) || !nullableTimestamp(job.heartbeatAt) || !timestamp(job.createdAt) ||
      !timestamp(job.updatedAt) || !nullableTimestamp(job.terminalAt) ||
      !(job.failureCode === null || string(job.failureCode, 120))) integrity();
  validateSourceStamp(job.source, String(job.projectId));
  return job;
}

function validateLegacyArtifact(value: unknown): Record<string, unknown> {
  const artifact = exact(value, LEGACY_ARTIFACT_KEYS);
  if (artifact.schemaVersion !== "s8-artifact-v2" || !uuid(artifact.artifactId) || !uuid(artifact.projectId) ||
      !uuid(artifact.jobId) || !hash(artifact.inputHash) || artifact.profile !== "swooshz-fbx-static-mesh-v1" ||
      artifact.format !== "fbx" || artifact.mimeType !== "application/octet-stream" ||
      artifact.downloadFileName !== "swooshz-s8-scene.fbx" || !EXPORT_STATUSES.has(String(artifact.status)) ||
      !PUBLICATION_PHASES.has(String(artifact.publicationPhase)) || !nullableHash(artifact.payloadSha256) ||
      !nullableHash(artifact.writerReceiptHash) || !nullableHash(artifact.nativeReadbackHash) ||
      !nullableHash(artifact.semanticReceiptHash) || !nullableHash(artifact.publicationReceiptHash) ||
      !nullableUuid(artifact.validationReceiptId) || !nullableHash(artifact.validationReceiptHash) ||
      !nullableHash(artifact.immutableReuseFingerprint) || !string(artifact.privateStagingPrefix, 1024) ||
      !string(artifact.privateFinalPrefix, 1024) || (artifact.attempt !== 1 && artifact.attempt !== 2) ||
      !nullableUuid(artifact.retryOfArtifactId) || !(artifact.failureCode === null || string(artifact.failureCode, 120)) ||
      !timestamp(artifact.createdAt) || !timestamp(artifact.updatedAt) || !nullableTimestamp(artifact.committedAt) ||
      !nullableTimestamp(artifact.staleAt)) integrity();
  if (artifact.objectHashes !== null) {
    const hashes = exact(artifact.objectHashes, ["artifactSha256", "artifactByteSize", "writerReceiptSha256",
      "nativeReadbackSha256", "semanticReceiptSha256", "publicationReceiptSha256"]);
    if (!hash(hashes.artifactSha256) || !safeInteger(hashes.artifactByteSize) || Number(hashes.artifactByteSize) < 1 ||
        !hash(hashes.writerReceiptSha256) || !hash(hashes.nativeReadbackSha256) || !hash(hashes.semanticReceiptSha256) ||
        !hash(hashes.publicationReceiptSha256)) integrity();
  }
  validateSourceStamp(artifact.source, String(artifact.projectId));
  return artifact;
}

function validateLegacyReceipt(value: unknown): Record<string, unknown> {
  const receipt = exact(value, LEGACY_RECEIPT_KEYS);
  if (receipt.schemaVersion !== "s8-validation-receipt-v2" || !uuid(receipt.receiptId) || !uuid(receipt.projectId) ||
      !uuid(receipt.artifactId) || !hash(receipt.payloadSha256) || !hash(receipt.artifactSha256) ||
      !safeInteger(receipt.artifactByteSize) || Number(receipt.artifactByteSize) < 1 ||
      !hash(receipt.writerReceiptHash) || !hash(receipt.nativeReadbackHash) || !hash(receipt.semanticReceiptHash) ||
      receipt.nativeOutcome !== "pass" || receipt.semanticOutcome !== "pass" ||
      receipt.fingerprintVersion !== "s8-immutable-reuse-fingerprint-v2" ||
      !hash(receipt.immutableReuseFingerprint) || !hash(receipt.resourceLimitsHash) || !timestamp(receipt.checkedAt) ||
      !hash(receipt.receiptHash)) integrity();
  validateSourceStamp(receipt.source, String(receipt.projectId));
  const { receiptHash, ...body } = receipt;
  if (sha256(jcs(body)) !== receiptHash) integrity();
  return receipt;
}

function validateLegacyIdempotency(value: unknown): Record<string, unknown> {
  const item = exact(value, LEGACY_IDEMPOTENCY_KEYS);
  if (item.schemaVersion !== "s8-idempotency-v2" || !uuid(item.projectId) || item.operation !== "export" ||
      !string(item.idempotencyKey, 240) || !hash(item.inputHash) || !uuid(item.jobId) || !uuid(item.artifactId) ||
      !timestamp(item.createdAt)) integrity();
  validateSourceStamp(item.source, String(item.projectId));
  return item;
}

function validateLegacyV1Attempt(value: unknown): Record<string, unknown> {
  const attempt = exact(value, LEGACY_V1_ATTEMPT_KEYS);
  if (attempt.schemaVersion !== "s8-native-operation-attempt-v1" || !uuid(attempt.attemptId) ||
      !uuid(attempt.projectId) || !uuid(attempt.jobId) || !uuid(attempt.artifactId) || !uuid(attempt.claimToken) ||
      (attempt.attempt !== 1 && attempt.attempt !== 2) || !["WRITER", "VALIDATOR"].includes(String(attempt.operation)) ||
      !["DISPATCHING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(attempt.state)) ||
      !hash(attempt.inputSha256) || !nullableHash(attempt.requestSha256) ||
      !(attempt.requestNonce === null || string(attempt.requestNonce, 256)) || !nullableHash(attempt.responseSha256) ||
      !nullableHash(attempt.releaseManifestSha256) || !["PERMANENT", "TRANSIENT", "UNCERTAIN", null].includes(attempt.failureClass as string | null) ||
      !["NOT_STARTED", "REAPED_REMOVED", "UNKNOWN"].includes(String(attempt.disposalState)) ||
      !timestamp(attempt.createdAt) || !timestamp(attempt.updatedAt) || !nullableTimestamp(attempt.completedAt)) integrity();
  return attempt;
}

function validateLegacyAttempt(value: unknown, evidenceVersion: 1 | 2 | null, trust: S8ImmutableApplicationTrust): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version === "s8-native-operation-attempt-v1" && evidenceVersion !== 2) return validateLegacyV1Attempt(value);
  if (version === "s8-native-operation-attempt-v2" && evidenceVersion === 2) return validateNativeAttempt(value, trust).attempt;
  return integrity();
}

function validateAnyLegacyAttempt(value: unknown, trust: S8ImmutableApplicationTrust): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version === "s8-native-operation-attempt-v1") return validateLegacyV1Attempt(value);
  if (version === "s8-native-operation-attempt-v2") return validateNativeAttempt(value, trust).attempt;
  return integrity();
}

function validateLegacyQuarantineV1(value: unknown, trust: S8ImmutableApplicationTrust): Record<string, unknown> {
  const quarantine = exact(value, LEGACY_QUARANTINE_V1_KEYS);
  if (quarantine.schemaVersion !== "s8-native-legacy-quarantine-v1" || !uuid(quarantine.quarantineId) ||
      quarantine.reason !== "LEGACY_NATIVE_ACCEPTANCE_UNPROVEN" || !timestamp(quarantine.migratedAt) ||
      !["NONE", "RECONCILIATION_REQUIRED"].includes(String(quarantine.admissionBlock)) ||
      !Array.isArray(quarantine.originalAttempts) || !Array.isArray(quarantine.originalValidationReceipts)) integrity();
  const job = validateLegacyJob(quarantine.originalJob);
  const artifact = validateLegacyArtifact(quarantine.originalArtifact);
  if (job.jobId !== quarantine.quarantineId || artifact.jobId !== quarantine.quarantineId ||
      artifact.artifactId !== job.artifactId || artifact.projectId !== job.projectId) integrity();
  for (const attempt of quarantine.originalAttempts) {
    const checked = validateAnyLegacyAttempt(attempt, trust);
    if (checked.jobId !== job.jobId || checked.artifactId !== artifact.artifactId || checked.projectId !== job.projectId) integrity();
  }
  for (const receiptValue of quarantine.originalValidationReceipts) {
    const receipt = validateLegacyReceipt(receiptValue);
    if (receipt.projectId !== job.projectId || receipt.artifactId !== artifact.artifactId || jcs(receipt.source) !== jcs(job.source)) integrity();
  }
  return quarantine;
}

function legacyAdmissionBlock(attempts: readonly Record<string, unknown>[]): "NONE" | "RECONCILIATION_REQUIRED" {
  if (attempts.some((attempt) => attempt.state === "DISPATCHING" || attempt.state === "UNKNOWN" ||
      attempt.disposalState !== "REAPED_REMOVED")) return "RECONCILIATION_REQUIRED";
  return "NONE";
}

function pristineLegacyQueued(
  job: Record<string, unknown>, artifact: Record<string, unknown>, attempts: readonly Record<string, unknown>[],
  receipts: readonly Record<string, unknown>[], idempotencies: readonly Record<string, unknown>[],
  priorQuarantine: Record<string, unknown> | undefined,
): boolean {
  const source = job.source as Record<string, unknown>;
  return priorQuarantine === undefined && attempts.length === 0 && receipts.length === 0 && idempotencies.length === 1 &&
    job.status === "queued" && artifact.status === "queued" && job.publicationPhase === "source_admission" &&
    artifact.publicationPhase === "source_admission" && job.attempt === 1 && artifact.attempt === 1 &&
    job.claimToken === null && job.ownerId === null && job.ownerProcessId === null && job.claimedAt === null &&
    job.heartbeatAt === null && job.terminalAt === null && job.failureCode === null && artifact.retryOfArtifactId === null &&
    artifact.payloadSha256 === null && artifact.objectHashes === null && artifact.writerReceiptHash === null &&
    artifact.nativeReadbackHash === null && artifact.semanticReceiptHash === null && artifact.publicationReceiptHash === null &&
    artifact.validationReceiptId === null && artifact.validationReceiptHash === null && artifact.immutableReuseFingerprint === null &&
    artifact.failureCode === null && artifact.committedAt === null && artifact.staleAt === null &&
    artifact.privateStagingPrefix === `private/projects/${job.projectId}/s8/staging/${artifact.artifactId}/unclaimed` &&
    artifact.privateFinalPrefix === `private/projects/${job.projectId}/s8/committed/${source.sourceRevisionHash}/${"0".repeat(64)}` &&
    idempotencies[0]?.jobId === job.jobId && idempotencies[0]?.artifactId === artifact.artifactId;
}

function convertQueuedLegacyJob(job: Record<string, unknown>): S8ExportJobV3 {
  return { ...cloneJson(job), schemaVersion: "s8-export-job-v3", nativeClaimToken: null, headCheckpointSha256: null,
    terminalOutcomeId: null, quarantineId: null, retryDecisionId: null } as unknown as S8ExportJobV3;
}

function convertQueuedLegacyArtifact(artifact: Record<string, unknown>): S8ArtifactV3 {
  return { ...cloneJson(artifact), schemaVersion: "s8-artifact-v3", headCheckpointSha256: null,
    terminalOutcomeId: null, quarantineId: null } as unknown as S8ArtifactV3;
}

function validateLegacyStateAndMigrate(
  decoded: Record<string, unknown>, binding: S8ProofBindingRecord,
): StoreState {
  const trust = binding.trust;
  const hasVersion = Object.prototype.hasOwnProperty.call(decoded, "s8NativeEvidenceVersion");
  const versionValue = hasVersion ? decoded.s8NativeEvidenceVersion : null;
  if (versionValue === 3) {
    if (decoded.s8NativeProofSchemaVersion !== "s8-native-proof-v1") integrity();
    const candidate = decoded as unknown as StoreState;
    validateStateShape(candidate, trust, binding);
    return candidate;
  }
  if (hasVersion && versionValue !== 1 && versionValue !== 2) integrity();
  if (Object.prototype.hasOwnProperty.call(decoded, "s8NativeProofSchemaVersion")) integrity();
  const predecessorVersion = versionValue as 1 | 2 | null;
  const legacyFields = new Set(["s8NativeEvidenceVersion", "s8ExportJobs", "s8Artifacts", "s8ValidationReceipts",
    "s8IdempotencyRecords", "s8NativeOperationAttempts", "s8NativeAttemptQuarantines"]);
  for (const key of Object.keys(decoded)) if (key.startsWith("s8") && !legacyFields.has(key)) integrity();
  if (predecessorVersion !== 2 && Object.prototype.hasOwnProperty.call(decoded, "s8NativeAttemptQuarantines")) integrity();
  if (predecessorVersion === 2 && (!Object.prototype.hasOwnProperty.call(decoded, "s8NativeOperationAttempts") ||
      !Object.prototype.hasOwnProperty.call(decoded, "s8NativeAttemptQuarantines"))) integrity();
  const list = (key: string): unknown[] => {
    if (!Object.prototype.hasOwnProperty.call(decoded, key)) return [];
    const value = decoded[key];
    if (!Array.isArray(value)) return integrity();
    return value;
  };
  const jobs = list("s8ExportJobs").map(validateLegacyJob);
  const artifacts = list("s8Artifacts").map(validateLegacyArtifact);
  const receipts = list("s8ValidationReceipts").map(validateLegacyReceipt);
  const idempotencies = list("s8IdempotencyRecords").map(validateLegacyIdempotency);
  const attempts = list("s8NativeOperationAttempts").map((value) => validateLegacyAttempt(value, predecessorVersion, trust));
  const oldQuarantines = predecessorVersion === 2
    ? list("s8NativeAttemptQuarantines").map((value) => validateLegacyQuarantineV1(value, trust)) : [];

  const jobsById = new Map<string, Record<string, unknown>>();
  for (const job of jobs) {
    if (jobsById.has(String(job.jobId))) integrity();
    jobsById.set(String(job.jobId), job);
  }
  const artifactsById = new Map<string, Record<string, unknown>>();
  for (const artifact of artifacts) {
    if (artifactsById.has(String(artifact.artifactId))) integrity();
    artifactsById.set(String(artifact.artifactId), artifact);
  }
  const oldQuarantineById = new Map<string, Record<string, unknown>>();
  for (const quarantine of oldQuarantines) {
    if (oldQuarantineById.has(String(quarantine.quarantineId))) integrity();
    oldQuarantineById.set(String(quarantine.quarantineId), quarantine);
  }
  if (jobs.length !== artifacts.length) integrity();
  const attemptIds = new Set<string>();
  const attemptTuples = new Set<string>();
  for (const attempt of attempts) {
    const job = jobsById.get(String(attempt.jobId));
    const artifact = artifactsById.get(String(attempt.artifactId));
    const tuple = [attempt.jobId, attempt.attempt, attempt.operation].join(":");
    if (!job || !artifact || attempt.projectId !== job.projectId || attempt.artifactId !== job.artifactId ||
        Number(attempt.attempt) > Number(job.attempt) || attemptIds.has(String(attempt.attemptId)) || attemptTuples.has(tuple)) integrity();
    attemptIds.add(String(attempt.attemptId)); attemptTuples.add(tuple);
  }
  const receiptIds = new Set<string>();
  for (const receipt of receipts) {
    const artifact = artifactsById.get(String(receipt.artifactId));
    const job = artifact && jobsById.get(String(artifact.jobId));
    if (!artifact || !job || receipt.projectId !== artifact.projectId ||
        receipt.artifactId !== artifact.artifactId || jcs(receipt.source) !== jcs(artifact.source) ||
        receipt.payloadSha256 !== artifact.payloadSha256 || receiptIds.has(String(receipt.receiptId))) integrity();
    receiptIds.add(String(receipt.receiptId));
  }
  const idempotencyKeys = new Set<string>();
  const idempotenciesByJob = new Map<string, Record<string, unknown>[]>();
  for (const item of idempotencies) {
    const job = jobsById.get(String(item.jobId));
    if (!job || job.projectId !== item.projectId || job.artifactId !== item.artifactId || job.inputHash !== item.inputHash ||
        job.idempotencyKey !== item.idempotencyKey || jcs(job.source) !== jcs(item.source) ||
        idempotencyKeys.has(`${item.projectId}:${item.idempotencyKey}`)) integrity();
    idempotencyKeys.add(`${item.projectId}:${item.idempotencyKey}`);
    const rows = idempotenciesByJob.get(String(item.jobId)) ?? [];
    rows.push(item); idempotenciesByJob.set(String(item.jobId), rows);
  }
  for (const artifact of artifacts) {
    const job = jobsById.get(String(artifact.jobId));
    if (!job || job.artifactId !== artifact.artifactId || job.projectId !== artifact.projectId ||
        job.inputHash !== artifact.inputHash || jcs(job.source) !== jcs(artifact.source) || job.attempt !== artifact.attempt) integrity();
    const isOldQuarantine = oldQuarantineById.has(String(job.jobId));
    if (!isOldQuarantine && (job.status !== artifact.status || job.publicationPhase !== artifact.publicationPhase)) integrity();
    if (isOldQuarantine && (job.status !== "failed_terminal" || artifact.status !== "failed_terminal" ||
        job.failureCode !== "S8_NATIVE_LEGACY_UNPROVEN" || artifact.failureCode !== "S8_NATIVE_LEGACY_UNPROVEN")) integrity();
    if (!isOldQuarantine && !idempotenciesByJob.has(String(job.jobId))) integrity();
  }
  for (const item of idempotencies) if (!artifactsById.has(String(item.artifactId))) integrity();
  for (const receipt of receipts) {
    const artifact = artifactsById.get(String(receipt.artifactId))!;
    if (artifact.validationReceiptId !== receipt.receiptId || artifact.validationReceiptHash !== receipt.receiptHash ||
        artifact.validationReceiptHash === null) integrity();
  }
  for (const attempt of attempts) {
    const job = jobsById.get(String(attempt.jobId))!;
    const artifact = artifactsById.get(String(attempt.artifactId))!;
    if (jcs(job.source) !== jcs(artifact.source) || attempt.projectId !== job.projectId) integrity();
  }
  for (const quarantine of oldQuarantines) {
    const job = jobsById.get(String(quarantine.quarantineId));
    if (!job || job.artifactId !== (quarantine.originalArtifact as Record<string, unknown>).artifactId ||
        !idempotenciesByJob.has(String(quarantine.quarantineId))) integrity();
  }

  const migratedAt = new Date().toISOString();
  const next = { ...cloneJson(emptyStoreState()), ...cloneJson(decoded) } as unknown as StoreState;
  next.s8NativeEvidenceVersion = 3;
  next.s8NativeProofSchemaVersion = "s8-native-proof-v1";
  next.s8ValidationReceiptBytes = [];
  next.s8NativeProofCheckpoints = [];
  next.s8NativeTerminalOutcomes = [];
  next.s8NativeOperationAttempts = [];
  next.s8NativeAttemptQuarantines = [];
  next.s8ExportJobs = [];
  next.s8Artifacts = [];
  next.s8ValidationReceipts = [];
  const quarantines: S8QuarantineV2[] = [];
  const terminalOutcomes: S8TerminalOutcome[] = [];
  const consumedReceiptIds = new Set<string>();

  for (const job of jobs) {
    const artifact = artifactsById.get(String(job.artifactId))!;
    const prior = oldQuarantineById.get(String(job.jobId));
    const relatedAttempts = attempts.filter((attempt) => attempt.jobId === job.jobId);
    const relatedReceipts = receipts.filter((receipt) => receipt.artifactId === artifact.artifactId);
    const relatedIdempotencies = idempotenciesByJob.get(String(job.jobId)) ?? [];
    if (pristineLegacyQueued(job, artifact, relatedAttempts, relatedReceipts, relatedIdempotencies, prior)) {
      next.s8ExportJobs.push(convertQueuedLegacyJob(job));
      next.s8Artifacts.push(convertQueuedLegacyArtifact(artifact));
      continue;
    }

    const originalJob = prior ? cloneJson(prior.originalJob as Record<string, unknown>) : cloneJson(job);
    const originalArtifact = prior ? cloneJson(prior.originalArtifact as Record<string, unknown>) : cloneJson(artifact);
    const originalAttempts = prior ? cloneJson(prior.originalAttempts as Record<string, unknown>[]) : cloneJson(relatedAttempts);
    const originalReceipts = prior ? cloneJson(prior.originalValidationReceipts as Record<string, unknown>[]) : cloneJson(relatedReceipts);
    if (prior && (relatedAttempts.length !== 0 || relatedReceipts.length !== 0)) integrity();
    for (const receipt of originalReceipts) consumedReceiptIds.add(String(receipt.receiptId));
    const admissionBlock = prior?.admissionBlock === "RECONCILIATION_REQUIRED" ||
      legacyAdmissionBlock(originalAttempts) === "RECONCILIATION_REQUIRED"
      ? "RECONCILIATION_REQUIRED" : "NONE";
    const quarantineId = String(originalJob.jobId);
    const outcomeId = randomUUID();
    const originalAttemptNumber = Number(originalJob.attempt);
    const shellJob: S8ExportJobV3 = {
      ...(cloneJson(job) as unknown as S8ExportJobV3), schemaVersion: "s8-export-job-v3", status: "failed_terminal",
      publicationPhase: "source_admission", claimToken: null, ownerId: null, ownerProcessId: null, claimedAt: null,
      heartbeatAt: null, updatedAt: migratedAt, terminalAt: migratedAt, failureCode: "S8_NATIVE_LEGACY_UNPROVEN",
      nativeClaimToken: null, headCheckpointSha256: null, terminalOutcomeId: outcomeId, quarantineId, retryDecisionId: null,
    };
    const shellArtifact: S8ArtifactV3 = {
      ...(cloneJson(artifact) as unknown as S8ArtifactV3), schemaVersion: "s8-artifact-v3", status: "failed_terminal",
      publicationPhase: "source_admission", payloadSha256: null, objectHashes: null, writerReceiptHash: null,
      nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null, validationReceiptId: null,
      validationReceiptHash: null, immutableReuseFingerprint: null, privateStagingPrefix: null, privateFinalPrefix: null,
      retryOfArtifactId: null, failureCode: "S8_NATIVE_LEGACY_UNPROVEN", updatedAt: migratedAt, committedAt: null,
      staleAt: null, headCheckpointSha256: null, terminalOutcomeId: outcomeId, quarantineId,
    };
    const quarantine: S8QuarantineV2 = {
      schemaVersion: "s8-native-proof-quarantine-v2", quarantineId,
      reason: "SUCCESSOR_NATIVE_PROOF_UNPROVEN", predecessorEvidenceVersion: predecessorVersion,
      migratedAt, admissionBlock, originalJob, originalArtifact, originalAttempts, originalValidationReceipts: originalReceipts,
      originalIdempotencyRecords: cloneJson(relatedIdempotencies),
    };
    terminalOutcomes.push({ schemaVersion: "s8-native-terminal-outcome-v1", outcomeId, projectId: shellJob.projectId,
      jobId: shellJob.jobId, artifactId: shellJob.artifactId, attempt: originalAttemptNumber as 1 | 2, kind: "FAILED_TERMINAL",
      reason: "LEGACY_PROOF_UNPROVEN", nativeAttemptId: null, headCheckpointSha256: null, quarantineId, recordedAt: migratedAt });
    next.s8ExportJobs.push(shellJob);
    next.s8Artifacts.push(shellArtifact);
    quarantines.push(quarantine);
  }
  next.s8ValidationReceipts = receipts.filter((receipt) => !consumedReceiptIds.has(String(receipt.receiptId))) as unknown as S8ValidationReceiptV3[];
  next.s8NativeAttemptQuarantines = quarantines;
  next.s8NativeTerminalOutcomes = terminalOutcomes;
  next.s8IdempotencyRecords = idempotencies as unknown as StoreState["s8IdempotencyRecords"];
    validateStateShape(next, trust, binding);
  return next;
}

function checkpointDomain(kind: string): Buffer {
  const domains: Record<string, string> = {
    STAGED: "S8-NATIVE-PROOF-STAGED-V1",
    VALIDATED: "S8-NATIVE-PROOF-VALIDATED-V1",
    PROMOTED: "S8-NATIVE-PROOF-PROMOTED-V1",
    COMMITTED: "S8-NATIVE-PROOF-COMMITTED-V1",
  };
  const domain = domains[kind];
  if (!domain) return integrity();
  return Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from([0])]);
}

function issueCheckpoint(state: StoreState, trust: S8ImmutableApplicationTrust, body: Record<string, unknown>): S8Checkpoint {
  if (!trust.currentKeyId || !trust.signingKey || body.keyId !== trust.currentKeyId) return integrity();
  const signature = sign(null, Buffer.concat([checkpointDomain(String(body.kind)), Buffer.from(jcs(body), "utf8")]), trust.signingKey).toString("base64url");
  const checkpoint: S8Checkpoint = { body, signature, checkpointSha256: sha256(jcs({ body, signature })) };
  state.s8NativeProofCheckpoints!.push(checkpoint);
  return checkpoint;
}

function signedRequestBody(value: unknown, attempt: Record<string, unknown>, trust: S8ImmutableApplicationTrust): Record<string, unknown> {
  const envelope = exact(value, ["body", "signature"]);
  const body = exact(envelope.body, ["schemaVersion", "keyId", "projectId", "jobId", "artifactId", "attempt", "operation",
    "sourceSha256", "profile", "protocolVersion", "configSha256", "inputSha256", "inputBytes", "deadlineUnixMs", "nonce", "releaseHandle"]);
  const signature = envelope.signature;
  if (body.schemaVersion !== "s8-native-request-v1" || typeof body.keyId !== "string" || typeof signature !== "string" ||
      !canonicalSignature(signature) || sha256(jcs(value)) !== attempt.requestSha256 ||
      !verify(null, Buffer.concat([Buffer.from("S8-NATIVE-REQUEST-V1", "ascii"), Buffer.from([0]), Buffer.from(jcs(body), "utf8")]),
        trust.verificationKeys.get(body.keyId) ?? integrity(), Buffer.from(signature, "base64url")) ||
      body.projectId !== attempt.projectId || body.jobId !== attempt.jobId || body.artifactId !== attempt.artifactId ||
      body.attempt !== attempt.attempt || body.operation !== attempt.operation || body.sourceSha256 !== attempt.acceptedSourceDigest ||
      body.profile !== attempt.profile || body.protocolVersion !== attempt.protocolVersion || body.configSha256 !== attempt.configSha256 ||
      body.inputSha256 !== attempt.inputSha256 || body.inputBytes !== attempt.inputBytes || body.deadlineUnixMs !== attempt.deadlineUnixMs ||
      body.nonce !== attempt.requestNonce || !canonicalNonce(body.nonce) ||
      (body.operation === "WRITER" ? body.releaseHandle !== null : !canonicalNonce(body.releaseHandle))) integrity();
  return body;
}

function requireChangedPair(baseline: StoreState, working: StoreState, command: Record<string, unknown>): {
  oldJob: S8ExportJobV3; job: S8ExportJobV3; oldArtifact: S8ArtifactV3; artifact: S8ArtifactV3;
} {
  const beforeJobs = baseline.s8ExportJobs ?? [];
  const afterJobs = working.s8ExportJobs ?? [];
  const beforeArtifacts = baseline.s8Artifacts ?? [];
  const afterArtifacts = working.s8Artifacts ?? [];
  if (beforeJobs.length !== afterJobs.length || beforeArtifacts.length !== afterArtifacts.length) integrity();
  const changedJobs = beforeJobs.flatMap((before) => {
    const after = afterJobs.find((value) => value.jobId === before.jobId);
    if (!after) integrity();
    return jcs(before) === jcs(after) ? [] : [{ before, after }];
  });
  if (changedJobs.length !== 1) integrity();
  const { before: oldJob, after: job } = changedJobs[0]!;
  const oldArtifact = beforeArtifacts.find((value) => value.artifactId === oldJob.artifactId);
  const artifact = afterArtifacts.find((value) => value.artifactId === job.artifactId);
  if (!oldArtifact || !artifact || command.projectId !== job.projectId || command.jobId !== job.jobId ||
      command.artifactId !== artifact.artifactId || oldJob.projectId !== job.projectId || oldJob.artifactId !== job.artifactId ||
      oldArtifact.projectId !== artifact.projectId || oldArtifact.jobId !== artifact.jobId) integrity();
  for (const before of beforeArtifacts) {
    const after = afterArtifacts.find((value) => value.artifactId === before.artifactId);
    if (!after || before.artifactId !== oldArtifact.artifactId && jcs(before) !== jcs(after)) integrity();
  }
  return { oldJob, job, oldArtifact, artifact };
}

function assertS8ArraysUnchanged(baseline: StoreState, working: StoreState, except: readonly string[]): void {
  const ignored = new Set(except);
  for (const name of S8_GRAPH_ARRAYS) if (!ignored.has(name) && jcs(baseline[name] ?? []) !== jcs(working[name] ?? [])) integrity();
  if (!sameNonS8State(baseline, working)) integrity();
}

const OBJECT_NAMES = ["artifact.fbx", "writer-receipt.json", "native-readback.json",
  "semantic-validation-receipt.json", "publication-receipt.json"] as const;

function validateObjectRef(
  value: unknown,
  name: (typeof OBJECT_NAMES)[number],
  expectedKey: string,
  readObjectExact: (reference: unknown) => Buffer,
): Buffer {
  const item = exact(value, ["name", "contentType", "key", "sha256", "byteSize"]);
  const isArtifact = name === "artifact.fbx";
  const maximum = name === "writer-receipt.json" ? 1048576 : isArtifact ? 134217728 : 8388608;
  const minimum = isArtifact ? 28 : 1;
  if (item.name !== name || item.contentType !== (isArtifact ? "application/octet-stream" : "application/json") ||
      item.key !== expectedKey || !hash(item.sha256) || !safeInteger(item.byteSize) ||
      Number(item.byteSize) < minimum || Number(item.byteSize) > maximum) integrity();
  const bytes = readObjectExact(item);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== item.byteSize || sha256(bytes) !== item.sha256) integrity();
  return bytes;
}

function validateManifest(
  value: unknown,
  names: readonly (typeof OBJECT_NAMES)[number][],
  expectedKeys: readonly string[],
  readObjectExact: (reference: unknown) => Buffer,
): Buffer[] {
  assertArray(value);
  if (value.length !== names.length || expectedKeys.length !== names.length) integrity();
  return value.map((item, index) => validateObjectRef(item, names[index]!, expectedKeys[index]!, readObjectExact));
}

function verifyCheckpointEnvelopeSignature(
  envelope: Record<string, unknown>,
  body: Record<string, unknown>,
  kind: string,
  trust: S8ImmutableApplicationTrust,
): void {
  const signature = envelope.signature;
  if (body.kind !== kind || typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) integrity();
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.byteLength !== 64 || signatureBytes.toString("base64url") !== signature) integrity();
  const checkpointSha256 = envelope.checkpointSha256;
  if (!hash(checkpointSha256) || sha256(jcs({ body, signature })) !== checkpointSha256) integrity();
  const key = trust.verificationKeys.get(String(body.keyId));
  if (!key || !verify(null, Buffer.concat([checkpointDomain(kind), Buffer.from(jcs(body), "utf8")]), key, signatureBytes)) integrity();
}

function authenticatedPromotedFinalPrefix(
  state: StoreState,
  trust: S8ImmutableApplicationTrust,
  artifact: S8ArtifactV3,
  job: S8ExportJobV3,
  stagedBody: Record<string, unknown>,
): string | null {
  const objectHashes = artifact.objectHashes;
  if (!objectHashes || !artifact.privateFinalPrefix || artifact.projectId !== stagedBody.projectId ||
      artifact.jobId !== stagedBody.jobId || artifact.attempt !== stagedBody.attempt ||
      job.projectId !== artifact.projectId || job.jobId !== artifact.jobId || job.artifactId !== artifact.artifactId ||
      job.attempt !== artifact.attempt || job.status !== artifact.status ||
      job.nativeClaimToken !== stagedBody.nativeClaimToken || jcs(job.source) !== jcs(stagedBody.source)) return null;
  const source = stagedBody.source as Record<string, unknown>;
  const finalPrefixBase = `private/projects/${artifact.projectId}/s8/committed/${source.sourceRevisionHash}/${objectHashes.artifactSha256}/${artifact.artifactId}/${artifact.attempt}`;
  const expectedHashes = [objectHashes.artifactSha256, objectHashes.writerReceiptSha256,
    objectHashes.nativeReadbackSha256, objectHashes.semanticReceiptSha256, objectHashes.publicationReceiptSha256];

  for (const raw of state.s8NativeProofCheckpoints ?? []) {
    const rawBody = typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).body
      : undefined;
    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) continue;
    const candidate = rawBody as Record<string, unknown>;
    if (candidate.kind !== "PROMOTED" || candidate.projectId !== stagedBody.projectId ||
        candidate.jobId !== stagedBody.jobId || candidate.artifactId !== stagedBody.artifactId ||
        candidate.attempt !== stagedBody.attempt || candidate.nativeClaimToken !== stagedBody.nativeClaimToken ||
        jcs(candidate.source) !== jcs(stagedBody.source)) continue;

    const envelope = exact(raw, ["body", "signature", "checkpointSha256"]);
    const body = envelope.body as Record<string, unknown>;
    verifyCheckpointEnvelopeSignature(envelope, body, "PROMOTED", trust);
    const publicationClaim = exact(body.publicationClaim, ["claimToken", "ownerId", "ownerProcessId", "claimedAt"]);
    if (!uuid(publicationClaim.claimToken)) integrity();
    const finalPrefix = `${finalPrefixBase}/${publicationClaim.claimToken}`;
    if (artifact.privateFinalPrefix !== finalPrefix) continue;

    assertArray(body.finalObjects);
    if (body.finalObjects.length !== OBJECT_NAMES.length) integrity();
    for (let index = 0; index < OBJECT_NAMES.length; index++) {
      const name = OBJECT_NAMES[index]!;
      const reference = exact(body.finalObjects[index], ["name", "contentType", "key", "sha256", "byteSize"]);
      if (reference.name !== name || reference.key !== `${finalPrefix}/${name}` || reference.sha256 !== expectedHashes[index]) integrity();
    }
    return finalPrefix;
  }
  return null;
}

function validateCheckpoint(value: unknown, trust: S8ImmutableApplicationTrust, binding: S8ProofBindingRecord, state: StoreState): S8Checkpoint {
  const envelope = exact(value, ["body", "signature", "checkpointSha256"]);
  const body = envelope.body as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) integrity();
  const kind = body.kind;
  const suffix: Record<string, readonly string[]> = {
    STAGED: ["stagedObjects"],
    VALIDATED: ["stagedCheckpointSha256", "validatorAttemptId", "validatorAcceptanceSha256", "validationReceiptId",
      "validationReceiptHash", "validationReceiptObjectSha256", "validationReceiptObjectBytes", "validatedObjects",
      "semanticReceiptSha256", "semanticOutcome"],
    PROMOTED: ["validatedCheckpointSha256", "validatorAttemptId", "validatorAcceptanceSha256", "validationReceiptId",
      "validationReceiptHash", "publicationClaim", "sourceFence", "publicationReceiptSha256", "publicationReceiptBytes",
      "finalObjects", "readbackManifest", "readbackManifestSha256"],
    COMMITTED: ["promotionCheckpointSha256", "validatedCheckpointSha256", "validatorAttemptId", "validatorAcceptanceSha256",
      "validationReceiptId", "validationReceiptHash", "publicationClaim", "sourceFence", "finalObjects",
      "publicationReceiptSha256", "readbackManifestSha256", "committedAt"],
  };
  const extras = suffix[String(kind)];
  if (!extras) integrity();
  exact(body, [...COMMON_CHECKPOINT_KEYS, ...extras]);
  if (body.schemaVersion !== "s8-native-proof-checkpoint-v1" || !uuid(body.checkpointId) ||
      !string(body.keyId, 80) || !uuid(body.projectId) || !uuid(body.jobId) || !uuid(body.artifactId) ||
      (body.attempt !== 1 && body.attempt !== 2) || !uuid(body.nativeClaimToken) ||
      !hash(body.acceptedSourceDigest) || !hash(body.payloadSha256) || !uuid(body.writerAttemptId) ||
      !hash(body.writerAcceptanceSha256) || !hash(body.releaseManifestSha256) || !hash(body.resourcePolicySha256) ||
      !timestamp(body.issuedAt) || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 ||
      Number(body.sequence) > 2147483647) integrity();
  validateSourceStamp(body.source, String(body.projectId));
  if (!uuid(body.nativeClaimToken) || body.acceptedSourceDigest !== sha256(jcs(body.source)) ||
      !hash(body.payloadSha256) || !hash(body.writerAcceptanceSha256) ||
      !hash(body.releaseManifestSha256) || !hash(body.resourcePolicySha256)) integrity();
  const stagedPrefix = `private/projects/${body.projectId}/s8/staging/${body.artifactId}/${body.nativeClaimToken}`;
  const finalPrefix = `private/projects/${body.projectId}/s8/committed/${(body.source as Record<string, unknown>).sourceRevisionHash}`;
  const artifact = (state.s8Artifacts ?? []).find((item) => item.artifactId === body.artifactId) as S8ArtifactV3 | undefined;
  const job = (state.s8ExportJobs ?? []).find((item) => item.jobId === body.jobId) as S8ExportJobV3 | undefined;
  const objectHashes = artifact?.objectHashes;
  const historicalStageFallback = (kind === "STAGED" || kind === "VALIDATED") && artifact && job && objectHashes &&
    (artifact.status === "promoted" || artifact.status === "committed") && job.status === artifact.status &&
    artifact.projectId === body.projectId && artifact.jobId === body.jobId && artifact.attempt === body.attempt &&
    job.projectId === body.projectId && job.artifactId === body.artifactId && job.attempt === body.attempt &&
    job.nativeClaimToken === body.nativeClaimToken && jcs(artifact.source) === jcs(body.source) &&
    jcs(job.source) === jcs(body.source)
    ? authenticatedPromotedFinalPrefix(state, trust, artifact, job, body)
    : null;
  const stagedObjectHashes: Record<string, unknown> = {
    "artifact.fbx": objectHashes?.artifactSha256,
    "writer-receipt.json": objectHashes?.writerReceiptSha256,
    "native-readback.json": objectHashes?.nativeReadbackSha256,
    "semantic-validation-receipt.json": objectHashes?.semanticReceiptSha256,
  };
  const readStagedObjectExact = (reference: unknown): Buffer => {
    try { return binding.readObjectExact(reference); }
    catch (error) {
      if (!historicalStageFallback || !(error instanceof AppError) || error.code !== "ASSET_NOT_FOUND") throw error;
      const item = exact(reference, ["name", "contentType", "key", "sha256", "byteSize"]);
      if (typeof item.name !== "string" || item.sha256 !== stagedObjectHashes[item.name]) integrity();
      let bytes: Buffer;
      try { bytes = binding.readObjectExact({ ...item, key: `${historicalStageFallback}/${item.name}` }); }
      catch (fallbackError) {
        if (fallbackError instanceof AppError && fallbackError.code === "ASSET_NOT_FOUND") {
          throw new AppError(409, "S8_PUBLICATION_OBJECT_MISMATCH");
        }
        throw fallbackError;
      }
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== item.byteSize || sha256(bytes) !== item.sha256) {
        throw new AppError(409, "S8_PUBLICATION_OBJECT_MISMATCH");
      }
      return bytes;
    }
  };
  let stagedBytes: Buffer[] = [];
  if (kind === "STAGED") {
    stagedBytes = validateManifest(body.stagedObjects, OBJECT_NAMES.slice(0, 2),
      OBJECT_NAMES.slice(0, 2).map((name) => `${stagedPrefix}/${name}`), readStagedObjectExact);
  } else if (kind === "VALIDATED") {
    stagedBytes = validateManifest(body.validatedObjects, OBJECT_NAMES.slice(0, 4),
      OBJECT_NAMES.slice(0, 4).map((name) => `${stagedPrefix}/${name}`), readStagedObjectExact);
  } else {
    const publicationClaim = exact(body.publicationClaim, ["claimToken", "ownerId", "ownerProcessId", "claimedAt"]);
    if (!uuid(publicationClaim.claimToken) || !ownerId(publicationClaim.ownerId) || publicationClaim.ownerId === null ||
        !safeInteger(publicationClaim.ownerProcessId) || Number(publicationClaim.ownerProcessId) < 1 ||
        Number(publicationClaim.ownerProcessId) > 2147483647 || !timestamp(publicationClaim.claimedAt)) integrity();
    const fbxRef = exact((body.finalObjects as unknown[])?.[0], ["name", "contentType", "key", "sha256", "byteSize"]);
    if (!hash(fbxRef.sha256)) integrity();
    const finalBase = `${finalPrefix}/${fbxRef.sha256}/${body.artifactId}/${body.attempt}/${publicationClaim.claimToken}`;
    stagedBytes = validateManifest(body.finalObjects, OBJECT_NAMES,
      OBJECT_NAMES.map((name) => `${finalBase}/${name}`), binding.readObjectExact);
    const fence = exact(body.sourceFence, ["source", "checkedAt"]);
    validateSourceStamp(fence.source, String(body.projectId));
    if (jcs(fence.source) !== jcs(body.source) || !timestamp(fence.checkedAt)) integrity();
    if (kind === "PROMOTED") {
      const readback = exact(body.readbackManifest, ["schemaVersion", "projectId", "jobId", "artifactId", "attempt",
        "publicationClaimToken", "validatedCheckpointSha256", "checkedAt", "objects"]);
      if (readback.schemaVersion !== "s8-native-final-readback-v1" || readback.projectId !== body.projectId ||
          readback.jobId !== body.jobId || readback.artifactId !== body.artifactId || readback.attempt !== body.attempt ||
          readback.publicationClaimToken !== publicationClaim.claimToken ||
          readback.validatedCheckpointSha256 !== body.validatedCheckpointSha256 ||
          !timestamp(readback.checkedAt) || jcs(readback.objects) !== jcs(body.finalObjects) ||
          !hash(body.readbackManifestSha256) || sha256(jcs(readback)) !== body.readbackManifestSha256 ||
          !safeInteger(body.publicationReceiptBytes) || Number(body.publicationReceiptBytes) < 1 ||
          Number(body.publicationReceiptBytes) > 8388608) integrity();
      if (body.publicationReceiptSha256 !== (body.finalObjects as Record<string, unknown>[])[4]?.sha256 ||
          body.publicationReceiptBytes !== (body.finalObjects as Record<string, unknown>[])[4]?.byteSize) integrity();
    } else if (body.publicationReceiptSha256 !== (body.finalObjects as Record<string, unknown>[])[4]?.sha256 ||
        !hash(body.readbackManifestSha256) || !timestamp(body.committedAt) || body.committedAt !== body.issuedAt) integrity();
  }
  if (kind === "VALIDATED" && (body.semanticOutcome !== "pass" || !hash(body.semanticReceiptSha256) ||
      !hash(body.stagedCheckpointSha256) || !uuid(body.validatorAttemptId) || !hash(body.validatorAcceptanceSha256) ||
      !uuid(body.validationReceiptId) || !hash(body.validationReceiptHash) ||
      !hash(body.validationReceiptObjectSha256) || !safeInteger(body.validationReceiptObjectBytes) ||
      Number(body.validationReceiptObjectBytes) < 1 || Number(body.validationReceiptObjectBytes) > 8388608)) integrity();
  if (kind === "PROMOTED" || kind === "COMMITTED") {
    if (!hash(body.validatedCheckpointSha256) || !uuid(body.validatorAttemptId) || !hash(body.validatorAcceptanceSha256) ||
        !uuid(body.validationReceiptId) || !hash(body.validationReceiptHash)) integrity();
  }
  if (kind === "COMMITTED" && (!hash(body.promotionCheckpointSha256) ||
      body.promotionCheckpointSha256 !== body.previousCheckpointSha256)) integrity();
  void stagedBytes;
  if (kind === "STAGED" && (body.sequence !== 1 || body.previousCheckpointSha256 !== null)) integrity();
  if (kind === "VALIDATED" && (body.sequence !== 2 || !hash(body.previousCheckpointSha256))) integrity();
  if ((kind === "PROMOTED" || kind === "COMMITTED") &&
      (Number(body.sequence) < 3 || !hash(body.previousCheckpointSha256))) integrity();
  verifyCheckpointEnvelopeSignature(envelope, body, String(kind), trust);
  return value as S8Checkpoint;
}

function validateStateShape(state: StoreState, trust: S8ImmutableApplicationTrust, binding: S8ProofBindingRecord): void {
  if (state.s8NativeEvidenceVersion !== 3 || state.s8NativeProofSchemaVersion !== "s8-native-proof-v1") integrity();
  const names = [
    "s8ExportJobs", "s8Artifacts", "s8ValidationReceipts", "s8ValidationReceiptBytes",
    "s8IdempotencyRecords", "s8NativeOperationAttempts", "s8NativeProofCheckpoints",
    "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines",
  ] as const;
  for (const name of names) assertArray(state[name]);
  const jobs = state.s8ExportJobs as S8ExportJobV3[];
  const artifacts = state.s8Artifacts as S8ArtifactV3[];
  const jobKeys = [
    "schemaVersion", "jobId", "projectId", "artifactId", "source", "inputHash", "idempotencyKey",
    "status", "publicationPhase", "attempt", "claimToken", "nativeClaimToken", "ownerId", "ownerProcessId",
    "claimedAt", "heartbeatAt", "createdAt", "updatedAt", "terminalAt", "failureCode",
    "headCheckpointSha256", "terminalOutcomeId", "quarantineId", "retryDecisionId",
  ];
  const artifactKeys = [
    "schemaVersion", "artifactId", "projectId", "jobId", "source", "inputHash", "profile", "format",
    "mimeType", "downloadFileName", "status", "publicationPhase", "payloadSha256", "objectHashes",
    "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "publicationReceiptHash",
    "validationReceiptId", "validationReceiptHash", "immutableReuseFingerprint", "privateStagingPrefix",
    "privateFinalPrefix", "attempt", "retryOfArtifactId", "failureCode", "createdAt", "updatedAt",
    "committedAt", "staleAt", "headCheckpointSha256", "terminalOutcomeId", "quarantineId",
  ];
  const jobById = new Map<string, S8ExportJobV3>();
  const artifactById = new Map<string, S8ArtifactV3>();
  for (const value of jobs) {
    exact(value, jobKeys);
    if (value.schemaVersion !== "s8-export-job-v3" || !uuid(value.jobId) || !uuid(value.projectId) ||
        !uuid(value.artifactId) || !hash(value.inputHash) || !string(value.idempotencyKey, 240) ||
        (value.attempt !== 1 && value.attempt !== 2) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) integrity();
    validateSourceStamp(value.source, value.projectId);
    if (!EXPORT_STATUSES.has(value.status) || !PUBLICATION_PHASES.has(value.publicationPhase) ||
        !nullableUuid(value.claimToken) || !nullableUuid(value.nativeClaimToken) ||
        !ownerId(value.ownerId) || (value.ownerProcessId !== null &&
          (!Number.isSafeInteger(value.ownerProcessId) || Number(value.ownerProcessId) < 1 || Number(value.ownerProcessId) > 2147483647)) ||
        !nullableTimestamp(value.claimedAt) || !nullableTimestamp(value.heartbeatAt) ||
        !nullableTimestamp(value.terminalAt) || (value.failureCode !== null && !string(value.failureCode, 120)) ||
        !nullableHash(value.headCheckpointSha256) || !nullableUuid(value.terminalOutcomeId) ||
        !nullableUuid(value.quarantineId) || !nullableUuid(value.retryDecisionId)) integrity();
    if ((value.claimToken === null) !== (value.ownerId === null) ||
        (value.claimToken === null) !== (value.ownerProcessId === null) ||
        (value.claimToken === null) !== (value.claimedAt === null) ||
        (value.claimToken === null) !== (value.heartbeatAt === null)) integrity();
    if (jobById.has(value.jobId)) integrity();
    jobById.set(value.jobId, value);
  }
  for (const value of artifacts) {
    exact(value, artifactKeys);
    if (value.schemaVersion !== "s8-artifact-v3" || !uuid(value.artifactId) || !uuid(value.projectId) ||
        !uuid(value.jobId) || value.profile !== "swooshz-fbx-static-mesh-v1" || value.format !== "fbx" ||
        value.mimeType !== "application/octet-stream" || value.downloadFileName !== "swooshz-s8-scene.fbx" ||
        !hash(value.inputHash) || (value.attempt !== 1 && value.attempt !== 2) ||
        value.retryOfArtifactId !== null || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) integrity();
    validateSourceStamp(value.source, value.projectId);
    if (!EXPORT_STATUSES.has(value.status) || !PUBLICATION_PHASES.has(value.publicationPhase) ||
        (value.payloadSha256 !== null && !hash(value.payloadSha256)) ||
        (value.writerReceiptHash !== null && !hash(value.writerReceiptHash)) ||
        (value.nativeReadbackHash !== null && !hash(value.nativeReadbackHash)) ||
        (value.semanticReceiptHash !== null && !hash(value.semanticReceiptHash)) ||
        (value.publicationReceiptHash !== null && !hash(value.publicationReceiptHash)) ||
        !nullableUuid(value.validationReceiptId) || !nullableHash(value.validationReceiptHash) ||
        !nullableHash(value.immutableReuseFingerprint) ||
        (value.privateStagingPrefix !== null && !string(value.privateStagingPrefix, 1024)) ||
        (value.privateFinalPrefix !== null && !string(value.privateFinalPrefix, 1024)) ||
        (value.failureCode !== null && !string(value.failureCode, 120)) ||
        !nullableTimestamp(value.committedAt) || !nullableTimestamp(value.staleAt) ||
        !nullableHash(value.headCheckpointSha256) || !nullableUuid(value.terminalOutcomeId) ||
        !nullableUuid(value.quarantineId)) integrity();
    if (value.objectHashes !== null) {
      const hashes = exact(value.objectHashes, ["artifactSha256", "artifactByteSize", "writerReceiptSha256",
        "nativeReadbackSha256", "semanticReceiptSha256", "publicationReceiptSha256"]);
      if (!hash(hashes.artifactSha256) || !Number.isSafeInteger(hashes.artifactByteSize) ||
          Number(hashes.artifactByteSize) < 28 || Number(hashes.artifactByteSize) > 134217728 ||
        !hash(hashes.writerReceiptSha256) || !hash(hashes.nativeReadbackSha256) ||
        !hash(hashes.semanticReceiptSha256) || !nullableHash(hashes.publicationReceiptSha256) ||
        ((value.status === "promoted" || value.status === "committed") !== (hashes.publicationReceiptSha256 !== null))) integrity();
    }
    if (artifactById.has(value.artifactId)) integrity();
    artifactById.set(value.artifactId, value);
  }
  for (const job of jobs) {
    const artifact = artifactById.get(job.artifactId);
    if (!artifact || artifact.jobId !== job.jobId || artifact.projectId !== job.projectId ||
        jcs(artifact.source) !== jcs(job.source) || artifact.attempt !== job.attempt ||
        artifact.status !== job.status || artifact.publicationPhase !== job.publicationPhase ||
        artifact.headCheckpointSha256 !== job.headCheckpointSha256 ||
        artifact.terminalOutcomeId !== job.terminalOutcomeId || artifact.quarantineId !== job.quarantineId) integrity();
  }
  const receiptsById = validateValidationReceipts(state);
  for (const artifact of artifacts) {
    if ((artifact.validationReceiptId === null) !== (artifact.validationReceiptHash === null)) integrity();
    if (artifact.validationReceiptId !== null) {
      const receipt = receiptsById.get(artifact.validationReceiptId);
      if (!receipt || receipt.receiptHash !== artifact.validationReceiptHash || receipt.artifactId !== artifact.artifactId ||
          receipt.projectId !== artifact.projectId || receipt.jobId !== artifact.jobId || receipt.attempt !== artifact.attempt ||
          receipt.nativeClaimToken !== jobById.get(artifact.jobId)!.nativeClaimToken ||
          receipt.immutableReuseFingerprint !== artifact.immutableReuseFingerprint ||
          receipt.artifactSha256 !== artifact.objectHashes?.artifactSha256 ||
          receipt.artifactByteSize !== artifact.objectHashes?.artifactByteSize) integrity();
    }
  }

  const attemptByIdentity = new Map<string, Record<string, unknown>>();
  const nativeAttemptIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  const retryIds = new Set<string>();
  for (const raw of state.s8NativeOperationAttempts!) {
    const checked = validateNativeAttempt(raw, trust);
    const attempt = checked.attempt;
    const identity = [attempt.jobId, attempt.attempt, attempt.operation].join(":");
    const job = jobById.get(String(attempt.jobId));
    const artifact = job ? artifactById.get(job.artifactId) : undefined;
    if (nativeAttemptIds.has(String(attempt.attemptId)) || attemptByIdentity.has(identity) || !job || !artifact ||
        job.projectId !== attempt.projectId || job.artifactId !== attempt.artifactId ||
        attempt.acceptedSourceDigest !== sha256(jcs(job.source)) ||
        Number(attempt.attempt) === job.attempt && attempt.claimToken !== job.nativeClaimToken ||
        Number(attempt.attempt) > job.attempt) integrity();
    nativeAttemptIds.add(String(attempt.attemptId));
    attemptByIdentity.set(identity, attempt);
    if (checked.acceptanceId) {
      if (acceptanceIds.has(checked.acceptanceId)) integrity();
      acceptanceIds.add(checked.acceptanceId);
    }
    if (checked.retryId) {
      if (retryIds.has(checked.retryId)) integrity();
      retryIds.add(checked.retryId);
    }
  }
  for (const attempt of attemptByIdentity.values()) {
    if (attempt.operation !== "VALIDATOR") continue;
    const writer = attemptByIdentity.get([attempt.jobId, attempt.attempt, "WRITER"].join(":"));
    const writerAcceptance = writer?.acceptanceReceipt
      ? (writer.acceptanceReceipt as { body?: Record<string, unknown> }).body
      : undefined;
    if (!writer || writer.state !== "SUCCEEDED" || !writerAcceptance || attempt.state === "SUCCEEDED" &&
        (attempt.claimToken !== writer.claimToken || attempt.acceptedSourceDigest !== writer.acceptedSourceDigest ||
         attempt.releaseManifestSha256 !== writer.releaseManifestSha256 || attempt.inputSha256 !== writerAcceptance.outputSha256 ||
         attempt.inputBytes !== writerAcceptance.outputBytes)) integrity();
  }

  const idempotencyKeys = new Set<string>();
  const idempotencyRowsByJob = new Map<string, Record<string, unknown>[]>();
  for (const raw of state.s8IdempotencyRecords!) {
    const item = exact(raw, ["schemaVersion", "projectId", "operation", "idempotencyKey", "inputHash", "source", "jobId", "artifactId", "createdAt"]);
    if (item.schemaVersion !== "s8-idempotency-v2" || !uuid(item.projectId) || item.operation !== "export" ||
        !string(item.idempotencyKey, 240) || !hash(item.inputHash) || !uuid(item.jobId) || !uuid(item.artifactId) ||
        !timestamp(item.createdAt)) integrity();
    validateSourceStamp(item.source, String(item.projectId));
    const key = [item.projectId, item.idempotencyKey].join(":");
    const job = jobById.get(String(item.jobId));
    if (idempotencyKeys.has(key) || !job || job.artifactId !== item.artifactId || job.inputHash !== item.inputHash ||
        jcs(job.source) !== jcs(item.source) || job.idempotencyKey !== item.idempotencyKey) integrity();
    idempotencyKeys.add(key);
    const rows = idempotencyRowsByJob.get(String(item.jobId)) ?? [];
    rows.push(item);
    idempotencyRowsByJob.set(String(item.jobId), rows);
  }

  const outcomes = new Map<string, Record<string, unknown>>();
  for (const raw of state.s8NativeTerminalOutcomes!) {
    const outcome = exact(raw, ["schemaVersion", "outcomeId", "projectId", "jobId", "artifactId", "attempt", "kind", "reason",
      "nativeAttemptId", "headCheckpointSha256", "quarantineId", "recordedAt"]);
    if (outcome.schemaVersion !== "s8-native-terminal-outcome-v1" || !uuid(outcome.outcomeId) || !uuid(outcome.projectId) ||
        !uuid(outcome.jobId) || !uuid(outcome.artifactId) || (outcome.attempt !== 1 && outcome.attempt !== 2) ||
        !["FAILED_TERMINAL", "STALE", "ABORTED"].includes(String(outcome.kind)) ||
        !["NATIVE_PERMANENT_FAILURE", "NATIVE_TIMEOUT", "NATIVE_CLOCK_INVALID", "SOURCE_STALE", "SOURCE_NOT_READY",
          "SEMANTIC_FAILED", "ACCEPTED_BYTES_UNAVAILABLE", "PUBLICATION_FAILED", "RECONCILIATION_REQUIRED",
          "LEGACY_PROOF_UNPROVEN", "ABORTED_BEFORE_DISPATCH"].includes(String(outcome.reason)) ||
        !nullableUuid(outcome.nativeAttemptId) || !nullableHash(outcome.headCheckpointSha256) || !nullableUuid(outcome.quarantineId) ||
        !timestamp(outcome.recordedAt) || outcomes.has(String(outcome.outcomeId))) integrity();
    outcomes.set(String(outcome.outcomeId), outcome);
  }
  for (const job of jobs) {
    if (job.terminalOutcomeId !== null) {
      const outcome = outcomes.get(job.terminalOutcomeId);
      const artifact = artifactById.get(job.artifactId)!;
      if (!outcome || outcome.jobId !== job.jobId || outcome.projectId !== job.projectId ||
          outcome.artifactId !== job.artifactId || outcome.attempt !== job.attempt ||
          artifact.terminalOutcomeId !== outcome.outcomeId) integrity();
    }
  }

  const quarantineIds = new Set<string>();
  for (const raw of state.s8NativeAttemptQuarantines!) {
    const quarantine = exact(raw, ["schemaVersion", "quarantineId", "reason", "predecessorEvidenceVersion", "migratedAt",
      "admissionBlock", "originalJob", "originalArtifact", "originalAttempts", "originalValidationReceipts", "originalIdempotencyRecords"]);
    if (quarantine.schemaVersion !== "s8-native-proof-quarantine-v2" || !uuid(quarantine.quarantineId) ||
        quarantine.reason !== "SUCCESSOR_NATIVE_PROOF_UNPROVEN" ||
        ![null, 1, 2].includes(quarantine.predecessorEvidenceVersion as null | number) ||
        !timestamp(quarantine.migratedAt) || !["NONE", "RECONCILIATION_REQUIRED"].includes(String(quarantine.admissionBlock)) ||
        typeof quarantine.originalJob !== "object" || quarantine.originalJob === null || Array.isArray(quarantine.originalJob) ||
        typeof quarantine.originalArtifact !== "object" || quarantine.originalArtifact === null || Array.isArray(quarantine.originalArtifact) ||
        !Array.isArray(quarantine.originalAttempts) || !Array.isArray(quarantine.originalValidationReceipts) ||
        !Array.isArray(quarantine.originalIdempotencyRecords) || quarantineIds.has(String(quarantine.quarantineId))) integrity();
    quarantineIds.add(String(quarantine.quarantineId));
    const terminalJob = jobById.get(String(quarantine.quarantineId));
    const terminalArtifact = terminalJob && artifactById.get(terminalJob.artifactId);
    const originalJob = validateLegacyJob(quarantine.originalJob);
    const originalArtifact = validateLegacyArtifact(quarantine.originalArtifact);
    if (originalJob.jobId !== quarantine.quarantineId || originalArtifact.jobId !== originalJob.jobId ||
        originalArtifact.artifactId !== originalJob.artifactId || originalArtifact.projectId !== originalJob.projectId ||
        !terminalJob || !terminalArtifact || terminalJob.jobId !== originalJob.jobId ||
        terminalJob.projectId !== originalJob.projectId || terminalJob.artifactId !== originalJob.artifactId ||
        terminalJob.inputHash !== originalJob.inputHash || terminalJob.idempotencyKey !== originalJob.idempotencyKey ||
        jcs(terminalJob.source) !== jcs(originalJob.source) || terminalJob.attempt !== originalJob.attempt ||
        terminalArtifact.projectId !== originalArtifact.projectId || terminalArtifact.jobId !== originalArtifact.jobId ||
        terminalArtifact.inputHash !== originalArtifact.inputHash || terminalArtifact.attempt !== originalArtifact.attempt ||
        jcs(terminalArtifact.source) !== jcs(originalArtifact.source)) integrity();
    const originalAttempts = (quarantine.originalAttempts as unknown[]).map((attempt) => validateAnyLegacyAttempt(attempt, trust));
    const originalAttemptIds = new Set<string>();
    const originalAttemptTuples = new Set<string>();
    for (const attempt of originalAttempts) {
      const tuple = [attempt.jobId, attempt.attempt, attempt.operation].join(":");
      if (attempt.jobId !== originalJob.jobId || attempt.projectId !== originalJob.projectId ||
          attempt.artifactId !== originalArtifact.artifactId || Number(attempt.attempt) > Number(originalJob.attempt) ||
          originalAttemptIds.has(String(attempt.attemptId)) || originalAttemptTuples.has(tuple)) integrity();
      originalAttemptIds.add(String(attempt.attemptId));
      originalAttemptTuples.add(tuple);
    }
    const originalReceipts = (quarantine.originalValidationReceipts as unknown[]).map(validateLegacyReceipt);
    const originalReceiptIds = new Set<string>();
    for (const receipt of originalReceipts) {
      if (receipt.projectId !== originalJob.projectId || receipt.artifactId !== originalArtifact.artifactId ||
          receipt.payloadSha256 !== originalArtifact.payloadSha256 || jcs(receipt.source) !== jcs(originalJob.source) ||
          originalReceiptIds.has(String(receipt.receiptId))) integrity();
      originalReceiptIds.add(String(receipt.receiptId));
    }
    const originalIdempotencies = (quarantine.originalIdempotencyRecords as unknown[]).map(validateLegacyIdempotency);
    const originalKeys = new Set<string>();
    for (const item of originalIdempotencies) {
      const key = `${item.projectId}:${item.idempotencyKey}`;
      if (item.projectId !== originalJob.projectId || item.jobId !== originalJob.jobId ||
          item.artifactId !== originalArtifact.artifactId || item.inputHash !== originalJob.inputHash ||
          item.idempotencyKey !== originalJob.idempotencyKey || jcs(item.source) !== jcs(originalJob.source) ||
          originalKeys.has(key)) integrity();
      originalKeys.add(key);
    }
    const activeIdempotencies = idempotencyRowsByJob.get(originalJob.jobId) ?? [];
    const outcome = terminalJob ? outcomes.get(String(terminalJob.terminalOutcomeId)) : undefined;
    if (!terminalJob || !terminalArtifact || terminalJob.quarantineId !== quarantine.quarantineId ||
        terminalArtifact.quarantineId !== quarantine.quarantineId || terminalJob.status !== "failed_terminal" ||
        terminalArtifact.status !== "failed_terminal" || terminalJob.publicationPhase !== "source_admission" ||
        terminalArtifact.publicationPhase !== "source_admission" || terminalJob.failureCode !== "S8_NATIVE_LEGACY_UNPROVEN" ||
        terminalArtifact.failureCode !== "S8_NATIVE_LEGACY_UNPROVEN" || terminalJob.claimToken !== null ||
        terminalJob.nativeClaimToken !== null || terminalJob.ownerId !== null || terminalJob.ownerProcessId !== null ||
        terminalJob.claimedAt !== null || terminalJob.heartbeatAt !== null || terminalJob.headCheckpointSha256 !== null ||
        terminalJob.retryDecisionId !== null || terminalArtifact.headCheckpointSha256 !== null ||
        terminalArtifact.payloadSha256 !== null || terminalArtifact.objectHashes !== null ||
        terminalArtifact.writerReceiptHash !== null || terminalArtifact.nativeReadbackHash !== null ||
        terminalArtifact.semanticReceiptHash !== null || terminalArtifact.publicationReceiptHash !== null ||
        terminalArtifact.validationReceiptId !== null || terminalArtifact.validationReceiptHash !== null ||
        terminalArtifact.immutableReuseFingerprint !== null || terminalArtifact.privateStagingPrefix !== null ||
        terminalArtifact.privateFinalPrefix !== null || terminalArtifact.retryOfArtifactId !== null ||
        activeIdempotencies.length !== originalIdempotencies.length || jcs(activeIdempotencies) !== jcs(originalIdempotencies) ||
        state.s8NativeOperationAttempts!.some((attempt) => (attempt as Record<string, unknown>).jobId === originalJob.jobId) ||
        state.s8ValidationReceipts!.some((receipt) => (receipt as Record<string, unknown>).jobId === originalJob.jobId) ||
        !outcome || outcome.kind !== "FAILED_TERMINAL" || outcome.reason !== "LEGACY_PROOF_UNPROVEN" ||
        outcome.quarantineId !== quarantine.quarantineId ||
        (quarantine.admissionBlock === "RECONCILIATION_REQUIRED" ?
          legacyAdmissionBlock(originalAttempts) !== "RECONCILIATION_REQUIRED" :
          legacyAdmissionBlock(originalAttempts) !== "NONE")) integrity();
  }

  const checkpointById = new Map<string, S8Checkpoint>();
  const checkpointByHash = new Map<string, S8Checkpoint>();
  const chainMap = new Map<string, S8Checkpoint[]>();
  for (const raw of state.s8NativeProofCheckpoints!) {
    const checkpoint = validateCheckpoint(raw, trust, binding, state);
    const body = checkpoint.body as Record<string, unknown>;
    const checkpointId = String(body.checkpointId);
    if (checkpointById.has(checkpointId) || checkpointByHash.has(checkpoint.checkpointSha256)) integrity();
    checkpointById.set(checkpointId, checkpoint);
    checkpointByHash.set(checkpoint.checkpointSha256, checkpoint);
    const key = [body.projectId, body.jobId, body.artifactId, body.attempt].join(":");
    const chain = chainMap.get(key) ?? [];
    chain.push(checkpoint);
    chainMap.set(key, chain);
  }
  for (const [key, chain] of chainMap) {
    chain.sort((a, b) => Number(a.body.sequence) - Number(b.body.sequence));
    const [projectId, jobId, artifactId, attemptText] = key.split(":");
    const job = jobById.get(jobId!);
    const artifact = artifactById.get(artifactId!);
    const attemptNumber = Number(attemptText);
    const writerAttempt = attemptByIdentity.get([jobId, attemptNumber, "WRITER"].join(":"));
    const writerAcceptance = writerAttempt?.acceptanceReceipt as { body?: Record<string, unknown>; receiptSha256?: string } | undefined;
    if (!job || !artifact || !writerAttempt || writerAttempt.state !== "SUCCEEDED" || !writerAcceptance?.body ||
        job.projectId !== projectId || artifact.projectId !== projectId || artifact.jobId !== jobId ||
        artifact.attempt < attemptNumber || writerAttempt.projectId !== projectId ||
        writerAttempt.artifactId !== artifactId || !writerAcceptance.receiptSha256) integrity();
    for (let i = 0; i < chain.length; i++) {
      const item = chain[i]!;
      const body = item.body as Record<string, unknown>;
      if (Number(body.sequence) !== i + 1 || body.projectId !== projectId || body.jobId !== jobId ||
          body.artifactId !== artifactId || body.attempt !== attemptNumber || body.nativeClaimToken !== writerAttempt.claimToken ||
          jcs(body.source) !== jcs(job.source) || body.acceptedSourceDigest !== sha256(jcs(job.source)) ||
          body.payloadSha256 !== job.inputHash || body.writerAttemptId !== writerAttempt.attemptId ||
          body.writerAcceptanceSha256 !== writerAcceptance.receiptSha256 ||
          body.releaseManifestSha256 !== writerAcceptance.body.releaseManifestSha256 ||
          body.resourcePolicySha256 !== writerAcceptance.body.resourcePolicySha256) integrity();
      if (i === 0 ? body.kind !== "STAGED" : body.previousCheckpointSha256 !== chain[i - 1]!.checkpointSha256) integrity();
      if (i === 1 && item.body.kind !== "VALIDATED") integrity();
      if (i >= 2 && item.body.kind !== "PROMOTED" && item.body.kind !== "COMMITTED") integrity();
      if (i < chain.length - 1 && item.body.kind === "COMMITTED") integrity();
      if (body.kind === "STAGED") {
        const objects = body.stagedObjects as Record<string, unknown>[];
        if (objects[0]?.sha256 !== writerAcceptance.body.outputSha256 ||
            objects[0]?.byteSize !== writerAcceptance.body.outputBytes ||
            objects[1]?.sha256 !== writerAcceptance.body.auxiliarySha256 ||
            objects[1]?.byteSize !== writerAcceptance.body.auxiliaryBytes) integrity();
      }
      if (body.kind === "VALIDATED") {
        const staged = chain[0]!;
        const validator = attemptByIdentity.get([jobId, attemptNumber, "VALIDATOR"].join(":"));
        const validatorAcceptance = validator?.acceptanceReceipt as { body?: Record<string, unknown>; receiptSha256?: string } | undefined;
        const receipt = receiptsById.get(String(body.validationReceiptId));
        const validationBytes = state.s8ValidationReceiptBytes!.find((entry) => entry.receiptId === body.validationReceiptId);
        const stagedObjects = (staged.body as Record<string, unknown>).stagedObjects;
        const validatedObjects = body.validatedObjects as Record<string, unknown>[];
        if (body.stagedCheckpointSha256 !== staged.checkpointSha256 || !validator || validator.state !== "SUCCEEDED" ||
            !validatorAcceptance?.body || !validatorAcceptance.receiptSha256 ||
            body.validatorAttemptId !== validator.attemptId || body.validatorAcceptanceSha256 !== validatorAcceptance.receiptSha256 ||
            !receipt || !validationBytes || receipt.receiptHash !== body.validationReceiptHash ||
            receipt.jobId !== jobId || receipt.projectId !== projectId || receipt.artifactId !== artifactId ||
            receipt.attempt !== attemptNumber || receipt.nativeClaimToken !== writerAttempt.claimToken ||
            receipt.acceptedSourceDigest !== body.acceptedSourceDigest || receipt.payloadSha256 !== body.payloadSha256 ||
            receipt.writerAttemptId !== writerAttempt.attemptId || receipt.writerAcceptanceSha256 !== writerAcceptance.receiptSha256 ||
            receipt.validatorAttemptId !== validator.attemptId || receipt.validatorAcceptanceSha256 !== validatorAcceptance.receiptSha256 ||
            receipt.stagedCheckpointSha256 !== staged.checkpointSha256 ||
            receipt.releaseManifestSha256 !== body.releaseManifestSha256 ||
            receipt.resourcePolicySha256 !== body.resourcePolicySha256 ||
            receipt.semanticReceiptHash !== body.semanticReceiptSha256 ||
            validatedObjects[0]?.sha256 !== writerAcceptance.body.outputSha256 ||
            validatedObjects[0]?.byteSize !== writerAcceptance.body.outputBytes ||
            validatedObjects[1]?.sha256 !== writerAcceptance.body.auxiliarySha256 ||
            validatedObjects[1]?.byteSize !== writerAcceptance.body.auxiliaryBytes ||
            validatedObjects[2]?.sha256 !== validatorAcceptance.body.outputSha256 ||
            validatedObjects[2]?.byteSize !== validatorAcceptance.body.outputBytes ||
            validatedObjects[3]?.sha256 !== receipt.semanticReceiptHash ||
            receipt.artifactSha256 !== validatedObjects[0]?.sha256 || receipt.artifactByteSize !== validatedObjects[0]?.byteSize ||
            receipt.writerReceiptHash !== validatedObjects[1]?.sha256 || receipt.writerReceiptBytes !== validatedObjects[1]?.byteSize ||
            receipt.nativeReadbackHash !== validatedObjects[2]?.sha256 || receipt.nativeReadbackBytes !== validatedObjects[2]?.byteSize ||
            receipt.semanticReceiptBytes !== validatedObjects[3]?.byteSize ||
            body.validationReceiptObjectSha256 !== validationBytes.sha256 ||
            body.validationReceiptObjectBytes !== validationBytes.byteSize ||
            jcs(validatedObjects.slice(0, 2)) !== jcs(stagedObjects)) integrity();
      }
      if (i > 0 && body.kind === "PROMOTED") {
        const validated = chain[1]!;
        if (body.validatedCheckpointSha256 !== validated.checkpointSha256 ||
            body.validatorAttemptId !== (validated.body as Record<string, unknown>).validatorAttemptId ||
            body.validatorAcceptanceSha256 !== (validated.body as Record<string, unknown>).validatorAcceptanceSha256 ||
            body.validationReceiptId !== (validated.body as Record<string, unknown>).validationReceiptId ||
            body.validationReceiptHash !== (validated.body as Record<string, unknown>).validationReceiptHash) integrity();
        const previous = i > 2 ? chain[i - 1] : undefined;
        if (previous?.body.kind === "PROMOTED" &&
            (body.publicationClaim as Record<string, unknown>).claimToken ===
              ((previous.body.publicationClaim as Record<string, unknown>).claimToken)) integrity();
        const validatedObjects = (validated.body as Record<string, unknown>).validatedObjects as Record<string, unknown>[];
        const finalObjects = body.finalObjects as Record<string, unknown>[];
        if (validatedObjects.some((ref, index) => ref.sha256 !== finalObjects[index]?.sha256 ||
            ref.byteSize !== finalObjects[index]?.byteSize || ref.contentType !== finalObjects[index]?.contentType ||
            ref.name !== finalObjects[index]?.name) ||
            finalObjects[4]?.sha256 !== body.publicationReceiptSha256 ||
            finalObjects[4]?.byteSize !== body.publicationReceiptBytes) integrity();
        const publicationBytes = binding.readObjectExact(finalObjects[4]);
        let publicationValue: unknown;
        try { publicationValue = JSON.parse(publicationBytes.toString("utf8")); } catch { integrity(); }
        if (!Buffer.from(jcs(publicationValue), "utf8").equals(publicationBytes)) integrity();
        const publication = exact(publicationValue, ["schemaVersion", "projectId", "jobId", "artifactId", "attempt",
          "nativeClaimToken", "publicationClaim", "source", "validatedCheckpointSha256", "writerAcceptanceSha256",
          "validatorAcceptanceSha256", "validationReceiptId", "validationReceiptHash", "immutableReuseFingerprint",
          "finalPrefix", "objects", "createdAt", "complete"]);
        if (publication.schemaVersion !== "s8-publication-receipt-v3" || publication.projectId !== projectId ||
            publication.jobId !== jobId || publication.artifactId !== artifactId || publication.attempt !== attemptNumber ||
            publication.nativeClaimToken !== writerAttempt.claimToken ||
            jcs(publication.publicationClaim) !== jcs(body.publicationClaim) || jcs(publication.source) !== jcs(body.source) ||
            publication.validatedCheckpointSha256 !== body.validatedCheckpointSha256 ||
            publication.writerAcceptanceSha256 !== body.writerAcceptanceSha256 ||
            publication.validatorAcceptanceSha256 !== body.validatorAcceptanceSha256 ||
            publication.validationReceiptId !== body.validationReceiptId || publication.validationReceiptHash !== body.validationReceiptHash ||
            publication.immutableReuseFingerprint !== receiptsById.get(String(body.validationReceiptId))?.immutableReuseFingerprint ||
            publication.finalPrefix !== (String(finalObjects[0]?.key).slice(0, String(finalObjects[0]?.key).lastIndexOf("/"))) ||
            jcs(publication.objects) !== jcs(finalObjects.slice(0, 4)) || publication.complete !== true ||
            !timestamp(publication.createdAt)) integrity();
      }
      if (body.kind === "COMMITTED") {
        const promoted = chain[i - 1];
        const validated = chain[1];
        if (!promoted || promoted.body.kind !== "PROMOTED" || !validated ||
            body.promotionCheckpointSha256 !== promoted.checkpointSha256 ||
            body.validatedCheckpointSha256 !== validated.checkpointSha256 ||
            body.validatorAttemptId !== (validated.body as Record<string, unknown>).validatorAttemptId ||
            body.validatorAcceptanceSha256 !== (validated.body as Record<string, unknown>).validatorAcceptanceSha256 ||
            body.validationReceiptId !== (validated.body as Record<string, unknown>).validationReceiptId ||
            body.validationReceiptHash !== (validated.body as Record<string, unknown>).validationReceiptHash ||
            jcs(body.publicationClaim) !== jcs(promoted.body.publicationClaim) ||
            jcs((body.sourceFence as Record<string, unknown>).source) !==
              jcs((promoted.body.sourceFence as Record<string, unknown>).source) ||
            (body.sourceFence as Record<string, unknown>).checkedAt !== body.committedAt ||
            jcs(body.finalObjects) !== jcs(promoted.body.finalObjects) ||
            body.publicationReceiptSha256 !== promoted.body.publicationReceiptSha256 ||
            body.readbackManifestSha256 !== promoted.body.readbackManifestSha256) integrity();
      }
    }
    if (attemptNumber === job.attempt && (job.headCheckpointSha256 !== chain.at(-1)!.checkpointSha256 ||
        artifact.headCheckpointSha256 !== chain.at(-1)!.checkpointSha256)) integrity();
  }
  for (const job of jobs) {
    const hasChain = [...chainMap.keys()].some((key) => key.startsWith(job.projectId + ":" + job.jobId + ":"));
    const currentChain = chainMap.get([job.projectId, job.jobId, job.artifactId, job.attempt].join(":"));
    const headKind = currentChain?.at(-1)?.body.kind;
    const hasCurrentWriter = attemptByIdentity.has([job.jobId, job.attempt, "WRITER"].join(":"));
    const hasCurrentValidator = attemptByIdentity.has([job.jobId, job.attempt, "VALIDATOR"].join(":"));
    if (!hasChain && job.headCheckpointSha256 !== null) integrity();
    if (job.status === "queued") {
      if (job.claimToken !== null || job.terminalOutcomeId !== null || job.quarantineId !== null || currentChain ||
          hasCurrentWriter || hasCurrentValidator || job.publicationPhase !== "source_admission" ||
          (job.attempt === 1 && job.retryDecisionId !== null) || (job.attempt === 2 && job.retryDecisionId === null)) integrity();
    } else if (job.status === "running") {
      if (job.claimToken === null || job.terminalOutcomeId !== null || job.quarantineId !== null ||
          headKind !== undefined || job.publicationPhase !== "claim") integrity();
    } else if (job.status === "staged") {
      if (headKind !== "STAGED" || job.publicationPhase !== "private_staging" || job.claimToken === null) integrity();
    } else if (job.status === "validated") {
      if (headKind !== "VALIDATED" || job.publicationPhase !== "independent_validation" || job.claimToken === null) integrity();
    } else if (job.status === "promoted") {
      if (headKind !== "PROMOTED" || job.publicationPhase !== "verified_readback" || job.claimToken === null) integrity();
    } else if (job.status === "committed") {
      if (headKind !== "COMMITTED" || job.publicationPhase !== "commit" || job.claimToken !== null ||
          job.terminalOutcomeId !== null || job.quarantineId !== null) integrity();
    } else if (job.status === "failed_retryable") {
      const retryable = ["WRITER", "VALIDATOR"].some((operation) => {
        const attempt = attemptByIdentity.get([job.jobId, job.attempt, operation].join(":"));
        return attempt?.state === "FAILED" && attempt.failureClass === "TRANSIENT" && attempt.retryEvidence !== null;
      });
      if (!retryable || job.claimToken !== null || job.terminalOutcomeId !== null || job.quarantineId !== null ||
          job.failureCode === null || job.retryDecisionId !== null || currentChain?.at(-1)?.body.kind === "COMMITTED") integrity();
    } else if (job.status === "failed_terminal" || job.status === "stale" || job.status === "aborted") {
      const outcome = job.terminalOutcomeId === null ? undefined : outcomes.get(job.terminalOutcomeId);
      if (!outcome || job.claimToken !== null || outcome.kind !== ({ failed_terminal: "FAILED_TERMINAL", stale: "STALE", aborted: "ABORTED" } as const)[job.status]) integrity();
    }
  }
}

function lifecycle(job: S8ExportJobV3, artifact: S8ArtifactV3, graph: StoreState): S8DerivedLifecycle {
  const terminal = graph.s8NativeTerminalOutcomes!.find((item) => item.outcomeId === job.terminalOutcomeId);
  if (job.quarantineId !== null) return "quarantined";
  if (terminal && typeof terminal === "object") {
    const kind = (terminal as Record<string, unknown>).kind;
    if (kind === "STALE") return "stale";
    if (kind === "ABORTED") return "aborted";
    if (kind === "FAILED_TERMINAL") return "failed_terminal";
  }
  if (job.status === "failed_retryable") return "failed_retryable";
  if (job.status === "failed_terminal") return "failed_terminal";
  if (job.status === "stale") return "stale";
  if (job.status === "aborted") return "aborted";
  if (job.status === "queued") return "queued";
  if (job.status === "running") return "running";
  if (job.status === "staged") return "staged";
  if (job.status === "validated") return "validated";
  if (job.status === "promoted") return "promoted";
  if (job.status === "committed" && artifact.status === "committed") return "committed";
  return integrity();
}

function validateTransition(baseline: StoreState, candidate: StoreState): void {
  const bJobs = baseline.s8ExportJobs ?? [];
  const cJobs = candidate.s8ExportJobs ?? [];
  const bArtifacts = baseline.s8Artifacts ?? [];
  const cArtifacts = candidate.s8Artifacts ?? [];
  const bCheckpoints = baseline.s8NativeProofCheckpoints ?? [];
  const cCheckpoints = candidate.s8NativeProofCheckpoints ?? [];
  const bAttempts = baseline.s8NativeOperationAttempts ?? [];
  const cAttempts = candidate.s8NativeOperationAttempts ?? [];
  const bReceipts = baseline.s8ValidationReceipts ?? [];
  const cReceipts = candidate.s8ValidationReceipts ?? [];
  const bBytes = baseline.s8ValidationReceiptBytes ?? [];
  const cBytes = candidate.s8ValidationReceiptBytes ?? [];
  const bQuarantine = baseline.s8NativeAttemptQuarantines ?? [];
  const cQuarantine = candidate.s8NativeAttemptQuarantines ?? [];
  const retained = (before: unknown[], after: unknown[], idField: string) => {
    const afterById = new Map(after.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
      return [String((value as Record<string, unknown>)[idField]), value] as const;
    }));
    for (const old of before) {
      if (typeof old !== "object" || old === null || Array.isArray(old)) integrity();
      const id = String((old as Record<string, unknown>)[idField]);
      const next = afterById.get(id);
      if (!next || jcs(old) !== jcs(next)) integrity();
    }
  };
  retained(bCheckpoints, cCheckpoints, "checkpointSha256");
  // Native attempts are append-only identities with command-validated state transitions.
  // Their per-command validators preserve identity and immutable request/release fields.
  retained(bReceipts, cReceipts, "receiptId");
  retained(bBytes, cBytes, "receiptId");
  retained(bQuarantine, cQuarantine, "quarantineId");
  const artifactsById = new Map(cArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  const jobsById = new Map(cJobs.map((job) => [job.jobId, job]));
  for (const previous of bJobs) {
    const next = jobsById.get(previous.jobId);
    const artifactNext = next ? artifactsById.get(next.artifactId) : undefined;
    const artifactPrevious = bArtifacts.find((item) => item.artifactId === previous.artifactId);
    if (!next || !artifactNext || !artifactPrevious) integrity();
    if (next.projectId !== previous.projectId || next.artifactId !== previous.artifactId ||
        next.inputHash !== previous.inputHash || next.idempotencyKey !== previous.idempotencyKey ||
        jcs(next.source) !== jcs(previous.source) || next.createdAt !== previous.createdAt) integrity();
    if (["committed", "stale", "failed_terminal", "aborted"].includes(previous.status) &&
        jcs(next) !== jcs(previous)) integrity();
    if (artifactNext.projectId !== artifactPrevious.projectId || artifactNext.jobId !== artifactPrevious.jobId ||
        artifactNext.inputHash !== artifactPrevious.inputHash || jcs(artifactNext.source) !== jcs(artifactPrevious.source) ||
        artifactNext.createdAt !== artifactPrevious.createdAt) integrity();
  }
  const priorIds = new Set(bJobs.map((job) => job.jobId));
  for (const job of cJobs) {
    if (priorIds.has(job.jobId)) continue;
    const artifact = artifactsById.get(job.artifactId);
    if (!artifact || job.status !== "queued" || job.claimToken !== null || job.nativeClaimToken !== null ||
        job.headCheckpointSha256 !== null || job.terminalOutcomeId !== null || job.quarantineId !== null ||
        job.retryDecisionId !== null || artifact.status !== "queued" || artifact.headCheckpointSha256 !== null ||
        artifact.terminalOutcomeId !== null || artifact.quarantineId !== null) integrity();
  }
}

const S8_GRAPH_ARRAYS = [
  "s8ExportJobs", "s8Artifacts", "s8ValidationReceipts", "s8ValidationReceiptBytes",
  "s8IdempotencyRecords", "s8NativeOperationAttempts", "s8NativeProofCheckpoints",
  "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines",
] as const;

function sameExcept(left: Record<string, unknown>, right: Record<string, unknown>, allowed: readonly string[]): boolean {
  const ignored = new Set(allowed);
  const a = Object.fromEntries(Object.entries(left).filter(([key]) => !ignored.has(key)));
  const b = Object.fromEntries(Object.entries(right).filter(([key]) => !ignored.has(key)));
  return jcs(a) === jcs(b);
}

function sameNonS8State(left: StoreState, right: StoreState): boolean {
  const withoutS8 = (state: StoreState) => {
    const copy = { ...state } as Record<string, unknown>;
    for (const name of S8_GRAPH_ARRAYS) delete copy[name];
    return copy;
  };
  return jcs(withoutS8(left)) === jcs(withoutS8(right));
}

function requireOnlyAppend<T>(before: readonly T[], after: readonly T[], identity: string | ((value: T) => string)): T {
  if (after.length !== before.length + 1) integrity();
  const afterById = new Map(after.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
    const key = typeof identity === "string"
      ? String((value as Record<string, unknown>)[identity])
      : identity(value);
    return [key, value] as const;
  }));
  for (const value of before) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
    const id = typeof identity === "string"
      ? String((value as Record<string, unknown>)[identity])
      : identity(value);
    const next = afterById.get(id);
    if (!next || jcs(value) !== jcs(next)) integrity();
    afterById.delete(id);
  }
  const added = [...afterById.values()];
  if (added.length !== 1) integrity();
  return added[0]!;
}

function applyCreateQueued(baseline: StoreState, working: StoreState, command: Record<string, unknown>): void {
  if (!sameNonS8State(baseline, working)) integrity();
  const job = requireOnlyAppend(baseline.s8ExportJobs ?? [], working.s8ExportJobs ?? [], "jobId") as S8ExportJobV3;
  const artifact = requireOnlyAppend(baseline.s8Artifacts ?? [], working.s8Artifacts ?? [], "artifactId") as S8ArtifactV3;
  const idempotency = requireOnlyAppend(
    baseline.s8IdempotencyRecords ?? [],
    working.s8IdempotencyRecords ?? [],
    (value) => {
      const item = value as Record<string, unknown>;
      return `${item.projectId}:${item.operation}:${item.idempotencyKey}`;
    },
  ) as Record<string, unknown>;
  for (const name of ["s8ValidationReceipts", "s8ValidationReceiptBytes", "s8NativeOperationAttempts", "s8NativeProofCheckpoints", "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines"] as const) {
    if (jcs(baseline[name] ?? []) !== jcs(working[name] ?? [])) integrity();
  }
  if (command.projectId !== job.projectId || command.jobId !== job.jobId || command.artifactId !== artifact.artifactId ||
      job.projectId !== artifact.projectId || job.artifactId !== artifact.artifactId || artifact.jobId !== job.jobId ||
      idempotency.projectId !== job.projectId || idempotency.jobId !== job.jobId || idempotency.artifactId !== artifact.artifactId ||
      idempotency.inputHash !== job.inputHash || idempotency.idempotencyKey !== job.idempotencyKey ||
      job.status !== "queued" || artifact.status !== "queued" || job.publicationPhase !== "source_admission" ||
      artifact.publicationPhase !== "source_admission" || job.attempt !== 1 || artifact.attempt !== 1) integrity();
}

function applyClaimQueued(baseline: StoreState, working: StoreState, command: Record<string, unknown>): void {
  if (!sameNonS8State(baseline, working)) integrity();
  for (const name of ["s8ValidationReceipts", "s8ValidationReceiptBytes", "s8IdempotencyRecords", "s8NativeOperationAttempts", "s8NativeProofCheckpoints", "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines"] as const) {
    if (jcs(baseline[name] ?? []) !== jcs(working[name] ?? [])) integrity();
  }
  const beforeJobs = baseline.s8ExportJobs ?? [];
  const afterJobs = working.s8ExportJobs ?? [];
  const beforeArtifacts = baseline.s8Artifacts ?? [];
  const afterArtifacts = working.s8Artifacts ?? [];
  if (beforeJobs.length !== afterJobs.length || beforeArtifacts.length !== afterArtifacts.length) integrity();
  const changedJobs = beforeJobs.flatMap((before) => {
    const after = afterJobs.find((value) => value.jobId === before.jobId);
    if (!after) integrity();
    return jcs(before) === jcs(after) ? [] : [{ before, after }];
  });
  if (changedJobs.length !== 1) integrity();
  const { before: oldJob, after: nextJob } = changedJobs[0]!;
  const oldArtifact = beforeArtifacts.find((value) => value.artifactId === oldJob.artifactId);
  const nextArtifact = afterArtifacts.find((value) => value.artifactId === nextJob.artifactId);
  if (!oldArtifact || !nextArtifact || jcs(oldArtifact) === jcs(nextArtifact) ||
      command.projectId !== oldJob.projectId || command.jobId !== oldJob.jobId || command.artifactId !== oldArtifact.artifactId ||
      oldArtifact.jobId !== oldJob.jobId || nextArtifact.jobId !== nextJob.jobId ||
      nextJob.projectId !== oldJob.projectId || nextArtifact.projectId !== oldArtifact.projectId) integrity();
  for (const before of beforeArtifacts) {
    const after = afterArtifacts.find((value) => value.artifactId === before.artifactId);
    if (!after) integrity();
    if (before.artifactId !== oldArtifact.artifactId && jcs(before) !== jcs(after)) integrity();
  }
  if (command.action === "claim") {
    if (oldJob.status !== "queued" || nextJob.status !== "running" || nextJob.publicationPhase !== "claim" ||
        nextArtifact.status !== "running" || nextArtifact.publicationPhase !== "claim" || nextJob.claimToken === null ||
        nextJob.nativeClaimToken !== null || nextJob.headCheckpointSha256 !== null || nextArtifact.headCheckpointSha256 !== null ||
        nextJob.ownerId === null || nextJob.ownerProcessId === null || nextJob.claimedAt === null ||
        nextJob.heartbeatAt !== nextJob.claimedAt || nextJob.updatedAt !== nextJob.claimedAt ||
        nextArtifact.updatedAt !== nextJob.updatedAt || nextArtifact.privateStagingPrefix === null ||
        !sameExcept(oldJob as unknown as Record<string, unknown>, nextJob as unknown as Record<string, unknown>,
          ["status", "publicationPhase", "claimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt", "updatedAt"]) ||
        !sameExcept(oldArtifact as unknown as Record<string, unknown>, nextArtifact as unknown as Record<string, unknown>,
          ["status", "publicationPhase", "privateStagingPrefix", "updatedAt"])) integrity();
    return;
  }
  if (command.action === "heartbeat") {
    const active = ["running", "staged", "validated", "promoted"].includes(oldJob.status);
    if (!active || nextJob.status !== oldJob.status || nextJob.publicationPhase !== oldJob.publicationPhase ||
        nextArtifact.status !== oldArtifact.status || nextArtifact.publicationPhase !== oldArtifact.publicationPhase ||
        nextJob.claimToken !== oldJob.claimToken || nextJob.ownerId !== oldJob.ownerId ||
        nextJob.ownerProcessId !== oldJob.ownerProcessId || nextJob.claimToken === null ||
        nextJob.heartbeatAt === oldJob.heartbeatAt || nextJob.updatedAt !== nextJob.heartbeatAt ||
        nextArtifact.updatedAt !== nextJob.updatedAt ||
        !sameExcept(oldJob as unknown as Record<string, unknown>, nextJob as unknown as Record<string, unknown>, ["heartbeatAt", "updatedAt"]) ||
        !sameExcept(oldArtifact as unknown as Record<string, unknown>, nextArtifact as unknown as Record<string, unknown>, ["updatedAt"])) integrity();
    return;
  }
  integrity();
}

function changedAttemptPair(baseline: StoreState, working: StoreState, command: Record<string, unknown>): {
  before: Record<string, unknown>; after: Record<string, unknown>;
} {
  const before = baseline.s8NativeOperationAttempts ?? [];
  const after = working.s8NativeOperationAttempts ?? [];
  if (before.length !== after.length) integrity();
  const changed = before.flatMap((value) => {
    const next = after.find((candidate) => candidate.attemptId === value.attemptId);
    if (!next) integrity();
    return jcs(value) === jcs(next) ? [] : [{ before: value as Record<string, unknown>, after: next as Record<string, unknown> }];
  });
  if (changed.length !== 1 || changed[0]!.after.jobId !== command.jobId) integrity();
  const pair = changed[0]!;
  if (pair.after.projectId !== command.projectId || pair.after.jobId !== command.jobId || pair.after.artifactId !== command.artifactId) integrity();
  return pair;
}

function applyBeginNativeAttempt(baseline: StoreState, working: StoreState, command: Record<string, unknown>): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts", "s8NativeOperationAttempts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  const attempt = requireOnlyAppend(baseline.s8NativeOperationAttempts ?? [], working.s8NativeOperationAttempts ?? [], "attemptId") as Record<string, unknown>;
  if (attempt.projectId !== job.projectId || attempt.jobId !== job.jobId || attempt.artifactId !== artifact.artifactId ||
      attempt.attempt !== job.attempt || attempt.claimToken !== job.nativeClaimToken || !uuid(attempt.attemptId) ||
      attempt.state !== "DISPATCHING" || attempt.requestSha256 !== null || attempt.requestNonce !== null ||
      attempt.signedRequest !== null || attempt.responseSha256 !== null || attempt.signedResponse !== null ||
      attempt.acceptanceReceipt !== null || attempt.retryEvidence !== null || attempt.failureClass !== null ||
      attempt.failureCode !== null || attempt.disposalState !== "NOT_STARTED") integrity();
  if (attempt.operation === "WRITER") {
    if (oldJob.status !== "running" || oldArtifact.status !== "running" || oldJob.claimToken === null ||
        oldJob.nativeClaimToken !== null || !uuid(job.nativeClaimToken) ||
        !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["nativeClaimToken", "updatedAt"]) ||
        !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["privateStagingPrefix", "updatedAt"]) ||
        artifact.privateStagingPrefix !== `private/projects/${job.projectId}/s8/staging/${artifact.artifactId}/${job.nativeClaimToken}`) integrity();
  } else if (attempt.operation === "VALIDATOR") {
    const writer = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "WRITER");
    const writerAcceptance = (writer as unknown as Record<string, unknown> | undefined)?.acceptanceReceipt as { body?: Record<string, unknown> } | null | undefined;
    if (oldJob.status !== "staged" || oldArtifact.status !== "staged" || oldJob.nativeClaimToken === null ||
        job.nativeClaimToken !== oldJob.nativeClaimToken || !writer || writer.state !== "SUCCEEDED" ||
        attempt.inputSha256 !== writerAcceptance?.body?.outputSha256 || attempt.inputBytes !== writerAcceptance?.body?.outputBytes ||
        !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["updatedAt"]) ||
        !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["updatedAt"])) integrity();
  } else integrity();
}

function applyPrepareNativeAttempt(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust): void {
  assertS8ArraysUnchanged(baseline, working, ["s8NativeOperationAttempts"]);
  const { before, after } = changedAttemptPair(baseline, working, command);
  if (before.state !== "DISPATCHING" || before.requestSha256 !== null || after.state !== "DISPATCHING" ||
      after.responseSha256 !== null || after.acceptanceReceipt !== null || after.retryEvidence !== null ||
      after.failureClass !== null || after.failureCode !== null || after.completedAt !== null || after.disposalState !== "UNKNOWN" ||
      !sameExcept(before, after, ["requestSha256", "requestNonce", "signedRequest", "disposalState", "updatedAt"])) integrity();
  signedRequestBody(after.signedRequest, after, trust);
}

function applyPersistNativeAcceptance(baseline: StoreState, working: StoreState, command: Record<string, unknown>): void {
  assertS8ArraysUnchanged(baseline, working, ["s8NativeOperationAttempts"]);
  const { before, after } = changedAttemptPair(baseline, working, command);
  if (before.state !== "DISPATCHING" || before.requestSha256 === null || after.state !== "SUCCEEDED" ||
      after.requestSha256 === null || after.responseSha256 === null || after.acceptanceReceipt === null ||
      after.retryEvidence !== null || after.failureClass !== null || after.failureCode !== null ||
      after.disposalState !== "REAPED_REMOVED" || !timestamp(after.completedAt) ||
      !sameExcept(before, after, ["state", "responseSha256", "signedResponse", "acceptanceReceipt", "disposalState", "updatedAt", "completedAt"])) integrity();
  const responseEnvelope = exact(after.signedResponse, ["body", "signature"]);
  const responseBody = responseEnvelope.body as Record<string, unknown>;
  const acceptance = (after.acceptanceReceipt as { body?: Record<string, unknown>; receiptSha256?: string }).body;
  const runnerEvidence = responseBody.runnerEvidence;
  const runnerBinary = typeof runnerEvidence === "object" && runnerEvidence !== null && !Array.isArray(runnerEvidence)
    ? (runnerEvidence as Record<string, unknown>).runnerBinary
    : undefined;
  if (!acceptance || sha256(jcs(after.signedResponse)) !== after.responseSha256 ||
      responseBody.requestSha256 !== after.requestSha256 || responseBody.projectId !== after.projectId ||
      responseBody.jobId !== after.jobId || responseBody.artifactId !== after.artifactId ||
      responseBody.attempt !== after.attempt || responseBody.operation !== after.operation ||
      responseBody.inputSha256 !== after.inputSha256 || responseBody.inputBytes !== after.inputBytes ||
      responseBody.releaseManifestSha256 !== after.releaseManifestSha256 ||
      responseBody.outputSha256 !== acceptance.outputSha256 || responseBody.outputBytes !== acceptance.outputBytes ||
      responseBody.auxiliarySha256 !== acceptance.auxiliarySha256 || responseBody.auxiliaryBytes !== acceptance.auxiliaryBytes ||
      responseBody.imageDigest !== acceptance.imageDigest || responseBody.containerId !== acceptance.containerId ||
      responseBody.releaseHandle !== acceptance.releaseHandle || responseBody.validatorIdentity !== acceptance.validatorIdentity ||
      typeof runnerEvidence !== "object" || runnerEvidence === null || Array.isArray(runnerEvidence) ||
      typeof runnerBinary !== "object" || runnerBinary === null || Array.isArray(runnerBinary) ||
      acceptance.runnerEvidenceSha256 !== sha256(jcs(runnerEvidence)) ||
      acceptance.runnerBinarySha256 !== (runnerBinary as Record<string, unknown>).selfSha256) integrity();
}

function acceptanceBody(attempt: Record<string, unknown>): Record<string, unknown> {
  const receipt = attempt.acceptanceReceipt as { body?: unknown } | null;
  if (!receipt?.body || attempt.state !== "SUCCEEDED") return integrity();
  return (receipt.body as { body?: Record<string, unknown> }).body ?? receipt.body as Record<string, unknown>;
}

function objectRef(name: string, key: string, sha256Value: unknown, byteSize: unknown): Record<string, unknown> {
  return { name, contentType: name === "artifact.fbx" ? "application/octet-stream" : "application/json",
    key, sha256: sha256Value, byteSize };
}

function applyStageAcceptedWriter(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  const writer = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.projectId === job.projectId && item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
  if (!writer || writer.state !== "SUCCEEDED" || oldJob.status !== "running" || oldArtifact.status !== "running" ||
      job.status !== oldJob.status || job.publicationPhase !== oldJob.publicationPhase ||
      artifact.status !== oldArtifact.status || artifact.publicationPhase !== oldArtifact.publicationPhase ||
      job.nativeClaimToken !== oldJob.nativeClaimToken || artifact.payloadSha256 !== job.inputHash ||
      artifact.privateStagingPrefix !== `private/projects/${job.projectId}/s8/staging/${artifact.artifactId}/${job.nativeClaimToken}` ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["updatedAt", "heartbeatAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["payloadSha256", "privateStagingPrefix", "updatedAt"])) integrity();
  const accepted = acceptanceBody(writer);
  const stagedPrefix = artifact.privateStagingPrefix!;
  const stagedObjects = [
    objectRef("artifact.fbx", `${stagedPrefix}/artifact.fbx`, accepted.outputSha256, accepted.outputBytes),
    objectRef("writer-receipt.json", `${stagedPrefix}/writer-receipt.json`, accepted.auxiliarySha256, accepted.auxiliaryBytes),
  ];
  const timestamp = writer.completedAt as string;
  const body = {
    schemaVersion: "s8-native-proof-checkpoint-v1", kind: "STAGED", checkpointId: randomUUID(), keyId: trust.currentKeyId,
    sequence: 1, previousCheckpointSha256: null, projectId: job.projectId, jobId: job.jobId, artifactId: artifact.artifactId,
    attempt: job.attempt, nativeClaimToken: job.nativeClaimToken, source: job.source,
    acceptedSourceDigest: sha256(jcs(job.source)), payloadSha256: job.inputHash, writerAttemptId: writer.attemptId,
    writerAcceptanceSha256: (writer.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    releaseManifestSha256: writer.releaseManifestSha256, resourcePolicySha256: writer.resourcePolicySha256,
    issuedAt: timestamp, stagedObjects,
  } as Record<string, unknown>;
  const checkpoint = issueCheckpoint(working, trust, body);
  job.status = "staged"; job.publicationPhase = "private_staging"; job.headCheckpointSha256 = checkpoint.checkpointSha256;
  job.updatedAt = timestamp; job.heartbeatAt = timestamp;
  artifact.status = "staged"; artifact.publicationPhase = "private_staging"; artifact.headCheckpointSha256 = checkpoint.checkpointSha256;
  artifact.updatedAt = timestamp;
}

function applyValidateAcceptedPair(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts", "s8ValidationReceipts", "s8ValidationReceiptBytes"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  const receipt = requireOnlyAppend(baseline.s8ValidationReceipts ?? [], working.s8ValidationReceipts ?? [], "receiptId") as Record<string, unknown>;
  const receiptBytes = requireOnlyAppend(baseline.s8ValidationReceiptBytes ?? [], working.s8ValidationReceiptBytes ?? [], "receiptId") as Record<string, unknown>;
  if (oldJob.status !== "staged" || oldArtifact.status !== "staged" || oldJob.publicationPhase !== "private_staging" ||
      oldJob.headCheckpointSha256 !== oldArtifact.headCheckpointSha256 || job.status !== oldJob.status ||
      job.publicationPhase !== oldJob.publicationPhase || artifact.status !== oldArtifact.status ||
      artifact.publicationPhase !== oldArtifact.publicationPhase || job.nativeClaimToken !== oldJob.nativeClaimToken ||
      job.claimToken !== oldJob.claimToken || job.ownerId !== oldJob.ownerId || job.ownerProcessId !== oldJob.ownerProcessId ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["updatedAt", "heartbeatAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>,
        ["payloadSha256", "objectHashes", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash",
          "publicationReceiptHash", "validationReceiptId", "validationReceiptHash", "immutableReuseFingerprint", "updatedAt"]) ||
      receipt.projectId !== job.projectId || receipt.jobId !== job.jobId || receipt.artifactId !== artifact.artifactId ||
      receipt.attempt !== job.attempt || receipt.nativeClaimToken !== job.nativeClaimToken ||
      receipt.source === undefined || jcs(receipt.source) !== jcs(job.source) ||
      receipt.receiptId !== receiptBytes.receiptId || receiptBytes.schemaVersion !== "s8-validation-receipt-bytes-v1" ||
      receiptBytes.byteSize !== Buffer.from(jcs(receipt), "utf8").byteLength ||
      receiptBytes.sha256 !== sha256(Buffer.from(jcs(receipt), "utf8")) ||
      receiptBytes.canonicalBase64url !== Buffer.from(jcs(receipt), "utf8").toString("base64url") ||
      artifact.validationReceiptId !== receipt.receiptId || artifact.validationReceiptHash !== receipt.receiptHash ||
      artifact.immutableReuseFingerprint !== receipt.immutableReuseFingerprint || artifact.payloadSha256 !== job.inputHash ||
      artifact.writerReceiptHash !== receipt.writerReceiptHash || artifact.nativeReadbackHash !== receipt.nativeReadbackHash ||
      artifact.semanticReceiptHash !== receipt.semanticReceiptHash || artifact.publicationReceiptHash !== null ||
      artifact.objectHashes?.artifactSha256 !== receipt.artifactSha256 ||
      artifact.objectHashes?.artifactByteSize !== receipt.artifactByteSize ||
      artifact.objectHashes?.writerReceiptSha256 !== receipt.writerReceiptHash ||
      artifact.objectHashes?.nativeReadbackSha256 !== receipt.nativeReadbackHash ||
      artifact.objectHashes?.semanticReceiptSha256 !== receipt.semanticReceiptHash ||
      artifact.objectHashes?.publicationReceiptSha256 !== null) integrity();

  const writer = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
  const validator = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "VALIDATOR") as Record<string, unknown> | undefined;
  if (!writer || !validator || writer.state !== "SUCCEEDED" || validator.state !== "SUCCEEDED") integrity();
  const writerAcceptance = acceptanceBody(writer);
  const validatorAcceptance = acceptanceBody(validator);
  const chain = (working.s8NativeProofCheckpoints ?? []).filter((item) =>
    item.body.projectId === job.projectId && item.body.jobId === job.jobId && item.body.artifactId === artifact.artifactId && item.body.attempt === job.attempt);
  const staged = chain.find((item) => item.body.kind === "STAGED");
  if (!staged || chain.length !== 1 || staged.checkpointSha256 !== job.headCheckpointSha256) integrity();
  const stagingPrefix = artifact.privateStagingPrefix;
  if (!stagingPrefix || job.nativeClaimToken === null) integrity();
  const objects = [
    objectRef("artifact.fbx", `${stagingPrefix}/artifact.fbx`, writerAcceptance.outputSha256, writerAcceptance.outputBytes),
    objectRef("writer-receipt.json", `${stagingPrefix}/writer-receipt.json`, writerAcceptance.auxiliarySha256, writerAcceptance.auxiliaryBytes),
    objectRef("native-readback.json", `${stagingPrefix}/native-readback.json`, validatorAcceptance.outputSha256, validatorAcceptance.outputBytes),
    objectRef("semantic-validation-receipt.json", `${stagingPrefix}/semantic-validation-receipt.json`, receipt.semanticReceiptHash, receipt.semanticReceiptBytes),
  ];
  const body = {
    schemaVersion: "s8-native-proof-checkpoint-v1", kind: "VALIDATED", checkpointId: randomUUID(), keyId: trust.currentKeyId,
    sequence: 2, previousCheckpointSha256: staged.checkpointSha256, projectId: job.projectId, jobId: job.jobId,
    artifactId: artifact.artifactId, attempt: job.attempt, nativeClaimToken: job.nativeClaimToken, source: job.source,
    acceptedSourceDigest: sha256(jcs(job.source)), payloadSha256: job.inputHash, writerAttemptId: writer.attemptId,
    writerAcceptanceSha256: (writer.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    releaseManifestSha256: writer.releaseManifestSha256, resourcePolicySha256: writer.resourcePolicySha256,
    issuedAt: receipt.checkedAt, stagedCheckpointSha256: staged.checkpointSha256, validatorAttemptId: validator.attemptId,
    validatorAcceptanceSha256: (validator.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    validationReceiptId: receipt.receiptId, validationReceiptHash: receipt.receiptHash,
    validationReceiptObjectSha256: receiptBytes.sha256, validationReceiptObjectBytes: receiptBytes.byteSize,
    validatedObjects: objects, semanticReceiptSha256: receipt.semanticReceiptHash, semanticOutcome: "pass",
  } as Record<string, unknown>;
  const checkpoint = issueCheckpoint(working, trust, body);
  job.status = "validated"; job.publicationPhase = "independent_validation"; job.headCheckpointSha256 = checkpoint.checkpointSha256;
  job.updatedAt = String(receipt.checkedAt); job.heartbeatAt = String(receipt.checkedAt);
  artifact.status = "validated"; artifact.publicationPhase = "independent_validation"; artifact.headCheckpointSha256 = checkpoint.checkpointSha256;
  artifact.updatedAt = String(receipt.checkedAt);
}

function applyPromoteValidated(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust, binding: S8ProofBindingRecord): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  if (oldJob.status !== "validated" || oldArtifact.status !== "validated" || oldJob.publicationPhase !== "independent_validation" ||
      job.status !== oldJob.status || job.publicationPhase !== oldJob.publicationPhase || job.nativeClaimToken !== oldJob.nativeClaimToken ||
      job.claimToken === null || job.ownerId === null || job.ownerProcessId === null || job.claimedAt === null ||
      artifact.validationReceiptId === null || artifact.validationReceiptHash === null || !artifact.objectHashes ||
      artifact.objectHashes.publicationReceiptSha256 === null || artifact.publicationReceiptHash !== artifact.objectHashes.publicationReceiptSha256 ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["updatedAt", "heartbeatAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>,
        ["privateFinalPrefix", "objectHashes", "publicationReceiptHash", "updatedAt"])) integrity();
  const chain = (baseline.s8NativeProofCheckpoints ?? []).filter((item) =>
    item.body.projectId === job.projectId && item.body.jobId === job.jobId && item.body.artifactId === artifact.artifactId && item.body.attempt === job.attempt)
    .sort((a, b) => Number(a.body.sequence) - Number(b.body.sequence));
  const validated = chain.find((item) => item.body.kind === "VALIDATED");
  if (!validated || chain.length < 2 || chain.at(-1)!.checkpointSha256 !== job.headCheckpointSha256 ||
      chain.at(-1)!.body.kind !== "VALIDATED" && chain.at(-1)!.body.kind !== "PROMOTED") integrity();
  const validation = validated.body;
  const writer = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
  const validator = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "VALIDATOR") as Record<string, unknown> | undefined;
  const receipt = (baseline.s8ValidationReceipts ?? []).find((item) => item.receiptId === artifact.validationReceiptId) as Record<string, unknown> | undefined;
  if (!writer || !validator || !receipt || writer.state !== "SUCCEEDED" || validator.state !== "SUCCEEDED") integrity();
  const checkedAt = job.updatedAt;
  const publicationClaim = { claimToken: job.claimToken, ownerId: job.ownerId, ownerProcessId: job.ownerProcessId, claimedAt: job.claimedAt };
  const root = `private/projects/${job.projectId}/s8/committed/${job.source.sourceRevisionHash}`;
  const finalBase = `${root}/${artifact.objectHashes.artifactSha256}/${artifact.artifactId}/${artifact.attempt}/${job.claimToken}`;
  if (artifact.privateFinalPrefix !== finalBase) integrity();
  const hashes = artifact.objectHashes;
  const finalObjects = [
    objectRef("artifact.fbx", `${finalBase}/artifact.fbx`, hashes.artifactSha256, hashes.artifactByteSize),
    objectRef("writer-receipt.json", `${finalBase}/writer-receipt.json`, hashes.writerReceiptSha256, receipt.writerReceiptBytes),
    objectRef("native-readback.json", `${finalBase}/native-readback.json`, hashes.nativeReadbackSha256, receipt.nativeReadbackBytes),
    objectRef("semantic-validation-receipt.json", `${finalBase}/semantic-validation-receipt.json`, hashes.semanticReceiptSha256, receipt.semanticReceiptBytes),
    objectRef("publication-receipt.json", `${finalBase}/publication-receipt.json`, hashes.publicationReceiptSha256, binding.readObjectExact({ key: `${finalBase}/publication-receipt.json` }).byteLength),
  ];
  const publicationBytes = binding.readObjectExact(finalObjects[4]);
  const readbackManifest = { schemaVersion: "s8-native-final-readback-v1", projectId: job.projectId, jobId: job.jobId,
    artifactId: artifact.artifactId, attempt: artifact.attempt, publicationClaimToken: job.claimToken,
    validatedCheckpointSha256: validated.checkpointSha256, checkedAt, objects: finalObjects };
  const readbackManifestSha256 = sha256(jcs(readbackManifest));
  const sourceFence = { source: job.source, checkedAt };
  const pub = JSON.parse(publicationBytes.toString("utf8")) as Record<string, unknown>;
  const body = {
    schemaVersion: "s8-native-proof-checkpoint-v1", kind: "PROMOTED", checkpointId: randomUUID(), keyId: trust.currentKeyId,
    sequence: chain.length + 1, previousCheckpointSha256: chain.at(-1)!.checkpointSha256, projectId: job.projectId,
    jobId: job.jobId, artifactId: artifact.artifactId, attempt: artifact.attempt, nativeClaimToken: job.nativeClaimToken,
    source: job.source, acceptedSourceDigest: sha256(jcs(job.source)), payloadSha256: job.inputHash,
    writerAttemptId: writer.attemptId, writerAcceptanceSha256: (writer.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    releaseManifestSha256: writer.releaseManifestSha256, resourcePolicySha256: writer.resourcePolicySha256,
    issuedAt: checkedAt, validatedCheckpointSha256: validated.checkpointSha256, validatorAttemptId: validator.attemptId,
    validatorAcceptanceSha256: (validator.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    validationReceiptId: receipt.receiptId, validationReceiptHash: receipt.receiptHash, publicationClaim, sourceFence,
    publicationReceiptSha256: hashes.publicationReceiptSha256, publicationReceiptBytes: publicationBytes.byteLength,
    finalObjects, readbackManifest, readbackManifestSha256,
  } as Record<string, unknown>;
  if (jcs(pub.publicationClaim) !== jcs(publicationClaim)) integrity();
  const checkpoint = issueCheckpoint(working, trust, body);
  job.status = "promoted"; job.publicationPhase = "verified_readback"; job.headCheckpointSha256 = checkpoint.checkpointSha256;
  job.updatedAt = checkedAt; job.heartbeatAt = checkedAt;
  artifact.status = "promoted"; artifact.publicationPhase = "verified_readback"; artifact.headCheckpointSha256 = checkpoint.checkpointSha256;
  artifact.updatedAt = checkedAt;
}

function applyCommitPromoted(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust, binding: S8ProofBindingRecord): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  if (oldJob.status !== "promoted" || oldArtifact.status !== "promoted" || oldJob.publicationPhase !== "verified_readback" ||
      job.status !== oldJob.status || job.publicationPhase !== oldJob.publicationPhase ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["updatedAt", "heartbeatAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["updatedAt"])) integrity();
  const sourceView = binding.readSourceView(working, job.projectId) as { sourceDisposition?: unknown; source?: unknown } | null;
  if (sourceView?.sourceDisposition !== "CURRENT" || jcs(sourceView.source) !== jcs(job.source) || !artifact.objectHashes || !artifact.privateFinalPrefix) integrity();
  const chain = (baseline.s8NativeProofCheckpoints ?? []).filter((item) =>
    item.body.projectId === job.projectId && item.body.jobId === job.jobId && item.body.artifactId === artifact.artifactId && item.body.attempt === job.attempt)
    .sort((a, b) => Number(a.body.sequence) - Number(b.body.sequence));
  const promotion = chain.at(-1);
  const validated = chain.find((item) => item.body.kind === "VALIDATED");
  if (!promotion || promotion.body.kind !== "PROMOTED" || !validated || promotion.checkpointSha256 !== job.headCheckpointSha256) integrity();
  const promotedBody = promotion.body;
  const finalObjects = promotedBody.finalObjects as Record<string, unknown>[];
  for (const ref of finalObjects) {
    const bytes = binding.readObjectExact(ref);
    if (bytes.byteLength !== ref.byteSize || sha256(bytes) !== ref.sha256) integrity();
  }
  const committedAt = job.updatedAt;
  const writer = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "WRITER") as Record<string, unknown> | undefined;
  const validator = (baseline.s8NativeOperationAttempts ?? []).find((item) => item.jobId === job.jobId && item.attempt === job.attempt && item.operation === "VALIDATOR") as Record<string, unknown> | undefined;
  if (!writer || !validator) integrity();
  const sourceFence = { source: job.source, checkedAt: committedAt };
  const body = {
    schemaVersion: "s8-native-proof-checkpoint-v1", kind: "COMMITTED", checkpointId: randomUUID(), keyId: trust.currentKeyId,
    sequence: chain.length + 1, previousCheckpointSha256: promotion.checkpointSha256, projectId: job.projectId,
    jobId: job.jobId, artifactId: artifact.artifactId, attempt: artifact.attempt, nativeClaimToken: job.nativeClaimToken,
    source: job.source, acceptedSourceDigest: sha256(jcs(job.source)), payloadSha256: job.inputHash,
    writerAttemptId: writer.attemptId, writerAcceptanceSha256: (writer.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    releaseManifestSha256: writer.releaseManifestSha256, resourcePolicySha256: writer.resourcePolicySha256,
    issuedAt: committedAt, promotionCheckpointSha256: promotion.checkpointSha256, validatedCheckpointSha256: validated.checkpointSha256,
    validatorAttemptId: validator.attemptId, validatorAcceptanceSha256: (validator.acceptanceReceipt as { receiptSha256: string }).receiptSha256,
    validationReceiptId: promotedBody.validationReceiptId, validationReceiptHash: promotedBody.validationReceiptHash,
    publicationClaim: promotedBody.publicationClaim, sourceFence, finalObjects, publicationReceiptSha256: promotedBody.publicationReceiptSha256,
    readbackManifestSha256: promotedBody.readbackManifestSha256, committedAt,
  } as Record<string, unknown>;
  const checkpoint = issueCheckpoint(working, trust, body);
  job.status = "committed"; job.publicationPhase = "commit"; job.headCheckpointSha256 = checkpoint.checkpointSha256;
  job.terminalAt = committedAt; job.claimToken = null; job.ownerId = null; job.ownerProcessId = null;
  job.claimedAt = null; job.heartbeatAt = null; job.updatedAt = committedAt;
  artifact.status = "committed"; artifact.publicationPhase = "commit"; artifact.headCheckpointSha256 = checkpoint.checkpointSha256;
  artifact.committedAt = committedAt; artifact.updatedAt = committedAt;
}

function applyPersistNativeFailure(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust): void {
  assertS8ArraysUnchanged(baseline, working, ["s8NativeOperationAttempts"]);
  const { before, after } = changedAttemptPair(baseline, working, command);
  if (before.state !== "DISPATCHING" || after.state !== "FAILED" && after.state !== "UNKNOWN" ||
      after.acceptanceReceipt !== null || !sameExcept(before, after,
        ["state", "responseSha256", "signedResponse", "retryEvidence", "failureClass", "failureCode", "disposalState", "updatedAt", "completedAt"])) integrity();
  validateNativeAttempt(after, trust);
}

function applyReconcilePreparedAttempt(baseline: StoreState, working: StoreState, command: Record<string, unknown>, trust: S8ImmutableApplicationTrust): void {
  assertS8ArraysUnchanged(baseline, working, ["s8NativeOperationAttempts"]);
  const { before, after } = changedAttemptPair(baseline, working, command);
  if (before.state !== "DISPATCHING" || after.state !== "UNKNOWN" || after.acceptanceReceipt !== null ||
      after.retryEvidence !== null || after.failureClass !== "UNCERTAIN" ||
      after.failureCode !== "RECONCILIATION_REQUIRED" || after.disposalState !== "UNKNOWN" || !timestamp(after.completedAt) ||
      !sameExcept(before, after, ["state", "failureClass", "failureCode", "disposalState", "updatedAt", "completedAt"])) integrity();
  validateNativeAttempt(after, trust);
}

function applyRecordTerminalFailure(baseline: StoreState, working: StoreState, command: Record<string, unknown>): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  if (["committed", "stale", "failed_terminal", "aborted"].includes(oldJob.status) ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["failureCode", "updatedAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["failureCode", "updatedAt"]) ||
      typeof job.failureCode !== "string" || job.failureCode.length === 0 || job.failureCode !== artifact.failureCode) integrity();
  const currentAttempts = (baseline.s8NativeOperationAttempts ?? []).filter((item) => item.jobId === job.jobId && item.attempt === job.attempt) as Record<string, unknown>[];
  if (currentAttempts.some((attempt) => attempt.state === "DISPATCHING") ||
      currentAttempts.some((attempt) => attempt.state === "UNKNOWN") &&
        job.failureCode !== "S8_NATIVE_RECONCILIATION_REQUIRED" &&
        job.failureCode !== "S8_SOURCE_STALE" && job.failureCode !== "S8_SOURCE_NOT_READY") integrity();
  const lastAttempt = currentAttempts.at(-1);
  const stale = job.failureCode === "S8_SOURCE_STALE" || job.failureCode === "S8_SOURCE_NOT_READY";
  const status = stale ? "stale" : "failed_terminal";
  const reason = job.failureCode === "S8_SOURCE_STALE" ? "SOURCE_STALE" :
    job.failureCode === "S8_SOURCE_NOT_READY" ? "SOURCE_NOT_READY" :
    job.failureCode === "S8_NATIVE_OPERATION_TIMEOUT" ? "NATIVE_TIMEOUT" :
    job.failureCode === "S8_NATIVE_CLOCK_INVALID" ? "NATIVE_CLOCK_INVALID" :
    job.failureCode === "S8_SEMANTIC_VALIDATION_FAILED" ? "SEMANTIC_FAILED" :
    job.failureCode === "S8_NATIVE_RECONCILIATION_REQUIRED" ? "RECONCILIATION_REQUIRED" :
    lastAttempt?.failureClass === "PERMANENT" ? "NATIVE_PERMANENT_FAILURE" : "PUBLICATION_FAILED";
  const kind = stale ? "STALE" : "FAILED_TERMINAL";
  const recordedAt = job.updatedAt;
  const outcomeId = randomUUID();
  const outcome = { schemaVersion: "s8-native-terminal-outcome-v1", outcomeId, projectId: job.projectId, jobId: job.jobId,
    artifactId: artifact.artifactId, attempt: job.attempt, kind, reason, nativeAttemptId: lastAttempt?.attemptId ?? null,
    headCheckpointSha256: job.headCheckpointSha256, quarantineId: null, recordedAt };
  working.s8NativeTerminalOutcomes ??= [];
  working.s8NativeTerminalOutcomes.push(outcome as StoreState["s8NativeTerminalOutcomes"] extends (infer T)[] | undefined ? T : never);
  job.status = status; job.terminalOutcomeId = outcomeId; job.terminalAt = recordedAt; job.updatedAt = recordedAt;
  job.claimToken = null; job.ownerId = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
  artifact.status = status; artifact.terminalOutcomeId = outcomeId; artifact.updatedAt = recordedAt;
  if (stale) artifact.staleAt = recordedAt;
}

function applyScheduleRetry(baseline: StoreState, working: StoreState, command: Record<string, unknown>, binding: S8ProofBindingRecord): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  const failed = (baseline.s8NativeOperationAttempts ?? []).filter((item) => item.jobId === job.jobId && item.attempt === 1) as Record<string, unknown>[];
  const retryable = failed.find((item) => item.state === "FAILED" && item.failureClass === "TRANSIENT" && item.retryEvidence !== null);
  const sourceView = binding.readSourceView(working, job.projectId) as { sourceDisposition?: unknown; source?: unknown } | null;
  const writer = failed.find((item) => item.operation === "WRITER");
  const validator = failed.find((item) => item.operation === "VALIDATOR");
  if (oldJob.status !== "running" && oldJob.status !== "staged" || oldJob.attempt !== 1 || !retryable ||
      oldJob.claimToken === null || oldJob.ownerId === null || oldJob.ownerProcessId === null ||
      sourceView?.sourceDisposition !== "CURRENT" || jcs(sourceView.source) !== jcs(oldJob.source) ||
      retryable.operation === "VALIDATOR" && (!writer || writer.state !== "SUCCEEDED" || !writer.acceptanceReceipt) ||
      retryable.operation === "WRITER" && validator !== undefined ||
      job.attempt !== 2 || artifact.attempt !== 2 || job.retryDecisionId !== (retryable.retryEvidence as { body: { decisionId: string } }).body.decisionId ||
      job.status !== "failed_retryable" || artifact.status !== "failed_retryable" ||
      job.publicationPhase !== "source_admission" || artifact.publicationPhase !== "source_admission" ||
      oldJob.claimToken === null || job.claimToken !== null || job.nativeClaimToken !== null ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["attempt", "status", "publicationPhase", "claimToken", "nativeClaimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt", "terminalAt", "failureCode", "updatedAt", "retryDecisionId", "headCheckpointSha256"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["attempt", "status", "publicationPhase", "payloadSha256", "objectHashes", "writerReceiptHash", "nativeReadbackHash", "semanticReceiptHash", "publicationReceiptHash", "validationReceiptId", "validationReceiptHash", "immutableReuseFingerprint", "privateStagingPrefix", "privateFinalPrefix", "failureCode", "updatedAt", "headCheckpointSha256"])) integrity();
  job.status = "queued"; job.publicationPhase = "source_admission"; job.failureCode = null; job.terminalAt = null;
  job.claimToken = null; job.nativeClaimToken = null; job.ownerId = null; job.ownerProcessId = null; job.claimedAt = null; job.heartbeatAt = null;
  job.headCheckpointSha256 = null; job.updatedAt = artifact.updatedAt;
  artifact.status = "queued"; artifact.publicationPhase = "source_admission"; artifact.failureCode = null;
  artifact.payloadSha256 = null; artifact.objectHashes = null; artifact.writerReceiptHash = null; artifact.nativeReadbackHash = null;
  artifact.semanticReceiptHash = null; artifact.publicationReceiptHash = null; artifact.validationReceiptId = null;
  artifact.validationReceiptHash = null; artifact.immutableReuseFingerprint = null;
  artifact.privateStagingPrefix = `private/projects/${artifact.projectId}/s8/staging/${artifact.artifactId}/unclaimed`;
  artifact.privateFinalPrefix = `private/projects/${artifact.projectId}/s8/committed/${artifact.source.sourceRevisionHash}/${"0".repeat(64)}`;
  artifact.headCheckpointSha256 = null; artifact.updatedAt = job.updatedAt;
}

function applyReclaimPublication(baseline: StoreState, working: StoreState, command: Record<string, unknown>, binding: S8ProofBindingRecord): void {
  assertS8ArraysUnchanged(baseline, working, ["s8ExportJobs", "s8Artifacts"]);
  const { oldJob, job, oldArtifact, artifact } = requireChangedPair(baseline, working, command);
  const sourceView = binding.readSourceView(working, job.projectId) as { sourceDisposition?: unknown; source?: unknown } | null;
  if (!(oldJob.status === "validated" || oldJob.status === "promoted") || oldJob.claimToken === null ||
      oldJob.ownerId === null || oldJob.ownerProcessId === null || sourceView?.sourceDisposition !== "CURRENT" ||
      jcs(sourceView.source) !== jcs(oldJob.source) ||
      job.status !== oldJob.status || job.publicationPhase !== oldJob.publicationPhase || job.nativeClaimToken !== oldJob.nativeClaimToken ||
      job.claimToken === null || job.claimToken === oldJob.claimToken || job.ownerId === null || job.ownerProcessId === null ||
      job.claimedAt !== job.updatedAt || job.heartbeatAt !== job.updatedAt || artifact.status !== oldArtifact.status ||
      artifact.publicationPhase !== oldArtifact.publicationPhase || artifact.headCheckpointSha256 !== oldArtifact.headCheckpointSha256 ||
      !sameExcept(oldJob as unknown as Record<string, unknown>, job as unknown as Record<string, unknown>, ["claimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt", "updatedAt"]) ||
      !sameExcept(oldArtifact as unknown as Record<string, unknown>, artifact as unknown as Record<string, unknown>, ["updatedAt"])) integrity();
}

export function createS8NativeProofAuthority(binding: S8RepositoryProofBinding): S8RepositoryProofAuthority {
  if (!isRegisteredS8RepositoryProofBinding(binding) || authorities.has(binding)) integrity();
  const record = (binding as BoundBinding).resolveBindingRecord();
  if (!record || typeof record !== "object" || !record.repositoryIdentity || !record.trust) integrity();
  authorities.add(binding);
  const assertLease = (lease: S8RepositoryLease) => record.assertLiveLease(lease);
  const authority: S8RepositoryProofAuthority = Object.freeze({
    validateLocked(lease, graph, baseline) {
      assertLease(lease);
      validateStateShape(graph, record.trust, record);
      validateStateShape(baseline, record.trust, record);
      validateTransition(baseline, graph);
      const prior = new Set(baseline.s8NativeProofCheckpoints!.map((item) => item.checkpointSha256));
      for (const checkpoint of baseline.s8NativeProofCheckpoints!) {
        if (!graph.s8NativeProofCheckpoints!.some((candidate) => candidate.checkpointSha256 === checkpoint.checkpointSha256)) integrity();
      }
      const digest = sha256(jcs(graph));
      const validated = Object.freeze({});
      validatedGraphs.set(validated, { repositoryIdentity: record.repositoryIdentity, state: cloneJson(graph), digest });
      void prior;
      return validated;
    },
    projectLocked(lease, graph, projectId, artifactId) {
      assertLease(lease);
      const validated = validatedGraphs.get(graph);
      if (!validated || validated.repositoryIdentity !== record.repositoryIdentity) integrity();
      const state = validated.state;
      const artifact = state.s8Artifacts!.find((item) => item.projectId === projectId && item.artifactId === artifactId);
      const job = artifact ? state.s8ExportJobs!.find((item) => item.jobId === artifact.jobId && item.projectId === projectId) : undefined;
      if (!artifact || !job) throw new AppError(404, "NOT_FOUND");
      const source = record.readSourceView(state, projectId) as { sourceDisposition?: unknown; source?: unknown } | null;
      const observedDisposition = source?.sourceDisposition === "STALE" ? "STALE" :
        source?.sourceDisposition === "CURRENT" ? "CURRENT" : "NOT_READY";
      const sourceDisposition = observedDisposition === "CURRENT" && jcs(source?.source) !== jcs(artifact.source)
        ? "STALE" : observedDisposition;
      const lifecycleValue = lifecycle(job, artifact, state);
      const publicArtifact: Record<string, unknown> = { ...cloneJson(artifact) };
      for (const field of ["privateStagingPrefix", "privateFinalPrefix", "headCheckpointSha256", "terminalOutcomeId", "quarantineId"]) {
        delete publicArtifact[field];
      }
      const publicJob: Record<string, unknown> = { ...cloneJson(job) };
      for (const field of ["claimToken", "nativeClaimToken", "ownerId", "ownerProcessId", "claimedAt", "heartbeatAt",
        "headCheckpointSha256", "terminalOutcomeId", "quarantineId", "retryDecisionId"]) delete publicJob[field];
      const immutableArtifact = deepFreezePublic(publicArtifact);
      const immutableApplicationArtifact = deepFreezePublic(cloneJson(artifact));
      const immutableJob = deepFreezePublic(publicJob);
      const validationReceipt = artifact.validationReceiptId === null ? null :
        state.s8ValidationReceipts!.find((item) => item.receiptId === artifact.validationReceiptId) ?? null;
      const projection = Object.freeze({
        publicArtifact() { assertProjection(this); return deepFreezePublic(cloneJson(projections.get(this)!.artifact)); },
        publicJob() { assertProjection(this); return deepFreezePublic(cloneJson(projections.get(this)!.job)); },
        applicationArtifact() { assertProjection(this); return deepFreezePublic(cloneJson(projections.get(this)!.applicationArtifact)); },
        validationReceipt() {
          assertProjection(this);
          const receipt = projections.get(this)!.validationReceipt;
          return receipt === null ? null : deepFreezePublic(cloneJson(receipt));
        },
        lifecycle() { assertProjection(this); return projections.get(this)!.lifecycle; },
        sourceDisposition() { assertProjection(this); return projections.get(this)!.sourceDisposition; },
      });
      projections.set(projection, {
        repositoryIdentity: record.repositoryIdentity, projectId, artifactId, lifecycle: lifecycleValue,
        sourceDisposition, artifact: immutableArtifact, applicationArtifact: immutableApplicationArtifact,
        job: immutableJob, validationReceipt: validationReceipt === null ? null : deepFreezePublic(cloneJson(validationReceipt)),
      });
      return projection;
    },
    applyLocked(lease, baseline, working, command) {
      assertLease(lease);
      if (typeof command !== "object" || command === null || Array.isArray(command)) integrity();
      const commandRecord = command as Record<string, unknown>;
      const kind = commandRecord.kind;
      exact(commandRecord, kind === "claimQueued"
        ? ["kind", "action", "projectId", "jobId", "artifactId"]
        : ["kind", "projectId", "jobId", "artifactId"]);
      if (typeof kind !== "string" || !["createQueued", "claimQueued", "beginNativeAttempt", "prepareNativeAttempt", "persistNativeAcceptance", "persistNativeFailure", "stageAcceptedWriter", "validateAcceptedPair", "promoteValidated", "commitPromoted", "recordTerminalFailure", "scheduleRetry", "reclaimPublication", "reconcilePreparedAttempt"].includes(kind)) integrity();
      if (kind === "createQueued" || kind === "claimQueued") {
        validateStateShape(working, record.trust, record);
        if (kind === "createQueued") applyCreateQueued(baseline, working, commandRecord);
        else applyClaimQueued(baseline, working, commandRecord);
      } else if (kind === "beginNativeAttempt") applyBeginNativeAttempt(baseline, working, commandRecord);
      else if (kind === "prepareNativeAttempt") applyPrepareNativeAttempt(baseline, working, commandRecord, record.trust);
      else if (kind === "persistNativeAcceptance") applyPersistNativeAcceptance(baseline, working, commandRecord);
      else if (kind === "stageAcceptedWriter") applyStageAcceptedWriter(baseline, working, commandRecord, record.trust);
      else if (kind === "validateAcceptedPair") applyValidateAcceptedPair(baseline, working, commandRecord, record.trust);
      else if (kind === "promoteValidated") applyPromoteValidated(baseline, working, commandRecord, record.trust, record);
      else if (kind === "commitPromoted") applyCommitPromoted(baseline, working, commandRecord, record.trust, record);
      else if (kind === "persistNativeFailure") applyPersistNativeFailure(baseline, working, commandRecord, record.trust);
      else if (kind === "reconcilePreparedAttempt") applyReconcilePreparedAttempt(baseline, working, commandRecord, record.trust);
      else if (kind === "recordTerminalFailure") applyRecordTerminalFailure(baseline, working, commandRecord);
      else if (kind === "scheduleRetry") applyScheduleRetry(baseline, working, commandRecord, record);
      else if (kind === "reclaimPublication") applyReclaimPublication(baseline, working, commandRecord, record);
      else throw new AppError(409, "S8_PROOF_REQUIRED");
      validateStateShape(working, record.trust, record);
      validateTransition(baseline, working);
    },
    migrateLocked(lease, decoded) {
      assertLease(lease);
      return validateLegacyStateAndMigrate(decoded, record);
    },
  });
  return authority;
}

function assertProjection(receiver: object): void {
  if (!projections.has(receiver)) throw new AppError(409, "S8_PROOF_REQUIRED");
}
