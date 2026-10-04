import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import {
  decideS8NativeAdmission, requireS8NativeAdmissionOpen, S8_NATIVE_RESOURCE_POLICY,
  S8_NATIVE_RESOURCE_POLICY_SHA256, type S8AdmissionEnvelope, type S8CapacityProofBody,
} from "../src/lib/s8-native-admission";
import {
  S8_BLENDER_PIN, S8_FBX_PROFILE, S8_UFBX_PIN, S8_VALIDATOR_PIN,
} from "../src/lib/s8-fbx-profile";
import {
  S8_NATIVE_WORKER_PROTOCOL_VERSION, verifyS8ReleaseManifest,
  type S8ReleaseManifestBody, type S8SignedReleaseManifest,
} from "../src/lib/s8-native-release";
import { assertS8ReleaseAdmissionBinding, S8NativeWorkerClient } from "../src/lib/s8-native-worker-client";
import { jcs, sha256 } from "../src/lib/utils";

const releasePair = generateKeyPairSync("ed25519");
const capacityPair = generateKeyPairSync("ed25519");
const launcherPair = generateKeyPairSync("ed25519");
const releasePrivatePem = releasePair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const releasePublicPem = releasePair.publicKey.export({ type: "spki", format: "pem" }).toString();
const capacityPublicPem = capacityPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const launcherPublicPem = launcherPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const testDigest = "a".repeat(64);
const otherDigest = "c".repeat(64);
const imageDigest = "sha256:" + "b".repeat(64);

function signBody(domain: string, body: unknown, privateKey: KeyObject): string {
  const prefix = Buffer.concat([Buffer.from(domain, "ascii"), Buffer.from([0])]);
  return sign(null, Buffer.concat([prefix, Buffer.from(jcs(body), "utf8")]), privateKey).toString("base64url");
}

function releaseBody(nowMs = Date.now()): S8ReleaseManifestBody {
  return {
    schemaVersion: "s8-release-manifest-v2", releaseId: "run138-release-test", sequence: 1,
    createdAt: new Date(nowMs - 1000).toISOString(), expiresAt: new Date(nowMs + 60_000).toISOString(),
    signingKeyId: "release-test", protocolVersion: S8_NATIVE_WORKER_PROTOCOL_VERSION, profile: S8_FBX_PROFILE,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256, processRunnerSha256: testDigest,
    writer: {
      imageDigest, blenderVersion: S8_BLENDER_PIN.version,
      blenderArchiveSha256: S8_BLENDER_PIN.archiveSha256,
      exporterPatchSha256: testDigest, writerScriptSha256: testDigest,
    },
    validator: {
      imageDigest, identity: S8_VALIDATOR_PIN.identity, ufbxVersion: S8_UFBX_PIN.version,
      ufbxCommit: S8_UFBX_PIN.commit, ufbxTree: S8_UFBX_PIN.tree, executableSha256: testDigest,
    },
    sandbox: {
      seccompPolicySha256: testDigest, jobAppArmorMode: "unsupported-not-relied-upon",
      rootlessKitHostAppArmor: {
        mode: "required-profile", profileName: "swooshz-s8-rootlesskit-v1", profileSha256: testDigest,
      },
    },
    provenanceSha256: testDigest, sbomSha256: testDigest,
  };
}

function signRelease(manifest: S8ReleaseManifestBody): S8SignedReleaseManifest {
  return {
    manifest,
    signature: signBody("S8-RELEASE-MANIFEST-V2", manifest, releasePair.privateKey),
  };
}

function budget(cpuMilli: number, memoryBytes: number, pids: number) {
  return { cpuMilli, memoryBytes, pids };
}

function sumBudgets(items: readonly ReturnType<typeof budget>[]) {
  return items.reduce((sum, item) => ({
    cpuMilli: sum.cpuMilli + item.cpuMilli,
    memoryBytes: sum.memoryBytes + item.memoryBytes,
    pids: sum.pids + item.pids,
  }), budget(0, 0, 0));
}

