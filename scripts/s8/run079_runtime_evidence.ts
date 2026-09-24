import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../../src/lib/types";
import { AppError } from "../../src/lib/types";
import { buildS8WriterPayload } from "../../src/lib/s8-fbx-payload";
import { runS8BlenderWriter, runS8NativeValidator, type S8WorkerConfig } from "../../src/lib/s8-fbx-worker";

type WorkMeta = {
  path: string;
  uidGid: string;
  mode: string;
  deviceInode: string;
  accessAcl: string;
  defaultAcl: string;
  inputFile: string;
};

type Receipt = {
  result?: {
    code?: number;
    name?: string;
    terminationClass?: string;
    targetExit?: number | null;
    targetSignal?: number | null;
    setupStage?: string | null;
    evidenceCode?: string | null;
  };
};

type CaseResult = {
  name: string;
  result: string;
  firstFailure: string;
  workChdir: "YES" | "NO" | "UNKNOWN" | "NOT_REACHED";
  runnerStarted: "YES" | "NO";
  targetStarted: "YES" | "NO";
  runnerBoundary: string;
  metaBefore?: WorkMeta;
  metaAfter?: WorkMeta;
  raw: string;
  logDir: string;
  writerPass: boolean;
  validatorPass: boolean | null;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("RUN079_REQUIRED_ENV_MISSING:" + name);
  return value;
}

function sourceFixture(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const hash = "a".repeat(64);
  const hashB = "b".repeat(64);
  const id = "11111111-1111-4111-8111-111111111111";
  const objectBase = {
    parentObjectId: null,
    objectType: "box" as const,
    role: "furniture" as const,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 }, geometryState: "exact" as const, localAnchor: "center" as const },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm: { xMm: 1.125, yMm: 2.25, zMm: -3.5 }, rotationMd: { xMd: 89999, yMd: -45001, zMd: 179999 } },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 },
    zoneIds: [],
    requirementIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "run-079", sourceFingerprint: hashB, acceptedByUser: true, note: null },
    unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId: id,
    acceptedRevisionId: "22222222-2222-4222-8222-222222222222",
    acceptedRevisionHash: hash,
    sourceS5Fingerprint: hashB,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [
      { ...objectBase, objectId: "run079-object-a", identityKey: "run079-identity-a", materialIds: ["run079-material-b", "run079-material-a"] },
      { ...objectBase, objectId: "run079-object-b", identityKey: "run079-identity-b", materialIds: [] },
    ],
    hierarchy: [{ objectId: "run079-object-a", parentObjectId: null }, { objectId: "run079-object-b", parentObjectId: null }],
    zones: [],
    requirements: [],
    assumptions: [],
    unknowns: [],
    materials: [
      { materialId: "run079-material-a", label: "Neutral", finishKind: "solid_color", colorHex: "#336699", source: "user_confirmed_design_decision", sourceAssetId: null, sourceAssetSha256: null, notes: null, provenance: { kind: "user_confirmed_design_decision", sourceRef: "run-079", sourceFingerprint: hash, acceptedByUser: true, note: null } },
      { materialId: "run079-material-b", label: "Wood", finishKind: "wood_like", colorHex: null, source: "s5_visual_intent", sourceAssetId: null, sourceAssetSha256: null, notes: null, provenance: { kind: "bounded_design_inference", sourceRef: "run-079", sourceFingerprint: hash, acceptedByUser: true, note: null } },
    ],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1",
    projectId: id,
    sourceRevisionId: s6.acceptedRevisionId,
    sourceRevisionHash: hash,
    sourceS5Fingerprint: hashB,
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
  return { s6, s7 };
}

