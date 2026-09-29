import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import { sha256, verifyResponseFrame } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";
import { createResponse } from "./result.mjs";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signingKey = keys.privateKey;
const request = {
  requestSha256: "a".repeat(64),
  body: {
    projectId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    attempt: 1,
    operation: "WRITER",
    sourceSha256: "b".repeat(64),
    inputSha256: "c".repeat(64),
    inputBytes: 16,
    releaseHandle: null,
  },
};
const release = {
  sha256: "d".repeat(64),
  manifest: {
    writer: { imageDigest: "sha256:" + "e".repeat(64) },
    validator: { imageDigest: "sha256:" + "f".repeat(64), executableSha256: "1".repeat(64) },
  },
};
const config = { signingKeyId: "launcher-2026", signingPrivateKey: signingKey };

test("successful Writer response issues the opaque handle needed to bind Validator input", () => {
  const output = Buffer.alloc(32, 7);
  const receipt = Buffer.from("{}");
  const handle = randomBytes(32).toString("base64url");
  const created = createResponse(config, request, release, "2".repeat(64), "EXIT_0", output, receipt, { verifiedByCaller: true }, handle);
  const verified = verifyResponseFrame(created.frame, {
    requestSha256: request.requestSha256,
    projectId: request.body.projectId,
    jobId: request.body.jobId,
    artifactId: request.body.artifactId,
    attempt: request.body.attempt,
    operation: "WRITER",
    sourceSha256: request.body.sourceSha256,
    releaseManifestSha256: release.sha256,
    imageDigest: release.manifest.writer.imageDigest,
    inputSha256: request.body.inputSha256,
    inputBytes: request.body.inputBytes,
    releaseHandle: null,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    launcherKeys: { "launcher-2026": publicKey },
  });
  assert.equal(verified.body.releaseHandle, handle);
  assert.equal(verified.body.outputSha256, sha256(output));
  assert.equal(created.responseSha256.length, 64);
});
