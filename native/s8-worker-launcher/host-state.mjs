import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyCapacityProof, verifyReleaseManifest } from "../s8-worker-common/admission.mjs";
import { jcs, sha256 } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../s8-worker-common/resource-policy.mjs";
import { assertMeasuredHost, assertWorkerScopesQuiescent, measurePhysicalHost, rootlessCgroupPaths, snapshotCgroupTree } from "./capacity.mjs";
import { readJsonFile } from "./config.mjs";

const execFileAsync = promisify(execFile);

export async function runDocker(config, args, timeout = 15000) {
  const result = await execFileAsync(config.dockerPath, ["--host", `unix://${config.dockerSocket}`, ...args], {
    timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", DOCKER_HOST: `unix://${config.dockerSocket}` },
  });
  if (Buffer.byteLength(result.stderr ?? "", "utf8") > 1024 * 1024) throw new Error("docker-output-limit");
  return String(result.stdout ?? "");
}

export function deadlineRemainingMs(deadlineUnixMs, now = Date.now) {
  if (!Number.isSafeInteger(deadlineUnixMs) || typeof now !== "function") throw new Error("deadline-invalid");
  const remaining = deadlineUnixMs - now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("deadline-expired");
  return Math.max(1, Math.ceil(remaining));
}

export function deadlineBoundDocker(deadlineUnixMs, now = Date.now, docker = runDocker) {
  return async (config, args, timeout = 15000) => {
    const remaining = deadlineRemainingMs(deadlineUnixMs, now);
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("docker-timeout-invalid");
    const result = await docker(config, args, Math.min(remaining, timeout));
    deadlineRemainingMs(deadlineUnixMs, now);
    return result;
  };
}

export function dockerContainerIds(output) {
  if (typeof output !== "string") throw new Error("container-inventory-invalid");
  const ids = output.split(/\s+/u).filter(Boolean);
  if (ids.some((id) => !/^[0-9a-f]{64}$/u.test(id))) throw new Error("container-id-invalid");
  return ids;
}

export function assertEmptyDockerInventory(output) {
  if (dockerContainerIds(output).length !== 0) throw new Error("worker-container-inventory-not-empty");
}

export function dockerVolumeNames(output) {
  if (typeof output !== "string") throw new Error("docker-volume-inventory-invalid");
  const volumes = output.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  if (volumes.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name)) || new Set(volumes).size !== volumes.length) {
    throw new Error("docker-volume-inventory-invalid");
  }
  return volumes;
}

export function assertEmptyDockerVolumeInventory(output) {
  if (dockerVolumeNames(output).length !== 0) throw new Error("docker-volume-inventory-not-empty");
}

export function assertImageHasNoVolumes(volumes) {
  if (volumes === null || (volumes && typeof volumes === "object" && !Array.isArray(volumes) && Object.keys(volumes).length === 0)) return;
  throw new Error("image-volume-drift");
}

export function readUnifiedCgroupPath(procRoot, pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw new Error("process-id-invalid");
  const lines = readFileSync(join(procRoot, String(pid), "cgroup"), "utf8").trim().split("\n");
  const unified = lines.filter((line) => line.startsWith("0::"));
  if (unified.length !== 1) throw new Error("process-cgroup-missing");
  const logicalPath = unified[0].slice(3);
  if (!logicalPath.startsWith("/") || logicalPath.includes("..") || logicalPath.includes("//")) throw new Error("process-cgroup-invalid");
  return logicalPath;
}

export function assertProcessCgroup(procRoot, pid, expectedLogicalPath) {
  const actual = readUnifiedCgroupPath(procRoot, pid);
  if (actual !== expectedLogicalPath && !actual.startsWith(expectedLogicalPath + "/")) throw new Error("process-cgroup-drift");
  return actual;
}

export function processUid(procRoot, pid) {
  const status = readFileSync(join(procRoot, String(pid), "status"), "utf8");
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(status);
  if (!match) throw new Error("process-uid-missing");
  const ids = match.slice(1).map(Number);
  if (!ids.every((id) => Number.isSafeInteger(id)) || new Set(ids).size !== 1) throw new Error("process-uid-drift");
  return ids[0];
}