function metadata(path: string): WorkMeta | undefined {
  if (!path) return undefined;
  const file = join(path, "metadata.txt");
  try {
    const value = readFileSync(file, "utf8");
    const field = (name: string) => value.split(/\r?\n/u).find((line) => line.startsWith(name + "="))?.slice(name.length + 1) ?? "";
    return {
      path: field("WORK_PATH"),
      uidGid: field("OWNER_GROUP"),
      mode: field("MODE") ? "0" + field("MODE") : "",
      deviceInode: field("DEVICE_INODE"),
      accessAcl: field("ACCESS_ACL"),
      defaultAcl: field("DEFAULT_ACL"),
      inputFile: field("INPUT_FILE"),
    };
  } catch {
    return undefined;
  }
}

function parseReceipt(path: string): Receipt | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const line = text.split(/\r?\n/u).find((entry) => entry.startsWith("S8_RUNNER_RECEIPT:"));
    if (!line) return undefined;
    return JSON.parse(line.slice("S8_RUNNER_RECEIPT:".length)) as Receipt;
  } catch {
    return undefined;
  }
}

function firstLine(path: string): string {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u).find((line) => line.length > 0)?.slice(0, 500) ?? "";
  } catch {
    return "";
  }
}

function writeShim(path: string): void {
  const text = String.raw`#!/usr/bin/bash
set -Eeuo pipefail
log_dir="@@{RUN079_LOG_DIR:?}"
args=("$@")
separator=-1
work_path=""
for ((i=0; i<@@{#args[@]}; i++)); do
  if [[ "@@{args[$i]}" == "--" ]]; then separator=$i; break; fi
  if [[ "@@{args[$i]}" == "--bind" && "@@{args[$((i + 2))]:-}" == "/work" ]]; then work_path="@@{args[$((i + 1))]}"; fi
done
(( separator > 0 )) || { printf 'RUN079_SHIM_ERROR=APPLICATION_SEPARATOR_MISSING\n' > "$log_dir/shim-error.txt"; exit 70; }
{
  printf 'WORK_PATH=%s\n' "$work_path"
  if [[ -n "$work_path" ]]; then
    /usr/bin/stat -c 'OWNER_GROUP=%u:%g' -- "$work_path"
    /usr/bin/stat -c 'MODE=%a' -- "$work_path"
    /usr/bin/stat -c 'DEVICE_INODE=%d:%i' -- "$work_path"
    acl="$(/usr/bin/getfacl --numeric --omit-header -- "$work_path" 2>/dev/null || true)"
    access="$(printf '%s\n' "$acl" | /usr/bin/sed '/^default:/d' | /usr/bin/paste -sd, -)"
    defaults="$(printf '%s\n' "$acl" | /usr/bin/sed -n 's/^default://p' | /usr/bin/paste -sd, -)"
    printf 'ACCESS_ACL=%s\nDEFAULT_ACL=%s\n' "$access" "$defaults"
    if [[ -f "$work_path/input.json" ]]; then
      /usr/bin/stat -c 'INPUT_FILE=%u:%g:%a:%d:%i' -- "$work_path/input.json"
    else
      printf 'INPUT_FILE=ABSENT\n'
    fi
  else
    printf 'OWNER_GROUP=UNKNOWN\nMODE=UNKNOWN\nDEVICE_INODE=UNKNOWN\nACCESS_ACL=UNKNOWN\nDEFAULT_ACL=UNKNOWN\nINPUT_FILE=UNKNOWN\n'
  fi
} > "$log_dir/metadata.txt"
printf '%s\0' "@@{args[@]}" | /usr/bin/sha256sum | /usr/bin/awk '{print $1}' > "$log_dir/application-argv.sha256"
for ((i=0; i<@@{#args[@]}; i++)); do printf 'arg[%03d]=%q\n' "$i" "@@{args[$i]}"; done > "$log_dir/application-argv.txt"
if [[ "@@{RUN079_ACCESS_ACL:-0}" == 1 ]]; then
  [[ -n "$work_path" ]] || { printf 'RUN079_ACL_ERROR=WORK_BIND_MISSING\n' > "$log_dir/acl-error.txt"; exit 71; }
  acl_subject_uid="$(/usr/bin/id -u)"
  [[ "$acl_subject_uid" =~ ^[1-9][0-9]*$ && "$acl_subject_uid" != "65534" ]] || { printf 'RUN079_ACL_ERROR=INVALID_RUNNER_UID\n' > "$log_dir/acl-error.txt"; exit 74; }
  printf '%s\n' "$acl_subject_uid" > "$log_dir/acl-subject.txt"
  /usr/bin/setfacl --no-mask --set "u::rwx,u:$acl_subject_uid:rwx,g::---,m::rwx,o::---" -- "$work_path"
  /usr/bin/setfacl --no-mask --default --set "u::rwx,u:$acl_subject_uid:rwx,g::---,m::rwx,o::---" -- "$work_path"
  /usr/bin/getfacl --numeric --absolute-names -- "$work_path" > "$log_dir/work-acl-post.txt"
  {
    /usr/bin/stat -c 'OWNER_GROUP=%u:%g' -- "$work_path"
    /usr/bin/stat -c 'MODE=%a' -- "$work_path"
    /usr/bin/stat -c 'DEVICE_INODE=%d:%i' -- "$work_path"
  } > "$log_dir/work-stat-post.txt"
fi
effective=("@@{args[@]}")
if [[ "@@{RUN079_IDENTITY:-0}" == 1 ]]; then
  effective=("@@{args[@]:0:separator}" --unshare-pid --unshare-ipc --unshare-uts --disable-userns --assert-userns-disabled --uid 65534 --gid 65534 --cap-drop ALL "@@{args[@]:separator}")
fi
if [[ "@@{RUN079_CLEAR_ENV:-0}" == 1 ]]; then
  sep=-1
  for ((i=0; i<@@{#effective[@]}; i++)); do if [[ "@@{effective[$i]}" == "--" ]]; then sep=$i; break; fi; done
  (( sep > 0 )) || { printf 'RUN079_SHIM_ERROR=EFFECTIVE_SEPARATOR_MISSING\n' > "$log_dir/shim-error.txt"; exit 72; }
  env_options=(--clearenv)
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    case "$key" in LANG|LC_ALL|HOME|PATH|TMPDIR|TZ|NODE_ENV|LD_DEBUG) ;;
      *) printf 'RUN079_SHIM_ERROR=ENV_KEY_NOT_ALLOWLISTED\n' > "$log_dir/shim-error.txt"; exit 73 ;;
    esac
    env_options+=(--setenv "$key" "$value")
  done <<< "@@{RUN079_SETENV_PAIRS:-}"
  effective=("@@{effective[@]:0:sep}" "@@{env_options[@]}" "@@{effective[@]:sep}")
fi
{
  printf '%s\0' "@@{effective[@]}" | /usr/bin/sha256sum | /usr/bin/awk '{print "EFFECTIVE_ARGV_SHA256=" $1}'
  for ((i=0; i<@@{#effective[@]}; i++)); do printf 'arg[%03d]=%q\n' "$i" "@@{effective[$i]}"; done
} > "$log_dir/effective-argv.txt"
set +e
/usr/bin/sudo -n /usr/bin/bwrap "@@{effective[@]}" > "$log_dir/stdout.txt" 2> "$log_dir/stderr.txt"
status=$?
set -e
/usr/bin/cat -- "$log_dir/stdout.txt"
/usr/bin/cat -- "$log_dir/stderr.txt" >&2
exit "$status"
`;
  const file = path;
  const shimText = text.replaceAll("@@{", "${");
  writeFileSync(file, shimText, { mode: 0o700, flag: "wx" });
  chmodSync(file, 0o700);
}

