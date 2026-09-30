import { createHash, createPrivateKey, verify as verifySignature, sign as signSignature } from "node:crypto";

export const PROTOCOL_VERSION = "s8-native-worker-v1";
export const PROFILE = "swooshz-fbx-static-mesh-v1";
export const REQUEST_DOMAIN = "S8-NATIVE-REQUEST-V1\0";
export const RESPONSE_DOMAIN = "S8-NATIVE-RESPONSE-V1\0";
export const STATUS_DOMAIN = "S8-NATIVE-STATUS-V1\0";
export const STATUS_REQUEST_DOMAIN = "S8-NATIVE-STATUS-REQUEST-V1\0";
export const STATUS_RESPONSE_DOMAIN = "S8-NATIVE-STATUS-RESPONSE-V1\0";
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_WRITER_INPUT_BYTES = 256 * 1024 * 1024;
export const MAX_VALIDATOR_INPUT_BYTES = 128 * 1024 * 1024;
export const MAX_WRITER_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MAX_WRITER_RECEIPT_BYTES = 1024 * 1024;
export const MAX_VALIDATOR_OUTPUT_BYTES = 8 * 1024 * 1024;
export const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const RELEASE_HANDLE = /^[A-Za-z0-9_-]{43}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function jcs(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical-json-invalid");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
  }
  throw new Error("canonical-json-invalid");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("protocol-invalid");
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("protocol-invalid");
}

function verifyBody(body, signature, pem, domain) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && verifySignature(null, Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from(jcs(body), "utf8")]), pem, bytes);
}

export function signBody(body, privateKeyPem, domain) {
  return signSignature(null, Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from(jcs(body), "utf8")]), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function parseFrame(bytes, maximumPayloadBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 + 8) throw new Error("frame-invalid");
  const headerLength = bytes.readUInt32BE(0);
  const headerBytes = bytes.subarray(4, 4 + headerLength);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES || bytes.length < 4 + headerLength + 8) throw new Error("frame-invalid");
  const inputLengthOffset = 4 + headerLength;
  const inputLength = bytes.readBigUInt64BE(inputLengthOffset);
  if (inputLength > BigInt(maximumPayloadBytes) || inputLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame-invalid");
  const payloadStart = inputLengthOffset + 8;
  if (bytes.length !== payloadStart + Number(inputLength)) throw new Error("frame-invalid");
  const headerText = headerBytes.toString("utf8");
  let parsed;
  try { parsed = JSON.parse(headerText); } catch { throw new Error("frame-invalid"); }
  if (jcs(parsed) !== headerText) throw new Error("frame-invalid");
  return { header: parsed, headerBytes, payload: bytes.subarray(payloadStart) };
}

export function encodeRequestFrame(signedRequest, payload) {
  const header = Buffer.from(jcs(signedRequest), "utf8");
  if (header.length < 1 || header.length > MAX_HEADER_BYTES) throw new Error("frame-invalid");
  const prefix = Buffer.alloc(4 + header.length + 8);
  prefix.writeUInt32BE(header.length, 0);
  header.copy(prefix, 4);
  prefix.writeBigUInt64BE(BigInt(payload.length), 4 + header.length);
  return Buffer.concat([prefix, payload]);
}

export function verifyRequestFrame(bytes, appKeys, resourcePolicySha256, nowMs = Date.now()) {
  const parsedFrame = parseFrame(bytes, MAX_WRITER_INPUT_BYTES);
  const signed = record(parsedFrame.header);
  exactKeys(signed, ["body", "signature"]);
  const body = record(signed.body);
  exactKeys(body, ["schemaVersion", "keyId", "projectId", "jobId", "artifactId", "attempt", "operation", "sourceSha256", "profile", "protocolVersion", "configSha256", "inputSha256", "inputBytes", "deadlineUnixMs", "nonce", "releaseHandle"]);
  const maximum = body.operation === "WRITER" ? MAX_WRITER_INPUT_BYTES : MAX_VALIDATOR_INPUT_BYTES;
  const expectedConfigHash = sha256(jcs({ profile: PROFILE, protocolVersion: PROTOCOL_VERSION, resourcePolicySha256 }));
  if (body.schemaVersion !== "s8-native-request-v1" || typeof body.keyId !== "string" || !KEY_ID.test(body.keyId)
    || !UUID.test(body.projectId) || !UUID.test(body.jobId) || !UUID.test(body.artifactId)
    || !Number.isSafeInteger(body.attempt) || body.attempt < 1 || body.attempt > 2
    || (body.operation !== "WRITER" && body.operation !== "VALIDATOR")
    || !HEX64.test(body.sourceSha256) || body.profile !== PROFILE || body.protocolVersion !== PROTOCOL_VERSION
    || body.configSha256 !== expectedConfigHash || !HEX64.test(body.inputSha256)
    || !Number.isSafeInteger(body.inputBytes) || body.inputBytes < 1 || body.inputBytes > maximum
    || body.inputBytes !== parsedFrame.payload.length || body.inputSha256 !== sha256(parsedFrame.payload)
    || !Number.isSafeInteger(body.deadlineUnixMs) || body.deadlineUnixMs <= nowMs || body.deadlineUnixMs > nowMs + (body.operation === "WRITER" ? 510_000 : 330_000)
    || typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.nonce)
    || (body.operation === "WRITER" && body.releaseHandle !== null)
    || (body.operation === "VALIDATOR" && (typeof body.releaseHandle !== "string" || !RELEASE_HANDLE.test(body.releaseHandle)))) throw new Error("request-invalid");
  const publicKeyPem = appKeys[body.keyId];
  if (!publicKeyPem || !verifyBody(body, signed.signature, publicKeyPem, REQUEST_DOMAIN)) throw new Error("request-signature-invalid");
  return { request: signed, body, payload: parsedFrame.payload, requestSha256: sha256(jcs(signed)) };
}


