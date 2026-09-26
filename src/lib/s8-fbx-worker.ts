import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { AppError } from "./types";
import type { S8UfbxReadback } from "./s8-fbx-semantic";
import { S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_LIMITS, S8_PROCESS_RUNNER_PIN, S8_WRITER_RECEIPT_VERSION, s8Sha256 } from "./s8-fbx-profile";

export type S8WorkerConfig = {
  blenderRuntimeRoot: string;
  blenderExecutable: string;
  writerScript: string;
  privateWorkRoot: string;
  processRunnerExecutable?: string;
  sandboxExecutable?: string;
  sandboxPolicySha256: string;
  nativeValidatorExecutable?: string;
  blenderExecutableSha256: string;
};

export type S8WriterReceipt = {
  schemaVersion: typeof S8_WRITER_RECEIPT_VERSION;
  profile: "swooshz-fbx-static-mesh-v1";
  payloadSha256: string;
  writerScriptSha256: string;
  artifactSha256: string;
  artifactByteSize: number;
  fbxHeaderVersion: 7400;
  objectCount: number;
  controlPointCount: number;
  triangleCount: number;
  runtime: {
    blenderVersion: [5, 2, 2];
    blenderVersionString: string;
    blenderBuildHash: string;
    blenderBinarySha256: string;
    exporterVersion: [5, 15, 0];
    exporterFiles: Record<string, { gitBlobSha1: string; sha256: string }>;
    privateExporterPatch: {
      schemaVersion: typeof S8_EXPORTER_PATCH_PIN.manifest;
      patchIdentity: typeof S8_EXPORTER_PATCH_PIN.identity;
      privateExporterSha256: string;
      manifestSha256: string;
    };
    platform: string;
    pythonVersion: string;
  };
};

export type S8RunnerLimits = {
  addressSpaceBytes: number;
  fileBytes: number;
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  maxChildren?: 0;
};

type RunnerLimitEvidence = {
  rlimitAsBytes: number;
  rlimitFsizeBytes: number;
  rlimitCpuSeconds: number;
  rlimitNproc: number;
  wallTimeoutMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  maxChildren?: number;
};

export type S8CallerVerification = {
  schemaVersion: "s8-runner-caller-verification-v2";
  status: "VERIFIED_BY_CALLER";
  preLaunchSha256: string;
  postLaunchSha256: string;
  runnerReportedSelfSha256: string;
  outerExitStatus: number;
  outerSignal: string | null;
  observedStdoutBytes: number;
  observedStderrBytes: number;
  receiptSha256: string;
};

export type S8RunnerEvidence = {
  schemaVersion: typeof S8_PROCESS_RUNNER_PIN.protocol;
  protocol: typeof S8_PROCESS_RUNNER_PIN.protocol;
  policyId: typeof S8_PROCESS_RUNNER_PIN.policy;
  requested: RunnerLimitEvidence & { wallTimeoutMs: number; stdoutBytes: number; stderrBytes: number; maxChildren: 0 };
  appliedByChild: RunnerLimitEvidence & { noNewPrivs: 1; seccompMode: 2 };
  observedByRunnerParent: RunnerLimitEvidence & { noNewPrivs: 1; seccompMode: 2 };
  runnerParentVerification: { status: "PASS"; mismatchCode: null };
  runnerBinary: { selfSha256: string };
  result: {
    code: number;
    name: string;
    terminationClass: string;
    targetExit: number | null;
    targetSignal: number | null;
    elapsedMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    setupStage: string | null;
    evidenceCode: string | null;
  };
  verifiedByCaller: S8CallerVerification;
};

export type S8BrokerIdentityEvidence = { requestId: string; allocationId: string | null; brokerStatus: number; launcherStatus: number; nativeOuterExit: number | null; nativeOuterSignal: number | null; policySha256: string; configSha256: string; runnerPreSha256: string | null; runnerPostSha256: string | null };
export type S8WriterResult = { artifact: Buffer; receipt: S8WriterReceipt; runnerEvidence: S8RunnerEvidence; stdout: string; stderr: string; nativeStdout: Buffer; nativeStderr: Buffer; brokerIdentity: S8BrokerIdentityEvidence; brokerMetadata: Buffer };

export type S8NativeValidatorResult = {
  readback: S8UfbxReadback;
  readbackBytes: Buffer;
  validatorIdentity?: string;
  runnerEvidence?: S8RunnerEvidence;
  stdout: string;
  stderr: string;
  nativeStdout: Buffer;
  nativeStderr: Buffer;
  brokerIdentity: S8BrokerIdentityEvidence;
  brokerMetadata: Buffer;
};

type RunnerIdentity = { path: string; device: number; inode: number; size: number; mtimeMs: number };
type RunnerCapture = { status: number | null; signal: string | null; stderr: Buffer };

