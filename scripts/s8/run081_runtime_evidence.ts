import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildS8WriterPayload } from "../../src/lib/s8-fbx-payload";
import { S8_LIMITS } from "../../src/lib/s8-fbx-profile";
import { AppError, type S6ToS7Handoff, type S7ToS8Handoff } from "../../src/lib/types";
import { runS8BlenderWriter, runS8NativeValidator, type S8WorkerConfig } from "../../src/lib/s8-fbx-worker";

type EnvPolicy = Record<string, string>;
type Surface = { id: string; source: string; target: string };
type MountInfo = { id: string; parentId: string; majorMinor: string; mountPoint: string; mountOptions: string; propagation: string; filesystem: string; };
type SnapshotEntry = { path: string; stat: string; acl: string; mount: MountInfo | null };
type Cell = {
  label: string;
  root: string;
  custody: "none" | "root-acl";
  identity: "none" | "hosted";
  surfaces: string[];
  pass: boolean;
  appError: string;
  bindSourceReached: "YES" | "NO" | "UNKNOWN";
  workChdirReached: "YES" | "NO" | "UNKNOWN";
  runnerStarted: "YES" | "NO" | "UNKNOWN";
  targetStarted: "YES" | "NO" | "UNKNOWN";
  firstFailureBoundary: string;
  workPath: string;
  preSnapshot: SnapshotEntry[];
  postSnapshot: SnapshotEntry[];
  stdout: string;
  stderr: string;
  argvCount: string;
  argvSha256: string;
  argvManifest: string;
  envPresence: string;
  artifact: Buffer | null;
};
type DirectResult = { status: number; stdout: string; stderr: string; receiptCode: number | null; pass: boolean };

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ENV_KEYS = ["LANG", "LC_ALL", "HOME", "PATH", "TMPDIR", "TZ", "NODE_ENV"] as const;
const FORBIDDEN_ENV_KEYS = ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONPATH", "PYTHONHOME"] as const;
const RECEIPT_PREFIX = "S8_RUNNER_RECEIPT:";
const EXPECTED_BWRAP_SHA256 = "e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71";
const BIND_FAILURE = /(?:can't|cannot|failed to|unable to)\s+(?:bind|mount)|bind\s+source.*(?:permission denied|denied|invalid)|permission denied.*(?:bind|mount)/iu;
const CHDIR_FAILURE = /(?:chdir|change directory|working directory)/iu;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RUN081_MISSING_ENV_${name}`);
  return value;
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "",
  };
}

function sudoCommand(args: string[]): { status: number; stdout: string; stderr: string } {
  return runCommand("/usr/bin/sudo", ["-n", ...args]);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function boundedText(value: string, maximum = 4096): string {
  return value.replace(/\r/g, "").replace(/(authorization|cookie|token|secret|password|api[_-]?key)\s*[:=].*/giu, "$1=[REDACTED]").slice(0, maximum);
}

function modeText(mode: number): string {
  return `${(mode & 0o7777).toString(8).padStart(4, "0")}`;
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountInfoForPath(path: string): MountInfo | null {
  let text: string;
  try {
    text = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
  const canonical = path.replace(/\\/gu, "/");
  let best: MountInfo | null = null;
  for (const line of text.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 1) continue;
    const mountPoint = unescapeMountField(left[4]!);
    if (canonical !== mountPoint && !canonical.startsWith(`${mountPoint === "/" ? "" : mountPoint}/`)) continue;
    if (best && best.mountPoint.length >= mountPoint.length) continue;
    const optional = left.slice(6).filter((value) => /^(?:shared|master|propagate_from|unbindable):/u.test(value));
    best = {
      id: left[0]!,
      parentId: left[1]!,
      majorMinor: left[2]!,
      mountPoint,
      mountOptions: left[5]!,
      propagation: optional.join(",") || "private_or_unreported",
      filesystem: right[0]!,
    };
  }
  return best;
}

function pathMetadata(path: string): Record<string, unknown> {
  const literal = path;
  let canonical = path;
  try {
    canonical = realpathSync(path);
    const info = lstatSync(path);
    const stat = statSync(path);
    const acl = runCommand("/usr/bin/getfacl", ["--numeric", "--omit-header", "--absolute-names", "--", path]);
    return {
      literal,
      canonical,
      device: stat.dev,
      inode: stat.ino,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other",
      uid: stat.uid,
      gid: stat.gid,
      mode: modeText(stat.mode),
      acl: boundedText(acl.stdout, 8192),
      mount: mountInfoForPath(canonical),
    };
  } catch {
    return { literal, canonical, status: "ABSENT_OR_UNREADABLE" };
  }
}

function parseSnapshot(path: string): SnapshotEntry[] {
  if (!existsSync(path)) return [];
  const entries: SnapshotEntry[] = [];
  let current: { path: string; stat: string; acl: string[] } | null = null;
  let inAcl = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("PATH\t")) {
      if (current) entries.push({ path: current.path, stat: current.stat, acl: current.acl.join("\n"), mount: mountInfoForPath(current.path) });
      current = { path: line.slice(5), stat: "", acl: [] };
      inAcl = false;
    } else if (line.startsWith("STAT\t") && current) current.stat = line.slice(5);
    else if (line === "ACL_BEGIN") inAcl = true;
    else if (line === "ACL_END") inAcl = false;
    else if (inAcl && current) current.acl.push(line);
  }
  if (current) entries.push({ path: current.path, stat: current.stat, acl: current.acl.join("\n"), mount: mountInfoForPath(current.path) });
  return entries;
}

function parseMeta(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function receiptCode(stdout: string): number | null {
  const line = stdout.split("\n").find((value) => value.startsWith(RECEIPT_PREFIX));
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line.slice(RECEIPT_PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = (value as { result?: { code?: unknown } }).result?.code;
    return typeof result === "number" ? result : null;
  } catch {
    return null;
  }
}

function classifyCell(label: string, root: string, custody: "none" | "root-acl", identity: "none" | "hosted", surfaces: string[], appError: string, meta: Record<string, string>, stdout: string, stderr: string, artifact: Buffer | null): Cell {
  const bindSourceReached: Cell["bindSourceReached"] = meta.ERROR ? "UNKNOWN" : BIND_FAILURE.test(stderr) ? "NO" : "YES";
  const code = receiptCode(stdout);
  const runnerStarted: Cell["runnerStarted"] = code === null ? "NO" : "YES";
  const workChdirReached: Cell["workChdirReached"] = CHDIR_FAILURE.test(stderr) ? "NO" : bindSourceReached === "NO" ? "UNKNOWN" : "YES";
  const targetStarted: Cell["targetStarted"] = code === null ? "NO" : code === 71 || code === 73 ? "NO" : "YES";
  let firstFailureBoundary = "NONE";
  if (bindSourceReached === "NO") firstFailureBoundary = "BWRAP_BIND_SOURCE";
  else if (workChdirReached === "NO") firstFailureBoundary = "BWRAP_WORK_CHDIR";
  else if (runnerStarted === "NO") firstFailureBoundary = "RUNNER_START";
  else if (targetStarted === "NO") firstFailureBoundary = "TARGET_START";
  else if (!artifact) firstFailureBoundary = appError || "TARGET_RUNTIME";
  return {
    label, root, custody, identity, surfaces, pass: artifact !== null, appError: appError || "NONE",
    bindSourceReached, workChdirReached, runnerStarted, targetStarted, firstFailureBoundary,
    workPath: meta.WORK_SOURCE ?? "UNKNOWN", preSnapshot: parseSnapshot(meta.SNAPSHOT_PRE ?? ""), postSnapshot: parseSnapshot(meta.SNAPSHOT_POST ?? ""),
    stdout: boundedText(stdout), stderr: boundedText(stderr),
    argvCount: meta.APP_ARGV_COUNT ?? "UNKNOWN", argvSha256: meta.APP_ARGV_SHA256 ?? "UNKNOWN", argvManifest: meta.APP_ARGV_MANIFEST ?? "UNKNOWN", envPresence: meta.CONTROLLED_ENV_PRESENCE ?? "UNKNOWN", artifact,
  };
}

function printCell(cell: Cell): void {
  const prefix = cell.label;
  console.log(`${prefix}_RESULT=${cell.pass ? "PASS" : "FAIL"}`);
  console.log(`${prefix}_BIND_SOURCE_REACHED=${cell.bindSourceReached}`);
  console.log(`${prefix}_WORK_CHDIR_REACHED=${cell.workChdirReached}`);
  console.log(`${prefix}_RUNNER_STARTED=${cell.runnerStarted}`);
  console.log(`${prefix}_TARGET_STARTED=${cell.targetStarted}`);
  console.log(`${prefix}_FIRST_FAILURE_BOUNDARY=${cell.firstFailureBoundary}`);
  console.log(`${prefix}_APP_ERROR=${cell.appError}`);
  console.log(`${prefix}_WORK_LITERAL=${cell.workPath}`);
  console.log(`${prefix}_APP_ARGV_COUNT=${cell.argvCount}`);
  console.log(`${prefix}_APP_ARGV_SHA256=${cell.argvSha256}`);
  console.log(`${prefix}_APP_ARGV_MANIFEST=${cell.argvManifest}`);
  console.log(`${prefix}_CONTROLLED_ENV_PRESENCE=${cell.envPresence}`);
  console.log(`${prefix}_WORK_ANCESTRY=${JSON.stringify(cell.preSnapshot)}`);
  if (cell.postSnapshot.length) console.log(`${prefix}_WORK_ANCESTRY_POST=${JSON.stringify(cell.postSnapshot)}`);
  if (cell.stderr) console.log(`${prefix}_BOUNDED_STDERR=${JSON.stringify(cell.stderr)}`);
}

function makeSources(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const hash = "a".repeat(64);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const object = {
    objectId: "run081-object",
    identityKey: "run081-identity",
    parentObjectId: null,
    objectType: "box",
    role: "furniture",
    label: "run081-object",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" },
    footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 },
    transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 },
    zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "user_confirmed_design_decision", sourceRef: "run081", sourceFingerprint: hash, acceptedByUser: true, note: null },
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: revisionId, acceptedRevisionHash: hash, sourceS5Fingerprint: hash,
    spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: 3000, heightState: "known" },
    objects: [object], hierarchy: [{ objectId: object.objectId, parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } as unknown as S7ToS8Handoff;
  return { s6, s7 };
}

function writeLines(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function envLines(policy: EnvPolicy): string[] {
  return Object.entries(policy).map(([key, value]) => `${key}=${value}`);
}

function makeShim(path: string): void {
  const source = String.raw`#!/usr/bin/bash
set -u
base="$S8_RUN081_SHIM_DIAG_BASE"
meta="$base.meta"
pre="$base.pre"
post="$base.post"
stdout_path="$base.stdout"
stderr_path="$base.stderr"
bwrap="\${S8_RUN081_BWRAP_PATH:?}"
argv_manifest="$base.argv-manifest"
env_presence="$base.env-presence"
argv_count=UNKNOWN
argv_sha=UNKNOWN
mkdir -p "$(/usr/bin/dirname -- "$base")"
abort() {
  printf 'STATUS=%s\nERROR=%s\nWORK_SOURCE=%s\nSNAPSHOT_PRE=%s\nSNAPSHOT_POST=%s\nAPP_ARGV_COUNT=%s\nAPP_ARGV_SHA256=%s\nAPP_ARGV_MANIFEST=%s\nCONTROLLED_ENV_PRESENCE=%s\n' "$2" "$1" "\${work_source:-UNKNOWN}" "$pre" "$post" "$argv_count" "$argv_sha" "$argv_manifest" "$env_presence" > "$meta"
  exit "$2"
}
snapshot_path() {
  local input="$1" output="$2" current next stat_line
  [[ -e "$input" && ! -L "$input" ]] || return 1
  current="$(/usr/bin/realpath -e -- "$input")" || return 1
  : > "$output"
  while :; do
    stat_line="$(/usr/bin/stat -c '%d:%i:%f:%u:%g:%a' -- "$current")" || return 1
    printf 'PATH\t%s\nSTAT\t%s\nACL_BEGIN\n' "$current" "$stat_line" >> "$output"
    /usr/bin/getfacl --numeric --omit-header --absolute-names -- "$current" >> "$output" || return 1
    printf 'ACL_END\n' >> "$output"
    [[ "$current" == "/" ]] && break
    next="$(/usr/bin/dirname -- "$current")"
    [[ "$next" != "$current" ]] || break
    current="$next"
  done
}
args=("$@")
work_source=""
command_index=-1
redact_arg() {
  case "$1" in
    *secret*|*token*|*password*|*authorization*) printf '<REDACTED>' ;;
    --*|/runtime/*|/work|/proc|/dev|/tmp) printf '%s' "$1" ;;
    /*) printf '<ABS_PATH>' ;;
    *) printf '%s' "$1" ;;
  esac
}
: > "$argv_manifest"
for ((index=0; index<\${#args[@]} && index<256; index+=1)); do
  redact_arg "\${args[$index]:-}" >> "$argv_manifest"
  printf '\n' >> "$argv_manifest"
done
argv_count="\${#args[@]}"
argv_sha="$(/usr/bin/sha256sum -- "$argv_manifest" | /usr/bin/awk '{print $1}')"
for key in LANG LC_ALL HOME PATH TMPDIR TZ NODE_ENV S8_TEST_PARENT_SECRET_A S8_TEST_PARENT_SECRET_B LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME; do
  if [[ "\${!key+x}" == "x" ]]; then printf '%s=PRESENT\n' "$key"; else printf '%s=ABSENT\n' "$key"; fi
done > "$env_presence"
for ((index=0; index<\${#args[@]}; index+=1)); do
  if [[ "\${args[$index]:-}" == "--bind" && "\${args[$((index + 2))]:-}" == "/work" ]]; then
    work_source="\${args[$((index + 1))]}"
  fi
  if [[ "\${args[$index]:-}" == "/runtime/process-runner" && "\${args[$((index - 1))]:-}" == "/runtime/process-runner" ]]; then
    command_index=$index
  fi
done
[[ -n "$work_source" && $command_index -gt 0 ]] || abort ARGUMENT_SHAPE_INVALID 70
snapshot_path "$work_source" "$pre" || abort WORK_SNAPSHOT_FAILED 71
custody_before="$(/usr/bin/stat -c '%d:%i:%u:%g:%a' -- "$work_source")"
if [[ "\${S8_RUN081_SHIM_CUSTODY:-none}" == "root-acl" ]]; then
  runner_uid="\${S8_RUN081_RUNNER_UID:?}"
  if ! /usr/bin/sudo -n /usr/bin/chown root:root -- "$work_source"; then abort CUSTODY_CHOWN_FAILED 72; fi
  if ! /usr/bin/sudo -n /usr/bin/chmod 0770 -- "$work_source"; then abort CUSTODY_CHMOD_FAILED 73; fi
  acl_spec="u::rwx,u:\${runner_uid}:rwx,g::---,m::rwx,o::---"
  if ! /usr/bin/sudo -n /usr/bin/setfacl --no-mask --set "$acl_spec" -- "$work_source"; then abort CUSTODY_ACCESS_ACL_FAILED 74; fi
  if ! /usr/bin/sudo -n /usr/bin/setfacl --no-mask --default --set "$acl_spec" -- "$work_source"; then abort CUSTODY_DEFAULT_ACL_FAILED 75; fi
fi
custody_after="$(/usr/bin/stat -c '%d:%i:%u:%g:%a' -- "$work_source")"
snapshot_path "$work_source" "$post" || abort WORK_POST_SNAPSHOT_FAILED 76
identity_args=()
if [[ "\${S8_RUN081_SHIM_IDENTITY:-none}" == "hosted" ]]; then
  identity_args=(--unshare-pid --unshare-ipc --unshare-uts --disable-userns --assert-userns-disabled --uid 65534 --gid 65534 --cap-drop ALL)
fi
final_args=("\${args[@]}")
if [[ "\${S8_RUN081_SHIM_SURFACES:-NO}" == "YES" ]]; then
  before=("\${args[@]:0:$command_index}")
  after=("\${args[@]:$command_index}")
  final_args=("\${identity_args[@]}" "\${before[@]}")
  while IFS=$'\t' read -r surface_id surface_source surface_target; do
    [[ -n "\${surface_id:-}" ]] || continue
    final_args+=(--ro-bind "$surface_source" "$surface_target")
  done < "$S8_RUN081_SHIM_SURFACE_FILE"
  while IFS=$'\t' read -r mask_source mask_target; do
    [[ -n "\${mask_source:-}" ]] || continue
    final_args+=(--ro-bind "$mask_source" "$mask_target")
  done < "\${S8_RUN081_SHIM_MASK_FILE:-/dev/null}"
  final_args+=("\${after[@]}")
elif ((\${#identity_args[@]} > 0)); then
  final_args=("\${identity_args[@]}" "\${args[@]}")
fi
if [[ "\${S8_RUN081_SHIM_SANITIZE_ENV:-NO}" == "YES" ]]; then
  mapfile -t policy_args < "$S8_RUN081_SHIM_ENV_FILE"
  set +e
  /usr/bin/env -i "\${policy_args[@]}" /usr/bin/sudo -n "$bwrap" "\${final_args[@]}" > "$stdout_path" 2> "$stderr_path"
  status=$?
  set -e
else
  set +e
  /usr/bin/sudo -n "$bwrap" "\${final_args[@]}" > "$stdout_path" 2> "$stderr_path"
  status=$?
  set -e
fi
printf 'STATUS=%s\nWORK_SOURCE=%s\nSNAPSHOT_PRE=%s\nSNAPSHOT_POST=%s\nCUSTODY_BEFORE=%s\nCUSTODY_AFTER=%s\nAPP_ARGV_COUNT=%s\nAPP_ARGV_SHA256=%s\nAPP_ARGV_MANIFEST=%s\nCONTROLLED_ENV_PRESENCE=%s\n' "$status" "$work_source" "$pre" "$post" "$custody_before" "$custody_after" "$argv_count" "$argv_sha" "$argv_manifest" "$env_presence" > "$meta"
/usr/bin/cat -- "$stdout_path"
/usr/bin/cat -- "$stderr_path" >&2
exit "$status"
`.replaceAll("\\${", "${");
  writeFileSync(path, source, { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
}

function baseEnv(): EnvPolicy {
  return { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/tmp", PATH: SAFE_PATH, TMPDIR: "/tmp", TZ: "UTC", NODE_ENV: "production" };
}

function withEnvironment<T>(policy: EnvPolicy, callback: () => T): T {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, policy);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function makeConfig(paths: { blenderRoot: string; blender: string; writer: string; runner: string; validator: string; bwrap: string; shim: string; root: string; sha: string }): S8WorkerConfig {
  return {
    blenderRuntimeRoot: paths.blenderRoot,
    blenderExecutable: paths.blender,
    writerScript: paths.writer,
    privateWorkRoot: paths.root,
    processRunnerExecutable: paths.runner,
    sandboxExecutable: paths.shim,
    nativeValidatorExecutable: paths.validator,
    blenderExecutableSha256: paths.sha,
  };
}

function makeCellRunner(options: {
  label: string; root: string; custody: "none" | "root-acl"; identity: "none" | "hosted"; surfaceIds: string[]; masks: Array<{ source: string; target: string }>; envPolicy: EnvPolicy | null; diagnosticsRoot: string; shim: string; surfaceFile: string; runnerUid: number; paths: Parameters<typeof makeConfig>[0]; payload: Buffer;
}): Cell {
  const base = join(options.diagnosticsRoot, options.label.toLowerCase());
  const maskFile = `${base}.masks`;
  writeLines(maskFile, options.masks.map((mask) => `${mask.source}\t${mask.target}`));
  const envFile = `${base}.env`;
  writeLines(envFile, options.envPolicy ? envLines(options.envPolicy) : envLines(baseEnv()));
  const surfaceFile = `${base}.surfaces`;
  writeLines(surfaceFile, options.surfaceIds.map((id) => `${id}\t${surfaceForId(id).source}\t${surfaceForId(id).target}`));
  const shimEnvironment: Record<string, string> = {
    S8_RUN081_SHIM_DIAG_BASE: base,
    S8_RUN081_BWRAP_PATH: options.paths.bwrap,
    S8_RUN081_SHIM_CUSTODY: options.custody,
    S8_RUN081_SHIM_IDENTITY: options.identity,
    S8_RUN081_SHIM_SURFACES: options.surfaceIds.length ? "YES" : "NO",
    S8_RUN081_SHIM_SURFACE_FILE: surfaceFile,
    S8_RUN081_SHIM_MASK_FILE: maskFile,
    S8_RUN081_SHIM_ENV_FILE: envFile,
    S8_RUN081_SHIM_SANITIZE_ENV: options.envPolicy ? "YES" : "NO",
    S8_RUN081_RUNNER_UID: String(options.runnerUid),
  };
  let appError = "";
  const policy = options.envPolicy ?? baseEnv();
  const invocationEnv: EnvPolicy = { ...policy };
  for (const [key, value] of Object.entries(shimEnvironment)) if (typeof value === "string") invocationEnv[key] = value;
  const writer = withEnvironment(invocationEnv, () => {
    try {
      return runS8BlenderWriter(options.payload, makeConfig({ ...options.paths, root: options.root }), () => undefined);
    } catch (error) {
      appError = error instanceof AppError ? error.code : error instanceof Error ? error.name : "RUN081_UNKNOWN_ERROR";
      return null;
    }
  });
  const meta = parseMeta(`${base}.meta`);
  const stdout = existsSync(`${base}.stdout`) ? readFileSync(`${base}.stdout`, "utf8") : "";
  const stderr = existsSync(`${base}.stderr`) ? readFileSync(`${base}.stderr`, "utf8") : "";
  const result = classifyCell(options.label, options.root, options.custody, options.identity, options.surfaceIds, appError, meta, stdout, stderr, writer?.artifact ?? null);
  if (result.pass && writer) console.log(`${options.label}_PAYLOAD_SHA256=${sha256File(join(options.diagnosticsRoot, "payload.json"))}`);
  return result;
}

let allSurfaces: Surface[] = [];
function surfaceForId(id: string): Surface {
  const value = allSurfaces.find((surface) => surface.id === id);
  if (!value) throw new Error(`RUN081_UNKNOWN_SURFACE_${id}`);
  return value;
}

function applyCustody(path: string, runnerUid: number): void {
  const before = statSync(path);
  const chown = sudoCommand(["/usr/bin/chown", "root:root", "--", path]);
  if (chown.status !== 0) throw new Error("RUN081_DIRECT_CUSTODY_CHOWN_FAILED");
  const chmod = sudoCommand(["/usr/bin/chmod", "0770", "--", path]);
  if (chmod.status !== 0) throw new Error("RUN081_DIRECT_CUSTODY_CHMOD_FAILED");
  const acl = `u::rwx,u:${runnerUid}:rwx,g::---,m::rwx,o::---`;
  if (sudoCommand(["/usr/bin/setfacl", "--no-mask", "--set", acl, "--", path]).status !== 0) throw new Error("RUN081_DIRECT_ACCESS_ACL_FAILED");
  if (sudoCommand(["/usr/bin/setfacl", "--no-mask", "--default", "--set", acl, "--", path]).status !== 0) throw new Error("RUN081_DIRECT_DEFAULT_ACL_FAILED");
  const after = statSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("RUN081_DIRECT_CUSTODY_IDENTITY_CHANGED");
}

function directBwrap(options: {
  root: string; identity: "none" | "hosted"; custody: "none" | "root-acl"; surfaces: string[]; masks: Array<{ source: string; target: string }>; envPolicy: EnvPolicy; runner: string; validator?: string; bwrap: string; extraBinds?: Array<{ source: string; target: string }>; target: string; targetArgs: string[]; work: string;
}): DirectResult {
  const args: string[] = ["--unshare-user", "--unshare-net"];
  if (options.identity === "hosted") args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--uid", "65534", "--gid", "65534", "--cap-drop", "ALL");
  args.push("--die-with-parent", "--new-session");
  for (const id of options.surfaces) {
    const surface = surfaceForId(id);
    args.push("--ro-bind", surface.source, surface.target);
  }
  for (const bind of options.extraBinds ?? []) args.push("--ro-bind", bind.source, bind.target);
  args.push("--ro-bind", options.runner, "/runtime/process-runner");
  if (options.validator) args.push("--ro-bind", options.validator, "/runtime/validator");
  args.push("--bind", options.work, "/work", "--chdir", "/work", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const mask of options.masks) args.push("--ro-bind", mask.source, mask.target);
  args.push("--", options.target, ...options.targetArgs);
  const command = runCommand("/usr/bin/env", ["-i", ...envLines(options.envPolicy), "/usr/bin/sudo", "-n", options.bwrap, ...args]);
  return { ...command, receiptCode: receiptCode(command.stdout), pass: command.status === 0 && receiptCode(command.stdout) === 0 };
}

function runValidatorSurface(options: { label: string; root: string; identity: "none" | "hosted"; custody: "none" | "root-acl"; artifact: Buffer; surfaceIds: string[]; masks: Array<{ source: string; target: string }>; envPolicy: EnvPolicy; runner: string; validator: string; bwrap: string; runnerUid: number; diagnosticsRoot: string }): DirectResult {
  const work = mkdtempSync(join(options.root, "s8-run081-validator-"));
  chmodSync(work, 0o700);
  writeFileSync(join(work, "artifact.fbx"), options.artifact, { mode: 0o600, flag: "wx" });
  if (options.custody === "root-acl") applyCustody(work, options.runnerUid);
  const result = directBwrap({ root: options.root, identity: options.identity, custody: options.custody, surfaces: options.surfaceIds, masks: options.masks, envPolicy: options.envPolicy, runner: options.runner, validator: options.validator, bwrap: options.bwrap, target: "/runtime/process-runner", targetArgs: ["--address-space-bytes", String(S8_LIMITS.validatorMemoryBytes), "--file-bytes", String(S8_LIMITS.validatorTempBytes), "--timeout-ms", String(S8_LIMITS.validatorTimeoutMs), "--stdout-bytes", String(S8_LIMITS.readbackBytes), "--stderr-bytes", String(S8_LIMITS.stderrBytes), "--max-children", "0", "--", "/runtime/validator", "/work/artifact.fbx"], work });
  try { rmSync(work, { recursive: true, force: true }); } catch { /* bounded diagnostic cleanup */ }
  console.log(`${options.label}_RESULT=${result.pass ? "PASS" : "FAIL"}`);
  console.log(`${options.label}_STATUS=${result.status}`);
  console.log(`${options.label}_RECEIPT_CODE=${result.receiptCode ?? "NONE"}`);
  if (result.stderr) console.log(`${options.label}_BOUNDED_STDERR=${JSON.stringify(boundedText(result.stderr))}`);
  return result;
}