function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code).replace(/[^A-Z0-9_]/gu, "_").slice(0, 120);
  }
  return error instanceof Error ? error.name : "UNCLASSIFIED_ERROR";
}

function classify(error: string, receipt: Receipt | undefined, stderr: string): Pick<CaseResult, "result" | "workChdir" | "runnerStarted" | "targetStarted" | "runnerBoundary"> {
  const result = receipt?.result;
  const runnerStarted = receipt ? "YES" : "NO";
  const targetStarted = result && (typeof result.targetExit === "number" || typeof result.targetSignal === "number") ? "YES" : "NO";
  if (/Can't find source path .*: Permission denied/u.test(stderr)) {
    return { result: "BWRAP_BIND_SOURCE_DENIED", workChdir: "NOT_REACHED", runnerStarted, targetStarted, runnerBoundary: "BWRAP_BIND_SOURCE" };
  }
  if (/Can't chdir to \/work/u.test(stderr)) {
    return { result: "WORK_CHDIR_DENIED", workChdir: "NO", runnerStarted, targetStarted, runnerBoundary: "BWRAP_CHDIR" };
  }
  if (receipt && result) {
    if (result.code === 0 && result.targetExit === 0) return { result: "TARGET_EXIT_ZERO", workChdir: "YES", runnerStarted, targetStarted: "YES", runnerBoundary: "TARGET_EXIT_ZERO" };
    if (result.setupStage) return { result: "RUNNER_SETUP_" + result.setupStage, workChdir: "YES", runnerStarted, targetStarted, runnerBoundary: "RUNNER_SETUP" };
    if (result.code === 73) return { result: "TARGET_EXEC_FAILED", workChdir: "YES", runnerStarted, targetStarted: "NO", runnerBoundary: "TARGET_EXEC" };
    if (typeof result.targetExit === "number") return { result: "TARGET_EXIT_" + result.targetExit, workChdir: "YES", runnerStarted, targetStarted: "YES", runnerBoundary: "TARGET_EXIT" };
    return { result: result.name ?? "RUNNER_RESULT_UNCLASSIFIED", workChdir: "YES", runnerStarted, targetStarted, runnerBoundary: result.terminationClass ?? "RUNNER_RESULT" };
  }
  return { result: error || "NO_RUNNER_RECEIPT", workChdir: "UNKNOWN", runnerStarted, targetStarted, runnerBoundary: stderr || "BWRAP_NO_DIAGNOSTIC" };
}

