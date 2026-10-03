import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyAdmissionEnvelope, verifyReleaseManifest } from "./admission.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./resource-policy.mjs";
import { jcs, sha256 } from "./protocol.mjs";

const now = Date.parse("2026-09-29T00:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function release() {
  return {
    schemaVersion: "s8-release-manifest-v2",
    releaseId: "native-release-1",
    sequence: 1,
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    signingKeyId: "release-2026",
    protocolVersion: "s8-native-worker-v1",
    profile: "swooshz-fbx-static-mesh-v1",
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    processRunnerSha256: "4".repeat(64),
    writer: {
      imageDigest: "sha256:" + "a".repeat(64),
      blenderVersion: "5.2.2",
      blenderArchiveSha256: "b".repeat(64),
      exporterPatchSha256: "c".repeat(64),
      writerScriptSha256: "d".repeat(64),
    },
    validator: {
      imageDigest: "sha256:" + "e".repeat(64),
      identity: "s8-validator-sha256:" + "f".repeat(64),
      ufbxVersion: "0.17.1",
      ufbxCommit: "a".repeat(40),
      ufbxTree: "b".repeat(40),
      executableSha256: "c".repeat(64),
    },
    sandbox: {
      seccompPolicySha256: "d".repeat(64),
      jobAppArmorMode: "unsupported-not-relied-upon",
      rootlessKitHostAppArmor: {
        mode: "required-profile",
        profileName: "swooshz-s8-rootlesskit-v1",
        profileSha256: "e".repeat(64),
      },
    },
    provenanceSha256: "f".repeat(64),
    sbomSha256: "0".repeat(64),
  };
}

function signed(body) {
  const signature = sign(null, Buffer.concat([
    Buffer.from("S8-RELEASE-MANIFEST-V2\0", "ascii"),
    Buffer.from(jcs(body), "utf8"),
  ]), privateKeyPem).toString("base64url");
  return { manifest: body, signature };
}

test("host accepts only a signed v2 release with separate job and RootlessKit AppArmor modes", () => {
  const verified = verifyReleaseManifest(signed(release()), { "release-2026": publicKeyPem }, now);
  assert.equal(verified.manifest.sandbox.jobAppArmorMode, "unsupported-not-relied-upon");
  assert.deepEqual(verified.manifest.sandbox.rootlessKitHostAppArmor, {
    mode: "required-profile",
    profileName: "swooshz-s8-rootlesskit-v1",
    profileSha256: "e".repeat(64),
  });
});

test("host rejects old release schema and impossible or drifted AppArmor identities", () => {
  const old = release();
  old.schemaVersion = "s8-release-manifest-v1";
  assert.throws(() => verifyReleaseManifest(signed(old), { "release-2026": publicKeyPem }, now));

  const impossibleJobMode = release();
  impossibleJobMode.sandbox.jobAppArmorMode = "required-profile";
  assert.throws(() => verifyReleaseManifest(signed(impossibleJobMode), { "release-2026": publicKeyPem }, now));

  const wrongHostMode = release();
  wrongHostMode.sandbox.rootlessKitHostAppArmor.mode = "unsupported";
  assert.throws(() => verifyReleaseManifest(signed(wrongHostMode), { "release-2026": publicKeyPem }, now));

  const wrongHostProfile = release();
  wrongHostProfile.sandbox.rootlessKitHostAppArmor.profileName = "other-profile";
  assert.throws(() => verifyReleaseManifest(signed(wrongHostProfile), { "release-2026": publicKeyPem }, now));

  const malformedProvenance = release();
  malformedProvenance.provenanceSha256 = "not-a-digest";
  assert.throws(() => verifyReleaseManifest(signed(malformedProvenance), { "release-2026": publicKeyPem }, now));

  const malformedSbom = release();
  malformedSbom.sbomSha256 = "not-a-digest";
  assert.throws(() => verifyReleaseManifest(signed(malformedSbom), { "release-2026": publicKeyPem }, now));

  const tamperedSignedProvenance = signed(release());
  tamperedSignedProvenance.manifest.provenanceSha256 = "9".repeat(64);
  assert.throws(() => verifyReleaseManifest(tamperedSignedProvenance, { "release-2026": publicKeyPem }, now));
});



const admissionNow = Date.parse("2026-09-29T00:00:00.000Z");
const capacityAuthority = generateKeyPairSync("ed25519");
const launcherAuthority = generateKeyPairSync("ed25519");
const capacityPublic = capacityAuthority.publicKey.export({ format: "pem", type: "spki" }).toString();
const launcherPublic = launcherAuthority.publicKey.export({ format: "pem", type: "spki" }).toString();

function signedBody(body, privateKey, domain) {
  return sign(null, Buffer.concat([
    Buffer.from(domain + "\0", "ascii"),
    Buffer.from(jcs(body), "utf8"),
  ]), privateKey).toString("base64url");
}

function budget(cpuMilli, memoryBytes, pids) {
  return { cpuMilli, memoryBytes, pids };
}

