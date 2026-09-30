import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import {
  MAX_HEADER_BYTES, MAX_VALIDATOR_INPUT_BYTES, MAX_VALIDATOR_OUTPUT_BYTES,
  MAX_WRITER_INPUT_BYTES, MAX_WRITER_OUTPUT_BYTES, MAX_WRITER_RECEIPT_BYTES,
  PROFILE, PROTOCOL_VERSION, verifyRequestFrame, verifyResponseFrame, verifyStatusRequest, verifyStatusResponse,
} from "../s8-worker-common/protocol.mjs";
import { verifyAdmissionEnvelope, verifyReleaseManifest } from "../s8-worker-common/admission.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";

const MAX_ADMISSION_BYTES = 128 * 1024;
const generic = Object.freeze({ error: "S8_WORKER_UNAVAILABLE" });
export const S8_GATEWAY_OPERATION_CONTENT_TYPES = Object.freeze(["application/octet-stream", "application/vnd.s8-native-frame-v1"]);
const fingerprint = (value) => String(value ?? "").replaceAll(":", "").toLowerCase();

export function canonicalFingerprint(value) {
  if (typeof value !== "string") return null;
  const normalized = fingerprint(value);
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function privateAddress(address) {
  if (address === "127.0.0.1") return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return false;
}

function readConfigFile(path, maximumBytes = 256 * 1024, privateKey = false) {
  const info = lstatSync(path);
  const forbiddenMode = privateKey ? 0o037 : 0o022;
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes || (info.mode & forbiddenMode) !== 0
    || (privateKey && (info.mode & 0o400) === 0)) throw new Error("configuration-file-invalid");
  return readFileSync(path);
}

function readConfigJson(environment, name, maximumBytes = 256 * 1024) {
  const path = environment[name];
  if (typeof path !== "string" || path.length === 0) throw new Error("configuration-invalid");
  return JSON.parse(readConfigFile(path, maximumBytes).toString("utf8"));
}

