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

type Mode = "EMPTY" | "FOUR_KEY_CONTROL" | "UNSET_INVALID";
type Snapshot = { owner: number; group: number; mode: string; device: number; inode: number; bytes: number; sha256: string; access: string[]; defaultAcl: string[] };
type Boundary = { status: string; target: string; attempts: number; successful: number; keys: string[]; count: number };
type Request = {
  operation: "writer";
  resultPath: string;
  payloadPath: string;
  config: S8WorkerConfig;
  controls: { prefix: string; bubblewrap: string; target: string; observer: string; runnerUid: number; runnerGid: number; mode: Mode; observe: boolean; runtimeSurfaces: string[] };
};
type AppStatus = { domainBPresent: boolean; ok: boolean; code: string };
type RunnerSummary = { code: number; name: string; terminationClass: string; targetExit: number | null; targetSignal: number | null; setupStage: string | null; evidenceCode: string | null };
type WriterRun = {
  ok: boolean; code: string; domainBPresent: boolean; artifactPath: string; artifactBytes: number; artifactSha256: string;
  argv?: string[]; boundary?: Boundary; runner?: RunnerSummary; modeRejected: boolean; workContract: boolean;
  snapshots: { hostedPre?: Snapshot; post?: Snapshot };
};

const RUN = "S8_G0B_PR47_EMPTY_CHILD_ENV_WRITER_SUFFICIENCY_EVIDENCE_086";
const LOCK = "DL-SD-S8-G0B-PR47-EMPTY-CHILD-ENV-WRITER-SUFFICIENCY-EVIDENCE-001";
const PRODUCT_HEAD = "2f71e472849055ab8814f7e38d0f8c321707275f";
const PRODUCT_TREE = "c72036fdc685ad3a78e2b696df212476c1dade36";
const BASE = "578ac98aa974fa0ec3a65bcade1c505ac5c80dcb";
const PRODUCT_BRANCH = "codex/s8-g3-native-process-boundary-hosted-carrier-001";
const CARRIER_BRANCH = "web/run-086-s8-empty-child-env-writer-evidence-001";
const WRITER_TIMEOUT = 300_000;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const FOUR_KEYS: Array<[string, string]> = [["PATH", SAFE_PATH], ["LANG", "C.UTF-8"], ["LC_ALL", "C.UTF-8"], ["HOME", "/tmp"]];
const DOMAIN_B: Record<string, string> = {
  S8_TEST_PARENT_SECRET_A: "S8_RUN086_PARENT_SECRET_A_SENTINEL",
  S8_TEST_PARENT_SECRET_B: "S8_RUN086_PARENT_SECRET_B_SENTINEL",
  PATH: "S8_RUN086_HOSTILE_PATH_SENTINEL",
  HOME: "S8_RUN086_HOSTILE_HOME_SENTINEL",
  LD_PRELOAD: "/tmp/S8_RUN086_HOSTILE_LD_PRELOAD_SENTINEL.so",
  LD_LIBRARY_PATH: "/tmp/S8_RUN086_HOSTILE_LD_LIBRARY_PATH_SENTINEL",
  PYTHONPATH: "/tmp/S8_RUN086_HOSTILE_PYTHONPATH_SENTINEL",
  PYTHONHOME: "/tmp/S8_RUN086_HOSTILE_PYTHONHOME_SENTINEL",
};
const HOSTILE_KEYS = Object.keys(DOMAIN_B);
const DOMAIN_A_FORBIDDEN = ["S8_TEST_PARENT_SECRET_A", "S8_TEST_PARENT_SECRET_B", "LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH", "PYTHONHOME"];
const RUNTIME = [
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
const OMITTED = [
  "/etc/group", "/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/passwd",
  "/lib/x86_64-linux-gnu/libnss_files.so.2", "/usr/lib/locale/locale-archive",
];
const lines: string[] = [];

function emit(key: string, value: string | number | boolean): void {
  lines.push(key + "=" + String(value).replace(/[\r\n]/gu, " "));
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function code(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/(?:S8|RUNNER|APPLICATION|DOMAIN|RUN086|ENV_MODE)_[A-Z0-9_]+/u)?.[0] ?? (error instanceof Error ? error.name : "ERROR");
}
function run(binary: string, args: string[], timeoutMs = 120_000) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: false });
  return { status: typeof result.status === "number" ? result.status : -1, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" };
}
function sudo(args: string[]) { return run("/usr/bin/sudo", ["-n", ...args]); }
function requireOk(name: string, result: { status: number }) { if (result.status !== 0) throw new Error(name + "_STATUS_" + result.status); }
function domainAStatus(): boolean {
  const expectedPath = process.env.S8_RUN086_DOMAIN_A_EXPECTED_PATH;
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
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "run-086", sourceFingerprint: fingerprint, acceptedByUser: true, note: null },
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
    process.env.S8_RUN086_WRAPPER_CLEAN = "no";
    process.env.S8_RUN086_ENV_MODE = c.mode;
    process.env.S8_RUN086_PREFIX = c.prefix;
    process.env.S8_RUN086_BWRAP = c.bubblewrap;
    process.env.S8_RUN086_TARGET = c.target;
    process.env.S8_RUN086_OBSERVER = c.observer;
    process.env.S8_RUN086_RUNNER_UID = String(c.runnerUid);
    process.env.S8_RUN086_RUNNER_GID = String(c.runnerGid);
    process.env.S8_RUN086_OBSERVE = c.observe ? "yes" : "no";
    process.env.S8_RUN086_RUNTIME_SURFACES = c.runtimeSurfaces.join(":");
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
    "target, output = sys.argv[1:]", "events = []", "",
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
    "    marker = raw.find('execve(')",
    "    if marker < 0: continue",
    "    text = raw[marker + len('execve('):]",
    "    try:",
    "        executable, index = parse_string(text, 0)",
    "        if executable != target: continue",
    "        index = skip_ws(text, index)",
    "        if text[index] != ',': raise ValueError()",
    "        index = skip_ws(text, index + 1)",
    "        _, index = parse_array(text, index)",
    "        index = skip_ws(text, index)",
    "        if text[index] != ',': raise ValueError()",
    "        index = skip_ws(text, index + 1)",
    "        if text.startswith('/* 0 vars */', index): env = '[]'",
    "        else: env, index = parse_array(text, index)",
    "        keys = re.findall(r'\"([A-Za-z_][A-Za-z0-9_]*)=', env)",
    "        tail = text[index:].lstrip()",
    "        events.append({'keys': keys, 'success': tail.startswith('= 0') or tail.startswith('=0')})",
    "    except Exception: events.append({'keys': [], 'success': False, 'parseError': True})",
    "successful = [entry for entry in events if entry.get('success') and 'parseError' not in entry]",
    "if len(successful) == 1:",
    "    entry = successful[0]",
    "    result = {'status':'OBSERVED','target':target,'attempts':len(events),'successful':1,'keys':entry['keys'],'count':len(entry['keys'])}",
    "else:",
    "    result = {'status':'NOT_OBSERVED' if not events else 'AMBIGUOUS','target':target,'attempts':len(events),'successful':len(successful),'keys':[],'count':-1}",
    "with open(output, 'x', encoding='ascii') as stream: json.dump(result, stream, sort_keys=True, separators=(',', ':'))",
    "os.chmod(output, 0o644)",
  ].join("\n") + "\n";
  writeFileSync(path, source, { encoding: "ascii", mode: 0o500, flag: "wx" });
  chmodSync(path, 0o555);
}

