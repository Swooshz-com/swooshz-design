import { verify as verifySignature } from "node:crypto";
import { jcs, sha256 } from "./protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./resource-policy.mjs";

const HEX64 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const CLOCK_SKEW_MS = 5000;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 30 * 1000;

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record");
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("keys");
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function time(value) {
  if (typeof value !== "string") throw new Error("timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("timestamp");
  return parsed;
}

function budget(value) {
  const parsed = record(value);
  exactKeys(parsed, ["cpuMilli", "memoryBytes", "pids"]);
  if (!positive(parsed.cpuMilli) || !positive(parsed.memoryBytes) || !positive(parsed.pids)) throw new Error("budget");
  return parsed;
}

function fits(total, values) {
  const sum = values.reduce((result, item) => ({
    cpuMilli: result.cpuMilli + item.cpuMilli,
    memoryBytes: result.memoryBytes + item.memoryBytes,
    pids: result.pids + item.pids,
  }), { cpuMilli: 0, memoryBytes: 0, pids: 0 });
  return Object.values(sum).every(Number.isSafeInteger)
    && sum.cpuMilli <= total.cpuMilli && sum.memoryBytes <= total.memoryBytes && sum.pids <= total.pids;
}

function signatureValid(body, signature, pem, domain) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && verifySignature(null, Buffer.concat([Buffer.from(`${domain}\0`, "ascii"), Buffer.from(jcs(body), "utf8")]), pem, bytes);
}

