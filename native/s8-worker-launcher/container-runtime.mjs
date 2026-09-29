import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { S8_NATIVE_RESOURCE_POLICY } from "../s8-worker-common/resource-policy.mjs";
import { rootlessCgroupPaths } from "./capacity.mjs";
import { deadlineRemainingMs, dockerVolumeNames, runDocker, imageReference } from "./host-state.mjs";

const READY = Buffer.from("S8_READY\n", "ascii");

export function workerBudget(proof, operation) {
  return operation === "WRITER" ? proof.allocation.writer : proof.allocation.validator;
}

export function createArguments(config, capacity, release, operation, requestSha256) {
  const budget = workerBudget(capacity.proof, operation);
  const limits = operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer : S8_NATIVE_RESOURCE_POLICY.validator;
  return [
    "create", "--pull=never", "--interactive", "--read-only", "--user=65532:65532",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--security-opt=seccomp=" + config.seccompPolicyFile,
    "--network=none", "--cpu-period=100000", "--cpu-quota=" + (budget.cpuMilli * 100),
    `--memory=${budget.memoryBytes}`, `--memory-swap=${budget.memoryBytes}`, `--pids-limit=${budget.pids}`,
    `--tmpfs=/work:rw,noexec,nosuid,nodev,size=${limits.tmpBytes},uid=65532,gid=65532,mode=700`,
    "--cgroup-parent=" + config.workerCgroupParentUnit, "--log-driver=none", "--restart=no",
    "--env", `S8_OPERATION=${operation}`,
    "--label", "s8.owner=swooshz-s8-launcher", "--label", `s8.operation=${operation}`,
    "--label", `s8.request=${requestSha256}`, imageReference(config, release.manifest, operation),
  ];
}

function captureProcess(child, maxStdout, now) {
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrHash = null;
  let overflow = false;
  let ready = false;
  let readyPrefix = Buffer.alloc(0);
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolvePromise, reject) => { resolveReady = resolvePromise; rejectReady = reject; });
  readyPromise.catch(() => {});
  let closedResult = null;
  const closePromise = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => {
      closedResult = { code, signal, overflow, stdout: Buffer.concat(stdout, stdoutBytes), stderrBytes, closedAtMs: now() };
      resolvePromise(closedResult);
    });
  });
  closePromise.catch(() => {});
  child.stdout.on("data", (chunk) => {
    if (!ready) {
      readyPrefix = Buffer.concat([readyPrefix, chunk]);
      if (readyPrefix.length > READY.length || !READY.subarray(0, Math.min(readyPrefix.length, READY.length)).equals(readyPrefix.subarray(0, Math.min(readyPrefix.length, READY.length)))) {
        rejectReady(new Error("worker-ready-invalid"));
        child.kill("SIGKILL");
      } else if (readyPrefix.length === READY.length) {
        ready = true;
        resolveReady();
      }
      return;
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdout) { overflow = true; child.kill("SIGKILL"); return; }
    stdout.push(chunk);
  });
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) { overflow = true; child.kill("SIGKILL"); return; }
    stderrChunks.push(chunk);
  });
  child.once("error", (error) => rejectReady(error));
  child.once("close", (code) => { if (!ready) rejectReady(new Error(code === 0 ? "worker-exited-before-ready" : "worker-exited-before-ready")); });
  return { readyPromise, closePromise, child, get closedResult() { return closedResult; }, set closedResult(value) { closedResult = value; } };
}

function disposalUnproven() {
  const error = new Error("worker-process-disposal-unproven");
  error.disposalUnproven = true;
  return error;
}

function waitForClose(capture, timeoutMs) {
  let timer;
  return Promise.race([
    capture.closePromise,
    new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitBeforeDeadline(promise, deadlineUnixMs, now, timeoutError, phaseLimitMs = Infinity) {
  const remaining = deadlineRemainingMs(deadlineUnixMs, now);
  const timeoutMs = Math.min(remaining, phaseLimitMs);
  let timer;
  try {
    const value = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMs === remaining ? "deadline-expired" : timeoutError)), timeoutMs);
      }),
    ]);
    deadlineRemainingMs(deadlineUnixMs, now);
    return value;
  } finally { clearTimeout(timer); }
}

function remainingCleanupMs(deadlineUnixMs, now) {
  const remaining = deadlineUnixMs - now();
  return Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
}

async function terminateWithinDeadline(capture, maximumMs, deadlineUnixMs, now) {
  return terminateAndReap(capture, Math.min(maximumMs, remainingCleanupMs(deadlineUnixMs, now)));
}

