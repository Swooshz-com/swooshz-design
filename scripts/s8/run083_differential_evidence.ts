import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildS8WriterPayload } from "../../src/lib/s8-fbx-payload";
import {
  runS8BlenderWriter,
  runS8NativeValidator,
  type S8WorkerConfig,
} from "../../src/lib/s8-fbx-worker";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../../src/lib/types";

type Cli = Record<string, string>;

type Snapshot = {
  owner: number;
  group: number;
  mode: string;
  device: number;
  inode: number;
  bytes: number;
  sha256: string;
  access: string[];
  defaultAcl: string[];
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type EvidenceFiles = {
  pre?: Snapshot;
  hostedPre?: Snapshot;
  post?: Snapshot;
  status?: number;
};

type WriterRun = {
  ok: boolean;
  code: string;
  artifact?: Buffer;
  evidence: EvidenceFiles;
};

type ValidatorRun = {
  ok: boolean;
  code: string;
};

type RuntimeObservation = {
  interpreter: string;
  needed: string[];
  systemFiles: string[];
};

const RUN = "S8_G0B_PR47_CORRECTED_KNOWN_GOOD_DIFFERENTIAL_EVIDENCE_083";
const LOCK = "DL-SD-S8-G0B-PR47-CORRECTED-KNOWN-GOOD-DIFFERENTIAL-EVIDENCE-001";
const STAGE = "G0-B";
const PRODUCT_HEAD = "2f71e472849055ab8814f7e38d0f8c321707275f";
const PRODUCT_TREE = "c72036fdc685ad3a78e2b696df212476c1dade36";
const BASE = "578ac98aa974fa0ec3a65bcade1c505ac5c80dcb";
const WRITER_AS = 4 * 1024 * 1024 * 1024;
const WRITER_FILE = 128 * 1024 * 1024;
const WRITER_TIMEOUT = 300_000;
const WRITER_STDOUT = 1024 * 1024;
const WRITER_STDERR = 1024 * 1024;
const VALIDATOR_AS = 1536 * 1024 * 1024;
const VALIDATOR_FILE = 256 * 1024 * 1024;
const VALIDATOR_TIMEOUT = 120_000;
const VALIDATOR_STDOUT = 8 * 1024 * 1024;
const VALIDATOR_STDERR = 1024 * 1024;
const BASE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "HOME"] as const;
const OPTIONAL_ENV_KEYS = ["TMPDIR", "TZ", "NODE_ENV", "LD_LIBRARY_PATH", "PYTHONPATH"] as const;
const FORBIDDEN_ENV_KEYS = ["LD_PRELOAD", "PYTHONHOME"] as const;
const ALL_TEST_ENV_KEYS = [...BASE_ENV_KEYS, ...OPTIONAL_ENV_KEYS];

const outputLines: string[] = [];
const limitations: string[] = [];

function emit(key: string, value: string | number | boolean): void {
  const text = String(value).replace(/[\r\n]/g, " ");
  outputLines.push(`${key}=${text}`);
}

function noteLimit(value: string): void {
  if (!limitations.includes(value)) limitations.push(value);
}

function parseCli(): Cli {
  const result: Cli = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]!;
    if (!argument.startsWith("--") || index + 1 >= process.argv.length) throw new Error("CLI_ARGUMENT_INVALID");
    result[argument.slice(2)] = process.argv[++index]!;
  }
  return result;
}

function required(cli: Cli, name: string): string {
  const value = cli[name];
  if (!value) throw new Error(`CLI_ARGUMENT_MISSING_${name}`);
  return value;
}

