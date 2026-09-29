import { createPrivateKey, randomBytes, sign, verify } from "node:crypto";
import { jcs, sha256 } from "./utils";
import { S8_FBX_PROFILE, S8_LIMITS } from "./s8-fbx-profile";
import { S8_NATIVE_RESOURCE_POLICY, S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./s8-native-admission";
import { AppError } from "./types";
import type { S8NativeWorkerConfig } from "./s8-fbx-config";
import { S8_NATIVE_WORKER_PROTOCOL_VERSION } from "./s8-native-release";
import type { S8RunnerEvidence } from "./s8-fbx-worker";

export function canonicalS8RunnerReceiptBytes(value: S8RunnerEvidence): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: value.schemaVersion,
    protocol: value.protocol,
    policyId: value.policyId,
    requested: {
      rlimitAsBytes: value.requested.rlimitAsBytes,
      rlimitFsizeBytes: value.requested.rlimitFsizeBytes,
      rlimitCpuSeconds: value.requested.rlimitCpuSeconds,
      rlimitNproc: value.requested.rlimitNproc,
      wallTimeoutMs: value.requested.wallTimeoutMs,
      stdoutBytes: value.requested.stdoutBytes,
      stderrBytes: value.requested.stderrBytes,
      maxChildren: value.requested.maxChildren,
    },
    appliedByChild: {
      rlimitAsBytes: value.appliedByChild.rlimitAsBytes,
      rlimitFsizeBytes: value.appliedByChild.rlimitFsizeBytes,
      rlimitCpuSeconds: value.appliedByChild.rlimitCpuSeconds,
      rlimitNproc: value.appliedByChild.rlimitNproc,
      noNewPrivs: value.appliedByChild.noNewPrivs,
      seccompMode: value.appliedByChild.seccompMode,
    },
    observedByRunnerParent: {
      rlimitAsBytes: value.observedByRunnerParent.rlimitAsBytes,
      rlimitFsizeBytes: value.observedByRunnerParent.rlimitFsizeBytes,
      rlimitCpuSeconds: value.observedByRunnerParent.rlimitCpuSeconds,
      rlimitNproc: value.observedByRunnerParent.rlimitNproc,
      noNewPrivs: value.observedByRunnerParent.noNewPrivs,
      seccompMode: value.observedByRunnerParent.seccompMode,
    },
    runnerParentVerification: {
      status: value.runnerParentVerification.status,
      mismatchCode: value.runnerParentVerification.mismatchCode,
    },
    runnerBinary: { selfSha256: value.runnerBinary.selfSha256 },
    result: {
      code: value.result.code,
      name: value.result.name,
      terminationClass: value.result.terminationClass,
      targetExit: value.result.targetExit,
      targetSignal: value.result.targetSignal,
      elapsedMs: value.result.elapsedMs,
      stdoutBytes: value.result.stdoutBytes,
      stderrBytes: value.result.stderrBytes,
      setupStage: value.result.setupStage,
      evidenceCode: value.result.evidenceCode,
    },
  }), "utf8");
}

export type S8NativeOperation = "WRITER" | "VALIDATOR";
export type S8NativeOperationContext = {
  projectId: string;
  jobId: string;
  artifactId: string;
  attempt: number;
  source: unknown;
  inputSha256: string;
};

export type S8NativeRequestBody = {
  schemaVersion: "s8-native-request-v1";
  keyId: string;
  projectId: string;
  jobId: string;
  artifactId: string;
  attempt: number;
  operation: S8NativeOperation;
  sourceSha256: string;
  profile: typeof S8_FBX_PROFILE;
  protocolVersion: typeof S8_NATIVE_WORKER_PROTOCOL_VERSION;
  configSha256: string;
  inputSha256: string;
  inputBytes: number;
  deadlineUnixMs: number;
  nonce: string;
  releaseHandle: string | null;
};

export type S8SignedNativeRequest = {
  body: S8NativeRequestBody;
  signature: string;
};

