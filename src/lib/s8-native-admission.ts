import { verify as verifySignature } from "node:crypto";
import { AppError } from "./types";
import { jcs, sha256 } from "./utils";
import { S8_LIMITS } from "./s8-fbx-profile";

export type S8AdmissionState = "CLOSED" | "PROVING" | "OPEN";

export type S8ResourceBudget = {
  cpuMilli: number;
  memoryBytes: number;
  pids: number;
};

export const S8_NATIVE_RESOURCE_POLICY = Object.freeze({
  schemaVersion: "s8-native-resource-policy-v1",
  oneOperationAtATime: true,
  streaming: Object.freeze({ minimumMemoryBytes: 2 * 1024 * 1024 * 1024, applicationPercent: 30, gatewayPercent: 30, launcherPercent: 40 }),
  writer: Object.freeze({
    cpuMilli: 2000,
    memoryBytes: S8_LIMITS.memoryBytes,
    pids: 80,
    inputBytes: S8_LIMITS.payloadBytes,
    outputBytes: S8_LIMITS.artifactBytes,
    receiptBytes: S8_LIMITS.receiptBytes,
    stdoutBytes: S8_LIMITS.stdoutBytes,
    stderrBytes: S8_LIMITS.stderrBytes,
    nativeDeadlineMs: S8_LIMITS.timeoutMs,
    endToEndDeadlineMs: 510000,
    tmpBytes: 1024 * 1024 * 1024,
  }),
  validator: Object.freeze({
    cpuMilli: 1000,
    memoryBytes: S8_LIMITS.validatorMemoryBytes,
    pids: 32,
    inputBytes: 128 * 1024 * 1024,
    outputBytes: S8_LIMITS.readbackBytes,
    stdoutBytes: S8_LIMITS.readbackBytes,
    stderrBytes: S8_LIMITS.stderrBytes,
    nativeDeadlineMs: S8_LIMITS.validatorTimeoutMs,
    endToEndDeadlineMs: 330000,
    tmpBytes: S8_LIMITS.validatorTempBytes,
  }),
});
export const S8_NATIVE_RESOURCE_POLICY_SHA256 = sha256(jcs(S8_NATIVE_RESOURCE_POLICY));

type S8HostCapacity = {
  hostId: string;
  cpuMilli: number;
  memoryBytes: number;
  pids: number;
  measuredAt: string;
};

type S8CapacityAllocation = {
  designAggregate: S8ResourceBudget;
  designApplication: S8ResourceBudget;
  gateway: S8ResourceBudget;
  launcher: S8ResourceBudget;
  rootlessDocker: S8ResourceBudget;
  rootlessDockerUid: number;
  systemd: S8ResourceBudget;
  streaming: S8ResourceBudget;
  writer: S8ResourceBudget;
  validator: S8ResourceBudget;
  nonDesignAggregate: S8ResourceBudget;
  nonDesignWorkloads: Array<{ workloadId: string; cgroupPath: string; budget: S8ResourceBudget }>;
  protectedHostReserve: S8ResourceBudget;
};

export type S8CapacityProofBody = {
  schemaVersion: "s8-capacity-proof-v1";
  proofId: string;
  state: S8AdmissionState;
  issuedAt: string;
  expiresAt: string;
  signingKeyId: string;
  host: S8HostCapacity;
  allocation: S8CapacityAllocation;
  oneOperationAtATime: true;
  workloadInventorySha256: string;
  cgroupTreeSha256: string;
  releaseManifestSha256: string;
  resourcePolicySha256: string;
  contentionEvidenceIds: string[];
  resourceLimitEvidenceIds: string[];
};

export type S8SignedCapacityProof = {
  proof: S8CapacityProofBody;
  signature: string;
};