function loadConfig(environment = process.env) {
  const bindAddress = environment.S8_GATEWAY_BIND_ADDRESS;
  const port = Number(environment.S8_GATEWAY_PORT);
  if (!bindAddress || !(bindAddress === "0.0.0.0" || privateAddress(bindAddress)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("configuration-invalid");
  const launcherUrl = new URL(environment.S8_LAUNCHER_URL ?? "");
  if (launcherUrl.protocol !== "https:" || !privateAddress(launcherUrl.hostname) || launcherUrl.pathname !== "/" || launcherUrl.search || launcherUrl.hash) throw new Error("configuration-invalid");
  const required = [
    "S8_GATEWAY_TLS_KEY_FILE", "S8_GATEWAY_TLS_CERT_FILE", "S8_GATEWAY_CLIENT_CA_FILE", "S8_APP_CLIENT_CERT_SHA256S_JSON",
    "S8_LAUNCHER_TLS_CA_FILE", "S8_LAUNCHER_TLS_CERT_FILE", "S8_LAUNCHER_TLS_KEY_FILE", "S8_LAUNCHER_SERVER_CERT_SHA256",
    "S8_APP_PUBLIC_KEYS_FILE", "S8_LAUNCHER_PUBLIC_KEYS_FILE", "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_FILE",
    "S8_RELEASE_PUBLIC_KEYS_FILE", "S8_RELEASE_MANIFEST_FILE",
  ];
  if (required.some((key) => typeof environment[key] !== "string" || environment[key].length === 0)) throw new Error("configuration-invalid");
  const appCertFingerprints = JSON.parse(environment.S8_APP_CLIENT_CERT_SHA256S_JSON);
  if (!Array.isArray(appCertFingerprints) || appCertFingerprints.length === 0
    || appCertFingerprints.some((value) => typeof value !== "string" || !/^[a-fA-F0-9:]{64,95}$/u.test(value) || canonicalFingerprint(value) === null)
    || new Set(appCertFingerprints.map(canonicalFingerprint)).size !== appCertFingerprints.length) throw new Error("configuration-invalid");
  const launcherFingerprint = canonicalFingerprint(environment.S8_LAUNCHER_SERVER_CERT_SHA256);
  if (launcherFingerprint === null) throw new Error("configuration-invalid");
  const appKeys = readConfigJson(environment, "S8_APP_PUBLIC_KEYS_FILE");
  const launcherKeys = readConfigJson(environment, "S8_LAUNCHER_PUBLIC_KEYS_FILE");
  const capacityAuthorityKeys = readConfigJson(environment, "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_FILE");
  const releaseAuthorityKeys = readConfigJson(environment, "S8_RELEASE_PUBLIC_KEYS_FILE");
  const release = verifyReleaseManifest(readConfigJson(environment, "S8_RELEASE_MANIFEST_FILE"), releaseAuthorityKeys);
  if (release.manifest.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("configuration-invalid");
  return {
    bindAddress, port, launcherUrl,
    appCertFingerprints: new Set(appCertFingerprints.map(fingerprint)),
    appKeys, launcherKeys, capacityAuthorityKeys, releaseAuthorityKeys, release,
    tls: {
      key: readConfigFile(environment.S8_GATEWAY_TLS_KEY_FILE, 64 * 1024, true),
      cert: readConfigFile(environment.S8_GATEWAY_TLS_CERT_FILE, 64 * 1024),
      ca: readConfigFile(environment.S8_GATEWAY_CLIENT_CA_FILE, 256 * 1024),
      launcherCa: readConfigFile(environment.S8_LAUNCHER_TLS_CA_FILE, 256 * 1024),
      launcherCert: readConfigFile(environment.S8_LAUNCHER_TLS_CERT_FILE, 64 * 1024),
      launcherKey: readConfigFile(environment.S8_LAUNCHER_TLS_KEY_FILE, 64 * 1024, true),
      launcherFingerprint,
    },
  };
}

function collect(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        request.destroy();
        reject(new Error("body-limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks, length)));
    request.on("aborted", () => reject(new Error("request-aborted")));
    request.on("error", reject);
  });
}

export function launcherRequest(
  config,
  method,
  pathname,
  body,
  maximumBytes,
  timeoutMs,
  contentType = "application/octet-stream",
  { deadlineUnixMs = null, requestImpl = https.request, now = Date.now, inboundRequest = null, downstreamResponse = null } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let wallTimer = null;
    let abortHandler = null;
    let disconnectHandler = null;
    const remaining = deadlineUnixMs === null ? timeoutMs : deadlineUnixMs - now();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isFinite(remaining) || remaining <= 0) {
      reject(new Error("launcher-deadline-expired"));
      return;
    }
    const boundedTimeout = Math.min(timeoutMs, Math.max(1, Math.ceil(remaining)));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (inboundRequest && abortHandler) inboundRequest.removeListener("aborted", abortHandler);
      if (downstreamResponse && disconnectHandler) downstreamResponse.removeListener("close", disconnectHandler);
      if (error) reject(error);
      else resolve(result);
    };
    const request = requestImpl(new URL(pathname, config.launcherUrl), {
      method,
      agent: config.launcherAgent,
      headers: body ? { "content-type": contentType, "content-length": String(body.length) } : undefined,
    }, (response) => {
      void collect(response, maximumBytes).then((bytes) => {
        try {
          if (deadlineUnixMs !== null && deadlineUnixMs <= now()) throw new Error("launcher-deadline-expired");
          finish(null, { status: response.statusCode ?? 0, bytes });
        } catch (error) {
          finish(error);
        }
      }, (error) => finish(error));
    });
    request.setTimeout(boundedTimeout, () => request.destroy(new Error("launcher-timeout")));
    wallTimer = setTimeout(() => request.destroy(new Error("launcher-timeout")), boundedTimeout);
    request.on("error", (error) => finish(error));
    if (inboundRequest) {
      abortHandler = () => request.destroy(new Error("launcher-request-aborted"));
      if (inboundRequest.aborted) abortHandler();
      else inboundRequest.once("aborted", abortHandler);
    }
    if (downstreamResponse) {
      disconnectHandler = () => {
        if (!downstreamResponse.writableEnded) request.destroy(new Error("launcher-client-disconnected"));
      };
      if (downstreamResponse.destroyed) disconnectHandler();
      else downstreamResponse.once("close", disconnectHandler);
    }
    if (deadlineUnixMs !== null && deadlineUnixMs <= now()) {
      const error = new Error("launcher-deadline-expired");
      finish(error);
      request.destroy(error);
      return;
    }
    if (inboundRequest?.aborted || downstreamResponse?.destroyed || downstreamResponse?.writableEnded) {
      const error = new Error("launcher-client-disconnected");
      finish(error);
      request.destroy(error);
      return;
    }
    if (body) request.end(body); else request.end();
  });
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

function peerAllowed(request, config) {
  if (!request.socket.authorized) return false;
  try {
    const peer = request.socket.getPeerCertificate(true);
    return Boolean(peer?.raw && config.appCertFingerprints.has(fingerprint(new X509Certificate(peer.raw).fingerprint256)));
  } catch { return false; }
}

function responseExpectation(verified, config) {
  const body = verified.body;
  return {
    requestSha256: verified.requestSha256,
    projectId: body.projectId, jobId: body.jobId, artifactId: body.artifactId,
    attempt: body.attempt, operation: body.operation, sourceSha256: body.sourceSha256,
    releaseManifestSha256: config.release.sha256,
    imageDigest: body.operation === "WRITER" ? config.release.manifest.writer.imageDigest : config.release.manifest.validator.imageDigest,
    inputSha256: body.inputSha256, inputBytes: body.inputBytes,
    releaseHandle: body.releaseHandle ?? undefined,
    expectedValidatorIdentity: body.operation === "VALIDATOR" ? `s8-validator-sha256:${config.release.manifest.validator.executableSha256}` : undefined,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    launcherKeys: config.launcherKeys,
  };
}