export type S8NativeResponseBody = {
  schemaVersion: "s8-native-response-v1";
  launcherKeyId: string;
  requestSha256: string;
  projectId: string;
  jobId: string;
  artifactId: string;
  attempt: number;
  operation: S8NativeOperation;
  sourceSha256: string;
  releaseManifestSha256: string;
  imageDigest: string;
  containerId: string;
  inputSha256: string;
  inputBytes: number;
  outputSha256: string;
  outputBytes: number;
  auxiliarySha256: string;
  auxiliaryBytes: number;
  exitClass: "EXIT_0" | "TRANSIENT_INFRASTRUCTURE_FAILURE" | "PERMANENT_FAILURE";
  limitProfileSha256: string;
  disposalState: "REAPED_REMOVED";
  releaseHandle: string | null;
  validatorIdentity: string | null;
  runnerEvidence: unknown;
};

export type S8SignedNativeResponse = {
  body: S8NativeResponseBody;
  signature: string;
};

export type S8NativeRequestFrame = {
  request: S8SignedNativeRequest;
  requestSha256: string;
  headerBytes: Buffer;
  prefixBytes: Buffer;
  contentLength: number;
};

export type S8NativeResponsePayload = {
  response: S8SignedNativeResponse;
  output: Buffer;
  auxiliary: Buffer;
};

export type S8NativeResponseExpectation = {
  request: S8SignedNativeRequest;
  requestSha256: string;
  inputBytes: number;
  expectedReleaseManifestSha256?: string;
  expectedReleaseHandle?: string;
  launcherKeys: Readonly<Record<string, string>>;
  expectedImageDigest?: string;
  expectedValidatorIdentity?: string;
};

const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const RELEASE_HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_DOMAIN = "S8-NATIVE-REQUEST-V1\0";
const RESPONSE_DOMAIN = "S8-NATIVE-RESPONSE-V1\0";
const STATUS_REQUEST_DOMAIN = "S8-NATIVE-STATUS-REQUEST-V1\0";
const STATUS_RESPONSE_DOMAIN = "S8-NATIVE-STATUS-RESPONSE-V1\0";
const MAX_HEADER_BYTES = 64 * 1024;
const EMPTY_SHA256 = sha256(Buffer.alloc(0));

export class S8NativeSignedFailure extends AppError {
  readonly failureClass: "TRANSIENT" | "PERMANENT";
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly releaseManifestSha256: string;
  readonly operation: S8NativeOperation;

  constructor(failureClass: "TRANSIENT" | "PERMANENT", requestSha256: string, responseSha256: string, releaseManifestSha256: string, operation: S8NativeOperation) {
    super(failureClass === "TRANSIENT" ? 503 : 422, failureClass === "TRANSIENT" ? "S8_NATIVE_TRANSIENT_FAILURE" : "S8_NATIVE_OPERATION_FAILED");
    this.name = "S8NativeSignedFailure";
    this.failureClass = failureClass;
    this.requestSha256 = requestSha256;
    this.responseSha256 = responseSha256;
    this.releaseManifestSha256 = releaseManifestSha256;
    this.operation = operation;
  }
}

function fail(): never {
  throw new Error("S8_NATIVE_PROTOCOL_INVALID");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function signBody(body: Record<string, unknown>, pem: string, domain: string): string {
  return sign(null, Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from(jcs(body), "utf8")]), createPrivateKey(pem)).toString("base64url");
}

function verifyBody(body: Record<string, unknown>, signature: unknown, pem: string, domain: string): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && verify(null, Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from(jcs(body), "utf8")]), pem, bytes);
}