function authorityFixture(nowMs = Date.now()) {
  const releaseManifest = signRelease(releaseBody(nowMs));
  const releaseAuthorityKeys = { "release-test": releasePublicPem };
  const active = verifyS8ReleaseManifest(releaseManifest, releaseAuthorityKeys, nowMs);
  const measuredAt = new Date(nowMs).toISOString();
  const writer = budget(
    S8_NATIVE_RESOURCE_POLICY.writer.cpuMilli,
    S8_NATIVE_RESOURCE_POLICY.writer.memoryBytes,
    S8_NATIVE_RESOURCE_POLICY.writer.pids,
  );
  const validator = budget(
    S8_NATIVE_RESOURCE_POLICY.validator.cpuMilli,
    S8_NATIVE_RESOURCE_POLICY.validator.memoryBytes,
    S8_NATIVE_RESOURCE_POLICY.validator.pids,
  );
  const activeCpu = Math.max(writer.cpuMilli, validator.cpuMilli);
  const activeMemory = Math.max(writer.memoryBytes, validator.memoryBytes);
  const activePids = Math.max(writer.pids, validator.pids);
  const application = budget(4000, 4 * 1024 ** 3, 512);
  const gateway = budget(2000, 2 * 1024 ** 3, 256);
  const launcher = budget(2000, 2 * 1024 ** 3, 256);
  const rootlessDocker = budget(activeCpu + 1000, activeMemory + 512 * 1024 ** 2, activePids + 16);
  const systemd = budget(2000, 2 * 1024 ** 3, 512);
  const streaming = budget(2000, 2 * 1024 ** 3, 128);
  const designAggregate = sumBudgets([application, gateway, launcher, rootlessDocker, systemd, streaming]);
  const workloadBudget = budget(1000, 2 * 1024 ** 3, 100);
  const workloadIds = ["future-non-design", "n8n", "other-siblings", "quote", "wordpress"];
  const nonDesignWorkloads = workloadIds.map((workloadId) => ({
    workloadId,
    cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-" + workloadId + ".slice",
    budget: workloadBudget,
  }));
  const nonDesignAggregate = sumBudgets(nonDesignWorkloads.map((item) => item.budget));
  nonDesignAggregate.cpuMilli += 1000;
  nonDesignAggregate.memoryBytes += 1024 ** 3;
  nonDesignAggregate.pids += 100;
  const protectedHostReserve = budget(4000, 8 * 1024 ** 3, 2048);
  const host = sumBudgets([
    designAggregate, nonDesignAggregate, protectedHostReserve, budget(32_000, 64 * 1024 ** 3, 30_000),
  ]);
  const proof: S8CapacityProofBody = {
    schemaVersion: "s8-capacity-proof-v1", proofId: "run138-" + String(nowMs), state: "OPEN",
    issuedAt: new Date(nowMs - 1000).toISOString(), expiresAt: new Date(nowMs + 4 * 60_000).toISOString(),
    signingKeyId: "capacity-test",
    host: { hostId: "offline-synthetic-host", ...host, measuredAt },
    allocation: {
      designAggregate, designApplication: application, gateway, launcher, rootlessDocker, rootlessDockerUid: 1000,
      systemd, streaming, writer, validator, nonDesignAggregate, nonDesignWorkloads, protectedHostReserve,
    },
    oneOperationAtATime: true, workloadInventorySha256: testDigest, cgroupTreeSha256: "c".repeat(64),
    releaseManifestSha256: active.sha256, resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    contentionEvidenceIds: ["offline-contention-check"], resourceLimitEvidenceIds: ["offline-resource-check"],
  };
  const capacity = {
    proof,
    signature: signBody("S8-CAPACITY-PROOF-V1", proof, capacityPair.privateKey),
  };
  const observation = {
    schemaVersion: "s8-launcher-observation-v2" as const,
    proofSha256: sha256(jcs(capacity)), state: "OPEN" as const,
    observedAt: measuredAt, launcherKeyId: "launcher-test", hostId: proof.host.hostId,
    cpuMilli: proof.host.cpuMilli, memoryBytes: proof.host.memoryBytes, pids: proof.host.pids,
    workloadInventorySha256: proof.workloadInventorySha256, cgroupTreeSha256: proof.cgroupTreeSha256,
    releaseManifestSha256: active.sha256, resourcePolicySha256: proof.resourcePolicySha256,
    jobAppArmorMode: "unsupported-not-relied-upon" as const, rootlessKitHostAppArmorMode: "required-profile" as const,
    rootlessKitHostAppArmorProfileName: "swooshz-s8-rootlesskit-v1",
    rootlessKitHostAppArmorProfileSha256: testDigest,
    cgroupV2: true as const, rootlessDocker: true as const,
    requiredControllers: ["cpu", "memory", "pids"] as ["cpu", "memory", "pids"],
    startupReconciled: true as const, unreconciledContainerCount: 0 as const,
  };
  const envelope: S8AdmissionEnvelope = {
    capacity,
    launcher: {
      observation,
      signature: signBody("S8-LAUNCHER-OBSERVATION-V2", observation, launcherPair.privateKey),
    },
  };
  const trust = {
    capacityAuthorityKeys: { "capacity-test": capacityPublicPem },
    launcherKeys: { "launcher-test": launcherPublicPem },
  };
  return { nowMs, releaseManifest, releaseAuthorityKeys, active, envelope, trust };
}

