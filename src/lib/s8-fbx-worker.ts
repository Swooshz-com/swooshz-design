import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

export type S8WriterResult = { artifact: Buffer; receipt: S8WriterReceipt; runnerEvidence: S8RunnerEvidence; stdout: string; stderr: string };

export type S8NativeValidatorResult = {
  readback: S8UfbxReadback;
  readbackBytes: Buffer;
  validatorIdentity?: string;
  runnerEvidence?: S8RunnerEvidence;
  stdout: string;
  stderr: string;
};

type RunnerOptions = { cwd: string } & S8RunnerLimits;
type RunnerResult = { stdout: string; stdoutBytes: Buffer; stderr: string; evidence: S8RunnerEvidence };
type CommandSpec = { command: string; args: string[] };
export type S8SandboxCommand = CommandSpec & { target: CommandSpec };
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
      if (!statSync(path).isFile()) fail("S8_TOOLING_HOLD_RUNTIME_ALLOWLIST", "runtime");
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
  const info = statSync(absolute);
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

function runnerArgs(options: RunnerOptions, command: string, args: readonly string[]): string[] {
  return [
    "--address-space-bytes", String(options.addressSpaceBytes),
    "--file-bytes", String(options.fileBytes),
    "--timeout-ms", String(options.timeoutMs),
    "--stdout-bytes", String(options.stdoutBytes),
    "--stderr-bytes", String(options.stderrBytes),
    "--max-children", String(options.maxChildren ?? 0),
    "--", command, ...args,
  ];
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

type S8RunnerReceiptDiagnostic = { exactFailedInvariant: string | null };

function markRunnerReceiptInvariant(diagnostic: S8RunnerReceiptDiagnostic | undefined, invariant: string): void {
  if (diagnostic) diagnostic.exactFailedInvariant = invariant;
}

function diagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function diagnosticNumber(value: unknown): string {
  if (value === null) return "null";
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "UNAVAILABLE";
}

function diagnosticBoolean(value: boolean | null): string {
  return value === null ? "UNAVAILABLE" : value ? "YES" : "NO";
}

function diagnosticSymbol(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : "UNAVAILABLE";
}

function diagnosticNullableSymbol(value: unknown, pattern: RegExp): string {
  return value === null ? "null" : diagnosticSymbol(value, pattern);
}

function diagnosticByteMarkerCount(output: Buffer, prefix: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset <= output.length - prefix.length) {
    const found = output.indexOf(prefix, offset);
    if (found === -1) break;
    count += 1;
    offset = found + prefix.length;
  }
  return count;
}

