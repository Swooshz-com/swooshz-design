import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../../src/lib/types";
import { buildS8WriterPayload } from "../../src/lib/s8-fbx-payload";
import {
  runS8BlenderWriter,
  runS8NativeValidator,
  type S8WorkerConfig,
} from "../../src/lib/s8-fbx-worker";

const PRODUCT_HEAD = "2f71e472849055ab8814f7e38d0f8c321707275f";
const PRODUCT_TREE = "c72036fdc685ad3a78e2b696df212476c1dade36";
const BLENDER_ARCHIVE_SHA256 = "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168";
const CONTROLLED_KEYS = [
  "S8_TEST_PARENT_SECRET_A",
  "S8_TEST_PARENT_SECRET_B",
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
] as const;
const ENVIRONMENT_KEYS = [
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
] as const;
const FIXED_ENV_CANDIDATES: Record<string, string> = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  HOME: "/work/config",
  TMPDIR: "/tmp",
  TZ: "UTC",
  LD_LIBRARY_PATH: "/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu",
  PYTHONPATH: "/runtime/writer",
  PYTHONHOME: "/runtime/blender-root/5.2/python",
};

type FileDependency = { soname: string; path: string };
type ElfEvidence = {
  label: string;
  path: string;
  sha256: string;
  fileIdentity: string;
  interpreter: string;
  needed: string[];
  rpathRunpath: string[];
  resolved: FileDependency[];
};
type RuntimeSurface = {
  id: string;
  kind: "file" | "directory";
  source: string;
  target: string;
  loadedMembers: string[];
};
type LaunchEvidence = {
  ok: boolean;
  error: string;
  stderr: string;
  stdout: string;
  manifest: Record<string, unknown>;
  result?: ReturnType<typeof runS8BlenderWriter>;
};

function redact(value: string, maximum = 2048): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|token)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(S8_TEST_PARENT_SECRET_[AB]\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, maximum);
}

function emit(key: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  process.stdout.write(`${key}=${redact(text ?? "null", 100_000)}\n`);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number; maxBuffer?: number } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error?.message ?? "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function outputOf(command: string, args: string[]): string {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed: ${redact(result.stderr || result.error)}`);
  return result.stdout;
}

function classifyValue(key: string, value: string | undefined): string {
  if (value === undefined) return "ABSENT";
  if (key === "S8_TEST_PARENT_SECRET_A" && value === "RUN077_PARENT_SENTINEL_A") return "SENTINEL_A";
  if (key === "S8_TEST_PARENT_SECRET_B" && value === "RUN077_PARENT_SENTINEL_B") return "SENTINEL_B";
  if (key === "LD_PRELOAD" && value.endsWith("/libm.so.6")) return "HOSTILE_VALID_LIBRARY_PATH";
  return "HOSTILE_VALUE_SET";
}

function withEnvironment<T>(environment: Record<string, string>, action: () => T): T {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  try {
    return action();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function withEnvironmentOverlay<T>(environment: Record<string, string>, action: () => T): T {
  const previous = new Map<string, string | undefined>(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function hostileParentEnvironment(ldPreload: string): Record<string, string> {
  return {
    S8_TEST_PARENT_SECRET_A: "RUN077_PARENT_SENTINEL_A",
    S8_TEST_PARENT_SECRET_B: "RUN077_PARENT_SENTINEL_B",
    PATH: "/run077-hostile-path",
    HOME: "/run077-hostile-home",
    LD_PRELOAD: ldPreload,
    LD_LIBRARY_PATH: "/run077-hostile-ld-library-path",
    PYTHONPATH: "/run077-hostile-pythonpath",
    PYTHONHOME: "/run077-hostile-pythonhome",
  };
}

function createFixture(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const hash = "a".repeat(64);
  const sourceFingerprint = "b".repeat(64);
  const object = {
    objectId: "run077-box-001",
    identityKey: "Run-077 deterministic box",
    parentObjectId: null,
    objectType: "box" as const,
    role: "furniture" as const,
    geometry: {
      kind: "rect_prism" as const,
      dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 },
      geometryState: "exact" as const,
      localAnchor: "center" as const,
    },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 },
    materialIds: ["run077-material-001"],
    zoneIds: [],
    requirementIds: [],
    provenance: {
      kind: "user_confirmed_design_decision" as const,
      sourceRef: "run077-deterministic-fixture",
      sourceFingerprint,
      acceptedByUser: true,
      note: null,
    },
    unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId: "77777777-7777-4777-8777-777777777777",
    acceptedRevisionId: "88888888-8888-4888-8888-888888888888",
    acceptedRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: {
      version: "booth-local-right-handed-v1",
      units: "millimetres",
      handedness: "right-handed",
      origin: "north-west-floor-corner",
      xAxis: "east",
      yAxis: "up",
      zAxis: "south",
    },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [object],
    hierarchy: [{ objectId: object.objectId, parentObjectId: null }],
    zones: [],
    requirements: [],
    assumptions: [],
    unknowns: [],
    materials: [{
      materialId: "run077-material-001",
      label: "Neutral blue",
      finishKind: "solid_color",
      colorHex: "#336699",
      source: "user_confirmed_design_decision",
      sourceAssetId: null,
      sourceAssetSha256: null,
      notes: null,
      provenance: {
        kind: "user_confirmed_design_decision",
        sourceRef: "run077-deterministic-fixture",
        sourceFingerprint: hash,
        acceptedByUser: true,
        note: null,
      },
    }],
    validationReceipt: { receiptId: "99999999-9999-4999-8999-999999999999", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1",
    projectId: s6.projectId,
    sourceRevisionId: s6.acceptedRevisionId,
    sourceRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    s7ArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    s7ArtifactHash: hash,
    s7ArtifactByteSize: 1,
    manifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    manifestHash: hash,
    readbackReceiptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1",
    worldToPlanVersion: "s7-world-to-plan-v1",
    coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true,
    s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

function parseLdd(text: string): FileDependency[] {
  const found: FileDependency[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const resolved = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)/u);
    if (resolved) found.push({ soname: resolved[1]!, path: resolved[2]! });
    else {
      const direct = line.match(/^\s*(\/\S+)\s+\(/u);
      if (direct) found.push({ soname: direct[1]!.split("/").at(-1)!, path: direct[1]! });
    }
  }
  return [...new Map(found.map((entry) => [`${entry.soname}\0${entry.path}`, entry])).values()];
}

function measureElf(label: string, path: string): ElfEvidence {
  const bytes = readFileSync(path);
  const stats = statSync(path);
  const programHeaders = outputOf("readelf", ["-lW", path]);
  const dynamicSection = outputOf("readelf", ["-dW", path]);
  const ldd = outputOf("ldd", [path]);
  const interpreter = programHeaders.match(/Requesting program interpreter:\s*(.*?)\]/u)?.[1] ?? "NONE";
  const needed = [...dynamicSection.matchAll(/\(NEEDED\).*?Shared library:\s*\[(.*?)\]/gu)].map((match) => match[1]!);
  const rpathRunpath = [...dynamicSection.matchAll(/\((?:RPATH|RUNPATH)\).*?Library (?:rpath|runpath):\s*\[(.*?)\]/gu)].map((match) => match[1]!);
  const identity = `${realpathSync(path)};size=${stats.size};mode=${(stats.mode & 0o777).toString(8)};dev=${stats.dev};ino=${stats.ino}`;
  return { label, path, sha256: sha256(bytes), fileIdentity: identity, interpreter, needed, rpathRunpath, resolved: parseLdd(ldd) };
}

function emitElf(prefix: string, evidence: ElfEvidence): void {
  emit(`${prefix}_SHA256`, evidence.sha256);
  emit(`${prefix}_FILE_IDENTITY`, evidence.fileIdentity);
  emit(`${prefix}_PT_INTERP`, evidence.interpreter);
  emit(`${prefix}_DT_NEEDED`, evidence.needed);
  emit(`${prefix}_RPATH_RUNPATH`, evidence.rpathRunpath.length ? evidence.rpathRunpath : "NONE");
  emit(`${prefix}_RESOLVED_DEPENDENCIES`, evidence.resolved.map((entry) => `${entry.soname}=>${entry.path}`));
}

function findExecutable(name: string): string | null {
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const directory of paths) {
    const path = join(directory, name);
    if (existsSync(path)) return realpathSync(path);
  }
  for (const path of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(path)) return realpathSync(path);
  }
  return null;
}

function isSharedObject(path: string): boolean {
  return /\.so(?:\.|$)/u.test(path);
}

function systemPath(path: string): boolean {
  return path === "/etc/ld.so.cache" || path.startsWith("/usr/") || path.startsWith("/lib/") || path.startsWith("/lib64/") || path.startsWith("/etc/");
}

function sharedLibraryDirectory(path: string): string | null {
  const directory = dirname(path);
  if (/^\/(?:usr\/)?lib\/x86_64-linux-gnu$/u.test(directory)) return directory;
  return null;
}

function addSurface(surfaces: Map<string, RuntimeSurface>, surface: RuntimeSurface): void {
  const existing = surfaces.get(surface.target);
  if (existing) {
    existing.loadedMembers = [...new Set([...existing.loadedMembers, ...surface.loadedMembers])].sort();
    return;
  }
  surfaces.set(surface.target, surface);
}

function candidateSurfaces(evidence: ElfEvidence[], loadedFiles: string[]): RuntimeSurface[] {
  const surfaces = new Map<string, RuntimeSurface>();
  for (const elf of evidence.filter((item) => item.label === "RUNNER" || item.label === "BLENDER")) {
    if (elf.interpreter !== "NONE") {
      const source = realpathSync(elf.interpreter);
      addSurface(surfaces, {
        id: `interpreter:${elf.interpreter}`,
        kind: "file",
        source,
        target: elf.interpreter,
        loadedMembers: [elf.path],
      });
    }
    for (const dependency of elf.resolved) {
      const directory = sharedLibraryDirectory(dependency.path);
      if (directory) {
        addSurface(surfaces, {
          id: `directory:${directory}`,
          kind: "directory",
          source: realpathSync(directory),
          target: directory,
          loadedMembers: [dependency.path],
        });
      } else {
        const target = dependency.path;
        if (!systemPath(target)) continue;
        addSurface(surfaces, {
          id: `file:${target}`,
          kind: "file",
          source: realpathSync(target),
          target,
          loadedMembers: [dependency.path],
        });
      }
    }
  }
  for (const path of loadedFiles) {
    if (!systemPath(path)) continue;
    if (path === "/etc/ld.so.cache") {
      addSurface(surfaces, {
        id: `file:${path}`,
        kind: "file",
        source: realpathSync(path),
        target: path,
        loadedMembers: [path],
      });
      continue;
    }
    if (!isSharedObject(path)) continue;
    const directory = sharedLibraryDirectory(path);
    if (directory) {
      addSurface(surfaces, {
        id: `directory:${directory}`,
        kind: "directory",
        source: realpathSync(directory),
        target: directory,
        loadedMembers: [path],
      });
    } else {
      addSurface(surfaces, {
        id: `file:${path}`,
        kind: "file",
        source: realpathSync(path),
        target: path,
        loadedMembers: [path],
      });
    }
  }
  return [...surfaces.values()].sort((left, right) => left.target.localeCompare(right.target));
}

function parseStraceLoadedFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const trace = readFileSync(path, "utf8");
  const files = new Set<string>();
  for (const line of trace.split(/\r?\n/u)) {
    if (!/^(?:\d+\s+)?(?:openat|openat2)\(/u.test(line)) continue;
    const match = line.match(/(?:openat|openat2)\([^,]+,\s*"((?:\\.|[^"])*)".*\)\s*=\s*(?:\d+|AT_FDCWD)/u);
    if (!match) continue;
    let pathname = match[1]!.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    if (!pathname.startsWith("/")) continue;
    if (systemPath(pathname)) files.add(pathname);
  }
  rmSync(path, { force: true });
  return [...files].sort();
}

