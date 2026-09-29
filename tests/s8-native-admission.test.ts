import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { decideS8NativeAdmission, requireS8NativeAdmissionOpen, S8_NATIVE_RESOURCE_POLICY, S8_NATIVE_RESOURCE_POLICY_SHA256, type S8AdmissionEnvelope } from "../src/lib/s8-native-admission";
import { jcs, sha256 } from "../src/lib/utils";

const now = Date.parse("2026-09-29T00:00:00.000Z");
const capacityKeys = generateKeyPairSync("ed25519");
const launcherKeys = generateKeyPairSync("ed25519");
const capacityPublicPem = capacityKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const launcherPublicPem = launcherKeys.publicKey.export({ format: "pem", type: "spki" }).toString();

function signBody(body: Record<string, unknown>, privateKey: typeof capacityKeys.privateKey, domain: string): string {
  return sign(null, Buffer.concat([Buffer.from(domain + "\0", "ascii"), Buffer.from(jcs(body), "utf8")]), privateKey).toString("base64url");
}

function capacityProof(state: "CLOSED" | "PROVING" | "OPEN" = "OPEN", cpuMilli = 4000) {
  const proof = {
    schemaVersion: "s8-capacity-proof-v1",
    proofId: "proof-2026-09-29",
    state,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    signingKeyId: "owner-capacity-2026",
    host: { hostId: "swooshz-vps-test", cpuMilli, memoryBytes: 24 * 1024 ** 3, pids: 2048, measuredAt: new Date(now - 1000).toISOString() },
    allocation: {
      designAggregate: { cpuMilli: 3000, memoryBytes: 10 * 1024 ** 3, pids: 600 },
      designApplication: { cpuMilli: 300, memoryBytes: 1024 ** 3, pids: 100 },
      gateway: { cpuMilli: 100, memoryBytes: 256 * 1024 ** 2, pids: 64 },
      launcher: { cpuMilli: 100, memoryBytes: 256 * 1024 ** 2, pids: 64 },
      rootlessDocker: { cpuMilli: 2100, memoryBytes: 4 * 1024 ** 3 + 256 * 1024 ** 2, pids: 96 },
      rootlessDockerUid: 12001,
      systemd: { cpuMilli: 100, memoryBytes: 256 * 1024 ** 2, pids: 64 },
      streaming: { cpuMilli: 100, memoryBytes: 2 * 1024 ** 3, pids: 64 },
      writer: { cpuMilli: S8_NATIVE_RESOURCE_POLICY.writer.cpuMilli, memoryBytes: S8_NATIVE_RESOURCE_POLICY.writer.memoryBytes, pids: S8_NATIVE_RESOURCE_POLICY.writer.pids },
      validator: { cpuMilli: S8_NATIVE_RESOURCE_POLICY.validator.cpuMilli, memoryBytes: S8_NATIVE_RESOURCE_POLICY.validator.memoryBytes, pids: S8_NATIVE_RESOURCE_POLICY.validator.pids },
      nonDesignAggregate: { cpuMilli: 500, memoryBytes: 4 * 1024 ** 3, pids: 400 },
      nonDesignWorkloads: [
        { workloadId: "future-non-design", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-future-non-design.slice", budget: { cpuMilli: 80, memoryBytes: 512 * 1024 ** 2, pids: 64 } },
        { workloadId: "n8n", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-n8n.slice", budget: { cpuMilli: 120, memoryBytes: 1024 ** 3, pids: 100 } },
        { workloadId: "other-siblings", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-other-siblings.slice", budget: { cpuMilli: 80, memoryBytes: 512 * 1024 ** 2, pids: 64 } },
        { workloadId: "quote", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-quote.slice", budget: { cpuMilli: 120, memoryBytes: 1024 ** 3, pids: 100 } },
        { workloadId: "wordpress", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-wordpress.slice", budget: { cpuMilli: 100, memoryBytes: 1024 ** 3, pids: 72 } },
      ],
      protectedHostReserve: { cpuMilli: 500, memoryBytes: 4 * 1024 ** 3, pids: 512 },
    },
    oneOperationAtATime: true,
    workloadInventorySha256: "f".repeat(64),
    cgroupTreeSha256: "d".repeat(64),
    releaseManifestSha256: "e".repeat(64),
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    contentionEvidenceIds: ["contention-proof-1"],
    resourceLimitEvidenceIds: ["limit-proof-1"],
  };
  return { proof, signature: signBody(proof, capacityKeys.privateKey, "S8-CAPACITY-PROOF-V1") };
}

function envelope(state: "CLOSED" | "PROVING" | "OPEN" = "OPEN", cpuMilli = 4000): S8AdmissionEnvelope {
  const capacity = capacityProof(state, cpuMilli);
  const proofSha256 = sha256(jcs(capacity));
  const observation = {
    schemaVersion: "s8-launcher-observation-v2",
    proofSha256,
    state,
    observedAt: new Date(now - 500).toISOString(),
    launcherKeyId: "launcher-2026",
    hostId: "swooshz-vps-test",
    cpuMilli,
    memoryBytes: 24 * 1024 ** 3,
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
    requiredControllers: ["cpu", "memory", "pids"] as ["cpu", "memory", "pids"],
    startupReconciled: true,
    unreconciledContainerCount: 0,
  };
  return {
    capacity,
    launcher: { observation, signature: signBody(observation, launcherKeys.privateKey, "S8-LAUNCHER-OBSERVATION-V2") },
  } as S8AdmissionEnvelope;
}

const trust = {
  capacityAuthorityKeys: { "owner-capacity-2026": capacityPublicPem },
  launcherKeys: { "launcher-2026": launcherPublicPem },
};

test("missing proof and missing trust remain CLOSED", () => {
  assert.equal(decideS8NativeAdmission(undefined, trust, now).state, "CLOSED");
  assert.equal(decideS8NativeAdmission(envelope(), undefined, now).state, "CLOSED");
});

test("OPEN accepts unsupported-not-relied-upon job AppArmor with a bound RootlessKit host profile", () => {
  const proofEnvelope = envelope();
  const result = decideS8NativeAdmission(proofEnvelope, trust, now);
  assert.deepEqual(result, {
    state: "OPEN",
    reason: null,
    proofSha256: sha256(jcs(proofEnvelope.capacity)),
    observedAt: new Date(now - 500).toISOString(),
  });
  assert.doesNotThrow(() => requireS8NativeAdmissionOpen(result));
});

test("capacity proofs must itemize protected sibling workload budgets", () => {
  const value = envelope();
  (value.capacity.proof.allocation as unknown as { nonDesignWorkloads: unknown[] }).nonDesignWorkloads = [];
  value.capacity.signature = signBody(value.capacity.proof as unknown as Record<string, unknown>, capacityKeys.privateKey, "S8-CAPACITY-PROOF-V1");
  assert.equal(decideS8NativeAdmission(value, trust, now).reason, "ALLOCATION_INVALID");
});

test("the current two-vCPU host cannot fit the frozen Writer plus positive allocations", () => {
  const result = decideS8NativeAdmission(envelope("OPEN", 2000), trust, now);
  assert.equal(result.state, "CLOSED");
  assert.equal(result.reason, "ALLOCATION_INVALID");
  assert.throws(() => requireS8NativeAdmissionOpen(result), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 503);
    assert.equal((error as { code?: string }).code, "S8_WORKER_ADMISSION_CLOSED");
    return true;
  });
});

test("PROVING is observable but cannot dispatch product work", () => {
  const result = decideS8NativeAdmission(envelope("PROVING"), trust, now);
  assert.equal(result.state, "PROVING");
  assert.equal(result.reason, "CAPACITY_NOT_OPEN");
  assert.throws(() => requireS8NativeAdmissionOpen(result), /S8_WORKER_ADMISSION_CLOSED/);
});

test("the prior launcher observation schema and signature domain are rejected", () => {
  const oldSchema = envelope();
  (oldSchema.launcher.observation as unknown as { schemaVersion: string }).schemaVersion = "s8-launcher-observation-v1";
  oldSchema.launcher.signature = signBody(oldSchema.launcher.observation as unknown as Record<string, unknown>, launcherKeys.privateKey, "S8-LAUNCHER-OBSERVATION-V1");
  assert.equal(decideS8NativeAdmission(oldSchema, trust, now).reason, "SIGNATURE_INVALID");
});

test("tampered proof, launcher drift, and impossible AppArmor mode fail closed", () => {
  const tampered = envelope();
  (tampered.capacity.proof.host as { memoryBytes: number }).memoryBytes -= 1;
  assert.equal(decideS8NativeAdmission(tampered, trust, now).reason, "SIGNATURE_INVALID");

  const drifted = envelope();
  (drifted.launcher.observation as { cgroupTreeSha256: string }).cgroupTreeSha256 = "a".repeat(64);
  drifted.launcher.signature = signBody(drifted.launcher.observation as unknown as Record<string, unknown>, launcherKeys.privateKey, "S8-LAUNCHER-OBSERVATION-V2");
  assert.equal(decideS8NativeAdmission(drifted, trust, now).reason, "REALIZATION_DRIFT");

  const wrongJobMode = envelope();
  (wrongJobMode.launcher.observation as unknown as { jobAppArmorMode: string }).jobAppArmorMode = "required-profile";
  wrongJobMode.launcher.signature = signBody(wrongJobMode.launcher.observation as unknown as Record<string, unknown>, launcherKeys.privateKey, "S8-LAUNCHER-OBSERVATION-V2");
  assert.equal(decideS8NativeAdmission(wrongJobMode, trust, now).reason, "REALIZATION_DRIFT");
});

test("expired proof and stale launcher observation fail closed", () => {
  const expired = envelope();
  expired.capacity.proof.expiresAt = new Date(now - 1).toISOString();
  expired.capacity.signature = signBody(expired.capacity.proof as unknown as Record<string, unknown>, capacityKeys.privateKey, "S8-CAPACITY-PROOF-V1");
  assert.equal(decideS8NativeAdmission(expired, trust, now).reason, "PROOF_STALE");

  const staleObservation = envelope();
  staleObservation.launcher.observation.observedAt = new Date(now - 31_000).toISOString();
  staleObservation.launcher.signature = signBody(staleObservation.launcher.observation as unknown as Record<string, unknown>, launcherKeys.privateKey, "S8-LAUNCHER-OBSERVATION-V2");
  assert.equal(decideS8NativeAdmission(staleObservation, trust, now).reason, "OBSERVATION_STALE");
});