function runnerEvidenceDiagnosticBlock(
  output: Buffer,
  expected: S8RunnerLimits,
  runnerSha256: string,
  postLaunchSha256: string,
  capture: RunnerCapture,
  diagnostic: S8RunnerReceiptDiagnostic,
): string {
  const prefix = Buffer.from(RUNNER_RECEIPT_PREFIX, "ascii");
  const prefixAtOffsetZero = output.subarray(0, prefix.length).equals(prefix);
  const newline = output.indexOf(0x0a, prefix.length);
  const receiptLineBytes = prefixAtOffsetZero && newline >= prefix.length ? output.subarray(prefix.length, newline) : null;
  let parsed: Record<string, unknown> | null = null;
  let strictJsonParseOk = false;
  if (receiptLineBytes && !receiptLineBytes.includes(0x0d) && !receiptLineBytes.some((byte) => byte > 0x7f)) {
    try {
      parsed = parseStrictJson(receiptLineBytes.toString("ascii"));
      strictJsonParseOk = true;
    } catch {
      // Diagnostic only. The production parser remains the authority.
    }
  }
  const requested = diagnosticRecord(parsed?.requested);
  const applied = diagnosticRecord(parsed?.appliedByChild);
  const observed = diagnosticRecord(parsed?.observedByRunnerParent);
  const parentVerification = diagnosticRecord(parsed?.runnerParentVerification);
  const runnerBinary = diagnosticRecord(parsed?.runnerBinary);
  const result = diagnosticRecord(parsed?.result);
  const expectedFields = expectedRequested(expected);
  const captureStderrBytes = Buffer.isBuffer(capture.stderr) ? capture.stderr.length : 0;
  const observedTargetStdoutBytes = prefixAtOffsetZero && newline > prefix.length ? output.length - newline - 1 : null;
  let canonicalReceiptBytesEqual: boolean | null = null;
  if (parsed && receiptLineBytes) {
    try {
      canonicalReceiptBytesEqual = canonicalS8RunnerReceiptBytes(parsed as unknown as S8RunnerEvidence).equals(receiptLineBytes);
    } catch {
      canonicalReceiptBytesEqual = null;
    }
  }
  const runnerReportedSelfSha256 = diagnosticSymbol(runnerBinary?.selfSha256, /^[A-Fa-f0-9]{64}$/);
  const runnerHashMatch = runnerReportedSelfSha256 !== "UNAVAILABLE"
    && runnerReportedSelfSha256 === runnerSha256
    && runnerSha256 === postLaunchSha256;
  const actualCode = result?.code;
  const targetStdoutCountMatch = typeof result?.stdoutBytes === "number" && Number.isSafeInteger(result.stdoutBytes) && observedTargetStdoutBytes !== null
    ? result.stdoutBytes === observedTargetStdoutBytes
    : null;
  const outerStderrCountMatch = typeof result?.stderrBytes === "number" && Number.isSafeInteger(result.stderrBytes)
    ? result.stderrBytes === captureStderrBytes
    : null;
  const requestedNames: ReadonlyArray<readonly [string, string]> = [
    ["RLIMIT_AS", "rlimitAsBytes"],
    ["RLIMIT_FSIZE", "rlimitFsizeBytes"],
    ["RLIMIT_CPU", "rlimitCpuSeconds"],
    ["RLIMIT_NPROC", "rlimitNproc"],
    ["WALL_TIMEOUT_MS", "wallTimeoutMs"],
    ["STDOUT_BYTES", "stdoutBytes"],
    ["STDERR_BYTES", "stderrBytes"],
    ["MAX_CHILDREN", "maxChildren"],
  ];
  const appliedNames: ReadonlyArray<readonly [string, string]> = [
    ["RLIMIT_AS", "rlimitAsBytes"],
    ["RLIMIT_FSIZE", "rlimitFsizeBytes"],
    ["RLIMIT_CPU", "rlimitCpuSeconds"],
    ["RLIMIT_NPROC", "rlimitNproc"],
    ["NO_NEW_PRIVS", "noNewPrivs"],
    ["SECCOMP_MODE", "seccompMode"],
  ];
  const lines = [
    "S8_G0_RUNNER_EVIDENCE_DIAGNOSTIC_BEGIN",
    "OUTER_EXIT_STATUS=" + diagnosticNumber(capture.status),
    "OUTER_SIGNAL=" + diagnosticNullableSymbol(capture.signal, /^SIG[A-Z0-9]{1,12}$/),
    "OUTER_STDOUT_BYTES=" + output.length,
    "OUTER_STDERR_BYTES=" + captureStderrBytes,
    "RECEIPT_PREFIX_AT_OFFSET_ZERO=" + diagnosticBoolean(prefixAtOffsetZero),
    "RECEIPT_MARKER_COUNT=" + diagnosticByteMarkerCount(output, prefix),
    "RECEIPT_LINE_BYTES=" + (receiptLineBytes === null ? "UNAVAILABLE" : receiptLineBytes.length),
    "STRICT_JSON_PARSE_OK=" + diagnosticBoolean(strictJsonParseOk),
    "CANONICAL_RECEIPT_BYTES_EQUAL=" + diagnosticBoolean(canonicalReceiptBytesEqual),
    "SCHEMA_MATCH=" + diagnosticBoolean(parsed ? parsed.schemaVersion === S8_PROCESS_RUNNER_PIN.protocol : null),
    "PROTOCOL_MATCH=" + diagnosticBoolean(parsed ? parsed.protocol === S8_PROCESS_RUNNER_PIN.protocol : null),
    "POLICY_MATCH=" + diagnosticBoolean(parsed ? parsed.policyId === S8_PROCESS_RUNNER_PIN.policy : null),
  ];
  for (const [label, key] of requestedNames) {
    lines.push("REQUESTED_" + label + "=" + diagnosticNumber(requested?.[key]));
    lines.push("EXPECTED_" + label + "=" + diagnosticNumber(expectedFields[key]));
  }
  for (const [label, key] of appliedNames) {
    lines.push("APPLIED_" + label + "=" + diagnosticNumber(applied?.[key]));
    lines.push("OBSERVED_" + label + "=" + diagnosticNumber(observed?.[key]));
  }
  lines.push(
    "PARENT_VERIFICATION_STATUS=" + (parentVerification?.status === "PASS" || parentVerification?.status === "FAIL" ? parentVerification.status : "UNAVAILABLE"),
    "PARENT_VERIFICATION_MISMATCH_CODE=" + diagnosticNullableSymbol(parentVerification?.mismatchCode, /^[A-Z0-9_]{1,64}$/),
    "RUNNER_REPORTED_SELF_SHA256=" + runnerReportedSelfSha256,
    "PRE_LAUNCH_SHA256=" + diagnosticSymbol(runnerSha256, /^[A-Fa-f0-9]{64}$/),
    "POST_LAUNCH_SHA256=" + diagnosticSymbol(postLaunchSha256, /^[A-Fa-f0-9]{64}$/),
    "RUNNER_HASH_MATCH=" + diagnosticBoolean(runnerHashMatch),
    "RESULT_CODE=" + diagnosticNumber(actualCode),
    "RESULT_NAME=" + diagnosticSymbol(result?.name, /^[A-Z0-9_]{1,64}$/),
    "RESULT_TERMINATION_CLASS=" + diagnosticSymbol(result?.terminationClass, /^[a-z0-9-]{1,48}$/),
    "RESULT_TARGET_EXIT=" + diagnosticNumber(result?.targetExit),
    "RESULT_TARGET_SIGNAL=" + diagnosticNumber(result?.targetSignal),
    "RESULT_SETUP_STAGE=" + diagnosticNullableSymbol(result?.setupStage, /^[a-z][a-z0-9_]{0,47}$/),
    "RESULT_EVIDENCE_CODE=" + diagnosticNullableSymbol(result?.evidenceCode, /^[A-Z0-9_]{1,64}$/),
    "RESULT_STDOUT_BYTES=" + diagnosticNumber(result?.stdoutBytes),
    "RESULT_STDERR_BYTES=" + diagnosticNumber(result?.stderrBytes),
    "OBSERVED_TARGET_STDOUT_BYTES=" + (observedTargetStdoutBytes === null ? "UNAVAILABLE" : observedTargetStdoutBytes),
    "OBSERVED_OUTER_STDERR_BYTES=" + captureStderrBytes,
    "OUTER_STATUS_EQUALS_RESULT_CODE=" + diagnosticBoolean(typeof capture.status === "number" && typeof actualCode === "number" && Number.isSafeInteger(actualCode) ? capture.status === actualCode : null),
    "TARGET_STDOUT_COUNT_MATCH=" + diagnosticBoolean(targetStdoutCountMatch),
    "OUTER_STDERR_COUNT_MATCH=" + diagnosticBoolean(outerStderrCountMatch),
    "EXACT_FAILED_INVARIANT=" + diagnosticSymbol(diagnostic.exactFailedInvariant ?? "UNCLASSIFIED", /^[A-Z0-9_]{1,64}$/),
    "S8_G0_RUNNER_EVIDENCE_DIAGNOSTIC_END",
  );
  return lines.join("\n");
}