function safeEnvironmentStatus(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(CONTROLLED_KEYS.map((key) => [key, classifyValue(key, environment[key])]));
}

function admitRuntimeSurface(target: string, access: "read-only" | "read-write", allowInitialUpperBound = false): string {
  if (access !== "read-only") throw new Error(`RUNTIME_SURFACE_WRITABLE_REJECTED:${target}`);
  if (target === "/" || ["/usr", "/lib", "/lib64", "/etc"].includes(target)) {
    if (!allowInitialUpperBound) throw new Error(`RUNTIME_SURFACE_BROAD_HOST_ROOT_REJECTED:${target}`);
  }
  if (!target.startsWith("/") || target.includes("/../")) throw new Error(`RUNTIME_SURFACE_TARGET_INVALID:${target}`);
  return "ADMITTED_READ_ONLY";
}

function makeShim(
  root: string,
  bwrapPath: string,
  mode: "current" | "scratch",
  options: { surfaces?: RuntimeSurface[]; childEnvironment?: Record<string, string>; tracePath?: string; trace?: boolean; useLoaderTrace?: boolean; substitute?: RuntimeSurface } = {},
): { path: string; manifestPath: string; tracePath?: string } {
  for (const surface of options.surfaces ?? []) {
    admitRuntimeSurface(surface.target, "read-only", surface.id.startsWith("initial-upper-bound:"));
  }
  const id = `${mode}-${Math.random().toString(16).slice(2)}`;
  const shimPath = join(root, `bwrap-${id}.cjs`);
  const manifestPath = join(root, `bwrap-${id}.manifest.json`);
  const tracePath = options.tracePath ?? join(root, `bwrap-${id}.strace`);
  const embedded = {
    mode,
    bwrapPath,
    manifestPath,
    tracePath,
    stracePath: options.useLoaderTrace ? null : findExecutable("strace"),
    surfaces: options.surfaces ?? [],
    childEnvironment: options.childEnvironment ?? {},
    trace: options.trace === true,
    substitute: options.substitute ?? null,
    environmentKeys: [...CONTROLLED_KEYS],
  };
  const code = `#!${process.execPath}
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const cfg = ${JSON.stringify(embedded)};
const redactText = (value) => String(value || "")
  .replace(/\\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b/g, "[REDACTED]")
  .replace(/(authorization\\s*:\\s*)[^\\s,;]+/gi, "$1[REDACTED]")
  .replace(/((?:GH_TOKEN|GITHUB_TOKEN|token)\\s*[=:]\\s*)[^\\s,;]+/gi, "$1[REDACTED]")
  .replace(/(S8_TEST_PARENT_SECRET_[AB]\\s*[=:]\\s*)[^\\s,;]+/gi, "$1[REDACTED]")
  .replace(/[\\r\\n]+/g, " ").slice(0, 2048);
const classify = (key, value) => {
  if (value === undefined) return "ABSENT";
  if (key === "S8_TEST_PARENT_SECRET_A" && value === "RUN077_PARENT_SENTINEL_A") return "SENTINEL_A";
  if (key === "S8_TEST_PARENT_SECRET_B" && value === "RUN077_PARENT_SENTINEL_B") return "SENTINEL_B";
  if (key === "LD_PRELOAD" && String(value).endsWith("/libm.so.6")) return "HOSTILE_VALID_LIBRARY_PATH";
  return "HOSTILE_VALUE_SET";
};
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const appArgs = process.argv.slice(2);
const originalDigest = hash(appArgs);
let bwrapArgs = appArgs;
const envReport = Object.fromEntries(cfg.environmentKeys.map((key) => [key, classify(key, process.env[key])]));
const manifest = {
  mode: cfg.mode,
  applicationArgvSha256: originalDigest,
  applicationArgvCount: appArgs.length,
  bwrapArgvUnchanged: cfg.mode === "current",
  parentEnvironmentClassification: envReport,
  mounts: [],
  targetCommand: "UNPARSED",
  childEnvironmentKeys: cfg.mode === "scratch" ? Object.keys(cfg.childEnvironment).sort() : null,
  sudoPreservedControls: null,
  exitStatus: null,
  launchError: null,
  underlyingStderr: "",
  runnerReceipt: null,
  traceCaptured: false,
    tracePath: cfg.trace ? cfg.tracePath : null,
};
if (cfg.mode === "scratch") {
  const parsed = (() => {
    const counts = { "--unshare-user": 0, "--unshare-net": 0, "--die-with-parent": 0, "--new-session": 0, "--ro-bind": 2, "--bind": 2, "--chdir": 1, "--proc": 1, "--dev": 1, "--tmpfs": 1, "--dir": 1, "--setenv": 2, "--uid": 1, "--gid": 1 };
    let index = 0;
    while (index < appArgs.length && appArgs[index].startsWith("--")) {
      const count = counts[appArgs[index]];
      if (count === undefined || index + count >= appArgs.length) throw new Error("UNRECOGNIZED_BWRAP_OPTION");
      index += 1 + count;
    }
    if (index >= appArgs.length) throw new Error("BWRAP_TARGET_MISSING");
    return { options: appArgs.slice(0, index), target: appArgs.slice(index) };
  })();
  const mounts = [...cfg.surfaces];
  const adds = [];
  const parentDirs = new Set();
  for (const surface of mounts) {
    let parent = path.posix.dirname(surface.target);
    while (parent !== "/") {
      parentDirs.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const parent of [...parentDirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) adds.push("--dir", parent);
  for (const surface of mounts) {
    const selected = cfg.substitute && cfg.substitute.target === surface.target ? cfg.substitute : surface;
    adds.push("--ro-bind", selected.source, surface.target);
    manifest.mounts.push({ id: surface.id, kind: surface.kind, mode: "read-only", target: surface.target, loadedMemberCount: surface.loadedMembers.length });
  }
  if (cfg.trace && !cfg.stracePath) {
    adds.push("--setenv", "LD_DEBUG", "libs,files", "--setenv", "LD_DEBUG_OUTPUT", "/work/run077-ld-debug");
  }
  bwrapArgs = [...parsed.options, ...adds, ...parsed.target];
  manifest.targetCommand = parsed.target[0];
} else {
  try {
    const counts = { "--unshare-user": 0, "--unshare-net": 0, "--die-with-parent": 0, "--new-session": 0, "--ro-bind": 2, "--bind": 2, "--chdir": 1, "--proc": 1, "--dev": 1, "--tmpfs": 1, "--dir": 1, "--setenv": 2, "--uid": 1, "--gid": 1 };
    let index = 0;
    while (index < appArgs.length && appArgs[index].startsWith("--")) {
      const count = counts[appArgs[index]];
      if (count === undefined || index + count >= appArgs.length) throw new Error("UNRECOGNIZED_BWRAP_OPTION");
      if (appArgs[index] === "--ro-bind" || appArgs[index] === "--bind") {
        manifest.mounts.push({ mode: appArgs[index] === "--ro-bind" ? "read-only" : "read-write", target: appArgs[index + 2] });
      }
      index += 1 + count;
    }
    manifest.targetCommand = appArgs[index] || "UNAVAILABLE";
  } catch { manifest.targetCommand = "UNPARSED"; }
}
if (cfg.mode === "current") {
  try {
    const probe = 'const keys=' + JSON.stringify(cfg.environmentKeys) + '; for (const k of keys) { const v=process.env[k]; let c=v===undefined?"ABSENT":(k==="S8_TEST_PARENT_SECRET_A"&&v==="RUN077_PARENT_SENTINEL_A"?"SENTINEL_A":k==="S8_TEST_PARENT_SECRET_B"&&v==="RUN077_PARENT_SENTINEL_B"?"SENTINEL_B":(k==="LD_PRELOAD"&&v.endsWith("/libm.so.6")?"HOSTILE_VALID_LIBRARY_PATH":"HOSTILE_VALUE_SET")); process.stdout.write(k+"="+c+"\\n"); }';
    const check = cp.spawnSync("/usr/bin/sudo", ["-n", "-E", process.execPath, "-e", probe], { env: process.env, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 });
    const observed = {};
    for (const line of String(check.stdout || "").split(/\\r?\\n/)) { const at = line.indexOf("="); if (at > 0) observed[line.slice(0, at)] = line.slice(at + 1); }
    manifest.sudoPreservedControls = { status: check.status, error: check.error ? "SUDO_ENV_PROBE_FAILED" : null, classifications: observed };
  } catch { manifest.sudoPreservedControls = { status: null, error: "SUDO_ENV_PROBE_FAILED", classifications: {} }; }
}
const childEnvironment = Object.entries(cfg.childEnvironment).map(([key, value]) => key + "=" + value);
let sudoArgs;
if (cfg.mode === "current") {
  sudoArgs = ["-n", "-E", cfg.bwrapPath, ...bwrapArgs];
} else {
  const envArgs = ["/usr/bin/env", "-i", ...childEnvironment, cfg.bwrapPath, ...bwrapArgs];
  if (cfg.trace && cfg.stracePath) sudoArgs = ["-n", cfg.stracePath, "-f", "-qq", "-s", "256", "-e", "trace=file", "-o", cfg.tracePath, "--", ...envArgs];
  else sudoArgs = ["-n", ...envArgs];
}
const child = cp.spawnSync("/usr/bin/sudo", sudoArgs, { env: process.env, encoding: null, timeout: 330000, maxBuffer: 64 * 1024 * 1024 });
manifest.exitStatus = child.status;
manifest.launchError = child.error ? String(child.error.code || child.error.message || "SPAWN_FAILED") : null;
manifest.underlyingStderr = redactText(Buffer.isBuffer(child.stderr) ? child.stderr.toString("utf8") : String(child.stderr || ""));
try {
  const output = Buffer.isBuffer(child.stdout) ? child.stdout.toString("utf8") : String(child.stdout || "");
  const firstLine = output.split(/\\r?\\n/, 1)[0].replace(/^S8_RUNNER_RECEIPT:/, "");
  const receipt = JSON.parse(firstLine);
  manifest.runnerReceipt = { code: receipt.result && receipt.result.code, name: receipt.result && receipt.result.name, terminationClass: receipt.result && receipt.result.terminationClass, targetExit: receipt.result && receipt.result.targetExit, setupStage: receipt.result && receipt.result.setupStage, evidenceCode: receipt.result && receipt.result.evidenceCode };
} catch {}
if (cfg.trace && cfg.stracePath && fs.existsSync(cfg.tracePath)) manifest.traceCaptured = true;
if (cfg.trace && !cfg.stracePath) {
  try {
    const parsed = appArgs;
    const bindAt = parsed.findIndex((value, index) => value === "--bind" && parsed[index + 2] === "/work");
    const work = bindAt >= 0 ? parsed[bindAt + 1] : null;
    if (work && fs.existsSync(work)) {
      const traces = fs.readdirSync(work).filter((name) => name.startsWith("run077-ld-debug."));
      const output = traces.map((name) => fs.readFileSync(path.join(work, name), "utf8")).join("\\n");
      const loaded = [...new Set([...output.matchAll(/(?:calling init:|file=)(\\/[^\\s,;]+)/g)].map((match) => match[1]))].filter((name) => /\\.so(?:\\.|$)/.test(name));
      manifest.loaderLoadedPaths = loaded;
      manifest.traceCaptured = loaded.length > 0;
    }
  } catch { manifest.traceCaptured = false; }
}
try { fs.writeFileSync(cfg.manifestPath, JSON.stringify(manifest), { mode: 0o600 }); } catch {}
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(Buffer.from(manifest.underlyingStderr, "utf8"));
process.exit(typeof child.status === "number" ? child.status : 127);
`;
  writeFileSync(shimPath, code, { mode: 0o700 });
  chmodSync(shimPath, 0o700);
  return { path: shimPath, manifestPath, tracePath: options.trace ? tracePath : undefined };
}