function procTaskInventory(procRoot) {
  let processes;
  try { processes = readdirSync(procRoot, { withFileTypes: true }); }
  catch { throw new Error("host-workload-inventory-unavailable"); }
  const tasks = new Map();
  for (const process of processes) {
    if (!process.isDirectory() || !/^\d+$/u.test(process.name)) continue;
    const taskRoot = join(procRoot, process.name, "task");
    let entries;
    try { entries = readdirSync(taskRoot, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      throw new Error("host-workload-inventory-unavailable");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      let status;
      try { status = readFileSync(join(taskRoot, entry.name, "status"), "utf8"); }
      catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
        throw new Error("host-workload-inventory-unavailable");
      }
      const field = (name, required = true) => {
        const matches = status.split(/\r?\n/u).filter((line) => line.startsWith(name + ":"));
        if (matches.length === 0 && !required) return undefined;
        if (matches.length !== 1) throw new Error("host-workload-inventory-unavailable");
        return matches[0].slice(name.length + 1).trim();
      };
      const tgid = Number(field("Tgid"));
      const pid = Number(field("Pid"));
      const rawKthread = field("Kthread", false);
      const kthread = rawKthread === undefined ? undefined : Number(rawKthread);
      if (!Number.isSafeInteger(tgid) || tgid !== Number(process.name)
        || !Number.isSafeInteger(pid) || pid !== Number(entry.name)
        || (kthread !== undefined && kthread !== 0 && kthread !== 1)
        || tasks.has(pid)) throw new Error("host-workload-inventory-unavailable");
      tasks.set(pid, { tgid, kthread });
    }
  }
  return tasks;
}