const RUNNER_RECEIPT_PREFIX = "S8_RUNNER_RECEIPT:";
const HEX64 = /^[0-9a-f]{64}$/u;
export const S8_SYSTEM_RUNTIME_BIND_PATHS = [
  "/lib64/ld-linux-x86-64.so.2",
  "/lib/x86_64-linux-gnu/libGL.so.1",
  "/lib/x86_64-linux-gnu/libGLX.so.0",
  "/lib/x86_64-linux-gnu/libGLdispatch.so.0",
  "/lib/x86_64-linux-gnu/libICE.so.6",
  "/lib/x86_64-linux-gnu/libSM.so.6",
  "/lib/x86_64-linux-gnu/libX11.so.6",
  "/lib/x86_64-linux-gnu/libXau.so.6",
  "/lib/x86_64-linux-gnu/libXdmcp.so.6",
  "/lib/x86_64-linux-gnu/libXext.so.6",
  "/lib/x86_64-linux-gnu/libXfixes.so.3",
  "/lib/x86_64-linux-gnu/libXi.so.6",
  "/lib/x86_64-linux-gnu/libXrender.so.1",
  "/lib/x86_64-linux-gnu/libbsd.so.0",
  "/lib/x86_64-linux-gnu/libc.so.6",
  "/lib/x86_64-linux-gnu/libdl.so.2",
  "/lib/x86_64-linux-gnu/libgcc_s.so.1",
  "/lib/x86_64-linux-gnu/libm.so.6",
  "/lib/x86_64-linux-gnu/libmd.so.0",
  "/lib/x86_64-linux-gnu/libpthread.so.0",
  "/lib/x86_64-linux-gnu/librt.so.1",
  "/lib/x86_64-linux-gnu/libstdc++.so.6",
  "/lib/x86_64-linux-gnu/libutil.so.1",
  "/lib/x86_64-linux-gnu/libuuid.so.1",
  "/lib/x86_64-linux-gnu/libxcb.so.1",
  "/lib/x86_64-linux-gnu/libxkbcommon.so.0",
  "/etc/passwd",
] as const;

function assertS8SystemRuntimePaths(): void {
  for (const path of S8_SYSTEM_RUNTIME_BIND_PATHS) {
    try {
      if (!statSync(/* turbopackIgnore: true */ path).isFile()) fail("S8_TOOLING_HOLD_RUNTIME_ALLOWLIST", "runtime");
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail("S8_TOOLING_HOLD_RUNTIME_ALLOWLIST", "runtime");
    }
  }
}

function fail(code: string, field = "worker"): never {
  throw new AppError(502, code, [{ field, code }]);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path: string, field: string): string {
  try {
    const original = lstatSync(path);
    const absolute = realpathSync(path);
    if (original.isSymbolicLink() || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) fail("S8_WORKER_PATH_INVALID", field);
    return absolute;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail("S8_WORKER_PATH_INVALID", field);
  }
}

function assertDirectory(path: string, field: string): string {
  try {
    const original = lstatSync(path);
    const absolute = realpathSync(path);
    if (original.isSymbolicLink() || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) fail("S8_WORKER_PATH_INVALID", field);
    return absolute;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail("S8_WORKER_PATH_INVALID", field);
  }
}

function runnerIdentity(path: string): RunnerIdentity {
  const absolute = assertRegularFile(path, "processRunnerExecutable");
  const info = statSync(/* turbopackIgnore: true */ absolute);
  return { path: absolute, device: Number(info.dev), inode: Number(info.ino), size: info.size, mtimeMs: info.mtimeMs };
}