function withLauncherMutation(
  envelope: S8AdmissionEnvelope,
  mutate: (observation: S8AdmissionEnvelope["launcher"]["observation"]) => void,
): S8AdmissionEnvelope {
  const observation = structuredClone(envelope.launcher.observation);
  mutate(observation);
  return {
    capacity: envelope.capacity,
    launcher: {
      observation,
      signature: signBody("S8-LAUNCHER-OBSERVATION-V2", observation, launcherPair.privateKey),
    },
  };
}

function withCapacityAndLauncherDigest(
  envelope: S8AdmissionEnvelope,
  digest: string,
): S8AdmissionEnvelope {
  const proof = structuredClone(envelope.capacity.proof);
  proof.releaseManifestSha256 = digest;
  const capacity = {
    proof,
    signature: signBody("S8-CAPACITY-PROOF-V1", proof, capacityPair.privateKey),
  };
  const observation = structuredClone(envelope.launcher.observation);
  observation.proofSha256 = sha256(jcs(capacity));
  observation.releaseManifestSha256 = digest;
  return {
    capacity,
    launcher: {
      observation,
      signature: signBody("S8-LAUNCHER-OBSERVATION-V2", observation, launcherPair.privateKey),
    },
  };
}

function workerClient(fixture: ReturnType<typeof authorityFixture>, envelope: S8AdmissionEnvelope): S8NativeWorkerClient {
  const config = {
    gatewayUrl: "https://s8-release-test.invalid/",
    appSigningKeyId: "app-test",
    appSigningPrivateKeyPem: releasePrivatePem,
    releaseManifest: fixture.releaseManifest,
    releaseAuthorityKeys: fixture.releaseAuthorityKeys,
    capacityAuthorityKeys: fixture.trust.capacityAuthorityKeys,
    launcherKeys: fixture.trust.launcherKeys,
    tlsCaPem: "unused test CA fixture",
    tlsClientCertPem: "unused test certificate fixture",
    tlsClientKeyPem: "unused test key fixture",
  };
  return new S8NativeWorkerClient(config, async () => Buffer.from(jcs(envelope), "utf8"));
}

async function clientAdmission(
  fixture: ReturnType<typeof authorityFixture>,
  envelope: S8AdmissionEnvelope,
) {
  const client = workerClient(fixture, envelope);
  try {
    return await client.getAdmission();
  } finally {
    client.close();
  }
}

function isAdmissionClosed(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "S8_WORKER_ADMISSION_CLOSED";
}

test("G138-P01 complete signed canonical admission opens and active release helper accepts", async () => {
  const fixture = authorityFixture();
  const decision = decideS8NativeAdmission(fixture.envelope, fixture.trust, fixture.nowMs);
  assert.equal(decision.state, "OPEN");
  assert.equal(decision.reason, null);
  assert.doesNotThrow(() => requireS8NativeAdmissionOpen(decision));
  const verified = verifyS8ReleaseManifest(
    fixture.releaseManifest, fixture.releaseAuthorityKeys, fixture.nowMs,
  );
  assert.equal(verified.sha256, fixture.envelope.capacity.proof.releaseManifestSha256);
  assert.doesNotThrow(() => assertS8ReleaseAdmissionBinding(fixture.envelope, verified));
  assert.equal((await clientAdmission(fixture, fixture.envelope)).state, "OPEN");
});
test("G138-N01 re-signed launcher release digest drift closes canonical admission", async () => {
  const fixture = authorityFixture();
  const drifted = withLauncherMutation(fixture.envelope, (observation) => {
    observation.releaseManifestSha256 = otherDigest;
  });
  const decision = decideS8NativeAdmission(drifted, fixture.trust, fixture.nowMs);
  assert.equal(decision.state, "CLOSED");
  assert.equal(decision.reason, "REALIZATION_DRIFT");
  assert.throws(() => requireS8NativeAdmissionOpen(decision), isAdmissionClosed);
  const clientDecision = await clientAdmission(fixture, drifted);
  assert.equal(clientDecision.state, "CLOSED");
  assert.equal(clientDecision.reason, "REALIZATION_DRIFT");
});

