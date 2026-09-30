import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertContainerVolumeAuthority, createArguments, inspectCreatedContainer, removeContainer, startContainer, validateContainerSecurityOptions, workerBudget, workerScopeIsQuiescent } from "./container-runtime.mjs";
import { classifyNativeFailure } from "./operation.mjs";
import { rootlessCgroupPaths } from "./capacity.mjs";
import { assertHostMeasurementRoots } from "./config.mjs";
import { assertEmptyDockerVolumeInventory, assertImageHasNoVolumes, deadlineBoundDocker, dockerVolumeNames, findRootlessKitPid, validateRootlessKitAppArmorEvidence } from "./host-state.mjs";

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

test("absolute deadline bounds Docker calls and rejects a command that completes late", async () => {
  let now = 1000;
  const timeouts = [];
  const docker = deadlineBoundDocker(1010, () => now, async (_config, _args, timeout) => {
    timeouts.push(timeout);
    now = 1008;
    return "inventory";
  });
  assert.equal(await docker(config, ["inspect"], 30000), "inventory");
  assert.deepEqual(timeouts, [10]);

  now = 2000;
  const lateDocker = deadlineBoundDocker(2005, () => now, async (_config, _args, timeout) => {
    timeouts.push(timeout);
    now = 2006;
    return "late";
  });
  await assert.rejects(lateDocker(config, ["inspect"], 30000), /deadline-expired/u);
  assert.equal(timeouts.at(-1), 5);
});

test("pinned worker image configs and daemon inventory reject persistent volumes", () => {
  assert.doesNotThrow(() => assertImageHasNoVolumes(null));
  assert.doesNotThrow(() => assertImageHasNoVolumes({}));
  assert.throws(() => assertImageHasNoVolumes({ "/work": {} }), /image-volume-drift/u);
  assert.throws(() => assertImageHasNoVolumes([]), /image-volume-drift/u);
  assert.deepEqual(dockerVolumeNames("job-volume\n"), ["job-volume"]);
  assert.throws(() => dockerVolumeNames("job-volume\njob-volume\n"), /docker-volume-inventory-invalid/u);
  assert.doesNotThrow(() => assertEmptyDockerVolumeInventory(""));
  assert.doesNotThrow(() => assertEmptyDockerVolumeInventory(" \n\t"));
  assert.throws(() => assertEmptyDockerVolumeInventory("job-volume\n"), /docker-volume-inventory-not-empty/u);
  assert.throws(() => assertEmptyDockerVolumeInventory("invalid/name\n"), /docker-volume-inventory-invalid/u);
});

test("created worker containers reject declared volumes and mounts before start", async () => {
  const containerId = "e".repeat(64);
  const clean = {
    Id: containerId,
    Config: { Volumes: null },
    HostConfig: { Binds: null, Mounts: null, VolumesFrom: null, Tmpfs: { "/work": "rw" } },
    Mounts: [],
  };
  const calls = [];
  const inspected = await inspectCreatedContainer(config, containerId, async (_config, args) => {
    calls.push(args);
    return JSON.stringify([clean]);
  });
  assert.deepEqual(inspected, clean);
  assert.deepEqual(calls, [["inspect", containerId]]);
  assert.doesNotThrow(() => assertContainerVolumeAuthority(clean));
  assert.doesNotThrow(() => assertContainerVolumeAuthority({
    ...clean,
    Mounts: [
      { Type: "tmpfs", Destination: "/work", RW: true },
      { Type: "tmpfs", Destination: "/dev/shm", RW: true },
    ],
  }, { requireMountInventory: true }));

  const rejected = [];
  const imageVolume = structuredClone(clean);
  imageVolume.Config.Volumes = { "/persist": {} };
  rejected.push(imageVolume);
  const bind = structuredClone(clean);
  bind.HostConfig.Binds = ["/host:/persist"];
  rejected.push(bind);
  const hostMount = structuredClone(clean);
  hostMount.HostConfig.Mounts = [{ Type: "bind", Source: "/host", Target: "/persist" }];
  rejected.push(hostMount);
  const volumesFrom = structuredClone(clean);
  volumesFrom.HostConfig.VolumesFrom = ["other"];
  rejected.push(volumesFrom);
  const effectiveVolume = structuredClone(clean);
  effectiveVolume.Mounts = [{ Type: "volume", Name: "anonymous", Destination: "/persist", RW: true }];
  rejected.push(effectiveVolume);
  const effectiveBind = structuredClone(clean);
  effectiveBind.Mounts = [{ Type: "bind", Source: "/host", Destination: "/persist", RW: true }];
  rejected.push(effectiveBind);
  const extraTmpfs = structuredClone(clean);
  extraTmpfs.HostConfig.Tmpfs = { "/work": "rw", "/persist": "rw" };
  rejected.push(extraTmpfs);
  for (const candidate of rejected) {
    assert.throws(() => assertContainerVolumeAuthority(candidate), /container-volume-drift/u);
  }
  assert.throws(() => assertContainerVolumeAuthority(clean, { requireMountInventory: true }), /container-volume-drift/u);
  const imageVolumeInspect = structuredClone(clean);
  imageVolumeInspect.Config.Volumes = { "/persist": {} };
  await assert.rejects(
    inspectCreatedContainer(config, containerId, async () => JSON.stringify([imageVolumeInspect])),
    /container-volume-drift/u,
  );
  assert.throws(() => assertContainerVolumeAuthority({ ...clean, Config: {} }), /container-volume-drift/u);
});