function sameRunnerIdentity(left: RunnerIdentity, right: RunnerIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function runnerPath(config: S8WorkerConfig): RunnerIdentity {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  if (!config.processRunnerExecutable) fail("S8_PROCESS_RUNNER_REQUIRED");
  return runnerIdentity(config.processRunnerExecutable);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function jsonStringEnd(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("string");
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) {
      if (character === "u" && !/^[0-9a-f]{4}$/iu.test(text.slice(index + 1, index + 5))) throw new Error("escape");
      escaped = false;
    } else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  throw new Error("string");
}

function scanJsonValue(text: string, start: number): number {
  const index = skipJsonWhitespace(text, start);
  const character = text[index];
  if (character === '"') return jsonStringEnd(text, index);
  if (character === "{") {
    let cursor = skipJsonWhitespace(text, index + 1);
    const keys = new Set<string>();
    if (text[cursor] === "}") return cursor + 1;
    for (;;) {
      const keyEnd = jsonStringEnd(text, cursor);
      const key = JSON.parse(text.slice(cursor, keyEnd)) as string;
      if (keys.has(key)) throw new Error("duplicate-key");
      keys.add(key);
      cursor = skipJsonWhitespace(text, keyEnd);
      if (text[cursor] !== ":") throw new Error("colon");
      cursor = scanJsonValue(text, cursor + 1);
      cursor = skipJsonWhitespace(text, cursor);
      if (text[cursor] === "}") return cursor + 1;
      if (text[cursor] !== ",") throw new Error("comma");
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
  }
  if (character === "[") {
    let cursor = skipJsonWhitespace(text, index + 1);
    if (text[cursor] === "]") return cursor + 1;
    for (;;) {
      cursor = scanJsonValue(text, cursor);
      cursor = skipJsonWhitespace(text, cursor);
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") throw new Error("comma");
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
  }
  const primitiveEnd = text.slice(index).search(/[\s,\]}]/u);
  const end = primitiveEnd < 0 ? text.length : index + primitiveEnd;
  if (end === index) throw new Error("value");
  return end;
}

function parseStrictJson(text: string): Record<string, unknown> {
  try {
    const end = scanJsonValue(text, 0);
    if (skipJsonWhitespace(text, end) !== text.length) throw new Error("trailing");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    if (JSON.stringify(value) !== text) throw new Error("noncanonical");
    return value as Record<string, unknown>;
  } catch {
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  return value as Record<string, unknown>;
}

function checkedNumber(value: unknown, positive = false): number {
  if (positive) {
    if (!isPositiveInteger(value)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    return value;
  }
  if (!isNonnegativeInteger(value)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  return value;
}

function checkedLimitObject(value: unknown, keys: readonly string[], includeWall: boolean, allowZero = false): Record<string, unknown> {
  const record = objectValue(value);
  exactKeys(record, keys);
  checkedNumber(record.rlimitAsBytes, !allowZero);
  checkedNumber(record.rlimitFsizeBytes, !allowZero);
  checkedNumber(record.rlimitCpuSeconds, !allowZero);
  checkedNumber(record.rlimitNproc, !allowZero);
  if (includeWall) {
    checkedNumber(record.wallTimeoutMs, true);
    checkedNumber(record.stdoutBytes, true);
    checkedNumber(record.stderrBytes, true);
    checkedNumber(record.maxChildren);
  }
  return record;
}

function cpuSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) + 1;
}

function expectedRequested(limits: S8RunnerLimits): Record<string, number> {
  return { rlimitAsBytes: limits.addressSpaceBytes, rlimitFsizeBytes: limits.fileBytes, rlimitCpuSeconds: cpuSeconds(limits.timeoutMs), rlimitNproc: 64, wallTimeoutMs: limits.timeoutMs, stdoutBytes: limits.stdoutBytes, stderrBytes: limits.stderrBytes, maxChildren: limits.maxChildren ?? 0 };
}

function equalFields(record: Record<string, unknown>, expected: Record<string, number>): void {
  for (const [key, value] of Object.entries(expected)) if (record[key] !== value) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
}

export function canonicalS8RunnerReceiptBytes(value: S8RunnerEvidence): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: value.schemaVersion,
    protocol: value.protocol,
    policyId: value.policyId,
    requested: {
      rlimitAsBytes: value.requested.rlimitAsBytes,
      rlimitFsizeBytes: value.requested.rlimitFsizeBytes,
      rlimitCpuSeconds: value.requested.rlimitCpuSeconds,
      rlimitNproc: value.requested.rlimitNproc,
      wallTimeoutMs: value.requested.wallTimeoutMs,
      stdoutBytes: value.requested.stdoutBytes,
      stderrBytes: value.requested.stderrBytes,
      maxChildren: value.requested.maxChildren,
    },
    appliedByChild: {
      rlimitAsBytes: value.appliedByChild.rlimitAsBytes,
      rlimitFsizeBytes: value.appliedByChild.rlimitFsizeBytes,
      rlimitCpuSeconds: value.appliedByChild.rlimitCpuSeconds,
      rlimitNproc: value.appliedByChild.rlimitNproc,
      noNewPrivs: value.appliedByChild.noNewPrivs,
      seccompMode: value.appliedByChild.seccompMode,
    },
    observedByRunnerParent: {
      rlimitAsBytes: value.observedByRunnerParent.rlimitAsBytes,
      rlimitFsizeBytes: value.observedByRunnerParent.rlimitFsizeBytes,
      rlimitCpuSeconds: value.observedByRunnerParent.rlimitCpuSeconds,
      rlimitNproc: value.observedByRunnerParent.rlimitNproc,
      noNewPrivs: value.observedByRunnerParent.noNewPrivs,
      seccompMode: value.observedByRunnerParent.seccompMode,
    },
    runnerParentVerification: {
      status: value.runnerParentVerification.status,
      mismatchCode: value.runnerParentVerification.mismatchCode,
    },
    runnerBinary: { selfSha256: value.runnerBinary.selfSha256 },
    result: {
      code: value.result.code,
      name: value.result.name,
      terminationClass: value.result.terminationClass,
      targetExit: value.result.targetExit,
      targetSignal: value.result.targetSignal,
      elapsedMs: value.result.elapsedMs,
      stdoutBytes: value.result.stdoutBytes,
      stderrBytes: value.result.stderrBytes,
      setupStage: value.result.setupStage,
      evidenceCode: value.result.evidenceCode,
    },
  }), "utf8");
}