async function terminateAndReap(capture, timeoutMs) {
  if (capture.closedResult) return capture.closedResult;
  try { capture.child.kill("SIGKILL"); } catch { /* close event below is the reaping evidence */ }
  const result = await waitForClose(capture, timeoutMs);
  if (!result) throw disposalUnproven();
  capture.closedResult = result;
  return result;
}

async function writeWithBackpressure(stream, bytes, deadlineUnixMs, now) {
  deadlineRemainingMs(deadlineUnixMs, now);
  if (stream.destroyed) throw new Error("worker-stdin-closed");
  if (!stream.write(bytes)) {
    await waitBeforeDeadline(new Promise((resolvePromise, reject) => {
      stream.once("drain", resolvePromise);
      stream.once("error", reject);
    }), deadlineUnixMs, now, "worker-input-timeout");
  }
  deadlineRemainingMs(deadlineUnixMs, now);
}

export async function startContainer(config, containerId, payload, operation, spawnProcess = spawn, deadlineUnixMs, now = Date.now) {
  deadlineRemainingMs(deadlineUnixMs, now);
  const maximum = operation === "WRITER" ? 128 * 1024 * 1024 + 1024 * 1024 + 64 * 1024 + 20 : 8 * 1024 * 1024 + 64 * 1024 + 20;
  const child = spawnProcess(config.dockerPath, ["--host", "unix://" + config.dockerSocket, "start", "--attach", "--interactive", containerId], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", DOCKER_HOST: "unix://" + config.dockerSocket },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const capture = captureProcess(child, maximum, now);
  const lengthHeader = Buffer.alloc(8);
  lengthHeader.writeBigUInt64BE(BigInt(payload.length), 0);
  try {
    deadlineRemainingMs(deadlineUnixMs, now);
    await writeWithBackpressure(child.stdin, lengthHeader, deadlineUnixMs, now);
    await writeWithBackpressure(child.stdin, payload, deadlineUnixMs, now);
    await waitBeforeDeadline(capture.readyPromise, deadlineUnixMs, now, "worker-ready-timeout", config.workerReadyTimeoutMs ?? 10000);
  } catch (error) {
    try { await terminateWithinDeadline(capture, config.workerReapTimeoutMs ?? 5000, deadlineUnixMs, now); }
    catch { throw disposalUnproven(); }
    throw error;
  }
  deadlineRemainingMs(deadlineUnixMs, now);
  return {
    release: async () => {
      try {
        await writeWithBackpressure(child.stdin, Buffer.from("R", "ascii"), deadlineUnixMs, now);
        child.stdin.end();
        deadlineRemainingMs(deadlineUnixMs, now);
      } catch (error) {
        try { await terminateWithinDeadline(capture, config.workerReapTimeoutMs ?? 5000, deadlineUnixMs, now); }
        catch { throw disposalUnproven(); }
        throw error;
      }
    },
    close: async () => {
      const result = await waitBeforeDeadline(capture.closePromise, deadlineUnixMs, now, "worker-timeout");
      if (result.closedAtMs > deadlineUnixMs) throw new Error("deadline-expired");
      return result;
    },
    abort: async () => terminateWithinDeadline(capture, config.workerReapTimeoutMs ?? 5000, deadlineUnixMs, now),
  };
}
export function validateContainerSecurityOptions(security, config) {
  const expected = ["no-new-privileges:true", "seccomp=" + config.seccompPolicyFile];
  if (!Array.isArray(security) || security.length !== expected.length
    || security.some((value) => typeof value !== "string")
    || expected.some((value) => !security.includes(value))
    || security.some((value) => value.startsWith("apparmor=") || value.startsWith("seccomp=unconfined"))) {
    throw new Error("container-security-drift");
  }
}

function emptyNullableObject(value) {
  return value === null || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function emptyNullableArray(value) {
  return value === null || (Array.isArray(value) && value.length === 0);
}

export function assertContainerVolumeAuthority(inspect, { requireMountInventory = false } = {}) {
  const config = inspect?.Config;
  const host = inspect?.HostConfig;
  const tmpfs = host?.Tmpfs;
  if (!config || !emptyNullableObject(config.Volumes) || !host
    || !emptyNullableArray(host.Binds) || !emptyNullableArray(host.Mounts) || !emptyNullableArray(host.VolumesFrom)
    || !tmpfs || typeof tmpfs !== "object" || Array.isArray(tmpfs) || Object.keys(tmpfs).join(",") !== "/work") {
    throw new Error("container-volume-drift");
  }
  const mounts = inspect.Mounts;
  if (mounts === undefined || mounts === null) {
    if (requireMountInventory) throw new Error("container-volume-drift");
    return inspect;
  }
  if (!Array.isArray(mounts)) throw new Error("container-volume-drift");
  let workTmpfsCount = 0;
  for (const mount of mounts) {
    if (!mount || typeof mount !== "object" || Array.isArray(mount) || !["tmpfs"].includes(mount.Type)) {
      throw new Error("container-volume-drift");
    }
    if (mount.Destination === "/work") {
      if (mount.RW !== true) throw new Error("container-volume-drift");
      workTmpfsCount += 1;
    } else if (mount.Destination !== "/dev/shm") {
      throw new Error("container-volume-drift");
    }
  }
  if (workTmpfsCount > 1 || (requireMountInventory && workTmpfsCount !== 1)) throw new Error("container-volume-drift");
  return inspect;
}

export async function inspectCreatedContainer(config, containerId, docker = runDocker) {
  if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new Error("container-identity-invalid");
  const list = JSON.parse(await docker(config, ["inspect", containerId]));
  const inspect = Array.isArray(list) && list.length === 1 ? list[0] : null;
  if (!inspect || inspect.Id !== containerId) throw new Error("container-identity-invalid");
  return assertContainerVolumeAuthority(inspect);
}
export async function inspectAndVerify(config, containerId, release, operation, budget, capacity, docker = runDocker) {
  const list = JSON.parse(await docker(config, ["inspect", containerId]));
  const inspect = Array.isArray(list) && list.length === 1 ? list[0] : null;
  if (!inspect || inspect.Id !== containerId) throw new Error("container-identity-invalid");
  assertContainerVolumeAuthority(inspect, { requireMountInventory: true });
  const host = inspect?.HostConfig;
  const image = imageReference(config, release.manifest, operation);
  const rootlessPaths = rootlessCgroupPaths(capacity.proof.allocation.rootlessDockerUid);
  const expectedEnvironment = ["PATH=/usr/local/bin:/usr/bin:/bin", "S8_OPERATION=" + operation].sort();
  const actualEnvironment = Array.isArray(inspect?.Config?.Env) ? [...inspect.Config.Env].sort() : [];
  if (!inspect || inspect.Id !== containerId || !/^[0-9a-f]{64}$/u.test(inspect.Id)
    || !host || inspect.Config?.Image !== image || inspect.Config?.User !== "65532:65532"
    || JSON.stringify(actualEnvironment) !== JSON.stringify(expectedEnvironment)
    || JSON.stringify(inspect.Config?.Entrypoint ?? []) !== JSON.stringify(["node", "/opt/s8/worker-entrypoint.mjs"])
    || (inspect.Config?.Cmd?.length ?? 0) !== 0
    || host.CgroupParent !== config.workerCgroupParentUnit
    || host.Memory !== budget.memoryBytes || host.MemorySwap !== budget.memoryBytes || host.CpuPeriod !== 100000
    || host.CpuQuota !== budget.cpuMilli * 100 || host.PidsLimit !== budget.pids || host.NetworkMode !== "none"
    || host.ReadonlyRootfs !== true || host.Privileged !== false || (host.NanoCpus ?? 0) !== 0
    || (host.PidMode ?? "") !== "" || (host.IpcMode ?? "") !== "private" || (host.CgroupnsMode ?? "") !== "private"
    || JSON.stringify(host.CapDrop ?? []) !== JSON.stringify(["ALL"]) || (host.CapAdd?.length ?? 0) !== 0
    || (host.Binds?.length ?? 0) !== 0 || (host.Mounts?.length ?? 0) !== 0 || (host.Devices?.length ?? 0) !== 0
    || Object.keys(host.Tmpfs ?? {}).join(",") !== "/work" || (host.PortBindings && Object.keys(host.PortBindings).length !== 0)
    || (host.GroupAdd?.length ?? 0) !== 0 || (host.VolumesFrom?.length ?? 0) !== 0
    || host.LogConfig?.Type !== "none" || !["no", ""].includes(host.RestartPolicy?.Name ?? "")) throw new Error("container-limit-drift");
  validateContainerSecurityOptions(host.SecurityOpt ?? [], config);
  const temporary = host.Tmpfs?.["/work"];
  const expectedTmp = operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer.tmpBytes : S8_NATIVE_RESOURCE_POLICY.validator.tmpBytes;
  const expectedTmpfs = ["rw", "noexec", "nosuid", "nodev", "size=" + expectedTmp, "uid=65532", "gid=65532", "mode=700"].sort();
  const actualTmpfs = typeof temporary === "string" ? temporary.split(",").sort() : [];
  if (JSON.stringify(actualTmpfs) !== JSON.stringify(expectedTmpfs)) throw new Error("container-tmpfs-drift");
  const labels = inspect.Config.Labels ?? {};
  if (labels["s8.owner"] !== "swooshz-s8-launcher" || labels["s8.operation"] !== operation) throw new Error("container-label-drift");
  const pid = inspect.State?.Pid;
  if (inspect.State?.Running !== true || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("container-pid-invalid");
  const lines = readFileSync(join(config.procRoot, String(pid), "cgroup"), "utf8").trim().split("\n");
  const unified = lines.find((line) => line.startsWith("0::"));
  if (!unified) throw new Error("container-cgroup-missing");
  const logical = unified.slice(3);
  const expectedScope = rootlessPaths.workers + "/docker-" + inspect.Id + ".scope";
  if (logical !== expectedScope || logical.includes("..")) throw new Error("container-cgroup-parent-drift");
  const directory = resolve(config.cgroupRoot, "." + logical);
  if (!directory.startsWith(`${config.cgroupRoot}/`)) throw new Error("container-cgroup-parent-drift");
  const cpu = readFileSync(join(directory, "cpu.max"), "utf8").trim().split(/\s+/u);
  if (cpu.length !== 2 || Number(cpu[0]) !== budget.cpuMilli * 100 || Number(cpu[1]) !== 100000
    || Number(readFileSync(join(directory, "memory.max"), "utf8").trim()) !== budget.memoryBytes
    || Number(readFileSync(join(directory, "pids.max"), "utf8").trim()) !== budget.pids) throw new Error("container-cgroup-limit-drift");
  const controllers = readFileSync(join(directory, "cgroup.controllers"), "utf8").trim().split(/\s+/u);
  if (["cpu", "memory", "pids"].some((value) => !controllers.includes(value))) throw new Error("container-cgroup-controller-missing");
  return inspect;
}

export function workerScopeIsQuiescent(config, containerId, rootlessDockerUid) {
  if (!/^[0-9a-f]{64}$/u.test(containerId) || !Number.isSafeInteger(rootlessDockerUid) || rootlessDockerUid < 1) throw new Error("container-identity-invalid");
  const root = realpathSync(config.cgroupRoot);
  const logical = rootlessCgroupPaths(rootlessDockerUid).workers + "/docker-" + containerId + ".scope";
  const directory = resolve(root, "." + logical);
  const pathFromRoot = relative(root, directory);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(".." + sep) || pathFromRoot === "") throw new Error("container-cgroup-parent-drift");
  let info;
  try { info = lstatSync(directory); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("container-cgroup-parent-drift");
  const events = readFileSync(join(directory, "cgroup.events"), "utf8").trim().split(/\r?\n/u);
  const populated = events.filter((line) => /^populated\s+[01]$/u.test(line));
  if (populated.length !== 1 || populated[0] !== "populated 0") return false;
  if (readFileSync(join(directory, "cgroup.procs"), "utf8").trim() !== "") return false;
  const children = readdirSync(directory, { withFileTypes: true });
  if (children.some((entry) => entry.isDirectory() || entry.isSymbolicLink())) return false;
  return true;
}

export async function removeContainer(config, containerId, rootlessDockerUid, docker = runDocker, baselineVolumeNames = []) {
  if (!containerId) return false;
  if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new Error("container-identity-invalid");
  if (!Array.isArray(baselineVolumeNames) || baselineVolumeNames.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name))
    || new Set(baselineVolumeNames).size !== baselineVolumeNames.length) throw new Error("docker-volume-inventory-invalid");
  try { await docker(config, ["rm", "--force", "--volumes", containerId], 30000); } catch { /* removal is decided by process and cgroup evidence below */ }
  const remaining = (await docker(config, ["ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + containerId])).split(/\s+/u).filter(Boolean);
  if (remaining.length !== 0 && !(remaining.length === 1 && remaining[0] === containerId)) throw new Error("container-inventory-invalid");
  if (remaining.length !== 0) return false;
  const expectedVolumes = new Set(baselineVolumeNames);
  const volumes = dockerVolumeNames(await docker(config, ["volume", "ls", "--quiet", "--no-trunc"]));
  if (baselineVolumeNames.some((name) => !volumes.includes(name))) throw new Error("docker-volume-inventory-drift");
  for (const name of volumes) {
    if (expectedVolumes.has(name)) continue;
    try { await docker(config, ["volume", "rm", name], 30000); } catch { /* exact volume inventory below is authoritative */ }
  }
  const remainingVolumes = dockerVolumeNames(await docker(config, ["volume", "ls", "--quiet", "--no-trunc"])).sort();
  if (JSON.stringify(remainingVolumes) !== JSON.stringify([...expectedVolumes].sort())) throw new Error("docker-volume-removal-unproven");
  return workerScopeIsQuiescent(config, containerId, rootlessDockerUid);
}
