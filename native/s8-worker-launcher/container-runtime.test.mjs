import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArguments, validateContainerSecurityOptions, workerBudget } from "./container-runtime.mjs";
import { findRootlessKitPid, validateRootlessKitAppArmorEvidence } from "./host-state.mjs";

const workerCgroupParent = "swooshz-s8-workers.slice";
const config = {
  writerRepository: "registry.invalid/s8-writer",
  validatorRepository: "registry.invalid/s8-validator",
  seccompPolicyFile: "/etc/swooshz/s8-worker-seccomp.json",
  workerCgroupParentUnit: workerCgroupParent,
};
const capacity = {
  proof: {
    allocation: {
      rootlessDockerUid: 12001,
      writer: { cpuMilli: 2000, memoryBytes: 4 * 1024 ** 3, pids: 80 },
      validator: { cpuMilli: 1000, memoryBytes: 1536 * 1024 ** 2, pids: 32 },
    },
  },
};
const release = {
  manifest: {
    writer: { imageDigest: "sha256:" + "a".repeat(64) },
    validator: { imageDigest: "sha256:" + "b".repeat(64) },
  },
};

test("rootless worker container arguments are fixed, digest-pinned, and have no mount/device escape", () => {
  const budget = workerBudget(capacity.proof, "WRITER");
  const args = createArguments(config, capacity, release, "WRITER", "c".repeat(64));
  const joined = args.join("\n");
  assert.equal(args[0], "create");
  assert.ok(args.includes("--pull=never"));
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--user=65532:65532"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.includes("--security-opt=seccomp=/etc/swooshz/s8-worker-seccomp.json"));
  assert.equal(joined.toLowerCase().includes("apparmor"), false);
  assert.ok(args.includes("--cpu-period=100000"));
  assert.ok(args.includes("--cpu-quota=200000"));
  assert.ok(args.includes("--memory=" + (4 * 1024 ** 3)));
  assert.ok(args.includes("--memory-swap=" + (4 * 1024 ** 3)));
  assert.ok(args.includes("--pids-limit=80"));
  assert.ok(args.includes("--cgroup-parent=" + workerCgroupParent));
  assert.equal(budget.memoryBytes, 4 * 1024 ** 3);
  for (const forbidden of ["--mount", "--volume", "-v", "--device", "--privileged", "--cap-add"]) assert.equal(args.includes(forbidden), false);
  assert.match(args.at(-1), /^registry\.invalid\/s8-writer@sha256:[0-9a-f]{64}$/u);
  assert.equal(joined.includes("/var/run/docker.sock"), false);
});

test("per-job AppArmor is unsupported and not required; seccomp and no-new-privileges stay mandatory", () => {
  const valid = ["no-new-privileges:true", "seccomp=" + config.seccompPolicyFile];
  assert.doesNotThrow(() => validateContainerSecurityOptions(valid, config));
  assert.throws(() => validateContainerSecurityOptions(["no-new-privileges:true"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions(["seccomp=" + config.seccompPolicyFile], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions(["no-new-privileges:true", "seccomp=unconfined"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions(["no-new-privileges:true"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions(["no-new-privileges:true", "seccomp=unconfined"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions([...valid, "apparmor=unconfined"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions([...valid, "seccomp=unconfined"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions([...valid, "label=disable"], config), /container-security-drift/u);
  assert.throws(() => validateContainerSecurityOptions([...valid, valid[1]], config), /container-security-drift/u);
});

test("RootlessKit host AppArmor profile identity is required and read back independently", () => {
  const profileBytes = Buffer.from("profile contents");
  const profileSha256 = createHash("sha256").update(profileBytes).digest("hex");
  const manifest = { sandbox: {
    jobAppArmorMode: "unsupported-not-relied-upon",
    rootlessKitHostAppArmor: { mode: "required-profile", profileName: "swooshz-s8-rootlesskit-v1", profileSha256 },
  } };
  const evidence = {
    profileBytes,
    enabled: "Y",
    loadedProfiles: "swooshz-s8-rootlesskit-v1 (enforce)\n",
    processProfile: "swooshz-s8-rootlesskit-v1 (enforce)\n",
  };
  assert.deepEqual(validateRootlessKitAppArmorEvidence(manifest, evidence), {
    jobAppArmorMode: "unsupported-not-relied-upon",
    rootlessKitHostAppArmorMode: "required-profile",
    rootlessKitHostAppArmorProfileName: "swooshz-s8-rootlesskit-v1",
    rootlessKitHostAppArmorProfileSha256: profileSha256,
  });
  assert.throws(() => validateRootlessKitAppArmorEvidence(manifest, { ...evidence, enabled: "N" }), /apparmor-unavailable/u);
  assert.throws(() => validateRootlessKitAppArmorEvidence(manifest, { ...evidence, processProfile: "unconfined" }), /rootlesskit-apparmor-drift/u);
  assert.throws(() => validateRootlessKitAppArmorEvidence(manifest, { ...evidence, loadedProfiles: "swooshz-s8-rootlesskit-v1 (complain)" }), /rootlesskit-apparmor-not-loaded/u);
  assert.throws(() => validateRootlessKitAppArmorEvidence(manifest, { ...evidence, profileBytes: Buffer.from("changed") }), /rootlesskit-apparmor-profile-drift/u);
  const wrongJobMode = structuredClone(manifest);
  wrongJobMode.sandbox.jobAppArmorMode = "required-profile";
  assert.throws(() => validateRootlessKitAppArmorEvidence(wrongJobMode, evidence), /rootlesskit-apparmor-profile-drift/u);
});

test("launcher locates exactly one RootlessKit process in the dedicated daemon cgroup and UID", () => {
  const procRoot = mkdtempSync(join(tmpdir(), "s8-rootlesskit-proc-"));
  try {
    const processDirectory = join(procRoot, "123");
    mkdirSync(processDirectory);
    writeFileSync(join(processDirectory, "comm"), "rootlesskit\n");
    writeFileSync(join(processDirectory, "status"), "Name:\trootlesskit\nUid:\t12001\t12001\t12001\t12001\n");
    writeFileSync(join(processDirectory, "cgroup"), "0::/swooshz.slice/rootless-daemon\n");
    assert.equal(findRootlessKitPid(procRoot, "/swooshz.slice/rootless-daemon", 12001), 123);
    writeFileSync(join(processDirectory, "cgroup"), "0::/outside.slice/rootlesskit\n");
    assert.throws(() => findRootlessKitPid(procRoot, "/swooshz.slice/rootless-daemon", 12001), /rootlesskit-process-inventory-drift/u);
    writeFileSync(join(processDirectory, "cgroup"), "0::/swooshz.slice/rootless-daemon\n");
    writeFileSync(join(processDirectory, "status"), "Name:\trootlesskit\nUid:\t12002\t12002\t12002\t12002\n");
    assert.throws(() => findRootlessKitPid(procRoot, "/swooshz.slice/rootless-daemon", 12001), /rootlesskit-process-uid-drift/u);
  } finally {
    rmSync(procRoot, { recursive: true, force: true });
  }
});