test("writer and validator Dockerfiles do not declare persistent volumes", () => {
  for (const path of ["../s8-worker-images/writer/Dockerfile", "../s8-worker-images/validator/Dockerfile"]) {
    const dockerfile = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(dockerfile, /^\s*VOLUME\s/im);
  }
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


function fakeAttachedChild(closeOnRelease = true) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (!child.killed) {
      child.killed = true;
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, "SIGKILL");
      }, 20);
    }
    return true;
  };
  if (closeOnRelease) {
    child.stdin.on("finish", () => setTimeout(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    }, 5));
  }
  return child;
}

function fakeSynchronousKillChild() {
  const child = fakeAttachedChild(false);
  child.kill = () => {
    if (!child.killed) {
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, "SIGKILL");
    }
    return true;
  };
  return child;
}

test("attached Docker process is waited through close after normal release and forced termination", async () => {
  const spawnProcess = () => {
    const child = fakeAttachedChild();
    setImmediate(() => child.stdout.write(Buffer.from("S8_READY\n", "ascii")));
    return child;
  };
  const running = await startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock", workerReapTimeoutMs: 100 }, "c".repeat(64), Buffer.from("input"), "WRITER", spawnProcess, Date.now() + 5000);
  await running.release();
  const closed = await running.close(Date.now() + 1000);
  assert.equal(closed.code, 0);

  let killedChild;
  const forced = await startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock", workerReapTimeoutMs: 100 }, "c".repeat(64), Buffer.from("input"), "WRITER", () => {
    killedChild = fakeAttachedChild(false);
    setImmediate(() => killedChild.stdout.write(Buffer.from("S8_READY\n", "ascii")));
    return killedChild;
  }, Date.now() + 5000);
  const startedAt = Date.now();
  const result = await forced.abort();
  assert.equal(result.signal, "SIGKILL");
  assert.equal(killedChild.killed, true);
  assert.ok(Date.now() - startedAt >= 10);
});

test("payload transfer is cut off at the absolute deadline and the attached process is killed", async () => {
  let now = 1000;
  let child;
  let writes = 0;
  const operation = startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock" }, "c".repeat(64), Buffer.from("payload"), "WRITER", () => {
    child = fakeSynchronousKillChild();
    child.stdin.write = () => {
      writes += 1;
      if (writes === 2) setImmediate(() => { now = 2001; child.stdin.emit("drain"); });
      return writes !== 2;
    };
    return child;
  }, 2000, () => now);
  await assert.rejects(operation, /deadline-expired/u);
  assert.equal(writes, 2);
  assert.equal(child.killed, true);
});

test("readiness and release waits consume the same absolute deadline", async () => {
  let now = 3000;
  let readyChild;
  const readiness = startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock" }, "c".repeat(64), Buffer.from("payload"), "WRITER", () => {
    readyChild = fakeSynchronousKillChild();
    setImmediate(() => { now = 4001; readyChild.stdout.write(Buffer.from("S8_READY\n", "ascii")); });
    return readyChild;
  }, 4000, () => now);
  await assert.rejects(readiness, /deadline-expired/u);
  assert.equal(readyChild.killed, true);

  now = 5000;
  let releaseChild;
  let writes = 0;
  const running = await startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock" }, "c".repeat(64), Buffer.from("payload"), "WRITER", () => {
    releaseChild = fakeSynchronousKillChild();
    releaseChild.stdin.write = () => { writes += 1; return true; };
    setImmediate(() => releaseChild.stdout.write(Buffer.from("S8_READY\n", "ascii")));
    return releaseChild;
  }, 6000, () => now);
  releaseChild.stdin.write = () => {
    writes += 1;
    setImmediate(() => { now = 6001; releaseChild.stdin.emit("drain"); });
    return false;
  };
  await assert.rejects(running.release(), /deadline-expired/u);
  assert.equal(releaseChild.killed, true);
});

