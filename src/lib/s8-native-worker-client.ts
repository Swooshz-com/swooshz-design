import { request as httpsRequest, Agent } from "node:https";
import { createS8NativeRequestFrame, createS8NativeStatusRequest, parseS8NativeJson, parseS8NativeResponseFrame, parseS8NativeStatusResponse, S8NativeSignedFailure, type S8NativeOperationContext } from "./s8-native-protocol";
import type { S8NativeValidatorResult, S8RunnerEvidence, S8WriterReceipt, S8WriterResult } from "./s8-fbx-worker";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./s8-native-admission";
import { jcs, sha256 } from "./utils";
import { AppError } from "./types";
import { decideS8NativeAdmission, type S8AdmissionDecision, type S8AdmissionEnvelope } from "./s8-native-admission";
import type { S8NativeWorkerConfig } from "./s8-fbx-config";
import { verifyS8ReleaseManifest, type S8ReleaseManifestBody, type S8VerifiedReleaseManifest } from "./s8-native-release";

const ADMISSION_RESPONSE_MAX_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_WRITER_RESPONSE_BYTES = 64 * 1024 + 16 + 128 * 1024 * 1024 + 1024 * 1024;
const MAX_VALIDATOR_RESPONSE_BYTES = 64 * 1024 + 16 + 8 * 1024 * 1024;

export type S8AdmissionJsonRequest = (url: URL, agent: Agent, timeoutMs: number) => Promise<Buffer>;

