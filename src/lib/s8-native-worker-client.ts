import { request as httpsRequest, Agent } from "node:https";
import { createS8NativeRequestFrame, createS8NativeStatusRequest, nativeOperationDeadlineUnixMs, nativeOperationRemainingMs, observeS8NativeResponse, parseS8NativeJson, parseS8NativeResponseFrame, parseS8NativeStatusResponse, S8NativeSignedFailure, type S8NativeOperationClock, type S8NativeOperationContext, type S8SignedNativeRequest } from "./s8-native-protocol";
import type { S8NativeValidatorResult, S8RunnerEvidence, S8WriterReceipt } from "./s8-fbx-worker";
import { jcs, sha256 } from "./utils";
import { AppError } from "./types";
import { decideS8NativeAdmission, S8_NATIVE_RESOURCE_POLICY, type S8AdmissionDecision, type S8AdmissionEnvelope } from "./s8-native-admission";
import type { S8NativeWorkerConfig } from "./s8-fbx-config";
import { verifyS8ReleaseManifest, type S8ReleaseManifestBody, type S8VerifiedReleaseManifest } from "./s8-native-release";

const ADMISSION_RESPONSE_MAX_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_WRITER_RESPONSE_BYTES = 64 * 1024 + 16 + 128 * 1024 * 1024 + 1024 * 1024;
const MAX_VALIDATOR_RESPONSE_BYTES = 64 * 1024 + 16 + 8 * 1024 * 1024;


function deadlineRemainingMs(clock: S8NativeOperationClock): number {
  return nativeOperationRemainingMs(clock);
}

function boundedTimeoutMs(maximumMs: number, clock: S8NativeOperationClock): number {
  return Math.min(maximumMs, deadlineRemainingMs(clock));
}

export function assertS8ReleaseAdmissionBinding(envelope: S8AdmissionEnvelope, active: S8VerifiedReleaseManifest): void {
  const observation = envelope.launcher.observation;
  const hostAppArmor = active.manifest.sandbox.rootlessKitHostAppArmor;
  if (envelope.capacity.proof.releaseManifestSha256 !== active.sha256
    || observation.jobAppArmorMode !== active.manifest.sandbox.jobAppArmorMode
    || observation.rootlessKitHostAppArmorMode !== hostAppArmor.mode
    || observation.rootlessKitHostAppArmorProfileName !== hostAppArmor.profileName
    || observation.rootlessKitHostAppArmorProfileSha256 !== hostAppArmor.profileSha256) {
    throw new Error("S8_RELEASE_MANIFEST_DRIFT");
  }
}

export type S8AdmissionJsonRequest = (url: URL, agent: Agent, timeoutMs: number) => Promise<Buffer>;

export type S8NativeVerifiedResultCapability = object;
export type S8NativeVerifiedResultData = Readonly<{
  operation: "WRITER" | "VALIDATOR";
  output: Buffer;
  auxiliary: Buffer;
  responseFrame: Buffer;
  response: ReturnType<typeof parseS8NativeResponseFrame>["response"];
  requestSha256: string;
  responseSha256: string;
  releaseManifestSha256: string;
  release: S8ReleaseManifestBody;
  releaseHandle?: string;
  writerReceipt?: S8WriterReceipt;
  readback?: S8NativeValidatorResult["readback"];
  validatorIdentity?: string;
  runnerEvidence: S8RunnerEvidence;
}>;

export type S8NativeVerifiedFailureData = Readonly<{
  operation: "WRITER" | "VALIDATOR";
  failureClass: "TRANSIENT" | "PERMANENT";
  response: ReturnType<typeof parseS8NativeResponseFrame>["response"];
  requestSha256: string;
  responseSha256: string;
  releaseManifestSha256: string;
}>;

type NativeVerifiedCapabilityRecord = Readonly<{
  operation: "WRITER" | "VALIDATOR";
  clock: S8NativeOperationClock;
  contextSha256: string;
  data: S8NativeVerifiedResultData;
}>;

type NativeVerifiedFailureRecord = Readonly<{
  operation: "WRITER" | "VALIDATOR";
  clock: S8NativeOperationClock;
  contextSha256: string;
  data: S8NativeVerifiedFailureData;
}>;