test("G138-N02 re-signed consistent alternate digest still fails active release binding", async () => {
  const fixture = authorityFixture();
  const alternate = withCapacityAndLauncherDigest(fixture.envelope, otherDigest);
  const decision = decideS8NativeAdmission(alternate, fixture.trust, fixture.nowMs);
  assert.equal(decision.state, "OPEN");
  assert.equal(decision.reason, null);
  assert.throws(
    () => assertS8ReleaseAdmissionBinding(alternate, fixture.active),
    /S8_RELEASE_MANIFEST_DRIFT/u,
  );
  const clientDecision = await clientAdmission(fixture, alternate);
  assert.equal(clientDecision.state, "CLOSED");
  assert.equal(clientDecision.reason, "REALIZATION_DRIFT");
});

test("G138-N03 missing launcher release digest is negative-only malformed input", async () => {
  const fixture = authorityFixture();
  const malformed = withLauncherMutation(fixture.envelope, (observation) => {
    delete (observation as unknown as Record<string, unknown>).releaseManifestSha256;
  });
  const decision = decideS8NativeAdmission(malformed, fixture.trust, fixture.nowMs);
  assert.equal(decision.state, "CLOSED");
  assert.equal(decision.reason, "OBSERVATION_INVALID");
  const clientDecision = await clientAdmission(fixture, malformed);
  assert.equal(clientDecision.state, "CLOSED");
  assert.equal(clientDecision.reason, "OBSERVATION_INVALID");
});

