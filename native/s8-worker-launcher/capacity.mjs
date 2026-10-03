import { readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { jcs, sha256 } from "../s8-worker-common/protocol.mjs";
import { S8_NATIVE_RESOURCE_POLICY } from "../s8-worker-common/resource-policy.mjs";

const REQUIRED = ["cpu", "memory", "pids"];
const PERIOD_US = 100000;
const HEX64 = /^[0-9a-f]{64}$/u;

function safeLogicalPath(value) {
  if (typeof value !== "string" || !/^\/swooshz\.slice(?:\/[A-Za-z0-9][A-Za-z0-9@._-]{0,190})*$/u.test(value) || value.includes("..")) throw new Error("cgroup-path");
  return value;
}

function parseCpuOnline(value) {
  if (typeof value !== "string") throw new Error("cpu-online");
  const normalized = value.trim();
  if (!/^[0-9,-]+$/u.test(normalized)) throw new Error("cpu-online");
  const online = new Set();
  for (const range of normalized.split(",")) {
    const parts = range.split("-").map(Number);
    if (parts.length > 2 || parts.some((part) => !Number.isSafeInteger(part) || part < 0) || (parts.length === 2 && parts[1] < parts[0])) throw new Error("cpu-online");
    const end = parts[1] ?? parts[0];
    if (end - parts[0] > 65535) throw new Error("cpu-online");
    for (let cpu = parts[0]; cpu <= end; cpu += 1) {
      if (online.has(cpu)) throw new Error("cpu-online");
      online.add(cpu);
    }
  }
  if (online.size < 1) throw new Error("cpu-online");
  return online.size;
}

function readPositiveTaskLimit(path) {
  let raw;
  try { raw = readFileSync(path, "utf8").trim(); }
  catch { throw new Error("physical-task-capacity"); }
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new Error("physical-task-capacity");
  return value;
}

export function measurePhysicalHost({ procRoot = "/proc", sysRoot = "/sys", etcRoot = "/etc" } = {}) {
  const cpuMilli = parseCpuOnline(readFileSync(join(sysRoot, "devices/system/cpu/online"), "utf8")) * 1000;
  const memInfo = readFileSync(join(procRoot, "meminfo"), "utf8");
  const memoryMatch = /^MemTotal:\s+(\d+)\s+kB\s*$/mu.exec(memInfo);
  if (!memoryMatch) throw new Error("physical-memory");
  const memoryBytes = Number(memoryMatch[1]) * 1024;
  const taskCeiling = readPositiveTaskLimit(join(procRoot, "sys/kernel/threads-max"));
  const pidRangeCeiling = readPositiveTaskLimit(join(procRoot, "sys/kernel/pid_max"));
  const pids = Math.min(taskCeiling, pidRangeCeiling);
  const machineId = readFileSync(join(etcRoot, "machine-id"), "utf8").trim();
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || !Number.isSafeInteger(pids) || pids <= 0 || !/^[0-9a-f]{32}$/u.test(machineId)) throw new Error("physical-measurement");
  return {
    hostId: sha256(Buffer.from(`s8-capacity-host-v1\0${machineId}`, "ascii")),
    cpuMilli,
    memoryBytes,
    pids,
  };
}

function share(total, percentages) {
  if (!Number.isSafeInteger(total) || total <= 0 || percentages.reduce((a, b) => a + b, 0) !== 100) throw new Error("streaming-share");
  const first = Math.floor(total * percentages[0] / 100);
  const second = Math.floor(total * percentages[1] / 100);
  const third = total - first - second;
  if (first < 1 || second < 1 || third < 1) throw new Error("streaming-share");
  return [first, second, third];
}

function add(a, b) {
  const result = { cpuMilli: a.cpuMilli + b.cpuMilli, memoryBytes: a.memoryBytes + b.memoryBytes, pids: a.pids + b.pids };
  if (!Object.values(result).every(Number.isSafeInteger)) throw new Error("budget-overflow");
  return result;
}

export function rootlessCgroupPaths(uid) {
  if (!Number.isSafeInteger(uid) || uid < 1000 || uid > 2147483647) throw new Error("rootless-uid");
  const rootlessDocker = "/swooshz.slice/swooshz-design.slice/swooshz-design-rootless-docker.slice";
  const userManager = rootlessDocker + "/user@" + uid + ".service";
  const app = userManager + "/app.slice";
  const daemon = app + "/swooshz-s8-rootless-docker.service";
  const workers = userManager + "/swooshz-s8-workers.slice";
  return { rootlessDocker, userManager, app, daemon, workers, workerParentUnit: "swooshz-s8-workers.slice" };
}