export function verifyCapacityProof(signedValue, trustedKeys, nowMs = Date.now()) {
  const signed = record(signedValue);
  exactKeys(signed, ["proof", "signature"]);
  const proof = record(signed.proof);
  exactKeys(proof, [
    "schemaVersion", "proofId", "state", "issuedAt", "expiresAt", "signingKeyId", "host", "allocation",
    "oneOperationAtATime", "workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256",
    "resourcePolicySha256", "contentionEvidenceIds", "resourceLimitEvidenceIds",
  ]);
  if (proof.schemaVersion !== "s8-capacity-proof-v1" || !["CLOSED", "PROVING", "OPEN"].includes(proof.state)
    || typeof proof.proofId !== "string" || !KEY_ID.test(proof.proofId) || typeof proof.signingKeyId !== "string" || !KEY_ID.test(proof.signingKeyId)) throw new Error("proof-schema");
  const publicKey = trustedKeys[proof.signingKeyId];
  if (!publicKey || !signatureValid(proof, signed.signature, publicKey, "S8-CAPACITY-PROOF-V1")) throw new Error("proof-signature");
  const issued = time(proof.issuedAt);
  const expires = time(proof.expiresAt);
  if (issued > nowMs + CLOCK_SKEW_MS || expires <= nowMs || expires <= issued || expires - issued > MAX_PROOF_AGE_MS) throw new Error("proof-freshness");
  const host = record(proof.host);
  exactKeys(host, ["hostId", "cpuMilli", "memoryBytes", "pids", "measuredAt"]);
  if (typeof host.hostId !== "string" || host.hostId.length < 1 || host.hostId.length > 160 || !positive(host.cpuMilli) || !positive(host.memoryBytes) || !positive(host.pids)) throw new Error("host");
  const measuredAt = time(host.measuredAt);
  if (measuredAt > nowMs + CLOCK_SKEW_MS || nowMs - measuredAt > MAX_PROOF_AGE_MS) throw new Error("host-freshness");
  if (proof.oneOperationAtATime !== true || proof.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("policy");
  for (const field of ["workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256", "resourcePolicySha256"]) {
    if (typeof proof[field] !== "string" || !HEX64.test(proof[field])) throw new Error("digest");
  }
  for (const field of ["contentionEvidenceIds", "resourceLimitEvidenceIds"]) {
    const values = proof[field];
    if (!Array.isArray(values) || values.length === 0 || values.length > 100
      || values.some((item) => typeof item !== "string" || item.length === 0 || item.length > 160)
      || new Set(values).size !== values.length) throw new Error("evidence");
  }
  const allocation = record(proof.allocation);
  exactKeys(allocation, ["designAggregate", "designApplication", "gateway", "launcher", "rootlessDocker", "rootlessDockerUid", "systemd", "streaming", "writer", "validator", "nonDesignAggregate", "nonDesignWorkloads", "protectedHostReserve"]);
  if (!Number.isSafeInteger(allocation.rootlessDockerUid) || allocation.rootlessDockerUid < 1000 || allocation.rootlessDockerUid > 2147483647) throw new Error("rootless-uid");
  const budgets = {};
  for (const key of ["designAggregate", "designApplication", "gateway", "launcher", "rootlessDocker", "systemd", "streaming", "writer", "validator", "nonDesignAggregate", "protectedHostReserve"]) budgets[key] = budget(allocation[key]);
  if (budgets.writer.cpuMilli !== 2000 || budgets.writer.memoryBytes !== 4 * 1024 ** 3 || budgets.writer.pids !== 80
    || budgets.validator.cpuMilli !== 1000 || budgets.validator.memoryBytes !== 1536 * 1024 ** 2 || budgets.validator.pids !== 32
    || budgets.streaming.memoryBytes < 2 * 1024 ** 3) throw new Error("frozen-limits");
  const siblings = allocation.nonDesignWorkloads;
  const required = new Set(["quote", "n8n", "wordpress", "other-siblings", "future-non-design"]);
  if (!Array.isArray(siblings) || siblings.length < required.size || siblings.length > 128) throw new Error("siblings");
  let previous = "";
  const siblingBudgets = [];
  const seen = new Set();
  for (const itemValue of siblings) {
    const item = record(itemValue);
    exactKeys(item, ["workloadId", "cgroupPath", "budget"]);
    if (typeof item.workloadId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(item.workloadId) || item.workloadId <= previous
      || typeof item.cgroupPath !== "string" || item.cgroupPath !== "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-" + item.workloadId + ".slice") throw new Error("siblings");
    previous = item.workloadId;
    seen.add(item.workloadId);
    siblingBudgets.push(budget(item.budget));
  }
  if ([...required].some((id) => !seen.has(id)) || !fits(budgets.nonDesignAggregate, siblingBudgets)) throw new Error("siblings");
  const worker = {
    cpuMilli: Math.max(budgets.writer.cpuMilli, budgets.validator.cpuMilli),
    memoryBytes: Math.max(budgets.writer.memoryBytes, budgets.validator.memoryBytes),
    pids: Math.max(budgets.writer.pids, budgets.validator.pids),
  };
  if (!fits(budgets.rootlessDocker, [worker])
    || budgets.rootlessDocker.cpuMilli <= worker.cpuMilli
    || budgets.rootlessDocker.memoryBytes <= worker.memoryBytes
    || budgets.rootlessDocker.pids <= worker.pids) throw new Error("rootless-runtime-budget");
  if (!fits(budgets.designAggregate, [budgets.designApplication, budgets.gateway, budgets.launcher, budgets.rootlessDocker, budgets.systemd, budgets.streaming])) throw new Error("design-total");
  if (!fits({ cpuMilli: host.cpuMilli, memoryBytes: host.memoryBytes, pids: host.pids }, [budgets.designAggregate, budgets.nonDesignAggregate, budgets.protectedHostReserve])) throw new Error("host-total");
  return { signed, proof, proofSha256: sha256(Buffer.from(jcs(signed), "utf8")), budgets };
}

export function verifyAdmissionEnvelope(envelopeValue, trust, nowMs = Date.now()) {
  const envelope = record(envelopeValue);
  exactKeys(envelope, ["capacity", "launcher"]);
  const capacity = verifyCapacityProof(envelope.capacity, trust.capacityAuthorityKeys, nowMs);
  const launcher = record(envelope.launcher);
  exactKeys(launcher, ["observation", "signature"]);
  const observation = record(launcher.observation);
  exactKeys(observation, [
    "schemaVersion", "proofSha256", "state", "observedAt", "launcherKeyId", "hostId", "cpuMilli", "memoryBytes", "pids",
    "workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256", "resourcePolicySha256",
    "jobAppArmorMode", "rootlessKitHostAppArmorMode", "rootlessKitHostAppArmorProfileName", "rootlessKitHostAppArmorProfileSha256",
    "cgroupV2", "rootlessDocker", "requiredControllers", "startupReconciled", "unreconciledContainerCount",
  ]);
  if (observation.schemaVersion !== "s8-launcher-observation-v2" || !KEY_ID.test(observation.launcherKeyId)
    || observation.proofSha256 !== capacity.proofSha256 || observation.state !== capacity.proof.state) throw new Error("observation-binding");
  const observedAt = time(observation.observedAt);
  if (observedAt > nowMs + CLOCK_SKEW_MS || nowMs - observedAt > MAX_OBSERVATION_AGE_MS) throw new Error("observation-freshness");
  const host = capacity.proof.host;
  for (const [field, value] of Object.entries({
    hostId: host.hostId, cpuMilli: host.cpuMilli, memoryBytes: host.memoryBytes, pids: host.pids,
    workloadInventorySha256: capacity.proof.workloadInventorySha256, cgroupTreeSha256: capacity.proof.cgroupTreeSha256,
    releaseManifestSha256: capacity.proof.releaseManifestSha256, resourcePolicySha256: capacity.proof.resourcePolicySha256,
  })) if (observation[field] !== value) throw new Error("observation-drift");
  if (observation.cgroupV2 !== true || observation.rootlessDocker !== true || observation.startupReconciled !== true || observation.unreconciledContainerCount !== 0
    || observation.jobAppArmorMode !== "unsupported-not-relied-upon" || observation.rootlessKitHostAppArmorMode !== "required-profile"
    || observation.rootlessKitHostAppArmorProfileName !== "swooshz-s8-rootlesskit-v1"
    || typeof observation.rootlessKitHostAppArmorProfileSha256 !== "string" || !HEX64.test(observation.rootlessKitHostAppArmorProfileSha256)
    || !Array.isArray(observation.requiredControllers) || observation.requiredControllers.join(",") !== "cpu,memory,pids") throw new Error("observation-runtime");
  const launcherKey = trust.launcherKeys[observation.launcherKeyId];
  if (!launcherKey || !signatureValid(observation, launcher.signature, launcherKey, "S8-LAUNCHER-OBSERVATION-V2")) throw new Error("observation-signature");
  return { capacity, launcher, observation };
}

export function verifyReleaseManifest(signedValue, trustedKeys, nowMs = Date.now()) {
  const signed = record(signedValue);
  exactKeys(signed, ["manifest", "signature"]);
  const body = record(signed.manifest);
  exactKeys(body, ["schemaVersion", "releaseId", "sequence", "createdAt", "expiresAt", "signingKeyId", "protocolVersion", "profile", "resourcePolicySha256", "processRunnerSha256", "writer", "validator", "sandbox", "provenanceSha256", "sbomSha256"]);
  if (body.schemaVersion !== "s8-release-manifest-v2" || typeof body.releaseId !== "string" || !/^[A-Za-z0-9._-]{1,120}$/u.test(body.releaseId)
    || !Number.isSafeInteger(body.sequence) || body.sequence < 1 || typeof body.signingKeyId !== "string" || !KEY_ID.test(body.signingKeyId)
    || body.protocolVersion !== "s8-native-worker-v1" || body.profile !== "swooshz-fbx-static-mesh-v1"
    || body.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("release-schema");
  const created = time(body.createdAt);
  const expires = time(body.expiresAt);
  if (created > nowMs + CLOCK_SKEW_MS || expires <= nowMs || expires <= created || expires - created > 365 * 24 * 60 * 60 * 1000) throw new Error("release-freshness");
  if (typeof body.processRunnerSha256 !== "string" || !HEX64.test(body.processRunnerSha256)) throw new Error("release-executable");
  if (![body.provenanceSha256, body.sbomSha256].every((value) => typeof value === "string" && HEX64.test(value))) throw new Error("release-digest");
  const writer = record(body.writer);
  exactKeys(writer, ["imageDigest", "blenderVersion", "blenderArchiveSha256", "exporterPatchSha256", "writerScriptSha256"]);
  const validator = record(body.validator);
  exactKeys(validator, ["imageDigest", "identity", "ufbxVersion", "ufbxCommit", "ufbxTree", "executableSha256"]);
  if (![writer.imageDigest, validator.imageDigest].every((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value))) throw new Error("release-image");
  if (![writer.blenderArchiveSha256, writer.exporterPatchSha256, writer.writerScriptSha256, validator.executableSha256].every((value) => typeof value === "string" && HEX64.test(value))) throw new Error("release-executable");
  const sandbox = record(body.sandbox);
  exactKeys(sandbox, ["seccompPolicySha256", "jobAppArmorMode", "rootlessKitHostAppArmor"]);
  if (typeof sandbox.seccompPolicySha256 !== "string" || !HEX64.test(sandbox.seccompPolicySha256)
    || sandbox.jobAppArmorMode !== "unsupported-not-relied-upon") throw new Error("release-sandbox");
  const rootlessKitHostAppArmor = record(sandbox.rootlessKitHostAppArmor);
  exactKeys(rootlessKitHostAppArmor, ["mode", "profileName", "profileSha256"]);
  if (rootlessKitHostAppArmor.mode !== "required-profile"
    || rootlessKitHostAppArmor.profileName !== "swooshz-s8-rootlesskit-v1"
    || typeof rootlessKitHostAppArmor.profileSha256 !== "string" || !HEX64.test(rootlessKitHostAppArmor.profileSha256)) throw new Error("release-sandbox");
  const key = trustedKeys[body.signingKeyId];
  if (!key || !signatureValid(body, signed.signature, key, "S8-RELEASE-MANIFEST-V2")) throw new Error("release-signature");
  return { signed, manifest: body, sha256: sha256(Buffer.from(jcs(signed), "utf8")) };
}

export { jcs, sha256 };