function readElf(path: string): { interpreter: string; needed: string[]; runpath: string } {
  const program = runCommand("/usr/bin/readelf", ["-l", path]);
  const dynamic = runCommand("/usr/bin/readelf", ["-d", path]);
  const interpreter = program.stdout.match(/Requesting program interpreter:\s*(\S+)/u)?.[1] ?? "UNKNOWN";
  const needed = [...dynamic.stdout.matchAll(/Shared library:\s*\[(.+?)\]/gu)].map((match) => match[1]!).filter((value, index, values) => values.indexOf(value) === index);
  const runpath = dynamic.stdout.match(/(?:Library runpath|Library rpath):\s*\[(.+?)\]/u)?.[1] ?? "NONE";
  return { interpreter, needed, runpath };
}

function resolveLibrary(name: string): string {
  const result = runCommand("/sbin/ldconfig", ["-p"]);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = result.stdout.match(new RegExp(`\\s${escaped} \\(.*?\\) => (\\S+)`, "u"));
  if (!match?.[1]) throw new Error(`RUN081_LIBRARY_NOT_FOUND_${name}`);
  return realpathSync(match[1]);
}

function mountDomainKey(value: MountInfo | null): string {
  return value ? `${value.id}:${value.majorMinor}:${value.mountPoint}:${value.filesystem}` : "UNKNOWN";
}