export function expectedCgroupBudgets(proof) {
  const allocation = proof?.allocation;
  if (!allocation) throw new Error("allocation-missing");
  const streaming = allocation.streaming;
  const percentages = [
    S8_NATIVE_RESOURCE_POLICY.streaming.applicationPercent,
    S8_NATIVE_RESOURCE_POLICY.streaming.gatewayPercent,
    S8_NATIVE_RESOURCE_POLICY.streaming.launcherPercent,
  ];
  const cpuShare = share(streaming.cpuMilli, percentages);
  const memoryShare = share(streaming.memoryBytes, percentages);
  const pidsShare = share(streaming.pids, percentages);
  const worker = {
    cpuMilli: Math.max(allocation.writer.cpuMilli, allocation.validator.cpuMilli),
    memoryBytes: Math.max(allocation.writer.memoryBytes, allocation.validator.memoryBytes),
    pids: Math.max(allocation.writer.pids, allocation.validator.pids),
  };
  const hostRoot = "/swooshz.slice";
  const design = hostRoot + "/swooshz-design.slice";
  const nonDesign = hostRoot + "/swooshz-non-design.slice";
  const rootlessPaths = rootlessCgroupPaths(allocation.rootlessDockerUid);
  const { rootlessDocker, userManager, app, daemon, workers } = rootlessPaths;
  const hostAggregate = add(add(allocation.designAggregate, allocation.nonDesignAggregate), allocation.protectedHostReserve);
  const entries = [
    [hostRoot, hostAggregate],
    [design, allocation.designAggregate],
    [design + "/swooshz-design-application.slice", add(allocation.designApplication, { cpuMilli: cpuShare[0], memoryBytes: memoryShare[0], pids: pidsShare[0] })],
    [design + "/swooshz-design-gateway.slice", add(allocation.gateway, { cpuMilli: cpuShare[1], memoryBytes: memoryShare[1], pids: pidsShare[1] })],
    [design + "/swooshz-design-launcher.slice", add(allocation.launcher, { cpuMilli: cpuShare[2], memoryBytes: memoryShare[2], pids: pidsShare[2] })],
    [rootlessDocker, allocation.rootlessDocker],
    [userManager, allocation.rootlessDocker],
    [app, allocation.rootlessDocker],
    [daemon, allocation.rootlessDocker],
    [design + "/swooshz-design-systemd.slice", allocation.systemd],
    [workers, worker],
    [nonDesign, allocation.nonDesignAggregate],
    [hostRoot + "/swooshz-host-reserve.slice", allocation.protectedHostReserve],
    ...allocation.nonDesignWorkloads.map((item) => [safeLogicalPath(item.cgroupPath), item.budget]),
  ];
  const seen = new Set();
  return entries.map(([logicalPath, budget]) => {
    safeLogicalPath(logicalPath);
    if (seen.has(logicalPath)) throw new Error("cgroup-duplicate");
    seen.add(logicalPath);
    return { logicalPath, budget };
  }).sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
}

function readText(path) {
  return readFileSync(path, "utf8").trim();
}

function cgroupDir(root, logicalPath) {
  safeLogicalPath(logicalPath);
  const resolvedRoot = realpathSync(root);
  const candidate = resolve(resolvedRoot, `.${logicalPath}`);
  if (!candidate.startsWith(`${resolvedRoot}${sep}`)) throw new Error("cgroup-path");
  const actual = realpathSync(candidate);
  if (!actual.startsWith(`${resolvedRoot}${sep}`)) throw new Error("cgroup-path");
  return actual;
}

function parseControllers(value) {
  const names = value.trim().split(/\s+/u).filter(Boolean).map((item) => item.replace(/^\+/u, ""));
  return [...new Set(names)].sort();
}

function childDirectories(directory) {
  return readdirSync(directory).filter((name) => statSync(join(directory, name)).isDirectory()).sort();
}

function assertChildren(cgroupRoot, logicalPath, expectedNames) {
  const actual = childDirectories(cgroupDir(cgroupRoot, logicalPath));
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error("cgroup-inventory-drift");
}

function assertChildrenWithOptional(cgroupRoot, logicalPath, requiredNames, optionalNames) {
  const actual = childDirectories(cgroupDir(cgroupRoot, logicalPath));
  const allowed = new Set([...requiredNames, ...optionalNames]);
  if (requiredNames.some((name) => !actual.includes(name)) || actual.some((name) => !allowed.has(name))) throw new Error("cgroup-inventory-drift");
  return actual;
}

