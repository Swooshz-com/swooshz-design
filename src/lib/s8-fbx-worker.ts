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
  /** Native Linux process runner. There is no spawnSync/maxBuffer production fallback. */
  processRunnerExecutable?: string;
  /** Optional bwrap-style filesystem/network sandbox, executed under the native runner. */
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

export type S8WriterResult = { artifact: Buffer; receipt: S8WriterReceipt; stdout: string; stderr: string };

export type S8NativeValidatorResult = {
  readback: S8UfbxReadback;
  readbackBytes: Buffer;
  validatorIdentity: string;
  runnerIdentity: string;
  appliedLimits: Record<string, number | string>;
  stdout: string;
  stderr: string;
};

type RunnerOptions = {
  cwd: string;
  addressSpaceBytes: number;
  fileBytes: number;
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
};

function fail(code: string, field = "worker"): never {
  throw new AppError(502, code, [{ field, code }]);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path: string, field: string): string {
  let absolute: string;
  let original: ReturnType<typeof lstatSync>;
  try {
    original = lstatSync(path);
    absolute = realpathSync(path);
  } catch { fail("S8_WORKER_PATH_INVALID", field); }
  if (original.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  return absolute;
}

function assertDirectory(path: string, field: string): string {
  let absolute: string;
  let original: ReturnType<typeof lstatSync>;
  try {
    original = lstatSync(path);
    absolute = realpathSync(path);
  } catch { fail("S8_WORKER_PATH_INVALID", field); }
  if (original.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  return absolute;
}

function boundedOutput(value: Buffer | string | null, maximum: number, code: string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
  if (buffer.length > maximum) fail(code);
  return buffer.toString("utf8");
}

function runnerPath(config: S8WorkerConfig): string {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  if (!config.processRunnerExecutable) fail("S8_PROCESS_RUNNER_REQUIRED");
  return assertRegularFile(config.processRunnerExecutable, "processRunnerExecutable");
}

function runUnderNativeRunner(command: string, args: readonly string[], config: S8WorkerConfig, options: RunnerOptions): { stdout: string; stderr: string } {
  const runner = runnerPath(config);
  const child = spawnSync(runner, [
    "--address-space-bytes", String(options.addressSpaceBytes),
    "--file-bytes", String(options.fileBytes),
    "--timeout-ms", String(options.timeoutMs),
    "--stdout-bytes", String(options.stdoutBytes),
    "--stderr-bytes", String(options.stderrBytes),
    "--max-children", "0",
    "--", command, ...args,
  ], {
    cwd: options.cwd,
    env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    shell: false,
    windowsHide: true,
    // This is only a transport guard around the runner itself. Resource enforcement
    // is owned by the native runner, never by Node's timeout/maxBuffer options.
    timeout: options.timeoutMs + 10_000,
    encoding: null,
    killSignal: "SIGKILL",
  });
  const stdout = boundedOutput(child.stdout, options.stdoutBytes, "S8_STDOUT_LIMIT");
  const stderr = boundedOutput(child.stderr, options.stderrBytes, "S8_STDERR_LIMIT");
  if (child.error) {
    const errorCode = "code" in child.error ? child.error.code : undefined;
    fail(errorCode === "ETIMEDOUT" ? "S8_PROCESS_RUNNER_TIMEOUT" : "S8_PROCESS_RUNNER_FAILED");
  }
  if (child.signal || child.status !== 0) fail(child.status === 124 ? "S8_PROCESS_RUNNER_TIMEOUT" : "S8_WORKER_FAILED");
  return { stdout, stderr };
}

function parseReceipt(bytes: Buffer, payloadSha256: string, writerSha256: string, executableSha256: string, artifact: Buffer, privateExporterSha256: string, manifestSha256: string): S8WriterReceipt {
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

function makeSandboxCommand(config: S8WorkerConfig, blenderRoot: string, blender: string, writer: string, privateExporter: string, patchManifest: string, work: string): { command: string; args: string[] } {
  if (!config.sandboxExecutable) fail("S8_WORKER_SANDBOX_REQUIRED");
  const sandbox = assertRegularFile(config.sandboxExecutable, "sandboxExecutable");
  const blenderRelativePath = relative(blenderRoot, blender);
  if (blenderRelativePath.startsWith("..") || resolve(blenderRoot, blenderRelativePath) !== blender || dirname(blender) !== blenderRoot) fail("S8_WORKER_PATH_INVALID", "blenderExecutable");
  return {
    command: sandbox,
    args: [
      "--unshare-net", "--die-with-parent", "--new-session",
      "--ro-bind", blenderRoot, "/runtime/blender-root",
      "--ro-bind", writer, "/runtime/writer.py",
      "--ro-bind", privateExporter, "/runtime/export_fbx_bin.py",
      "--ro-bind", patchManifest, "/runtime/patch-manifest.json",
      "--bind", work, "/work", "--chdir", "/work",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      `/runtime/blender-root/${blenderRelativePath.replaceAll("\\", "/")}`,
      "--background", "--factory-startup", "--disable-autoexec", "--offline-mode",
      "--python-exit-code", "50", "--python", "/runtime/writer.py", "--",
    ],
  };
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
  const configDir = join(work, "config");
  mkdirSync(configDir, { mode: 0o700 });
  const input = join(work, "input.json");
  writeFileSync(input, payloadBytes, { mode: 0o600, flag: "wx" });
  try {
    onHeartbeat?.();
    const sandbox = makeSandboxCommand(config, blenderRoot, blender, writer, privateExporter, patchManifest, work);
    const processResult = runUnderNativeRunner(sandbox.command, sandbox.args, config, { cwd: work, addressSpaceBytes: S8_LIMITS.writerAddressSpaceBytes, fileBytes: S8_LIMITS.artifactBytes, timeoutMs: S8_LIMITS.timeoutMs, stdoutBytes: S8_LIMITS.stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes });
    onHeartbeat?.();
    const artifactPath = join(work, "artifact.fbx");
    const receiptPath = join(work, "writer-receipt.json");
    const artifactInfo = lstatSync(artifactPath);
    const receiptInfo = lstatSync(receiptPath);
    if (artifactInfo.isSymbolicLink() || receiptInfo.isSymbolicLink()) fail("S8_WORKER_OUTPUT_INVALID");
    if (artifactInfo.size <= 27 || artifactInfo.size > S8_LIMITS.artifactBytes) fail("S8_ARTIFACT_RESOURCE_LIMIT");
    const artifact = readFileSync(artifactPath);
    const receipt = parseReceipt(readFileSync(receiptPath), s8Sha256(payloadBytes), writerSha256, executableSha256, artifact, privateExporterSha256, manifestSha256);
    return { artifact, receipt, stdout: processResult.stdout, stderr: processResult.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseNativeReadback(stdout: string): { readback: S8UfbxReadback; validatorIdentity: string; runnerIdentity: string; appliedLimits: Record<string, number | string> } {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { fail("S8_NATIVE_READBACK_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("S8_NATIVE_READBACK_INVALID");
  const wrapper = parsed as Record<string, unknown>;
  const readbackValue = wrapper.readback && typeof wrapper.readback === "object" ? wrapper.readback : parsed;
  if (!readbackValue || typeof readbackValue !== "object" || Array.isArray(readbackValue)) fail("S8_NATIVE_READBACK_INVALID");
  const readback = readbackValue as S8UfbxReadback;
  if (readback.schemaVersion !== "s8-ufbx-readback-v1" || readback.fbxVersion !== 7400 || !Array.isArray(readback.nodes) || !Array.isArray(readback.materials)) fail("S8_NATIVE_READBACK_INVALID");
  return {
    readback,
    validatorIdentity: typeof wrapper.validatorIdentity === "string" ? wrapper.validatorIdentity : S8_PROCESS_RUNNER_PIN.identity,
    runnerIdentity: typeof wrapper.runnerIdentity === "string" ? wrapper.runnerIdentity : S8_PROCESS_RUNNER_PIN.identity,
    appliedLimits: wrapper.appliedLimits && typeof wrapper.appliedLimits === "object" && !Array.isArray(wrapper.appliedLimits) ? wrapper.appliedLimits as Record<string, number | string> : { addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, maxChildren: S8_LIMITS.validatorChildProcesses },
  };
}

export function runS8NativeValidator(artifact: Buffer, config: S8WorkerConfig, onHeartbeat?: () => void): S8NativeValidatorResult {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  if (!config.nativeValidatorExecutable) fail("S8_NATIVE_VALIDATOR_REQUIRED");
  const validator = assertRegularFile(config.nativeValidatorExecutable, "nativeValidatorExecutable");
  const root = assertDirectory(config.privateWorkRoot, "privateWorkRoot");
  const work = mkdtempSync(join(root, "s8-validator-"));
  const artifactPath = join(work, "artifact.fbx");
  writeFileSync(artifactPath, artifact, { mode: 0o600, flag: "wx" });
  try {
    onHeartbeat?.();
    const result = runUnderNativeRunner(validator, [artifactPath], config, { cwd: work, addressSpaceBytes: S8_LIMITS.validatorMemoryBytes, fileBytes: S8_LIMITS.validatorTempBytes, timeoutMs: S8_LIMITS.validatorTimeoutMs, stdoutBytes: S8_LIMITS.readbackBytes, stderrBytes: S8_LIMITS.stderrBytes });
    onHeartbeat?.();
    if (Buffer.byteLength(result.stdout, "utf8") > S8_LIMITS.readbackBytes) fail("S8_NATIVE_READBACK_LIMIT");
    const parsed = parseNativeReadback(result.stdout);
    return { ...parsed, readbackBytes: Buffer.from(result.stdout, "utf8"), stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