test("G138-R01 release signature, schema, identity, AppArmor, policy, provenance, SBOM, and freshness remain strict", async () => {
  const now = Date.now();
  const valid = signRelease(releaseBody(now));
  const verified = verifyS8ReleaseManifest(valid, { "release-test": releasePublicPem }, now);
  assert.equal(verified.manifest.writer.imageDigest, valid.manifest.writer.imageDigest);
  assert.equal(verified.manifest.validator.imageDigest, valid.manifest.validator.imageDigest);
  assert.equal(verified.manifest.validator.executableSha256, valid.manifest.validator.executableSha256);
  assert.equal(verified.manifest.sandbox.jobAppArmorMode, "unsupported-not-relied-upon");
  assert.equal(verified.manifest.provenanceSha256, testDigest);
  assert.equal(verified.manifest.sbomSha256, testDigest);
  assert.equal(verified.sha256, sha256(jcs(valid)));
  assert.throws(() => verifyS8ReleaseManifest(valid, {}, now));

  const tampered = structuredClone(valid);
  tampered.manifest.sbomSha256 = "d".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(tampered, { "release-test": releasePublicPem }, now));

  const schemaV1 = releaseBody(now);
  (schemaV1 as unknown as { schemaVersion: string }).schemaVersion = "s8-release-manifest-v1";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(schemaV1), { "release-test": releasePublicPem }, now,
  ));
  const oldProtocol = releaseBody(now);
  (oldProtocol as unknown as { protocolVersion: string }).protocolVersion = "s8-native-worker-v0";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(oldProtocol), { "release-test": releasePublicPem }, now,
  ));

  const wrongWriterImage = releaseBody(now);
  wrongWriterImage.writer.imageDigest = "not-an-image-digest";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongWriterImage), { "release-test": releasePublicPem }, now,
  ));
  const wrongValidatorImage = releaseBody(now);
  wrongValidatorImage.validator.imageDigest = "sha256:" + "x".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongValidatorImage), { "release-test": releasePublicPem }, now,
  ));
  const wrongValidatorIdentity = releaseBody(now);
  (wrongValidatorIdentity.validator as unknown as { identity: string }).identity = "untrusted-validator";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongValidatorIdentity), { "release-test": releasePublicPem }, now,
  ));
  const wrongExecutable = releaseBody(now);
  wrongExecutable.validator.executableSha256 = "not-a-digest";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongExecutable), { "release-test": releasePublicPem }, now,
  ));

  const wrongPolicy = releaseBody(now);
  wrongPolicy.resourcePolicySha256 = "e".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongPolicy), { "release-test": releasePublicPem }, now,
  ));
  const wrongJobProfile = releaseBody(now);
  (wrongJobProfile.sandbox as unknown as { jobAppArmorMode: string }).jobAppArmorMode = "required-profile";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongJobProfile), { "release-test": releasePublicPem }, now,
  ));
  const wrongHostProfile = releaseBody(now);
  (wrongHostProfile.sandbox.rootlessKitHostAppArmor as unknown as { profileName: string }).profileName = "unexpected-profile";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(wrongHostProfile), { "release-test": releasePublicPem }, now,
  ));

  const missingProvenance = releaseBody(now);
  missingProvenance.provenanceSha256 = "not-a-digest";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(missingProvenance), { "release-test": releasePublicPem }, now,
  ));
  const missingSbom = releaseBody(now);
  missingSbom.sbomSha256 = "not-a-digest";
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(missingSbom), { "release-test": releasePublicPem }, now,
  ));
  const changedProvenance = signRelease(releaseBody(now));
  changedProvenance.manifest.provenanceSha256 = "f".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(
    changedProvenance, { "release-test": releasePublicPem }, now,
  ));

  const expired = releaseBody(now);
  expired.createdAt = new Date(now - 120_000).toISOString();
  expired.expiresAt = new Date(now - 1).toISOString();
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(expired), { "release-test": releasePublicPem }, now,
  ));
  const stale = releaseBody(now);
  stale.createdAt = new Date(now - 366 * 24 * 60 * 60 * 1000).toISOString();
  stale.expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(stale), { "release-test": releasePublicPem }, now,
  ));
  const future = releaseBody(now);
  future.createdAt = new Date(now + 6000).toISOString();
  future.expiresAt = new Date(now + 60_000).toISOString();
  assert.throws(() => verifyS8ReleaseManifest(
    signRelease(future), { "release-test": releasePublicPem }, now,
  ));

  const fixture = authorityFixture(now);
  const active = verifyS8ReleaseManifest(
    fixture.releaseManifest, fixture.releaseAuthorityKeys, fixture.nowMs,
  );
  const appArmorMutations: ReadonlyArray<[
    string,
    (observation: S8AdmissionEnvelope["launcher"]["observation"]) => void,
  ]> = [
    ["jobAppArmorMode", (observation) => {
      (observation as unknown as { jobAppArmorMode: string }).jobAppArmorMode = "required-profile";
    }],
    ["rootlessKitHostAppArmorMode", (observation) => {
      (observation as unknown as { rootlessKitHostAppArmorMode: string }).rootlessKitHostAppArmorMode = "unsupported";
    }],
    ["rootlessKitHostAppArmorProfileName", (observation) => {
      observation.rootlessKitHostAppArmorProfileName = "wrong-profile";
    }],
    ["rootlessKitHostAppArmorProfileSha256", (observation) => {
      observation.rootlessKitHostAppArmorProfileSha256 = otherDigest;
    }],
  ];
  for (const [_name, mutate] of appArmorMutations) {
    const drifted = withLauncherMutation(fixture.envelope, mutate);
    assert.throws(
      () => assertS8ReleaseAdmissionBinding(drifted, active),
      /S8_RELEASE_MANIFEST_DRIFT/u,
    );
    const decision = await clientAdmission(fixture, drifted);
    assert.equal(decision.state, "CLOSED");
    assert.equal(decision.reason, "REALIZATION_DRIFT");
  }

  const wrongActiveDigest = withCapacityAndLauncherDigest(fixture.envelope, otherDigest);
  assert.throws(
    () => assertS8ReleaseAdmissionBinding(wrongActiveDigest, active),
    /S8_RELEASE_MANIFEST_DRIFT/u,
  );
});

test("G138-I01 production admission and release helpers preserve Run-130/G135 active binding", async () => {
  const fixture = authorityFixture();
  const directDecision = decideS8NativeAdmission(fixture.envelope, fixture.trust, fixture.nowMs);
  assert.equal(directDecision.state, "OPEN");
  const active = verifyS8ReleaseManifest(
    fixture.releaseManifest, fixture.releaseAuthorityKeys, fixture.nowMs,
  );
  assert.doesNotThrow(() => assertS8ReleaseAdmissionBinding(fixture.envelope, active));

  const mismatchedAppArmor = withLauncherMutation(fixture.envelope, (observation) => {
    observation.rootlessKitHostAppArmorProfileSha256 = otherDigest;
  });
  assert.equal(decideS8NativeAdmission(mismatchedAppArmor, fixture.trust, fixture.nowMs).state, "OPEN");
  const productionDecision = await clientAdmission(fixture, mismatchedAppArmor);
  assert.equal(productionDecision.state, "CLOSED");
  assert.equal(productionDecision.reason, "REALIZATION_DRIFT");
});