export function createGatewayServer(config) {
  config.launcherAgent ??= new https.Agent({
    ca: config.tls.launcherCa, cert: config.tls.launcherCert, key: config.tls.launcherKey,
    rejectUnauthorized: true, keepAlive: true, maxSockets: 2,
    checkServerIdentity: (_hostname, certificate) => fingerprint(certificate.fingerprint256) === config.tls.launcherFingerprint ? undefined : new Error("launcher-certificate-mismatch"),
  });
  return https.createServer({ key: config.tls.key, cert: config.tls.cert, ca: config.tls.ca, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    if (!peerAllowed(request, config)) return sendJson(response, 403, generic);
    const url = new URL(request.url ?? "/", "https://gateway.invalid");
    if (request.method === "GET" && url.pathname === "/v1/admission" && url.search === "") {
      try {
        const result = await launcherRequest(config, "GET", "/v1/admission", null, MAX_ADMISSION_BYTES, 10_000, "application/octet-stream", { inboundRequest: request, downstreamResponse: response });
        if (result.status !== 200) return sendJson(response, 503, { state: "CLOSED", error: "S8_WORKER_ADMISSION_CLOSED" });
        const envelope = JSON.parse(result.bytes.toString("utf8"));
        const verified = verifyAdmissionEnvelope(envelope, { capacityAuthorityKeys: config.capacityAuthorityKeys, launcherKeys: config.launcherKeys });
        if (verified.capacity.proof.releaseManifestSha256 !== config.release.sha256) return sendJson(response, 503, { state: "CLOSED", error: "S8_WORKER_ADMISSION_CLOSED" });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(result.bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(result.bytes);
      } catch {
        if (!response.headersSent) sendJson(response, 503, { state: "CLOSED", error: "S8_WORKER_ADMISSION_CLOSED" });
        else response.destroy();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/status" && url.search === "" && request.headers["content-type"] === "application/json") {
      try {
        const body = await collect(request, MAX_HEADER_BYTES);
        const statusRequest = verifyStatusRequest(body, config.appKeys);
        const forwarded = await launcherRequest(config, "POST", "/v1/status", body, MAX_ADMISSION_BYTES, 10000, "application/json", { inboundRequest: request, downstreamResponse: response });
        if (forwarded.status !== 200) return sendJson(response, 503, generic);
        const statusResponse = JSON.parse(forwarded.bytes.toString("utf8"));
        verifyStatusResponse(statusResponse, {
          statusRequestSha256: statusRequest.statusRequestSha256,
          jobId: statusRequest.body.jobId,
          artifactId: statusRequest.body.artifactId,
          attempt: statusRequest.body.attempt,
          operation: statusRequest.body.operation,
          requestSha256: statusRequest.body.requestSha256,
          launcherKeys: config.launcherKeys,
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(forwarded.bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(forwarded.bytes);
      } catch {
        if (!response.headersSent) sendJson(response, 503, generic); else response.destroy();
      }
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/operations" || url.search !== ""
      || !S8_GATEWAY_OPERATION_CONTENT_TYPES.includes(request.headers["content-type"] ?? "")
      || request.headers["transfer-encoding"] !== undefined) return sendJson(response, 404, generic);
    const declaredLength = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 13 || declaredLength > 4 + MAX_HEADER_BYTES + 8 + MAX_WRITER_INPUT_BYTES) return sendJson(response, 413, generic);
    try {
      const maximumInput = 4 + MAX_HEADER_BYTES + 8 + MAX_WRITER_INPUT_BYTES;
      const frame = await collect(request, maximumInput);
      if (frame.length !== declaredLength) return sendJson(response, 400, generic);
      const verified = verifyRequestFrame(frame, config.appKeys, S8_NATIVE_RESOURCE_POLICY_SHA256);
      const maxInput = verified.body.operation === "WRITER" ? MAX_WRITER_INPUT_BYTES : MAX_VALIDATOR_INPUT_BYTES;
      if (verified.payload.length > maxInput || verified.body.profile !== PROFILE || verified.body.protocolVersion !== PROTOCOL_VERSION) return sendJson(response, 400, generic);
      const maxResponse = verified.body.operation === "WRITER" ? MAX_WRITER_OUTPUT_BYTES + MAX_WRITER_RECEIPT_BYTES + MAX_HEADER_BYTES + 20 : MAX_VALIDATOR_OUTPUT_BYTES + MAX_HEADER_BYTES + 20;
      const forwarded = await launcherRequest(config, "POST", "/v1/operations", frame, maxResponse, verified.body.operation === "WRITER" ? 510_000 : 330_000, "application/octet-stream", { deadlineUnixMs: verified.body.deadlineUnixMs, inboundRequest: request, downstreamResponse: response });
      if (forwarded.status !== 200) return sendJson(response, 503, generic);
      verifyResponseFrame(forwarded.bytes, responseExpectation(verified, config));
      if (Date.now() >= verified.body.deadlineUnixMs) throw new Error("launcher-deadline-expired");
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(forwarded.bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(forwarded.bytes);
    } catch {
      if (!response.headersSent) sendJson(response, 503, generic);
      else response.destroy();
    }
  });
}

export async function startGateway(config = loadConfig()) {
  const server = createGatewayServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await startGateway(); }
  catch {
    process.stderr.write("S8_GATEWAY_START_FAILED\n");
    process.exitCode = 1;
  }
}
