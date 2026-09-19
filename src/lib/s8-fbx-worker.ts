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
  schemaVersion: "s8-runner-caller-verification-v1";
  status: "VERIFIED_BY_CALLER";
  preLaunchSha256: string;
  postLaunchSha256: string;
  runnerReportedSelfSha256: string;
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
type RunnerResult = { stdout: string; stderr: string; evidence: S8RunnerEvidence };
type CommandSpec = { command: string; args: string[] };
type SandboxCommand = CommandSpec & { target: CommandSpec };
type RunnerIdentity = { path: string; device: number; inode: number; size: number; mtimeMs: number };

const RUNNER_RECEIPT_PREFIX = "S8_RUNNER_RECEIPT:";
const HEX64 = /^[0-9a-f]{64}$/u;

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

function boundedOutput(value: Buffer | string | null, maximum: number, code: string): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
  if (bytes.length > maximum) fail(code);
  return bytes.toString("utf8");
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

function checkedLimitObject(value: unknown, keys: readonly string[], includeWall: boolean): Record<string, unknown> {
  const record = objectValue(value);
  exactKeys(record, keys);
  checkedNumber(record.rlimitAsBytes, true);
  checkedNumber(record.rlimitFsizeBytes, true);
  checkedNumber(record.rlimitCpuSeconds, true);
  checkedNumber(record.rlimitNproc, true);
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

export function parseS8RunnerReceipt(output: Buffer, expected: S8RunnerLimits, runnerSha256: string, postLaunchSha256 = runnerSha256): { stdout: string; evidence: S8RunnerEvidence } {
  const text = output.toString("utf8");
  const newline = text.indexOf("\n");
  if (!text.startsWith(RUNNER_RECEIPT_PREFIX) || newline <= RUNNER_RECEIPT_PREFIX.length || text.slice(RUNNER_RECEIPT_PREFIX.length, newline).includes("\r")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const receiptText = text.slice(RUNNER_RECEIPT_PREFIX.length, newline);
  const parsed = parseStrictJson(receiptText);
  exactKeys(parsed, ["schemaVersion", "protocol", "policyId", "requested", "appliedByChild", "observedByRunnerParent", "runnerParentVerification", "runnerBinary", "result"]);
  if (parsed.schemaVersion !== S8_PROCESS_RUNNER_PIN.protocol || parsed.protocol !== S8_PROCESS_RUNNER_PIN.protocol || parsed.policyId !== S8_PROCESS_RUNNER_PIN.policy) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const requested = checkedLimitObject(parsed.requested, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "wallTimeoutMs", "stdoutBytes", "stderrBytes", "maxChildren"], true);
  const applied = checkedLimitObject(parsed.appliedByChild, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false);
  const observed = checkedLimitObject(parsed.observedByRunnerParent, ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc", "noNewPrivs", "seccompMode"], false);
  checkedNumber(applied.noNewPrivs, true); checkedNumber(applied.seccompMode, true); checkedNumber(observed.noNewPrivs, true); checkedNumber(observed.seccompMode, true);
  if (applied.noNewPrivs !== 1 || applied.seccompMode !== 2 || observed.noNewPrivs !== 1 || observed.seccompMode !== 2) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  equalFields(requested, expectedRequested(expected));
  for (const key of ["rlimitAsBytes", "rlimitFsizeBytes", "rlimitCpuSeconds", "rlimitNproc"]) if (applied[key] !== requested[key] || observed[key] !== applied[key]) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const verification = objectValue(parsed.runnerParentVerification);
  exactKeys(verification, ["status", "mismatchCode"]);
  if (verification.status !== "PASS" || verification.mismatchCode !== null) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const binary = objectValue(parsed.runnerBinary);
  exactKeys(binary, ["selfSha256"]);
  if (typeof binary.selfSha256 !== "string" || !HEX64.test(binary.selfSha256) || binary.selfSha256 !== runnerSha256 || runnerSha256 !== postLaunchSha256) fail("S8_RUNNER_HASH_DRIFT");
  const result = objectValue(parsed.result);
  exactKeys(result, ["code", "name", "terminationClass", "targetExit", "targetSignal", "elapsedMs", "stdoutBytes", "stderrBytes", "setupStage", "evidenceCode"]);
  checkedNumber(result.code); checkedNumber(result.elapsedMs);
  const stdoutBytes = checkedNumber(result.stdoutBytes);
  const stderrBytes = checkedNumber(result.stderrBytes);
  if (typeof result.name !== "string" || typeof result.terminationClass !== "string" || (result.targetExit !== null && !isNonnegativeInteger(result.targetExit)) || (result.targetSignal !== null && !isPositiveInteger(result.targetSignal)) || (result.setupStage !== null && typeof result.setupStage !== "string") || (result.evidenceCode !== null && typeof result.evidenceCode !== "string")) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  if (stdoutBytes > expected.stdoutBytes || stderrBytes > expected.stderrBytes) fail("S8_PROCESS_RUNNER_EVIDENCE_INVALID");
  const evidence = parsed as unknown as S8RunnerEvidence;
  evidence.verifiedByCaller = {
    schemaVersion: "s8-runner-caller-verification-v1",
    status: "VERIFIED_BY_CALLER",
    preLaunchSha256: runnerSha256,
    postLaunchSha256,
    runnerReportedSelfSha256: binary.selfSha256 as string,
    receiptSha256: s8Sha256(receiptText),
  };
  return { stdout: text.slice(newline + 1), evidence };
}

function makeSandboxCommand(config: S8WorkerConfig, blenderRoot: string, blender: string, writer: string, privateExporter: string, patchManifest: string, work: string): SandboxCommand {
  if (!config.sandboxExecutable) fail("S8_WORKER_SANDBOX_REQUIRED");
  const sandbox = assertRegularFile(config.sandboxExecutable, "sandboxExecutable");
  const blenderRelativePath = relative(blenderRoot, blender);
  if (blenderRelativePath.startsWith("..") || resolve(blenderRoot, blenderRelativePath) !== blender || dirname(blender) !== blenderRoot) fail("S8_WORKER_PATH_INVALID", "blenderExecutable");
  return {
    command: sandbox,
    args: [
      "--unshare-user", "--unshare-net", "--die-with-parent", "--new-session",
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
  const child = spawnSync(executable, childArgs, {
    cwd: options.cwd,
    env: { ...process.env, NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
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
  const parsed = parseS8RunnerReceipt(Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? ""), options, preLaunchSha256, postLaunchSha256);
  const stdout = boundedOutput(parsed.stdout, options.stdoutBytes, "S8_STDOUT_LIMIT");
  const stderr = boundedOutput(child.stderr, options.stderrBytes, "S8_STDERR_LIMIT");
  if (child.status !== 0) fail(runnerFailure(parsed.evidence.result.code));
  return { stdout, stderr, evidence: parsed.evidence };
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
    const sandbox = makeSandboxCommand(config, blenderRoot, blender, writer, privateExporter, patchManifest, work);
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

function parseNativeReadback(stdout: string): S8UfbxReadback {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { fail("S8_NATIVE_READBACK_INVALID"); }
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
  if (!config.nativeValidatorExecutable) fail("S8_NATIVE_VALIDATOR_REQUIRED");
  const validator = assertRegularFile(config.nativeValidatorExecutable, "nativeValidatorExecutable");
  const validatorIdentity = `s8-validator-sha256:${fileSha256(validator)}`;
  const root = assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  const work = mkdtempSync(join(root, "s8-validator-"));
  const artifactPath = join(work, "artifact.fbx");
  writeFileSync(artifactPath, artifact, { mode: 0o600, flag: "wx" });
  try {
    onHeartbeat?.();
    const result = runUnderNativeRunner(validator, [artifactPath], config, { cwd: work, addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, fileBytes: S8_LIMITS.validatorTempBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, stdoutBytes: S8_LIMITS.readbackBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 });
    onHeartbeat?.();
    if (Buffer.byteLength(result.stdout, "utf8") > S8_LIMITS.readbackBytes) fail("S8_NATIVE_READBACK_LIMIT");
    return { readback: parseNativeReadback(result.stdout), readbackBytes: Buffer.from(result.stdout, "utf8"), validatorIdentity, runnerEvidence: result.evidence, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