function equalFields(record: Record<string, unknown>, expected: Record<string, number>, onMismatch?: (key: string) => void): void {
  for (const [key, value] of Object.entries(expected)) if (record[key] !== value) {
    onMismatch?.(key);
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
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
  diagnostic?: S8RunnerReceiptDiagnostic,
): { stdout: string; stdoutBytes: Buffer; evidence: S8RunnerEvidence } {
  const prefix = Buffer.from(RUNNER_RECEIPT_PREFIX, "ascii");
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_PREFIX_AT_OFFSET_ZERO");
  if (!output.subarray(0, prefix.length).equals(prefix)) {
    if (capture.status === 64 && capture.signal === null && output.indexOf(prefix) === -1) fail("S8_PROCESS_RUNNER_ARGUMENT_INVALID");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_MARKER_COUNT");
  if (output.indexOf(prefix, prefix.length) !== -1) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_LINE_FRAME");
  const newline = output.indexOf(0x0a, prefix.length);
  if (newline <= prefix.length) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const receiptBytes = output.subarray(prefix.length, newline);
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_LINE_ENCODING");
  if (receiptBytes.includes(0x0d) || receiptBytes.some((byte) => byte > 0x7f)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const receiptText = receiptBytes.toString("ascii");
  markRunnerReceiptInvariant(diagnostic, "STRICT_JSON_PARSE");
  const parsed = parseStrictJson(receiptText);
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_SCHEMA_KEYS");
  exactKeys(parsed, ["schemaVersion", "protocol", "policyId", "requested", "appliedByChild", "observedByRunnerParent", "runnerParentVerification", "runnerBinary", "result"]);
  if (parsed.schemaVersion !== S8_PROCESS_RUNNER_PIN.protocol) {
    markRunnerReceiptInvariant(diagnostic, "SCHEMA_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (parsed.protocol !== S8_PROCESS_RUNNER_PIN.protocol) {
    markRunnerReceiptInvariant(diagnostic, "PROTOCOL_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (parsed.policyId !== S8_PROCESS_RUNNER_PIN.policy) {
    markRunnerReceiptInvariant(diagnostic, "POLICY_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  markRunnerReceiptInvariant(diagnostic, "RESULT_OBJECT_SHAPE");
  const resultRecord = objectValue(parsed.result);
  markRunnerReceiptInvariant(diagnostic, "RESULT_CODE_INVALID");
  const resultCode = checkedNumber(resultRecord.code);
  const setupFailure = resultCode === 71;
  markRunnerReceiptInvariant(diagnostic, "REQUESTED_LIMIT_SHAPE_OR_VALUE");
  const requested = checkedLimitObject(parsed.requested, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "wallTimeoutMs", "stdoutBytes", "stderrBytes", "maxChildren"], true);
  markRunnerReceiptInvariant(diagnostic, "APPLIED_LIMIT_SHAPE_OR_VALUE");
  const applied = checkedLimitObject(parsed.appliedByChild, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false, setupFailure);
  markRunnerReceiptInvariant(diagnostic, "OBSERVED_LIMIT_SHAPE_OR_VALUE");
  const observed = checkedLimitObject(parsed.observedByRunnerParent, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false, setupFailure);
  if (setupFailure) {
    // Native code 71 emits a zeroed setup record before releasing the target.
    markRunnerReceiptInvariant(diagnostic, "SETUP_LIMITS_NOT_ZERO");
    if ([applied.rlimitAsBytes, applied.rlimitFsizeBytes, applied.rlimitCpuSeconds, applied.rlimitNproc, applied.noNewPrivs, applied.seccompMode, observed.rlimitAsBytes, observed.rlimitFsizeBytes, observed.rlimitCpuSeconds, observed.rlimitNproc, observed.noNewPrivs, observed.seccompMode].some((value) => value !== 0)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else {
    markRunnerReceiptInvariant(diagnostic, "APPLIED_OBSERVED_SECURITY_FIELDS_INVALID");
    checkedNumber(applied.noNewPrivs, true); checkedNumber(applied.seccompMode, true); checkedNumber(observed.noNewPrivs, true); checkedNumber(observed.seccompMode, true);
    if (applied.noNewPrivs !== 1) {
      markRunnerReceiptInvariant(diagnostic, "APPLIED_NO_NEW_PRIVS_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
    if (applied.seccompMode !== 2) {
      markRunnerReceiptInvariant(diagnostic, "APPLIED_SECCOMP_MODE_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
    if (observed.noNewPrivs !== 1) {
      markRunnerReceiptInvariant(diagnostic, "OBSERVED_NO_NEW_PRIVS_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
    if (observed.seccompMode !== 2) {
      markRunnerReceiptInvariant(diagnostic, "OBSERVED_SECCOMP_MODE_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  markRunnerReceiptInvariant(diagnostic, "REQUESTED_LIMIT_MISMATCH");
  equalFields(requested, expectedRequested(expected), () => markRunnerReceiptInvariant(diagnostic, "REQUESTED_LIMIT_MISMATCH"));
  if (!setupFailure) for (const key of ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc"]) {
    if (applied[key] !== requested[key]) {
      markRunnerReceiptInvariant(diagnostic, "APPLIED_LIMIT_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
    if (observed[key] !== applied[key]) {
      markRunnerReceiptInvariant(diagnostic, "OBSERVED_LIMIT_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  markRunnerReceiptInvariant(diagnostic, "PARENT_VERIFICATION_OBJECT_SHAPE");
  const verification = objectValue(parsed.runnerParentVerification);
  markRunnerReceiptInvariant(diagnostic, "PARENT_VERIFICATION_KEYS");
  exactKeys(verification, ["status", "mismatchCode"]);
  markRunnerReceiptInvariant(diagnostic, "PARENT_VERIFICATION_STATUS_OR_CODE_INVALID");
  if ((verification.status !== "PASS" && verification.status !== "FAIL") || (verification.mismatchCode !== null && typeof verification.mismatchCode !== "string")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  markRunnerReceiptInvariant(diagnostic, "RUNNER_BINARY_OBJECT_SHAPE");
  const binary = objectValue(parsed.runnerBinary);
  markRunnerReceiptInvariant(diagnostic, "RUNNER_BINARY_KEYS");
  exactKeys(binary, ["selfSha256"]);
  if (typeof binary.selfSha256 !== "string" || !HEX64.test(binary.selfSha256) || binary.selfSha256 !== runnerSha256 || runnerSha256 !== postLaunchSha256) fail("S8_RUNNER_HASH_DRIFT");
  markRunnerReceiptInvariant(diagnostic, "RESULT_OBJECT_SHAPE");
  const result = objectValue(parsed.result);
  markRunnerReceiptInvariant(diagnostic, "RESULT_KEYS");
  exactKeys(result, ["code", "name", "terminationClass", "targetExit", "targetSignal", "elapsedMs", "stdoutBytes", "stderrBytes", "setupStage", "evidenceCode"]);
  markRunnerReceiptInvariant(diagnostic, "RECEIPT_CANONICAL_BYTES_MISMATCH");
  if (!canonicalS8RunnerReceiptBytes(parsed as unknown as S8RunnerEvidence).equals(receiptBytes)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const code = resultCode;
  markRunnerReceiptInvariant(diagnostic, "RESULT_ELAPSED_TIME_INVALID");
  checkedNumber(result.elapsedMs);
  markRunnerReceiptInvariant(diagnostic, "RESULT_STDOUT_BYTE_COUNT_INVALID");
  const stdoutBytes = checkedNumber(result.stdoutBytes);
  markRunnerReceiptInvariant(diagnostic, "RESULT_STDERR_BYTE_COUNT_INVALID");
  const stderrBytes = checkedNumber(result.stderrBytes);
  markRunnerReceiptInvariant(diagnostic, "RESULT_FIELDS_INVALID");
  if (typeof result.name !== "string" || typeof result.terminationClass !== "string" || (result.targetExit !== null && !isNonnegativeInteger(result.targetExit)) || (result.targetSignal !== null && !isPositiveInteger(result.targetSignal)) || (result.setupStage !== null && typeof result.setupStage !== "string") || (result.evidenceCode !== null && typeof result.evidenceCode !== "string")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  markRunnerReceiptInvariant(diagnostic, "RESULT_BYTE_COUNT_LIMIT_EXCEEDED");
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
  markRunnerReceiptInvariant(diagnostic, "RESULT_MAPPING_MISMATCH");
  if (!contract || result.name !== contract[0] || result.terminationClass !== contract[1]) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const noTargetTermination = result.targetExit === null && result.targetSignal === null;
  if (code === 0) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_SUCCESS_TERMINATION_MISMATCH");
    if (result.targetExit !== 0 || result.targetSignal !== null || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 70) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_INTERNAL_TERMINATION_MISMATCH");
    if (!noTargetTermination || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 71) {
    const setupStages = new Set(["setpgid", "pdeathsig", "parent_check", "rlimit_as", "rlimit_fsize", "rlimit_cpu", "rlimit_nproc", "no_new_privs", "seccomp", "child_evidence", "release"]);
    markRunnerReceiptInvariant(diagnostic, "RESULT_SETUP_FAILURE_MAPPING_MISMATCH");
    if (!noTargetTermination || typeof result.setupStage !== "string" || !setupStages.has(result.setupStage) || result.evidenceCode !== null || verification.status !== "FAIL" || verification.mismatchCode !== null || result.stdoutBytes !== 0 || result.stderrBytes !== 0) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 72) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_EVIDENCE_FAILURE_MAPPING_MISMATCH");
    if (!noTargetTermination || result.setupStage !== null || typeof result.evidenceCode !== "string" || result.evidenceCode.length === 0 || verification.mismatchCode !== result.evidenceCode) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 76) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_TARGET_EXIT_MAPPING_MISMATCH");
    if (result.targetExit === null || result.targetExit === 0 || result.targetExit > 255 || result.targetSignal !== null || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (code === 77) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_TARGET_SIGNAL_MAPPING_MISMATCH");
    if (result.targetExit !== null || result.targetSignal === null || result.targetSignal > 64 || result.setupStage !== null || result.evidenceCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  } else if (!noTargetTermination || result.setupStage !== null || result.evidenceCode !== null) {
    markRunnerReceiptInvariant(diagnostic, "RESULT_TERMINATION_MAPPING_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (code === 70) {
    const verifiedInternalMismatchCodes = new Set(["CAPTURE_INIT", "EXEC_CHANNEL", "POLL", "STDOUT_READ", "STDERR_READ", "WAITPID", "INTERNAL"]);
    if (verification.status === "FAIL") {
      markRunnerReceiptInvariant(diagnostic, "PARENT_INTERNAL_VERIFICATION_MISMATCH");
      if (verification.mismatchCode !== "PARENT_SETPGID") fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    } else if (verification.mismatchCode !== null && (typeof verification.mismatchCode !== "string" || !verifiedInternalMismatchCodes.has(verification.mismatchCode))) {
      markRunnerReceiptInvariant(diagnostic, "PARENT_INTERNAL_MISMATCH_CODE_INVALID");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  if (code === 72) {
    const evidenceMismatchCodes = new Set([
      "CHILD_EVIDENCE_MALFORMED", "PARENT_PRLIMIT_AS", "PARENT_PRLIMIT_FSIZE", "PARENT_PRLIMIT_CPU", "PARENT_PRLIMIT_NPROC",
      "PARENT_PROC_STATUS", "PARENT_PROC_SECURITY", "REQUESTED_APPLIED_OBSERVED", "RELEASE_CHANNEL",
    ]);
    markRunnerReceiptInvariant(diagnostic, "RESULT_EVIDENCE_CODE_INVALID");
    if (typeof result.evidenceCode !== "string" || !evidenceMismatchCodes.has(result.evidenceCode)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    if (result.evidenceCode === "RELEASE_CHANNEL") {
      markRunnerReceiptInvariant(diagnostic, "PARENT_RELEASE_CHANNEL_STATUS_MISMATCH");
      if (verification.status !== "PASS") fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    } else if (verification.status !== "FAIL") {
      markRunnerReceiptInvariant(diagnostic, "PARENT_EVIDENCE_STATUS_MISMATCH");
      fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
    }
  }
  markRunnerReceiptInvariant(diagnostic, "PARENT_VERIFICATION_RESULT_MAPPING_MISMATCH");
  if (code !== 70 && code !== 71 && code !== 72 && (verification.status !== "PASS" || verification.mismatchCode !== null)) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");

  const targetStdout = output.subarray(newline + 1);
  const capturedStderr = Buffer.isBuffer(capture.stderr) ? capture.stderr : Buffer.alloc(0);
  if (capture.signal !== null) {
    markRunnerReceiptInvariant(diagnostic, "OUTER_SIGNAL_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (capture.status !== code) {
    markRunnerReceiptInvariant(diagnostic, "OUTER_STATUS_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (stdoutBytes !== targetStdout.length) {
    markRunnerReceiptInvariant(diagnostic, "TARGET_STDOUT_BYTE_COUNT_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
  if (stderrBytes !== capturedStderr.length) {
    markRunnerReceiptInvariant(diagnostic, "OUTER_STDERR_BYTE_COUNT_MISMATCH");
    fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  }
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

export function buildS8BlenderSandboxCommand(config: S8WorkerConfig, blenderRoot: string, blender: string, writer: string, privateExporter: string, patchManifest: string, work: string): S8SandboxCommand {
  if (!config.sandboxExecutable) fail("S8_WORKER_SANDBOX_REQUIRED");
  const sandbox = assertRegularFile(config.sandboxExecutable, "sandboxExecutable");
  const blenderRelativePath = relative(blenderRoot, blender);
  if (blenderRelativePath.startsWith("..") || resolve(blenderRoot, blenderRelativePath) !== blender || dirname(blender) !== blenderRoot) fail("S8_WORKER_PATH_INVALID", "blenderExecutable");
  return {
    command: sandbox,
    args: [
      "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--disable-userns", "--assert-userns-disabled", "--uid", "65534", "--gid", "65534", "--cap-drop", "ALL",
      "--die-with-parent", "--new-session", "--clearenv",
      ...S8_SYSTEM_RUNTIME_BIND_PATHS.flatMap((path) => ["--ro-bind", path, path]),
      "--ro-bind", blenderRoot, "/runtime/blender-root",
      "--ro-bind", writer, "/runtime/writer.py",
      "--ro-bind", privateExporter, "/runtime/export_fbx_bin.py",
      "--ro-bind", patchManifest, "/runtime/patch-manifest.json",
      "--bind", work, "/work", "--chdir", "/work",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ],
    target: {
      command: `/runtime/blender-root/${blenderRelativePath.replaceAll("\\", "/")}`,
      args: ["--background", "--factory-startup", "--disable-autoexec", "--offline-mode", "--python-exit-code", "50", "--python", "/runtime/writer.py", "--"],
    },
  };
}

export function buildS8ValidatorSandboxCommand(config: S8WorkerConfig, validator: string, work: string): S8SandboxCommand {
  if (!config.sandboxExecutable) fail("S8_WORKER_SANDBOX_REQUIRED");
  const sandbox = assertRegularFile(config.sandboxExecutable, "sandboxExecutable");
  return {
    command: sandbox,
    args: [
      "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--disable-userns", "--assert-userns-disabled", "--uid", "65534", "--gid", "65534", "--cap-drop", "ALL",
      "--die-with-parent", "--new-session", "--clearenv",
      ...S8_SYSTEM_RUNTIME_BIND_PATHS.flatMap((path) => ["--ro-bind", path, path]),
      "--ro-bind", validator, "/runtime/validator",
      "--bind", work, "/work", "--chdir", "/work",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ],
    target: { command: "/runtime/validator", args: ["/work/artifact.fbx"] },
  };
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

function runUnderNativeRunner(command: string, args: readonly string[], config: S8WorkerConfig, options: RunnerOptions, sandbox?: CommandSpec): RunnerResult {
  const before = runnerPath(config);
  const preLaunchSha256 = fileSha256(before.path);
  const expected = runnerArgs(options, command, args);
  const executable = sandbox?.command ?? before.path;
  const childArgs = sandbox ? [...sandbox.args, "--ro-bind", before.path, "/runtime/process-runner", "/runtime/process-runner", ...expected] : expected;
  const emptyEnvironment = Object.create(null) as NodeJS.ProcessEnv;
  const child = spawnSync(executable, childArgs, {
    cwd: options.cwd,
    env: emptyEnvironment,
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs + 10_000,
    maxBuffer: Math.max(options.stdoutBytes, options.stderrBytes) + 2 * 1024 * 1024,
    encoding: null,
    killSignal: "SIGKILL",
  });
  if (child.error) {
    const errorCode = "code" in child.error ? child.error.code : undefined;
    fail(errorCode === "ETIMEDOUT" ? "S8_PROCESS_RUNNER_TIMEOUT" : "S8_PROCESS_RUNNER_FAILED");
  }
  const after = runnerIdentity(before.path);
  if (!sameRunnerIdentity(before, after)) fail("S8_RUNNER_IDENTITY_DRIFT");
  const postLaunchSha256 = fileSha256(after.path);
  const stderrBytes = Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(child.stderr ?? "");
  const stdoutBytes = Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? "");
  const capture = { status: child.status, signal: child.signal, stderr: stderrBytes };
  const diagnostic: S8RunnerReceiptDiagnostic = { exactFailedInvariant: null };
  let parsed: ReturnType<typeof parseS8RunnerReceipt>;
  try {
    parsed = parseS8RunnerReceipt(stdoutBytes, options, preLaunchSha256, postLaunchSha256, capture, diagnostic);
  } catch (error) {
    if (error instanceof AppError && error.code === "S8_PROCESS_RUNNER_EVIDENCE_INVALID") {
      try {
        process.stderr.write(runnerEvidenceDiagnosticBlock(stdoutBytes, options, preLaunchSha256, postLaunchSha256, capture, diagnostic) + "\n");
      } catch {
        // Preserve the original parser failure if diagnostic output is unavailable.
      }
    }
    throw error;
  }
  if (child.status !== 0) fail(runnerFailure(parsed.evidence.result.code));
  return { stdout: parsed.stdout, stdoutBytes: parsed.stdoutBytes, stderr: stderrBytes.toString("utf8"), evidence: parsed.evidence };
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
  const blenderRoot = assertDirectory(config.blenderRuntimeRoot, "blenderRuntimeRoot");
  const blender = assertRegularFile(config.blenderExecutable, "blenderExecutable");
  const writer = assertRegularFile(config.writerScript, "writerScript");
  const privateExporter = assertRegularFile(join(dirname(writer), "export_fbx_bin.py"), "privateExporter");
  const patchManifest = assertRegularFile(join(dirname(writer), "patch-manifest.json"), "patchManifest");
  const executableSha256 = fileSha256(blender);
  if (executableSha256 !== config.blenderExecutableSha256) fail("S8_BLENDER_EXECUTABLE_DIGEST_MISMATCH");
  const writerSha256 = fileSha256(writer);
  const privateExporterSha256 = fileSha256(privateExporter);
  const manifestSha256 = fileSha256(patchManifest);
  const root = assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  const work = resolve(root, `s8-${randomUUID()}`);
  if (!work.startsWith(`${root}/`) && !work.startsWith(`${root}\\`)) fail("S8_WORKER_PATH_INVALID");
  mkdirSync(work, { mode: 0o700 });
  mkdirSync(join(work, "config"), { mode: 0o700 });
  writeFileSync(join(work, "input.json"), payloadBytes, { mode: 0o600, flag: "wx" });
  try {
    onHeartbeat?.();
    const sandbox = buildS8BlenderSandboxCommand(config, blenderRoot, blender, writer, privateExporter, patchManifest, work);
    const result = runUnderNativeRunner(sandbox.target.command, [...sandbox.target.args, ...[]], config, { cwd: work, addressSpaceBytes: S8_LIMITS.writerAddressSpaceBytes, fileBytes: S8_LIMITS.artifactBytes, timeoutMs: S8_LIMITS.timeoutMs, stdoutBytes: S8_LIMITS.stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 }, sandbox);
    onHeartbeat?.();
    const artifactPath = join(work, "artifact.fbx");
    const receiptPath = join(work, "writer-receipt.json");
    const artifactInfo = lstatSync(artifactPath);
    const receiptInfo = lstatSync(receiptPath);
    if (artifactInfo.isSymbolicLink() || receiptInfo.isSymbolicLink() || !artifactInfo.isFile() || !receiptInfo.isFile()) fail("S8_WORKER_OUTPUT_INVALID");
    if (artifactInfo.size <= 27 || artifactInfo.size > S8_LIMITS.artifactBytes) fail("S8_ARTIFACT_RESOURCE_LIMIT");
    const artifact = readFileSync(artifactPath);
    const receipt = parseWriterReceipt(readFileSync(receiptPath), s8Sha256(payloadBytes), writerSha256, executableSha256, artifact, privateExporterSha256, manifestSha256);
    return { artifact, receipt, runnerEvidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
  const root = assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  const work = mkdtempSync(join(root, "s8-validator-"));
  const artifactPath = join(work, "artifact.fbx");
  writeFileSync(artifactPath, artifact, { mode: 0o600, flag: "wx" });
  try {
    onHeartbeat?.();
    const sandbox = buildS8ValidatorSandboxCommand(config, validator, work);
    const result = runUnderNativeRunner(sandbox.target.command, sandbox.target.args, config, { cwd: work, addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, fileBytes: S8_LIMITS.validatorTempBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, stdoutBytes: S8_LIMITS.readbackBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 }, sandbox);
    onHeartbeat?.();
    return { readback: parseNativeReadback(result.stdoutBytes), readbackBytes: result.stdoutBytes, validatorIdentity, runnerEvidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
