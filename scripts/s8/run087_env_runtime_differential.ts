import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { buildS8WriterPayload } from "../../src/lib/s8-fbx-payload";
import { validateS8Readback } from "../../src/lib/s8";
import { runS8BlenderWriter, runS8NativeValidator, type S8WorkerConfig } from "../../src/lib/s8-fbx-worker";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../../src/lib/types";

type EnvKey = "PATH" | "LANG" | "LC_ALL" | "HOME";
type Mode = "SUBSET" | "FOUR_KEY_CONTROL" | "INVALID";
type Snapshot = { owner: number; group: number; mode: string; device: number; inode: number; bytes: number; sha256: string; access: string[]; defaultAcl: string[] };
type Boundary = { status: string; target: string; attempts: number; successful: number; keys: string[]; count: number; traceLines: number; execveLines: number; targetMatches: number; parseErrors: number };
type Request = {
  operation: "writer";
  resultPath: string;
  payloadPath: string;
  config: S8WorkerConfig;
  controls: { prefix: string; bubblewrap: string; target: string; observer: string; runnerUid: number; runnerGid: number; mode: Mode; envKeys: EnvKey[]; observe: boolean; runtimeSurfaces: string[] };
};
type AppStatus = { domainBPresent: boolean; ok: boolean; code: string };
type RunnerSummary = { code: number; name: string; terminationClass: string; targetExit: number | null; targetSignal: number | null; setupStage: string | null; evidenceCode: string | null };
type LaunchDiagnostic = {
  bwrapStatus: number | null;
  runnerStdoutBytes: number;
  runnerStdoutFirstLine: "EMPTY" | "RECEIPT_SUMMARY" | "RECEIPT_UNPARSED" | "NON_RECEIPT";
  runnerStderrBytes: number;
  runnerStderrClass: string;
  runnerStderrSummary: string;
  wrapperStderrBytes: number;
  wrapperStderrClass: string;
  wrapperStderrSummary: string;
};
type WriterRun = {
  ok: boolean; code: string; domainBPresent: boolean; artifactPath: string; artifactBytes: number; artifactSha256: string;
  argv?: string[]; boundary?: Boundary; runner?: RunnerSummary; launchDiagnostic: LaunchDiagnostic; modeRejected: boolean; workContract: boolean;
  snapshots: { hostedPre?: Snapshot; post?: Snapshot };
};
type Trial = { writer: WriterRun; validator: string; validatorReceipt: boolean; passed: boolean; contract: ReturnType<typeof bwrapContract> };

const RUN = "S8_G0B_PR47_ENV_RUNTIME_ORTHOGONAL_DIFFERENTIAL_EVIDENCE_087";
const LOCK = "DL-SD-S8-G0B-PR47-ENV-RUNTIME-ORTHOGONAL-DIFFERENTIAL-EVIDENCE-001";
const PRODUCT_HEAD = "2f71e472849055ab8814f7e38d0f8c321707275f";
const PRODUCT_TREE = "c72036fdc685ad3a78e2b696df212476c1dade36";
const BASE = "578ac98aa974fa0ec3a65bcade1c505ac5c80dcb";
const PRODUCT_BRANCH = "codex/s8-g3-native-process-boundary-hosted-carrier-001";
const CARRIER_BRANCH = "web/run-087-s8-env-runtime-differential-evidence-001";
const WRITER_TIMEOUT = 300_000;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ENV_KEY_ORDER: EnvKey[] = ["PATH", "LANG", "LC_ALL", "HOME"];
const ENV_VALUES: Record<EnvKey, string> = { PATH: SAFE_PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/tmp" };
const DOMAIN_B: Record<string, string> = {
  S8_TEST_PARENT_SECRET_A: "S8_RUN087_PARENT_SECRET_A_SENTINEL",
  S8_TEST_PARENT_SECRET_B: "S8_RUN087_PARENT_SECRET_B_SENTINEL",
  PATH: "S8_RUN087_HOSTILE_PATH_SENTINEL",
  HOME: "S8_RUN087_HOSTILE_HOME_SENTINEL",
  LD_PRELOAD: "/tmp/S8_RUN087_HOSTILE_LD_PRELOAD_SENTINEL.so",
  LD_LIBRARY_PATH: "/tmp/S8_RUN087_HOSTILE_LD_LIBRARY_PATH_SENTINEL",
  PYTHONPATH: "/tmp/S8_RUN087_HOSTILE_PYTHONPATH_SENTINEL",
  PYTHONHOME: "/tmp/S8_RUN087_HOSTILE_PYTHONHOME_SENTINEL",
};
const HOSTILE_KEYS = Object.keys(DOMAIN_B);
const DOMAIN_A_FORBIDDEN = ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"];
const CORE_RUNTIME = [
  "/lib64/ld-linux-x86-64.so.2",
  "/lib/x86_64-linux-gnu/libGL.so.1", "/lib/x86_64-linux-gnu/libGLX.so.0", "/lib/x86_64-linux-gnu/libGLdispatch.so.0",
  "/lib/x86_64-linux-gnu/libICE.so.6", "/lib/x86_64-linux-gnu/libSM.so.6", "/lib/x86_64-linux-gnu/libX11.so.6",
  "/lib/x86_64-linux-gnu/libXau.so.6", "/lib/x86_64-linux-gnu/libXdmcp.so.6", "/lib/x86_64-linux-gnu/libXext.so.6",
  "/lib/x86_64-linux-gnu/libXfixes.so.3", "/lib/x86_64-linux-gnu/libXi.so.6", "/lib/x86_64-linux-gnu/libXrender.so.1",
  "/lib/x86_64-linux-gnu/libbsd.so.0", "/lib/x86_64-linux-gnu/libc.so.6", "/lib/x86_64-linux-gnu/libdl.so.2",
  "/lib/x86_64-linux-gnu/libgcc_s.so.1", "/lib/x86_64-linux-gnu/libm.so.6", "/lib/x86_64-linux-gnu/libmd.so.0",
  "/lib/x86_64-linux-gnu/libpthread.so.0", "/lib/x86_64-linux-gnu/librt.so.1", "/lib/x86_64-linux-gnu/libstdc++.so.6",
  "/lib/x86_64-linux-gnu/libutil.so.1", "/lib/x86_64-linux-gnu/libuuid.so.1", "/lib/x86_64-linux-gnu/libxcb.so.1",
  "/lib/x86_64-linux-gnu/libxkbcommon.so.0",
];
const SUPPORT6 = [
  "/etc/group", "/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/passwd",
  "/lib/x86_64-linux-gnu/libnss_files.so.2", "/usr/lib/locale/locale-archive",
];
const FULL_RUNTIME = [...CORE_RUNTIME, ...SUPPORT6];
const NON_PATH_HOSTILE_KEYS = ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"];
const lines: string[] = [];

function emit(key: string, value: string | number | boolean): void {
  lines.push(key + "=" + String(value).replace(/[\r\n]/gu, " "));
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function code(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/(?:S8|RUNNER|APPLICATION|DOMAIN|RUN087|ENV_MODE)_[A-Z0-9_]+/u)?.[0] ?? (error instanceof Error ? error.name : "ERROR");
}
function run(binary: string, args: string[], timeoutMs = 120_000) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false });
  return { status: typeof result.status === "number" ? result.status : -1, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" };
}
function sudo(args: string[]) { return run("/usr/bin/sudo", ["-n", ...args]); }
function requireOk(name: string, result: { status: number }) { if (result.status !== 0) throw new Error(name + "_STATUS_" + result.status); }
function domainAStatus(): boolean {
  const expectedPath = process.env.S8_RUN087_DOMAIN_A_EXPECTED_PATH;
  return Boolean(expectedPath)
    && process.env.PATH === expectedPath && process.env.HOME === "/tmp"
    && process.env.LANG === "C.UTF-8" && process.env.LC_ALL === "C.UTF-8"
    && process.env.LD_PRELOAD === undefined && process.env.LD_LIBRARY_PATH === undefined
    && process.env.PYTHONPATH === undefined && process.env.PYTHONHOME === undefined
    && DOMAIN_A_FORBIDDEN.every((key) => process.env[key] === undefined);
}
function domainBStatus(): boolean { return HOSTILE_KEYS.every((key) => process.env[key] === DOMAIN_B[key]); }

