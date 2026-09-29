import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  EMPTY_SHA256,
  REQUEST_DOMAIN,
  RESPONSE_DOMAIN,
  encodeRequestFrame,
  encodeResponseFrame,
  jcs,
  sha256,
  signBody,
  verifyRequestFrame,
  verifyResponseFrame,
} from "./protocol.mjs";

const app = generateKeyPairSync("ed25519");
const launcher = generateKeyPairSync("ed25519");
const appPublic = app.publicKey.export({ type: "spki", format: "pem" }).toString();
const appPrivate = app.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const launcherPublic = launcher.publicKey.export({ type: "spki", format: "pem" }).toString();
const launcherPrivate = launcher.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const policySha = "a".repeat(64);
const releaseSha = "b".repeat(64);
const imageDigest = `sha256:${"c".repeat(64)}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";

function makeRequest(operation = "WRITER") {
  const payload = Buffer.from("bounded-native-input");
  const now = Date.now();
  const body = {
    schemaVersion: "s8-native-request-v1",
    keyId: "app-2026",
    projectId,
    jobId,
    artifactId,
    attempt: 1,
    operation,
    sourceSha256: "d".repeat(64),
    profile: "swooshz-fbx-static-mesh-v1",
    protocolVersion: "s8-native-worker-v1",
    configSha256: sha256(jcs({ profile: "swooshz-fbx-static-mesh-v1", protocolVersion: "s8-native-worker-v1", resourcePolicySha256: policySha })),
    inputSha256: sha256(payload),
    inputBytes: payload.length,
    deadlineUnixMs: now + 100_000,
    nonce: "e".repeat(43),
    releaseHandle: operation === "WRITER" ? null : "f".repeat(43),
  };
  return { body, signature: signBody(body, appPrivate, REQUEST_DOMAIN), payload };
}

function makeResponse(request, requestSha256, exitClass = "EXIT_0") {
  const output = exitClass === "EXIT_0" && request.body.operation === "WRITER" ? Buffer.alloc(32, 7) : Buffer.alloc(0);
  const auxiliary = exitClass === "EXIT_0" && request.body.operation === "WRITER" ? Buffer.from("{}") : Buffer.alloc(0);
  const body = {
    schemaVersion: "s8-native-response-v1",
    launcherKeyId: "launcher-2026",
    requestSha256,
    projectId: request.body.projectId,
    jobId: request.body.jobId,
    artifactId: request.body.artifactId,
    attempt: request.body.attempt,
    operation: request.body.operation,
    sourceSha256: request.body.sourceSha256,
    releaseManifestSha256: releaseSha,
    imageDigest,
    containerId: "1".repeat(64),
    inputSha256: request.body.inputSha256,
    inputBytes: request.body.inputBytes,
    outputSha256: sha256(output),
    outputBytes: output.length,
    auxiliarySha256: sha256(auxiliary),
    auxiliaryBytes: auxiliary.length,
    exitClass,
    limitProfileSha256: policySha,
    disposalState: "REAPED_REMOVED",
    releaseHandle: exitClass === "EXIT_0" && request.body.operation === "WRITER" ? "2".repeat(43) : request.body.releaseHandle,
    validatorIdentity: null,
    runnerEvidence: exitClass === "EXIT_0" ? { verifiedByCaller: { status: "VERIFIED_BY_CALLER" } } : null,
  };
  const signedResponse = { body, signature: signBody(body, launcherPrivate, RESPONSE_DOMAIN) };
  return { frame: encodeResponseFrame(signedResponse, output, auxiliary), signedResponse };
}

test("request verifier binds the signed header, payload size, payload hash and exact frame", () => {
  const signed = makeRequest();
  const frame = encodeRequestFrame({ body: signed.body, signature: signed.signature }, signed.payload);
  const verified = verifyRequestFrame(frame, { "app-2026": appPublic }, policySha);
  assert.equal(verified.body.jobId, jobId);
  assert.equal(verified.requestSha256, sha256(jcs({ body: signed.body, signature: signed.signature })));
  assert.throws(() => verifyRequestFrame(Buffer.concat([frame, Buffer.from("x")]), { "app-2026": appPublic }, policySha));
  const wrongPayload = Buffer.from(frame);
  wrongPayload[wrongPayload.length - 1] ^= 1;
  assert.throws(() => verifyRequestFrame(wrongPayload, { "app-2026": appPublic }, policySha));
});

test("response verifier accepts success only for the bound image and verifies signed transient disposal", () => {
  const signedRequest = makeRequest();
  const requestFrame = encodeRequestFrame({ body: signedRequest.body, signature: signedRequest.signature }, signedRequest.payload);
  const verifiedRequest = verifyRequestFrame(requestFrame, { "app-2026": appPublic }, policySha);
  const expected = {
    requestSha256: verifiedRequest.requestSha256,
    projectId,
    jobId,
    artifactId,
    attempt: 1,
    operation: "WRITER",
    sourceSha256: signedRequest.body.sourceSha256,
    releaseManifestSha256: releaseSha,
    imageDigest,
    inputSha256: signedRequest.body.inputSha256,
    inputBytes: signedRequest.body.inputBytes,
    releaseHandle: null,
    validatorIdentity: null,
    resourcePolicySha256: policySha,
    launcherKeys: { "launcher-2026": launcherPublic },
  };
  const success = makeResponse(signedRequest, verifiedRequest.requestSha256);
  assert.equal(verifyResponseFrame(success.frame, expected).body.exitClass, "EXIT_0");
  const transient = makeResponse(signedRequest, verifiedRequest.requestSha256, "TRANSIENT_INFRASTRUCTURE_FAILURE");
  assert.equal(verifyResponseFrame(transient.frame, expected).body.outputSha256, EMPTY_SHA256);
  const changed = structuredClone(success.signedResponse);
  changed.body.disposalState = "UNKNOWN";
  changed.signature = signBody(changed.body, launcherPrivate, RESPONSE_DOMAIN);
  assert.throws(() => verifyResponseFrame(encodeResponseFrame(changed, Buffer.alloc(32, 7), Buffer.from("{}")), expected));
});