function cgroupThreadIds(directory) {
  let value;
  try { value = readFileSync(join(directory, "cgroup.threads"), "utf8").trim(); }
  catch { throw new Error("host-workload-inventory-unavailable"); }
  if (value === "") return [];
  const ids = value.split(/\s+/u);
  if (ids.some((id) => !/^\d+$/u.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error("host-workload-inventory-unavailable");
  }
  return ids.map(Number);
}

function withinCgroup(logicalPath, boundedPath) {
  return logicalPath === boundedPath || logicalPath.startsWith(boundedPath + "/");
}

export function assertHostWorkloadPlacement(cgroupRoot, procRoot, proof) {
  const allocation = proof?.allocation;
  if (!allocation || !Array.isArray(allocation.nonDesignWorkloads)) throw new Error("host-workload-inventory-unavailable");
  const rootless = rootlessCgroupPaths(allocation.rootlessDockerUid);
  const boundedPaths = [
    "/swooshz.slice/swooshz-design.slice/swooshz-design-application.slice",
    "/swooshz.slice/swooshz-design.slice/swooshz-design-gateway.slice",
    "/swooshz.slice/swooshz-design.slice/swooshz-design-launcher.slice",
    "/swooshz.slice/swooshz-design.slice/swooshz-design-systemd.slice",
    rootless.rootlessDocker,
    "/swooshz.slice/swooshz-host-reserve.slice",
    ...allocation.nonDesignWorkloads.map((workload) => workload.cgroupPath),
  ];
  const taskInventory = procTaskInventory(procRoot);
  let rootDirectory;
  try { rootDirectory = readdirSync(cgroupRoot, { withFileTypes: true }); }
  catch { throw new Error("host-workload-inventory-unavailable"); }

  function visit(directory, logicalPath, entries) {
    for (const tid of cgroupThreadIds(directory)) {
      if (logicalPath === "/") {
        const task = taskInventory.get(tid);
        if (!task || task.tgid !== tid || task.kthread !== 1) {
          throw new Error(task?.kthread === undefined ? "host-workload-inventory-unavailable" : "host-workload-placement-unbounded");
        }
      } else if (logicalPath === "/init.scope") {
        const task = taskInventory.get(tid);
        if (!task || task.tgid !== 1 || task.kthread !== 0) {
          throw new Error(task?.kthread === undefined ? "host-workload-inventory-unavailable" : "host-workload-placement-unbounded");
        }
      } else if (!boundedPaths.some((boundedPath) => withinCgroup(logicalPath, boundedPath))) {
        throw new Error("host-workload-placement-unbounded");
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = logicalPath === "/" ? "/" + entry.name : logicalPath + "/" + entry.name;
      let childEntries;
      try { childEntries = readdirSync(join(directory, entry.name), { withFileTypes: true }); }
      catch { throw new Error("host-workload-inventory-unavailable"); }
      visit(join(directory, entry.name), childPath, childEntries);
    }
  }

  visit(cgroupRoot, "/", rootDirectory);
  return true;
}

async function systemdMainPid(config, unitName, deadlineUnixMs = null, now = Date.now, systemctl = execFileAsync) {
  const timeout = deadlineUnixMs === null ? 5000 : Math.min(5000, deadlineRemainingMs(deadlineUnixMs, now));
  const result = await systemctl(config.systemctlPath, ["show", unitName, "--property=MainPID", "--value"], {
    timeout, maxBuffer: 4096, encoding: "utf8", windowsHide: true,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
  });
  if (deadlineUnixMs !== null) deadlineRemainingMs(deadlineUnixMs, now);
  const pid = Number(String(result.stdout ?? "").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("rootless-user-manager-unavailable");
  return pid;
}

export function readRootlessDaemonPid(pidFile) {
  const info = lstatSync(pidFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 || (info.mode & 0o022) !== 0) throw new Error("rootless-daemon-pidfile");
  const value = readFileSync(pidFile, "utf8").trim();
  if (!/^\d{1,10}$/u.test(value)) throw new Error("rootless-daemon-pidfile");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("rootless-daemon-unavailable");
  return pid;
}

export function imageReference(config, manifest, operation) {
  const digest = operation === "WRITER" ? manifest.writer.imageDigest : manifest.validator.imageDigest;
  const repository = operation === "WRITER" ? config.writerRepository : config.validatorRepository;
  return `${repository}@${digest}`;
}

export function validateDockerRuntimeInfo(raw) {
  const values = raw.trim().split("|");
  if (values.length !== 3 || values[1] !== "2" || values[2] !== "systemd") throw new Error("runtime-drift");
  const options = JSON.parse(values[0]);
  if (!Array.isArray(options) || !options.some((value) => String(value) === "name=rootless")
    || !options.some((value) => String(value).startsWith("name=seccomp"))
    || options.some((value) => String(value).includes("unconfined"))) throw new Error("runtime-drift");
}

async function verifyDocker(config, docker = runDocker) {
  const raw = await docker(config, ["info", "--format", "{{json .SecurityOptions}}|{{.CgroupVersion}}|{{.CgroupDriver}}"]);
  validateDockerRuntimeInfo(raw);
}

async function verifyImages(config, manifest, docker = runDocker) {
  for (const operation of ["WRITER", "VALIDATOR"]) {
    const reference = imageReference(config, manifest, operation);
    const raw = await docker(config, ["image", "inspect", "--format", "{{json .RepoDigests}}", reference]);
    const digests = JSON.parse(raw);
    if (!Array.isArray(digests) || !digests.includes(reference)) throw new Error("image-drift");
    const volumes = JSON.parse(await docker(config, ["image", "inspect", "--format", "{{json .Config.Volumes}}", reference]));
    assertImageHasNoVolumes(volumes);
  }
}

export function validateRootlessKitAppArmorEvidence(manifest, evidence) {
  const sandbox = manifest?.sandbox;
  const hostProfile = sandbox?.rootlessKitHostAppArmor;
  if (sandbox?.jobAppArmorMode !== "unsupported-not-relied-upon"
    || hostProfile?.mode !== "required-profile"
    || hostProfile.profileName !== "swooshz-s8-rootlesskit-v1"
    || !/^[0-9a-f]{64}$/u.test(hostProfile.profileSha256)
    || sha256(evidence.profileBytes) !== hostProfile.profileSha256) throw new Error("rootlesskit-apparmor-profile-drift");
  if (evidence.enabled !== "Y") throw new Error("apparmor-unavailable");
  const enforcedProfile = hostProfile.profileName + " (enforce)";
  if (!String(evidence.loadedProfiles).split(/\r?\n/u).some((line) => line.trim() === enforcedProfile)) throw new Error("rootlesskit-apparmor-not-loaded");
  if (String(evidence.processProfile).trim() !== enforcedProfile) throw new Error("rootlesskit-apparmor-drift");
  return {
    jobAppArmorMode: sandbox.jobAppArmorMode,
    rootlessKitHostAppArmorMode: hostProfile.mode,
    rootlessKitHostAppArmorProfileName: hostProfile.profileName,
    rootlessKitHostAppArmorProfileSha256: hostProfile.profileSha256,
  };
}

export function findRootlessKitPid(procRoot, expectedLogicalPath, expectedUid) {
  let entries;
  try { entries = readdirSync(procRoot, { withFileTypes: true }); }
  catch { throw new Error("rootlesskit-process-inventory-unavailable"); }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let command;
    try { command = readFileSync(join(procRoot, entry.name, "comm"), "utf8").trim(); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      throw new Error("rootlesskit-process-inventory-unavailable");
    }
    if (command !== "rootlesskit") continue;
    let cgroup;
    try { cgroup = readUnifiedCgroupPath(procRoot, entry.name); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      throw new Error("rootlesskit-process-cgroup-unavailable");
    }
    if (cgroup !== expectedLogicalPath && !cgroup.startsWith(expectedLogicalPath + "/")) continue;
    if (processUid(procRoot, entry.name) !== expectedUid) throw new Error("rootlesskit-process-uid-drift");
    matches.push(Number(entry.name));
  }
  if (matches.length !== 1) throw new Error("rootlesskit-process-inventory-drift");
  return matches[0];
}

function verifySandbox(config, manifest, rootlessKitPid) {
  const seccomp = readFileSync(config.seccompPolicyFile);
  if (sha256(seccomp) !== manifest.sandbox.seccompPolicySha256) throw new Error("seccomp-drift");
  const profileBytes = readFileSync(config.rootlessKitAppArmorProfileFile);
  const evidence = {
    profileBytes,
    enabled: readFileSync(join(config.sysRoot, "module/apparmor/parameters/enabled"), "utf8").trim().toUpperCase(),
    loadedProfiles: readFileSync(join(config.sysRoot, "kernel/security/apparmor/profiles"), "utf8"),
    processProfile: readFileSync(join(config.procRoot, String(rootlessKitPid), "attr/current"), "utf8"),
  };
  return validateRootlessKitAppArmorEvidence(manifest, evidence);
}

export async function admissionSnapshot(config, startupReady, deadlineUnixMs = null, now = Date.now, dependencies = {}) {
  const executeDocker = dependencies.docker ?? runDocker;
  const docker = deadlineUnixMs === null ? executeDocker : deadlineBoundDocker(deadlineUnixMs, now, executeDocker);
  const checkDeadline = () => { if (deadlineUnixMs !== null) deadlineRemainingMs(deadlineUnixMs, now); };
  checkDeadline();
  if (!startupReady()) throw new Error("startup-not-reconciled");
  assertProcessCgroup(config.procRoot, process.pid, config.launcherCgroupLogicalPath);
  const signedProof = readJsonFile(config.capacityProofFile, 256 * 1024);
  const capacity = verifyCapacityProof(signedProof, config.capacityAuthorityKeys);
  const release = verifyReleaseManifest(readJsonFile(config.releaseManifestFile, 256 * 1024), config.releaseAuthorityKeys);
  checkDeadline();
  if (capacity.proof.releaseManifestSha256 !== release.sha256 || capacity.proof.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("proof-release-drift");
  const host = measurePhysicalHost({ procRoot: config.procRoot, sysRoot: config.sysRoot, etcRoot: config.etcRoot });
  assertMeasuredHost(host, capacity.proof.host);
  checkDeadline();
  const inventory = readJsonFile(config.workloadInventoryFile, 1024 * 1024);
  if (Object.keys(inventory).sort().join(",") !== "schemaVersion,workloads" || inventory.schemaVersion !== "s8-workload-inventory-v1"
    || jcs(inventory.workloads) !== jcs(capacity.proof.allocation.nonDesignWorkloads)
    || sha256(Buffer.from(jcs(inventory), "utf8")) !== capacity.proof.workloadInventorySha256) throw new Error("inventory-drift");
  const tree = snapshotCgroupTree(config.cgroupRoot, capacity.proof);
  if (tree.sha256 !== capacity.proof.cgroupTreeSha256) throw new Error("cgroup-drift");
  assertHostWorkloadPlacement(config.cgroupRoot, config.procRoot, capacity.proof);
  checkDeadline();
  await verifyDocker(config, docker);
  assertEmptyDockerInventory(await docker(config, ["ps", "--all", "--quiet", "--no-trunc"]));
  assertEmptyDockerVolumeInventory(await docker(config, ["volume", "ls", "--quiet", "--no-trunc"]));
  checkDeadline();
  assertWorkerScopesQuiescent(config.cgroupRoot, capacity.proof);
  const rootlessUid = capacity.proof.allocation.rootlessDockerUid;
  const rootlessPaths = rootlessCgroupPaths(rootlessUid);
  const managerPid = await systemdMainPid(config, "user@" + rootlessUid + ".service", deadlineUnixMs, now, dependencies.systemctl ?? execFileAsync);
  const managerCgroup = assertProcessCgroup(config.procRoot, managerPid, rootlessPaths.userManager);
  if (![rootlessPaths.userManager, rootlessPaths.userManager + "/init.scope"].includes(managerCgroup)
    || processUid(config.procRoot, managerPid) !== rootlessUid) throw new Error("rootless-user-manager-drift");
  const daemonPid = readRootlessDaemonPid(config.rootlessDockerPidFile);
  assertProcessCgroup(config.procRoot, daemonPid, rootlessPaths.daemon);
  if (processUid(config.procRoot, daemonPid) !== rootlessUid) throw new Error("rootless-daemon-uid-drift");
  const rootlessKitPid = findRootlessKitPid(config.procRoot, rootlessPaths.daemon, rootlessUid);
  const appArmor = verifySandbox(config, release.manifest, rootlessKitPid);
  checkDeadline();
  await verifyImages(config, release.manifest, docker);
  checkDeadline();
  const observation = {
    schemaVersion: "s8-launcher-observation-v2",
    proofSha256: capacity.proofSha256,
    state: capacity.proof.state,
    observedAt: new Date().toISOString(),
    launcherKeyId: config.signingKeyId,
    hostId: host.hostId,
    cpuMilli: host.cpuMilli,
    memoryBytes: host.memoryBytes,
    pids: host.pids,
    workloadInventorySha256: capacity.proof.workloadInventorySha256,
    cgroupTreeSha256: tree.sha256,
    releaseManifestSha256: release.sha256,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    jobAppArmorMode: appArmor.jobAppArmorMode,
    rootlessKitHostAppArmorMode: appArmor.rootlessKitHostAppArmorMode,
    rootlessKitHostAppArmorProfileName: appArmor.rootlessKitHostAppArmorProfileName,
    rootlessKitHostAppArmorProfileSha256: appArmor.rootlessKitHostAppArmorProfileSha256,
    cgroupV2: true,
    rootlessDocker: true,
    requiredControllers: ["cpu", "memory", "pids"],
    startupReconciled: true,
    unreconciledContainerCount: 0,
  };
  checkDeadline();
  return { signedProof, capacity, release, host, tree, observation };
}

export async function reconcileStartup(config) {
  config.ledger.reconcileInflight();
  const ids = dockerContainerIds(await runDocker(config, ["ps", "--all", "--quiet", "--no-trunc"]));
  for (const id of ids) {
    const labels = JSON.parse(await runDocker(config, ["inspect", "--format", "{{json .Config.Labels}}", id]));
    if (labels?.["s8.owner"] !== "swooshz-s8-launcher") throw new Error("foreign-container");
    try { await runDocker(config, ["rm", "--force", "--volumes", id], 30000); } catch { /* exact inventory below is authoritative */ }
    const remaining = (await runDocker(config, ["ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + id])).split(/\s+/u).filter(Boolean);
    if (remaining.length !== 0) throw new Error("container-remains");
  }
  await verifyDocker(config);
  const signedProof = readJsonFile(config.capacityProofFile, 256 * 1024);
  const capacity = verifyCapacityProof(signedProof, config.capacityAuthorityKeys);
  assertWorkerScopesQuiescent(config.cgroupRoot, capacity.proof);
  assertHostWorkloadPlacement(config.cgroupRoot, config.procRoot, capacity.proof);
  assertEmptyDockerInventory(await runDocker(config, ["ps", "--all", "--quiet", "--no-trunc"]));
  assertEmptyDockerVolumeInventory(await runDocker(config, ["volume", "ls", "--quiet", "--no-trunc"]));
  return ids.length;
}