function fixture(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const hashValue = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const object = {
    objectId: "obj-a", identityKey: "stable-object", parentObjectId: null,
    objectType: "box" as const, role: "furniture" as const,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm: { xMm: 1, yMm: 2, zMm: 3 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "run-087", sourceFingerprint: fingerprint, acceptedByUser: true, note: null },
    unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: revisionId, acceptedRevisionHash: hashValue,
    sourceS5Fingerprint: fingerprint, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [object], hierarchy: [{ objectId: object.objectId, parentObjectId: null }],
    zones: [], requirements: [], assumptions: [], unknowns: [], materials: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hashValue, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hashValue,
    sourceS5Fingerprint: fingerprint, s7ArtifactId: "44444444-4444-4444-8444-444444444444",
    s7ArtifactHash: hashValue, s7ArtifactByteSize: 1, manifestId: "55555555-5555-4555-8555-555555555555",
    manifestHash: hashValue, readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hashValue,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1",
    coordinateConvention: "booth-local-right-handed-v1", dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

function readSnapshot(path: string): Snapshot | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as Snapshot; } catch { return undefined; }
}
function seedAdmission(runValue: WriterRun): boolean {
  const pre = runValue.snapshots.hostedPre;
  const post = runValue.snapshots.post;
  if (!pre || !post) return false;
  const stripUid0 = (items: string[]) => items.filter((item) => item !== "user:0:r--").sort();
  const same = pre.owner === post.owner && pre.group === post.group && pre.mode === post.mode
    && pre.device === post.device && pre.inode === post.inode && pre.bytes === post.bytes && pre.sha256 === post.sha256
    && JSON.stringify(pre.defaultAcl.slice().sort()) === JSON.stringify(post.defaultAcl.slice().sort())
    && JSON.stringify(stripUid0(pre.access)) === JSON.stringify(stripUid0(post.access));
  return same && post.access.includes("user:0:r--") && post.access.length === pre.access.length + 1
    && post.defaultAcl.length === 0 && post.owner > 0 && post.group > 0 && post.mode === "0660";
}
function appArgs(requestPath: string): string[] {
  if (process.execArgv.length) return [...process.execArgv, __filename, "--application-parent", requestPath];
  if (process.argv[1]) return [process.argv[1], __filename, "--application-parent", requestPath];
  throw new Error("APPLICATION_PARENT_LAUNCHER_MISSING");
}
function applicationParent(requestPath: string): void {
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as Request;
  const status: AppStatus = { domainBPresent: domainBStatus(), ok: false, code: "DOMAIN_B_ENV_NOT_PRESENT" };
  if (!status.domainBPresent) { process.stdout.write(JSON.stringify(status) + "\n"); return; }
  try {
    const c = request.controls;
    process.env.S8_RUN087_WRAPPER_CLEAN = "no";
    process.env.S8_RUN087_ENV_MODE = c.mode;
    process.env.S8_RUN087_ENV_KEYS = c.envKeys.join(",");
    process.env.S8_RUN087_PREFIX = c.prefix;
    process.env.S8_RUN087_BWRAP = c.bubblewrap;
    process.env.S8_RUN087_TARGET = c.target;
    process.env.S8_RUN087_OBSERVER = c.observer;
    process.env.S8_RUN087_RUNNER_UID = String(c.runnerUid);
    process.env.S8_RUN087_RUNNER_GID = String(c.runnerGid);
    process.env.S8_RUN087_OBSERVE = c.observe ? "yes" : "no";
    process.env.S8_RUN087_RUNTIME_SURFACES = c.runtimeSurfaces.join(":");
    const result = runS8BlenderWriter(readFileSync(request.payloadPath), request.config);
    writeFileSync(request.resultPath, result.artifact, { mode: 0o600, flag: "wx" });
    status.ok = true;
    status.code = "PASS";
  } catch (error) { status.code = code(error); }
  process.stdout.write(JSON.stringify(status) + "\n");
}
function runAppParent(request: Request, timeoutMs: number): AppStatus {
  const requestPath = request.resultPath + ".request.json";
  writeFileSync(requestPath, JSON.stringify(request), { encoding: "utf8", mode: 0o600, flag: "wx" });
  const result = spawnSync(process.execPath, appArgs(requestPath), {
    cwd: process.cwd(), env: { ...DOMAIN_B } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024, shell: false,
  });
  rmSync(requestPath, { force: true });
  if (result.error || typeof result.stdout !== "string") return { domainBPresent: false, ok: false, code: "APPLICATION_PARENT_LAUNCH_FAILED" };
  try {
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "") as AppStatus;
    if (typeof parsed.domainBPresent !== "boolean" || typeof parsed.ok !== "boolean" || typeof parsed.code !== "string") throw new Error("APPLICATION_PARENT_STATUS_INVALID");
    return parsed;
  } catch {
    return { domainBPresent: false, ok: false, code: typeof result.status === "number" ? "APPLICATION_PARENT_EXIT_" + result.status : "APPLICATION_PARENT_STATUS_INVALID" };
  }
}

function writeObserver(path: string): void {
  const source = [
    "#!/usr/bin/python3", "import json", "import os", "import re", "import sys", "",
    "target, output = sys.argv[1:]", "events = []; trace_lines = 0; execve_lines = 0; target_matches = 0; parse_errors = 0", "",
    "def skip_ws(text, index):",
    "    while index < len(text) and text[index].isspace(): index += 1",
    "    return index",
    "def parse_string(text, index):",
    "    if text[index] != chr(34): raise ValueError()",
    "    index += 1; out = []",
    "    while index < len(text):",
    "        char = text[index]",
    "        if char == chr(34): return ''.join(out), index + 1",
    "        if char == chr(92):",
    "            index += 1",
    "            if index >= len(text): raise ValueError()",
    "            out.append(text[index])",
    "        else: out.append(char)",
    "        index += 1",
    "    raise ValueError()",
    "def parse_array(text, index):",
    "    if text[index] != '[': raise ValueError()",
    "    start = index + 1; index += 1; depth = 1; quoted = False; escaped = False",
    "    while index < len(text):",
    "        char = text[index]",
    "        if quoted:",
    "            if escaped: escaped = False",
    "            elif char == chr(92): escaped = True",
    "            elif char == chr(34): quoted = False",
    "        else:",
    "            if char == chr(34): quoted = True",
    "            elif char == '[': depth += 1",
    "            elif char == ']':",
    "                depth -= 1",
    "                if depth == 0: return text[start:index], index + 1",
    "        index += 1",
    "    raise ValueError()",
    "for raw in sys.stdin:",
    "    trace_lines += 1",
    "    marker = raw.find('execve(')",
    "    if marker < 0: continue",
    "    execve_lines += 1",
    "    text = raw[marker + len('execve('):]",
    "    try:",
    "        executable, index = parse_string(text, 0)",
    "        if executable != target: continue",
    "        target_matches += 1",
    "        index = skip_ws(text, index)",
    "        if text[index] != ',': raise ValueError()",
    "        index = skip_ws(text, index + 1)",
    "        _, index = parse_array(text, index)",
    "        index = skip_ws(text, index)",
    "        if text[index] != ',': raise ValueError()",
    "        index = skip_ws(text, index + 1)",
    "        if text.startswith('/* 0 vars */', index): env = '[]'; index += len('/* 0 vars */')",
    "        else: env, index = parse_array(text, index)",
    "        keys = re.findall(r'\"([A-Za-z_][A-Za-z0-9_]*)=', env)",
    "        tail = text[index:].lstrip()",
    "        if not tail.startswith(')'): raise ValueError()",
    "        tail = tail[1:].lstrip()",
    "        events.append({'keys': keys, 'success': tail.startswith('= 0') or tail.startswith('=0')})",
    "    except Exception: parse_errors += 1; events.append({'keys': [], 'success': False, 'parseError': True})",
    "successful = [entry for entry in events if entry.get('success') and 'parseError' not in entry]",
    "if len(successful) == 1:",
    "    entry = successful[0]",
    "    result = {'status':'OBSERVED','target':target,'attempts':len(events),'successful':1,'keys':entry['keys'],'count':len(entry['keys']),'traceLines':trace_lines,'execveLines':execve_lines,'targetMatches':target_matches,'parseErrors':parse_errors}",
    "else:",
    "    result = {'status':'NOT_OBSERVED' if not events else 'AMBIGUOUS','target':target,'attempts':len(events),'successful':len(successful),'keys':[],'count':-1,'traceLines':trace_lines,'execveLines':execve_lines,'targetMatches':target_matches,'parseErrors':parse_errors}",
    "with open(output, 'x', encoding='ascii') as stream: json.dump(result, stream, sort_keys=True, separators=(',', ':'))",
    "os.chmod(output, 0o644)",
  ].join("\n") + "\n";
  writeFileSync(path, source, { encoding: "ascii", mode: 0o500, flag: "wx" });
  chmodSync(path, 0o555);
}

