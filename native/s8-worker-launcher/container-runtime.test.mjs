import assert from "node:assert/strict";
import test from "node:test";
import { createArguments, workerBudget } from "./container-runtime.mjs";

const workerCgroupParent = "swooshz-s8-workers.slice";
const config = {
  writerRepository: "registry.invalid/s8-writer",
  validatorRepository: "registry.invalid/s8-validator",
  seccompPolicyFile: "/etc/swooshz/s8-worker-seccomp.json",
  appArmorProfileName: "swooshz-s8-worker-v1",
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