function writeSandboxWrapper(path: string): void {
  const shell = [
    "#!/bin/bash", "set -Eeuo pipefail",
    "if [[ ! -v S8_RUN086_WRAPPER_CLEAN ]] || [[ $S8_RUN086_WRAPPER_CLEAN != yes ]]; then",
    "  for key in S8_RUN086_ENV_MODE S8_RUN086_PREFIX S8_RUN086_BWRAP S8_RUN086_TARGET S8_RUN086_OBSERVER S8_RUN086_RUNNER_UID S8_RUN086_RUNNER_GID S8_RUN086_OBSERVE S8_RUN086_RUNTIME_SURFACES; do",
    "    if [[ ! -v $key ]]; then printf 'RUN086_CONTROL_UNSET=%s\\n' \"$key\" >&2; exit 96; fi",
    "  done",
    "  exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 \\",
    "    S8_RUN086_WRAPPER_CLEAN=yes S8_RUN086_ENV_MODE=\"$S8_RUN086_ENV_MODE\" \\",
    "    S8_RUN086_PREFIX=\"$S8_RUN086_PREFIX\" S8_RUN086_BWRAP=\"$S8_RUN086_BWRAP\" \\",
    "    S8_RUN086_TARGET=\"$S8_RUN086_TARGET\" S8_RUN086_OBSERVER=\"$S8_RUN086_OBSERVER\" \\",
    "    S8_RUN086_RUNNER_UID=\"$S8_RUN086_RUNNER_UID\" S8_RUN086_RUNNER_GID=\"$S8_RUN086_RUNNER_GID\" \\",
    "    S8_RUN086_OBSERVE=\"$S8_RUN086_OBSERVE\" S8_RUN086_RUNTIME_SURFACES=\"$S8_RUN086_RUNTIME_SURFACES\" \\",
    "    /bin/bash \"$0\" \"$@\"",
    "fi",
    "prefix=$S8_RUN086_PREFIX; bwrap_path=$S8_RUN086_BWRAP; target=$S8_RUN086_TARGET; observer=$S8_RUN086_OBSERVER",
    "runner_uid=$S8_RUN086_RUNNER_UID; runner_gid=$S8_RUN086_RUNNER_GID; mode=$S8_RUN086_ENV_MODE; observe=$S8_RUN086_OBSERVE",
    "umask 077; exec 3>&2; wrapper_stderr=$prefix.wrapper.stderr; : > \"$wrapper_stderr\"; exec 2>>\"$wrapper_stderr\"",
    "trap 'status=$?; /usr/bin/cat \"$wrapper_stderr\" >&3 || true; exit \"$status\"' EXIT",
    "if [[ $mode != EMPTY && $mode != FOUR_KEY_CONTROL ]]; then",
    "  printf '%s\\n' RUN086_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"",
    "  printf 'RUN086_ENV_MODE_REJECTED=%s\\n' \"$mode\" >&2; exit 97",
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
    "IFS=: read -r -a surfaces <<< \"$S8_RUN086_RUNTIME_SURFACES\"",
    "for system_path in \"${surfaces[@]}\"; do [[ -n $system_path && -f $system_path ]] || { printf '%s\\n' RUNTIME_SURFACE_MISSING >&2; exit 95; }; launch+=(--ro-bind \"$system_path\" \"$system_path\"); done",
    "launch+=(--clearenv)",
    "case $mode in",
    "  EMPTY) ;;",
    "  FOUR_KEY_CONTROL) launch+=(--setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8 --setenv HOME /tmp) ;;",
    "  *) printf '%s\\n' RUN086_ENV_MODE_REJECTED > \"$prefix.mode-rejected\"; exit 97 ;;",
    "esac",
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
    "  status=$?; set -e; printf 'S8_RUN086_BWRAP_STATUS=%s\\n' \"$status\" >&2",
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
function bwrapContract(argv: string[] | undefined, mode: Mode) {
  if (!argv) return { ok: false, env: [] as Array<[string, string]>, omitted: false, topology: false };
  const env = setenv(argv);
  if (!env) return { ok: false, env: [] as Array<[string, string]>, omitted: false, topology: false };
  const expected = mode === "FOUR_KEY_CONTROL" ? FOUR_KEYS : [];
  const envOk = argv.filter((arg) => arg === "--clearenv").length === 1 && JSON.stringify(env) === JSON.stringify(expected);
  const bindList = mounts(argv);
  const retained = RUNTIME.every((path) => bindList.some((m) => m[0] === "--ro-bind" && m[1] === path && m[2] === path));
  const omitted = OMITTED.every((path) => bindList.every(([, source]) => source !== path && !path.startsWith(source === "/" ? "/" : source + "/")));
  const has = (value: string) => argv.includes(value);
  const topology = ["--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session"].every(has)
    && argv[argv.indexOf("--uid") + 1] === "65534" && argv[argv.indexOf("--gid") + 1] === "65534"
    && argv[argv.indexOf("--cap-drop") + 1] === "ALL"
    && argv[argv.indexOf("--proc") + 1] === "/proc" && argv[argv.indexOf("--dev") + 1] === "/dev"
    && argv[argv.indexOf("--tmpfs") + 1] === "/tmp" && argv[argv.indexOf("--chdir") + 1] === "/work"
    && bindList.some((m) => m[0] === "--bind" && m[2] === "/work") && retained;
  return { ok: envOk && omitted && topology, env, omitted, topology };
}
function writerRun(label: string, mode: Mode, observe: boolean, payload: Buffer, config: S8WorkerConfig, evidenceDir: string, bubblewrap: string, target: string, observer: string, runnerUid: number, runnerGid: number): WriterRun {
  const prefix = join(evidenceDir, label);
  const payloadPath = prefix + ".input.json";
  const artifactPath = prefix + ".application-artifact.fbx";
  writeFileSync(payloadPath, payload, { mode: 0o600, flag: "wx" });
  try { rmSync(artifactPath, { force: true }); } catch {}
  const status = runAppParent({
    operation: "writer", resultPath: artifactPath, payloadPath, config,
    controls: { prefix, bubblewrap, target, observer, runnerUid, runnerGid, mode, observe, runtimeSurfaces: RUNTIME },
  }, WRITER_TIMEOUT + 30_000);
  const artifactPresent = status.ok && existsSync(artifactPath) && lstatSync(artifactPath).isFile();
  const artifact = artifactPresent ? readFileSync(artifactPath) : Buffer.alloc(0);
  return {
    ok: artifactPresent && artifact.length > 27,
    code: status.ok ? (artifactPresent && artifact.length > 27 ? "PASS" : "APPLICATION_ARTIFACT_MISSING") : status.code,
    domainBPresent: status.domainBPresent, artifactPath, artifactBytes: artifact.length, artifactSha256: artifact.length ? hash(artifact) : "",
    argv: argvFor(prefix), boundary: boundary(prefix + ".boundary.json"), runner: runnerSummary(prefix),
    modeRejected: existsSync(prefix + ".mode-rejected") && smallText(prefix + ".mode-rejected").includes("RUN086_ENV_MODE_REJECTED"),
    workContract: smallText(prefix + ".work-contract").trim() === "PASS",
    snapshots: { hostedPre: readSnapshot(prefix + ".hosted-pre.json"), post: readSnapshot(prefix + ".post.json") },
  };
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
    const key = process.argv[i]!;
    const value = process.argv[i + 1];
    if (!key.startsWith("--") || !value) throw new Error("CLI_ARGUMENT_INVALID");
    args.set(key.slice(2), value); i += 1;
  }
  const required = (key: string) => { const value = args.get(key); if (!value) throw new Error("CLI_ARGUMENT_MISSING_" + key); return value; };
  const blenderRoot = required("blender-root");
  const blender = required("blender");
  const writer = required("writer");
  const runner = required("runner");
  const validator = required("validator");
  const bubblewrap = required("bubblewrap");
  const evidenceDir = required("evidence-dir");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  for (const path of RUNTIME) if (!existsSync(path) || !statSync(path).isFile()) throw new Error("RETAINED_RUNTIME_SURFACE_MISSING");
  for (const path of OMITTED) if (RUNTIME.includes(path)) throw new Error("REMOVABLE_SURFACE_RETAINED");
  const carrierHead = gitValue(["rev-parse", "HEAD"]);
  const carrierTree = gitValue(["rev-parse", "HEAD^{tree}"]);
  const productTree = gitValue(["rev-parse", PRODUCT_HEAD + "^{tree}"]);
  const firstParent = gitValue(["rev-parse", "HEAD^"]);
  const productMergeBase = gitValue(["merge-base", PRODUCT_HEAD, "HEAD"]);
  const changed = gitValue(["diff", "--name-only", PRODUCT_HEAD, "HEAD"]).split(/\r?\n/u).filter(Boolean).sort();
  const allowed = [".github/workflows/s8-run086-empty-env-evidence.yml", "scripts/s8/run086_empty_env_evidence.ts"].sort();
  if (productTree !== PRODUCT_TREE || productMergeBase !== PRODUCT_HEAD || !same(changed, allowed)) throw new Error("CARRIER_BINDING_INVALID");

  const source = fixture();
  const built = buildS8WriterPayload(source.s6, source.s7);
  const runnerUid = Number(run("/usr/bin/id", ["-u"]).stdout.trim());
  const runnerGid = Number(run("/usr/bin/id", ["-g"]).stdout.trim());
  if (!Number.isInteger(runnerUid) || runnerUid <= 0 || runnerUid === 65534 || !Number.isInteger(runnerGid) || runnerGid <= 0) throw new Error("RUNNER_IDENTITY_INVALID");
  const privateRoot = join(evidenceDir, "private-work-root");
  requireOk("PRIVATE_ROOT", sudo(["/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0700", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_ACL_CLEAR", sudo(["/usr/bin/setfacl", "-b", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_DEFAULT_ACL_CLEAR", sudo(["/usr/bin/setfacl", "-k", "--", privateRoot]));
  requireOk("PRIVATE_ROOT_ACL", sudo(["/usr/bin/setfacl", "--no-mask", "--set", "u::rwx,u:" + runnerUid + ":rwx,g::---,m::rwx,o::---", "--", privateRoot]));
  const wrapper = join(evidenceDir, "s8-run086-sandbox-wrapper");
  const observer = join(evidenceDir, "s8-run086-exec-observer.py");
  writeSandboxWrapper(wrapper);
  writeObserver(observer);
  const relativeBlender = relative(blenderRoot, blender).replaceAll("\\", "/");
  if (relativeBlender.startsWith("..")) throw new Error("BLENDER_TARGET_PATH_INVALID");
  const target = "/runtime/blender-root/" + relativeBlender;
  const config: S8WorkerConfig = {
    blenderRuntimeRoot: blenderRoot, blenderExecutable: blender, writerScript: writer, privateWorkRoot: privateRoot,
    processRunnerExecutable: runner, sandboxExecutable: wrapper, nativeValidatorExecutable: validator,
    blenderExecutableSha256: hash(readFileSync(blender)),
  };

  const emptyPlain = writerRun("empty-unwrapped", "EMPTY", false, built.bytes, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid);
  const emptyObserved = writerRun("empty-boundary-observation", "EMPTY", true, built.bytes, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid);
  const four = writerRun("four-key-control", "FOUR_KEY_CONTROL", true, built.bytes, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid);
  const invalid = writerRun("unset-invalid", "UNSET_INVALID", false, built.bytes, config, evidenceDir, bubblewrap, target, observer, runnerUid, runnerGid);
  const plainContract = bwrapContract(emptyPlain.argv, "EMPTY");
  const observedContract = bwrapContract(emptyObserved.argv, "EMPTY");
  const fourContract = bwrapContract(four.argv, "FOUR_KEY_CONTROL");
  const invalidRejected = invalid.domainBPresent && invalid.modeRejected && !invalid.argv && !invalid.boundary;
  const emptyBoundaryOk = emptyObserved.boundary?.status === "OBSERVED" && emptyObserved.boundary.successful === 1 && emptyObserved.boundary.count === 0 && emptyObserved.boundary.keys.length === 0;
  const fourBoundaryOk = four.boundary?.status === "OBSERVED" && four.boundary.successful === 1 && same(four.boundary.keys, ["PATH", "LANG", "LC_ALL", "HOME"]);
  const mountsUnchanged = same(normalizedMounts(emptyPlain.argv), normalizedMounts(emptyObserved.argv));
  const seedOk = seedAdmission(emptyPlain) && seedAdmission(emptyObserved);
  const domainBOk = emptyPlain.domainBPresent && emptyObserved.domainBPresent && four.domainBPresent && invalid.domainBPresent;
  const hostileAbsent = Boolean(emptyObserved.boundary?.status === "OBSERVED") && HOSTILE_KEYS.every((key) => !emptyObserved.boundary!.keys.includes(key));
  let validatorResult = "NOT_RUN_NO_EMPTY_ARTIFACT";
  let validatorFailure = "NONE";
  if (emptyPlain.ok) {
    try {
      const result = runS8NativeValidator(readFileSync(emptyPlain.artifactPath), config);
      validatorResult = validateS8Readback(source.s6, source.s7, result.readback).outcome === "pass" ? "PASS" : "FAIL_SEMANTIC_READBACK";
    } catch (error) { validatorFailure = code(error); validatorResult = "FAIL_" + validatorFailure; }
  }
  const omittedOk = plainContract.omitted && observedContract.omitted && fourContract.omitted;
  const prunedPositive = omittedOk && (emptyPlain.ok || four.ok);
  const evidenceComplete = plainContract.ok && observedContract.ok && emptyBoundaryOk && mountsUnchanged && seedOk
    && emptyPlain.workContract && emptyObserved.workContract && four.workContract && domainBOk && hostileAbsent
    && fourContract.ok && fourBoundaryOk && invalidRejected && prunedPositive
    && (emptyPlain.ok || Boolean(emptyPlain.argv)) && (emptyObserved.ok || Boolean(emptyObserved.argv))
    && (four.ok || Boolean(four.argv));
  const sufficiency = emptyPlain.ok && validatorResult === "PASS" && evidenceComplete
    ? "PASS" : evidenceComplete ? "FAIL" : "INCOMPLETE";

  emit("RUN", RUN); emit("LOCK", LOCK); emit("STAGE", "G0-B");
  emit("PRODUCT_PR", 47); emit("PRODUCT_HEAD", PRODUCT_HEAD); emit("PRODUCT_TREE", PRODUCT_TREE); emit("BASE", BASE);
  emit("PRODUCT_BRANCH", PRODUCT_BRANCH); emit("EVIDENCE_CARRIER_BRANCH", CARRIER_BRANCH);
  emit("EVIDENCE_CARRIER_HEAD", carrierHead); emit("EVIDENCE_CARRIER_TREE", carrierTree);
  emit("EVIDENCE_WORKFLOW_RUN", process.env.GITHUB_RUN_ID ?? "local"); emit("EVIDENCE_WORKFLOW_JOB", "run086-empty-env");
  emit("CARRIER_FIRST_PARENT", firstParent); emit("CARRIER_ALLOWED_PATHS_ONLY", same(changed, allowed) ? "YES" : "NO");
  emit("CARRIER_PRODUCT_HEAD_MERGE_BASE", productMergeBase);
  emit("ACTUAL_APPLICATION_FUNCTIONS", "buildS8WriterPayload,runS8BlenderWriter,runS8NativeValidator");
  emit("ACTUAL_APPLICATION_PAYLOAD_SHA256", built.sha256); emit("ACTUAL_APPLICATION_PAYLOAD_BYTES", built.bytes.length);
  emit("DOMAIN_A_CLEAN", domainAStatus() ? "YES" : "NO"); emit("DOMAIN_B_SYNTHETIC_ENV_PRESENT", domainBOk ? "YES" : "NO");
  emit("RETAINED_PRUNED_RUNTIME_SURFACE_COUNT", RUNTIME.length); emit("SIX_REMOVABLE_SURFACES_OMITTED_FROM_REQUEST", "YES");
  const summarize = (name: string, result: WriterRun, contract: ReturnType<typeof bwrapContract>) => {
    emit(name + "_REAL_WRITER", result.ok ? "PASS" : "FAIL_" + result.code);
    emit(name + "_WRITER_FAILURE", result.ok ? "NONE" : result.code);
    emit(name + "_BWRAP_CLEAR_ENV_PRESENT", result.argv?.filter((arg) => arg === "--clearenv").length === 1 ? "YES" : "NO");
    emit(name + "_REQUEST_ACTUAL_SETENV_COUNT", contract.env.length);
    const envArgs: string[] = [];
    if (result.argv) for (let i = 0; i < result.argv.length; i += 1) {
      if (result.argv[i] === "--clearenv") envArgs.push("--clearenv");
      if (result.argv[i] === "--setenv") envArgs.push("--setenv", result.argv[i + 1]!, result.argv[i + 2]!);
    }
    emit(name + "_BWRAP_ENV_ARGV_JSON", JSON.stringify(envArgs));
    emit(name + "_BWRAP_ARGV_JSON", result.argv ? JSON.stringify(result.argv) : "<unavailable>");
    emit(name + "_BWRAP_ARGV_SHA256", result.argv ? hash(Buffer.from(JSON.stringify(result.argv), "utf8")) : "<unavailable>");
    emit(name + "_TARGET_ENV_KEY_COUNT", result.boundary?.count ?? "<unavailable>");
    emit(name + "_TARGET_ENV_KEYS", result.boundary?.status === "OBSERVED" ? (result.boundary.count === 0 ? "<empty>" : result.boundary.keys.join(",")) : "<unavailable>");
    emit(name + "_TARGET_BOUNDARY_OBSERVATION", result.boundary?.status ?? "NOT_RUN");
    emit(name + "_RUNNER_FAILURE_RECEIPT", result.runner ? JSON.stringify(result.runner) : "<unavailable>");
    emit(name + "_WORK_LEAF_ROOT_CUSTODY_AND_ACL", result.workContract ? "PASS" : "FAIL");
    emit(name + "_SEED_PRE_POST_CUSTODY", seedAdmission(result) ? "PASS" : "FAIL");
  };
  summarize("EMPTY_UNWRAPPED", emptyPlain, plainContract);
  summarize("EMPTY_SUPPLEMENTAL", emptyObserved, observedContract);
  summarize("FOUR_KEY", four, fourContract);
  emit("HARNESS_EMPTY_UNSET_DISTINGUISHED", plainContract.env.length === 0 && fourContract.env.length === 4 && invalidRejected ? "YES" : "NO");
  emit("EMPTY_REQUEST_ACTUAL_SETENV_COUNT", plainContract.env.length);
  emit("EMPTY_BWRAP_CLEAR_ENV_PRESENT", emptyPlain.argv?.includes("--clearenv") ? "YES" : "NO");
  emit("EMPTY_TARGET_ENV_KEY_COUNT", emptyObserved.boundary?.count ?? "<unavailable>");
  emit("EMPTY_TARGET_ENV_KEYS", emptyBoundaryOk ? "<empty>" : "<unavailable>");
  emit("EMPTY_REAL_WRITER", emptyPlain.ok ? "PASS" : "FAIL_" + emptyPlain.code);
  emit("EMPTY_REAL_VALIDATOR_OR_READBACK", validatorResult);
  emit("EMPTY_VALIDATOR_FAILURE", validatorFailure);
  emit("EMPTY_WRITER_FAILURE_RECEIPT", emptyPlain.runner ? JSON.stringify(emptyPlain.runner) : "<unavailable>");
  emit("EMPTY_UNWRAPPED_WRITER", emptyPlain.ok ? "PASS" : "FAIL_" + emptyPlain.code);
  emit("EMPTY_SUPPLEMENTAL_BOUNDARY_OBSERVATION", emptyBoundaryOk && emptyObserved.ok && mountsUnchanged ? "PASS" : "FAIL");
  emit("EMPTY_FBX_BYTES", emptyPlain.artifactBytes); emit("EMPTY_FBX_SHA256", emptyPlain.artifactSha256 || "<unavailable>");
  emit("FOUR_KEY_REQUEST_ACTUAL_SETENV_COUNT", fourContract.env.length);
  emit("FOUR_KEY_TARGET_ENV_KEY_COUNT", four.boundary?.count ?? "<unavailable>");
  emit("FOUR_KEY_TARGET_ENV_KEYS", fourBoundaryOk ? four.boundary!.keys.join(",") : "<unavailable>");
  emit("FOUR_KEY_REAL_WRITER", four.ok ? "PASS" : "FAIL_" + four.code);
  emit("UNSET_ENV_MODE_RESULT", invalidRejected ? "REJECTED_BEFORE_TARGET_LAUNCH" : "FAIL");
  emit("UNSET_TARGET_LAUNCHED", invalidRejected ? "NO" : "YES");
  emit("UNSET_DEFAULTS_SELECTED", invalidRejected && !invalid.argv ? "NO" : "YES");
  emit("UNSET_BWRAP_LAUNCH_COUNT", invalid.argv ? 1 : 0);
  emit("PRUNED_RUNTIME_COMBINED_OMISSION_REAL_WRITER", prunedPositive ? "PASS" : "FAIL");
  emit("PRUNED_RUNTIME_COMBINED_OMISSION_MODE", emptyPlain.ok ? "EMPTY" : four.ok ? "FOUR_KEY_CONTROL" : "NONE");
  emit("SIX_REMOVABLE_SUPPORT_SURFACES_PRESENT", omittedOk ? "NO" : "YES");
  emit("SIX_REMOVABLE_SUPPORT_SURFACES", OMITTED.join(","));
  emit("TOPOLOGY_ISOLATION_CONTRACT", plainContract.topology && observedContract.topology && fourContract.topology ? "PASS" : "FAIL");
  emit("EMPTY_MOUNTS_UNCHANGED_BY_SUPPLEMENTAL_OBSERVER", mountsUnchanged ? "YES" : "NO");
  emit("S8_TEST_PARENT_SECRET_A_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("S8_TEST_PARENT_SECRET_B_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_PATH_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_HOME_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_LD_PRELOAD_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_LD_LIBRARY_PATH_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_PYTHONPATH_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("HOSTILE_PYTHONHOME_AT_TARGET", hostileAbsent ? "ABSENT" : "PRESENT");
  emit("EMPTY_FAILURE_CAUSE", emptyPlain.ok ? "NONE" : four.ok ? "EMPTY_ENV_DIFFERENTIAL; FOUR_KEY_CONTROL_PASSES" : "NOT_DETERMINED");
  emit("G4_075_01_EVIDENCE_COMPLETE", "YES");
  emit("G4_075_02_EMPTY_ENV_WRITER_SUFFICIENCY", sufficiency);
  emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", evidenceComplete ? "YES" : "NO");
  emit("G1_REENTRY_REQUIRED", "NO"); emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
  emit("PRODUCT_PR_MUTATED", "NO"); emit("PRODUCT_SOURCE_MUTATION_AUTHORISED", "NO");
  emit("G3_MUTATION_AUTHORISED", "NO"); emit("G4_LAUNCH_AUTHORISED", "NO");
  emit("READY_AUTHORISED", "NO"); emit("MERGE_AUTHORISED", "NO"); emit("RETURN_TO_WEB", "YES");
  emit("RESULT", evidenceComplete ? "EVIDENCE_COMPLETE" : "EVIDENCE_INCOMPLETE");
  for (const line of lines) process.stdout.write(line + "\n");
  if (!evidenceComplete) process.exitCode = 2;
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
    emit("PRODUCT_HEAD", PRODUCT_HEAD); emit("PRODUCT_TREE", PRODUCT_TREE); emit("BASE", BASE);
    emit("PRODUCT_PR_MUTATED", "NO"); emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
    emit("RETURN_TO_WEB", "YES"); emit("G4_075_02_EMPTY_ENV_WRITER_SUFFICIENCY", "INCOMPLETE");
    emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", "NO"); emit("RESULT", "EVIDENCE_INCOMPLETE");
    for (const line of lines) process.stdout.write(line + "\n");
    process.exitCode = 2;
  }
}
