import { request as httpsRequest, Agent } from "node:https";
import { createS8NativeRequestFrame, createS8NativeStatusRequest, parseS8NativeJson, parseS8NativeResponseFrame, parseS8NativeStatusResponse, S8NativeSignedFailure, type S8NativeOperationContext } from "./s8-native-protocol";
import type { S8NativeValidatorResult, S8RunnerEvidence, S8WriterReceipt, S8WriterResult } from "./s8-fbx-worker";
type NativeWorkerWriterResult = Omit<S8WriterResult, "brokerIdentity" | "brokerMetadata">;
type NativeWorkerValidatorResult = Omit<S8NativeValidatorResult, "brokerIdentity" | "brokerMetadata">;
import { jcs, sha256 } from "./utils";
import { AppError } from "./types";
import { decideS8NativeAdmission, S8_NATIVE_RESOURCE_POLICY, type S8AdmissionDecision, type S8AdmissionEnvelope } from "./s8-native-admission";
import type { S8NativeWorkerConfig } from "./s8-fbx-config";
import { verifyS8ReleaseManifest, type S8ReleaseManifestBody, type S8VerifiedReleaseManifest } from "./s8-native-release";

const ADMISSION_RESPONSE_MAX_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_WRITER_RESPONSE_BYTES = 64 * 1024 + 16 + 128 * 1024 * 1024 + 1024 * 1024;
const MAX_VALIDATOR_RESPONSE_BYTES = 64 * 1024 + 16 + 8 * 1024 * 1024;


function deadlineRemainingMs(deadlineUnixMs: number, now: () => number): number {
  if (!Number.isSafeInteger(deadlineUnixMs) || typeof now !== "function") throw new Error("S8_NATIVE_OPERATION_TIMEOUT");
  const remaining = deadlineUnixMs - now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("S8_NATIVE_OPERATION_TIMEOUT");
  return Math.max(1, Math.ceil(remaining));
}