function assertEmptyCgroup(cgroupRoot, logicalPath) {
  const directory = cgroupDir(cgroupRoot, logicalPath);
  if (readText(join(directory, "cgroup.procs")) !== "" || childDirectories(directory).length !== 0) throw new Error("cgroup-inventory-drift");
}

function assertWorkerScopes(cgroupRoot, logicalPath) {
  const actual = childDirectories(cgroupDir(cgroupRoot, logicalPath));
  if (actual.length > 1 || actual.some((name) => !/^docker-[0-9a-f]{64}\.scope$/u.test(name))) throw new Error("cgroup-inventory-drift");
}

export function assertWorkerScopesQuiescent(cgroupRoot, proof) {
  const workers = rootlessCgroupPaths(proof?.allocation?.rootlessDockerUid).workers;
  const actual = childDirectories(cgroupDir(cgroupRoot, workers));
  if (actual.length > 1 || actual.some((name) => !/^docker-[0-9a-f]{64}\.scope$/u.test(name))) throw new Error("cgroup-inventory-drift");
  for (const name of actual) {
    const scope = workers + "/" + name;
    const directory = cgroupDir(cgroupRoot, scope);
    const populated = readText(join(directory, "cgroup.events")).split(/\r?\n/u)
      .filter((line) => /^populated\s+\d+$/u.test(line));
    if (populated.length !== 1 || populated[0] !== "populated 0"
      || readText(join(directory, "cgroup.procs")) !== "" || childDirectories(directory).length !== 0) {
      throw new Error("worker-scope-not-quiescent");
    }
  }
}

function readHardLimit(value) {
  if (value === "max") return null;
  if (!/^\d+$/u.test(value)) throw new Error("launcher-cgroup-limit");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("launcher-cgroup-limit");
  return parsed;
}