function printMeta(prefix: string, value: WorkMeta | undefined): void {
  if (!value) {
    console.log(prefix + "_WORK_METADATA=UNAVAILABLE");
    return;
  }
  console.log(prefix + "_WORK_PATH=" + value.path);
  console.log(prefix + "_WORK_UID_GID=" + value.uidGid);
  console.log(prefix + "_WORK_MODE=" + value.mode);
  console.log(prefix + "_WORK_ACCESS_ACL=" + value.accessAcl);
  console.log(prefix + "_WORK_DEFAULT_ACL=" + value.defaultAcl);
  console.log(prefix + "_WORK_DEVICE_INODE=" + value.deviceInode);
  console.log(prefix + "_WORK_INPUT_FILE=" + value.inputFile);
}

type WorkerConfigBase = Pick<S8WorkerConfig, "blenderRuntimeRoot" | "blenderExecutable" | "writerScript" | "processRunnerExecutable" | "nativeValidatorExecutable" | "blenderExecutableSha256">;

type WorkerCaseSettings = {
  name: string;
  acl: boolean;
  sandboxIdentity: boolean;
  clearEnv: boolean;
  setenvPairs: string;
};

function runAdditionalCase(item: WorkerCaseSettings, builtBytes: Buffer, configBase: WorkerConfigBase, root: string): CaseResult {
  const caseRoot = join(root, item.name);
  const logDir = join(caseRoot, "logs");
  const workRoot = join(caseRoot, "private-work");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const shim = join(caseRoot, "bwrap-shim");
  writeShim(shim);
  const config: S8WorkerConfig = { ...configBase, privateWorkRoot: workRoot, sandboxExecutable: shim };
  const restore: Array<() => void> = [];
  const set = (key: string, value: string) => {
    const prior = process.env[key];
    process.env[key] = value;
    restore.push(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  };
  set("RUN079_MODE", item.name);
  set("RUN079_LOG_DIR", logDir);
  set("RUN079_ACCESS_ACL", item.acl ? "1" : "0");
  set("RUN079_IDENTITY", item.sandboxIdentity ? "1" : "0");
  set("RUN079_CLEAR_ENV", item.clearEnv ? "1" : "0");
  set("RUN079_SETENV_PAIRS", item.setenvPairs);
  let writerPass = false;
  let validatorPass: boolean | null = null;
  let code = "";
  try {
    const writer = runS8BlenderWriter(builtBytes, config);
    writerPass = true;
    const validated = runS8NativeValidator(writer.artifact, config);
    validatorPass = validated.readback.schemaVersion === "s8-ufbx-readback-v1";
    if (!validatorPass) code = "VALIDATOR_READBACK_SCHEMA_INVALID";
  } catch (error) {
    code = errorCode(error);
  } finally {
    for (const restoreEnv of restore.reverse()) restoreEnv();
  }
  const receipt = parseReceipt(join(logDir, "stdout.txt"));
  const stderr = firstLine(join(logDir, "stderr.txt"));
  const invocation = classify(code, receipt, stderr);
  const shimMetadata = metadata(logDir);
  return {
    name: item.name,
    ...invocation,
    firstFailure: stderr || code || "NONE",
    raw: code,
    logDir,
    writerPass,
    validatorPass,
    metaBefore: shimMetadata,
  };
}
function main(): void {
  const { s6, s7 } = sourceFixture();
  const built = buildS8WriterPayload(s6, s7);
  const evidenceRoot = required("RUN079_EVIDENCE_ROOT");
  const configBase = {
    blenderRuntimeRoot: resolve(required("RUN079_BLENDER_RUNTIME_ROOT")),
    blenderExecutable: resolve(required("RUN079_BLENDER_EXECUTABLE")),
    writerScript: resolve(required("RUN079_WRITER_SCRIPT")),
    processRunnerExecutable: resolve(required("RUN079_PROCESS_RUNNER_EXECUTABLE")),
    nativeValidatorExecutable: resolve(required("RUN079_NATIVE_VALIDATOR_EXECUTABLE")),
    blenderExecutableSha256: required("RUN079_BLENDER_SHA256"),
  };
  if (!statSync(configBase.blenderExecutable).isFile()) throw new Error("RUN079_BLENDER_NOT_REGULAR");
  const root = mkdtempSync(join(evidenceRoot, "s8-run079-"));
  const configs = [
    { name: "M0", acl: false, sandboxIdentity: false, clearEnv: false },
    { name: "M1", acl: true, sandboxIdentity: false, clearEnv: false },
    { name: "M2", acl: false, sandboxIdentity: true, clearEnv: false },
    { name: "M3", acl: true, sandboxIdentity: true, clearEnv: false },
  ];
  const results: CaseResult[] = [];
  for (const item of configs) {
    const caseRoot = join(root, item.name);
    const logDir = join(caseRoot, "logs");
    const workRoot = join(caseRoot, "private-work");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    const shim = join(caseRoot, "bwrap-shim");
    writeShim(shim);
    const config: S8WorkerConfig = { ...configBase, privateWorkRoot: workRoot, sandboxExecutable: shim };
    const restore: Array<() => void> = [];
    const set = (key: string, value: string) => {
      const prior = process.env[key];
      process.env[key] = value;
      restore.push(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    };
    set("RUN079_MODE", item.name);
    set("RUN079_LOG_DIR", logDir);
    set("RUN079_ACCESS_ACL", item.acl ? "1" : "0");
    set("RUN079_IDENTITY", item.sandboxIdentity ? "1" : "0");
    set("RUN079_CLEAR_ENV", item.clearEnv ? "1" : "0");
    set("RUN079_SETENV_PAIRS", "");
    let writerPass = false;
    let validatorPass: boolean | null = null;
    let code = "";
    try {
      const writer = runS8BlenderWriter(built.bytes, config);
      writerPass = true;
      const validated = runS8NativeValidator(writer.artifact, config);
      validatorPass = validated.readback.schemaVersion === "s8-ufbx-readback-v1";
      if (!validatorPass) code = "VALIDATOR_READBACK_SCHEMA_INVALID";
    } catch (error) {
      code = errorCode(error);
    } finally {
      for (const restoreEnv of restore.reverse()) restoreEnv();
    }
    const receipt = parseReceipt(join(logDir, "stdout.txt"));
    const stderr = firstLine(join(logDir, "stderr.txt"));
    const invocation = classify(code, receipt, stderr);
    const shimMetadata = metadata(logDir);
    const result: CaseResult = {
      name: item.name,
      ...invocation,
      firstFailure: stderr || code || "NONE",
      raw: code,
      logDir,
      writerPass,
      validatorPass,
      metaBefore: shimMetadata,
    };
    results.push(result);
    console.log("RUN079_CASE=" + item.name + ";RESULT=" + result.result + ";WORK_CHDIR=" + result.workChdir + ";RUNNER_STARTED=" + result.runnerStarted + ";TARGET_STARTED=" + result.targetStarted + ";WRITER_PASS=" + (writerPass ? "YES" : "NO") + ";VALIDATOR_PASS=" + (validatorPass === null ? "NOT_RUN" : validatorPass ? "YES" : "NO") + ";FIRST_FAILURE=" + (result.firstFailure || "NONE"));
    if (shimMetadata) printMeta(item.name + "_PRE", shimMetadata);
    if (item.acl) {
      const aclPost = readFileSync(join(logDir, "work-acl-post.txt"), "utf8").trim().split(/\r?\n/u).join(",");
      const statPost = readFileSync(join(logDir, "work-stat-post.txt"), "utf8").trim().split(/\r?\n/u).join(",").replace(/(^|,)MODE=([0-7]+)/u, "$1MODE=0$2");
      console.log(item.name + "_POST_WORK_ACL=" + aclPost);
      console.log(item.name + "_POST_WORK_OWNER_GROUP_MODE_DEVICE_INODE=" + statPost);
      console.log(item.name + "_ACL_SUBJECT_UID=" + readFileSync(join(logDir, "acl-subject.txt"), "utf8").trim());
    }
    if (item.name === "M0") {
      console.log("CURRENT_APPLICATION_COUNTEREXAMPLE=" + result.result);
      console.log("CURRENT_FAILURE_BOUNDARY=" + result.runnerBoundary + ";FIRST_FAILURE=" + result.firstFailure);
      if (shimMetadata) {
        console.log("CURRENT_WORK_PATH=" + shimMetadata.path);
        console.log("CURRENT_WORK_UID_GID=" + shimMetadata.uidGid);
        console.log("CURRENT_WORK_MODE=" + shimMetadata.mode);
        console.log("CURRENT_WORK_ACCESS_ACL=" + shimMetadata.accessAcl);
        console.log("CURRENT_WORK_DEFAULT_ACL=" + shimMetadata.defaultAcl);
      }
      const argvPath = join(logDir, "application-argv.txt");
      console.log("CURRENT_APPLICATION_BWRAP_ARGV=" + readFileSync(argvPath, "utf8").trim().replace(/\r?\n/gu, " | "));
      console.log("CURRENT_APPLICATION_BWRAP_ARGV_SHA256=" + readFileSync(join(logDir, "application-argv.sha256"), "utf8").trim());
      console.log("CURRENT_APPLICATION_BWRAP_ARGV_SHA256_INPUT=ordered_NUL_delimited_argv");
      console.log("CURRENT_APPLICATION_SANDBOX_SETUP_OPTIONS=" + readFileSync(argvPath, "utf8").split(/\r?\n/u).filter((line) => /--unshare|--die-with-parent|--new-session|--bind|--chdir|--proc|--dev|--tmpfs/u.test(line)).join(" | "));
    }
  }
  const byName = new Map(results.map((value) => [value.name, value]));
  console.log("M0_CURRENT_RESULT=" + byName.get("M0")!.result);
  console.log("M1_ACL_ONLY_RESULT=" + byName.get("M1")!.result);
  console.log("M2_SANDBOX_IDENTITY_ONLY_RESULT=" + byName.get("M2")!.result);
  console.log("M3_ACL_PLUS_SANDBOX_IDENTITY_RESULT=" + byName.get("M3")!.result);
  const workAlone = byName.get("M1")!.workChdir === "YES";
  const identityAlone = byName.get("M2")!.workChdir === "YES";
  const combined = byName.get("M3")!.workChdir === "YES";
  console.log("WORK_ADMISSION_PREREQUISITE=" + (workAlone && byName.get("M0")!.workChdir !== "YES" ? "ESTABLISHED" : combined ? "COMBINED_ONLY" : "NOT_ESTABLISHED"));
  console.log("SANDBOX_IDENTITY_PREREQUISITE=" + (identityAlone && byName.get("M0")!.workChdir !== "YES" ? "ESTABLISHED" : combined ? "COMBINED_ONLY" : "NOT_ESTABLISHED"));
  const postWork = [byName.get("M1")!, byName.get("M2")!, byName.get("M3")!].find((value) => value.workChdir === "YES");
  console.log("POST_WORK_ADMISSION_FAILURE_BOUNDARY=" + (postWork?.runnerBoundary ?? "NO_MATRIX_CELL_CROSSED_WORK"));
  const smallest = byName.get("M1")!.workChdir === "YES" ? "M1"
    : byName.get("M2")!.workChdir === "YES" ? "M2"
    : byName.get("M3")!.workChdir === "YES" ? "M3"
    : null;
  const environmentResults: CaseResult[] = [];
  if (smallest) {
    const selected = configs.find((value) => value.name === smallest)!;
    const environmentCases: WorkerCaseSettings[] = [
      { name: "CLEAR_ENV_ONLY", acl: selected.acl, sandboxIdentity: selected.sandboxIdentity, clearEnv: true, setenvPairs: "" },
      { name: "ENV_INCREMENT_LANG", acl: selected.acl, sandboxIdentity: selected.sandboxIdentity, clearEnv: true, setenvPairs: "LANG=C.UTF-8" },
      { name: "ENV_INCREMENT_LC_ALL", acl: selected.acl, sandboxIdentity: selected.sandboxIdentity, clearEnv: true, setenvPairs: "LANG=C.UTF-8\nLC_ALL=C.UTF-8" },
      { name: "ENV_INCREMENT_HOME", acl: selected.acl, sandboxIdentity: selected.sandboxIdentity, clearEnv: true, setenvPairs: "LANG=C.UTF-8\nLC_ALL=C.UTF-8\nHOME=/tmp" },
      { name: "ENV_INCREMENT_PATH", acl: selected.acl, sandboxIdentity: selected.sandboxIdentity, clearEnv: true, setenvPairs: "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
    ];
    for (const item of environmentCases) {
      const value = runAdditionalCase(item, built.bytes, configBase, root);
      environmentResults.push(value);
      console.log("RUN079_CASE=" + item.name + ";RESULT=" + value.result + ";WORK_CHDIR=" + value.workChdir + ";RUNNER_STARTED=" + value.runnerStarted + ";TARGET_STARTED=" + value.targetStarted + ";WRITER_PASS=" + (value.writerPass ? "YES" : "NO") + ";VALIDATOR_PASS=" + (value.validatorPass === null ? "NOT_RUN" : value.validatorPass ? "YES" : "NO") + ";FIRST_FAILURE=" + (value.firstFailure || "NONE"));
    }
    const envByName = new Map(environmentResults.map((value) => [value.name, value]));
    console.log("CLEAR_ENV_ONLY_RESULT=" + envByName.get("CLEAR_ENV_ONLY")!.result);
    console.log("ENV_INCREMENT_LANG=" + envByName.get("ENV_INCREMENT_LANG")!.result);
    console.log("ENV_INCREMENT_LC_ALL=" + envByName.get("ENV_INCREMENT_LC_ALL")!.result);
    console.log("ENV_INCREMENT_HOME=" + envByName.get("ENV_INCREMENT_HOME")!.result);
    console.log("ENV_INCREMENT_PATH=" + envByName.get("ENV_INCREMENT_PATH")!.result);
  } else {
    console.log("CLEAR_ENV_ONLY_RESULT=NOT_RUN_NO_MATRIX_CELL_CROSSED_WORK");
    console.log("ENV_INCREMENT_LANG=NOT_RUN_NO_MATRIX_CELL_CROSSED_WORK");
    console.log("ENV_INCREMENT_LC_ALL=NOT_RUN_NO_MATRIX_CELL_CROSSED_WORK");
    console.log("ENV_INCREMENT_HOME=NOT_RUN_NO_MATRIX_CELL_CROSSED_WORK");
    console.log("ENV_INCREMENT_PATH=NOT_RUN_NO_MATRIX_CELL_CROSSED_WORK");
  }
  console.log("RUNNER_MINIMUM_SURFACES=NOT_RUN");
  console.log("VALIDATOR_MINIMUM_SURFACES=NOT_RUN");
  console.log("BLENDER_MINIMUM_SYSTEM_SURFACES=NOT_RUN");
  console.log("RUNTIME_SURFACE_REMOVAL_MATRIX=NOT_RUN");
  console.log("REAL_WRITER_WITH_MINIMUM_SURFACES=NOT_RUN");
  console.log("REAL_VALIDATOR_WITH_MINIMUM_SURFACES=NOT_RUN");
  console.log("MINIMUM_CHILD_ENV_CANDIDATE=NOT_ESTABLISHED");
  console.log("CHILD_ENV_REQUIRED_KEYS=NOT_RUN");
  console.log("CHILD_ENV_UNNECESSARY_KEYS=NOT_RUN");
  console.log("CHILD_ENV_FORBIDDEN_KEYS=NOT_RUN");
  console.log("REAL_WRITER_WITH_MINIMUM_ENV=NOT_RUN");
  console.log("REAL_VALIDATOR_WITH_MINIMUM_ENV=NOT_RUN");
  console.log("CHILD_ENV_NEGATIVE_CONTROLS=NOT_RUN");
  console.log("G4_075_01_EVIDENCE_COMPLETE=NO");
  console.log("G4_075_02_ENVIRONMENT_EVIDENCE_COMPLETE=NO");
  console.log("EVIDENCE_LIMITATIONS=RUN079_A_C_ONLY_FIRST_PASS");
  console.log("RUN079_PAYLOAD_SHA256=" + built.sha256);
  console.log("RUN079_PAYLOAD_BYTES=" + built.bytes.length);
  console.log("RUN079_HARNESS_STATUS=PASS");
  console.log("RUN079_EVIDENCE_ROOT=" + root);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, "\n## Run-079 initial evidence\n\nThe exact application worker functions were invoked with deterministic output from buildS8WriterPayload().\n\n");
    appendFileSync(summaryPath, "- Payload SHA-256: " + built.sha256 + "\n- Diagnostic root: " + root + "\n- Matrix: " + results.map((value) => value.name + "=" + value.result).join(", ") + "\n");
  }
}

try {
  main();
} catch (error) {
  const code = errorCode(error);
  console.error("RUN079_HARNESS_STATUS=FAIL");
  console.error("RUN079_HARNESS_FAILURE=" + code);
  process.exitCode = 1;
}