export function createS8NativeRequestFrame(
  operation: S8NativeOperation,
  payload: Buffer,
  context: S8NativeOperationContext,
  releaseHandle: string | null,
  config: S8NativeWorkerConfig,
  nowMs = Date.now(),
): S8NativeRequestFrame {
  if (!UUID.test(context.projectId) || !UUID.test(context.jobId) || !UUID.test(context.artifactId)
    || !Number.isSafeInteger(context.attempt) || context.attempt < 1 || context.attempt > 2
    || !digest(context.inputSha256) || sha256(payload) !== context.inputSha256
    || payload.length === 0 || (operation === "WRITER" && payload.length > S8_LIMITS.payloadBytes)
    || (operation === "VALIDATOR" && payload.length > 128 * 1024 * 1024)
    || (operation === "WRITER" && releaseHandle !== null)
    || (operation === "VALIDATOR" && (!releaseHandle || !RELEASE_HANDLE.test(releaseHandle)))) fail();

  const body: S8NativeRequestBody = {
    schemaVersion: "s8-native-request-v1",
    keyId: config.appSigningKeyId,
    projectId: context.projectId,
    jobId: context.jobId,
    artifactId: context.artifactId,
    attempt: context.attempt,
    operation,
    sourceSha256: sha256(jcs(context.source)),
    profile: S8_FBX_PROFILE,
    protocolVersion: S8_NATIVE_WORKER_PROTOCOL_VERSION,
    configSha256: sha256(jcs({ profile: S8_FBX_PROFILE, protocolVersion: S8_NATIVE_WORKER_PROTOCOL_VERSION, resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256 })),
    inputSha256: context.inputSha256,
    inputBytes: payload.length,
    deadlineUnixMs: nowMs + (operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer.endToEndDeadlineMs : S8_NATIVE_RESOURCE_POLICY.validator.endToEndDeadlineMs),
    nonce: randomBytes(32).toString("base64url"),
    releaseHandle,
  };
  const request = { body, signature: signBody(body as unknown as Record<string, unknown>, config.appSigningPrivateKeyPem, REQUEST_DOMAIN) };
  const headerBytes = Buffer.from(jcs(request), "utf8");
  if (headerBytes.length === 0 || headerBytes.length > MAX_HEADER_BYTES) fail();
  const prefixBytes = Buffer.allocUnsafe(4 + headerBytes.length + 8);
  prefixBytes.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(prefixBytes, 4);
  prefixBytes.writeBigUInt64BE(BigInt(payload.length), 4 + headerBytes.length);
  return {
    request,
    requestSha256: sha256(jcs(request)),
    headerBytes,
    prefixBytes,
    contentLength: prefixBytes.length + payload.length,
  };
}

export type S8NativeStatusRequest = {
  body: {
    schemaVersion: "s8-native-status-request-v1";
    keyId: string;
    projectId: string;
    jobId: string;
    artifactId: string;
    attempt: number;
    operation: S8NativeOperation;
    requestSha256: string;
    nonce: string;
  };
  signature: string;
};

export type S8NativeStatusResponseBody = {
  schemaVersion: "s8-native-status-response-v1";
  launcherKeyId: string;
  statusRequestSha256: string;
  jobId: string;
  artifactId: string;
  attempt: number;
  operation: S8NativeOperation;
  requestSha256: string;
  state: "NOT_FOUND" | "STARTED" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CONFLICT";
  disposalState: "NOT_STARTED" | "RUNNING" | "REAPED_REMOVED" | "UNKNOWN";
  failureClass: "TRANSIENT" | "PERMANENT" | "UNCERTAIN" | null;
  responseSha256: string | null;
  failureFrameBase64: string | null;
  observedAt: string;
};

export function createS8NativeStatusRequest(
  request: S8SignedNativeRequest,
  requestSha256: string,
  config: S8NativeWorkerConfig,
): S8NativeStatusRequest {
  if (!digest(requestSha256) || request.body.keyId !== config.appSigningKeyId) fail();
  const body = {
    schemaVersion: "s8-native-status-request-v1" as const,
    keyId: config.appSigningKeyId,
    projectId: request.body.projectId,
    jobId: request.body.jobId,
    artifactId: request.body.artifactId,
    attempt: request.body.attempt,
    operation: request.body.operation,
    requestSha256,
    nonce: randomBytes(32).toString("base64url"),
  };
  return { body, signature: signBody(body, config.appSigningPrivateKeyPem, STATUS_REQUEST_DOMAIN) };
}