export function assertNestedCgroupLimits(cgroupRoot, actualLogicalPath, signedParentPath, budget) {
  safeLogicalPath(actualLogicalPath);
  safeLogicalPath(signedParentPath);
  if (actualLogicalPath !== signedParentPath && !actualLogicalPath.startsWith(signedParentPath + "/")) throw new Error("launcher-cgroup-drift");
  if (!budget || ![budget.cpuMilli, budget.memoryBytes, budget.pids].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("launcher-cgroup-budget-invalid");

  const descendants = actualLogicalPath === signedParentPath ? [] : actualLogicalPath.slice(signedParentPath.length + 1).split("/");
  const paths = [signedParentPath];
  let current = signedParentPath;
  for (const component of descendants) {
    if (!/^[A-Za-z0-9][A-Za-z0-9@._-]{0,190}$/u.test(component)) throw new Error("launcher-cgroup-drift");
    current += "/" + component;
    paths.push(current);
  }

  for (let index = 0; index < paths.length; index += 1) {
    const logicalPath = paths[index];
    const directory = cgroupDir(cgroupRoot, logicalPath);
    const cpuParts = readText(join(directory, "cpu.max")).split(/\s+/u);
    if (cpuParts.length !== 2 || !/^\d+$/u.test(cpuParts[1])) throw new Error("launcher-cgroup-limit");
    const period = Number(cpuParts[1]);
    if (!Number.isSafeInteger(period) || period <= 0) throw new Error("launcher-cgroup-limit");
    const quota = readHardLimit(cpuParts[0]);
    const memory = readHardLimit(readText(join(directory, "memory.max")));
    const pids = readHardLimit(readText(join(directory, "pids.max")));
    if (index === 0) {
      const expectedQuota = budget.cpuMilli * PERIOD_US / 1000;
      if (!Number.isSafeInteger(expectedQuota) || quota !== expectedQuota || period !== PERIOD_US
        || memory !== budget.memoryBytes || pids !== budget.pids) throw new Error("launcher-cgroup-limit");
      continue;
    }
    if ((quota !== null && BigInt(quota) * 1000n < BigInt(budget.cpuMilli) * BigInt(period))
      || (memory !== null && memory < budget.memoryBytes) || (pids !== null && pids < budget.pids)) throw new Error("launcher-cgroup-limit");
  }
  return actualLogicalPath;
}

export function snapshotCgroupTree(cgroupRoot, proof) {
  if (!HEX64.test(proof.cgroupTreeSha256)) throw new Error("cgroup-digest");
  const groups = expectedCgroupBudgets(proof);
  const hostRoot = "/swooshz.slice";
  const design = hostRoot + "/swooshz-design.slice";
  const nonDesign = hostRoot + "/swooshz-non-design.slice";
  const rootlessPaths = rootlessCgroupPaths(proof.allocation.rootlessDockerUid);
  const { rootlessDocker, userManager, app, daemon, workers } = rootlessPaths;
  const siblingNames = proof.allocation.nonDesignWorkloads.map((item) => {
    const logicalPath = safeLogicalPath(item.cgroupPath);
    const prefix = nonDesign + "/";
    if (!logicalPath.startsWith(prefix) || logicalPath.slice(prefix.length).includes("/")) throw new Error("cgroup-path");
    return logicalPath.slice(prefix.length);
  });
  assertChildren(cgroupRoot, hostRoot, ["swooshz-design.slice", "swooshz-host-reserve.slice", "swooshz-non-design.slice"]);
  assertChildren(cgroupRoot, design, [
    "swooshz-design-application.slice", "swooshz-design-gateway.slice", "swooshz-design-launcher.slice",
    "swooshz-design-rootless-docker.slice", "swooshz-design-systemd.slice",
  ]);
  assertChildren(cgroupRoot, rootlessDocker, ["user@" + proof.allocation.rootlessDockerUid + ".service"]);
  const userManagerChildren = assertChildrenWithOptional(cgroupRoot, userManager, ["app.slice", "swooshz-s8-workers.slice"], ["background.slice", "init.scope", "session.slice"]);
  for (const idle of ["background.slice", "session.slice"]) if (userManagerChildren.includes(idle)) assertEmptyCgroup(cgroupRoot, userManager + "/" + idle);
  if (userManagerChildren.includes("init.scope") && childDirectories(cgroupDir(cgroupRoot, userManager + "/init.scope")).length !== 0) throw new Error("cgroup-inventory-drift");
  assertChildren(cgroupRoot, app, ["swooshz-s8-rootless-docker.service"]);
  assertWorkerScopes(cgroupRoot, workers);
  assertChildren(cgroupRoot, nonDesign, siblingNames);
  const entries = groups.map(({ logicalPath, budget }) => {
    const directory = cgroupDir(cgroupRoot, logicalPath);
    const cpu = readText(join(directory, "cpu.max")).split(/\s+/u);
    if (cpu.length !== 2 || !/^\d+$/u.test(cpu[0]) || Number(cpu[1]) !== PERIOD_US) throw new Error("cpu-limit");
    const quota = Number(cpu[0]);
    const expectedQuota = budget.cpuMilli * PERIOD_US / 1000;
    if (!Number.isSafeInteger(expectedQuota) || quota !== expectedQuota) throw new Error("cpu-limit");
    const memory = readText(join(directory, "memory.max"));
    const pids = readText(join(directory, "pids.max"));
    if (!/^\d+$/u.test(memory) || Number(memory) !== budget.memoryBytes || !/^\d+$/u.test(pids) || Number(pids) !== budget.pids) throw new Error("memory-pid-limit");
    const controllers = parseControllers(readText(join(directory, "cgroup.controllers")));
    if (REQUIRED.some((controller) => !controllers.includes(controller))) throw new Error("controller-missing");
    const info = statSync(directory, { bigint: true });
    return { logicalPath, budget, cpuMax: `${quota} ${PERIOD_US}`, memoryMax: memory, pidsMax: pids, controllers, device: info.dev.toString(), inode: info.ino.toString() };
  });
  for (const parent of ["/swooshz.slice", "/swooshz.slice/swooshz-design.slice", rootlessDocker, userManager, app, workers, "/swooshz.slice/swooshz-non-design.slice"]) {
    const directory = cgroupDir(cgroupRoot, parent);
    const subtree = parseControllers(readText(join(directory, "cgroup.subtree_control")));
    if (REQUIRED.some((controller) => !subtree.includes(controller))) throw new Error("controller-not-delegated");
  }
  const tree = { schemaVersion: "s8-cgroup-tree-v1", periodUs: PERIOD_US, entries };
  return { tree, sha256: sha256(Buffer.from(jcs(tree), "utf8")) };
}

export function assertMeasuredHost(actual, expected) {
  if (actual.hostId !== expected.hostId || actual.cpuMilli !== expected.cpuMilli || actual.memoryBytes !== expected.memoryBytes || actual.pids !== expected.pids) throw new Error("host-drift");
}