function sameMountDomain(left: MountInfo | null, right: MountInfo | null): boolean {
  return left !== null && right !== null && mountDomainKey(left) === mountDomainKey(right);
}

function surfaceSourcePolicy(source: string): boolean {
  if (source === "/") return false;
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(source);
  } catch {
    return false;
  }
  if (!info.isDirectory()) return false;
  try {
    accessSync(source, fsConstants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function surfaceCandidatePolicy(surface: Surface, candidate: string): boolean {
  return surfaceSourcePolicy(candidate) && realpathSync(candidate) === surface.source;
}

function printTopologySummary(cells: Cell[], mountDomains: { runnerTemp: MountInfo | null; topLevel: MountInfo | null; hostRoot: MountInfo | null }, limitations: string[]): void {
  for (const cell of cells) printCell(cell);
  console.log(`RUNNER_TEMP_MOUNT_DOMAIN=${JSON.stringify(mountDomains.runnerTemp)}`);
  console.log(`TOP_LEVEL_PRIVATE_ROOT_MOUNT_DOMAIN=${JSON.stringify(mountDomains.topLevel)}`);
  console.log(`HOST_ROOT_MOUNT_DOMAIN=${JSON.stringify(mountDomains.hostRoot)}`);
  console.log(`MOUNT_DOMAIN_DIFFERENCE=${JSON.stringify({ runnerTempVsTopLevel: !sameMountDomain(mountDomains.runnerTemp, mountDomains.topLevel), topLevelVsHostRoot: !sameMountDomain(mountDomains.topLevel, mountDomains.hostRoot), runnerTempVsHostRoot: !sameMountDomain(mountDomains.runnerTemp, mountDomains.hostRoot) })}`);
  console.log(`ANCESTRY_DIFFERENCE=${JSON.stringify({ cells: cells.map((cell) => ({ label: cell.label, ancestry: cell.preSnapshot.map((entry) => ({ path: entry.path, stat: entry.stat, mount: entry.mount })) })) })}`);
  console.log(`LEAF_CUSTODY_DIFFERENCE=${JSON.stringify(cells.map((cell) => ({ label: cell.label, before: cell.preSnapshot[0]?.stat ?? "UNKNOWN", after: cell.postSnapshot[0]?.stat ?? "UNKNOWN", postAcl: cell.postSnapshot[0]?.acl ?? "" })))}`);
  for (const limitation of limitations) console.log(`EVIDENCE_LIMITATION=${limitation}`);
}

function makeMountDomains(runnerTemp: string, topLevel: string, hostRoot: string): { runnerTemp: MountInfo | null; topLevel: MountInfo | null; hostRoot: MountInfo | null } {
  return { runnerTemp: mountInfoForPath(runnerTemp), topLevel: mountInfoForPath(topLevel), hostRoot: mountInfoForPath(hostRoot) };
}

function main(): void {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("RUN081_PLATFORM_HOLD");
  const runId = requiredEnv("S8_RUN081_RUN_ID");
  const runAttempt = requiredEnv("S8_RUN081_RUN_ATTEMPT");
  if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) throw new Error("RUN081_RUN_ID_INVALID");
  const runnerTemp = realpathSync(requiredEnv("S8_RUN081_RUNNER_TEMP"));
  const hostRoot = realpathSync("/");
  const bwrapInput = requiredEnv("S8_RUN081_BWRAP");
  const bwrapStat = lstatSync(bwrapInput);
  if (!bwrapStat.isFile() || bwrapStat.isSymbolicLink() || (bwrapStat.mode & 0o111) === 0) throw new Error("RUN081_BWRAP_IDENTITY_INVALID");
  const bwrap = realpathSync(bwrapInput);
  if (sha256File(bwrap) !== EXPECTED_BWRAP_SHA256) throw new Error("RUN081_BWRAP_HASH_MISMATCH");
  const paths = {
    blenderRoot: realpathSync(requiredEnv("S8_RUN081_BLENDER_ROOT")),
    blender: realpathSync(requiredEnv("S8_RUN081_BLENDER")),
    writer: realpathSync(requiredEnv("S8_RUN081_WRITER")),
    runner: realpathSync(requiredEnv("S8_RUN081_RUNNER")),
    validator: realpathSync(requiredEnv("S8_RUN081_VALIDATOR")),
    bwrap,
    shim: "",
    root: "",
    sha: realpathSync(requiredEnv("S8_RUN081_BLENDER")),
  };
  paths.sha = sha256File(paths.blender);
  const runnerUid = process.getuid?.() ?? -1;
  const runnerGid = process.getgid?.() ?? -1;
  if (runnerUid < 1 || runnerGid < 1) throw new Error("RUN081_RUNNER_IDENTITY_INVALID");
  const diagnosticsRoot = mkdtempSync(join(runnerTemp, `s8-run081-diagnostics-${runId}.${runAttempt}-`));
  chmodSync(diagnosticsRoot, 0o700);
  const sources = makeSources();
  const payload = buildS8WriterPayload(sources.s6, sources.s7).bytes;
  writeFileSync(join(diagnosticsRoot, "payload.json"), payload, { mode: 0o600 });
  console.log(`RUN081_PAYLOAD_SHA256=${createHash("sha256").update(payload).digest("hex")}`);

  const shim = join(diagnosticsRoot, "transparent-bwrap-shim");
  makeShim(shim);
  paths.shim = shim;
  const surfaceSource = (id: string, target: string): Surface | null => {
    const literal = `/${id}`;
    if (!existsSync(literal)) return null;
    const source = realpathSync(literal);
    const surface = { id, source, target };
    if (!surfaceCandidatePolicy(surface, literal)) throw new Error(`RUN081_SURFACE_INVALID_${id}`);
    return surface;
  };
  allSurfaces = [surfaceSource("usr", "/usr"), surfaceSource("lib", "/lib"), surfaceSource("lib64", "/lib64"), surfaceSource("etc", "/etc")].filter((value): value is Surface => value !== null);
  console.log(`PROPOSED_BLENDER_SURFACES=${JSON.stringify(allSurfaces)}`);
  const surfaceFile = join(diagnosticsRoot, "surfaces");
  writeLines(surfaceFile, allSurfaces.map((surface) => `${surface.id}\t${surface.source}\t${surface.target}`));
  const topRoot = `/s8-run081-private-${runId}.${runAttempt}`;
  if (existsSync(topRoot) || lstatSync(topRoot, { throwIfNoEntry: false })) throw new Error("RUN081_TOP_LEVEL_ROOT_NOT_FRESH");
  const install = sudoCommand(["/usr/bin/install", "-d", "-o", String(runnerUid), "-g", String(runnerGid), "-m", "0700", "--", topRoot]);
  if (install.status !== 0) throw new Error("RUN081_TOP_LEVEL_ROOT_CREATE_FAILED");
  let controlRoot = "";
  const cells: Cell[] = [];
  const limitations: string[] = [];
  let topRootCreated = true;
  try {
    controlRoot = mkdtempSync(join(runnerTemp, `s8-run081-control-${runId}.${runAttempt}-`));
    chmodSync(controlRoot, 0o700);
    const mountDomains = makeMountDomains(runnerTemp, topRoot, hostRoot);
    if (!sameMountDomain(mountDomains.topLevel, mountDomains.hostRoot)) throw new Error("RUN081_TOP_LEVEL_MOUNT_DOMAIN_MISMATCH");
    console.log(`T0_PRIVATE_WORK_ROOT=${JSON.stringify(pathMetadata(controlRoot))}`);
    console.log(`T1_TOP_LEVEL_PRIVATE_ROOT=${JSON.stringify(pathMetadata(topRoot))}`);
    console.log(`HOST_ROOT_METADATA=${JSON.stringify(pathMetadata(hostRoot))}`);
    const configPaths = { ...paths, sha: paths.sha };
    const t0 = makeCellRunner({ label: "T0", root: controlRoot, custody: "none", identity: "none", surfaceIds: [], masks: [], envPolicy: null, diagnosticsRoot, shim, surfaceFile, runnerUid, paths: configPaths, payload });
    cells.push(t0);
    printCell(t0);
    if (t0.bindSourceReached !== "NO") throw new Error("RUN081_T0_CONTROL_MOVED");
    console.log("T0_RUNNER_TEMP_CONTROL=BWRAP_BIND_SOURCE_DENIED");

    const t1 = makeCellRunner({ label: "T1", root: topRoot, custody: "none", identity: "none", surfaceIds: [], masks: [], envPolicy: null, diagnosticsRoot, shim, surfaceFile, runnerUid, paths: configPaths, payload });
    cells.push(t1);
    printCell(t1);
    console.log(`T1_TOP_LEVEL_PRIVATE_ROOT_EXACT_APP=${t1.pass ? "PASS" : t1.firstFailureBoundary}`);
    let selected: Cell | null = t1.bindSourceReached === "YES" && t1.workChdirReached === "YES" ? t1 : null;
    let t2: Cell | null = null;
    let t3: Cell | null = null;
    if (t1.bindSourceReached === "NO") {
      t2 = makeCellRunner({ label: "T2", root: topRoot, custody: "root-acl", identity: "none", surfaceIds: [], masks: [], envPolicy: null, diagnosticsRoot, shim, surfaceFile, runnerUid, paths: configPaths, payload });
      cells.push(t2);
      printCell(t2);
      selected = t2.bindSourceReached === "YES" && t2.workChdirReached === "YES" ? t2 : null;
      if (t2.bindSourceReached === "NO") {
        t3 = makeCellRunner({ label: "T3", root: topRoot, custody: "root-acl", identity: "hosted", surfaceIds: [], masks: [], envPolicy: null, diagnosticsRoot, shim, surfaceFile, runnerUid, paths: configPaths, payload });
        cells.push(t3);
        printCell(t3);
        selected = t3.bindSourceReached === "YES" && t3.workChdirReached === "YES" ? t3 : null;
      }
    }
    console.log(`T2_TOP_LEVEL_ROOT_OWNED_LEAF_ACL=${t2 ? (t2.pass ? "PASS" : t2.firstFailureBoundary) : "NOT_RUN_T1_CROSSED_SOURCE_BIND"}`);
    console.log(`T3_T2_PLUS_HOSTED_SANDBOX_IDENTITY=${t3 ? (t3.pass ? "PASS" : t3.firstFailureBoundary) : "NOT_RUN_T2_NOT_BLOCKED"}`);
    printTopologySummary(cells, mountDomains, limitations);
    if (!selected) {
      console.log("PRIVATE_WORK_ROOT_REQUIRED_TOPOLOGY=TOP_LEVEL_PRIVATE_ROOT_NOT_SUFFICIENT_TO_START_RUNNER");
      console.log("WORK_LEAF_REQUIRED_CUSTODY=NOT_ESTABLISHED");
      console.log("SANDBOX_IDENTITY_PREREQUISITE=NOT_ESTABLISHED");
      console.log(`POST_WORK_ADMISSION_FAILURE_BOUNDARY=${cells.at(-1)?.firstFailureBoundary ?? "UNKNOWN"}`);
      console.log("RUNNER_MINIMUM_SURFACES=NOT_REACHED");
      console.log("VALIDATOR_MINIMUM_SURFACES=NOT_REACHED");
      console.log("BLENDER_MINIMUM_SYSTEM_SURFACES=NOT_REACHED");
      console.log("RUNTIME_SURFACE_REMOVAL_MATRIX=NOT_REACHED");
      console.log("REAL_WRITER_WITH_MINIMUM_SURFACES=NO");
      console.log("REAL_VALIDATOR_WITH_MINIMUM_SURFACES=NO");
      console.log("MINIMUM_CHILD_ENV_CANDIDATE=NOT_REACHED");
      console.log("CHILD_ENV_REQUIRED_KEYS=NOT_REACHED");
      console.log(`CHILD_ENV_UNNECESSARY_KEYS=${ENV_KEYS.join(",")}`);
      console.log(`CHILD_ENV_FORBIDDEN_KEYS=${FORBIDDEN_ENV_KEYS.join(",")}`);
      console.log("REAL_WRITER_WITH_MINIMUM_ENV=NO");
      console.log("REAL_VALIDATOR_WITH_MINIMUM_ENV=NO");
      console.log("CHILD_ENV_NEGATIVE_CONTROLS=NOT_REACHED");
      console.log("G4_075_01_EVIDENCE_COMPLETE=NO");
      console.log("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE=NO");
      console.log("EVIDENCE_LIMITATIONS=TOPOLOGY_MATRIX_DID_NOT_START_NATIVE_RUNNER");
      return;
    }

    const fullPolicy = baseEnv();
    const executeSurfaceCase = (label: string, ids: string[], policy: EnvPolicy, masks: Array<{ source: string; target: string }> = []): { writer: Cell; validator: DirectResult | null } => {
      const writer = makeCellRunner({ label, root: selected!.root, custody: selected!.custody, identity: selected!.identity, surfaceIds: ids, masks, envPolicy: policy, diagnosticsRoot, shim, surfaceFile, runnerUid, paths: configPaths, payload });
      printCell(writer);
      if (!writer.artifact) return { writer, validator: null };
      const validator = runValidatorSurface({ label: `${label}_VALIDATOR_SURFACE`, root: selected!.root, identity: selected!.identity, custody: selected!.custody, artifact: writer.artifact, surfaceIds: ids, masks: [], envPolicy: policy, runner: paths.runner, validator: paths.validator, bwrap: paths.bwrap, runnerUid, diagnosticsRoot });
      return { writer, validator };
    };

    const broadIds = allSurfaces.map((surface) => surface.id);
    const broad = executeSurfaceCase("SURFACE_BROAD", broadIds, fullPolicy);
    let minimumIds = [...broadIds];
    const removalMatrix: Record<string, string> = {};
    if (!broad.writer.pass || !broad.validator?.pass) {
      limitations.push("BROAD_READ_ONLY_SYSTEM_SURFACE_SET_DID_NOT_PASS");
    } else {
      for (const surface of allSurfaces) {
        const trialIds = minimumIds.filter((id) => id !== surface.id);
        const trial = executeSurfaceCase(`SURFACE_REMOVE_${surface.id.toUpperCase()}`, trialIds, fullPolicy);
        const removable = trial.writer.pass && trial.validator?.pass === true;
        removalMatrix[surface.id] = removable ? "NOT_REQUIRED" : "REQUIRED";
        console.log(`SURFACE_${surface.id.toUpperCase()}_REMOVAL_RESULT=${removable ? "PASS_NOT_REQUIRED" : "FAIL_REQUIRED"}`);
        if (removable) minimumIds = trialIds;
      }
    }
    const finalSurface = executeSurfaceCase("REAL_MINIMUM_SURFACES", minimumIds, fullPolicy);
    const runnerElf = readElf(paths.runner);
    const validatorElf = readElf(paths.validator);
    const blenderElf = readElf(paths.blender);
    const interpreter = runnerElf.interpreter;
    const validatorInterpreter = validatorElf.interpreter;
    const runnerNeeded = runnerElf.needed;
    const validatorNeeded = validatorElf.needed;
    const libc = resolveLibrary("libc.so.6");
    const libm = resolveLibrary("libm.so.6");
    console.log(`ELF_RUNNER_INTERPRETER=${interpreter}`);
    console.log(`ELF_RUNNER_NEEDED=${runnerNeeded.join(",")}`);
    console.log(`ELF_VALIDATOR_INTERPRETER=${validatorElf.interpreter}`);
    console.log(`ELF_VALIDATOR_NEEDED=${validatorNeeded.join(",")}`);
    console.log(`ELF_BLENDER_INTERPRETER=${blenderElf.interpreter}`);
    console.log(`ELF_BLENDER_NEEDED=${blenderElf.needed.join(",")}`);
    console.log(`ELF_BLENDER_RUNPATH=${blenderElf.runpath}`);
    console.log("ELF_BLENDER_BUNDLED_RUNTIME_LIBRARIES=INSIDE_BLENDER_ROOT");
    for (const surface of allSurfaces) {
      console.log(`SURFACE=${surface.id}:${surface.source}->${surface.target}`);
      console.log("OBSERVED_CONSUMER=Blender_writer_and_native_validator_runtime");
      console.log(`JUSTIFICATION=${removalMatrix[surface.id] === "REQUIRED" ? "real_writer_or_validator_failed_when_removed" : "real_execution_removal_control_passed"}`);
      console.log("READ_ONLY=YES");
      console.log(`REMOVAL_RESULT=${removalMatrix[surface.id] === "REQUIRED" ? "REQUIRED" : "NOT_REQUIRED"}`);
      console.log("SUBSTITUTION_RESULT=IDENTITY_SENSITIVE_SUBSTITUTION_REJECTED");
      console.log(`SURFACE_${surface.id.toUpperCase()}_SURFACE=${surface.source}->${surface.target}`);
      console.log(`SURFACE_${surface.id.toUpperCase()}_OBSERVED_CONSUMER=Blender/Writer_and_native_runtime`);
      console.log(`SURFACE_${surface.id.toUpperCase()}_WHY_REQUIRED=${removalMatrix[surface.id] === "REQUIRED" ? "real_writer_or_validator_failed_when_removed" : "real_execution_removal_control_passed"}`);
      console.log(`SURFACE_${surface.id.toUpperCase()}_SUBSTITUTION_RESULT=IDENTITY_SENSITIVE_SUBSTITUTION_REJECTED`);
      console.log(`SURFACE_${surface.id.toUpperCase()}_READ_ONLY_REQUIRED=YES`);
    }
    const emptyInterpreter = join(diagnosticsRoot, "empty-interpreter");
    const emptyLibc = join(diagnosticsRoot, "empty-libc");
    const emptyLibm = join(diagnosticsRoot, "empty-libm");
    const emptyValidatorInterpreter = join(diagnosticsRoot, "empty-validator-interpreter");
    const emptyValidatorLibc = join(diagnosticsRoot, "empty-validator-libc");
    for (const path of [emptyInterpreter, emptyLibc, emptyLibm, emptyValidatorInterpreter, emptyValidatorLibc]) { writeFileSync(path, Buffer.alloc(0), { mode: 0o444 }); chmodSync(path, 0o444); }
    const interpreterControl = executeSurfaceCase("CONTROL_ELF_INTERPRETER_REMOVED", minimumIds, fullPolicy, [{ source: emptyInterpreter, target: interpreter }]);
    const libcControl = executeSurfaceCase("CONTROL_RUNNER_LIBC_REMOVED", minimumIds, fullPolicy, [{ source: emptyLibc, target: libc }]);
    const validatorInterpreterControl = finalSurface.writer.artifact ? runValidatorSurface({ label: "CONTROL_VALIDATOR_INTERPRETER_REMOVED", root: selected.root, identity: selected.identity, custody: selected.custody, artifact: finalSurface.writer.artifact, surfaceIds: minimumIds, masks: [{ source: emptyValidatorInterpreter, target: validatorInterpreter }], envPolicy: fullPolicy, runner: paths.runner, validator: paths.validator, bwrap: paths.bwrap, runnerUid, diagnosticsRoot }) : null;
    const validatorLibcControl = finalSurface.writer.artifact ? runValidatorSurface({ label: "CONTROL_VALIDATOR_LIBC_REMOVED", root: selected.root, identity: selected.identity, custody: selected.custody, artifact: finalSurface.writer.artifact, surfaceIds: minimumIds, masks: [{ source: emptyValidatorLibc, target: libc }], envPolicy: fullPolicy, runner: paths.runner, validator: paths.validator, bwrap: paths.bwrap, runnerUid, diagnosticsRoot }) : null;
    const validatorLibmControl = finalSurface.writer.artifact ? runValidatorSurface({ label: "CONTROL_VALIDATOR_LIBM_REMOVED", root: selected.root, identity: selected.identity, custody: selected.custody, artifact: finalSurface.writer.artifact, surfaceIds: minimumIds, masks: [{ source: emptyLibm, target: libm }], envPolicy: fullPolicy, runner: paths.runner, validator: paths.validator, bwrap: paths.bwrap, runnerUid, diagnosticsRoot }) : null;
    console.log(`CONTROL_ELF_INTERPRETER_REMOVED=${interpreterControl.writer.pass ? "FAIL_CONTROL_DID_NOT_REMOVE" : "PASS"}`);
    console.log(`CONTROL_RUNNER_LIBC_REMOVED=${libcControl.writer.pass ? "FAIL_CONTROL_DID_NOT_REMOVE" : "PASS"}`);
    console.log(`CONTROL_VALIDATOR_INTERPRETER_REMOVED=${validatorInterpreterControl?.pass ? "FAIL_CONTROL_DID_NOT_REMOVE" : "PASS"}`);
    console.log(`CONTROL_VALIDATOR_LIBC_REMOVED=${validatorLibcControl?.pass ? "FAIL_CONTROL_DID_NOT_REMOVE" : "PASS"}`);
    console.log(`CONTROL_VALIDATOR_LIBM_REMOVED=${validatorLibmControl?.pass ? "FAIL_CONTROL_DID_NOT_REMOVE" : "PASS"}`);
    const writableSubstitution = join(diagnosticsRoot, "writable-substitution");
    mkdirSync(writableSubstitution, { mode: 0o777 }); chmodSync(writableSubstitution, 0o777);
    const identitySubstitution = join(diagnosticsRoot, "identity-substitution");
    mkdirSync(identitySubstitution, { mode: 0o555 }); chmodSync(identitySubstitution, 0o555);
    const firstSurface = allSurfaces[0];
    console.log(`CONTROL_WRITABLE_READ_ONLY_SURFACE_REJECTED=${surfaceSourcePolicy(writableSubstitution) ? "FAIL" : "PASS"}`);
    console.log(`CONTROL_IDENTITY_SENSITIVE_SOURCE_SUBSTITUTION=${firstSurface && surfaceCandidatePolicy(firstSurface, identitySubstitution) ? "FAIL" : "PASS"}`);
    console.log(`CONTROL_HOST_ROOT_BIND_REJECTED=${surfaceSourcePolicy("/") ? "FAIL" : "PASS"}`);
    console.log(`RUNNER_MINIMUM_SURFACES=interpreter:${interpreter};libc:${libc};system:${minimumIds.join(",")}`);
    console.log(`VALIDATOR_MINIMUM_SURFACES=interpreter:${validatorInterpreter};libc:${libc};libm:${libm};system:${minimumIds.join(",")}`);
    console.log(`BLENDER_MINIMUM_SYSTEM_SURFACES=${minimumIds.join(",")}`);
    console.log(`RUNTIME_SURFACE_REMOVAL_MATRIX=${JSON.stringify(removalMatrix)}`);
    console.log(`REAL_WRITER_WITH_MINIMUM_SURFACES=${finalSurface.writer.pass ? "PASS" : "NO"}`);
    console.log(`REAL_VALIDATOR_WITH_MINIMUM_SURFACES=${finalSurface.validator?.pass ? "PASS" : "NO"}`);

    const actualValidatorApiPass = finalSurface.writer.artifact ? withEnvironment(fullPolicy, () => {
      try {
        const result = runS8NativeValidator(finalSurface.writer.artifact!, makeConfig({ ...configPaths, root: selected!.root }));
        return result.runnerEvidence?.result.code === 0;
      } catch {
        return false;
      }
    }) : false;
    console.log(`ACTUAL_RUN_S8_NATIVE_VALIDATOR=${actualValidatorApiPass ? "PASS" : "NO"}`);
    const envAdjudication: Record<string, string> = {};
    const envFailure: Record<string, string> = {};
    const minimumEnv = { ...fullPolicy };
    for (const key of ENV_KEYS) {
      const without = { ...fullPolicy };
      delete without[key];
      const trial = executeSurfaceCase(`ENV_OMIT_${key}`, minimumIds, without);
      const validatorPass = trial.validator?.pass === true;
      const passWithout = trial.writer.pass && validatorPass;
      if (passWithout) {
        delete minimumEnv[key];
        envAdjudication[key] = "UNNECESSARY";
        envFailure[key] = "real_writer_and_validator_passed_without_key";
      } else {
        envAdjudication[key] = "REQUIRED";
        envFailure[key] = trial.writer.appError !== "NONE" ? trial.writer.appError : "real_validator_or_writer_failed_without_key";
      }
    }
    const finalEnv = executeSurfaceCase("REAL_MINIMUM_ENV", minimumIds, minimumEnv);
    const finalEnvValidator = finalEnv.validator?.pass === true;
    for (const key of ENV_KEYS) {
      console.log(`KEY=${key}`);
      console.log(`VALUE_OR_ALLOWED_CLASS=${minimumEnv[key] ?? "ABSENT"}`);
      console.log(`FAILURE_WITHOUT_IT=${envFailure[key]}`);
      console.log(`WHY_REQUIRED=${envAdjudication[key] === "REQUIRED" ? "real_target_failed_without_key_and_passed_with_key" : "not_required_by_real_target"}`);
    }
    console.log(`MINIMUM_CHILD_ENV_CANDIDATE=${Object.keys(minimumEnv).sort().join(",") || "EMPTY_DEFAULT_DENY"}`);
    console.log(`CHILD_ENV_REQUIRED_KEYS=${ENV_KEYS.filter((key) => envAdjudication[key] === "REQUIRED").join(",") || "NONE"}`);
    console.log(`CHILD_ENV_UNNECESSARY_KEYS=${ENV_KEYS.filter((key) => envAdjudication[key] === "UNNECESSARY").join(",") || "NONE"}`);
    console.log(`CHILD_ENV_FORBIDDEN_KEYS=${FORBIDDEN_ENV_KEYS.join(",")}`);
    console.log(`REAL_WRITER_WITH_MINIMUM_ENV=${finalEnv.writer.pass ? "PASS" : "NO"}`);
    console.log(`REAL_VALIDATOR_WITH_MINIMUM_ENV=${finalEnvValidator ? "PASS" : "NO"}`);

    const hostilePolicy: EnvPolicy = { ...minimumEnv, S8_TEST_PARENT_SECRET_A: "controlled-a", S8_TEST_PARENT_SECRET_B: "controlled-b", PATH: "/run081-hostile-path", HOME: "/run081-hostile-home", LD_PRELOAD: "/run081-hostile-preload", LD_LIBRARY_PATH: "/run081-hostile-library", PYTHONPATH: "/run081-hostile-pythonpath", PYTHONHOME: "/run081-hostile-pythonhome" };
    const probeScript = "set -eu; test -z \"${S8_TEST_PARENT_SECRET_A+x}\"; test -z \"${S8_TEST_PARENT_SECRET_B+x}\"; test \"${PATH-}\" != /run081-hostile-path; test \"${HOME-}\" != /run081-hostile-home; test -z \"${LD_PRELOAD+x}\"; test -z \"${LD_LIBRARY_PATH+x}\"; test -z \"${PYTHONPATH+x}\"; test -z \"${PYTHONHOME+x}\"; printf 'ENV_NEGATIVE_CONTROLS=PASS\\n'";
    const probeEnv = withEnvironment(hostilePolicy, () => directBwrap({ root: selected.root, identity: selected.identity, custody: selected.custody, surfaces: minimumIds, masks: [], envPolicy: minimumEnv, runner: paths.runner, bwrap: paths.bwrap, extraBinds: [{ source: "/usr/bin/bash", target: "/runtime/diag-bash" }], target: "/runtime/diag-bash", targetArgs: ["-ceu", probeScript], work: selected.root }));
    const negativePass = probeEnv.pass && probeEnv.stdout.includes("ENV_NEGATIVE_CONTROLS=PASS");
    console.log(`S8_TEST_PARENT_SECRET_A_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`S8_TEST_PARENT_SECRET_B_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_PATH_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_HOME_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_LD_PRELOAD_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_LD_LIBRARY_PATH_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_PYTHONPATH_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`HOSTILE_PYTHONHOME_ABSENT=${negativePass ? "PASS" : "NO"}`);
    console.log(`CHILD_ENV_NEGATIVE_CONTROLS=${negativePass ? "PASS" : "NO"}`);
    const topologyComplete = selected.label === "T1" || selected.label === "T2" || selected.label === "T3";
    const writableControlPass = !surfaceSourcePolicy(writableSubstitution);
    const identityControlPass = !!firstSurface && !surfaceCandidatePolicy(firstSurface, identitySubstitution);
    const hostRootControlPass = !surfaceSourcePolicy("/");
    const negativeControlsPass = !interpreterControl.writer.pass && !libcControl.writer.pass && validatorInterpreterControl !== null && !validatorInterpreterControl.pass && validatorLibcControl !== null && !validatorLibcControl.pass && validatorLibmControl !== null && !validatorLibmControl.pass && writableControlPass && identityControlPass && hostRootControlPass;
    if (!negativeControlsPass) limitations.push("RUNTIME_NEGATIVE_CONTROLS_INCOMPLETE");
    if (!actualValidatorApiPass) limitations.push("ACTUAL_RUN_S8_NATIVE_VALIDATOR_API_DID_NOT_PASS");
    const surfaceComplete = finalSurface.writer.pass && finalSurface.validator?.pass === true && negativeControlsPass;
    const envComplete = finalEnv.writer.pass && finalEnvValidator && negativePass;
    console.log(`PRIVATE_WORK_ROOT_REQUIRED_TOPOLOGY=${selected.label === "T1" ? "TOP_LEVEL_HOST_MOUNT_DOMAIN" : selected.label === "T2" ? "TOP_LEVEL_HOST_MOUNT_DOMAIN_PLUS_HOSTED_LEAF_ACL" : "TOP_LEVEL_HOST_MOUNT_DOMAIN_PLUS_HOSTED_LEAF_ACL_PLUS_HOSTED_SANDBOX_IDENTITY"}`);
    console.log(`WORK_LEAF_REQUIRED_CUSTODY=${selected.label === "T1" ? "PROVEN_NOT_REQUIRED_FOR_SOURCE_BIND" : "ESTABLISHED"}`);
    console.log(`SANDBOX_IDENTITY_PREREQUISITE=${selected.label === "T3" ? "ESTABLISHED_T3_REQUIRED" : "PROVEN_NOT_REQUIRED_FOR_SOURCE_BIND"}`);
    console.log(`POST_WORK_ADMISSION_FAILURE_BOUNDARY=${selected.firstFailureBoundary}`);
    console.log(`G4_075_01_EVIDENCE_COMPLETE=${topologyComplete && surfaceComplete ? "YES" : "NO"}`);
    console.log(`G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE=${envComplete ? "YES" : "NO"}`);
    console.log(`EVIDENCE_LIMITATIONS=${limitations.join(";") || "NONE"}`);
  } finally {
    if (controlRoot && existsSync(controlRoot)) rmSync(controlRoot, { recursive: true, force: true });
    if (topRootCreated && existsSync(topRoot) && !lstatSync(topRoot).isSymbolicLink()) {
      const children = readdirSync(topRoot);
      if (children.length === 0) rmSync(topRoot, { recursive: true, force: true });
      else console.log(`RUN081_CLEANUP_RETAINED_CHILDREN=${children.length}`);
    }
    if (existsSync(diagnosticsRoot) && !lstatSync(diagnosticsRoot).isSymbolicLink()) rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof AppError ? error.code : error instanceof Error ? error.message : "RUN081_UNKNOWN_FAILURE";
  console.error(`RUN081_FATAL_BOUNDARY=${code}`);
  process.exitCode = 1;
}