type S8LauncherObservationBody = {
  schemaVersion: "s8-launcher-observation-v2";
  proofSha256: string;
  state: S8AdmissionState;
  observedAt: string;
  launcherKeyId: string;
  hostId: string;
  cpuMilli: number;
  memoryBytes: number;
  pids: number;
  workloadInventorySha256: string;
  cgroupTreeSha256: string;
  releaseManifestSha256: string;
  resourcePolicySha256: string;
  jobAppArmorMode: "unsupported-not-relied-upon";
  rootlessKitHostAppArmorMode: "required-profile";
  rootlessKitHostAppArmorProfileName: string;
  rootlessKitHostAppArmorProfileSha256: string;
  cgroupV2: true;
  rootlessDocker: true;
  requiredControllers: ["cpu", "memory", "pids"];
  startupReconciled: true;
  unreconciledContainerCount: 0;
};

export type S8SignedLauncherObservation = {
  observation: S8LauncherObservationBody;
  signature: string;
};

export type S8AdmissionEnvelope = {
  capacity: S8SignedCapacityProof;
  launcher: S8SignedLauncherObservation;
};

export type S8AdmissionTrust = {
  capacityAuthorityKeys: Readonly<Record<string, string>>;
  launcherKeys: Readonly<Record<string, string>>;
};

export type S8AdmissionDecision = {
  state: S8AdmissionState;
  reason: "PROOF_MISSING" | "TRUST_KEY_MISSING" | "SIGNATURE_INVALID" | "PROOF_INVALID" | "PROOF_STALE" | "ALLOCATION_INVALID" | "OBSERVATION_INVALID" | "OBSERVATION_STALE" | "REALIZATION_DRIFT" | "CAPACITY_NOT_OPEN" | null;
  proofSha256: string | null;
  observedAt: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 30 * 1000;
const CLOCK_SKEW_MS = 5000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("keys");
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new Error("timestamp");
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("timestamp");
  return result;
}

function verifySignedBody(
  body: Record<string, unknown>,
  signature: unknown,
  publicKeyPem: string,
  domain: string,
): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64) return false;
  return verifySignature(
    null,
    Buffer.concat([Buffer.from(domain + "\0", "ascii"), Buffer.from(jcs(body), "utf8")]),
    publicKeyPem,
    signatureBytes,
  );
}

function parseBudget(value: unknown): S8ResourceBudget {
  const item = record(value);
  exactKeys(item, ["cpuMilli", "memoryBytes", "pids"]);
  if (!positiveInteger(item.cpuMilli) || !positiveInteger(item.memoryBytes) || !positiveInteger(item.pids)) throw new Error("budget");
  return item as unknown as S8ResourceBudget;
}

function equalBudget(actual: S8ResourceBudget, expected: S8ResourceBudget): boolean {
  return actual.cpuMilli === expected.cpuMilli && actual.memoryBytes === expected.memoryBytes && actual.pids === expected.pids;
}

function sumFits(total: S8ResourceBudget, parts: readonly S8ResourceBudget[]): boolean {
  const sum = parts.reduce((result, item) => ({
    cpuMilli: result.cpuMilli + item.cpuMilli,
    memoryBytes: result.memoryBytes + item.memoryBytes,
    pids: result.pids + item.pids,
  }), { cpuMilli: 0, memoryBytes: 0, pids: 0 });
  return Number.isSafeInteger(sum.cpuMilli) && Number.isSafeInteger(sum.memoryBytes) && Number.isSafeInteger(sum.pids)
    && sum.cpuMilli <= total.cpuMilli && sum.memoryBytes <= total.memoryBytes && sum.pids <= total.pids;
}