export function verifyStatusRequest(bytes, appKeys, nowMs = Date.now()) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_HEADER_BYTES) throw new Error("status-invalid");
  let signed;
  try { signed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("status-invalid"); }
  if (jcs(signed) !== bytes.toString("utf8")) throw new Error("status-invalid");
  record(signed); exactKeys(signed, ["body", "signature"]);
  const body = record(signed.body);
  exactKeys(body, ["schemaVersion", "keyId", "projectId", "jobId", "artifactId", "attempt", "operation", "requestSha256", "nonce"]);
  if (body.schemaVersion !== "s8-native-status-request-v1" || !KEY_ID.test(body.keyId)
    || !UUID.test(body.projectId) || !UUID.test(body.jobId) || !UUID.test(body.artifactId)
    || !Number.isSafeInteger(body.attempt) || body.attempt < 1 || body.attempt > 2
    || (body.operation !== "WRITER" && body.operation !== "VALIDATOR") || !HEX64.test(body.requestSha256)
    || typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.nonce)) throw new Error("status-invalid");
  const key = appKeys[body.keyId];
  if (!key || !verifyBody(body, signed.signature, key, STATUS_REQUEST_DOMAIN)) throw new Error("status-signature-invalid");
  return { signed, body, statusRequestSha256: sha256(jcs(signed)) };
}

export function verifyStatusResponse(value, expected) {
  const signed = record(value);
  exactKeys(signed, ["body", "signature"]);
  const body = record(signed.body);
  exactKeys(body, ["schemaVersion", "launcherKeyId", "statusRequestSha256", "jobId", "artifactId", "attempt", "operation", "requestSha256", "state", "disposalState", "failureClass", "responseSha256", "failureFrameBase64", "observedAt"]);
  const keyId = body.launcherKeyId;
  const failureFrame = body.failureFrameBase64;
  if (body.schemaVersion !== "s8-native-status-response-v1" || !KEY_ID.test(keyId)
    || body.statusRequestSha256 !== expected.statusRequestSha256 || body.jobId !== expected.jobId || body.artifactId !== expected.artifactId
    || body.attempt !== expected.attempt || body.operation !== expected.operation || body.requestSha256 !== expected.requestSha256
    || !["NOT_FOUND", "STARTED", "SUCCEEDED", "FAILED", "UNKNOWN", "CONFLICT"].includes(body.state)
    || !["NOT_STARTED", "RUNNING", "REAPED_REMOVED", "UNKNOWN"].includes(body.disposalState)
    || (body.failureClass !== null && !["TRANSIENT", "PERMANENT", "UNCERTAIN"].includes(body.failureClass))
    || (body.responseSha256 !== null && !HEX64.test(body.responseSha256))
    || (failureFrame !== null && (typeof failureFrame !== "string" || !/^[A-Za-z0-9_-]+$/u.test(failureFrame) || failureFrame.length > 120000))
    || typeof body.observedAt !== "string" || !Number.isFinite(Date.parse(body.observedAt))) throw new Error("status-invalid");
  const pem = expected.launcherKeys[keyId];
  if (!pem || !verifyBody(body, signed.signature, pem, STATUS_RESPONSE_DOMAIN)) throw new Error("status-signature-invalid");
  if (body.state === "FAILED" && body.failureClass === "TRANSIENT" && !failureFrame) throw new Error("status-invalid");
  if (body.state !== "FAILED" && failureFrame !== null) throw new Error("status-invalid");
  return { signed, body };
}

export function encodeResponseFrame(signedResponse, output, auxiliary) {
  const header = Buffer.from(jcs(signedResponse), "utf8");
  if (header.length < 1 || header.length > MAX_HEADER_BYTES) throw new Error("frame-invalid");
  const prefix = Buffer.alloc(4 + header.length + 8 + 8);
  prefix.writeUInt32BE(header.length, 0);
  header.copy(prefix, 4);
  prefix.writeBigUInt64BE(BigInt(output.length), 4 + header.length);
  const auxiliaryLengthOffset = 4 + header.length + 8 + output.length;
  const suffix = Buffer.alloc(8);
  suffix.writeBigUInt64BE(BigInt(auxiliary.length), 0);
  return Buffer.concat([prefix.subarray(0, 4 + header.length + 8), output, suffix, auxiliary]);
}