const registeredClients = new WeakSet<object>();

export function isRegisteredS8NativeWorkerClient(value: unknown): value is S8NativeWorkerClient {
  return typeof value === "object" && value !== null && registeredClients.has(value);
}

function httpsJsonRequest(url: URL, agent: Agent, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let byteLength = 0;
    const chunks: Buffer[] = [];
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error | null, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (error) reject(error);
      else if (bytes) resolve(bytes);
      else reject(new Error("S8_ADMISSION_STATUS_UNAVAILABLE"));
    };
    const request = httpsRequest(url, { method: "GET", agent, headers: { accept: "application/json" } }, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.length;
        if (byteLength > ADMISSION_RESPONSE_MAX_BYTES) {
          request.destroy(new Error("S8_ADMISSION_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) finish(new Error("S8_ADMISSION_STATUS_UNAVAILABLE"));
        else finish(undefined, Buffer.concat(chunks, byteLength));
      });
      response.on("error", (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("S8_ADMISSION_TIMEOUT")));
    wallTimer = setTimeout(() => request.destroy(new Error("S8_ADMISSION_TIMEOUT")), timeoutMs);
    request.on("error", (error) => finish(error));
    request.end();
  });
}
function httpsOperationRequest(
  url: URL,
  agent: Agent,
  frame: ReturnType<typeof createS8NativeRequestFrame>,
  payload: Buffer,
  maximumResponseBytes: number,
  timeoutMs: number,
  heartbeat: () => void,
  clock: S8NativeOperationClock,
): Promise<{ statusCode: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const wallTimeoutMs = Math.min(timeoutMs, deadlineRemainingMs(clock));
    let settled = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    const chunks: Buffer[] = [];
    let byteLength = 0;
    const finish = (error?: Error | null, result?: { statusCode: number; bytes: Buffer }) => {
      if (settled) return;
      settled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("S8_NATIVE_TRANSPORT_FAILED"));
    };
    const request = httpsRequest(url, {
      method: "POST",
      agent,
      headers: {
        accept: "application/vnd.s8-native-frame-v1",
        "content-type": "application/vnd.s8-native-frame-v1",
        "content-length": String(frame.contentLength),
      },
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.length;
        if (byteLength > maximumResponseBytes) {
          request.destroy(new Error("S8_NATIVE_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        finish(undefined, { statusCode: response.statusCode ?? 0, bytes: Buffer.concat(chunks, byteLength) });
      });
      response.on("error", (error) => finish(error));
    });
    heartbeatTimer = setInterval(() => {
      try {
        deadlineRemainingMs(clock);
        heartbeat();
      } catch { request.destroy(new Error("S8_HEARTBEAT_FAILED")); }
    }, 20_000);
    wallTimer = setTimeout(() => request.destroy(new Error("S8_NATIVE_OPERATION_TIMEOUT")), wallTimeoutMs);
    request.setTimeout(wallTimeoutMs, () => request.destroy(new Error("S8_NATIVE_OPERATION_TIMEOUT")));
    request.on("error", (error) => finish(error));
    const write = (bytes: Buffer): Promise<void> => new Promise((resolveWrite, rejectWrite) => {
      request.write(bytes, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite());
    });
    void (async () => {
      try {
        deadlineRemainingMs(clock);
        await write(frame.prefixBytes);
        for (let offset = 0; offset < payload.length; offset += STREAM_CHUNK_BYTES) {
          deadlineRemainingMs(clock);
          await write(payload.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, payload.length)));
        }
        deadlineRemainingMs(clock);
        request.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("S8_NATIVE_TRANSPORT_FAILED"));
      }
    })();
  });
}
function httpsJsonPost(url: URL, agent: Agent, body: Buffer, timeoutMs: number, clock: S8NativeOperationClock): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wallTimeoutMs = Math.min(timeoutMs, deadlineRemainingMs(clock));
    let settled = false;
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    let length = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error | null, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (error) reject(error);
      else if (bytes) resolve(bytes);
      else reject(new Error("S8_NATIVE_STATUS_UNAVAILABLE"));
    };
    const request = httpsRequest(url, {
      method: "POST",
      agent,
      headers: { accept: "application/json", "content-type": "application/json", "content-length": String(body.length) },
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 128 * 1024) { request.destroy(new Error("S8_NATIVE_STATUS_TOO_LARGE")); return; }
        chunks.push(bytes);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) finish(new Error("S8_NATIVE_STATUS_UNAVAILABLE"));
        else finish(undefined, Buffer.concat(chunks, length));
      });
      response.on("error", (error) => finish(error));
    });
    request.setTimeout(wallTimeoutMs, () => request.destroy(new Error("S8_NATIVE_STATUS_TIMEOUT")));
    wallTimer = setTimeout(() => request.destroy(new Error("S8_NATIVE_STATUS_TIMEOUT")), wallTimeoutMs);
    request.on("error", (error) => finish(error));
    request.end(body);
  });
}
function closed(reason: S8AdmissionDecision["reason"]): S8AdmissionDecision {
  return { state: "CLOSED", reason, proofSha256: null, observedAt: null };
}