function readManifest(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { unavailable: true };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { invalid: true };
  }
}

function makeConfig(root: string, blenderPath: string, runnerPath: string, validatorPath: string, shimPath: string): S8WorkerConfig {
  const writerRoot = join(root, "writer");
  return {
    blenderRuntimeRoot: dirname(blenderPath),
    blenderExecutable: blenderPath,
    writerScript: join(writerRoot, "writer.py"),
    privateWorkRoot: join(root, "private-work"),
    processRunnerExecutable: runnerPath,
    sandboxExecutable: shimPath,
    nativeValidatorExecutable: validatorPath,
    blenderExecutableSha256: sha256(readFileSync(blenderPath)),
  };
}

function tryWriter(
  root: string,
  bwrapPath: string,
  configPaths: { blender: string; runner: string; validator: string },
  payloadBytes: Buffer,
  mode: "current" | "scratch",
  options: { surfaces?: RuntimeSurface[]; childEnvironment?: Record<string, string>; trace?: boolean; useLoaderTrace?: boolean; parentEnvironment?: Record<string, string>; substitute?: RuntimeSurface } = {},
): LaunchEvidence {
  const shim = makeShim(root, bwrapPath, mode, options);
  const config = makeConfig(root, configPaths.blender, configPaths.runner, configPaths.validator, shim.path);
  let result: ReturnType<typeof runS8BlenderWriter> | undefined;
  let error = "";
  try {
    const action = () => {
      try {
        result = runS8BlenderWriter(payloadBytes, config);
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
    };
    if (options.parentEnvironment && mode === "current") withEnvironmentOverlay(options.parentEnvironment, action);
    else if (options.parentEnvironment) withEnvironment(options.parentEnvironment, action);
    else action();
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const manifest = readManifest(shim.manifestPath);
  if (mode === "scratch" && options.trace && !options.useLoaderTrace && shim.tracePath && existsSync(shim.tracePath)) {
    const loadedFiles = parseStraceLoadedFiles(shim.tracePath);
    manifest.runtimeLoadedFiles = loadedFiles;
    manifest.traceCaptured = loadedFiles.length > 0;
    writeFileSync(shim.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  }
  const stderr = typeof manifest.underlyingStderr === "string" ? redact(manifest.underlyingStderr) : "";
  const stdout = result?.stdout ?? "";
  return { ok: Boolean(result), error: redact(error), stderr, stdout: redact(stdout), manifest, result };
}

function directRunnerTarget(
  runnerPath: string,
  target: string,
  args: string[],
  environment: Record<string, string>,
  cwd: string,
  timeoutMs = 120_000,
): { ok: boolean; status: number | null; receipt: Record<string, unknown> | null; targetStdout: string; stderr: string; error: string } {
  const runnerArgs = [
    "--address-space-bytes", String(1_610_612_736),
    "--file-bytes", String(268_435_456),
    "--timeout-ms", String(timeoutMs),
    "--stdout-bytes", String(8 * 1024 * 1024),
    "--stderr-bytes", String(1024 * 1024),
    "--max-children", "0",
    "--", target, ...args,
  ];
  const child = spawnSync(runnerPath, runnerArgs, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: timeoutMs + 10_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  const output = child.stdout ?? "";
  const newline = output.indexOf("\n");
  let receipt: Record<string, unknown> | null = null;
  let targetStdout = output;
  if (newline >= 0) {
    const firstLine = output.slice(0, newline).replace(/^S8_RUNNER_RECEIPT:/u, "");
    try {
      receipt = JSON.parse(firstLine) as Record<string, unknown>;
      targetStdout = output.slice(newline + 1);
    } catch { /* Keep only the bounded raw output for a safe classification below. */ }
  }
  return {
    ok: child.status === 0 && Boolean(receipt),
    status: child.status,
    receipt,
    targetStdout: redact(targetStdout),
    stderr: redact(child.stderr ?? ""),
    error: child.error?.message ?? "",
  };
}

function envProbe(runnerPath: string, environment: Record<string, string>, root: string): { ok: boolean; keys: string[]; statuses: Record<string, string> } {
  const result = directRunnerTarget(runnerPath, "/usr/bin/env", [], environment, root, 10_000);
  const lines = result.targetStdout.split(/\r?\n/u).filter(Boolean);
  const observed = new Map(lines.map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  const keys = [...observed.keys()].sort();
  const statuses = Object.fromEntries(CONTROLLED_KEYS.map((key) => {
    const value = observed.get(key);
    if (value === undefined) return [key, "ABSENT"];
    if (environment[key] !== undefined && value === environment[key]) return [key, "PRESENT_CANDIDATE_VALUE"];
    return [key, "PRESENT_UNEXPECTED_VALUE"];
  }));
  return { ok: result.ok, keys, statuses };
}

function testSurfacePolicy(root: string): { broad: string; writable: string; outcomes: string[] } {
  const reject = (target: string, access: "read-only" | "read-write") => {
    try {
      return `${access.toUpperCase()}=${admitRuntimeSurface(target, access)}`;
    } catch (error) {
      return `${access.toUpperCase()}=REJECTED:${error instanceof Error ? error.message : "POLICY_REJECTED"}`;
    }
  };
  const broad = reject("/usr", "read-only");
  const rootBroad = reject("/", "read-only");
  const writable = reject("/usr/lib/x86_64-linux-gnu", "read-write");
  const outcomes = [broad, rootBroad, writable];
  const probe = join(root, "writable-host-probe");
  mkdirSync(probe, { mode: 0o700 });
  const before = sha256(readFileSync(join(root, "product-fixture.sha256")));
  const rejected = writable.includes("RUNTIME_SURFACE_WRITABLE_REJECTED");
  const after = sha256(readFileSync(join(root, "product-fixture.sha256")));
  if (before !== after || !rejected) throw new Error("writable host surface negative control failed");
  return { broad: `${broad}; ${rootBroad}`, writable, outcomes };
}

function broadUpperBoundSurfaces(): RuntimeSurface[] {
  return [
    { id: "initial-upper-bound:/usr", kind: "directory", source: "/usr", target: "/usr", loadedMembers: [] },
    { id: "initial-upper-bound:/lib", kind: "directory", source: "/lib", target: "/lib", loadedMembers: [] },
    { id: "initial-upper-bound:/lib64", kind: "directory", source: "/lib64", target: "/lib64", loadedMembers: [] },
    { id: "initial-upper-bound:/etc", kind: "directory", source: "/etc", target: "/etc", loadedMembers: [] },
  ];
}

function substitutionFor(surface: RuntimeSurface, root: string, index: number): RuntimeSurface {
  const source = join(root, `wrong-runtime-surface-${index}`);
  if (surface.kind === "directory") mkdirSync(source, { mode: 0o700 });
  else writeFileSync(source, "RUN077-WRONG-RUNTIME-SURFACE\n", { mode: 0o600 });
  return { ...surface, id: `wrong:${surface.id}`, source };
}

function readGitTree(): { head: string; tree: string; workflowBlob: string; harnessBlob: string; workflowSha256: string; harnessSha256: string } {
  const head = outputOf("git", ["rev-parse", "HEAD"]).trim();
  const tree = outputOf("git", ["rev-parse", "HEAD^{tree}"]).trim();
  const workflowPath = ".github/workflows/s8-run077-runtime-evidence.yml";
  const harnessPath = "scripts/s8/run077_runtime_evidence.ts";
  return {
    head,
    tree,
    workflowBlob: outputOf("git", ["hash-object", workflowPath]).trim(),
    harnessBlob: outputOf("git", ["hash-object", harnessPath]).trim(),
    workflowSha256: sha256(readFileSync(workflowPath)),
    harnessSha256: sha256(readFileSync(harnessPath)),
  };
}

function traceRuntimeFiles(fallbackManifest: Record<string, unknown>): string[] {
  const captured = fallbackManifest.runtimeLoadedFiles;
  if (Array.isArray(captured)) return captured.filter((value): value is string => typeof value === "string" && systemPath(value));
  const fromLoader = fallbackManifest.loaderLoadedPaths;
  return Array.isArray(fromLoader) ? fromLoader.filter((value): value is string => typeof value === "string" && systemPath(value)) : [];
}

function classifyFailure(launch: LaunchEvidence): string {
  const evidence = `${launch.stderr} ${launch.error}`.toLowerCase();
  const runnerReceipt = launch.manifest.runnerReceipt && typeof launch.manifest.runnerReceipt === "object" ? launch.manifest.runnerReceipt as Record<string, unknown> : null;
  if (launch.manifest.launchError === "ENOENT" && !findExecutable("bwrap")) return "HOSTED_BUBBLEWRAP_EXECUTABLE_UNAVAILABLE";
  if (launch.manifest.launchError === "ENOENT" && !existsSync("/usr/bin/sudo")) return "HOSTED_PRIVILEGE_SHIM_UNAVAILABLE";
  if (evidence.includes("/runtime/process-runner") && (evidence.includes("no such file") || evidence.includes("not found"))) return "INNER_PROCESS_RUNNER_EXEC_FAILED_ELF_INTERPRETER_OR_RUNTIME_MISSING";
  if (evidence.includes("bwrap") && (evidence.includes("operation not permitted") || evidence.includes("creating new namespace"))) return "BUBBLEWRAP_PRIVILEGE_OR_NAMESPACE_SETUP_FAILED";
  if (evidence.includes("bwrap") && (evidence.includes("no such file") || evidence.includes("command not found"))) return "HOSTED_BUBBLEWRAP_EXECUTABLE_UNAVAILABLE";
  if (runnerReceipt) return `INNER_RUNNER_TARGET_FAILURE:${String(runnerReceipt.name ?? runnerReceipt.code ?? "UNKNOWN")}`;
  if (launch.ok) return "SUCCESS";
  return "APPLICATION_WORKER_OR_RUNNER_FAILED";
}

function printSurfaceMatrix(records: Array<Record<string, unknown>>): void {
  emit("RUNTIME_SURFACE_REMOVAL_MATRIX", records);
}

async function main(): Promise<void> {
  const root = process.env.S8_RUN077_ROOT;
  if (!root || !existsSync(root)) throw new Error("S8_RUN077_ROOT is missing or not prepared by the workflow");
  const productTree = outputOf("git", ["rev-parse", `${PRODUCT_HEAD}^{tree}`]).trim();
  if (productTree !== PRODUCT_TREE) throw new Error(`product candidate tree mismatch: ${productTree}`);
  outputOf("git", ["merge-base", "--is-ancestor", PRODUCT_HEAD, "HEAD"]);

  const git = readGitTree();
  emit("RUN", "Run-077");
  emit("PRODUCT_HEAD", PRODUCT_HEAD);
  emit("PRODUCT_TREE", PRODUCT_TREE);
  emit("EVIDENCE_CARRIER_HEAD", git.head);
  emit("EVIDENCE_CARRIER_TREE", git.tree);
  emit("EVIDENCE_WORKFLOW_BLOB_OR_SHA256", `${git.workflowBlob}/${git.workflowSha256}`);
  emit("EVIDENCE_TS_HARNESS_BLOB_OR_SHA256", `${git.harnessBlob}/${git.harnessSha256}`);
  emit("EVIDENCE_HARNESS_PATHS", ".github/workflows/s8-run077-runtime-evidence.yml,scripts/s8/run077_runtime_evidence.ts");

  const blenderRoot = join(root, "extracted", "blender-5.2.2-linux-x64");
  const blenderPath = join(blenderRoot, "blender");
  const runnerPath = join(root, "s8-runner", "s8-process-runner");
  const validatorPath = join(root, "s8-validator", "s8-fbx-validator");
  if (!existsSync(blenderPath) || !existsSync(runnerPath) || !existsSync(validatorPath)) throw new Error("normally built targets or pinned Blender are missing");
  if (sha256(readFileSync(join(root, "blender-5.2.2-linux-x64.tar.xz"))) !== BLENDER_ARCHIVE_SHA256) throw new Error("pinned Blender archive digest mismatch");
  mkdirSync(join(root, "private-work"), { mode: 0o700 });
  const writerRoot = join(root, "writer");
  if (!existsSync(writerRoot)) {
    mkdirSync(writerRoot, { mode: 0o700 });
    const copy = run("cp", ["-a", "blender/s8-fbx-writer/.", writerRoot]);
    if (copy.status !== 0) throw new Error(`candidate Writer staging failed: ${redact(copy.stderr || copy.error)}`);
  }
  const writerPath = join(writerRoot, "writer.py");
  const privateExporterPath = join(writerRoot, "export_fbx_bin.py");
  const patchManifestPath = join(writerRoot, "patch-manifest.json");
  for (const path of [writerPath, privateExporterPath, patchManifestPath]) if (!existsSync(path)) throw new Error(`candidate Writer identity input missing: ${path}`);
  emit("BLENDER_ARCHIVE_SHA256", BLENDER_ARCHIVE_SHA256);
  emit("WRITER_SHA256", sha256(readFileSync(writerPath)));
  emit("PRIVATE_EXPORTER_SHA256", sha256(readFileSync(privateExporterPath)));
  emit("EXPORTER_PATCH_MANIFEST_SHA256", sha256(readFileSync(patchManifestPath)));

  const runner = measureElf("RUNNER", runnerPath);
  const validator = measureElf("VALIDATOR", validatorPath);
  const blender = measureElf("BLENDER", blenderPath);
  emitElf("RUNNER", runner);
  emitElf("VALIDATOR", validator);
  emitElf("BLENDER", blender);

  const { s6, s7 } = createFixture();
  const built = buildS8WriterPayload(s6, s7);
  writeFileSync(join(root, "product-fixture.sha256"), built.sha256, { mode: 0o600 });
  emit("BUILDS8WRITERPAYLOAD", `PASS;PAYLOAD_SHA256=${built.sha256};BYTE_SIZE=${built.bytes.length};SOURCE=S6+S7 deterministic fixture`);

  const ldPreload = runner.resolved.find((entry) => entry.soname === "libm.so.6")?.path ?? "/lib/x86_64-linux-gnu/libm.so.6";
  const controls = hostileParentEnvironment(ldPreload);
  const bwrapPath = findExecutable("bwrap") ?? "/usr/bin/bwrap";
  emit("HOST_BWRAP_PATH", findExecutable("bwrap") ?? "NOT_FOUND_AT_STANDARD_PATHS");
  const current = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "current", { parentEnvironment: controls });
  const currentError = current.ok ? "SUCCESS_UNEXPECTED_FOR_UNCHANGED_CANDIDATE" : current.error || "APPLICATION_THROWN";
  const currentFailureBoundary = classifyFailure(current);
  emit("CURRENT_APPLICATION_WRITER_LAUNCH_RESULT", current.ok ? "UNEXPECTED_PASS" : `FAIL;CLASSIFICATION=${currentError}`);
  emit("CURRENT_APPLICATION_WRITER_FAILURE_BOUNDARY", currentFailureBoundary);
  emit("CURRENT_APPLICATION_BWRAP_ARGV_DIGEST_OR_BOUNDED_MANIFEST", {
    sha256: current.manifest.applicationArgvSha256 ?? "UNAVAILABLE",
    count: current.manifest.applicationArgvCount ?? "UNAVAILABLE",
    unchanged: current.manifest.bwrapArgvUnchanged ?? false,
    targetCommand: current.manifest.targetCommand ?? "UNAVAILABLE",
    mounts: current.manifest.mounts ?? [],
    parentEnvironmentClassification: current.manifest.parentEnvironmentClassification ?? safeEnvironmentStatus(controls),
    sudoPreservedControls: current.manifest.sudoPreservedControls ?? "UNAVAILABLE",
    runnerReceipt: current.manifest.runnerReceipt ?? "UNAVAILABLE",
    launchError: current.manifest.launchError ?? "NONE",
    underlyingStderr: current.stderr || current.manifest.underlyingStderr || "<empty-or-unavailable>",
  });
  emit("CURRENT_PARENT_ENV_SENTINEL_INHERITANCE", {
    applicationToShim: current.manifest.parentEnvironmentClassification ?? safeEnvironmentStatus(controls),
    privilegeShim: current.manifest.sudoPreservedControls ?? "UNAVAILABLE",
    runnerOrTarget: current.ok ? "TARGET_REACHED; SEE_SCRATCH_NEGATIVE_CONTROL" : "TARGET_NOT_REACHED_BECAUSE_CURRENT_LAUNCH_FAILED",
  });

  const runtimeRecords: Array<Record<string, unknown>> = [];
  let runtimeEvidenceComplete = false;
  let environmentEvidenceComplete = false;
  let runtimeLoaded: string[] = [];
  let finalSurfaces: RuntimeSurface[] = [];
  let writerArtifact: Buffer | undefined;
  let writerReceipt: Record<string, unknown> | undefined;
  let validatorApplicationResult = "NOT_RUN";
  let positiveWriterResult = "NOT_RUN";
  let positiveValidatorResult = "NOT_RUN";
  let envCandidate: Record<string, string> = {};
  let envProbeResult: { ok: boolean; keys: string[]; statuses: Record<string, string> } | null = null;
  let hostileWriter: LaunchEvidence | null = null;

  const bwrapAvailable = Boolean(findExecutable("bwrap"));
  const stracePath = findExecutable("strace");
  const policy = testSurfacePolicy(root);
  emit("BROAD_HOST_SURFACE_NEGATIVE_CONTROL", policy.broad);
  emit("WRITABLE_HOST_SURFACE_NEGATIVE_CONTROL", policy.writable);

  if (bwrapAvailable) {
    let broadRun = tryWriter(
      root,
      bwrapPath,
      { blender: blenderPath, runner: runnerPath, validator: validatorPath },
      built.bytes,
      "scratch",
      { surfaces: broadUpperBoundSurfaces(), childEnvironment: envCandidate, trace: true },
    );
    const envDiscovery: Array<Record<string, unknown>> = [];
    if (!broadRun.ok && findExecutable("strace")) {
      const loaderTraceRun = tryWriter(
        root,
        bwrapPath,
        { blender: blenderPath, runner: runnerPath, validator: validatorPath },
        built.bytes,
        "scratch",
        { surfaces: broadUpperBoundSurfaces(), childEnvironment: envCandidate, trace: true, useLoaderTrace: true },
      );
      envDiscovery.push({ probe: "ELF_LOADER_TRACE_FALLBACK", result: loaderTraceRun.ok ? "PASS" : `FAIL_${classifyFailure(loaderTraceRun)}` });
      if (loaderTraceRun.ok) broadRun = loaderTraceRun;
    }
    if (!broadRun.ok && !["HOSTED_BUBBLEWRAP_EXECUTABLE_UNAVAILABLE", "HOSTED_PRIVILEGE_SHIM_UNAVAILABLE", "BUBBLEWRAP_PRIVILEGE_OR_NAMESPACE_SETUP_FAILED", "INNER_PROCESS_RUNNER_EXEC_FAILED_ELF_INTERPRETER_OR_RUNTIME_MISSING"].includes(classifyFailure(broadRun))) {
      const untracedRun = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: envCandidate });
      envDiscovery.push({ probe: "UNTRACED_UPPER_BOUND_POSITIVE_CONTROL", result: untracedRun.ok ? "PASS" : `FAIL_${classifyFailure(untracedRun)}` });
      if (untracedRun.ok) broadRun = untracedRun;
    }
    if (!broadRun.ok && !["HOSTED_BUBBLEWRAP_EXECUTABLE_UNAVAILABLE", "HOSTED_PRIVILEGE_SHIM_UNAVAILABLE", "BUBBLEWRAP_PRIVILEGE_OR_NAMESPACE_SETUP_FAILED", "INNER_PROCESS_RUNNER_EXEC_FAILED_ELF_INTERPRETER_OR_RUNTIME_MISSING"].includes(classifyFailure(broadRun))) {
      let foundEnvironment = false;
      for (const key of ENVIRONMENT_KEYS) {
        const trialEnvironment = { [key]: FIXED_ENV_CANDIDATES[key]! };
        const trial = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: trialEnvironment });
        envDiscovery.push({ keys: [key], result: trial.ok ? "PASS" : `FAIL_${classifyFailure(trial)}` });
        if (trial.ok) {
          envCandidate = trialEnvironment;
          foundEnvironment = true;
          break;
        }
      }
      if (!foundEnvironment) {
        searchPairs: for (let left = 0; left < ENVIRONMENT_KEYS.length; left += 1) {
          for (let right = left + 1; right < ENVIRONMENT_KEYS.length; right += 1) {
            const keyA = ENVIRONMENT_KEYS[left]!;
            const keyB = ENVIRONMENT_KEYS[right]!;
            const trialEnvironment = { [keyA]: FIXED_ENV_CANDIDATES[keyA]!, [keyB]: FIXED_ENV_CANDIDATES[keyB]! };
            const trial = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: trialEnvironment });
            envDiscovery.push({ keys: [keyA, keyB], result: trial.ok ? "PASS" : `FAIL_${classifyFailure(trial)}` });
            if (trial.ok) {
              envCandidate = trialEnvironment;
              foundEnvironment = true;
              break searchPairs;
            }
          }
        }
      }
      if (foundEnvironment) {
        const minimalKeys = Object.keys(envCandidate);
        for (const key of minimalKeys) {
          const trialEnvironment = Object.fromEntries(Object.entries(envCandidate).filter(([candidate]) => candidate !== key));
          const trial = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: trialEnvironment });
          envDiscovery.push({ omittedKey: key, result: trial.ok ? "PASS_KEY_UNNECESSARY" : `FAIL_KEY_REQUIRED:${FIXED_ENV_CANDIDATES[key]}` });
          if (trial.ok) envCandidate = trialEnvironment;
        }
      }
      if (foundEnvironment) {
        broadRun = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: envCandidate, trace: true });
        if (!broadRun.ok && findExecutable("strace")) {
          const loaderTraceRun = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: broadUpperBoundSurfaces(), childEnvironment: envCandidate, trace: true, useLoaderTrace: true });
          envDiscovery.push({ probe: "ELF_LOADER_TRACE_FALLBACK_AFTER_ENV_ADDITION", result: loaderTraceRun.ok ? "PASS" : `FAIL_${classifyFailure(loaderTraceRun)}` });
          if (loaderTraceRun.ok) broadRun = loaderTraceRun;
        }
      }
    }
    emit("CHILD_ENV_DISCOVERY_TRIALS", envDiscovery);
    emit("CHILD_ENV_CANDIDATE_AFTER_POSITIVE_CONTROL", envCandidate);
    if (broadRun.ok && broadRun.result) {
      writerArtifact = broadRun.result.artifact;
      writerReceipt = broadRun.result.receipt as unknown as Record<string, unknown>;
      positiveWriterResult = "PASS_WITH_INITIAL_BROAD_READ_ONLY_UPPER_BOUND_AND_EMPTY_CHILD_ENV";
      runtimeLoaded = traceRuntimeFiles(broadRun.manifest);
      emit("BLENDER_RUNTIME_LOADED_DEPENDENCIES", runtimeLoaded);
      emit("RUNTIME_LOAD_MECHANISM", runtimeLoaded.length ? (stracePath && broadRun.manifest.traceCaptured ? "strace -f -e trace=file (existing host tool)" : "LD_DEBUG=libs,files (existing ELF loader diagnostics)") : (stracePath ? "strace present but no successful file-load set was captured" : "NO_READ_ONLY_RUNTIME_LOAD_MECHANISM_AVAILABLE"));
      emit("PINNED_BLENDER_RUNTIME_RECEIPT", {
        version: writerReceipt.runtime && (writerReceipt.runtime as Record<string, unknown>).blenderVersion,
        buildHash: writerReceipt.runtime && (writerReceipt.runtime as Record<string, unknown>).blenderBuildHash,
        binarySha256: writerReceipt.runtime && (writerReceipt.runtime as Record<string, unknown>).blenderBinarySha256,
        exporterVersion: writerReceipt.runtime && (writerReceipt.runtime as Record<string, unknown>).exporterVersion,
        privatePatch: writerReceipt.runtime && (writerReceipt.runtime as Record<string, unknown>).privateExporterPatch,
      });

      const measured = candidateSurfaces([runner, blender], runtimeLoaded);
      emit("MEASURED_SURFACES_BEFORE_MINIMIZATION", measured.map((surface) => ({ id: surface.id, kind: surface.kind, target: surface.target, loadedMembers: surface.loadedMembers })));
      finalSurfaces = [...measured];
      for (const surface of measured) {
        const without = finalSurfaces.filter((candidate) => candidate.target !== surface.target);
        const result = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: without, childEnvironment: envCandidate });
        if (result.ok) {
          finalSurfaces = without;
          runtimeRecords.push({ SURFACE: surface.target, WHY_REQUIRED: "Not required; omitted from minimized candidate", BOUND_EXECUTABLE_OR_RUNTIME_LOAD: surface.loadedMembers, REMOVAL_RESULT: "PASS_TARGET_STILL_EXECUTED", SUBSTITUTION_RESULT: "NOT_PROPOSED" });
        } else {
          runtimeRecords.push({ SURFACE: surface.target, WHY_REQUIRED: "Required by measured ELF dependency or actual runtime load", BOUND_EXECUTABLE_OR_RUNTIME_LOAD: surface.loadedMembers, REMOVAL_RESULT: `FAIL_${classifyFailure(result)}; ${result.stderr || result.error}`, SUBSTITUTION_RESULT: "PENDING_FINAL_CANDIDATE" });
        }
      }

      const removalOutcomes = new Map<string, string>();
      let minimizationStable = false;
      for (let pass = 0; pass < measured.length + 1 && !minimizationStable; pass += 1) {
        minimizationStable = true;
        for (const surface of [...finalSurfaces]) {
          const without = finalSurfaces.filter((candidate) => candidate.target !== surface.target);
          const result = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: without, childEnvironment: envCandidate });
          removalOutcomes.set(surface.target, result.ok ? "PASS_TARGET_STILL_EXECUTED" : `FAIL_${classifyFailure(result)}; ${result.stderr || result.error}`);
          if (result.ok) {
            finalSurfaces = without;
            minimizationStable = false;
          }
        }
      }

      const finalWriter = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: finalSurfaces, childEnvironment: envCandidate });
      if (finalWriter.ok && finalWriter.result) {
        writerArtifact = finalWriter.result.artifact;
        writerReceipt = finalWriter.result.receipt as unknown as Record<string, unknown>;
        positiveWriterResult = "PASS_WITH_MINIMIZED_READ_ONLY_RUNTIME_SURFACES_AND_EMPTY_CHILD_ENV";
      } else {
        positiveWriterResult = `FAIL_${classifyFailure(finalWriter)}; ${finalWriter.stderr || finalWriter.error}`;
      }

      let allRemovalFailures = finalSurfaces.length > 0;
      const finalMatrix: Array<Record<string, unknown>> = [];
      for (let index = 0; index < finalSurfaces.length; index += 1) {
        const surface = finalSurfaces[index]!;
        const removalResult = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: finalSurfaces.filter((candidate) => candidate.target !== surface.target), childEnvironment: envCandidate });
        const substitute = substitutionFor(surface, root, index);
        const substitutionResult = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: finalSurfaces, childEnvironment: envCandidate, substitute });
        const removalStatus = removalResult.ok ? "PASS_TARGET_STILL_EXECUTED" : `FAIL_${classifyFailure(removalResult)}`;
        const substitutionStatus = substitutionResult.ok ? "PASS_TARGET_STILL_EXECUTED_WITH_SUBSTITUTION" : `FAIL_${classifyFailure(substitutionResult)}`;
        if (removalResult.ok || substitutionResult.ok) allRemovalFailures = false;
        finalMatrix.push({
          SURFACE: surface.target,
          WHY_REQUIRED: "Bound read-only because the normal runner/Blender ELF loader or measured runtime load resolves members here",
          BOUND_EXECUTABLE_OR_RUNTIME_LOAD: surface.loadedMembers,
          REMOVAL_RESULT: removalStatus,
          SUBSTITUTION_RESULT: substitutionStatus,
        });
      }
      const interpreter = [...new Set([runner.interpreter, blender.interpreter].filter((value) => value !== "NONE"))];
      const interpreterRemoval = finalSurfaces.filter((surface) => !interpreter.includes(surface.target));
      const interpreterControl = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", { surfaces: interpreterRemoval, childEnvironment: envCandidate });
      emit("ELF_INTERPRETER_REMOVAL_RESULT", interpreterControl.ok ? "FAIL_CONTROL_INTERPRETER_OMISSION_STILL_EXECUTED" : `PASS_OMISSION_FAILED_${classifyFailure(interpreterControl)}; ${interpreterControl.stderr || interpreterControl.error}`);
      finalMatrix.push({ SURFACE: "UNADMITTED_EXTRA:/usr", WHY_REQUIRED: "Broad host surface is not part of the measured minimum", BOUND_EXECUTABLE_OR_RUNTIME_LOAD: [], REMOVAL_RESULT: policy.broad, SUBSTITUTION_RESULT: "NOT_EXECUTED_BY_FAIL_CLOSED_POLICY" });
      finalMatrix.push({ SURFACE: "UNADMITTED_RW:/usr/lib/x86_64-linux-gnu", WHY_REQUIRED: "Runtime surfaces must be read-only; only /work is writable", BOUND_EXECUTABLE_OR_RUNTIME_LOAD: [], REMOVAL_RESULT: policy.writable, SUBSTITUTION_RESULT: "NOT_EXECUTED_BY_FAIL_CLOSED_POLICY" });
      printSurfaceMatrix(finalMatrix);
      emit("RUNTIME_SURFACE_CANDIDATE", finalSurfaces.map((surface) => `${surface.kind}:${surface.source}->${surface.target}:RO`));
      emit("RUNTIME_SURFACE_JUSTIFICATION", finalSurfaces.map((surface) => ({ surface: surface.target, concreteMembers: surface.loadedMembers })));

      if (writerArtifact) {
        const artifactPath = join(root, "run077-artifact.fbx");
        writeFileSync(artifactPath, writerArtifact, { mode: 0o600 });
        const validatorResult = withEnvironment({}, () => {
          try {
            const appConfig = makeConfig(root, blenderPath, runnerPath, validatorPath, current.manifest.unavailable ? "/usr/bin/bwrap" : bwrapPath);
            const result = runS8NativeValidator(writerArtifact!, appConfig);
            return { ok: true, readback: result.readback, identity: result.validatorIdentity };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? redact(error.message) : "VALIDATOR_APP_FUNCTION_FAILED" };
          }
        });
        validatorApplicationResult = validatorResult.ok ? "PASS_ACTUAL_RUNS8NATIVEVALIDATOR" : `FAIL_${validatorResult.error}`;
        const direct = directRunnerTarget(runnerPath, validatorPath, [artifactPath], {}, root, 120_000);
        positiveValidatorResult = direct.ok ? "PASS_NORMALLY_BUILT_VALIDATOR_WITH_EMPTY_CHILD_ENV" : `FAIL_STATUS_${direct.status}; ${direct.stderr || direct.error}`;
        envProbeResult = envProbe(runnerPath, {}, root);
        emit("ACTUAL_RUNS8NATIVEVALIDATOR_RESULT", validatorApplicationResult);
        emit("DIRECT_RUNNER_VALIDATOR_EMPTY_ENV_RESULT", positiveValidatorResult);
        emit("EMPTY_ENV_RUNNER_PROBE", envProbeResult);

        const candidateKeys = Object.keys(envCandidate).sort();
        if (!current.ok && currentFailureBoundary === "INNER_PROCESS_RUNNER_EXEC_FAILED_ELF_INTERPRETER_OR_RUNTIME_MISSING" && finalWriter.ok && direct.ok && validatorResult.ok && envProbeResult.ok && JSON.stringify(envProbeResult.keys) === JSON.stringify(candidateKeys) && allRemovalFailures && !interpreterControl.ok) {
          runtimeEvidenceComplete = runtimeLoaded.length > 0 && finalSurfaces.length > 0;
          environmentEvidenceComplete = true;
        }

        hostileWriter = tryWriter(root, bwrapPath, { blender: blenderPath, runner: runnerPath, validator: validatorPath }, built.bytes, "scratch", {
          surfaces: finalSurfaces,
          childEnvironment: envCandidate,
          parentEnvironment: hostileParentEnvironment(ldPreload),
        });
        const hostileValidator = directRunnerTarget(runnerPath, validatorPath, [artifactPath], envCandidate, root, 120_000);
        const hostileEnvProbe = envProbe(runnerPath, envCandidate, root);
        emit("CHILD_ENV_NEGATIVE_CONTROLS", {
          injectedParentKeys: Object.fromEntries(CONTROLLED_KEYS.map((key) => [key, classifyValue(key, hostileParentEnvironment(ldPreload)[key])])),
          writerTargetSuccess: hostileWriter.ok,
          writerTargetEnvironmentKeys: hostileWriter.manifest.childEnvironmentKeys ?? "UNAVAILABLE",
          validatorTargetSuccess: hostileValidator.ok,
          validatorObservedControlKeys: hostileEnvProbe.statuses,
        });
        const writerTargetKeys = Array.isArray(hostileWriter.manifest.childEnvironmentKeys) ? [...hostileWriter.manifest.childEnvironmentKeys as string[]].sort() : [];
        const forbiddenSecretKeysAbsent = ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B"].every((key) => hostileEnvProbe.statuses[key] === "ABSENT");
        const hostileValuesReplaced = ["PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"].every((key) => {
          const expected = Object.hasOwn(envCandidate, key) ? "PRESENT_CANDIDATE_VALUE" : "ABSENT";
          return hostileEnvProbe.statuses[key] === expected;
        });
        if (!hostileWriter.ok || !hostileValidator.ok || !hostileEnvProbe.ok || JSON.stringify(writerTargetKeys) !== JSON.stringify(candidateKeys) || JSON.stringify(hostileEnvProbe.keys) !== JSON.stringify(candidateKeys) || !forbiddenSecretKeysAbsent || !hostileValuesReplaced) environmentEvidenceComplete = false;
      }

      emit("RUNTIME_MINIMIZATION_STABILITY", minimizationStable ? "STABLE" : "NOT_STABLE");
      emit("RUNTIME_REMOVAL_OUTCOMES", Object.fromEntries(removalOutcomes));
      emit("RUNTIME_SUBSTITUTION_CONTROLS", finalMatrix.filter((record) => String(record.SURFACE).startsWith("/")));
    } else {
      emit("BLENDER_RUNTIME_LOADED_DEPENDENCIES", "NOT_ESTABLISHED; INITIAL_UPPER_BOUND_WRITER_FAILED");
      emit("RUNTIME_LOAD_MECHANISM", stracePath ? "strace available but actual writer startup did not reach target" : "strace and loader trace unavailable or actual writer startup did not reach target");
      emit("RUNTIME_SURFACE_CANDIDATE", "NOT_ESTABLISHED");
      emit("RUNTIME_SURFACE_JUSTIFICATION", "NO SCRATCH POSITIVE CONTROL");
      printSurfaceMatrix(runtimeRecords);
      emit("ELF_INTERPRETER_REMOVAL_RESULT", "NOT_RUN; INITIAL UPPER BOUND DID NOT EXECUTE");
      emit("SCRATCH_UPPER_BOUND_WRITER_RESULT", { classification: classifyFailure(broadRun), error: broadRun.error, stderr: broadRun.stderr });
    }
  } else {
    emit("BLENDER_RUNTIME_LOADED_DEPENDENCIES", "NOT_ESTABLISHED; HOST BUBBLEWRAP NOT AVAILABLE; SYSTEM PACKAGES NOT INSTALLED");
    emit("RUNTIME_LOAD_MECHANISM", stracePath ? "strace available but Bubblewrap unavailable" : "strace unavailable and Bubblewrap unavailable");
    emit("RUNTIME_SURFACE_CANDIDATE", "NOT_ESTABLISHED");
    emit("RUNTIME_SURFACE_JUSTIFICATION", "NO SCRATCH BUBBLEWRAP RUNTIME");
    emit("RUNTIME_SURFACE_REMOVAL_MATRIX", [{ SURFACE: "/lib64/ELF_INTERPRETER", WHY_REQUIRED: "PT_INTERP measured above; no Bubblewrap runtime available for a controlled scratch mount", BOUND_EXECUTABLE_OR_RUNTIME_LOAD: [runner.interpreter, blender.interpreter], REMOVAL_RESULT: "NOT_RUN", SUBSTITUTION_RESULT: "NOT_RUN" }]);
    emit("ELF_INTERPRETER_REMOVAL_RESULT", "NOT_RUN; BUBBLEWRAP UNAVAILABLE");
  }

  if (!positiveWriterResult.startsWith("PASS") && writerArtifact === undefined) {
    emit("CHILD_ENV_POSITIVE_REAL_TARGET_RESULT", `BLENDER_WRITER=${positiveWriterResult}; NATIVE_VALIDATOR=NOT_RUN_NO_VALID_FBXS`);
  } else {
    emit("CHILD_ENV_POSITIVE_REAL_TARGET_RESULT", `BLENDER_WRITER=${positiveWriterResult}; NATIVE_VALIDATOR=${positiveValidatorResult}; ACTUAL_APP_VALIDATOR=${validatorApplicationResult}; ENV_CANDIDATE=${JSON.stringify(envCandidate)}`);
  }
  emit("MINIMUM_CHILD_ENV_CANDIDATE", envCandidate);
  emit("CHILD_ENV_REQUIRED_KEYS", Object.keys(envCandidate).length ? envCandidate : "NONE");
  emit("CHILD_ENV_UNNECESSARY_KEYS", Object.keys(envCandidate).length ? ENVIRONMENT_KEYS.filter((key) => !(key in envCandidate)) : ENVIRONMENT_KEYS);
  emit("CHILD_ENV_REQUIRED_KEY_JUSTIFICATION", Object.entries(envCandidate).map(([key, value]) => ({ key, fixedValue: value, whyRequired: "A scratch real-target run passed with this value; a subsequent omission control failed before admitting it to the minimum." })));
  emit("CHILD_ENV_FORBIDDEN_KEYS", ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B", "hostile PATH/HOME/LD_PRELOAD/LD_LIBRARY_PATH/PYTHONPATH/PYTHONHOME values"]);
  emit("CHILD_ENV_ADJUDICATION", Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, Object.hasOwn(envCandidate, key) ? `REQUIRED:${envCandidate[key]}` : "UNNECESSARY:ABSENT_DURING_SUCCESSFUL_DEFAULT_DENY_TARGET_RUNS"])));
  emit("G4_075_01_EVIDENCE_COMPLETE", runtimeEvidenceComplete ? "YES" : "NO");
  emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", environmentEvidenceComplete ? "YES" : "NO");
  emit("EVIDENCE_LIMITATIONS", [
    current.ok ? "current Writer unexpectedly passed unchanged" : currentFailureBoundary !== "INNER_PROCESS_RUNNER_EXEC_FAILED_ELF_INTERPRETER_OR_RUNTIME_MISSING" ? `current application Writer launch failed outside the measured ELF runtime boundary: ${currentFailureBoundary}` : undefined,
    !runtimeEvidenceComplete ? "minimum read-only runtime surfaces lack a complete successful/removal/substitution matrix" : undefined,
    !environmentEvidenceComplete ? "default-deny child environment lacks successful real-target positive and negative controls" : undefined,
  ].filter((entry): entry is string => Boolean(entry)));
  emit("PRODUCT_PR_MUTATED", "NO");
  emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
  emit("RETURN_TO_WEB", "YES");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? redact(error.message) : "UNKNOWN_EVIDENCE_HARNESS_FAILURE";
  emit("EVIDENCE_HARNESS_FAILURE", message);
  emit("G4_075_01_EVIDENCE_COMPLETE", "NO");
  emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", "NO");
  emit("RETURN_TO_WEB", "YES");
  process.exitCode = 1;
});
