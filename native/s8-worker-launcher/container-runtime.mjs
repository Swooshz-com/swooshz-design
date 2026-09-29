import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { S8_NATIVE_RESOURCE_POLICY } from "../s8-worker-common/resource-policy.mjs";
import { rootlessCgroupPaths } from "./capacity.mjs";
import { runDocker, imageReference } from "./host-state.mjs";

const READY = Buffer.from("S8_READY\n", "ascii");

export function workerBudget(proof, operation) {
  return operation === "WRITER" ? proof.allocation.writer : proof.allocation.validator;
}

export function createArguments(config, capacity, release, operation, requestSha256) {
  const budget = workerBudget(capacity.proof, operation);
  const limits = operation === "WRITER" ? S8_NATIVE_RESOURCE_POLICY.writer : S8_NATIVE_RESOURCE_POLICY.validator;
  return [
    "create", "--pull=never", "--interactive", "--read-only", "--user=65532:65532",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", `--security-opt=seccomp=${config.seccompPolicyFile}`,
    `--security-opt=apparmor=${config.appArmorProfileName}`, "--network=none", "--cpu-period=100000", `--cpu-quota=${budget.cpuMilli * 100}`,
    `--memory=${budget.memoryBytes}`, `--memory-swap=${budget.memoryBytes}`, `--pids-limit=${budget.pids}`,
    `--tmpfs=/work:rw,noexec,nosuid,nodev,size=${limits.tmpBytes},uid=65532,gid=65532,mode=700`,
    "--cgroup-parent=" + config.workerCgroupParentUnit, "--log-driver=none", "--restart=no",
    "--env", `S8_OPERATION=${operation}`,
    "--label", "s8.owner=swooshz-s8-launcher", "--label", `s8.operation=${operation}`,
    "--label", `s8.request=${requestSha256}`, imageReference(config, release.manifest, operation),
  ];
}

function captureProcess(child, maxStdout) {
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
  const closePromise = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal, overflow, stdout: Buffer.concat(stdout, stdoutBytes), stderrBytes }));
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
  return { readyPromise, closePromise, child };
}

async function writeWithBackpressure(stream, bytes) {
  if (stream.destroyed) throw new Error("worker-stdin-closed");
  if (!stream.write(bytes)) await new Promise((resolvePromise, reject) => { stream.once("drain", resolvePromise); stream.once("error", reject); });
}

export async function startContainer(config, containerId, payload, operation) {
  const maximum = operation === "WRITER" ? 128 * 1024 * 1024 + 1024 * 1024 + 64 * 1024 + 20 : 8 * 1024 * 1024 + 64 * 1024 + 20;
  const child = spawn(config.dockerPath, ["--host", `unix://${config.dockerSocket}`, "start", "--attach", "--interactive", containerId], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", DOCKER_HOST: `unix://${config.dockerSocket}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const capture = captureProcess(child, maximum);
  const lengthHeader = Buffer.alloc(8);
  lengthHeader.writeBigUInt64BE(BigInt(payload.length), 0);
  await writeWithBackpressure(child.stdin, lengthHeader);
  await writeWithBackpressure(child.stdin, payload);
  let timer;
  try {
    await Promise.race([capture.readyPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker-ready-timeout")), 10000); })]);
  } finally { clearTimeout(timer); }
  return {
    release: async () => { await writeWithBackpressure(child.stdin, Buffer.from("R", "ascii")); child.stdin.end(); },
    close: async (timeoutMs) => {
      let deadline;
      try { return await Promise.race([capture.closePromise, new Promise((_, reject) => { deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker-timeout")); }, timeoutMs); })]); }
      finally { clearTimeout(deadline); }
    },
  };
}

export async function inspectAndVerify(config, containerId, release, operation, budget, capacity) {
  const list = JSON.parse(await runDocker(config, ["inspect", containerId]));
  const inspect = Array.isArray(list) ? list[0] : null;
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
  const security = host.SecurityOpt ?? [];
  if (!security.includes("no-new-privileges:true") || !security.includes(`seccomp=${config.seccompPolicyFile}`)
    || !security.includes(`apparmor=${config.appArmorProfileName}`)) throw new Error("container-security-drift");
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

export async function removeContainer(config, containerId) {
  if (!containerId) return false;
  try { await runDocker(config, ["rm", "--force", containerId], 30000); } catch { /* exact inventory below is authoritative */ }
  const remaining = (await runDocker(config, ["ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + containerId])).split(/\s+/u).filter(Boolean);
  if (remaining.length === 0) return true;
  if (remaining.length === 1 && remaining[0] === containerId) return false;
  throw new Error("container-inventory-invalid");
}