test("native close observed after the absolute deadline cannot be accepted", async () => {
  let now = 7000;
  let child;
  let writes = 0;
  const running = await startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock" }, "c".repeat(64), Buffer.from("payload"), "WRITER", () => {
    child = fakeAttachedChild(false);
    child.stdin.write = () => { writes += 1; return true; };
    setImmediate(() => child.stdout.write(Buffer.from("S8_READY\n", "ascii")));
    return child;
  }, 8000, () => now);
  await running.release();
  setImmediate(() => {
    now = 8001;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  await assert.rejects(running.close(), /deadline-expired/u);
  assert.ok(child.killed === false);
});

test("container disposal verification cannot continue after the absolute deadline", async () => {
  let now = 9000;
  const docker = deadlineBoundDocker(9010, () => now, async (_config, args, timeout) => {
    assert.equal(args[0], "rm");
    assert.equal(timeout, 10);
    now = 9010;
    return "";
  });
  await assert.rejects(removeContainer(config, "d".repeat(64), 12001, docker), /deadline-expired/u);
});

test("an attached process without a close event remains disposal-unknown", async () => {
  const running = await startContainer({ ...config, dockerSocket: "/run/swooshz-s8/docker.sock", workerReapTimeoutMs: 5 }, "c".repeat(64), Buffer.from("input"), "WRITER", () => {
    const child = fakeAttachedChild(false);
    child.kill = () => true;
    setImmediate(() => child.stdout.write(Buffer.from("S8_READY\n", "ascii")));
    return child;
  }, Date.now() + 5000);
  await assert.rejects(running.abort(), (error) => error.disposalUnproven === true);
});

