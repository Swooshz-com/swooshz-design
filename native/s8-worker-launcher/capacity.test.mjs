import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProcessCgroup, processUid, readUnifiedCgroupPath, validateDockerRuntimeInfo } from "./host-state.mjs";
import { expectedCgroupBudgets, measurePhysicalHost, rootlessCgroupPaths, snapshotCgroupTree } from "./capacity.mjs";

const gib = 1024 ** 3;
const mb = 1024 ** 2;

function sampleProof() {
  return {
    cgroupTreeSha256: "a".repeat(64),
    allocation: {
      designAggregate: { cpuMilli: 4000, memoryBytes: 12 * gib, pids: 800 },
      designApplication: { cpuMilli: 300, memoryBytes: gib, pids: 100 },
      gateway: { cpuMilli: 100, memoryBytes: 256 * mb, pids: 64 },
      launcher: { cpuMilli: 100, memoryBytes: 256 * mb, pids: 64 },
      rootlessDocker: { cpuMilli: 2200, memoryBytes: 4 * gib + 512 * mb, pids: 96 },
      rootlessDockerUid: 12001,
      systemd: { cpuMilli: 100, memoryBytes: 256 * mb, pids: 64 },
      streaming: { cpuMilli: 1000, memoryBytes: 2 * gib, pids: 100 },
      writer: { cpuMilli: 2000, memoryBytes: 4 * gib, pids: 80 },
      validator: { cpuMilli: 1000, memoryBytes: 1536 * mb, pids: 32 },
      nonDesignAggregate: { cpuMilli: 1000, memoryBytes: 5 * gib, pids: 500 },
      nonDesignWorkloads: [
        { workloadId: "future-non-design", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-future-non-design.slice", budget: { cpuMilli: 100, memoryBytes: gib, pids: 100 } },
        { workloadId: "n8n", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-n8n.slice", budget: { cpuMilli: 200, memoryBytes: gib, pids: 100 } },
        { workloadId: "other-siblings", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-other-siblings.slice", budget: { cpuMilli: 200, memoryBytes: gib, pids: 100 } },
        { workloadId: "quote", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-quote.slice", budget: { cpuMilli: 200, memoryBytes: gib, pids: 100 } },
        { workloadId: "wordpress", cgroupPath: "/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-wordpress.slice", budget: { cpuMilli: 200, memoryBytes: gib, pids: 100 } },
      ],
      protectedHostReserve: { cpuMilli: 1000, memoryBytes: 5 * gib, pids: 1000 },
    },
  };
}

function installCgroupFixture(root, proof) {
  const entries = expectedCgroupBudgets(proof);
  for (const { logicalPath, budget } of entries) {
    const directory = join(root, logicalPath.slice(1));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cpu.max"), `${budget.cpuMilli * 100} 100000\n`);
    writeFileSync(join(directory, "memory.max"), `${budget.memoryBytes}\n`);
    writeFileSync(join(directory, "pids.max"), `${budget.pids}\n`);
    writeFileSync(join(directory, "cgroup.controllers"), "cpu memory pids\n");
  }
  for (const logicalPath of [
    "/swooshz.slice",
    "/swooshz.slice/swooshz-design.slice",
    rootlessCgroupPaths(proof.allocation.rootlessDockerUid).rootlessDocker,
    rootlessCgroupPaths(proof.allocation.rootlessDockerUid).userManager,
    rootlessCgroupPaths(proof.allocation.rootlessDockerUid).app,
    rootlessCgroupPaths(proof.allocation.rootlessDockerUid).workers,
    "/swooshz.slice/swooshz-non-design.slice",
  ]) {
    writeFileSync(join(root, logicalPath.slice(1), "cgroup.subtree_control"), "cpu memory pids\n");
  }
}

test("streaming reserve is enforced as 30/30/40 across app, gateway, and launcher", () => {
  const proof = sampleProof();
  const groups = new Map(expectedCgroupBudgets(proof).map((entry) => [entry.logicalPath, entry.budget]));
  const design = "/swooshz.slice/swooshz-design.slice/";
  assert.deepEqual(groups.get(design + "swooshz-design-application.slice"), { cpuMilli: 600, memoryBytes: gib + Math.floor(2 * gib * 0.3), pids: 130 });
  assert.deepEqual(groups.get(design + "swooshz-design-gateway.slice"), { cpuMilli: 400, memoryBytes: 256 * mb + Math.floor(2 * gib * 0.3), pids: 94 });
  assert.deepEqual(groups.get(design + "swooshz-design-launcher.slice"), { cpuMilli: 500, memoryBytes: 256 * mb + 2 * gib - 2 * Math.floor(2 * gib * 0.3), pids: 104 });
  assert.equal(groups.get(rootlessCgroupPaths(proof.allocation.rootlessDockerUid).workers).cpuMilli, 2000);
});



test("rootless Docker cgroups use an isolated systemd user manager and reject invalid UIDs", () => {
  const paths = rootlessCgroupPaths(12001);
  assert.equal(paths.userManager, "/swooshz.slice/swooshz-design.slice/swooshz-design-rootless-docker.slice/user@12001.service");
  assert.equal(paths.daemon, paths.app + "/swooshz-s8-rootless-docker.service");
  assert.equal(paths.workers, paths.userManager + "/swooshz-s8-workers.slice");
  assert.throws(() => rootlessCgroupPaths(0), /rootless-uid/u);
});

test("physical host measurement uses online CPUs, MemTotal, and pid_max", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-host-measure-"));
  try {
    const proc = join(root, "proc");
    const sys = join(root, "sys");
    const etc = join(root, "etc");
    mkdirSync(join(proc, "sys/kernel"), { recursive: true });
    mkdirSync(join(sys, "devices/system/cpu"), { recursive: true });
    mkdirSync(etc, { recursive: true });
    writeFileSync(join(proc, "meminfo"), "MemTotal: 8192 kB\nMemAvailable: 1 kB\n");
    writeFileSync(join(proc, "sys/kernel/pid_max"), "4194304\n");
    writeFileSync(join(sys, "devices/system/cpu/online"), "0-1\n");
    writeFileSync(join(etc, "machine-id"), "0123456789abcdef0123456789abcdef\n");
    const first = measurePhysicalHost({ procRoot: proc, sysRoot: sys, etcRoot: etc });
    writeFileSync(join(proc, "meminfo"), "MemTotal: 8192 kB\nMemAvailable: 8000000 kB\n");
    const second = measurePhysicalHost({ procRoot: proc, sysRoot: sys, etcRoot: etc });
    assert.equal(first.cpuMilli, 2000);
    assert.equal(first.memoryBytes, 8192 * 1024);
    assert.equal(first.pids, 4194304);
    assert.equal(first.hostId, second.hostId);
    assert.equal(first.memoryBytes, second.memoryBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live cgroup snapshot binds finite ceilings and rejects an unexpected sibling cgroup", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-cgroup-tree-"));
  try {
    const proof = sampleProof();
    installCgroupFixture(root, proof);
    const first = snapshotCgroupTree(root, proof);
    assert.match(first.sha256, /^[0-9a-f]{64}$/u);
    mkdirSync(join(root, "swooshz.slice/swooshz-non-design/swooshz-non-design-uninventoried.slice"), { recursive: true });
    assert.throws(() => snapshotCgroupTree(root, proof), /cgroup-inventory-drift/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker rootless admission requires cgroup-v2 systemd plus rootless, seccomp, and AppArmor readback", () => {
  const valid = JSON.stringify(["name=rootless", "name=seccomp,profile=builtin", "name=apparmor"]) + "|2|systemd";
  assert.doesNotThrow(() => validateDockerRuntimeInfo(valid));
  assert.throws(() => validateDockerRuntimeInfo(valid.replace("|systemd", "|cgroupfs")), /runtime-drift/u);
  assert.throws(() => validateDockerRuntimeInfo(JSON.stringify(["name=rootless", "name=seccomp"]) + "|2|systemd"), /runtime-drift/u);
});

test("rootless processes must run with an unmodified dedicated UID", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-process-uid-"));
  try {
    mkdirSync(join(root, "123"), { recursive: true });
    writeFileSync(join(root, "123/status"), "Name:\tdockerd\nUid:\t12001\t12001\t12001\t12001\n");
    assert.equal(processUid(root, 123), 12001);
    writeFileSync(join(root, "123/status"), "Uid:\t12001\t0\t12001\t12001\n");
    assert.throws(() => processUid(root, 123), /process-uid-drift/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher and rootless Docker processes must remain inside their allocated cgroups", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-process-cgroup-"));
  try {
    mkdirSync(join(root, "123"), { recursive: true });
    writeFileSync(join(root, "123/cgroup"), "0::/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice/swooshz-s8-worker-launcher.service\n");
    assert.equal(assertProcessCgroup(root, 123, "/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice"), "/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice/swooshz-s8-worker-launcher.service");
    assert.throws(() => assertProcessCgroup(root, 123, "/swooshz.slice/swooshz-design.slice/swooshz-design-rootless-docker.slice"), /process-cgroup-drift/u);
    assert.equal(readUnifiedCgroupPath(root, "123"), "/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice/swooshz-s8-worker-launcher.service");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