function admissionEnvelope(observationVersion = "s8-launcher-observation-v2", observationDomain = "S8-LAUNCHER-OBSERVATION-V2") {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const workloads = [
    ["future-non-design", 80, 512 * mib, 64],
    ["n8n", 120, gib, 100],
    ["other-siblings", 80, 512 * mib, 64],
    ["quote", 120, gib, 100],
    ["wordpress", 100, gib, 72],
  ].map(([workloadId, cpuMilli, memoryBytes, pids]) => ({
    workloadId,
    cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-" + workloadId + ".slice",
    budget: budget(cpuMilli, memoryBytes, pids),
  }));
  const proof = {
    schemaVersion: "s8-capacity-proof-v1",
    proofId: "proof-2026-09-29",
    state: "OPEN",
    issuedAt: new Date(admissionNow - 1000).toISOString(),
    expiresAt: new Date(admissionNow + 60_000).toISOString(),
    signingKeyId: "owner-capacity-2026",
    host: {
      hostId: "swooshz-vps-test",
      cpuMilli: 4000,
      memoryBytes: 24 * gib,
      pids: 2048,
      measuredAt: new Date(admissionNow - 1000).toISOString(),
    },
    allocation: {
      designAggregate: budget(3000, 10 * gib, 600),
      designApplication: budget(300, gib, 100),
      gateway: budget(100, 256 * mib, 64),
      launcher: budget(100, 256 * mib, 64),
      rootlessDocker: budget(2100, 4 * gib + 256 * mib, 96),
      rootlessDockerUid: 12001,
      systemd: budget(100, 256 * mib, 64),
      streaming: budget(100, 2 * gib, 64),
      writer: budget(2000, 4 * gib, 80),
      validator: budget(1000, 1536 * mib, 32),
      nonDesignAggregate: budget(500, 4 * gib, 400),
      nonDesignWorkloads: workloads,
      protectedHostReserve: budget(500, 4 * gib, 512),
    },
    oneOperationAtATime: true,
    workloadInventorySha256: "f".repeat(64),
    cgroupTreeSha256: "d".repeat(64),
    releaseManifestSha256: "e".repeat(64),
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    contentionEvidenceIds: ["contention-proof-1"],
    resourceLimitEvidenceIds: ["limit-proof-1"],
  };
  const capacity = {
    proof,
    signature: signedBody(proof, capacityAuthority.privateKey, "S8-CAPACITY-PROOF-V1"),
  };
  const proofSha256 = sha256(Buffer.from(jcs(capacity), "utf8"));
  const observation = {
    schemaVersion: observationVersion,
    proofSha256,
    state: "OPEN",
    observedAt: new Date(admissionNow - 500).toISOString(),
    launcherKeyId: "launcher-2026",
    hostId: "swooshz-vps-test",
    cpuMilli: 4000,
    memoryBytes: 24 * gib,
    pids: 2048,
    workloadInventorySha256: "f".repeat(64),
    cgroupTreeSha256: "d".repeat(64),
    releaseManifestSha256: "e".repeat(64),
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    jobAppArmorMode: "unsupported-not-relied-upon",
    rootlessKitHostAppArmorMode: "required-profile",
    rootlessKitHostAppArmorProfileName: "swooshz-s8-rootlesskit-v1",
    rootlessKitHostAppArmorProfileSha256: "1".repeat(64),
    cgroupV2: true,
    rootlessDocker: true,
    requiredControllers: ["cpu", "memory", "pids"],
    startupReconciled: true,
    unreconciledContainerCount: 0,
  };
  return {
    capacity,
    launcher: {
      observation,
      signature: signedBody(observation, launcherAuthority.privateKey, observationDomain),
    },
  };
}

const admissionTrust = {
  capacityAuthorityKeys: { "owner-capacity-2026": capacityPublic },
  launcherKeys: { "launcher-2026": launcherPublic },
};

test("gateway admission verifier accepts v2 AppArmor separation only with signed live host evidence", () => {
  const verified = verifyAdmissionEnvelope(admissionEnvelope(), admissionTrust, admissionNow);
  assert.equal(verified.observation.jobAppArmorMode, "unsupported-not-relied-upon");
  assert.equal(verified.observation.rootlessKitHostAppArmorMode, "required-profile");
});

test("gateway admission verifier rejects old observation schemas, signatures, and impossible job AppArmor", () => {
  assert.throws(
    () => verifyAdmissionEnvelope(admissionEnvelope("s8-launcher-observation-v1"), admissionTrust, admissionNow),
    /observation-binding/u,
  );
  assert.throws(
    () => verifyAdmissionEnvelope(admissionEnvelope("s8-launcher-observation-v2", "S8-LAUNCHER-OBSERVATION-V1"), admissionTrust, admissionNow),
    /observation-signature/u,
  );
  const impossible = admissionEnvelope();
  impossible.launcher.observation.jobAppArmorMode = "required-profile";
  impossible.launcher.signature = signedBody(impossible.launcher.observation, launcherAuthority.privateKey, "S8-LAUNCHER-OBSERVATION-V2");
  assert.throws(() => verifyAdmissionEnvelope(impossible, admissionTrust, admissionNow), /observation-runtime/u);
});