function writeSandboxWrapper(path: string): void {
  const shell = [
    "#!/bin/bash", "set -Eeuo pipefail",
    "if [[ ! -v S8_RUN087_WRAPPER_CLEAN ]] || [[ $S8_RUN087_WRAPPER_CLEAN != yes ]]; then",
    "  for key in S8_RUN087_ENV_MODE S8_RUN087_ENV_KEYS S8_RUN087_PREFIX S8_RUN087_BWRAP S8_RUN087_TARGET S8_RUN087_OBSERVER S8_RUN087_RUNNER_UID S8_RUN087_RUNNER_GID S8_RUN087_OBSERVE S8_RUN087_RUNTIME_SURFACES; do",
    "    if [[ ! -v $key ]]; then printf 'RUN087_CONTROL_UNSET=%s\\n' \"$key\" >&2; exit 96; fi",
    "  done",
    "  exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 \\",
    "    S8_RUN087_WRAPPER_CLEAN=yes S8_RUN087_ENV_MODE=\"$S8_RUN087_ENV_MODE\" S8_RUN087_ENV_KEYS=\"$S8_RUN087_ENV_KEYS\" \\",
    "    S8_RUN087_PREFIX=\"$S8_RUN087_PREFIX\" S8_RUN087_BWRAP=\"$S8_RUN087_BWRAP\" \\",
    "    S8_RUN087_TARGET=\"$S8_RUN087_TARGET\" S8_RUN087_OBSERVER=\"$S8_RUN087_OBSERVER\" \\",
    "    S8_RUN087_RUNNER_UID=\"$S8_RUN087_RUNNER_UID\" S8_RUN087_RUNNER_GID=\"$S8_RUN087_RUNNER_GID\" \\",
    "    S8_RUN087_OBSERVE=\"$S8_RUN087_OBSERVE\" S8_RUN087_RUNTIME_SURFACES=\"$S8_RUN087_RUNTIME_SURFACES\" \\",
    "    /bin/bash \"$0\" \"$@\"",
    "fi",
    "prefix=$S8_RUN087_PREFIX; bwrap_path=$S8_RUN087_BWRAP; target=$S8_RUN087_TARGET; observer=$S8_RUN087_OBSERVER",
    "runner_uid=$S8_RUN087_RUNNER_UID; runner_gid=$S8_RUN087_RUNNER_GID; mode=$S8_RUN087_ENV_MODE; observe=$S8_RUN087_OBSERVE",
    "umask 077; exec 3>&2; wrapper_stderr=$prefix.wrapper.stderr; : > \"$wrapper_stderr\"; exec 2>>\"$wrapper_stderr\"",
    "trap 'status=$?; /usr/bin/cat \"$wrapper_stderr\" >&3 || true; exit \"$status\"' EXIT",
    "if [[ $mode != SUBSET && $mode != FOUR_KEY_CONTROL && $mode != INVALID ]]; then",
    "  printf '%s\\n' RUN087_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"",
    "  printf 'RUN087_ENV_MODE_REJECTED=%s\\n' \"$mode\" >&2; exit 97",
    "fi",
    "work=$(pwd); input=$work/input.json",
    "snapshot() {",
    "  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/python3 - \"$1\" \"$2\" <<'PY'",
    "import hashlib,json,os,subprocess,sys",
    "path,output=sys.argv[1:]; st=os.lstat(path)",
    "acl=subprocess.run(['/usr/bin/getfacl','--numeric','--omit-header','--absolute-names','--',path],check=True,capture_output=True,text=True)",
    "access=[]; default=[]",
    "for raw in acl.stdout.splitlines():",
    " v=raw.strip()",
    " if not v or v.startswith('#'): continue",
    " entry=v.split('#',1)[0].strip()",
    " (default if entry.startswith('default:') else access).append(entry)",
    "with open(path,'rb') as f: data=f.read()",
    "value={'owner':st.st_uid,'group':st.st_gid,'mode':format(st.st_mode&0o777,'04o'),'device':st.st_dev,'inode':st.st_ino,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'access':access,'defaultAcl':default}",
    "with open(output,'x',encoding='ascii') as f: json.dump(value,f,sort_keys=True,separators=(',',':'))",
    "PY",
    "}",
    "if [[ ! -f $input || -L $input ]]; then exit 92; fi",
    "snapshot \"$input\" \"$prefix.pre.json\"",
    "if [[ $runner_uid -le 0 || $runner_uid -eq 65534 || $runner_gid -le 0 ]]; then exit 93; fi",
    "/usr/bin/sudo -n /usr/bin/chown root:root -- \"$work\"",
    "/usr/bin/sudo -n /usr/bin/setfacl --no-mask --set \"u::rwx,u:$runner_uid:rwx,g::---,m::rwx,o::---\" -- \"$work\"",
    "/usr/bin/sudo -n /usr/bin/setfacl --no-mask --default --set \"u::rwx,u:$runner_uid:rwx,g::---,m::rwx,o::---\" -- \"$work\"",
    "/usr/bin/sudo -n /usr/bin/chmod 0770 -- \"$work\"",
    "/usr/bin/sudo -n /usr/bin/chown \"$runner_uid:$runner_gid\" -- \"$input\"",
    "/usr/bin/sudo -n /usr/bin/chmod 0660 -- \"$input\"",
    "/usr/bin/sudo -n /usr/bin/setfacl -b -- \"$input\"",
    "/usr/bin/sudo -n /usr/bin/setfacl -k -- \"$input\"",
    "/usr/bin/sudo -n /usr/bin/setfacl --no-mask --set \"u::rw-,u:$runner_uid:rwx,g::---,m::rw-,o::---\" -- \"$input\"",
    "snapshot \"$input\" \"$prefix.hosted-pre.json\"",
    "/usr/bin/sudo -n /usr/bin/setfacl --no-mask -m u:0:r-- -- \"$input\"",
    "snapshot \"$input\" \"$prefix.post.json\"",
    "work_uid=$(/usr/bin/stat -c '%u' -- \"$work\"); work_gid=$(/usr/bin/stat -c '%g' -- \"$work\"); work_mode=$(/usr/bin/stat -c '%a' -- \"$work\")",
    "work_acl=$(/usr/bin/getfacl --numeric --omit-header --absolute-names -- \"$work\" | /usr/bin/sed '/^#/d;/^$/d' | /usr/bin/sort)",
    "expected_acl=$(printf 'default:group::---\\ndefault:mask::rwx\\ndefault:other::---\\ndefault:user::rwx\\ndefault:user:%s:rwx\\ngroup::---\\nmask::rwx\\nother::---\\nuser::rwx\\nuser:%s:rwx' \"$runner_uid\" \"$runner_uid\" | /usr/bin/sort)",
    "if [[ $work_uid != 0 || $work_gid != 0 || $work_mode != 770 || $work_acl != \"$expected_acl\" ]]; then printf '%s\\n' FAILED > \"$prefix.work-contract\"; exit 94; fi",
    "printf '%s\\n' PASS > \"$prefix.work-contract\"",
    "launch=(--unshare-user --unshare-net --unshare-pid --unshare-ipc --unshare-uts --disable-userns --assert-userns-disabled --uid 65534 --gid 65534 --cap-drop ALL --die-with-parent --new-session)",
    "IFS=: read -r -a surfaces <<< \"$S8_RUN087_RUNTIME_SURFACES\"",
    "for system_path in \"${surfaces[@]}\"; do [[ -n $system_path && -f $system_path ]] || { printf '%s\\n' RUNTIME_SURFACE_MISSING >&2; exit 95; }; launch+=(--ro-bind \"$system_path\" \"$system_path\"); done",
    "if [[ $mode == INVALID ]]; then printf '%s\\n' RUN087_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"; exit 97; fi",
    "if [[ $mode == FOUR_KEY_CONTROL && $S8_RUN087_ENV_KEYS != PATH,LANG,LC_ALL,HOME ]]; then printf '%s\\n' RUN087_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"; exit 97; fi",
    "launch+=(--clearenv --unsetenv PWD)",
    "selected_keys=(); if [[ -n $S8_RUN087_ENV_KEYS ]]; then IFS=, read -r -a selected_keys <<< \"$S8_RUN087_ENV_KEYS\"; fi",
    "seen_keys=,",
    "for key in \"${selected_keys[@]}\"; do",
    "  if [[ $seen_keys == *\",$key,\"* ]]; then printf '%s\\n' RUN087_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"; exit 97; fi",
    "  seen_keys+=\"$key,\"",
    "  case $key in",
    "    PATH) launch+=(--setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) ;;",
    "    LANG) launch+=(--setenv LANG C.UTF-8) ;;",
    "    LC_ALL) launch+=(--setenv LC_ALL C.UTF-8) ;;",
    "    HOME) launch+=(--setenv HOME /tmp) ;;",
    "    *) printf '%s\\n' RUN087_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"; exit 97 ;;",
    "  esac",
    "done",
    "launch+=(--proc /proc --dev /dev --tmpfs /tmp --chdir /work)",
    "filtered=(); skip=0",
    "for argument in \"$@\"; do",
    "  if (( skip > 0 )); then skip=$((skip-1)); continue; fi",
    "  case $argument in",
    "    --unshare-user|--unshare-net|--unshare-pid|--unshare-ipc|--unshare-uts|--die-with-parent|--new-session|--disable-userns|--assert-userns-disabled|--clearenv) continue ;;",
    "    --uid|--gid|--cap-drop|--proc|--dev|--tmpfs|--chdir) skip=1; continue ;;",
    "    --setenv) skip=2; continue ;;",
    "    *) filtered+=(\"$argument\") ;;",
    "  esac",
    "done",
    "launch+=(\"${filtered[@]}\")",
    "run_bwrap() {",
    "  local out=$prefix.runner.stdout err=$prefix.runner.stderr argv_file=$prefix.bwrap-argv.nul status observer_command",
    "  : > \"$out\"; : > \"$err\"; printf '%s\\0' \"$bwrap_path\" \"$@\" > \"$argv_file\"; set +e",
    "  if [[ $observe == yes ]]; then",
    "    printf -v observer_command '%q ' /usr/bin/python3 \"$observer\" \"$target\" \"$prefix.boundary.json\"",
    "    /usr/bin/sudo -n /usr/bin/strace -f -q -v -s 65536 -e trace=execve -o \"|$observer_command\" -- \"$bwrap_path\" \"$@\" > \"$out\" 2> \"$err\"",
    "  else /usr/bin/sudo -n \"$bwrap_path\" \"$@\" > \"$out\" 2> \"$err\"; fi",
    "  status=$?; set -e; printf 'S8_RUN087_BWRAP_STATUS=%s\\n' \"$status\" >&2",
    "  printf '{\"status\":%s}\\n' \"$status\" > \"$prefix.status.json\"",
    "  /usr/bin/cat \"$out\"; /usr/bin/cat \"$err\" >&2; return \"$status\"",
    "}",
    "run_bwrap \"${launch[@]}\"",
  ].join("\n") + "\n";
  const content = shell.replaceAll("$", "$");
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755, flag: "wx" });
  chmodSync(path, 0o755);
}