function boundedTimeoutMs(maximumMs: number, deadlineUnixMs: number | undefined, now: () => number): number {
  if (deadlineUnixMs === undefined) return maximumMs;
  return Math.min(maximumMs, deadlineRemainingMs(deadlineUnixMs, now));
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
  deadlineUnixMs: number,
  now: () => number,
): Promise<{ statusCode: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const wallTimeoutMs = Math.min(timeoutMs, deadlineRemainingMs(deadlineUnixMs, now));
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
        try {
          deadlineRemainingMs(deadlineUnixMs, now);
          finish(undefined, { statusCode: response.statusCode ?? 0, bytes: Buffer.concat(chunks, byteLength) });
        } catch (error) {
          finish(error instanceof Error ? error : new Error("S8_NATIVE_OPERATION_TIMEOUT"));
        }
      });
      response.on("error", (error) => finish(error));
    });
    heartbeatTimer = setInterval(() => {
      try {
        deadlineRemainingMs(deadlineUnixMs, now);
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
        deadlineRemainingMs(deadlineUnixMs, now);
        await write(frame.prefixBytes);
        for (let offset = 0; offset < payload.length; offset += STREAM_CHUNK_BYTES) {
          deadlineRemainingMs(deadlineUnixMs, now);
          await write(payload.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, payload.length)));
        }
        deadlineRemainingMs(deadlineUnixMs, now);
        request.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("S8_NATIVE_TRANSPORT_FAILED"));
      }
    })();
  });
}
function httpsJsonPost(url: URL, agent: Agent, body: Buffer, timeoutMs: number, deadlineUnixMs: number, now: () => number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wallTimeoutMs = Math.min(timeoutMs, deadlineRemainingMs(deadlineUnixMs, now));
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
        try {
          deadlineRemainingMs(deadlineUnixMs, now);
          if (response.statusCode !== 200) finish(new Error("S8_NATIVE_STATUS_UNAVAILABLE"));
          else finish(undefined, Buffer.concat(chunks, length));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("S8_NATIVE_OPERATION_TIMEOUT"));
        }
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

  constructor(
    private readonly config: S8NativeWorkerConfig,
    private readonly admissionRequest: S8AdmissionJsonRequest = httpsJsonRequest,
    private readonly now: () => number = Date.now,
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
  }

  async getAdmission(deadlineUnixMs?: number): Promise<S8AdmissionDecision> {
    const url = new URL("/v1/admission", this.config.gatewayUrl);
    let response: Buffer;
    try {
      response = await this.admissionRequest(url, this.agent, boundedTimeoutMs(10_000, deadlineUnixMs, this.now));
      if (deadlineUnixMs !== undefined) deadlineRemainingMs(deadlineUnixMs, this.now);
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
    }, this.now());
    if (deadlineUnixMs !== undefined) {
      try { deadlineRemainingMs(deadlineUnixMs, this.now); } catch { return closed("OBSERVATION_INVALID"); }
    }
    if (decision.state === "CLOSED") return decision;
    try { this.verifyActiveRelease(envelope); } catch { return closed("REALIZATION_DRIFT"); }
    if (deadlineUnixMs !== undefined) {
      try { deadlineRemainingMs(deadlineUnixMs, this.now); } catch { return closed("OBSERVATION_INVALID"); }
    }
    return decision;
  }
  private verifyActiveRelease(envelope: S8AdmissionEnvelope): S8VerifiedReleaseManifest {
    const active = verifyS8ReleaseManifest(this.config.releaseManifest, this.config.releaseAuthorityKeys, this.now());
    assertS8ReleaseAdmissionBinding(envelope, active);
    return active;
  }

  private async requireVerifiedOpen(deadlineUnixMs: number): Promise<{ releaseManifestSha256: string; release: S8ReleaseManifestBody }> {
    const url = new URL("/v1/admission", this.config.gatewayUrl);
    let response: Buffer;
    try {
      response = await this.admissionRequest(url, this.agent, boundedTimeoutMs(10_000, deadlineUnixMs, this.now));
      deadlineRemainingMs(deadlineUnixMs, this.now);
    } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    let parsed: unknown;
    try { parsed = JSON.parse(response.toString("utf8")); } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    const envelope = parsed as S8AdmissionEnvelope;
    const decision = decideS8NativeAdmission(envelope, {
      capacityAuthorityKeys: this.config.capacityAuthorityKeys,
      launcherKeys: this.config.launcherKeys,
    }, this.now());
    if (decision.state !== "OPEN" || decision.reason !== null) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    let active: S8VerifiedReleaseManifest;
    try { active = this.verifyActiveRelease(envelope); } catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
    try { deadlineRemainingMs(deadlineUnixMs, this.now); } catch { throw new AppError(503, "S8_NATIVE_OPERATION_TIMEOUT"); }
    return { releaseManifestSha256: active.sha256, release: active.manifest };
  }
  private async reconcileLostOperation(
    request: ReturnType<typeof createS8NativeRequestFrame>["request"],
    requestSha256: string,
    releaseManifestSha256: string,
    release: S8ReleaseManifestBody,
    deadlineUnixMs: number,
  ): Promise<Buffer> {
    try {
      const signedStatus = createS8NativeStatusRequest(request, requestSha256, this.config);
      const statusBytes = await httpsJsonPost(
        new URL("/v1/status", this.config.gatewayUrl),
        this.agent,
        Buffer.from(jcs(signedStatus), "utf8"),
        boundedTimeoutMs(10_000, deadlineUnixMs, this.now),
        deadlineUnixMs,
        this.now,
      );
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
      deadlineRemainingMs(deadlineUnixMs, this.now);
      if (parsed.response.body.exitClass === "EXIT_0" || sha256(jcs(parsed.response)) !== status.responseSha256) throw new Error("S8_NATIVE_RECONCILIATION_REQUIRED");
      return frame;
    } catch (error) {
      if (deadlineUnixMs <= this.now()) throw new AppError(504, "S8_NATIVE_OPERATION_TIMEOUT");
      throw new AppError(503, "S8_NATIVE_RECONCILIATION_REQUIRED");
    }
  }
  private async runOperation(
    operation: "WRITER" | "VALIDATOR",
    payload: Buffer,
    context: S8NativeOperationContext,
    releaseHandle: string | null,
    heartbeat: () => void,
    expectedReleaseManifestSha256?: string,
    onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number) => void,
    suppliedDeadlineUnixMs?: number,
  ): Promise<{ output: Buffer; auxiliary: Buffer; response: ReturnType<typeof parseS8NativeResponseFrame>["response"]; requestSha256: string; responseSha256: string; release: S8ReleaseManifestBody }> {
    const durationMs = operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer.endToEndDeadlineMs : S8_NATIVE_RESOURCE_POLICY.validator.endToEndDeadlineMs;
    const deadlineUnixMs = suppliedDeadlineUnixMs ?? this.now() + durationMs;
    deadlineRemainingMs(deadlineUnixMs, this.now);
    const admission = await this.requireVerifiedOpen(deadlineUnixMs);
    deadlineRemainingMs(deadlineUnixMs, this.now);
    if (expectedReleaseManifestSha256 && expectedReleaseManifestSha256 !== admission.releaseManifestSha256) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    const frame = createS8NativeRequestFrame(operation, payload, context, releaseHandle, this.config, this.now(), deadlineUnixMs);
    onRequestPrepared?.(frame.requestSha256, frame.request.body.nonce, admission.releaseManifestSha256, deadlineUnixMs);
    deadlineRemainingMs(deadlineUnixMs, this.now);
    let response: { statusCode: number; bytes: Buffer };
    try {
      response = await this.operationRequest(
        new URL("/v1/operations", this.config.gatewayUrl),
        this.agent,
        frame,
        payload,
        operation === "WRITER" ? MAX_WRITER_RESPONSE_BYTES : MAX_VALIDATOR_RESPONSE_BYTES,
        operation === "WRITER" ? 510_000 : 330_000,
        heartbeat,
        deadlineUnixMs,
        this.now,
      );
    } catch {
      deadlineRemainingMs(deadlineUnixMs, this.now);
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release, deadlineUnixMs) };
    }
    if (response.statusCode !== 200) {
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release, deadlineUnixMs) };
    }
    deadlineRemainingMs(deadlineUnixMs, this.now);
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
    deadlineRemainingMs(deadlineUnixMs, this.now);
    const responseSha256 = sha256(jcs(parsed.response));
    if (parsed.response.body.exitClass !== "EXIT_0") throw new S8NativeSignedFailure(
      parsed.response.body.exitClass === "TRANSIENT_INFRASTRUCTURE_FAILURE" ? "TRANSIENT" : "PERMANENT",
      frame.requestSha256, responseSha256, parsed.response.body.releaseManifestSha256, operation,
    );
    return {
      output: parsed.output,
      auxiliary: parsed.auxiliary,
      response: parsed.response,
      requestSha256: frame.requestSha256,
      responseSha256,
      release: admission.release,
    };
  }
  async runWriter(payload: Buffer, context: S8NativeOperationContext, heartbeat: () => void, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number) => void, deadlineUnixMs?: number): Promise<NativeWorkerWriterResult & { releaseHandle: string; releaseManifestSha256: string; nativeRequestSha256: string; nativeResponseSha256: string }> {
    const result = await this.runOperation("WRITER", payload, context, null, heartbeat, undefined, onRequestPrepared, deadlineUnixMs);
    const receipt = parseS8NativeJson(result.auxiliary) as unknown as S8WriterReceipt;
    if (receipt.writerScriptSha256 !== result.release.writer.writerScriptSha256) throw new Error("S8_NATIVE_PROTOCOL_INVALID");
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    return {
      artifact: result.output,
      receipt,
      runnerEvidence,
      stdout: "",
      stderr: "",
      nativeStdout: Buffer.alloc(0),
      nativeStderr: Buffer.alloc(0),
      releaseHandle: body.releaseHandle!,
      releaseManifestSha256: body.releaseManifestSha256,
      nativeRequestSha256: result.requestSha256,
      nativeResponseSha256: result.responseSha256,
    };
  }
  async runValidator(artifact: Buffer, context: S8NativeOperationContext, releaseHandle: string, heartbeat: () => void, expectedReleaseManifestSha256?: string, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadlineUnixMs: number) => void, deadlineUnixMs?: number): Promise<NativeWorkerValidatorResult & { nativeRequestSha256: string; nativeResponseSha256: string; releaseManifestSha256: string }> {
    const result = await this.runOperation("VALIDATOR", artifact, context, releaseHandle, heartbeat, expectedReleaseManifestSha256, onRequestPrepared, deadlineUnixMs);
    const readback = parseS8NativeJson(result.output);
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    return {
      readback: readback as unknown as S8NativeValidatorResult["readback"],
      readbackBytes: result.output,
      validatorIdentity: body.validatorIdentity ?? undefined,
      runnerEvidence,
      stdout: "",
      stderr: "",
      nativeStdout: Buffer.alloc(0),
      nativeStderr: Buffer.alloc(0),
      nativeRequestSha256: result.requestSha256,
      nativeResponseSha256: result.responseSha256,
      releaseManifestSha256: body.releaseManifestSha256,
    };
  }

  close(): void {
    this.agent.destroy();
  }
}