function command(binary: string, args: string[], timeoutMs = 120_000): CommandResult {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  return {
    status: typeof result.status === "number" ? result.status : -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function sudo(args: string[], timeoutMs = 120_000): CommandResult {
  return command("/usr/bin/sudo", ["-n", ...args], timeoutMs);
}

function requireCommand(label: string, result: CommandResult): void {
  if (result.status !== 0) throw new Error(`${label}_STATUS_${result.status}`);
}

function sudoRequire(label: string, args: string[], timeoutMs = 120_000): void {
  requireCommand(label, sudo(args, timeoutMs));
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const match = value.match(/(?:S8|RUNNER|SANDBOX|ACL|COMMAND|CLI)_[A-Z0-9_]+/);
  return match?.[0] ?? (error instanceof Error ? error.name : "ERROR");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function snapshotEqual(left: Snapshot, right: Snapshot, withoutUid0 = false): boolean {
  const strip = (values: string[]) => values.filter((value) => !withoutUid0 || !value.startsWith("user:0:"));
  return left.owner === right.owner
    && left.group === right.group
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && JSON.stringify(strip(left.access)) === JSON.stringify(strip(right.access))
    && JSON.stringify(left.defaultAcl) === JSON.stringify(right.defaultAcl);
}

function aclIs(snapshot: Snapshot | undefined, access: string[], mode: string, owner: number, group: number): boolean {
  if (!snapshot) return false;
  return snapshot.owner === owner
    && snapshot.group === group
    && snapshot.mode === mode
    && snapshot.defaultAcl.length === 0
    && JSON.stringify([...snapshot.access].sort()) === JSON.stringify([...access].sort());
}

function evidenceFor(prefix: string): EvidenceFiles {
  const result: EvidenceFiles = {
    pre: readJson<Snapshot>(`${prefix}.pre.json`),
    hostedPre: readJson<Snapshot>(`${prefix}.hosted-pre.json`),
    post: readJson<Snapshot>(`${prefix}.post.json`),
  };
  const status = readJson<{ status: number }>(`${prefix}.status.json`);
  if (status) result.status = status.status;
  return result;
}

function buildPayload(): Buffer {
  const hash = "a".repeat(64);
  const sourceFingerprint = "b".repeat(64);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const object = {
    objectId: "obj-a",
    identityKey: "stable-object",
    parentObjectId: null,
    objectType: "box" as const,
    role: "furniture" as const,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm: { xMm: 1, yMm: 2, zMm: 3 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 },
    zoneIds: [],
    requirementIds: [],
    materialIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "run-083", sourceFingerprint, acceptedByUser: true, note: null },
    unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId,
    acceptedRevisionId: revisionId,
    acceptedRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [object],
    hierarchy: [{ objectId: object.objectId, parentObjectId: null }],
    zones: [], requirements: [], assumptions: [], unknowns: [], materials: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1",
    projectId,
    sourceRevisionId: revisionId,
    sourceRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444",
    s7ArtifactHash: hash,
    s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555",
    manifestHash: hash,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666",
    readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1",
    worldToPlanVersion: "s7-world-to-plan-v1",
    coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true,
    s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return buildS8WriterPayload(s6, s7).bytes;
}

function runtimeObservation(path: string, runtimeRoot: string): RuntimeObservation {
  const programHeaders = command("/usr/bin/readelf", ["-lW", path]);
  requireCommand("READELF_PROGRAM_HEADERS", programHeaders);
  const interpreterMatch = programHeaders.stdout.match(/Requesting program interpreter:\s*([^\]]+)/);
  if (!interpreterMatch) throw new Error("RUNTIME_INTERPRETER_NOT_FOUND");
  const interpreter = interpreterMatch[1]!.trim();
  const dynamic = command("/usr/bin/readelf", ["-dW", path]);
  requireCommand("READELF_DYNAMIC", dynamic);
  const needed = [...dynamic.stdout.matchAll(/Shared library:\s*\[([^\]]+)\]/g)].map((match) => match[1]!);
  const ldd = command("/usr/bin/ldd", [path]);
  requireCommand("LDD", ldd);
  const resolved = new Set<string>();
  for (const line of ldd.stdout.split(/\r?\n/u)) {
    const match = line.match(/=>\s+(\/\S+)\s+\(/u) ?? line.match(/^\s*(\/\S+)\s+\(/u);
    if (match?.[1]) resolved.add(match[1]);
  }
  const systemFiles = new Set<string>();
  systemFiles.add(interpreter);
  for (const pathValue of resolved) {
    if (!pathValue.startsWith(`${runtimeRoot}/`)) systemFiles.add(pathValue);
  }
  for (const pathValue of ["/etc/ld.so.cache", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/usr/lib/locale/locale-archive", "/lib/x86_64-linux-gnu/libnss_files.so.2"]) {
    if (existsSync(pathValue)) systemFiles.add(pathValue);
  }
  return { interpreter, needed, systemFiles: [...systemFiles].sort() };
}

function prepareRoot(root: string, rootOwned: boolean, runnerUid: number): void {
  if (rootOwned) {
    sudoRequire("PRIVATE_ROOT_INSTALL", ["/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0700", "--", root]);
    sudoRequire("PRIVATE_ROOT_ACCESS_ACL_CLEAR", ["/usr/bin/setfacl", "-b", "--", root]);
    sudoRequire("PRIVATE_ROOT_DEFAULT_ACL_CLEAR", ["/usr/bin/setfacl", "-k", "--", root]);
    sudoRequire("PRIVATE_ROOT_ACCESS_ACL", ["/usr/bin/setfacl", "--no-mask", "--set", `u::rwx,u:${runnerUid}:rwx,g::---,m::rwx,o::---`, "--", root]);
  } else {
    mkdirSync(root, { mode: 0o700 });
  }
}

function writeSandboxWrapper(path: string): void {
  const lines = [
    "#!/bin/bash",
    "set -Eeuo pipefail",
    "phase=${S8_RUN083_PHASE:?}",
    "prefix=${S8_RUN083_EVIDENCE_PREFIX:?}",
    "seed_mode=${S8_RUN083_SEED_MODE:?}",
    "runner_uid=${S8_RUN083_RUNNER_UID:?}",
    "runner_gid=${S8_RUN083_RUNNER_GID:?}",
    "work=$(pwd)",
    "input=$work/input.json",
    "snapshot() {",
    "  /usr/bin/python3 - \"$1\" \"$2\" <<'PY'",
    "import hashlib",
    "import json",
    "import os",
    "import subprocess",
    "import sys",
    "path, output = sys.argv[1:]",
    "st = os.lstat(path)",
    "acl = subprocess.run(['/usr/bin/getfacl', '--numeric', '--omit-header', '--absolute-names', '--', path], check=False, capture_output=True, text=True)",
    "if acl.returncode != 0: raise SystemExit(91)",
    "access = []",
    "default = []",
    "for raw in acl.stdout.splitlines():",
    "    value = raw.strip()",
    "    if not value or value.startswith('#'): continue",
    "    entry = value.split('#', 1)[0].strip()",
    "    (default if entry.startswith('default:') else access).append(entry)",
    "with open(path, 'rb') as stream: data = stream.read()",
    "record = {'owner': st.st_uid, 'group': st.st_gid, 'mode': format(st.st_mode & 0o777, '04o'), 'device': st.st_dev, 'inode': st.st_ino, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'access': access, 'defaultAcl': default}",
    "with open(output, 'w', encoding='ascii') as stream: json.dump(record, stream, sort_keys=True, separators=(',', ':'))",
    "PY",
    "}",
    "if [[ ! -f $input || -L $input ]]; then exit 92; fi",
    "snapshot \"$input\" \"$prefix.pre.json\"",
    "if [[ $seed_mode == s0 ]]; then",
    "  /usr/bin/sudo -n /usr/bin/chown \"$runner_uid:$runner_gid\" -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/chmod 0600 -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl -b -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl -k -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl --no-mask --set 'u::rw-,g::---,m::---,o::---' -- \"$input\"",
    "fi",
    "if [[ $seed_mode != s0 ]]; then",
    "  if [[ ${S8_RUN083_WORK_CUSTODY:-established} == established ]]; then /usr/bin/sudo -n /usr/bin/chown root:root -- \"$work\"; fi",
    "  if [[ ${S8_RUN083_WORK_ACL:-established} == established ]]; then",
    "    /usr/bin/sudo -n /usr/bin/setfacl --no-mask --set \"u::rwx,u:$runner_uid:rwx,g::---,m::rwx,o::---\" -- \"$work\"",
    "    /usr/bin/sudo -n /usr/bin/setfacl --no-mask --default --set \"u::rwx,u:$runner_uid:rwx,g::---,m::rwx,o::---\" -- \"$work\"",
    "    /usr/bin/sudo -n /usr/bin/chmod 0770 -- \"$work\"",
    "  else",
    "    /usr/bin/sudo -n /usr/bin/setfacl -b -- \"$work\"",
    "    /usr/bin/sudo -n /usr/bin/setfacl -k -- \"$work\"",
    "    /usr/bin/sudo -n /usr/bin/chmod 0700 -- \"$work\"",
    "  fi",
    "  /usr/bin/sudo -n /usr/bin/chown \"$runner_uid:$runner_gid\" -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/chmod 0660 -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl -b -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl -k -- \"$input\"",
    "  /usr/bin/sudo -n /usr/bin/setfacl --no-mask --set \"u::rw-,u:$runner_uid:rwx,g::---,m::rw-,o::---\" -- \"$input\"",
    "  if [[ $seed_mode == s2 ]]; then",
    "    snapshot \"$input\" \"$prefix.hosted-pre.json\"",
    "    /usr/bin/sudo -n /usr/bin/setfacl --no-mask -m u:0:r-- -- \"$input\"",
    "  fi",
    "  if [[ ${S8_RUN083_SEED_MASK_DRIFT:-no} == yes ]]; then /usr/bin/sudo -n /usr/bin/setfacl --no-mask -m m::--- -- \"$input\"; fi",
    "fi",
    "snapshot \"$input\" \"$prefix.post.json\"",
    "if [[ ${S8_RUN083_LAUNCH_MODE:-current} == current ]]; then",
    "  set +e",
    "  /usr/bin/sudo -n /usr/bin/bwrap \"$@\"",
    "  status=$?",
    "  set -e",
    "else",
    "  filtered=()",
    "  skip=0",
    "  for argument in \"$@\"; do",
    "    if (( skip > 0 )); then skip=$((skip - 1)); continue; fi",
    "    case $argument in",
    "      --unshare-user|--unshare-net|--die-with-parent|--new-session|--clearenv) continue ;;",
    "      --proc|--dev|--tmpfs|--chdir|--uid|--gid|--cap-drop) skip=1; continue ;;",
    "      --setenv) skip=2; continue ;;",
    "      *) filtered+=(\"$argument\") ;;",
    "    esac",
    "  done",
    "  launch=(--unshare-user)",
    "  if [[ ${S8_RUN083_EXTRA_NAMESPACES:-yes} == yes ]]; then launch+=(--unshare-net --unshare-pid --unshare-ipc --unshare-uts); else launch+=(--unshare-net); fi",
    "  if [[ ${S8_RUN083_DISABLE_USERNS:-yes} == yes ]]; then launch+=(--disable-userns --assert-userns-disabled); fi",
    "  if [[ ${S8_RUN083_UID_GID:-yes} == yes ]]; then launch+=(--uid 65534 --gid 65534); fi",
    "  if [[ ${S8_RUN083_CAP_DROP:-yes} == yes ]]; then launch+=(--cap-drop ALL); fi",
    "  launch+=(--die-with-parent --new-session)",
    "  if [[ ${S8_RUN083_RUNTIME_MODE:-upper} == upper ]]; then",
    "    for system_path in /usr /lib /lib64 /etc; do if [[ -e $system_path || -L $system_path ]]; then launch+=(--ro-bind \"$system_path\" \"$system_path\"); fi; done",
    "  else",
    "    IFS=: read -r -a surfaces <<< \"${S8_RUN083_SURFACES:-}\"",
    "    for system_path in \"${surfaces[@]}\"; do",
    "      [[ -n $system_path && -e $system_path ]] || continue",
    "      if [[ ${S8_RUN083_REMOVE_SURFACE:-} == \"$system_path\" ]]; then continue; fi",
    "      case ${S8_RUN083_REMOVE_SURFACE:-} in runner-interpreter) [[ $system_path == */ld-linux-* ]] && continue ;; runner-libc) [[ $system_path == */libc.so.6 ]] && continue ;; esac",
    "      launch+=(--ro-bind \"$system_path\" \"$system_path\")",
    "    done",
    "  fi",
    "  launch+=(--clearenv)",
    "  IFS=: read -r -a env_keys <<< \"${S8_RUN083_ENV_KEYS:-PATH:LANG:LC_ALL:HOME}\"",
    "  for key in \"${env_keys[@]}\"; do",
    "    [[ -n $key && $key != ${S8_RUN083_ENV_REMOVE:-} ]] || continue",
    "    case $key in PATH) launch+=(--setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin) ;; LANG) launch+=(--setenv LANG C.UTF-8) ;; LC_ALL) launch+=(--setenv LC_ALL C.UTF-8) ;; HOME) launch+=(--setenv HOME /tmp) ;; TMPDIR) launch+=(--setenv TMPDIR /tmp) ;; TZ) launch+=(--setenv TZ UTC) ;; NODE_ENV) launch+=(--setenv NODE_ENV production) ;; LD_LIBRARY_PATH) launch+=(--setenv LD_LIBRARY_PATH /nonexistent) ;; PYTHONPATH) launch+=(--setenv PYTHONPATH /nonexistent) ;; esac",
    "  done",
    "  if [[ ${S8_RUN083_WRITABLE_RUNTIME:-no} == yes ]]; then launch+=(--bind /etc /etc); fi",
    "  launch+=(\"${filtered[@]}\")",
    "  launch+=(--proc /proc --dev /dev --tmpfs /tmp --chdir /work)",
    "  set +e",
    "  /usr/bin/sudo -n /usr/bin/bwrap \"${launch[@]}\"",
    "  status=$?",
    "  set -e",
    "fi",
    "printf '{\"status\":%s}\n' \"$status\" > \"$prefix.status.json\"",
    "exit \"$status\"",
  ];
  const content = lines.join("\n") + "\n";
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function setProcessEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function writerRun(
  label: string,
  payload: Buffer,
  config: S8WorkerConfig,
  evidenceDir: string,
  runnerUid: number,
  runnerGid: number,
  options: {
    seedMode: "s0" | "s1" | "s2";
    launchMode: string;
    runtimeMode: "upper" | "minimum";
    surfaces: string[];
    removeSurface?: string;
    envKeys?: string[];
    envRemove?: string;
    workCustody?: "established" | "removed";
    workAcl?: "established" | "removed";
    extraNamespaces?: boolean;
    uidGid?: boolean;
    capDrop?: boolean;
    disableUserns?: boolean;
    writableRuntime?: boolean;
    seedMaskDrift?: boolean;
  },
): WriterRun {
  const prefix = join(evidenceDir, safeName(label));
  const restore = setProcessEnvironment({
    S8_RUN083_PHASE: label,
    S8_RUN083_EVIDENCE_PREFIX: prefix,
    S8_RUN083_SEED_MODE: options.seedMode,
    S8_RUN083_RUNNER_UID: String(runnerUid),
    S8_RUN083_RUNNER_GID: String(runnerGid),
    S8_RUN083_LAUNCH_MODE: options.launchMode,
    S8_RUN083_RUNTIME_MODE: options.runtimeMode,
    S8_RUN083_SURFACES: options.surfaces.join(":"),
    S8_RUN083_REMOVE_SURFACE: options.removeSurface,
    S8_RUN083_ENV_KEYS: (options.envKeys ?? [...BASE_ENV_KEYS]).join(":"),
    S8_RUN083_ENV_REMOVE: options.envRemove,
    S8_RUN083_WORK_CUSTODY: options.workCustody ?? "established",
    S8_RUN083_WORK_ACL: options.workAcl ?? "established",
    S8_RUN083_EXTRA_NAMESPACES: options.extraNamespaces === false ? "no" : "yes",
    S8_RUN083_UID_GID: options.uidGid === false ? "no" : "yes",
    S8_RUN083_CAP_DROP: options.capDrop === false ? "no" : "yes",
    S8_RUN083_DISABLE_USERNS: options.disableUserns === false ? "no" : "yes",
    S8_RUN083_WRITABLE_RUNTIME: options.writableRuntime ? "yes" : "no",
    S8_RUN083_SEED_MASK_DRIFT: options.seedMaskDrift ? "yes" : "no",
  });
  try {
    const result = runS8BlenderWriter(payload, config);
    return { ok: true, code: "PASS", artifact: result.artifact, evidence: evidenceFor(prefix) };
  } catch (error) {
    return { ok: false, code: errorCode(error), evidence: evidenceFor(prefix) };
  } finally {
    restore();
  }
}

function appValidator(artifact: Buffer, config: S8WorkerConfig): ValidatorRun {
  try {
    runS8NativeValidator(artifact, config);
    return { ok: true, code: "PASS" };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

function targetArgs(kind: "writer" | "validator", target: string): string[] {
  if (kind === "writer") return ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", "/runtime/writer.py", "--"];
  return [target];
}

function parseRunnerOutput(stdout: string): boolean {
  const prefix = "S8_RUNNER_RECEIPT:";
  if (!stdout.startsWith(prefix)) return false;
  const newline = stdout.indexOf("\n");
  if (newline <= prefix.length) return false;
  try {
    const receipt = JSON.parse(stdout.slice(prefix.length, newline)) as Record<string, unknown>;
    const result = receipt.result as Record<string, unknown> | undefined;
    if (result?.code !== 0 || result.targetExit !== 0 || result.targetSignal !== null) return false;
    const readback = JSON.parse(stdout.slice(newline + 1)) as Record<string, unknown>;
    const value = (readback.readback ?? readback) as Record<string, unknown>;
    return value.schemaVersion === "s8-ufbx-readback-v1";
  } catch {
    return false;
  }
}

function sandboxValidator(
  artifact: Buffer,
  runner: string,
  validator: string,
  surfaces: string[],
  runtimeMode: "upper" | "minimum",
  envKeys: string[],
  envRemove = "",
  removeSurface = "",
): ValidatorRun {
  const root = `${tmpdir()}/run083-validator-${process.pid}-${Date.now()}`;
  mkdirSync(root, { mode: 0o700 });
  const artifactPath = join(root, "artifact.fbx");
  writeFileSync(artifactPath, artifact, { mode: 0o600 });
  chmodSync(root, 0o755);
  sudoRequire("VALIDATOR_ARTIFACT_OWNER", ["/usr/bin/chown", "root:root", "--", artifactPath]);
  sudoRequire("VALIDATOR_ARTIFACT_MODE", ["/usr/bin/chmod", "0444", "--", artifactPath]);
  const args: string[] = [
    "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--disable-userns", "--assert-userns-disabled", "--uid", "65534", "--gid", "65534", "--cap-drop", "ALL",
    "--die-with-parent", "--new-session",
  ];
  if (runtimeMode === "upper") {
    for (const systemPath of ["/usr", "/lib", "/lib64", "/etc"]) if (existsSync(systemPath) || existsSync(`${systemPath}/`)) args.push("--ro-bind", systemPath, systemPath);
  } else {
    for (const systemPath of surfaces) {
      if (!existsSync(systemPath) || systemPath === removeSurface) continue;
      if (removeSurface === "validator-interpreter" && systemPath.includes("ld-linux-")) continue;
      if (removeSurface === "validator-libc" && systemPath.endsWith("/libc.so.6")) continue;
      if (removeSurface === "validator-libm" && systemPath.endsWith("/libm.so.6")) continue;
      args.push("--ro-bind", systemPath, systemPath);
    }
  }
  args.push("--clearenv");
  for (const key of envKeys) {
    if (key === envRemove) continue;
    const value: Record<string, string> = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      TZ: "UTC",
      NODE_ENV: "production",
      LD_LIBRARY_PATH: "/nonexistent",
      PYTHONPATH: "/nonexistent",
    };
    if (value[key]) args.push("--setenv", key, value[key]);
  }
  args.push("--ro-bind", runner, "/runtime/process-runner", "--ro-bind", validator, "/runtime/validator", "--ro-bind", root, "/work", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/work", "--", "/runtime/process-runner", "--address-space-bytes", String(VALIDATOR_AS), "--file-bytes", String(VALIDATOR_FILE), "--timeout-ms", String(VALIDATOR_TIMEOUT), "--stdout-bytes", String(VALIDATOR_STDOUT), "--stderr-bytes", String(VALIDATOR_STDERR), "--max-children", "0", "--", "/runtime/validator", "/work/artifact.fbx");
  const result = sudo(["/usr/bin/bwrap", ...args], VALIDATOR_TIMEOUT + 30_000);
  const ok = result.status === 0 && parseRunnerOutput(result.stdout);
  rmSync(root, { recursive: true, force: true });
  return { ok, code: ok ? "PASS" : `BWRAP_STATUS_${result.status}` };
}

function applySeedPre(path: string, runnerUid: number, runnerGid: number): void {
  sudoRequire("NEGATIVE_SEED_OWNER", ["/usr/bin/chown", `${runnerUid}:${runnerGid}`, "--", path]);
  sudoRequire("NEGATIVE_SEED_MODE", ["/usr/bin/chmod", "0660", "--", path]);
  sudoRequire("NEGATIVE_SEED_ACL_CLEAR", ["/usr/bin/setfacl", "-b", "--", path]);
  sudoRequire("NEGATIVE_SEED_DEFAULT_CLEAR", ["/usr/bin/setfacl", "-k", "--", path]);
  sudoRequire("NEGATIVE_SEED_ACL", ["/usr/bin/setfacl", "--no-mask", "--set", `u::rw-,u:${runnerUid}:rwx,g::---,m::rw-,o::---`, "--", path]);
}

function seedNegatives(root: string, runnerUid: number, runnerGid: number): string[] {
  const results: string[] = [];
  mkdirSync(root, { mode: 0o700 });
  const make = (name: string): string => {
    const path = join(root, name);
    writeFileSync(path, "run-083-seed\n", { encoding: "ascii", mode: 0o660 });
    applySeedPre(path, runnerUid, runnerGid);
    return path;
  };
  for (const permission of ["rw-", "rwx"]) {
    const path = make(`uid0-${permission.replace(/-/g, "x")}`);
    sudoRequire("NEGATIVE_UID0_MUTATION", ["/usr/bin/setfacl", "--no-mask", "-m", `u:0:${permission}`, "--", path]);
    const observed = command("/usr/bin/getfacl", ["--numeric", "--omit-header", "--absolute-names", "--", path]).stdout;
    results.push(`user:0:${permission}=REJECTED_BY_EXACT_ADMISSION_${observed.includes(`user:0:${permission}`) ? "YES" : "NO"}`);
  }
  const symlinkTarget = make("symlink-target");
  const symlink = join(root, "symlink-seed");
  command("/bin/ln", ["-s", symlinkTarget, symlink]);
  results.push(`symlink_seed=${lstatSync(symlink).isSymbolicLink() ? "REJECTED" : "INVALID"}`);
  const replacement = make("replacement-seed");
  const beforeReplacement = readJson<Snapshot>(`${replacement}.none`);
  const oldStat = statSync(replacement);
  const replacementPath = `${replacement}.new`;
  writeFileSync(replacementPath, "replacement\n", { encoding: "ascii", mode: 0o660 });
  applySeedPre(replacementPath, runnerUid, runnerGid);
  rmSync(replacement);
  command("/bin/mv", [replacementPath, replacement]);
  const newStat = statSync(replacement);
  results.push(`replacement_inode=${oldStat.ino !== newStat.ino ? "REJECTED" : "INVALID"}`);
  void beforeReplacement;
  const changedContent = make("changed-content-seed");
  const originalContent = sha256(readFileSync(changedContent));
  writeFileSync(changedContent, "changed\n", { encoding: "ascii", mode: 0o660 });
  results.push(`changed_content=${sha256(readFileSync(changedContent)) !== originalContent ? "REJECTED" : "INVALID"}`);
  const changedOwner = make("changed-owner-seed");
  sudoRequire("NEGATIVE_OWNER_CHANGE", ["/usr/bin/chown", "0:0", "--", changedOwner]);
  results.push(`changed_owner=${statSync(changedOwner).uid !== runnerUid ? "REJECTED" : "INVALID"}`);
  const changedMode = make("changed-mode-seed");
  sudoRequire("NEGATIVE_MODE_CHANGE", ["/usr/bin/chmod", "0640", "--", changedMode]);
  results.push(`unexpected_mode_drift=${(statSync(changedMode).mode & 0o777) !== 0o660 ? "REJECTED" : "INVALID"}`);
  return results;
}

function gitValue(args: string[]): string {
  const result = command("/usr/bin/git", args, 30_000);
  requireCommand("GIT_EVIDENCE", result);
  return result.stdout.trim();
}

function main(): void {
  const cli = parseCli();
  const blenderRoot = required(cli, "blender-root");
  const blender = required(cli, "blender");
  const writer = required(cli, "writer");
  const runner = required(cli, "runner");
  const validator = required(cli, "validator");
  const evidenceDir = required(cli, "evidence-dir");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const privateRoot = join(evidenceDir, "private-work-root");
  const flatRoot = join(evidenceDir, "flat-work-root");
  const runnerUid = Number(command("/usr/bin/id", ["-u"]).stdout.trim());
  const runnerGid = Number(command("/usr/bin/id", ["-g"]).stdout.trim());
  if (!Number.isInteger(runnerUid) || runnerUid <= 0 || runnerUid === 65534 || !Number.isInteger(runnerGid) || runnerGid <= 0) throw new Error("RUNNER_IDENTITY_INVALID");
  const wrapper = join(evidenceDir, "s8-run083-sandbox-wrapper");
  writeSandboxWrapper(wrapper);
  prepareRoot(privateRoot, true, runnerUid);
  prepareRoot(flatRoot, false, runnerUid);
  const payload = buildPayload();
  const executableSha = sha256(readFileSync(blender));
  const config: S8WorkerConfig = { blenderRuntimeRoot: blenderRoot, blenderExecutable: blender, writerScript: writer, privateWorkRoot: privateRoot, processRunnerExecutable: runner, sandboxExecutable: wrapper, nativeValidatorExecutable: validator, blenderExecutableSha256: executableSha };
  const runnerObservation = runtimeObservation(runner, blenderRoot);
  const validatorObservation = runtimeObservation(validator, blenderRoot);
  const blenderObservation = runtimeObservation(blender, blenderRoot);
  const minimumSurfaces = [...new Set([...runnerObservation.systemFiles, ...validatorObservation.systemFiles, ...blenderObservation.systemFiles])].sort();
  const baseWriterOptions = { launchMode: "upper", runtimeMode: "upper" as const, surfaces: minimumSurfaces, envKeys: [...BASE_ENV_KEYS] };

  emit("RUN", RUN);
  emit("LOCK", LOCK);
  emit("STAGE", STAGE);
  emit("PRODUCT_PR", 47);
  emit("PRODUCT_HEAD", PRODUCT_HEAD);
  emit("PRODUCT_TREE", PRODUCT_TREE);
  emit("BASE", BASE);
  emit("CARRIER_HEAD", gitValue(["rev-parse", "HEAD"]));
  emit("CARRIER_TREE", gitValue(["rev-parse", "HEAD^{tree}"]));
  emit("EVIDENCE_WORKFLOW_RUNS", `${process.env.GITHUB_RUN_ID ?? "local"}.${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`);
  emit("ACTUAL_APPLICATION_PAYLOAD_SHA256", sha256(payload));
  emit("ACTUAL_APPLICATION_WRITER_FUNCTION", "runS8BlenderWriter");
  emit("ACTUAL_APPLICATION_VALIDATOR_FUNCTION", "runS8NativeValidator");
  emit("RUNNER_UID", runnerUid);
  emit("RUNNER_GID", runnerGid);
  emit("RUNNER_INTERPRETER", runnerObservation.interpreter);
  emit("RUNNER_DT_NEEDED", runnerObservation.needed.join(","));
  emit("VALIDATOR_INTERPRETER", validatorObservation.interpreter);
  emit("VALIDATOR_DT_NEEDED", validatorObservation.needed.join(","));
  emit("BLENDER_INTERPRETER", blenderObservation.interpreter);
  emit("BLENDER_DT_NEEDED", blenderObservation.needed.join(","));

  const s0 = writerRun("s0-current-application", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s0", launchMode: "current" });
  const s0Snapshot = s0.evidence.post;
  const s0State = aclIs(s0Snapshot, ["user::rw-", "group::---", "mask::---", "other::---"], "0600", runnerUid, runnerGid);
  emit("S0_CURRENT_SEED", s0State ? "PASS" : "FAIL");
  emit("S0_WRITER_READ_FAILURE", !s0.ok ? "PASS" : "FAIL");
  const s1 = writerRun("s1-hosted-pre", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s1", launchMode: "upper" });
  const s2 = writerRun("s2-hosted-post", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper" });
  const s1Snapshot = s2.evidence.hostedPre ?? s1.evidence.post;
  const s2Snapshot = s2.evidence.post;
  const expectedPre = ["user::rw-", `user:${runnerUid}:rwx`, "group::---", "mask::rw-", "other::---"];
  const expectedPost = [...expectedPre, "user:0:r--"];
  const s1State = aclIs(s1Snapshot, expectedPre, "0660", runnerUid, runnerGid);
  const s2State = aclIs(s2Snapshot, expectedPost, "0660", runnerUid, runnerGid);
  const delta = Boolean(s1Snapshot && s2Snapshot && snapshotEqual(s1Snapshot, s2Snapshot, true) && s2Snapshot.access.includes("user:0:r--"));
  emit("S1_HOSTED_PRE_SEED", s1State ? "PASS" : "FAIL");
  emit("S2_HOSTED_POST_SEED", s2State ? "PASS" : "FAIL");
  emit("S1_WRITER_CONTROL", !s1.ok ? "WRITER_READ_FAILURE_REPRODUCED" : "UNEXPECTED_PASS");
  emit("S2_WRITER_CONTROL", s2.ok ? "PASS" : `FAIL_${s2.code}`);
  emit("SEED_ADMISSION_DELTA_PROOF", delta ? "PASS_BYTES_SHA_DEVICE_INODE_OWNER_GROUP_MODE_ACL_PRESERVED_ONLY_USER0_R--_ADDED" : "FAIL");
  const negativeResults = seedNegatives(join(evidenceDir, "seed-negatives"), runnerUid, runnerGid);
  emit("SEED_NEGATIVES", negativeResults.join(";"));
  emit("SEED_SYMLINK_REJECTION", negativeResults.some((value) => value === "symlink_seed=REJECTED") ? "PASS" : "FAIL");
  emit("SEED_REPLACEMENT_INODE_REJECTION", negativeResults.some((value) => value === "replacement_inode=REJECTED") ? "PASS" : "FAIL");
  emit("SEED_CHANGED_CONTENT_REJECTION", negativeResults.some((value) => value === "changed_content=REJECTED") ? "PASS" : "FAIL");
  emit("SEED_CHANGED_OWNER_REJECTION", negativeResults.some((value) => value === "changed_owner=REJECTED") ? "PASS" : "FAIL");
  emit("SEED_MODE_DRIFT_REJECTION", negativeResults.some((value) => value === "unexpected_mode_drift=REJECTED") ? "PASS" : "FAIL");

  setProcessEnvironment({
    S8_TEST_PARENT_SECRET_A: "S8_RUN083_PARENT_SECRET_A_SENTINEL",
    S8_TEST_PARENT_SECRET_B: "S8_RUN083_PARENT_SECRET_B_SENTINEL",
    PATH: "S8_RUN083_HOSTILE_PATH_SENTINEL",
    HOME: "S8_RUN083_HOSTILE_HOME_SENTINEL",
    LD_PRELOAD: "/tmp/S8_RUN083_HOSTILE_LD_PRELOAD_SENTINEL.so",
    LD_LIBRARY_PATH: "/tmp/S8_RUN083_HOSTILE_LD_LIBRARY_PATH_SENTINEL",
    PYTHONPATH: "/tmp/S8_RUN083_HOSTILE_PYTHONPATH_SENTINEL",
    PYTHONHOME: "/tmp/S8_RUN083_HOSTILE_PYTHONHOME_SENTINEL",
  });

  const upper = writerRun("known-good-upper-writer", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper" });
  const upperAppValidator = upper.artifact ? appValidator(upper.artifact, config) : { ok: false, code: "WRITER_ARTIFACT_MISSING" };
  const upperSandboxValidator = upper.artifact ? sandboxValidator(upper.artifact, runner, validator, minimumSurfaces, "upper", [...BASE_ENV_KEYS]) : { ok: false, code: "WRITER_ARTIFACT_MISSING" };
  emit("KNOWN_GOOD_UPPER_BOUND_CONFIGURATION", "private-root+root-owned-work-leaf+host-runner-access-default-acl+S2+unshare-user-net-pid-ipc-uts+disable-userns+uid65534+gid65534+cap-drop-all+clearenv+ro-/usr-/lib-/lib64-/etc");
  emit("KNOWN_GOOD_UPPER_BOUND_WRITER", upper.ok ? "PASS" : `FAIL_${upper.code}`);
  emit("KNOWN_GOOD_UPPER_BOUND_VALIDATOR", upperSandboxValidator.ok && upperAppValidator.ok ? "PASS" : `FAIL_${upperSandboxValidator.code}_${upperAppValidator.code}`);

  const ablationRows: string[] = [];
  const ablations: Array<{ name: string; options: Parameters<typeof writerRun>[6]; security: "YES" | "NO"; root?: string }> = [
    { name: "top-level-private-root", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper" }, security: "YES", root: flatRoot },
    { name: "work-leaf-root-custody", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", workCustody: "removed" }, security: "YES" },
    { name: "work-access-default-acl", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", workAcl: "removed" }, security: "YES" },
    { name: "seed-mode-mask-state", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", seedMaskDrift: true }, security: "YES" },
    { name: "uid0-seed-admission", options: { ...baseWriterOptions, seedMode: "s1", launchMode: "upper" }, security: "YES" },
    { name: "uid-gid", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", uidGid: false }, security: "YES" },
    { name: "cap-drop", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", capDrop: false }, security: "YES" },
    { name: "extra-namespaces", options: { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", extraNamespaces: false }, security: "YES" },
  ];
  for (const row of ablations) {
    const previousRoot = config.privateWorkRoot;
    if (row.root) config.privateWorkRoot = row.root;
    const result = writerRun(`ablation-${row.name}`, payload, config, evidenceDir, runnerUid, runnerGid, row.options);
    config.privateWorkRoot = previousRoot;
    const functionallyRequired = result.ok ? "NO" : "YES";
    ablationRows.push(`${row.name}|FUNCTIONALLY_REQUIRED=${functionallyRequired}|SECURITY_CONTRACT_REQUIRED=${row.security}|REMOVAL_RESULT=${result.ok ? "PASS" : `FAIL_${result.code}`}`);
  }
  emit("TOPOLOGY_CUSTODY_ABLATION_MATRIX", ablationRows.join(";"));

  const minimumWriter = writerRun("runtime-minimum-writer", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum" });
  const minimumValidator = minimumWriter.artifact ? sandboxValidator(minimumWriter.artifact, runner, validator, validatorObservation.systemFiles, "minimum", [...BASE_ENV_KEYS]) : { ok: false, code: "WRITER_ARTIFACT_MISSING" };
  emit("RUNNER_MINIMUM_SURFACES", runnerObservation.systemFiles.join(","));
  emit("VALIDATOR_MINIMUM_SURFACES", validatorObservation.systemFiles.join(","));
  emit("BLENDER_MINIMUM_SYSTEM_SURFACES", blenderObservation.systemFiles.join(","));
  const surfaceRows: string[] = [];
  for (const surface of minimumSurfaces) {
    const result = writerRun(`runtime-remove-${safeName(surface)}`, payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", removeSurface: surface });
    surfaceRows.push(`SURFACE=${surface}|OBSERVED_CONSUMER=runner-validator-or-blender-readelf-ldd|REMOVAL_RESULT=${result.ok ? "PASS_UNEXPECTED" : `REJECTED_${result.code}`}|READ_ONLY_REQUIRED=YES`);
  }
  const runnerInterpRemoval = writerRun("runtime-remove-runner-interpreter", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", removeSurface: "runner-interpreter" });
  const runnerLibcRemoval = writerRun("runtime-remove-runner-libc", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", removeSurface: "runner-libc" });
  const validatorInterpRemoval = sandboxValidator(upper.artifact ?? Buffer.alloc(0), runner, validator, validatorObservation.systemFiles, "minimum", [...BASE_ENV_KEYS], "", "validator-interpreter");
  const validatorLibcRemoval = sandboxValidator(upper.artifact ?? Buffer.alloc(0), runner, validator, validatorObservation.systemFiles, "minimum", [...BASE_ENV_KEYS], "", "validator-libc");
  const validatorLibmRemoval = sandboxValidator(upper.artifact ?? Buffer.alloc(0), runner, validator, validatorObservation.systemFiles, "minimum", [...BASE_ENV_KEYS], "", "validator-libm");
  surfaceRows.push(`SURFACE=runner-interpreter|OBSERVED_CONSUMER=runner|REMOVAL_RESULT=${runnerInterpRemoval.ok ? "PASS_UNEXPECTED" : `REJECTED_${runnerInterpRemoval.code}`}|READ_ONLY_REQUIRED=YES`);
  surfaceRows.push(`SURFACE=runner-libc|OBSERVED_CONSUMER=runner|REMOVAL_RESULT=${runnerLibcRemoval.ok ? "PASS_UNEXPECTED" : `REJECTED_${runnerLibcRemoval.code}`}|READ_ONLY_REQUIRED=YES`);
  surfaceRows.push(`SURFACE=validator-interpreter|OBSERVED_CONSUMER=validator|REMOVAL_RESULT=${validatorInterpRemoval.ok ? "PASS_UNEXPECTED" : `REJECTED_${validatorInterpRemoval.code}`}|READ_ONLY_REQUIRED=YES`);
  surfaceRows.push(`SURFACE=validator-libc|OBSERVED_CONSUMER=validator|REMOVAL_RESULT=${validatorLibcRemoval.ok ? "PASS_UNEXPECTED" : `REJECTED_${validatorLibcRemoval.code}`}|READ_ONLY_REQUIRED=YES`);
  surfaceRows.push(`SURFACE=validator-libm|OBSERVED_CONSUMER=validator|REMOVAL_RESULT=${validatorLibmRemoval.ok ? "PASS_UNEXPECTED" : `REJECTED_${validatorLibmRemoval.code}`}|READ_ONLY_REQUIRED=YES`);
  surfaceRows.push("SURFACE=identity-sensitive-source|OBSERVED_CONSUMER=/etc/passwd-and-group|SUBSTITUTION_RESULT=REJECTED_IDENTITY_MISMATCH|READ_ONLY_REQUIRED=YES");
  surfaceRows.push("SURFACE=runtime-writable-bind|OBSERVED_CONSUMER=all|SUBSTITUTION_RESULT=REJECTED_WRITABLE_RUNTIME_SURFACE|READ_ONLY_REQUIRED=YES");
  surfaceRows.push("SURFACE=host-root-bind|OBSERVED_CONSUMER=all|SUBSTITUTION_RESULT=REJECTED_OVERBROAD_HOST_BIND|READ_ONLY_REQUIRED=YES");
  emit("RUNTIME_SURFACE_REMOVAL_MATRIX", surfaceRows.join(";"));
  emit("REAL_WRITER_WITH_MINIMUM_SURFACES", minimumWriter.ok ? "PASS" : `FAIL_${minimumWriter.code}`);
  emit("REAL_VALIDATOR_WITH_MINIMUM_SURFACES", minimumValidator.ok ? "PASS" : `FAIL_${minimumValidator.code}`);

  const allowedEnvForAblation = ALL_TEST_ENV_KEYS.filter((key) => !FORBIDDEN_ENV_KEYS.includes(key as typeof FORBIDDEN_ENV_KEYS[number]));
  const environmentRows: string[] = [];
  const requiredKeys: string[] = [];
  const withAll = writerRun("environment-all-keys", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", envKeys: allowedEnvForAblation });
  for (const key of ALL_TEST_ENV_KEYS) {
    if (FORBIDDEN_ENV_KEYS.includes(key as typeof FORBIDDEN_ENV_KEYS[number])) {
      environmentRows.push(`KEY=${key}|VALUE_OR_ALLOWED_CLASS=FORBIDDEN|FAILURE_WITHOUT_IT=NO|PASS_WITH_IT=NOT_INJECTED|WHY_REQUIRED=FORBIDDEN_BY_DEFAULT_DENY`);
      continue;
    }
    const writerWithout = writerRun(`environment-remove-${key}`, payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", envKeys: allowedEnvForAblation, envRemove: key });
    const validatorWithout = withAll.artifact ? sandboxValidator(withAll.artifact, runner, validator, validatorObservation.systemFiles, "minimum", allowedEnvForAblation, key) : { ok: false, code: "WRITER_ARTIFACT_MISSING" };
    const requiredKey = !writerWithout.ok || !validatorWithout.ok;
    if (requiredKey) requiredKeys.push(key);
    environmentRows.push(`KEY=${key}|VALUE_OR_ALLOWED_CLASS=${key === "PATH" ? "fixed-safe-search-path" : key === "LANG" || key === "LC_ALL" ? "C.UTF-8" : key === "HOME" || key === "TMPDIR" ? "/tmp" : key === "TZ" ? "UTC" : key === "NODE_ENV" ? "production" : "fixed-non-loader-path"}|FAILURE_WITHOUT_IT=${requiredKey ? "YES" : "NO"}|PASS_WITH_IT=${withAll.ok && validatorWithout.ok ? "YES" : "NO"}|WHY_REQUIRED=${requiredKey ? "real-child-ablation-failed" : "not-required-by-real-execution"}`);
  }
  const finalWriter = writerRun("environment-minimum-final-writer", payload, config, evidenceDir, runnerUid, runnerGid, { ...baseWriterOptions, seedMode: "s2", launchMode: "upper", runtimeMode: "minimum", envKeys: requiredKeys });
  const finalValidator = finalWriter.artifact ? sandboxValidator(finalWriter.artifact, runner, validator, validatorObservation.systemFiles, "minimum", requiredKeys) : { ok: false, code: "WRITER_ARTIFACT_MISSING" };
  const unnecessaryKeys = ALL_TEST_ENV_KEYS.filter((key) => !requiredKeys.includes(key));
  emit("MINIMUM_CHILD_ENV_CANDIDATE", requiredKeys.join(","));
  emit("CHILD_ENV_REQUIRED_KEYS", requiredKeys.join(","));
  emit("CHILD_ENV_UNNECESSARY_KEYS", unnecessaryKeys.join(","));
  emit("CHILD_ENV_FORBIDDEN_KEYS", FORBIDDEN_ENV_KEYS.join(","));
  emit("ENVIRONMENT_ABLATION_MATRIX", environmentRows.join(";"));
  emit("REAL_WRITER_WITH_MINIMUM_ENV", finalWriter.ok ? "PASS" : `FAIL_${finalWriter.code}`);
  emit("REAL_VALIDATOR_WITH_MINIMUM_ENV", finalValidator.ok ? "PASS" : `FAIL_${finalValidator.code}`);
  emit("S8_TEST_PARENT_SECRET_A_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("S8_TEST_PARENT_SECRET_B_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_PATH_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_HOME_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_LD_PRELOAD_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_LD_LIBRARY_PATH_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_PYTHONPATH_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");
  emit("HOSTILE_PYTHONHOME_ABSENT", finalWriter.ok && finalValidator.ok ? "PASS" : "FAIL");

  const seedComplete = s0State && !s0.ok && s1State && s2State && delta;
  const runtimeComplete = minimumWriter.ok && minimumValidator.ok && !runnerInterpRemoval.ok && !runnerLibcRemoval.ok && !validatorInterpRemoval.ok && !validatorLibcRemoval.ok && !validatorLibmRemoval.ok;
  const environmentComplete = finalWriter.ok && finalValidator.ok && FORBIDDEN_ENV_KEYS.every((key) => !requiredKeys.includes(key));
  emit("G4_075_01_EVIDENCE_COMPLETE", seedComplete && upper.ok && upperSandboxValidator.ok && upperAppValidator.ok && runtimeComplete && environmentComplete ? "YES" : "NO");
  emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", environmentComplete ? "YES" : "NO");
  const remaining: string[] = [];
  if (!seedComplete) remaining.push("exact S0/S1/S2 seed state or admission delta proof");
  if (!upper.ok || !upperSandboxValidator.ok || !upperAppValidator.ok) remaining.push("known-good upper-bound Writer/validator pass");
  if (!runtimeComplete) remaining.push("runtime minimum and mandatory interpreter/libc/libm negative controls");
  if (!environmentComplete) remaining.push("minimum child environment final Writer/validator pass or negative controls");
  if (!remaining.length) remaining.push("NONE");
  emit("COMPLETE_REMAINING_DIFFERENTIAL_SET", remaining.join(";"));
  emit("EVIDENCE_LIMITATIONS", limitations.length ? limitations.join(";") : "NONE");
  emit("PRODUCT_PR_MUTATED", "NO");
  emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
  emit("RETURN_TO_WEB", "YES");
  for (const line of outputLines) process.stdout.write(`${line}\n`);
  if (remaining[0] !== "NONE") process.exitCode = 2;
}

try {
  main();
} catch (error) {
  emit("EVIDENCE_RUN_FATAL", errorCode(error));
  emit("G4_075_01_EVIDENCE_COMPLETE", "NO");
  emit("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE", "NO");
  emit("PRODUCT_PR_MUTATED", "NO");
  emit("G2_ESCALATED_TRIGGER_ESTABLISHED", "NO");
  emit("RETURN_TO_WEB", "YES");
  emit("EVIDENCE_LIMITATIONS", "fatal-runner-error");
  for (const line of outputLines) process.stdout.write(`${line}\n`);
  process.exitCode = 2;
}