function boundary(path: string): Boundary | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as Boundary; } catch { return undefined; }
}
function argvFor(prefix: string): string[] | undefined {
  const path = prefix + ".bwrap-argv.nul";
  if (!existsSync(path)) return undefined;
  const values = readFileSync(path).toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values.length > 1 ? values : undefined;
}
function smallText(path: string): string {
  if (!existsSync(path)) return "";
  try { return readFileSync(path).subarray(0, 4096).toString("utf8"); } catch { return ""; }
}
function fileBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
function runnerSummary(prefix: string): RunnerSummary | undefined {
  const first = smallText(prefix + ".runner.stdout").split(/\r?\n/u)[0] ?? "";
  const marker = "S8_RUNNER_RECEIPT:";
  if (!first.startsWith(marker)) return undefined;
  try {
    const receipt = JSON.parse(first.slice(marker.length)) as { result?: Record<string, unknown> };
    const result = receipt.result;
    if (!result || typeof result.code !== "number" || typeof result.name !== "string" || typeof result.terminationClass !== "string") return undefined;
    return {
      code: result.code,
      name: result.name,
      terminationClass: result.terminationClass,
      targetExit: typeof result.targetExit === "number" ? result.targetExit : null,
      targetSignal: typeof result.targetSignal === "number" ? result.targetSignal : null,
      setupStage: typeof result.setupStage === "string" ? result.setupStage : null,
      evidenceCode: typeof result.evidenceCode === "string" ? result.evidenceCode : null,
    };
  } catch { return undefined; }
}
function stderrClass(text: string): string {
  if (!text.trim()) return "EMPTY";
  if (/no such file or directory|cannot find|not found/iu.test(text)) return "NO_SUCH_FILE";
  if (/creating new namespace failed|namespace.*failed|unshare.*failed/iu.test(text)) return "NAMESPACE_SETUP_FAILED";
  if (/operation not permitted/iu.test(text)) return "OPERATION_NOT_PERMITTED";
  if (/permission denied/iu.test(text)) return "PERMISSION_DENIED";
  if (/invalid argument/iu.test(text)) return "INVALID_ARGUMENT";
  if (/exec format error/iu.test(text)) return "EXEC_FORMAT";
  if (/too many levels of symbolic links/iu.test(text)) return "SYMLINK_LOOP";
  return "NONEMPTY_OTHER";
}
function stderrSummary(text: string): string {
  const lines = text.split(/\r?\n/u).filter(Boolean).slice(0, 2);
  if (!lines.length) return "EMPTY";
  return lines.join(" | ")
    .replace(/\/(?:tmp|home|usr|lib64?|etc|runtime|work|proc|dev)(?:\/[^\s:"]*)?/gu, (path) => {
      const stable = path.split("/").filter(Boolean)
        .filter((part) => !/^s8-run087-\d+\.\d+$/u.test(part) && !/^s8-[0-9a-f-]{36}$/iu.test(part));
      return "<path>" + (stable.length ? "/" + stable.slice(-3).join("/") : "");
    })
    .replace(/\bS8_RUN087_[A-Z0-9_]+\b/gu, "<redacted>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<id>")
    .replace(/[^\x20-\x7e]/gu, "?")
    .slice(0, 240);
}
function launchDiagnostic(prefix: string): LaunchDiagnostic {
  let bwrapStatus: number | null = null;
  try {
    const value = JSON.parse(smallText(prefix + ".status.json")) as { status?: unknown };
    if (typeof value.status === "number" && Number.isInteger(value.status)) bwrapStatus = value.status;
  } catch {}
  const stdout = smallText(prefix + ".runner.stdout");
  const firstLine = stdout.split(/\r?\n/u)[0] ?? "";
  const runner = runnerSummary(prefix);
  const runnerStdoutFirstLine: LaunchDiagnostic["runnerStdoutFirstLine"] = !firstLine
    ? "EMPTY" : firstLine.startsWith("S8_RUNNER_RECEIPT:") ? (runner ? "RECEIPT_SUMMARY" : "RECEIPT_UNPARSED") : "NON_RECEIPT";
  const runnerStderr = smallText(prefix + ".runner.stderr");
  const wrapperStderr = smallText(prefix + ".wrapper.stderr");
  return {
    bwrapStatus,
    runnerStdoutBytes: fileBytes(prefix + ".runner.stdout"),
    runnerStdoutFirstLine,
    runnerStderrBytes: fileBytes(prefix + ".runner.stderr"),
    runnerStderrClass: stderrClass(runnerStderr),
    runnerStderrSummary: stderrSummary(runnerStderr),
    wrapperStderrBytes: fileBytes(prefix + ".wrapper.stderr"),
    wrapperStderrClass: stderrClass(wrapperStderr),
    wrapperStderrSummary: stderrSummary(wrapperStderr),
  };
}
function setenv(argv: string[]): Array<[string, string]> | undefined {
  const result: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--setenv") {
    if (!argv[i + 1] || !argv[i + 2]) return undefined;
    result.push([argv[i + 1]!, argv[i + 2]!]); i += 2;
  }
  return result;
}
function mounts(argv: string[]): Array<[string, string, string]> {
  const result: Array<[string, string, string]> = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ro-bind" || argv[i] === "--bind") {
      if (argv[i + 1] && argv[i + 2]) result.push([argv[i]!, argv[i + 1]!, argv[i + 2]!]);
      i += 2;
    } else if (argv[i] === "--proc" || argv[i] === "--dev" || argv[i] === "--tmpfs") {
      if (argv[i + 1]) result.push([argv[i]!, "", argv[i + 1]!]);
      i += 1;
    }
  }
  return result;
}
function normalizedMounts(argv: string[] | undefined) {
  return argv ? mounts(argv).map(([kind, source, dest]) => [kind, dest === "/work" ? "<application-work-leaf>" : source, dest]) : undefined;
}
function containsPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
function bwrapContract(argv: string[] | undefined, envKeys: EnvKey[], runtimeSurfaces: string[]) {
  if (!argv) return { ok: false, env: [] as Array<[string, string]>, omitted: false, topology: false, runtime: false, mountManifest: [] as Array<[string, string, string]> };
  const env = setenv(argv);
  if (!env) return { ok: false, env: [] as Array<[string, string]>, omitted: false, topology: false, runtime: false, mountManifest: [] as Array<[string, string, string]> };
  const expected = envKeys.map((key) => [key, ENV_VALUES[key]] as [string, string]);
  const envOk = argv.filter((arg) => arg === "--clearenv").length === 1 && same(env, expected)
    && argv.filter((arg) => arg === "--unsetenv").length === 1 && argv[argv.indexOf("--unsetenv") + 1] === "PWD";
  const bindList = mounts(argv);
  const expectedSurfaces = new Set(runtimeSurfaces);
  const allowedRuntimeSet = new Set(FULL_RUNTIME);
  const runtimeMounts = bindList.filter(([, source]) => allowedRuntimeSet.has(source));
  const retained = runtimeSurfaces.every((path) => bindList.some((m) => m[0] === "--ro-bind" && m[1] === path && m[2] === path));
  const runtime = CORE_RUNTIME.every((path) => expectedSurfaces.has(path))
    && runtimeSurfaces.every((path) => allowedRuntimeSet.has(path))
    && runtimeMounts.length === runtimeSurfaces.length
    && new Set(runtimeMounts.map((mount) => mount[1])).size === runtimeSurfaces.length
    && runtimeMounts.every((mount) => mount[0] === "--ro-bind" && mount[1] === mount[2])
    && retained;
  const omittedPaths = SUPPORT6.filter((path) => !expectedSurfaces.has(path));
  const omitted = omittedPaths.every((path) => bindList.every(([kind, source]) =>
    (kind !== "--bind" && kind !== "--ro-bind") || !containsPath(path, source)));
  const broadRoots = ["/", "/usr", "/lib", "/lib64", "/etc"];
  const broadBind = bindList.some(([kind, source, dest]) =>
    (kind === "--bind" || kind === "--ro-bind")
    && (broadRoots.includes(source) || broadRoots.includes(dest)
      || FULL_RUNTIME.some((path) => containsPath(path, source) && path !== source)));
  const readonlyOnly = bindList.filter((mount) => mount[0] === "--bind").length === 1
    && bindList.filter((mount) => mount[0] === "--bind").every((mount) => mount[2] === "/work")
    && bindList.filter((mount) => mount[0] !== "--bind" && mount[0] !== "--ro-bind").every((mount) => ["--proc", "--dev", "--tmpfs"].includes(mount[0]));
  const flagOnce = (flag: string) => argv.filter((arg) => arg === flag).length === 1;
  const hasValue = (flag: string, value: string) => flagOnce(flag) && argv[argv.indexOf(flag) + 1] === value;
  const topology = ["--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session"].every(flagOnce)
    && hasValue("--uid", "65534") && hasValue("--gid", "65534")
    && hasValue("--cap-drop", "ALL") && hasValue("--proc", "/proc") && hasValue("--dev", "/dev")
    && hasValue("--tmpfs", "/tmp") && hasValue("--chdir", "/work")
    && bindList.some((m) => m[0] === "--bind" && m[2] === "/work") && readonlyOnly && !broadBind && runtime;
  const mountManifest = runtimeMounts.map((mount) => [mount[0], mount[1], mount[2]] as [string, string, string]);
  return { ok: envOk && omitted && topology, env, omitted, topology, runtime, mountManifest };
}
function writerRun(label: string, mode: Mode, envKeys: EnvKey[], observe: boolean, payload: Buffer, config: S8WorkerConfig, evidenceDir: string, bubblewrap: string, target: string, observer: string, runnerUid: number, runnerGid: number, runtimeSurfaces: string[]): WriterRun {
  const prefix = join(evidenceDir, label);
  const payloadPath = prefix + ".input.json";
  const artifactPath = prefix + ".application-artifact.fbx";
  writeFileSync(payloadPath, payload, { mode: 0o600, flag: "wx" });
  try { rmSync(artifactPath, { force: true }); } catch {}
  const status = runAppParent({
    operation: "writer", resultPath: artifactPath, payloadPath, config,
    controls: { prefix, bubblewrap, target, observer, runnerUid, runnerGid, mode, envKeys, observe, runtimeSurfaces },
  }, WRITER_TIMEOUT + 30_000);
  const artifactPresent = status.ok && existsSync(artifactPath) && lstatSync(artifactPath).isFile();
  const artifact = artifactPresent ? readFileSync(artifactPath) : Buffer.alloc(0);
  return {
    ok: artifactPresent && artifact.length > 27,
    code: status.ok ? (artifactPresent && artifact.length > 27 ? "PASS" : "APPLICATION_ARTIFACT_MISSING") : status.code,
    domainBPresent: status.domainBPresent, artifactPath, artifactBytes: artifact.length, artifactSha256: artifact.length ? hash(artifact) : "",
    argv: argvFor(prefix), boundary: boundary(prefix + ".boundary.json"), runner: runnerSummary(prefix), launchDiagnostic: launchDiagnostic(prefix),
    modeRejected: existsSync(prefix + ".mode-rejected") && smallText(prefix + ".mode-rejected").includes("RUN087_ENV_MODE_REJECTED"),
    workContract: smallText(prefix + ".work-contract").trim() === "PASS",
    snapshots: { hostedPre: readSnapshot(prefix + ".hosted-pre.json"), post: readSnapshot(prefix + ".post.json") },
  };
}
function hasArtifact(writer: WriterRun): boolean {
  return existsSync(writer.artifactPath) && lstatSync(writer.artifactPath).isFile();
}
function validWriterRunnerReceipt(writer: WriterRun): boolean {
  const receipt = writer.runner;
  return Boolean(receipt && receipt.code === 0 && receipt.name === "S8_RUNNER_SUCCESS"
    && receipt.terminationClass === "target-exit-zero" && receipt.targetExit === 0 && receipt.targetSignal === null);
}
function trial(label: string, envKeys: EnvKey[], runtimeSurfaces: string[], observe: boolean, payload: Buffer, source: { s6: S6ToS7Handoff; s7: S7ToS8Handoff }, config: S8WorkerConfig, evidenceDir: string, bubblewrap: string, target: string, observer: string, runnerUid: number, runnerGid: number, mode: Mode = "SUBSET"): Trial {
  const writer = writerRun(label, mode, envKeys, observe, payload, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid, runtimeSurfaces);
  const contract = bwrapContract(writer.argv, envKeys, runtimeSurfaces);
  if (!hasArtifact(writer)) return { writer, validator: "NOT_RUN_NO_ARTIFACT", validatorReceipt: false, passed: false, contract };
  try {
    const result = runS8NativeValidator(readFileSync(writer.artifactPath), config);
    const outcome = validateS8Readback(source.s6, source.s7, result.readback).outcome;
    const validator = outcome === "pass" ? "PASS" : "FAIL_SEMANTIC_READBACK";
    return { writer, validator, validatorReceipt: true, passed: writer.ok && validWriterRunnerReceipt(writer) && validator === "PASS" && contract.ok && writer.workContract && seedAdmission(writer) && writer.domainBPresent, contract };
  } catch (error) {
    return { writer, validator: "FAIL_" + code(error), validatorReceipt: false, passed: false, contract };
  }
}
function gitValue(args: string[]): string {
  const result = run("/usr/bin/git", args, 30_000);
  requireOk("GIT_EVIDENCE", result);
  return result.stdout.trim();
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function main(): void {
  if (!domainAStatus()) throw new Error("DOMAIN_A_NOT_CLEAN");
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i]!, value = process.argv[i + 1];
    if (!key.startsWith("--") || !value) throw new Error("CLI_ARGUMENT_INVALID");
    args.set(key.slice(2), value); i += 1;
  }
  const required = (key: string) => { const value = args.get(key); if (!value) throw new Error("CLI_ARGUMENT_MISSING_" + key); return value; };
  const blenderRoot = required("blender-root"), blender = required("blender"), writer = required("writer");
  const runner = required("runner"), validator = required("validator"), bubblewrap = required("bubblewrap"), evidenceDir = required("evidence-dir");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  for (const path of FULL_RUNTIME) if (!existsSync(path) || !statSync(path).isFile()) throw new Error("FULL_RUNTIME_SURFACE_MISSING");
  if (!same(FULL_RUNTIME, [...CORE_RUNTIME, ...SUPPORT6])) throw new Error("RUNTIME_AUTHORITY_ORDER_INVALID");

  const carrierHead = gitValue(["rev-parse", "HEAD"]), carrierTree = gitValue(["rev-parse", "HEAD^{tree}"]);
  const productTree = gitValue(["rev-parse", PRODUCT_HEAD + "^{tree}"]), firstParent = gitValue(["rev-parse", "HEAD^"]);
  const carrierCommitCount = gitValue(["rev-list", "--count", PRODUCT_HEAD + "..HEAD"]);
  const firstParentCommitCount = gitValue(["rev-list", "--first-parent", "--count", PRODUCT_HEAD + "..HEAD"]);
  const productMergeBase = gitValue(["merge-base", PRODUCT_HEAD, "HEAD"]);
  const changed = gitValue(["diff", "--name-only", PRODUCT_HEAD, "HEAD"]).split(/\r?\n/u).filter(Boolean).sort();
  const allowed = [".github/workflows/s8-run087-env-runtime-differential.yml", "scripts/s8/run087_env_runtime_differential.ts"].sort();
  if (productTree !== PRODUCT_TREE || productMergeBase !== PRODUCT_HEAD || carrierCommitCount === "0"
    || carrierCommitCount !== firstParentCommitCount || !same(changed, allowed)) throw new Error("CARRIER_BINDING_INVALID");

  const source = fixture(), built = buildS8WriterPayload(source.s6, source.s7);
  const uidResult = run("/usr/bin/id", ["-u"]), gidResult = run("/usr/bin/id", ["-g"]);
  requireOk("RUNNER_UID", uidResult); requireOk("RUNNER_GID", gidResult);
  const runnerUid = Number(uidResult.stdout.trim()), runnerGid = Number(gidResult.stdout.trim());
  if (!Number.isInteger(runnerUid) || runnerUid <= 0 || runnerUid === 65534 || !Number.isInteger(runnerGid) || runnerGid <= 0) throw new Error("RUNNER_IDENTITY_INVALID");
  const privateRoot = join(evidenceDir, "private-work-root");
  requireOk("PRIVATE_ROOT", sudo(["/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0700", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_ACL_CLEAR", sudo(["/usr/bin/setfacl", "-b", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_DEFAULT_ACL_CLEAR", sudo(["/usr/bin/setfacl", "-k", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_ACL", sudo(["/usr/bin/setfacl", "--no-mask", "--set", "u::rwx,u:" + runnerUid + ":rwx,g::---,m::rwx,o::---", "--", privateRoot]));
  const wrapper = join(evidenceDir, "s8-run087-sandbox-wrapper"), observer = join(evidenceDir, "s8-run087-exec-observer.py");
  writeSandboxWrapper(wrapper); writeObserver(observer);
  const relativeBlender = relative(blenderRoot, blender).replaceAll("\\", "/");
  if (relativeBlender.startsWith("..")) throw new Error("BLENDER_TARGET_PATH_INVALID");
  const target = "/runtime/blender-root/" + relativeBlender;
  const config: S8WorkerConfig = {
    blenderRuntimeRoot: blenderRoot, blenderExecutable: blender, writerScript: writer, privateWorkRoot: privateRoot,
    processRunnerExecutable: runner, sandboxExecutable: wrapper, nativeValidatorExecutable: validator,
    blenderExecutableSha256: hash(readFileSync(blender)),
  };
  const runTrial = (label: string, envKeys: EnvKey[], runtimeSurfaces: string[], observe = false, mode: Mode = "SUBSET") =>
    trial(label, envKeys, runtimeSurfaces, observe, built.bytes, source, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid, mode);
  const sorted = (keys: EnvKey[]) => keys.slice().sort();
  const subsetName = (keys: EnvKey[]) => keys.length ? sorted(keys).join(",") : "<empty>";
  const writerStatus = (value: Trial | undefined) => value ? (value.writer.ok ? "PASS" : "FAIL_" + value.writer.code) : "NOT_RUN";
  const failStatus = (value: Trial) => !value.writer.ok ? "WRITER_" + value.writer.code : value.validator !== "PASS" ? "VALIDATOR_" + value.validator : "CONTRACT_OR_RECEIPT_FAILED";
  const boundaryMatches = (value: Trial | undefined, keys: EnvKey[]) => {
    const b = value?.writer.boundary;
    return Boolean(b?.status === "OBSERVED" && b.successful === 1 && b.count === keys.length && same(sorted(b.keys as EnvKey[]), sorted(keys)));
  };
  const boundaryCount = (value: Trial | undefined) => value?.writer.boundary?.status === "OBSERVED" ? value.writer.boundary.count : "<unavailable>";
  const boundaryNames = (value: Trial | undefined) => value?.writer.boundary?.status === "OBSERVED"
    ? (value.writer.boundary.keys.length ? value.writer.boundary.keys.slice().sort().join(",") : "<empty>") : "<unavailable>";
  const boundaryDiagnostics = (value: Trial | undefined) => {
    const observation = value?.writer.boundary;
    return {
      status: observation?.status ?? "NO_RECEIPT", attempts: observation?.attempts ?? 0,
      successful: observation?.successful ?? 0, traceLines: observation?.traceLines ?? 0,
      execveLines: observation?.execveLines ?? 0, targetMatches: observation?.targetMatches ?? 0,
      parseErrors: observation?.parseErrors ?? 0,
      wrapperStderrClass: value?.writer.launchDiagnostic.wrapperStderrClass ?? "NOT_RUN",
      wrapperStderrSummary: value?.writer.launchDiagnostic.wrapperStderrSummary ?? "NOT_RUN",
    };
  };
  const noLeak = (value: Trial | undefined, keys: EnvKey[]) => {
    if (!value || !value.writer.domainBPresent || value.writer.boundary?.status !== "OBSERVED") return false;
    const expected = keys.map((key) => [key, ENV_VALUES[key]] as [string, string]);
    return value.writer.argv?.filter((arg) => arg === "--clearenv").length === 1
      && same(setenv(value.writer.argv ?? []), expected) && boundaryMatches(value, keys)
      && NON_PATH_HOSTILE_KEYS.every((key) => !value.writer.boundary!.keys.includes(key));
  };
  const packet = (value: Trial) => ({
    writer: value.writer.ok ? "PASS" : "FAIL_" + value.writer.code, validator: value.validator,
    validWriterRunnerReceipt: validWriterRunnerReceipt(value.writer), validatorRunnerReceipt: value.validatorReceipt,
    sandboxContract: value.contract.ok, runtimeMountContract: value.contract.runtime, omittedSupportAbsent: value.contract.omitted,
    topologyContract: value.contract.topology, workLeafRootCustodyAndAcl: value.writer.workContract,
    seedPrePostTransition: seedAdmission(value.writer), artifactBytes: value.writer.artifactBytes,
    artifactSha256: value.writer.artifactSha256 || "<unavailable>",
  });

  const phaseA = runTrial("phase-a-four-key-full-runtime", ENV_KEY_ORDER, FULL_RUNTIME, false, "FOUR_KEY_CONTROL");
  const phaseAOk = phaseA.passed;
  let fourObserved: Trial | undefined, invalid: WriterRun | undefined;
  const phaseB: Array<{ keys: EnvKey[]; result: Trial }> = [];
  if (phaseAOk) {
    fourObserved = runTrial("phase-a-four-key-boundary-observed", ENV_KEY_ORDER, FULL_RUNTIME, true, "FOUR_KEY_CONTROL");
    invalid = writerRun("invalid-environment-mode", "INVALID", [], false, built.bytes, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid, FULL_RUNTIME);
    for (let mask = 0; mask < 16; mask += 1) {
      const keys = ENV_KEY_ORDER.filter((_, index) => (mask & (1 << index)) !== 0);
      phaseB.push({ keys, result: runTrial("environment-powerset-" + String(mask).padStart(2, "0"), keys, FULL_RUNTIME) });
    }
  }
  const invalidRejected = Boolean(invalid?.domainBPresent && invalid.modeRejected && !invalid.argv && !invalid.boundary);
  const passing = phaseB.filter((item) => item.result.passed).sort((a, b) =>
    a.keys.length - b.keys.length || (subsetName(a.keys) < subsetName(b.keys) ? -1 : subsetName(a.keys) > subsetName(b.keys) ? 1 : 0));
  const minimum = passing[0], selected = minimum?.keys ?? [];
  const selectedUnwrapped = minimum ? runTrial("selected-minimum-unwrapped", selected, FULL_RUNTIME) : undefined;
  const selectedObserved = minimum ? runTrial("selected-minimum-boundary-observed", selected, FULL_RUNTIME, true) : undefined;
  const emptyCase = phaseB.find((item) => item.keys.length === 0)?.result;

  let supportStart: Trial | undefined, supportCurrent: string[] = [];
  const supportGreedy: Array<Record<string, string | boolean>> = [], supportChecks: Array<Record<string, string | boolean>> = [];
  let finalUnwrapped: Trial | undefined, finalObserved: Trial | undefined;
  if (phaseAOk && minimum) {
    supportStart = runTrial("support6-starting-full-control", selected, FULL_RUNTIME);
    if (supportStart.passed) {
      supportCurrent = SUPPORT6.slice();
      for (let i = 0; i < SUPPORT6.length; i += 1) {
        const surface = SUPPORT6[i]!, candidate = supportCurrent.filter((path) => path !== surface);
        const test = runTrial("support6-greedy-remove-" + String(i + 1).padStart(2, "0"), selected, [...CORE_RUNTIME, ...candidate]);
        const removed = test.passed;
        if (removed) supportCurrent = candidate;
        supportGreedy.push({ surface, disposition: removed ? "REMOVED_PASS" : "RETAINED_FAIL", writer: test.writer.ok ? "PASS" : "FAIL_" + test.writer.code, validator: test.validator, supportSetAfter: supportCurrent.join(",") || "<empty>" });
      }
      for (let i = 0; i < supportCurrent.length; i += 1) {
        const surface = supportCurrent[i]!, candidate = supportCurrent.filter((path) => path !== surface);
        const test = runTrial("support6-final-necessity-" + String(i + 1).padStart(2, "0"), selected, [...CORE_RUNTIME, ...candidate]);
        supportChecks.push({ surface, result: !test.passed ? "FAIL_AS_REQUIRED" : "UNEXPECTED_PASS", failure: !test.passed ? failStatus(test) : "NONE", sandboxContract: test.contract.ok, workAclContract: test.writer.workContract, seedTransition: seedAdmission(test.writer) });
      }
      const finalRuntime = [...CORE_RUNTIME, ...supportCurrent];
      finalUnwrapped = runTrial("final-support-set-unwrapped", selected, finalRuntime);
      finalObserved = runTrial("phase-d-final-integrated-boundary-observed", selected, finalRuntime, true);
    }
  }

  const fourBoundaryOk = boundaryMatches(fourObserved, ENV_KEY_ORDER) && Boolean(fourObserved?.passed);
  const selectedBoundaryOk = boundaryMatches(selectedObserved, selected) && Boolean(selectedObserved?.passed);
  const finalBoundaryOk = boundaryMatches(finalObserved, selected);
  const noParentLeak = noLeak(fourObserved, ENV_KEY_ORDER) && noLeak(selectedObserved, selected);
  const fourMountsUnchanged = same(normalizedMounts(phaseA.writer.argv), normalizedMounts(fourObserved?.writer.argv));
  const selectedMountsUnchanged = same(normalizedMounts(selectedUnwrapped?.writer.argv), normalizedMounts(selectedObserved?.writer.argv));
  const observedMountsUnchanged = same(normalizedMounts(finalUnwrapped?.writer.argv), normalizedMounts(finalObserved?.writer.argv));
  const powersetComplete = phaseB.length === 16;
  const domainBOk = powersetComplete && phaseB.every((item) => item.result.writer.domainBPresent);
  const supportNecessary = supportChecks.every((item) => item.result === "FAIL_AS_REQUIRED" && item.sandboxContract === true && item.workAclContract === true && item.seedTransition === true);
  const finalContract = Boolean(finalObserved?.contract.ok && finalObserved.contract.runtime && finalObserved.contract.omitted
    && finalObserved.writer.workContract && seedAdmission(finalObserved.writer) && supportGreedy.length === 6);
  const environmentComplete = phaseAOk && powersetComplete && Boolean(minimum?.result.passed && selectedUnwrapped?.passed && selectedObserved?.passed)
    && fourBoundaryOk && selectedBoundaryOk && noParentLeak && fourMountsUnchanged && selectedMountsUnchanged && domainBOk && invalidRejected;
  const supportComplete = Boolean(supportStart?.passed && supportGreedy.length === 6 && supportNecessary);
  const integratedComplete = Boolean(finalUnwrapped?.passed && finalObserved?.passed && finalBoundaryOk && finalContract && observedMountsUnchanged
    && validWriterRunnerReceipt(finalObserved?.writer as WriterRun) && finalObserved?.validatorReceipt);
  const complete = environmentComplete && supportComplete && integratedComplete;
  const blockers: string[] = [];
  if (!phaseAOk) blockers.push("PHASE_A_FOUR_KEY_FULL_RUNTIME_CONTROL_FAILED");
  else {
    if (!powersetComplete) blockers.push("ENVIRONMENT_POWERSET_INCOMPLETE");
    if (powersetComplete && !minimum) blockers.push("NO_ENVIRONMENT_SUBSET_PASSED_AFTER_PHASE_A_CONTROL");
    if (minimum && !selectedUnwrapped?.passed) blockers.push("SELECTED_ENV_UNWRAPPED_POSITIVE_FAILED");
    if (!fourBoundaryOk || !selectedBoundaryOk || !noParentLeak) blockers.push("TARGET_BOUNDARY_OR_PARENT_ENVIRONMENT_SEPARATION_UNPROVEN");
    if (!fourMountsUnchanged || !selectedMountsUnchanged) blockers.push("ENVIRONMENT_OBSERVER_CHANGED_SANDBOX_MOUNTS");
    if (!invalidRejected) blockers.push("ENVIRONMENT_ENCODING_FAIL_CLOSED_CHECK_FAILED");
    if (!domainBOk) blockers.push("DOMAIN_B_SYNTHETIC_PARENT_NOT_PRESENT_IN_EVERY_CASE");
    if (!supportStart?.passed) blockers.push("SUPPORT6_STARTING_FULL_CONTROL_FAILED");
    if (supportStart?.passed && supportGreedy.length !== 6) blockers.push("SUPPORT6_GREEDY_MATRIX_INCOMPLETE");
    if (supportGreedy.length === 6 && !supportNecessary) blockers.push("SUPPORT6_RETAINED_NECESSITY_NOT_ESTABLISHED");
    if (!integratedComplete) blockers.push("FINAL_INTEGRATED_POSITIVE_OR_CONTRACT_FAILED");
  }
  const supportOmitted = SUPPORT6.filter((path) => !supportCurrent.includes(path));
  const manifest = finalObserved ? JSON.stringify({ readonlyRuntimeBinds: finalObserved.contract.mountManifest, omittedSupport6: supportOmitted }) : "<unavailable>";
  const phaseAReceipt = validWriterRunnerReceipt(phaseA.writer) && phaseA.validatorReceipt;
  emit("RUN", RUN); emit("LOCK", LOCK); emit("STAGE", "G0-B"); emit("MODE", "BOUNDED_ORTHOGONAL_DIFFERENTIAL_EVIDENCE");
  emit("PRODUCT_PR", 47); emit("PRODUCT_HEAD", PRODUCT_HEAD); emit("PRODUCT_TREE", PRODUCT_TREE); emit("BASE", BASE);
  emit("PRODUCT_BRANCH", PRODUCT_BRANCH); emit("EVIDENCE_CARRIER_BRANCH", CARRIER_BRANCH);
  emit("EVIDENCE_CARRIER_HEAD", carrierHead); emit("EVIDENCE_CARRIER_TREE", carrierTree);
  emit("EVIDENCE_WORKFLOW_RUN", process.env.GITHUB_RUN_ID ?? "local"); emit("EVIDENCE_WORKFLOW_JOB", "run087-env-runtime");
  emit("EVIDENCE_WORKFLOW_ATTEMPT", process.env.GITHUB_RUN_ATTEMPT ?? "local");
  emit("CARRIER_FIRST_PARENT", firstParent); emit("CARRIER_COMMIT_COUNT", carrierCommitCount);
  emit("CARRIER_LINEAR_HISTORY", carrierCommitCount !== "0" && carrierCommitCount === firstParentCommitCount ? "YES" : "NO");
  emit("CARRIER_ALLOWED_PATHS_ONLY", same(changed, allowed) ? "YES" : "NO");
  emit("CARRIER_PRODUCT_HEAD_MERGE_BASE", productMergeBase); emit("CONTINUING_OWNER", "S8 #29 / PR #47");
  emit("ACTUAL_APPLICATION_FUNCTIONS", "buildS8WriterPayload,runS8BlenderWriter,runS8NativeValidator");
  emit("ACTUAL_APPLICATION_PAYLOAD_SHA256", built.sha256); emit("ACTUAL_APPLICATION_PAYLOAD_BYTES", built.bytes.length);
  emit("DOMAIN_A_CLEAN", domainAStatus() ? "YES" : "NO"); emit("DOMAIN_B_SYNTHETIC_ENV_PRESENT", domainBOk && phaseA.writer.domainBPresent ? "YES" : "NO");
  emit("CORE_RUNTIME_SURFACE_COUNT", CORE_RUNTIME.length); emit("SUPPORT6_SURFACE_COUNT", SUPPORT6.length); emit("FULL_RUNTIME_SURFACE_COUNT", FULL_RUNTIME.length);
  emit("PHASE_A_FOUR_KEY_FULL_RUNTIME_WRITER", phaseA.writer.ok ? "PASS" : "FAIL_" + phaseA.writer.code);
  emit("PHASE_A_FOUR_KEY_FULL_RUNTIME_VALIDATOR", phaseA.validator); emit("PHASE_A_VALID_RUNNER_RECEIPT", phaseAReceipt ? "YES" : "NO");
  emit("PHASE_A_COMPLETE_PATH", phaseAOk ? "PASS" : "FAIL"); emit("PHASE_A_DETAILS_JSON", JSON.stringify(packet(phaseA)));
  emit("PHASE_A_BWRAP_ARGV_JSON", phaseA.writer.argv ? JSON.stringify(phaseA.writer.argv) : "<unavailable>");
  emit("PHASE_A_RUNNER_RECEIPT_SUMMARY_JSON", phaseA.writer.runner ? JSON.stringify(phaseA.writer.runner) : "<unavailable>");
  if (!phaseAOk) emit("PHASE_A_LAUNCH_DIAGNOSTICS_JSON", JSON.stringify(phaseA.writer.launchDiagnostic));
  emit("ENV_POWERSET_CASES", JSON.stringify(phaseB.map((item) => ({ subset: sorted(item.keys), empty: !item.keys.length, ...packet(item.result) }))));
  emit("ENV_PASSING_SUBSETS", passing.length ? passing.map((item) => subsetName(item.keys)).join(";") : "<none>");
  emit("MINIMUM_CHILD_ENV", minimum ? subsetName(minimum.keys) : "<none>");
  emit("MINIMUM_CHILD_ENV_CARDINALITY", minimum ? minimum.keys.length : "<unavailable>");
  emit("EMPTY_ENV_WRITER", emptyCase ? (emptyCase.writer.ok ? "PASS" : "FAIL_" + emptyCase.writer.code) : "NOT_RUN_PHASE_A_FAILED");
  emit("SELECTED_ENV_UNWRAPPED_WRITER", writerStatus(selectedUnwrapped)); emit("SELECTED_ENV_VALIDATOR", selectedUnwrapped?.validator ?? "NOT_RUN");
  emit("SELECTED_ENV_TARGET_ENV_KEY_COUNT", boundaryCount(selectedObserved)); emit("SELECTED_ENV_TARGET_ENV_KEYS", boundaryNames(selectedObserved));
  emit("FOUR_KEY_TARGET_ENV_KEY_COUNT", boundaryCount(fourObserved)); emit("FOUR_KEY_TARGET_ENV_KEYS", boundaryNames(fourObserved));
  emit("TARGET_BOUNDARY_DIAGNOSTICS_JSON", JSON.stringify({ fourKey: boundaryDiagnostics(fourObserved), selectedMinimum: boundaryDiagnostics(selectedObserved), finalIntegrated: boundaryDiagnostics(finalObserved) }));
  emit("PARENT_SECRET_HOSTILE_ENV_TARGET_LEAKAGE", !fourObserved || !selectedObserved || !fourBoundaryOk || !selectedBoundaryOk ? "UNAVAILABLE" : noParentLeak ? "NONE" : "PRESENT");
  emit("FOUR_KEY_MOUNTS_UNCHANGED_BY_OBSERVER", fourMountsUnchanged ? "YES" : "NO");
  emit("SELECTED_ENV_MOUNTS_UNCHANGED_BY_OBSERVER", selectedMountsUnchanged ? "YES" : "NO");
  emit("ENVIRONMENT_ENCODING_INVALID_MODE_RESULT", invalidRejected ? "REJECTED_BEFORE_TARGET_LAUNCH" : "FAIL_OR_NOT_RUN");
  emit("SUPPORT6_STARTING_FULL_CONTROL", supportStart ? (supportStart.passed ? "PASS" : "FAIL_" + failStatus(supportStart)) : "NOT_RUN");
  emit("SUPPORT6_1_MINIMAL_RETAINED", supportStart?.passed && supportGreedy.length === 6 ? (supportCurrent.join(",") || "<empty>") : "<not-established>");
  emit("SUPPORT6_OMITTED", supportStart?.passed && supportGreedy.length === 6 ? (supportOmitted.join(",") || "<empty>") : "<not-established>");
  emit("SUPPORT6_GREEDY_MATRIX", supportGreedy.length ? JSON.stringify(supportGreedy) : "<not-run>");
  emit("SUPPORT6_RETAINED_NECESSITY_CHECKS", JSON.stringify(supportChecks));
  emit("1_MINIMAL_EVIDENCE_SUPPORTED_SUPPORT_SET", supportComplete ? (supportCurrent.join(",") || "<empty>") : "<not-established>");
  emit("FINAL_SUPPORT_SET_WRITER", writerStatus(finalUnwrapped)); emit("FINAL_SUPPORT_SET_VALIDATOR", finalUnwrapped?.validator ?? "NOT_RUN");
  emit("FINAL_INTEGRATED_WRITER", writerStatus(finalObserved)); emit("FINAL_INTEGRATED_VALIDATOR", finalObserved?.validator ?? "NOT_RUN");
  emit("FINAL_VALID_RUNNER_RECEIPT", finalObserved && validWriterRunnerReceipt(finalObserved.writer) && finalObserved.validatorReceipt ? "YES" : "NO");
  emit("FINAL_TARGET_ENV_KEY_COUNT", boundaryCount(finalObserved)); emit("FINAL_TARGET_ENV_KEYS", boundaryNames(finalObserved));
  emit("FINAL_RUNTIME_MOUNT_MANIFEST", manifest); emit("FINAL_INTEGRATED_MOUNTS_UNCHANGED_BY_OBSERVER", observedMountsUnchanged ? "YES" : "NO");
  emit("G4_075_01_EVIDENCE_COMPLETE", phaseAOk ? "YES" : "NO"); emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", complete ? "YES" : "NO");
  emit("REMAINING_DIFFERENTIAL", blockers.length ? blockers.join(";") : "NONE");
  emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO"); emit("G1_REENTRY_REQUIRED", "NO"); emit("G3_MUTATION_AUTHORISED", "NO");
  emit("G4_LAUNCH_AUTHORISED", "NO"); emit("READY_AUTHORISED", "NO"); emit("MERGE_AUTHORISED", "NO");
  emit("PRODUCT_PR_MUTATED", "NO"); emit("PRODUCT_SOURCE_MUTATION_AUTHORISED", "NO");
  emit("PRODUCT_BRANCH_MUTATION_AUTHORISED", "NO"); emit("PRODUCT_CI_RERUN_AUTHORISED", "NO"); emit("RETURN_TO_WEB", "YES");
  emit("RESULT", complete ? "EVIDENCE_COMPLETE" : "EVIDENCE_INCOMPLETE");
  for (const line of lines) process.stdout.write(line + "\n");
  if (!complete) process.exitCode = 2;
}
if (process.argv[2] === "--application-parent") {
  try {
    if (!process.argv[3]) throw new Error("APPLICATION_PARENT_REQUEST_MISSING");
    applicationParent(process.argv[3]);
  } catch (error) {
    process.stdout.write(JSON.stringify({ domainBPresent: false, ok: false, code: code(error) }) + "\n");
  }
} else {
  try { main(); }
  catch (error) {
    emit("EVIDENCE_RUN_FATAL", code(error)); emit("RUN", RUN); emit("LOCK", LOCK); emit("STAGE", "G0-B");
    emit("PRODUCT_PR", 47); emit("PRODUCT_HEAD", PRODUCT_HEAD); emit("PRODUCT_TREE", PRODUCT_TREE); emit("BASE", BASE);
    emit("PRODUCT_PR_MUTATED", "NO"); emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
    emit("G1_REENTRY_REQUIRED", "NO"); emit("G3_MUTATION_AUTHORISED", "NO"); emit("G4_LAUNCH_AUTHORISED", "NO");
    emit("READY_AUTHORISED", "NO"); emit("MERGE_AUTHORISED", "NO"); emit("RETURN_TO_WEB", "YES");
    emit("EVIDENCE_CARRIER_BRANCH", CARRIER_BRANCH); emit("EVIDENCE_CARRIER_HEAD", "<unavailable>"); emit("EVIDENCE_CARRIER_TREE", "<unavailable>");
    emit("EVIDENCE_WORKFLOW_RUN", process.env.GITHUB_RUN_ID ?? "local"); emit("EVIDENCE_WORKFLOW_JOB", "run087-env-runtime");
    emit("TERMINAL_RECEIPT", "EVIDENCE_RUN_FATAL=" + code(error));
    emit("G4_075_01_EVIDENCE_COMPLETE", "NO"); emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", "NO");
    emit("REMAINING_DIFFERENTIAL", "EVIDENCE_RUN_FATAL_" + code(error)); emit("RESULT", "EVIDENCE_INCOMPLETE");
    for (const line of lines) process.stdout.write(line + "\n");
    process.exitCode = 2;
  }
}