test("missing Docker record is insufficient while its worker cgroup is populated", async () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-disposal-"));
  const containerId = "d".repeat(64);
  const uid = 12001;
  const logicalWorkers = rootlessCgroupPaths(uid).workers;
  const scope = join(root, ...logicalWorkers.split("/").filter(Boolean), "docker-" + containerId + ".scope");
  const scopedConfig = { ...config, cgroupRoot: root };
  const docker = async (_config, args) => args[0] === "ps" ? "" : "";
  try {
    assert.equal(workerScopeIsQuiescent(scopedConfig, containerId, uid), true);
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, "cgroup.events"), "populated 1\nfrozen 0\n");
    writeFileSync(join(scope, "cgroup.procs"), "123\n");
    assert.equal(await removeContainer(scopedConfig, containerId, uid, docker), false);
    assert.equal(workerScopeIsQuiescent(scopedConfig, containerId, uid), false);
    writeFileSync(join(scope, "cgroup.events"), "populated 0\nfrozen 0\n");
    writeFileSync(join(scope, "cgroup.procs"), "");
    assert.equal(await removeContainer(scopedConfig, containerId, uid, docker), true);
    mkdirSync(join(scope, "child"));
    assert.equal(workerScopeIsQuiescent(scopedConfig, containerId, uid), false);
    assert.equal(await removeContainer(scopedConfig, containerId, uid, async (_config, args) => args[0] === "ps" ? containerId : ""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("container removal removes and verifies anonymous volume cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-volume-removal-"));
  const containerId = "f".repeat(64);
  let volumePresent = true;
  let removedWithVolumes = false;
  const calls = [];
  const docker = async (_config, args) => {
    calls.push(args);
    if (args[0] === "rm") {
      removedWithVolumes = args.includes("--volumes");
      volumePresent = false;
      return "";
    }
    if (args[0] === "ps") return "";
    if (args[0] === "volume") { assert.deepEqual(args, ["volume", "ls", "--quiet"]); return volumePresent ? "job-anonymous-volume\n" : ""; }
    return "";
  };
  try {
    assert.equal(await removeContainer({ ...config, cgroupRoot: root }, containerId, 12001, docker), true);
    assert.equal(removedWithVolumes, true);
    assert.deepEqual(calls.filter((args) => args[0] === "volume" && args[1] === "ls"), [["volume", "ls", "--quiet"], ["volume", "ls", "--quiet"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphan job volume is removed by exact name while the baseline volume is preserved", async () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-orphan-cleanup-"));
  const containerId = "b".repeat(64);
  const baseline = ["preserved-volume"];
  let volumes = [...baseline, "job-anonymous-volume"];
  const removedVolumes = [];
  const docker = async (_config, args) => {
    if (args[0] === "rm") return "";
    if (args[0] === "ps") return "";
    if (args[0] === "volume" && args[1] === "ls") { assert.deepEqual(args, ["volume", "ls", "--quiet"]); return volumes.join("\n") + "\n"; }
    if (args[0] === "volume" && args[1] === "rm") {
      removedVolumes.push(args[2]);
      volumes = volumes.filter((name) => name !== args[2]);
      return args[2];
    }
    return "";
  };
  try {
    assert.equal(await removeContainer({ ...config, cgroupRoot: root }, containerId, 12001, docker, baseline), true);
    assert.deepEqual(removedVolumes, ["job-anonymous-volume"]);
    assert.deepEqual(volumes, baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a missing container record does not prove that anonymous volumes were removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-orphan-volume-"));
  const containerId = "a".repeat(64);
  let removedWithVolumes = false;
  let attemptedVolumeRemoval = false;
  const docker = async (_config, args) => {
    if (args[0] === "rm") {
      removedWithVolumes = args.includes("--volumes");
      return "";
    }
    if (args[0] === "ps") return "";
    if (args[0] === "volume" && args[1] === "rm") {
      attemptedVolumeRemoval = args[2] === "orphan-anonymous-volume";
      throw new Error("volume-removal-failed");
    }
    if (args[0] === "volume") { assert.deepEqual(args, ["volume", "ls", "--quiet"]); return "orphan-anonymous-volume\n"; }
    return "";
  };
  try {
    await assert.rejects(
      removeContainer({ ...config, cgroupRoot: root }, containerId, 12001, docker),
      /docker-volume-removal-unproven/u,
    );
    assert.equal(removedWithVolumes, true);
    assert.equal(attemptedVolumeRemoval, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("launcher host measurements cannot be redirected to a fabricated proc, sys, etc, or cgroup tree", () => {
  assert.deepEqual(assertHostMeasurementRoots({ S8_CGROUP_ROOT: "/sys/fs/cgroup" }), {
    cgroupRoot: "/sys/fs/cgroup",
    procRoot: "/proc",
    sysRoot: "/sys",
    etcRoot: "/etc",
  });
  for (const [name, expected] of [["S8_CGROUP_ROOT", "/sys/fs/cgroup"], ["S8_PROC_ROOT", "/proc"], ["S8_SYS_ROOT", "/sys"], ["S8_ETC_ROOT", "/etc"]]) {
    const environment = { S8_CGROUP_ROOT: "/sys/fs/cgroup" };
    environment[name] = expected === "/sys/fs/cgroup" ? "/tmp/fake-cgroup" : "/tmp/fake-host";
    assert.throws(() => assertHostMeasurementRoots(environment), /host-measurement-root-invalid/u);
  }
});
test("attached worker EPIPE is reaped and remains nonretryable", async () => {
  const child = fakeSynchronousKillChild();
  const error = Object.assign(new Error("attached worker pipe closed"), { code: "EPIPE" });
  child.stdin.write = () => { throw error; };
  let spawnCount = 0;
  let observed;
  await assert.rejects(
    startContainer(
      { ...config, dockerSocket: "/run/swooshz-s8/docker.sock", workerReapTimeoutMs: 100 },
      "c".repeat(64),
      Buffer.from("input"),
      "WRITER",
      () => { spawnCount += 1; return child; },
      Date.now() + 5000,
    ),
    (caught) => { observed = caught; return caught === error; },
  );
  assert.equal(spawnCount, 1);
  assert.equal(child.killed, true);
  assert.equal(classifyNativeFailure(observed), "PERMANENT");
});

test("attached process EAGAIN remains nonretryable and does not spawn twice", async () => {
  const error = Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
  let spawnCount = 0;
  let observed;
  await assert.rejects(
    startContainer(
      { ...config, dockerSocket: "/run/swooshz-s8/docker.sock" },
      "c".repeat(64),
      Buffer.from("input"),
      "WRITER",
      () => { spawnCount += 1; throw error; },
      Date.now() + 5000,
    ),
    (caught) => { observed = caught; return caught === error; },
  );
  assert.equal(spawnCount, 1);
  assert.equal(classifyNativeFailure(observed), "PERMANENT");
});

test("readiness phase timeout is reaped and remains nonretryable", async () => {
  let child;
  let spawnCount = 0;
  let observed;
  await assert.rejects(
    startContainer(
      { ...config, dockerSocket: "/run/swooshz-s8/docker.sock", workerReadyTimeoutMs: 5, workerReapTimeoutMs: 100 },
      "c".repeat(64),
      Buffer.from("input"),
      "WRITER",
      () => { spawnCount += 1; child = fakeSynchronousKillChild(); return child; },
      Date.now() + 5000,
    ),
    (error) => { observed = error; return error.message === "worker-ready-timeout"; },
  );
  assert.equal(spawnCount, 1);
  assert.equal(child.killed, true);
  assert.equal(classifyNativeFailure(observed), "PERMANENT");
});