function httpsJsonRequest(url: URL, agent: Agent, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: "GET", agent, headers: { accept: "application/json" } }, (response) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
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
        if (response.statusCode !== 200) {
          reject(new Error("S8_ADMISSION_STATUS_UNAVAILABLE"));
          return;
        }
        resolve(Buffer.concat(chunks, byteLength));
      });
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("S8_ADMISSION_TIMEOUT")));
    request.on("error", reject);
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
): Promise<{ statusCode: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let byteLength = 0;
    const finish = (error?: Error | null, result?: { statusCode: number; bytes: Buffer }) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      clearTimeout(wallTimer);
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
      response.on("end", () => finish(undefined, { statusCode: response.statusCode ?? 0, bytes: Buffer.concat(chunks, byteLength) }));
      response.on("error", (error) => finish(error));
    });
    const heartbeatTimer = setInterval(() => {
      try { heartbeat(); } catch { request.destroy(new Error("S8_HEARTBEAT_FAILED")); }
    }, 20_000);
    const wallTimer = setTimeout(() => request.destroy(new Error("S8_NATIVE_OPERATION_TIMEOUT")), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("S8_NATIVE_OPERATION_TIMEOUT")));
    request.on("error", (error) => finish(error));
    const write = (bytes: Buffer): Promise<void> => new Promise((resolveWrite, rejectWrite) => {
      request.write(bytes, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite());
    });
    void (async () => {
      try {
        await write(frame.prefixBytes);
        for (let offset = 0; offset < payload.length; offset += STREAM_CHUNK_BYTES) {
          await write(payload.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, payload.length)));
        }
        request.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("S8_NATIVE_TRANSPORT_FAILED"));
      }
    })();
  });
}
function httpsJsonPost(url: URL, agent: Agent, body: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "POST",
      agent,
      headers: { accept: "application/json", "content-type": "application/json", "content-length": String(body.length) },
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 128 * 1024) { request.destroy(new Error("S8_NATIVE_STATUS_TOO_LARGE")); return; }
        chunks.push(bytes);
      });
      response.on("end", () => response.statusCode === 200 ? resolve(Buffer.concat(chunks, length)) : reject(new Error("S8_NATIVE_STATUS_UNAVAILABLE")));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("S8_NATIVE_STATUS_TIMEOUT")));
    request.on("error", reject);
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
    }, this.now());
    if (decision.state === "CLOSED") return decision;
    try { this.verifyActiveRelease(envelope); } catch { return closed("REALIZATION_DRIFT"); }
    return decision;
  }

  private verifyActiveRelease(envelope: S8AdmissionEnvelope): S8VerifiedReleaseManifest {
    const active = verifyS8ReleaseManifest(this.config.releaseManifest, this.config.releaseAuthorityKeys, this.now());
    if (envelope.capacity.proof.releaseManifestSha256 !== active.sha256) throw new Error("S8_RELEASE_MANIFEST_DRIFT");
    return active;
  }

  private async requireVerifiedOpen(): Promise<{ releaseManifestSha256: string; release: S8ReleaseManifestBody }> {
    const url = new URL("/v1/admission", this.config.gatewayUrl);
    let response: Buffer;
    try { response = await this.admissionRequest(url, this.agent, 10_000); }
    catch { throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED"); }
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
    return { releaseManifestSha256: active.sha256, release: active.manifest };
  }

  private async reconcileLostOperation(
    request: ReturnType<typeof createS8NativeRequestFrame>["request"],
    requestSha256: string,
    releaseManifestSha256: string,
    release: S8ReleaseManifestBody,
  ): Promise<Buffer> {
    try {
      const signedStatus = createS8NativeStatusRequest(request, requestSha256, this.config);
      const statusBytes = await httpsJsonPost(new URL("/v1/status", this.config.gatewayUrl), this.agent, Buffer.from(jcs(signedStatus), "utf8"), 10_000);
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
        expectedValidatorIdentity: request.body.operation === "VALIDATOR" ? `s8-validator-sha256:${release.validator.executableSha256}` : undefined,
      });
      if (parsed.response.body.exitClass === "EXIT_0" || sha256(jcs(parsed.response)) !== status.responseSha256) throw new Error("S8_NATIVE_RECONCILIATION_REQUIRED");
      return frame;
    } catch {
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
    onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string) => void,
  ): Promise<{ output: Buffer; auxiliary: Buffer; response: ReturnType<typeof parseS8NativeResponseFrame>["response"]; metadata: Buffer; requestId: string; requestSha256: string; responseSha256: string; configSha256: string; release: S8ReleaseManifestBody }> {
    const admission = await this.requireVerifiedOpen();
    if (expectedReleaseManifestSha256 && expectedReleaseManifestSha256 !== admission.releaseManifestSha256) throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED");
    const frame = createS8NativeRequestFrame(operation, payload, context, releaseHandle, this.config, this.now());
    onRequestPrepared?.(frame.requestSha256, frame.request.body.nonce, admission.releaseManifestSha256);
    let response: { statusCode: number; bytes: Buffer };
    try {
      response = await httpsOperationRequest(
        new URL("/v1/operations", this.config.gatewayUrl),
        this.agent,
        frame,
        payload,
        operation === "WRITER" ? MAX_WRITER_RESPONSE_BYTES : MAX_VALIDATOR_RESPONSE_BYTES,
        operation === "WRITER" ? 510_000 : 330_000,
        heartbeat,
      );
    } catch {
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release) };
    }
    if (response.statusCode !== 200) {
      response = { statusCode: 0, bytes: await this.reconcileLostOperation(frame.request, frame.requestSha256, admission.releaseManifestSha256, admission.release) };
    }
    const parsed = parseS8NativeResponseFrame(response.bytes, {
      request: frame.request,
      requestSha256: frame.requestSha256,
      inputBytes: payload.length,
      expectedReleaseManifestSha256: expectedReleaseManifestSha256 ?? admission.releaseManifestSha256,
      expectedReleaseHandle: releaseHandle ?? undefined,
      launcherKeys: this.config.launcherKeys,
      expectedImageDigest: operation === "WRITER" ? admission.release.writer.imageDigest : admission.release.validator.imageDigest,
      expectedValidatorIdentity: operation === "VALIDATOR" ? `s8-validator-sha256:${admission.release.validator.executableSha256}` : undefined,
    });
    const responseSha256 = sha256(jcs(parsed.response));
    if (parsed.response.body.exitClass !== "EXIT_0") throw new S8NativeSignedFailure(
      parsed.response.body.exitClass === "TRANSIENT_INFRASTRUCTURE_FAILURE" ? "TRANSIENT" : "PERMANENT",
      frame.requestSha256, responseSha256, parsed.response.body.releaseManifestSha256, operation,
    );
    return {
      output: parsed.output,
      auxiliary: parsed.auxiliary,
      response: parsed.response,
      metadata: Buffer.from(jcs({ request: frame.request, response: parsed.response }), "utf8"),
      requestId: frame.request.body.nonce,
      requestSha256: frame.requestSha256,
      responseSha256,
      configSha256: frame.request.body.configSha256,
      release: admission.release,
    };
  }

  async runWriter(payload: Buffer, context: S8NativeOperationContext, heartbeat: () => void, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string) => void): Promise<S8WriterResult & { releaseHandle: string; releaseManifestSha256: string; nativeRequestSha256: string; nativeResponseSha256: string }> {
    const result = await this.runOperation("WRITER", payload, context, null, heartbeat, undefined, onRequestPrepared);
    const receipt = parseS8NativeJson(result.auxiliary) as unknown as S8WriterReceipt;
    if (receipt.writerScriptSha256 !== result.release.writer.writerScriptSha256) throw new Error("S8_NATIVE_PROTOCOL_INVALID");
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    const caller = runnerEvidence?.verifiedByCaller;
    const brokerIdentity = {
      requestId: result.requestId,
      allocationId: null,
      brokerStatus: 200,
      launcherStatus: 200,
      nativeOuterExit: 0,
      nativeOuterSignal: null,
      policySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
      configSha256: result.configSha256,
      runnerPreSha256: caller?.preLaunchSha256 ?? null,
      runnerPostSha256: caller?.postLaunchSha256 ?? null,
    };
    return {
      artifact: result.output,
      receipt,
      runnerEvidence,
      stdout: "",
      stderr: "",
      nativeStdout: Buffer.alloc(0),
      nativeStderr: Buffer.alloc(0),
      brokerIdentity,
      brokerMetadata: result.metadata,
      releaseHandle: body.releaseHandle!,
      releaseManifestSha256: body.releaseManifestSha256,
      nativeRequestSha256: result.requestSha256,
      nativeResponseSha256: result.responseSha256,
    };
  }

  async runValidator(artifact: Buffer, context: S8NativeOperationContext, releaseHandle: string, heartbeat: () => void, expectedReleaseManifestSha256?: string, onRequestPrepared?: (requestSha256: string, requestNonce: string, releaseManifestSha256: string) => void): Promise<S8NativeValidatorResult & { nativeRequestSha256: string; nativeResponseSha256: string; releaseManifestSha256: string }> {
    const result = await this.runOperation("VALIDATOR", artifact, context, releaseHandle, heartbeat, expectedReleaseManifestSha256, onRequestPrepared);
    const readback = parseS8NativeJson(result.output);
    const body = result.response.body;
    const runnerEvidence = body.runnerEvidence as S8RunnerEvidence;
    if (runnerEvidence?.runnerBinary?.selfSha256 !== result.release.processRunnerSha256) throw new AppError(503, "S8_NATIVE_WORKER_RELEASE_MISMATCH");
    const caller = runnerEvidence?.verifiedByCaller;
    const brokerIdentity = {
      requestId: result.requestId,
      allocationId: null,
      brokerStatus: 200,
      launcherStatus: 200,
      nativeOuterExit: 0,
      nativeOuterSignal: null,
      policySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
      configSha256: result.configSha256,
      runnerPreSha256: caller?.preLaunchSha256 ?? null,
      runnerPostSha256: caller?.postLaunchSha256 ?? null,
    };
    return {
      readback: readback as unknown as S8NativeValidatorResult["readback"],
      readbackBytes: result.output,
      validatorIdentity: body.validatorIdentity ?? undefined,
      runnerEvidence,
      stdout: "",
      stderr: "",
      nativeStdout: Buffer.alloc(0),
      nativeStderr: Buffer.alloc(0),
      brokerIdentity,
      brokerMetadata: result.metadata,
      nativeRequestSha256: result.requestSha256,
      nativeResponseSha256: result.responseSha256,
      releaseManifestSha256: body.releaseManifestSha256,
    };
  }
  close(): void {
    this.agent.destroy();
  }
}