export function parseS8NativeStatusResponse(
  bytes: Buffer,
  expected: { statusRequestSha256: string; request: S8SignedNativeRequest; requestSha256: string; launcherKeys: Readonly<Record<string, string>> },
): S8NativeStatusResponseBody {
  if (bytes.length === 0 || bytes.length > 128 * 1024) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
  const signed = asRecord(parsed);
  exactKeys(signed, ["body", "signature"]);
  const body = asRecord(signed.body);
  exactKeys(body, ["schemaVersion", "launcherKeyId", "statusRequestSha256", "jobId", "artifactId", "attempt", "operation", "requestSha256", "state", "disposalState", "failureClass", "responseSha256", "failureFrameBase64", "observedAt"]);
  const states = ["NOT_FOUND", "STARTED", "SUCCEEDED", "FAILED", "UNKNOWN", "CONFLICT"];
  const disposal = ["NOT_STARTED", "RUNNING", "REAPED_REMOVED", "UNKNOWN"];
  const observedAt = typeof body.observedAt === "string" ? Date.parse(body.observedAt) : Number.NaN;
  const failureFrame = body.failureFrameBase64;
  if (jcs(parsed) !== bytes.toString("utf8") || body.schemaVersion !== "s8-native-status-response-v1"
    || typeof body.launcherKeyId !== "string" || !KEY_ID.test(body.launcherKeyId)
    || body.statusRequestSha256 !== expected.statusRequestSha256
    || body.jobId !== expected.request.body.jobId || body.artifactId !== expected.request.body.artifactId
    || body.attempt !== expected.request.body.attempt || body.operation !== expected.request.body.operation
    || body.requestSha256 !== expected.requestSha256 || !states.includes(String(body.state)) || !disposal.includes(String(body.disposalState))
    || (body.failureClass !== null && !["TRANSIENT", "PERMANENT", "UNCERTAIN"].includes(String(body.failureClass)))
    || (body.responseSha256 !== null && !digest(body.responseSha256))
    || (failureFrame !== null && (typeof failureFrame !== "string" || !/^[A-Za-z0-9_-]+$/u.test(failureFrame) || failureFrame.length > 120000))
    || !Number.isFinite(observedAt) || observedAt > Date.now() + 5000 || Date.now() - observedAt > 30_000) fail();
  if (body.state === "FAILED" ? failureFrame === null || body.responseSha256 === null : failureFrame !== null) fail();
  const publicKey = expected.launcherKeys[body.launcherKeyId];
  if (!publicKey || !verifyBody(body, signed.signature, publicKey, STATUS_RESPONSE_DOMAIN)) fail();
  return body as unknown as S8NativeStatusResponseBody;
}

function readLength(bytes: Buffer, offset: number, width: 4 | 8): number {
  if (bytes.length < offset + width) fail();
  const value = width === 4 ? BigInt(bytes.readUInt32BE(offset)) : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}

