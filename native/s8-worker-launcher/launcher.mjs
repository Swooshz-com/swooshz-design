import { createServer } from "node:https";
import { X509Certificate, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { MAX_HEADER_BYTES, MAX_WRITER_INPUT_BYTES, verifyRequestFrame, verifyStatusRequest, jcs } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";
import { loadConfig } from "./config.mjs";
import { admissionSnapshot, reconcileStartup } from "./host-state.mjs";
import { runNativeOperation } from "./operation.mjs";

const generic = Object.freeze({ error: "S8_WORKER_UNAVAILABLE" });
let isStartupReady = false;
let queued = 0;
let queueTail = Promise.resolve();

function signedBody(config, body, domain) {
  const signature = sign(null, Buffer.concat([Buffer.from(`${domain}\0`, "ascii"), Buffer.from(jcs(body), "utf8")]), config.signingPrivateKey).toString("base64url");
  return { body, signature };
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(bytes);
}

function collect(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maximum) { request.destroy(); reject(new Error("body-limit")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks, total)));
    request.on("aborted", () => reject(new Error("request-aborted")));
    request.on("error", reject);
  });
}

function gatewayAuthenticated(request, config) {
  if (!request.socket.authorized) return false;
  try {
    const cert = request.socket.getPeerCertificate(true);
    return Boolean(cert?.raw && new X509Certificate(cert.raw).fingerprint256.replaceAll(":", "").toLowerCase() === config.gatewayFingerprint);
  } catch { return false; }
}

async function exclusive(action) {
  if (queued >= 2) throw new Error("worker-queue-full");
  queued += 1;
  const previous = queueTail;
  let release;
  queueTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await action(); }
  finally { queued -= 1; release(); }
}

function statusReply(config, request) {
  const key = { jobId: request.body.jobId, attempt: request.body.attempt, operation: request.body.operation };
  const record = config.ledger.get(key);
  let state = record?.state ?? "NOT_FOUND";
  let disposalState = record?.disposalState ?? "NOT_STARTED";
  let failureClass = record?.failureClass ?? null;
  let responseSha256 = record?.responseSha256 ?? null;
  let failureFrameBase64 = record?.signedFailureFrame ?? null;
  if (record && record.requestSha256 !== request.body.requestSha256) {
    state = "CONFLICT";
    disposalState = "UNKNOWN";
    failureClass = "UNCERTAIN";
    responseSha256 = null;
    failureFrameBase64 = null;
  }
  const body = {
    schemaVersion: "s8-native-status-response-v1",
    launcherKeyId: config.signingKeyId,
    statusRequestSha256: request.statusRequestSha256,
    jobId: request.body.jobId,
    artifactId: request.body.artifactId,
    attempt: request.body.attempt,
    operation: request.body.operation,
    requestSha256: request.body.requestSha256,
    state,
    disposalState,
    failureClass,
    responseSha256,
    failureFrameBase64,
    observedAt: new Date().toISOString(),
  };
  return signedBody(config, body, "S8-NATIVE-STATUS-RESPONSE-V1");
}

export function createLauncherServer(config) {
  return createServer({ key: config.tls.key, cert: config.tls.cert, ca: config.tls.ca, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    if (!gatewayAuthenticated(request, config)) return sendJson(response, 403, generic);
    const url = new URL(request.url ?? "/", "https://launcher.invalid");
    if (request.method === "GET" && url.pathname === "/v1/admission" && url.search === "") {
      try {
        const snapshot = await admissionSnapshot(config, () => isStartupReady);
        const launcher = signedBody(config, snapshot.observation, "S8-LAUNCHER-OBSERVATION-V2");
        return sendJson(response, 200, { capacity: snapshot.signedProof, launcher });
      } catch { return sendJson(response, 503, { state: "CLOSED", error: "S8_WORKER_ADMISSION_CLOSED" }); }
    }
    if (request.method === "POST" && url.pathname === "/v1/status" && url.search === "" && request.headers["content-type"] === "application/json") {
      try {
        const bytes = await collect(request, MAX_HEADER_BYTES);
        const status = verifyStatusRequest(bytes, config.appKeys);
        return sendJson(response, 200, statusReply(config, status));
      } catch { return sendJson(response, 503, generic); }
    }
    if (request.method !== "POST" || url.pathname !== "/v1/operations" || url.search !== "" || request.headers["content-type"] !== "application/octet-stream") return sendJson(response, 404, generic);
    try {
      const maximum = 4 + MAX_HEADER_BYTES + 8 + MAX_WRITER_INPUT_BYTES;
      const bytes = await collect(request, maximum);
      const verified = verifyRequestFrame(bytes, config.appKeys, S8_NATIVE_RESOURCE_POLICY_SHA256);
      const frame = await exclusive(() => runNativeOperation(config, verified, () => isStartupReady, () => { isStartupReady = false; }));
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(frame.length), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(frame);
    } catch { sendJson(response, 503, generic); }
  });
}

export async function startLauncher(config = loadConfig()) {
  try { await reconcileStartup(config); isStartupReady = true; }
  catch { isStartupReady = false; }
  const server = createLauncherServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await startLauncher(); }
  catch {
    process.stderr.write("S8_LAUNCHER_START_FAILED\n");
    process.exitCode = 1;
  }
}