export function verifyResponseFrame(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 + 8 + 8) throw new Error("response-invalid");
  const headerLength = bytes.readUInt32BE(0);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES || bytes.length < 4 + headerLength + 16) throw new Error("response-invalid");
  const headerEnd = 4 + headerLength;
  const outputLength = bytes.readBigUInt64BE(headerEnd);
  if (outputLength > BigInt(MAX_WRITER_OUTPUT_BYTES + MAX_WRITER_RECEIPT_BYTES + MAX_VALIDATOR_OUTPUT_BYTES)) throw new Error("response-invalid");
  const outputStart = headerEnd + 8;
  const auxiliaryLengthOffset = outputStart + Number(outputLength);
  if (auxiliaryLengthOffset + 8 > bytes.length) throw new Error("response-invalid");
  const auxiliaryLength = bytes.readBigUInt64BE(auxiliaryLengthOffset);
  if (auxiliaryLength > BigInt(MAX_WRITER_RECEIPT_BYTES) || auxiliaryLengthOffset + 8 + Number(auxiliaryLength) !== bytes.length) throw new Error("response-invalid");
  const output = bytes.subarray(outputStart, auxiliaryLengthOffset);
  const auxiliary = bytes.subarray(auxiliaryLengthOffset + 8);
  const headerBytes = bytes.subarray(4, headerEnd);
  let signed;
  try { signed = JSON.parse(headerBytes.toString("utf8")); } catch { throw new Error("response-invalid"); }
  if (jcs(signed) !== headerBytes.toString("utf8")) throw new Error("response-invalid");
  record(signed); exactKeys(signed, ["body", "signature"]);
  const body = record(signed.body);
  exactKeys(body, ["schemaVersion", "launcherKeyId", "requestSha256", "projectId", "jobId", "artifactId", "attempt", "operation", "sourceSha256", "releaseManifestSha256", "imageDigest", "containerId", "inputSha256", "inputBytes", "outputSha256", "outputBytes", "auxiliarySha256", "auxiliaryBytes", "exitClass", "limitProfileSha256", "disposalState", "releaseHandle", "validatorIdentity", "runnerEvidence"]);
  const maxOutput = expected.operation === "WRITER" ? MAX_WRITER_OUTPUT_BYTES : MAX_VALIDATOR_OUTPUT_BYTES;
  const maxAuxiliary = expected.operation === "WRITER" ? MAX_WRITER_RECEIPT_BYTES : 0;
  if (body.schemaVersion !== "s8-native-response-v1" || !KEY_ID.test(body.launcherKeyId)
    || body.requestSha256 !== expected.requestSha256 || body.projectId !== expected.projectId || body.jobId !== expected.jobId || body.artifactId !== expected.artifactId
    || body.attempt !== expected.attempt || body.operation !== expected.operation || body.sourceSha256 !== expected.sourceSha256
    || body.releaseManifestSha256 !== expected.releaseManifestSha256 || body.imageDigest !== expected.imageDigest || !IMAGE_DIGEST.test(body.imageDigest)
    || !HEX64.test(body.containerId) || body.inputSha256 !== expected.inputSha256 || body.inputBytes !== expected.inputBytes
    || body.outputBytes !== output.length || !HEX64.test(body.outputSha256) || body.outputSha256 !== sha256(output)
    || body.auxiliaryBytes !== auxiliary.length || !HEX64.test(body.auxiliarySha256) || body.auxiliarySha256 !== sha256(auxiliary)
    || !["EXIT_0", "TRANSIENT_INFRASTRUCTURE_FAILURE", "PERMANENT_FAILURE"].includes(body.exitClass)
    || body.limitProfileSha256 !== expected.resourcePolicySha256 || body.disposalState !== "REAPED_REMOVED") throw new Error("response-invalid");
  const launcherPem = expected.launcherKeys[body.launcherKeyId];
  if (!launcherPem || !verifyBody(body, signed.signature, launcherPem, RESPONSE_DOMAIN)) throw new Error("response-signature-invalid");

  if (body.exitClass !== "EXIT_0") {
    if (output.length !== 0 || auxiliary.length !== 0 || body.outputSha256 !== EMPTY_SHA256 || body.auxiliarySha256 !== EMPTY_SHA256 || body.runnerEvidence !== null || body.validatorIdentity !== null) throw new Error("response-invalid");
    if (expected.operation === "WRITER" ? body.releaseHandle !== null : body.releaseHandle !== expected.releaseHandle) throw new Error("response-invalid");
  } else if (expected.operation === "WRITER") {
    if (output.length <= 27 || output.length > maxOutput || auxiliary.length < 1 || auxiliary.length > maxAuxiliary
      || typeof body.releaseHandle !== "string" || !RELEASE_HANDLE.test(body.releaseHandle) || body.validatorIdentity !== null || !body.runnerEvidence) throw new Error("response-invalid");
  } else if (output.length < 1 || output.length > maxOutput || auxiliary.length !== 0 || body.releaseHandle !== expected.releaseHandle
    || body.validatorIdentity !== expected.validatorIdentity || !body.runnerEvidence) throw new Error("response-invalid");
  return { signedResponse: signed, body, output, auxiliary };
}