export function parseS8NativeResponseFrame(bytes: Buffer, expected: S8NativeResponseExpectation): S8NativeResponsePayload {
  if (bytes.length < 4 + 8 + 8) fail();
  const headerLength = readLength(bytes, 0, 4);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || bytes.length < 4 + headerLength + 16) fail();
  const headerStart = 4;
  const headerEnd = headerStart + headerLength;
  const outputLengthOffset = headerEnd;
  const outputLength = readLength(bytes, outputLengthOffset, 8);
  const outputStart = outputLengthOffset + 8;
  const auxiliaryLengthOffset = outputStart + outputLength;
  if (auxiliaryLengthOffset + 8 > bytes.length) fail();
  const auxiliaryLength = readLength(bytes, auxiliaryLengthOffset, 8);
  const auxiliaryStart = auxiliaryLengthOffset + 8;
  if (auxiliaryStart + auxiliaryLength !== bytes.length) fail();

  const headerBytes = bytes.subarray(headerStart, headerEnd);
  let parsed: unknown;
  try { parsed = JSON.parse(headerBytes.toString("utf8")); } catch { return fail(); }
  const signed = asRecord(parsed);
  exactKeys(signed, ["body", "signature"]);
  const body = asRecord(signed.body);
  exactKeys(body, [
    "schemaVersion", "launcherKeyId", "requestSha256", "projectId", "jobId", "artifactId", "attempt", "operation",
    "sourceSha256", "releaseManifestSha256", "imageDigest", "containerId", "inputSha256", "inputBytes",
    "outputSha256", "outputBytes", "auxiliarySha256", "auxiliaryBytes", "exitClass", "limitProfileSha256",
    "disposalState", "releaseHandle", "validatorIdentity", "runnerEvidence",
  ]);
  if (jcs(parsed) !== headerBytes.toString("utf8") || body.schemaVersion !== "s8-native-response-v1"
    || typeof body.launcherKeyId !== "string" || !KEY_ID.test(body.launcherKeyId)
    || !digest(body.requestSha256) || body.requestSha256 !== expected.requestSha256
    || body.projectId !== expected.request.body.projectId || body.jobId !== expected.request.body.jobId || body.artifactId !== expected.request.body.artifactId
    || body.attempt !== expected.request.body.attempt || body.operation !== expected.request.body.operation
    || !digest(body.sourceSha256) || body.sourceSha256 !== expected.request.body.sourceSha256
    || !digest(body.releaseManifestSha256) || (expected.expectedReleaseManifestSha256 && body.releaseManifestSha256 !== expected.expectedReleaseManifestSha256)
    || typeof body.imageDigest !== "string" || !IMAGE_DIGEST.test(body.imageDigest) || (expected.expectedImageDigest && body.imageDigest !== expected.expectedImageDigest)
    || typeof body.containerId !== "string" || !HEX64.test(body.containerId)
    || body.inputSha256 !== expected.request.body.inputSha256 || body.inputBytes !== expected.inputBytes
    || !digest(body.outputSha256) || body.outputBytes !== outputLength
    || !digest(body.auxiliarySha256) || body.auxiliaryBytes !== auxiliaryLength
    || !["EXIT_0", "TRANSIENT_INFRASTRUCTURE_FAILURE", "PERMANENT_FAILURE"].includes(String(body.exitClass)) || body.limitProfileSha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256
    || body.disposalState !== "REAPED_REMOVED"
    || !expected.launcherKeys[body.launcherKeyId]
    || !verifyBody(body, signed.signature, expected.launcherKeys[body.launcherKeyId]!, RESPONSE_DOMAIN)) fail();

  const output = bytes.subarray(outputStart, auxiliaryLengthOffset);
  const auxiliary = bytes.subarray(auxiliaryStart);
  if (sha256(output) !== body.outputSha256 || sha256(auxiliary) !== body.auxiliarySha256) fail();

  if (body.exitClass !== "EXIT_0") {
    if (outputLength !== 0 || auxiliaryLength !== 0 || body.outputSha256 !== EMPTY_SHA256 || body.auxiliarySha256 !== EMPTY_SHA256 || body.runnerEvidence !== null || body.validatorIdentity !== null) fail();
    if (body.operation === "WRITER" ? body.releaseHandle !== null : body.releaseHandle !== expected.expectedReleaseHandle) fail();
    return { response: parsed as S8SignedNativeResponse, output, auxiliary };
  }

  if (body.operation === "WRITER") {
    if (outputLength <= 27 || outputLength > S8_NATIVE_RESOURCE_POLICY.writer.outputBytes
      || auxiliaryLength === 0 || auxiliaryLength > S8_NATIVE_RESOURCE_POLICY.writer.receiptBytes
      || typeof body.releaseHandle !== "string" || !RELEASE_HANDLE.test(body.releaseHandle)
      || body.validatorIdentity !== null) fail();
  } else {
    if (outputLength === 0 || outputLength > S8_NATIVE_RESOURCE_POLICY.validator.outputBytes
      || auxiliaryLength !== 0 || body.releaseHandle !== expected.expectedReleaseHandle
      || typeof body.validatorIdentity !== "string" || body.validatorIdentity.length === 0 || body.validatorIdentity.length > 160
      || (expected.expectedValidatorIdentity && body.validatorIdentity !== expected.expectedValidatorIdentity)) fail();
  }
  return { response: parsed as S8SignedNativeResponse, output, auxiliary };
}

export function parseS8NativeJson(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const result = asRecord(value);
    if (jcs(result) !== bytes.toString("utf8")) fail();
    return result;
  } catch {
    return fail();
  }
}