export function parseS8RunnerReceipt(
  output: Buffer,
  expected: S8RunnerLimits,
  runnerSha256: string,
  postLaunchSha256 = runnerSha256,
  capture: RunnerCapture = { status: 0, signal: null, stderr: Buffer.alloc(0) },
): { stdout: string; stdoutBytes: Buffer; evidence: S8RunnerEvidence } {
  const prefix = Buffer.from(RUNNER_RECEIPT_PREFIX, "ascii");
  if (!output.subarray(0, prefix.length).equals(prefix)) {
    if (capture.status === 64 && capture.signal === null && output.indexOf(prefix) === -1) fail("S8_PROCESS_RUNNER_ARGUMENT_INVALID");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (output.indexOf(prefix, prefix.length) !== -1) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const newline = output.indexOf(0x0a, prefix.length);
  if (newline <= prefix.length) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const receiptBytes = output.subarray(prefix.length, newline);
  if (receiptBytes.includes(0x0d) || receiptBytes.some((byte) => byte > 0x7f)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const receiptText = receiptBytes.toString("ascii");
  const parsed = parseStrictJson(receiptText);
  exactKeys(parsed, ["schemaVersion", "protocol", "policyId", "requested", "appliedByChild", "observedByRunnerParent", "runnerParentVerification", "runnerBinary", "result"]);
  if (parsed.schemaVersion !== S8_PROCESS_RUNNER_PIN.protocol || parsed.protocol !== S8_PROCESS_RUNNER_PIN.protocol || parsed.policyId !== S8_PROCESS_RUNNER_PIN.policy) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const resultCode = checkedNumber(objectValue(parsed.result).code);
  const setupFailure = resultCode === 71;
  const requested = checkedLimitObject(parsed.requested, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "wallTimeoutMs", "stdoutBytes", "stderrBytes", "maxChildren"], true);
  const applied = checkedLimitObject(parsed.appliedByChild, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false, setupFailure);
  const observed = checkedLimitObject(parsed.observedByRunnerParent, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false, setupFailure);
  if (setupFailure) {
    // Native code 71 emits a zeroed setup record before releasing the target.
    if ([applied.rlimitAsBytes, applied.rlimitFsizeBytes, applied.rlimitCpuSeconds, applied.rlimitNproc, applied.noNewPrivs, applied.seccompMode, observed.rlimitAsBytes, observed.rlimitFsizeBytes, observed.rlimitCpuSeconds, observed.rlimitNproc, observed.noNewPrivs, observed.seccompMode].some((value) => value !== 0)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else {
    checkedNumber(applied.noNewPrivs, true); checkedNumber(applied.seccompMode, true); checkedNumber(observed.noNewPrivs, true); checkedNumber(observed.seccompMode, true);
    if (applied.noNewPrivs !== 1 || applied.seccompMode !== 2 || observed.noNewPrivs !== 1 || observed.seccompMode !== 2) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  equalFields(requested, expectedRequested(expected));
  if (!setupFailure) for (const key of ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc"]) if (applied[key] !== requested[key] || observed[key] !== applied[key]) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const verification = objectValue(parsed.runnerParentVerification);
  exactKeys(verification, ["status", "mismatchCode"]);
  if ((verification.status !== "PASS" && verification.status !== "FAIL") || (verification.mismatchCode !== null && typeof verification.mismatchCode !== "string")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const binary = objectValue(parsed.runnerBinary);
  exactKeys(binary, ["selfSha256"]);
  if (typeof binary.selfSha256 !== "string" || !HEX64.test(binary.selfSha256) || binary.selfSha256 !== runnerSha256 || runnerSha256 !== postLaunchSha256) fail("S8_RUNNER_HASH_DRIFT");
  const result = objectValue(parsed.result);
  exactKeys(result, ["code", "name", "terminationClass", "targetExit", "targetSignal", "elapsedMs", "stdoutBytes", "stderrBytes", "setupStage", "evidenceCode"]);
  if (!canonicalS8RunnerReceiptBytes(parsed as unknown as S8RunnerEvidence).equals(receiptBytes)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const code = resultCode;
  checkedNumber(result.elapsedMs);
  const stdoutBytes = checkedNumber(result.stdoutBytes);
  const stderrBytes = checkedNumber(result.stderrBytes);
  if (typeof result.name !== "string" || typeof result.terminationClass !== "string" || (result.targetExit !== null && !isNonnegativeInteger(result.targetExit)) || (result.targetSignal !== null && !isPositiveInteger(result.targetSignal)) || (result.setupStage !== null && typeof result.setupStage !== "string") || (result.evidenceCode !== null && typeof result.evidenceCode !== "string")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  if (stdoutBytes > expected.stdoutBytes || stderrBytes > expected.stderrBytes) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const resultContracts: Record<number, readonly [string, string]> = {
    0: ["S8_RUNNER_SUCCESS", "target-exit-zero"],
    70: ["S8_RUNNER_INTERNAL", "runner-internal"],
    71: ["S8_RUNNER_CHILD_SETUP_FAILED", "child-setup-failed"],
    72: ["S8_RUNNER_EVIDENCE_INVALID", "evidence-failed"],
    73: ["S8_RUNNER_EXEC_FAILED", "exec-failed"],
    74: ["S8_RUNNER_STDOUT_LIMIT", "stdout-limit"],
    75: ["S8_RUNNER_STDERR_LIMIT", "stderr-limit"],
    76: ["S8_RUNNER_TARGET_EXIT_NONZERO", "target-exit-nonzero"],
    77: ["S8_RUNNER_TARGET_SIGNAL", "target-signal"],
    124: ["S8_RUNNER_TIMEOUT", "wall-timeout"],
  };
  const contract = resultContracts[code];
  if (!contract || result.name !== contract[0] || result.terminationClass !== contract[1]) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const noTargetTermination = result.targetExit === null && result.targetSignal === null;
  if (code === 0) {
    if (result.targetExit !== 0 || result.targetSignal !== null || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 70) {
    if (!noTargetTermination || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 71) {
    const setupStages = new Set(["setpgid", "pdeathsig", "parent_check", "rlimit_as", "rlimit_fsize", "rlimit_cpu", "rlimit_nproc", "no_new_privs", "seccomp", "child_evidence", "release"]);
    if (!noTargetTermination || typeof result.setupStage !== "string" || !setupStages.has(result.setupStage) || result.evidenceCode !== null || verification.status !== "FAIL" || verification.mismatchCode !== null || result.stdoutBytes !== 0 || result.stderrBytes !== 0) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 72) {
    if (!noTargetTermination || result.setupStage !== null || typeof result.evidenceCode !== "string" || result.evidenceCode.length === 0 || verification.mismatchCode !== result.evidenceCode) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 76) {
    if (result.targetExit === null || result.targetExit === 0 || result.targetExit > 255 || result.targetSignal !== null || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 77) {
    if (result.targetExit !== null || result.targetSignal === null || result.targetSignal > 64 || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (!noTargetTermination || result.setupStage !== null || result.evidenceCode !== null) {
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (code === 70) {
    const verifiedInternalMismatchCodes = new Set(["CAPTURE_INIT", "EXEC_CHANNEL", "POLL", "STDOUT_READ", "STDERR_READ", "WAITPID", "INTERNAL"]);
    if (verification.status === "FAIL") {
      if (verification.mismatchCode !== "PARENT_SETPGID") fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    } else if (verification.mismatchCode !== null && (typeof verification.mismatchCode !== "string" || !verifiedInternalMismatchCodes.has(verification.mismatchCode))) {
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  if (code === 72) {
    const evidenceMismatchCodes = new Set([
      "CHILD_EVIDENCE_MALFORMED", "PARENT_PRLIMIT_AS", "PARENT_PRLIMIT_FSIZE", "PARENT_PRLIMIT_CPU", "PARENT_PRLIMIT_NPROC",
      "PARENT_PROC_STATUS", "PARENT_PROC_SECURITY", "REQUESTED_APPLIED_OBSERVED", "RELEASE_CHANNEL",
    ]);
    if (typeof result.evidenceCode !== "string" || !evidenceMismatchCodes.has(result.evidenceCode)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    if (result.evidenceCode === "RELEASE_CHANNEL") {
      if (verification.status !== "PASS") fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    } else if (verification.status !== "FAIL") {
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  if (code !== 70 && code !== 71 && code !== 72 && (verification.status !== "PASS" || verification.mismatchCode !== null)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");

  const targetStdout = output.subarray(newline + 1);
  const capturedStderr = Buffer.isBuffer(capture.stderr) ? capture.stderr : Buffer.alloc(0);
  if (capture.signal !== null || capture.status !== code || stdoutBytes !== targetStdout.length || stderrBytes !== capturedStderr.length) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const evidence = parsed as unknown as S8RunnerEvidence;
  evidence.verifiedByCaller = {
    schemaVersion: "s8-runner-caller-verification-v2",
    status: "VERIFIED_BY_CALLER",
    preLaunchSha256: runnerSha256,
    postLaunchSha256,
    runnerReportedSelfSha256: binary.selfSha256 as string,
    outerExitStatus: capture.status as number,
    outerSignal: capture.signal,
    observedStdoutBytes: targetStdout.length,
    observedStderrBytes: capturedStderr.length,
    receiptSha256: s8Sha256(receiptBytes),
  };
  return { stdout: targetStdout.toString("utf8"), stdoutBytes: Buffer.from(targetStdout), evidence };
}

function runnerFailure(code: number): string {
  switch (code) {
    case 64: return "S8_PROCESS_RUNNER_ARGUMENT_INVALID";
    case 71: return "S8_PROCESS_RUNNER_CHILD_SETUP_FAILED";
    case 72: return "S8_PROCESS_RUNNER_EVIDENCE_INVALID";
    case 73: return "S8_PROCESS_RUNNER_EXEC_FAILED";
    case 74: return "S8_STDOUT_LIMIT";
    case 75: return "S8_STDERR_LIMIT";
    case 124: return "S8_PROCESS_RUNNER_TIMEOUT";
    case 76: case 77: return "S8_WORKER_FAILED";
    default: return "S8_PROCESS_RUNNER_FAILED";
  }
}

const BROKER_REQUEST_BYTES = 160;
const BROKER_RESPONSE_HEADER_BYTES = 320;
const BROKER_PROTOCOL_VERSION = 1;
const BROKER_LAUNCHER_PATH = "/usr/local/libexec/swooshz-s8/s8-sandbox";
const BROKER_WRITER_MAX_BYTES = 137_445_696;
const BROKER_VALIDATOR_MAX_BYTES = 9_519_424;
const BROKER_METADATA_MAX_BYTES = 16_384;
const BROKER_STDERR_MAX_BYTES = 4_096;
const BROKER_STATUS = new Map<number, string>([[64, "PROTOCOL_INVALID"], [65, "CALLER_OR_POLICY_INVALID"], [66, "ROOT_OR_DEPLOYMENT_INVALID"], [67, "JOURNAL_INVALID"], [68, "ALLOCATION_OR_INPUT_ADMISSION_FAILED"], [69, "LAUNCH_OR_STATUS_INVALID"], [70, "NATIVE_OPERATION_FAILED"], [71, "OUTPUT_OR_RECEIPT_INVALID"], [72, "CLEANUP_HOLD"], [73, "RECOVERY_IDENTITY_UNKNOWN_HOLD"], [74, "RECOVERY_LAUNCH_IDENTITY_UNKNOWN_HOLD"], [75, "RECOVERY_PIDNS_INIT_IDENTITY_HOLD"], [76, "RECOVERY_PROCESS_TREE_NOT_QUIESCENT_HOLD"], [77, "RECOVERY_RETRY_LIMIT_HOLD"], [78, "BUSY"], [79, "BROKER_INTERNAL"], [124, "OPERATION_TIMEOUT"]]);

export type S8BrokerOperation = "WRITER" | "VALIDATOR";
export type S8BrokerResponse = {
  operation: S8BrokerOperation;
  requestId: string;
  brokerStatus: number;
  nativeOuterExit: number;
  nativeOuterSignal: number;
  allocationId: string | null;
  runnerPreSha256: string;
  runnerPostSha256: string;
  policySha256: string;
  configSha256: string;
  identityBound: boolean;
  artifact: Buffer;
  writerReceipt: Buffer;
  nativeStdout: Buffer;
  nativeStderr: Buffer;
  metadata: Buffer;
};

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalConfigString(value: unknown, field: string): string {
  if (typeof value !== "string" || !hasOnlyUnicodeScalars(value)) fail("S8_BROKER_CONFIG_INVALID", field);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 1024 || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) fail("S8_BROKER_CONFIG_INVALID", field);
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) fail("S8_BROKER_CONFIG_INVALID", field);
  return JSON.stringify(value);
}

export function canonicalS8ConfigBytes(config: S8WorkerConfig): Buffer {
  if (!config.sandboxExecutable || config.sandboxExecutable !== BROKER_LAUNCHER_PATH) fail("S8_WORKER_SANDBOX_REQUIRED");
  if (!HEX64.test(config.sandboxPolicySha256)) fail("S8_BROKER_POLICY_IDENTITY_INVALID");
  if (!HEX64.test(config.blenderExecutableSha256)) fail("S8_BROKER_CONFIG_INVALID", "blenderExecutableSha256");
  const fields = [
    ["blenderRuntimeRoot", config.blenderRuntimeRoot],
    ["blenderExecutable", config.blenderExecutable],
    ["writerScript", config.writerScript],
    ["privateWorkRoot", config.privateWorkRoot],
    ["processRunnerExecutable", config.processRunnerExecutable],
    ["sandboxExecutable", config.sandboxExecutable],
    ["nativeValidatorExecutable", config.nativeValidatorExecutable],
    ["blenderExecutableSha256", config.blenderExecutableSha256],
    ["sandboxPolicySha256", config.sandboxPolicySha256],
  ] as const;
  const members = fields.map(([key, value]) => `"${key}":${canonicalConfigString(value, key)}`);
  return Buffer.from(`{${members.join(",")}}`, "utf8");
}

export function createS8BrokerRequest(operation: S8BrokerOperation, payload: Buffer, config: S8WorkerConfig, requestId = randomBytes(16)): { bytes: Buffer; requestId: string; configSha256: string } {
  if (requestId.length !== 16) fail("S8_BROKER_PROTOCOL_INVALID");
  if ((operation === "WRITER" && (payload.length === 0 || payload.length > S8_LIMITS.payloadBytes)) || (operation === "VALIDATOR" && payload.length > 134_217_728)) fail("S8_BROKER_PROTOCOL_INVALID");
  const configSha256 = s8Sha256(canonicalS8ConfigBytes(config));
  const header = Buffer.alloc(BROKER_REQUEST_BYTES);
  header.write("S8BRQ001", 0, "ascii");
  header.writeUInt16BE(BROKER_PROTOCOL_VERSION, 8);
  header.writeUInt8(operation === "WRITER" ? 1 : 2, 10);
  requestId.copy(header, 12);
  Buffer.from(config.sandboxPolicySha256, "hex").copy(header, 28);
  Buffer.from(configSha256, "hex").copy(header, 60);
  header.writeBigUInt64BE(BigInt(payload.length), 92);
  createHash("sha256").update(payload).digest().copy(header, 100);
  return { bytes: Buffer.concat([header, payload]), requestId: requestId.toString("hex"), configSha256 };
}

function strictUtf8(bytes: Buffer, code: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) fail(code);
    return text;
  } catch { fail(code); }
}

export function parseS8BrokerResponse(bytes: Buffer, expected: { operation: S8BrokerOperation; requestId: string; policySha256: string; configSha256: string }): S8BrokerResponse {
  if (bytes.length < BROKER_RESPONSE_HEADER_BYTES) fail("S8_BROKER_RESPONSE_INVALID");
  const header = bytes.subarray(0, BROKER_RESPONSE_HEADER_BYTES);
  const opCode = expected.operation === "WRITER" ? 1 : 2;
  if (header.toString("ascii", 0, 8) !== "S8BRS001" || header.readUInt16BE(8) !== BROKER_PROTOCOL_VERSION || header.readUInt8(10) !== opCode || header[11] !== 0 || header.readUInt16BE(30) !== 0) fail("S8_BROKER_RESPONSE_INVALID");
  if (header.subarray(12, 28).toString("hex") !== expected.requestId) fail("S8_BROKER_RESPONSE_BINDING_MISMATCH");
  if (header.subarray(256).some((value) => value !== 0)) fail("S8_BROKER_RESPONSE_INVALID");
  const lengths = [184, 192, 200, 208, 216].map((offset) => header.readBigUInt64BE(offset));
  const total = lengths.reduce((sum, value) => sum + value, BigInt(BROKER_RESPONSE_HEADER_BYTES));
  const maximum = expected.operation === "WRITER" ? BROKER_WRITER_MAX_BYTES : BROKER_VALIDATOR_MAX_BYTES;
  if (total > BigInt(maximum) || total !== BigInt(bytes.length) || lengths[4]! > BigInt(BROKER_METADATA_MAX_BYTES) || lengths[3]! > BigInt(BROKER_STDERR_MAX_BYTES)) fail("S8_BROKER_RESPONSE_INVALID");
  let cursor = BROKER_RESPONSE_HEADER_BYTES;
  const sections: Buffer[] = [];
  for (const length of lengths) {
    const size = Number(length);
    sections.push(bytes.subarray(cursor, cursor + size));
    cursor += size;
  }
  if (!createHash("sha256").update(Buffer.concat(sections)).digest().equals(header.subarray(224, 256))) fail("S8_BROKER_RESPONSE_DIGEST_MISMATCH");
  const metadataText = strictUtf8(sections[4]!, "S8_BROKER_METADATA_INVALID");
  const metadata = parseStrictJson(metadataText);
  if (JSON.stringify(metadata) !== metadataText) fail("S8_BROKER_METADATA_INVALID");
  const status = header.readUInt16BE(28);
  const nativeOuterExit = header.readInt32BE(32);
  const nativeOuterSignal = header.readInt32BE(36);
  if (nativeOuterExit < -1 || nativeOuterSignal < -1 || nativeOuterSignal > 64) fail("S8_BROKER_RESPONSE_INVALID");
  const allocationBytes = header.subarray(40, 56);
  const allocationId = allocationBytes.some((value) => value !== 0) ? allocationBytes.toString("hex") : null;
  const response: S8BrokerResponse = {
    operation: expected.operation,
    requestId: expected.requestId,
    brokerStatus: status,
    nativeOuterExit,
    nativeOuterSignal,
    allocationId,
    runnerPreSha256: header.subarray(56, 88).toString("hex"),
    runnerPostSha256: header.subarray(88, 120).toString("hex"),
    policySha256: header.subarray(120, 152).toString("hex"),
    configSha256: header.subarray(152, 184).toString("hex"),
    identityBound: header.subarray(120, 152).toString("hex") === expected.policySha256 && header.subarray(152, 184).toString("hex") === expected.configSha256,
    artifact: sections[0]!, writerReceipt: sections[1]!, nativeStdout: sections[2]!, nativeStderr: sections[3]!, metadata: sections[4]!,
  };
  if (status === 0 && (nativeOuterExit !== 0 || nativeOuterSignal !== -1 || allocationId === null)) fail("S8_BROKER_RESPONSE_INVALID");
  if (status !== 0 && (response.artifact.length !== 0 || response.writerReceipt.length !== 0)) fail("S8_BROKER_FAILURE_PUBLISHED_OUTPUT");
  return response;
}

export function validateS8BrokerResponseIdentity(response: S8BrokerResponse): void {
  if (response.brokerStatus === 0 && !response.identityBound) fail("S8_OUTPUT_OR_RECEIPT_INVALID");
}

function runS8Broker(operation: S8BrokerOperation, payload: Buffer, config: S8WorkerConfig): { response: S8BrokerResponse; identity: S8BrokerIdentityEvidence } {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  const launcher = assertRegularFile(config.sandboxExecutable ?? "", "sandboxExecutable");
  if (launcher !== BROKER_LAUNCHER_PATH) fail("S8_WORKER_SANDBOX_REQUIRED");
  const runner = runnerPath(config);
  const runnerPreSha256 = fileSha256(runner.path);
  const request = createS8BrokerRequest(operation, payload, config);
  const emptyEnvironment = Object.create(null) as NodeJS.ProcessEnv;
  const writer = operation === "WRITER";
  const child = spawnSync(/* turbopackIgnore: true */ launcher, [], {
    input: request.bytes,
    env: emptyEnvironment,
    shell: false,
    windowsHide: true,
    timeout: writer ? 495_000 : 315_000,
    maxBuffer: writer ? BROKER_WRITER_MAX_BYTES : BROKER_VALIDATOR_MAX_BYTES,
    encoding: null,
    killSignal: "SIGKILL",
  });
  if (child.error) {
    const errorCode = "code" in child.error ? child.error.code : undefined;
    fail(errorCode === "ETIMEDOUT" ? "S8_SANDBOX_BROKER_TIMEOUT" : "S8_SANDBOX_BROKER_LAUNCH_FAILED");
  }
  const raw = Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? "");
  const brokerStderr = Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(child.stderr ?? "");
  if (brokerStderr.length > BROKER_STDERR_MAX_BYTES) fail("S8_SANDBOX_BROKER_STDERR_LIMIT");
  const after = runnerIdentity(runner.path);
  if (!sameRunnerIdentity(runner, after)) fail("S8_RUNNER_IDENTITY_DRIFT");
  const runnerPostSha256 = fileSha256(after.path);
  const response = parseS8BrokerResponse(raw, { operation, requestId: request.requestId, policySha256: config.sandboxPolicySha256, configSha256: request.configSha256 });
  validateS8BrokerResponseIdentity(response);
  if (response.runnerPreSha256 !== runnerPreSha256 || response.runnerPostSha256 !== runnerPostSha256) fail("S8_RUNNER_IDENTITY_DRIFT");
  if (response.brokerStatus !== 0 || child.status !== 0 || child.signal !== null) {
    const detail = BROKER_STATUS.get(response.brokerStatus) ?? `STATUS_${response.brokerStatus}`;
    fail(`S8_SANDBOX_BROKER_${detail}`);
  }
  if (brokerStderr.length !== 0) fail("S8_SANDBOX_BROKER_DIAGNOSTIC_OUTPUT");
  return {
    response,
    identity: { requestId: request.requestId, allocationId: response.allocationId, brokerStatus: response.brokerStatus, launcherStatus: child.status ?? -1, nativeOuterExit: response.nativeOuterExit < 0 ? null : response.nativeOuterExit, nativeOuterSignal: response.nativeOuterSignal < 0 ? null : response.nativeOuterSignal, policySha256: response.policySha256, configSha256: response.configSha256, runnerPreSha256: response.runnerPreSha256, runnerPostSha256: response.runnerPostSha256 },
  };
}

function parseWriterReceipt(bytes: Buffer, payloadSha256: string, writerSha256: string, executableSha256: string, artifact: Buffer, privateExporterSha256: string, manifestSha256: string): S8WriterReceipt {
  if (bytes.length > S8_LIMITS.receiptBytes) fail("S8_WRITER_RECEIPT_LIMIT");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("ascii")); } catch { fail("S8_WRITER_RECEIPT_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("S8_WRITER_RECEIPT_INVALID");
  const receipt = value as S8WriterReceipt;
  if (receipt.schemaVersion !== S8_WRITER_RECEIPT_VERSION || receipt.profile !== "swooshz-fbx-static-mesh-v1" || receipt.fbxHeaderVersion !== 7400 || !receipt.runtime) fail("S8_WRITER_RECEIPT_INVALID");
  if (receipt.payloadSha256 !== payloadSha256 || receipt.writerScriptSha256 !== writerSha256 || receipt.artifactSha256 !== s8Sha256(artifact) || receipt.artifactByteSize !== artifact.length) fail("S8_WRITER_RECEIPT_BINDING_MISMATCH");
  if (receipt.runtime.blenderBinarySha256 !== executableSha256 || JSON.stringify(receipt.runtime.blenderVersion) !== "[5,2,2]" || !receipt.runtime.blenderBuildHash.startsWith(S8_BLENDER_PIN.buildHashPrefix) || JSON.stringify(receipt.runtime.exporterVersion) !== "[5,15,0]") fail("S8_RUNTIME_IDENTITY_MISMATCH");
  for (const [name, expectedSha1] of Object.entries(S8_BLENDER_PIN.exporterBlobs)) if (receipt.runtime.exporterFiles?.[name]?.gitBlobSha1 !== expectedSha1) fail("S8_EXPORTER_IDENTITY_MISMATCH");
  if (receipt.runtime.privateExporterPatch?.schemaVersion !== S8_EXPORTER_PATCH_PIN.manifest || receipt.runtime.privateExporterPatch.patchIdentity !== S8_EXPORTER_PATCH_PIN.identity || receipt.runtime.privateExporterPatch.privateExporterSha256 !== privateExporterSha256 || receipt.runtime.privateExporterPatch.manifestSha256 !== manifestSha256) fail("S8_EXPORTER_PATCH_IDENTITY_MISMATCH");
  return receipt;
}

export function runS8BlenderWriter(payloadBytes: Buffer, config: S8WorkerConfig, onHeartbeat?: () => void): S8WriterResult {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  assertS8SystemRuntimePaths();
  if (payloadBytes.length === 0 || payloadBytes.length > S8_LIMITS.payloadBytes) fail("S8_PAYLOAD_RESOURCE_LIMIT");
  assertDirectory(config.blenderRuntimeRoot, "blenderRuntimeRoot");
  const blender = assertRegularFile(config.blenderExecutable, "blenderExecutable");
  const writer = assertRegularFile(config.writerScript, "writerScript");
  const privateExporter = assertRegularFile(join(dirname(writer), "export_fbx_bin.py"), "privateExporter");
  const patchManifest = assertRegularFile(join(dirname(writer), "patch-manifest.json"), "patchManifest");
  const executableSha256 = fileSha256(blender);
  if (executableSha256 !== config.blenderExecutableSha256) fail("S8_BLENDER_EXECUTABLE_DIGEST_MISMATCH");
  const writerSha256 = fileSha256(writer);
  const privateExporterSha256 = fileSha256(privateExporter);
  const manifestSha256 = fileSha256(patchManifest);
  assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  onHeartbeat?.();
  const { response, identity } = runS8Broker("WRITER", payloadBytes, config);
  onHeartbeat?.();
  if (response.artifact.length <= 27 || response.artifact.length > S8_LIMITS.artifactBytes || response.writerReceipt.length === 0 || response.nativeOuterExit !== 0 || response.nativeOuterSignal !== -1) fail("S8_WORKER_OUTPUT_INVALID");
  const runner = runnerPath(config);
  const runnerSha256 = fileSha256(runner.path);
  const nativeLimits: S8RunnerLimits = { addressSpaceBytes: S8_LIMITS.writerAddressSpaceBytes, fileBytes: S8_LIMITS.artifactBytes, timeoutMs: S8_LIMITS.timeoutMs, stdoutBytes: S8_LIMITS.stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 };
  const parsedRunner = parseS8RunnerReceipt(response.nativeStdout, nativeLimits, runnerSha256, runnerSha256, { status: 0, signal: null, stderr: response.nativeStderr });
  if (parsedRunner.evidence.result.code !== 0) fail(runnerFailure(parsedRunner.evidence.result.code));
  const receipt = parseWriterReceipt(response.writerReceipt, s8Sha256(payloadBytes), writerSha256, executableSha256, response.artifact, privateExporterSha256, manifestSha256);
  return { artifact: response.artifact, receipt, runnerEvidence: parsedRunner.evidence, stdout: parsedRunner.stdout, stderr: response.nativeStderr.toString("utf8"), nativeStdout: response.nativeStdout, nativeStderr: response.nativeStderr, brokerIdentity: identity, brokerMetadata: response.metadata };
}

function parseNativeReadback(stdout: Buffer): S8UfbxReadback {
  let parsed: unknown;
  try {
    const text = stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(stdout)) fail("S8_NATIVE_READBACK_INVALID");
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail("S8_NATIVE_READBACK_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("S8_NATIVE_READBACK_INVALID");
  const wrapper = parsed as Record<string, unknown>;
  const value = wrapper.readback && typeof wrapper.readback === "object" ? wrapper.readback : parsed;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("S8_NATIVE_READBACK_INVALID");
  const readback = value as S8UfbxReadback;
  if (readback.schemaVersion !== "s8-ufbx-readback-v1" || readback.fbxVersion !== 7400 || !Array.isArray(readback.nodes) || !Array.isArray(readback.materials)) fail("S8_NATIVE_READBACK_INVALID");
  return readback;
}

export function runS8NativeValidator(artifact: Buffer, config: S8WorkerConfig, onHeartbeat?: () => void): S8NativeValidatorResult {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  assertS8SystemRuntimePaths();
  if (!config.nativeValidatorExecutable) fail("S8_NATIVE_VALIDATOR_REQUIRED");
  const validator = assertRegularFile(config.nativeValidatorExecutable, "nativeValidatorExecutable");
  const validatorIdentity = `s8-validator-sha256:${fileSha256(validator)}`;
  assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  if (artifact.length === 0 || artifact.length > 134_217_728) fail("S8_ARTIFACT_RESOURCE_LIMIT");
  onHeartbeat?.();
  const { response, identity } = runS8Broker("VALIDATOR", artifact, config);
  onHeartbeat?.();
  if (response.artifact.length !== 0 || response.writerReceipt.length !== 0 || response.nativeOuterExit !== 0 || response.nativeOuterSignal !== -1) fail("S8_WORKER_OUTPUT_INVALID");
  const runner = runnerPath(config);
  const runnerSha256 = fileSha256(runner.path);
  const nativeLimits: S8RunnerLimits = { addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, fileBytes: S8_LIMITS.validatorTempBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, stdoutBytes: S8_LIMITS.readbackBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 };
  const parsedRunner = parseS8RunnerReceipt(response.nativeStdout, nativeLimits, runnerSha256, runnerSha256, { status: 0, signal: null, stderr: response.nativeStderr });
  if (parsedRunner.evidence.result.code !== 0) fail(runnerFailure(parsedRunner.evidence.result.code));
  const readbackBytes = parsedRunner.stdoutBytes;
  return { readback: parseNativeReadback(readbackBytes), readbackBytes, validatorIdentity, runnerEvidence: parsedRunner.evidence, stdout: parsedRunner.stdout, stderr: response.nativeStderr.toString("utf8"), nativeStdout: response.nativeStdout, nativeStderr: response.nativeStderr, brokerIdentity: identity, brokerMetadata: response.metadata };
}