function assertCapacityProofBody(value: unknown, nowMs: number): S8CapacityProofBody {
  const proof = record(value);
  exactKeys(proof, [
    "schemaVersion", "proofId", "state", "issuedAt", "expiresAt", "signingKeyId", "host", "allocation",
    "oneOperationAtATime", "workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256",
    "resourcePolicySha256", "contentionEvidenceIds", "resourceLimitEvidenceIds",
  ]);
  if (proof.schemaVersion !== "s8-capacity-proof-v1" || !["CLOSED", "PROVING", "OPEN"].includes(String(proof.state))) throw new Error("schema");
  if (typeof proof.proofId !== "string" || !KEY_ID.test(proof.proofId) || typeof proof.signingKeyId !== "string" || !KEY_ID.test(proof.signingKeyId)) throw new Error("identity");
  const issuedAt = timestamp(proof.issuedAt);
  const expiresAt = timestamp(proof.expiresAt);
  const host = record(proof.host);
  exactKeys(host, ["hostId", "cpuMilli", "memoryBytes", "pids", "measuredAt"]);
  if (typeof host.hostId !== "string" || host.hostId.length < 1 || host.hostId.length > 160 || !positiveInteger(host.cpuMilli) || !positiveInteger(host.memoryBytes) || !positiveInteger(host.pids)) throw new Error("host");
  const measuredAt = timestamp(host.measuredAt);
  if (issuedAt > nowMs + CLOCK_SKEW_MS || expiresAt <= nowMs || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_PROOF_AGE_MS || nowMs - measuredAt > MAX_PROOF_AGE_MS || measuredAt > nowMs + CLOCK_SKEW_MS) throw new Error("freshness");
  if (proof.oneOperationAtATime !== true) throw new Error("concurrency");
  for (const key of ["workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256", "resourcePolicySha256"]) if (typeof proof[key] !== "string" || !HEX64.test(proof[key])) throw new Error("digest");
  if (proof.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("policy");
  const contention = proof.contentionEvidenceIds;
  const limits = proof.resourceLimitEvidenceIds;
  if (!Array.isArray(contention) || contention.length === 0 || !Array.isArray(limits) || limits.length === 0) throw new Error("evidence");
  for (const values of [contention, limits]) {
    if (values.length > 100 || values.some((item) => typeof item !== "string" || item.length === 0 || item.length > 160) || new Set(values).size !== values.length) throw new Error("evidence");
  }

  const allocation = record(proof.allocation);
  exactKeys(allocation, ["designAggregate", "designApplication", "gateway", "launcher", "rootlessDocker", "rootlessDockerUid", "systemd", "streaming", "writer", "validator", "nonDesignAggregate", "nonDesignWorkloads", "protectedHostReserve"]);
  if (!Number.isSafeInteger(allocation.rootlessDockerUid) || Number(allocation.rootlessDockerUid) < 1000 || Number(allocation.rootlessDockerUid) > 2147483647) throw new Error("rootless-uid");
  const budgets = {} as Record<Exclude<keyof S8CapacityAllocation, "nonDesignWorkloads">, S8ResourceBudget>;
  for (const key of ["designAggregate", "designApplication", "gateway", "launcher", "rootlessDocker", "systemd", "streaming", "writer", "validator", "nonDesignAggregate", "protectedHostReserve"] as const) budgets[key] = parseBudget(allocation[key]);
  const nonDesign = allocation.nonDesignWorkloads;
  const requiredWorkloads = new Set(["quote", "n8n", "wordpress", "other-siblings", "future-non-design"]);
  if (!Array.isArray(nonDesign) || nonDesign.length < requiredWorkloads.size || nonDesign.length > 128) throw new Error("siblings");
  const seenWorkloads = new Set<string>();
  const siblingBudgets: S8ResourceBudget[] = [];
  let priorWorkloadId = "";
  for (const raw of nonDesign) {
    const item = record(raw);
    exactKeys(item, ["workloadId", "cgroupPath", "budget"]);
    if (typeof item.workloadId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(item.workloadId) || item.workloadId <= priorWorkloadId
      || typeof item.cgroupPath !== "string" || item.cgroupPath !== "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-" + item.workloadId + ".slice") throw new Error("siblings");
    priorWorkloadId = item.workloadId;
    seenWorkloads.add(item.workloadId);
    siblingBudgets.push(parseBudget(item.budget));
  }
  if ([...requiredWorkloads].some((workloadId) => !seenWorkloads.has(workloadId)) || !sumFits(budgets.nonDesignAggregate, siblingBudgets)) throw new Error("siblings");
  if (budgets.streaming.memoryBytes < S8_NATIVE_RESOURCE_POLICY.streaming.minimumMemoryBytes) throw new Error("streaming-budget");
  if (!equalBudget(budgets.writer, S8_NATIVE_RESOURCE_POLICY.writer) || !equalBudget(budgets.validator, S8_NATIVE_RESOURCE_POLICY.validator)) throw new Error("frozen-limits");

  const activeWorker: S8ResourceBudget = {
    cpuMilli: Math.max(budgets.writer.cpuMilli, budgets.validator.cpuMilli),
    memoryBytes: Math.max(budgets.writer.memoryBytes, budgets.validator.memoryBytes),
    pids: Math.max(budgets.writer.pids, budgets.validator.pids),
  };
  if (!sumFits(budgets.rootlessDocker, [activeWorker])
    || budgets.rootlessDocker.cpuMilli <= activeWorker.cpuMilli
    || budgets.rootlessDocker.memoryBytes <= activeWorker.memoryBytes
    || budgets.rootlessDocker.pids <= activeWorker.pids) throw new Error("rootless-runtime-budget");
  if (!sumFits(budgets.designAggregate, [budgets.designApplication, budgets.gateway, budgets.launcher, budgets.rootlessDocker, budgets.systemd, budgets.streaming])) throw new Error("design-total");
  if (!sumFits({ cpuMilli: host.cpuMilli, memoryBytes: host.memoryBytes, pids: host.pids }, [budgets.designAggregate, budgets.nonDesignAggregate, budgets.protectedHostReserve])) throw new Error("host-total");

  return proof as unknown as S8CapacityProofBody;
}

function assertObservationBody(value: unknown, nowMs: number, proof: S8CapacityProofBody, proofSha256: string): S8LauncherObservationBody {
  const observation = record(value);
  exactKeys(observation, [
    "schemaVersion", "proofSha256", "state", "observedAt", "launcherKeyId", "hostId", "cpuMilli", "memoryBytes", "pids",
    "workloadInventorySha256", "cgroupTreeSha256", "releaseManifestSha256", "resourcePolicySha256",
    "jobAppArmorMode", "rootlessKitHostAppArmorMode", "rootlessKitHostAppArmorProfileName", "rootlessKitHostAppArmorProfileSha256",
    "cgroupV2", "rootlessDocker", "requiredControllers", "startupReconciled", "unreconciledContainerCount",
  ]);
  if (observation.schemaVersion !== "s8-launcher-observation-v2" || !["CLOSED", "PROVING", "OPEN"].includes(String(observation.state))) throw new Error("schema");
  if (typeof observation.launcherKeyId !== "string" || !KEY_ID.test(observation.launcherKeyId)) throw new Error("key-id");
  const observedAt = timestamp(observation.observedAt);
  if (observedAt > nowMs + CLOCK_SKEW_MS || nowMs - observedAt > MAX_OBSERVATION_AGE_MS) throw new Error("freshness");
  if (observation.proofSha256 !== proofSha256 || observation.state !== proof.state || observation.hostId !== proof.host.hostId
    || observation.cpuMilli !== proof.host.cpuMilli || observation.memoryBytes !== proof.host.memoryBytes || observation.pids !== proof.host.pids
    || observation.workloadInventorySha256 !== proof.workloadInventorySha256 || observation.cgroupTreeSha256 !== proof.cgroupTreeSha256
    || observation.releaseManifestSha256 !== proof.releaseManifestSha256 || observation.resourcePolicySha256 !== proof.resourcePolicySha256) throw new Error("drift");
  if (observation.cgroupV2 !== true || observation.rootlessDocker !== true || observation.startupReconciled !== true || observation.unreconciledContainerCount !== 0
    || observation.jobAppArmorMode !== "unsupported-not-relied-upon" || observation.rootlessKitHostAppArmorMode !== "required-profile"
    || observation.rootlessKitHostAppArmorProfileName !== "swooshz-s8-rootlesskit-v1"
    || typeof observation.rootlessKitHostAppArmorProfileSha256 !== "string" || !HEX64.test(observation.rootlessKitHostAppArmorProfileSha256)) throw new Error("runtime");
  const controllers = observation.requiredControllers;
  if (!Array.isArray(controllers) || controllers.length !== 3 || controllers[0] !== "cpu" || controllers[1] !== "memory" || controllers[2] !== "pids") throw new Error("controllers");
  return observation as unknown as S8LauncherObservationBody;
}

export function decideS8NativeAdmission(
  envelope: S8AdmissionEnvelope | null | undefined,
  trust: S8AdmissionTrust | undefined,
  nowMs = Date.now(),
): S8AdmissionDecision {
  if (!envelope) return { state: "CLOSED", reason: "PROOF_MISSING", proofSha256: null, observedAt: null };
  if (!trust) return { state: "CLOSED", reason: "TRUST_KEY_MISSING", proofSha256: null, observedAt: null };
  try {
    const capacity = record(envelope.capacity);
    exactKeys(capacity, ["proof", "signature"]);
    const proofRecord = record(capacity.proof);
    const capacityKeyId = proofRecord.signingKeyId;
    if (typeof capacityKeyId !== "string" || !trust.capacityAuthorityKeys[capacityKeyId]) return { state: "CLOSED", reason: "TRUST_KEY_MISSING", proofSha256: null, observedAt: null };
    if (!verifySignedBody(proofRecord, capacity.signature, trust.capacityAuthorityKeys[capacityKeyId]!, "S8-CAPACITY-PROOF-V1")) return { state: "CLOSED", reason: "SIGNATURE_INVALID", proofSha256: null, observedAt: null };
    let proof: S8CapacityProofBody;
    try { proof = assertCapacityProofBody(proofRecord, nowMs); }
    catch (error) {
      const reason = error instanceof Error && error.message === "freshness" ? "PROOF_STALE" : error instanceof Error && ["design-total", "host-total", "frozen-limits", "siblings", "streaming-budget", "rootless-runtime-budget"].includes(error.message) ? "ALLOCATION_INVALID" : "PROOF_INVALID";
      return { state: "CLOSED", reason, proofSha256: null, observedAt: null };
    }
    const proofSha256 = sha256(jcs(envelope.capacity));
    const launcher = record(envelope.launcher);
    exactKeys(launcher, ["observation", "signature"]);
    const observationRecord = record(launcher.observation);
    const launcherKeyId = observationRecord.launcherKeyId;
    if (typeof launcherKeyId !== "string" || !trust.launcherKeys[launcherKeyId]) return { state: "CLOSED", reason: "TRUST_KEY_MISSING", proofSha256, observedAt: null };
    if (!verifySignedBody(observationRecord, launcher.signature, trust.launcherKeys[launcherKeyId]!, "S8-LAUNCHER-OBSERVATION-V2")) return { state: "CLOSED", reason: "SIGNATURE_INVALID", proofSha256, observedAt: null };
    let observation: S8LauncherObservationBody;
    try { observation = assertObservationBody(observationRecord, nowMs, proof, proofSha256); }
    catch (error) {
      const reason = error instanceof Error && error.message === "freshness" ? "OBSERVATION_STALE" : error instanceof Error && error.message === "drift" || error instanceof Error && error.message === "runtime" || error instanceof Error && error.message === "controllers" ? "REALIZATION_DRIFT" : "OBSERVATION_INVALID";
      return { state: "CLOSED", reason, proofSha256, observedAt: null };
    }
    if (proof.state !== "OPEN" || observation.state !== "OPEN") return { state: proof.state, reason: "CAPACITY_NOT_OPEN", proofSha256, observedAt: observation.observedAt };
    return { state: "OPEN", reason: null, proofSha256, observedAt: observation.observedAt };
  } catch {
    return { state: "CLOSED", reason: "PROOF_INVALID", proofSha256: null, observedAt: null };
  }
}

export function requireS8NativeAdmissionOpen(decision: S8AdmissionDecision): void {
  if (decision.state !== "OPEN") {
    throw new AppError(503, "S8_WORKER_ADMISSION_CLOSED", [{ field: "admission", code: "CLOSED" }], {
      reason: decision.reason ?? "CAPACITY_NOT_OPEN",
      proofSha256: decision.proofSha256,
    });
  }
}