export class S8NativeWorkerClient {
  private readonly agent: Agent;
  readonly #verifiedResults = new WeakMap<object, NativeVerifiedCapabilityRecord>();
  readonly #verifiedFailures = new WeakMap<object, NativeVerifiedFailureRecord>();

  constructor(
    private readonly config: S8NativeWorkerConfig,
    private readonly admissionRequest: S8AdmissionJsonRequest = httpsJsonRequest,
    private readonly operationRequest: typeof httpsOperationRequest = httpsOperationRequest,
  ) {
    this.agent = new Agent({
      ca: config.tlsCaPem,
      cert: config.tlsClientCertPem,
      key: config.tlsClientKeyPem,
      rejectUnauthorized: true,
      keepAlive: true,
      maxSockets: 1,
    });
    registeredClients.add(this);
  }

  isBoundTo(config: S8NativeWorkerConfig): boolean {
    return this.config === config;
  }

  async getAdmission(): Promise<S8AdmissionDecision> {
    const url = new URL("/v1/admission", this.config.gatewayUrl);
    let response: Buffer;
    try {
      response = await this.admissionRequest(url, this.agent, 10_000);
    } catch {
      return closed("OBSERVATION_INVALID");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(response.toString("utf8")); } catch { return closed("OBSERVATION_INVALID"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return closed("OBSERVATION_INVALID");
    const envelope = parsed as S8AdmissionEnvelope;
    const decision = decideS8NativeAdmission(envelope, {
      capacityAuthorityKeys: this.config.capacityAuthorityKeys,
      launcherKeys: this.config.launcherKeys,
    }, Date.now());
    if (decision.state === "CLOSED") return decision;
    try { this.verifyActiveRelease(envelope); } catch { return closed("REALIZATION_DRIFT"); }
    return decision;
  }
  private verifyActiveRelease(envelope: S8AdmissionEnvelope): S8VerifiedReleaseManifest {
    const active = verifyS8ReleaseManifest(this.config.releaseManifest, this.config.releaseAuthorityKeys, Date.now());
    assertS8ReleaseAdmissionBinding(envelope, active);
    return active;
  }
  configuredReleaseManifestSha256(): string {
    return verifyS8ReleaseManifest(this.config.releaseManifest, this.config.releaseAuthorityKeys, Date.now()).sha256;
  }

  private async requireVerifiedOpen(clock: S8NativeOperationClock): Promise<{ releaseManifestSha256: string; release: S8ReleaseManifestBody }> {
    const url = new URL("/v1/admission", this.config.gatewayUrl);
    let response: Buffer;
    try {
      response = await this.admissionRequest(url, this.agent, boundedTimeoutMs(10_000, clock));
      deadlineRemainingMs(clock);
    } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    let parsed: unknown;
    try { parsed = JSON.parse(response.toString("utf8")); } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    const envelope = parsed as S8AdmissionEnvelope;
    const decision = decideS8NativeAdmission(envelope, {
      capacityAuthorityKeys: this.config.capacityAuthorityKeys,
      launcherKeys: this.config.launcherKeys,
    }, Date.now());
    if (decision.state !== "OPEN" || decision.reason !== null) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    let active: S8VerifiedReleaseManifest;
    try { active = this.verifyActiveRelease(envelope); } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    try { deadlineRemainingMs(clock); } catch { throw new AppError(503, "S8_NATIVE_OPERATION_TIMEOUT"); }
    return { releaseManifestSha256: active.sha256, release: active.manifest };
  }
  private async reconcileLostOperation(
    request: ReturnType<typeof createS8NativeRequestFrame>["request"],
    requestSha256: string,
    releaseManifestSha256: string,
    release: S8ReleaseManifestBody,
    clock: S8NativeOperationClock,
  ): Promise<Buffer> {
    try {
      const signedStatus = createS8NativeStatusRequest(request, requestSha256, this.config);
      const statusBytes = await httpsJsonPost(
        new URL("/v1/status", this.config.gatewayUrl),
        this.agent,
        Buffer.from(jcs(signedStatus), "utf8"),
        boundedTimeoutMs(10_000, clock),
        clock,
      );
      observeS8NativeResponse(clock);
      const status = parseS8NativeStatusResponse(statusBytes, {
        statusRequestSha256: sha256(jcs(signedStatus)),
        request,
        requestSha256,
        launcherKeys: this.config.launcherKeys,
      });
      if (status.state !== "FAILED" || !status.failureFrameBase64 || !status.responseSha256) throw new Error("S8_NATIVE_RECONCILIATION_REQUIRED");
      const frame = Buffer.from(status.failureFrameBase64, "base64url");
      const parsed = parseS8NativeResponseFrame(frame, {
        request,
        requestSha256,
        inputBytes: request.body.inputBytes,
        expectedReleaseManifestSha256: releaseManifestSha256,
        expectedReleaseHandle: request.body.releaseHandle ?? undefined,
        launcherKeys: this.config.launcherKeys,
        expectedImageDigest: request.body.operation === "WRITER" ? release.writer.imageDigest : release.validator.imageDigest,
        expectedValidatorIdentity: request.body.operation === "VALIDATOR" ? "s8-validator-sha256:" + release.validator.executableSha256 : undefined,
      });
      deadlineRemainingMs(clock);
      if (parsed.response.body.exitClass === "EXIT_0" || sha256(jcs(parsed.response)) !== status.responseSha256) throw new Error("S8_NATIVE_RECONCILIATION_REQUIRED");
      return frame;
    } catch (error) {
      try { deadlineRemainingMs(clock); } catch { throw new AppError(504, "S8_NATIVE_OPERATION_TIMEOUT"); }
      throw new AppError(503, "S8_NATIVE_RECONCILIATION_REQUIRED");
    }
  }
  private async runOperation(
    operation: "WRITER" | "VALIDATOR",
    payload: Buffer,
    context: S8NativeOperationContext,
    releaseHandle: string | null,
    heartbeat: () => void,
    clock: S8NativeOperationClock,
    expectedReleaseManifestSha256?: string,
    onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number, clock: S8NativeOperationClock, signedRequest: S8SignedNativeRequest) => void,
  ): Promise<{ output: Buffer; auxiliary: Buffer; responseFrame: Buffer; response: ReturnType<typeof parseS8NativeResponseFrame>["response"]; requestSha256: string; responseSha256: string; releaseManifestSha256: string; release: S8ReleaseManifestBody }> {
    const deadlineUnixMs = nativeOperationDeadlineUnixMs(clock);
    deadlineRemainingMs(clock);
    const admission = await this.requireVerifiedOpen(clock);
    deadlineRemainingMs(clock);
    if (expectedReleaseManifestSha256 && expectedReleaseManifestSha256 !== admission.releaseManifestSha256) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    const frame = createS8NativeRequestFrame(operation, payload, context, clock, releaseHandle, this.config);
    onRequestPrepared?.(frame.requestSha256, frame.request.body.nonce, admission.releaseManifestSha256, deadlineUnixMs, clock, frame.request);
    deadlineRemainingMs(clock);
    let response: { statusCode: number; bytes: Buffer };
    try {
      response = await this.operationRequest(
        new URL("/v1/operations", this.config.gatewayUrl),
        this.agent,
        frame,
        payload,
        operation === "WRITER" ? MAX_WRITER_RESPONSE_BYTES : MAX_VALIDATOR_RESPONSE_BYTES,
        operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer.endToEndDeadlineMs : S8_NATIVE_RESOURCE_POLICY.validator.endToEndDeadlineMs,
        heartbeat,
        clock,
      );
    } catch {
      deadlineRemainingMs(clock);
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release, clock) };
    }
    if (response.statusCode !== 200) {
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release, clock) };
    } else {
      observeS8NativeResponse(clock);
    }
    const parsed = parseS8NativeResponseFrame(response.bytes, {
      request: frame.request,
      requestSha256: frame.requestSha256,
      inputBytes: payload.length,
      expectedReleaseManifestSha256: expectedReleaseManifestSha256 ?? admission.releaseManifestSha256,
      expectedReleaseHandle: releaseHandle ?? undefined,
      launcherKeys: this.config.launcherKeys,
      expectedImageDigest: operation === "WRITER" ? admission.release.writer.imageDigest : admission.release.validator.imageDigest,
      expectedValidatorIdentity: operation === "VALIDATOR" ? "s8-validator-sha256:" + admission.release.validator.executableSha256 : undefined,
    });
    const responseSha256 = sha256(jcs(parsed.response));
    if (parsed.response.body.exitClass !== "EXIT_0") {
      const failureClass = parsed.response.body.exitClass === "TRANSIENT_INFRASTRUCTURE_FAILURE" ? "TRANSIENT" : "PERMANENT";
      const failure = new S8NativeSignedFailure(failureClass, frame.requestSha256, responseSha256,
        parsed.response.body.releaseManifestSha256, operation);
      this.#verifiedFailures.set(failure, Object.freeze({ operation, clock, contextSha256: sha256(jcs(context)),
        data: Object.freeze({ operation, failureClass, response: JSON.parse(jcs(parsed.response)) as typeof parsed.response,
          requestSha256: frame.requestSha256, responseSha256, releaseManifestSha256: admission.releaseManifestSha256 }) }));
      throw failure;
    }
    return {
      output: parsed.output,
      auxiliary: parsed.auxiliary,
      responseFrame: Buffer.from(response.bytes),
      response: parsed.response,
      requestSha256: frame.requestSha256,
      responseSha256,
      releaseManifestSha256: admission.releaseManifestSha256,
      release: admission.release,
    };
  }
  private issueVerifiedResult(operation: "WRITER" | "VALIDATOR", context: S8NativeOperationContext, clock: S8NativeOperationClock, data: S8NativeVerifiedResultData): S8NativeVerifiedResultCapability {
    const capability = Object.freeze({});
    const privateCopy = Object.freeze({ ...data, output: Buffer.from(data.output), auxiliary: Buffer.from(data.auxiliary), responseFrame: Buffer.from(data.responseFrame),
      response: JSON.parse(jcs(data.response)) as typeof data.response, release: JSON.parse(jcs(data.release)) as S8ReleaseManifestBody,
      writerReceipt: data.writerReceipt ? JSON.parse(jcs(data.writerReceipt)) as S8WriterReceipt : undefined,
      readback: data.readback ? JSON.parse(jcs(data.readback)) as S8NativeValidatorResult["readback"] : undefined,
      runnerEvidence: JSON.parse(jcs(data.runnerEvidence)) as S8RunnerEvidence,
    });
    this.#verifiedResults.set(capability, Object.freeze({ operation, contextSha256: sha256(jcs(context)), clock, data: privateCopy }));
    return capability;
  }

  consumeVerifiedResult(capability: S8NativeVerifiedResultCapability, operation: "WRITER" | "VALIDATOR", context: S8NativeOperationContext, clock: S8NativeOperationClock): S8NativeVerifiedResultData {
    if (typeof capability !== "object" || capability === null) throw new AppError(500, "S8_PROOF_REQUIRED");
    const record = this.#verifiedResults.get(capability);
    if (!record || record.operation !== operation || record.clock !== clock || record.contextSha256 !== sha256(jcs(context))) {
      throw new AppError(500, "S8_PROOF_REQUIRED");
    }
    this.#verifiedResults.delete(capability);
    const data = record.data;
    return Object.freeze({ ...data,
      output: Buffer.from(data.output), auxiliary: Buffer.from(data.auxiliary), responseFrame: Buffer.from(data.responseFrame),
      response: JSON.parse(jcs(data.response)) as typeof data.response,
      release: JSON.parse(jcs(data.release)) as S8ReleaseManifestBody,
      writerReceipt: data.writerReceipt ? JSON.parse(jcs(data.writerReceipt)) as S8WriterReceipt : undefined,
      readback: data.readback ? JSON.parse(jcs(data.readback)) as S8NativeValidatorResult["readback"] : undefined,
      runnerEvidence: JSON.parse(jcs(data.runnerEvidence)) as S8RunnerEvidence,
    });
  }

  consumeVerifiedFailure(error: unknown, operation: "WRITER" | "VALIDATOR", context: S8NativeOperationContext,
    clock: S8NativeOperationClock): S8NativeVerifiedFailureData {
    if (typeof error !== "object" || error === null) throw new AppError(500, "S8_PROOF_REQUIRED");
    const record = this.#verifiedFailures.get(error);
    if (!record || record.operation !== operation || record.clock !== clock || record.contextSha256 !== sha256(jcs(context))) {
      throw new AppError(500, "S8_PROOF_REQUIRED");
    }
    this.#verifiedFailures.delete(error);
    return Object.freeze({ ...record.data, response: JSON.parse(jcs(record.data.response)) as typeof record.data.response });
  }

  async runWriter(payload: Buffer, context: S8NativeOperationContext, heartbeat: () => void, clock: S8NativeOperationClock, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number, clock: S8NativeOperationClock, signedRequest: S8SignedNativeRequest) => void): Promise<S8NativeVerifiedResultCapability> {
    const result = await this.runOperation("WRITER", payload, context, null, heartbeat, clock, undefined, onRequestPrepared);
    const receipt = parseS8NativeJson(result.auxiliary) as unknown as S8WriterReceipt;
    if (receipt.writerScriptSha256 !== result.release.writer.writerScriptSha256) throw new Error("S8_NATIVE_PROTOCOL_INVALID");
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    return this.issueVerifiedResult("WRITER", context, clock, {
      operation: "WRITER", output: result.output, auxiliary: result.auxiliary, responseFrame: result.responseFrame,
      response: result.response, requestSha256: result.requestSha256, responseSha256: result.responseSha256,
      releaseManifestSha256: result.releaseManifestSha256, release: result.release,
      releaseHandle: body.releaseHandle!,
      writerReceipt: receipt, runnerEvidence,
    });
  }
  async runValidator(artifact: Buffer, context: S8NativeOperationContext, releaseHandle: string, heartbeat: () => void, clock: S8NativeOperationClock, expectedReleaseManifestSha256?: string, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number, clock: S8NativeOperationClock, signedRequest: S8SignedNativeRequest) => void): Promise<S8NativeVerifiedResultCapability> {
    const result = await this.runOperation("VALIDATOR", artifact, context, releaseHandle, heartbeat, clock, expectedReleaseManifestSha256, onRequestPrepared);
    const readback = parseS8NativeJson(result.output);
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    return this.issueVerifiedResult("VALIDATOR", context, clock, {
      operation: "VALIDATOR", output: result.output, auxiliary: result.auxiliary, responseFrame: result.responseFrame,
      response: result.response, requestSha256: result.requestSha256, responseSha256: result.responseSha256,
      releaseManifestSha256: result.releaseManifestSha256, release: result.release,
      releaseHandle: body.releaseHandle ?? undefined,
      validatorIdentity: body.validatorIdentity ?? undefined,
      readback: readback as unknown as S8NativeValidatorResult["readback"], runnerEvidence,
    });
  }

  close(): void {
    this.agent.destroy();
  }
}
