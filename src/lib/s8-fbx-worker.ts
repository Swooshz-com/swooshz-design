import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AppError } from "./types";
import { S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_LIMITS, S8_WRITER_RECEIPT_VERSION, s8Sha256 } from "./s8-fbx-profile";

export type S8WorkerConfig = {
  blenderRuntimeRoot: string;
  blenderExecutable: string;
  writerScript: string;
  privateWorkRoot: string;
  sandboxExecutable: string;
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

function fail(code: string, field = "worker"): never {
  throw new AppError(502, code, [{ field, code }]);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path: string, field: string): string {
  const absolute = realpathSync(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  return absolute;
}

function assertDirectory(path: string, field: string): string {
  const absolute = realpathSync(path);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("S8_WORKER_PATH_INVALID", field);
  return absolute;
}

function boundedOutput(value: Buffer | string | null, maximum: number, code: string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
  if (buffer.length > maximum) fail(code);
  return buffer.toString("utf8");
}

function parseReceipt(bytes: Buffer, payloadSha256: string, writerSha256: string, executableSha256: string, artifact: Buffer, privateExporterSha256: string, manifestSha256: string): S8WriterReceipt {
  if (bytes.length > S8_LIMITS.receiptBytes) fail("S8_WRITER_RECEIPT_LIMIT");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("ascii")); } catch { fail("S8_WRITER_RECEIPT_INVALID"); }
  if (!value || typeof value !== "object") fail("S8_WRITER_RECEIPT_INVALID");
  const receipt = value as S8WriterReceipt;
  if (receipt.schemaVersion !== S8_WRITER_RECEIPT_VERSION || receipt.profile !== "swooshz-fbx-static-mesh-v1" || receipt.fbxHeaderVersion !== 7400) fail("S8_WRITER_RECEIPT_INVALID");
  if (receipt.payloadSha256 !== payloadSha256 || receipt.writerScriptSha256 !== writerSha256 || receipt.artifactSha256 !== s8Sha256(artifact) || receipt.artifactByteSize !== artifact.length) fail("S8_WRITER_RECEIPT_BINDING_MISMATCH");
  if (receipt.runtime.blenderBinarySha256 !== executableSha256 || JSON.stringify(receipt.runtime.blenderVersion) !== "[5,2,2]" || !receipt.runtime.blenderBuildHash.startsWith(S8_BLENDER_PIN.buildHashPrefix) || JSON.stringify(receipt.runtime.exporterVersion) !== "[5,15,0]") fail("S8_RUNTIME_IDENTITY_MISMATCH");
  for (const [name, expectedSha1] of Object.entries(S8_BLENDER_PIN.exporterBlobs)) if (receipt.runtime.exporterFiles[name]?.gitBlobSha1 !== expectedSha1) fail("S8_EXPORTER_IDENTITY_MISMATCH");
  if (receipt.runtime.privateExporterPatch?.schemaVersion !== S8_EXPORTER_PATCH_PIN.manifest || receipt.runtime.privateExporterPatch.patchIdentity !== S8_EXPORTER_PATCH_PIN.identity || receipt.runtime.privateExporterPatch.privateExporterSha256 !== privateExporterSha256 || receipt.runtime.privateExporterPatch.manifestSha256 !== manifestSha256) fail("S8_EXPORTER_PATCH_IDENTITY_MISMATCH");
  return receipt;
}

export function runS8BlenderWriter(payloadBytes: Buffer, config: S8WorkerConfig): S8WriterResult {
  if (process.platform !== "linux" || process.arch !== "x64") fail("S8_TOOLING_HOLD_PLATFORM");
  if (payloadBytes.length === 0 || payloadBytes.length > S8_LIMITS.payloadBytes) fail("S8_PAYLOAD_RESOURCE_LIMIT");
  const blenderRoot = assertDirectory(config.blenderRuntimeRoot, "blenderRuntimeRoot");
  const blender = assertRegularFile(config.blenderExecutable, "blenderExecutable");
  const blenderRelativePath = relative(blenderRoot, blender);
  if (blenderRelativePath.startsWith("..") || resolve(blenderRoot, blenderRelativePath) !== blender || dirname(blender) !== blenderRoot) fail("S8_WORKER_PATH_INVALID", "blenderExecutable");
  const writer = assertRegularFile(config.writerScript, "writerScript");
  const privateExporter = assertRegularFile(join(dirname(writer), "export_fbx_bin.py"), "privateExporter");
  const patchManifest = assertRegularFile(join(dirname(writer), "patch-manifest.json"), "patchManifest");
  const sandbox = assertRegularFile(config.sandboxExecutable, "sandboxExecutable");
  const executableSha256 = fileSha256(blender);
  if (executableSha256 !== config.blenderExecutableSha256) fail("S8_BLENDER_EXECUTABLE_DIGEST_MISMATCH");
  const writerSha256 = fileSha256(writer);
  const privateExporterSha256 = fileSha256(privateExporter);
  const manifestSha256 = fileSha256(patchManifest);
  const root = realpathSync(config.privateWorkRoot);
  const work = resolve(root, `s8-${randomUUID()}`);
  if (!work.startsWith(`${root}/`) && !work.startsWith(`${root}\\`)) fail("S8_WORKER_PATH_INVALID");
  mkdirSync(work, { mode: 0o700 });
  const configDir = join(work, "config");
  mkdirSync(configDir, { mode: 0o700 });
  const input = join(work, "input.json");
  writeFileSync(input, payloadBytes, { mode: 0o600, flag: "wx" });
  try {
    const args = [
      "--unshare-net", "--die-with-parent", "--new-session",
      "--ro-bind", blenderRoot, "/runtime/blender-root",
      "--ro-bind", writer, "/runtime/writer.py",
      "--ro-bind", privateExporter, "/runtime/export_fbx_bin.py",
      "--ro-bind", patchManifest, "/runtime/patch-manifest.json",
      "--bind", work, "/work", "--chdir", "/work",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      `/runtime/blender-root/${blenderRelativePath.replaceAll("\\", "/")}`, "--background", "--factory-startup", "--disable-autoexec", "--offline-mode",
      "--python-exit-code", "50", "--python", "/runtime/writer.py", "--",
    ];
    const child = spawnSync(sandbox, args, {
      cwd: work,
      env: { NODE_ENV: "production", HOME: "/work/config", XDG_CONFIG_HOME: "/work/config", XDG_CACHE_HOME: "/work/config", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      shell: false,
      windowsHide: true,
      timeout: S8_LIMITS.timeoutMs,
      maxBuffer: S8_LIMITS.stdoutBytes + S8_LIMITS.stderrBytes,
      encoding: null,
      killSignal: "SIGKILL",
    });
    const stdout = boundedOutput(child.stdout, S8_LIMITS.stdoutBytes, "S8_STDOUT_LIMIT");
    const stderr = boundedOutput(child.stderr, S8_LIMITS.stderrBytes, "S8_STDERR_LIMIT");
    if (child.error || child.signal || child.status !== 0) fail(child.error && "code" in child.error && child.error.code === "ETIMEDOUT" ? "S8_WORKER_TIMEOUT" : "S8_WORKER_FAILED");
    const artifactPath = join(work, "artifact.fbx");
    const receiptPath = join(work, "writer-receipt.json");
    if (lstatSync(artifactPath).isSymbolicLink() || lstatSync(receiptPath).isSymbolicLink()) fail("S8_WORKER_OUTPUT_INVALID");
    const artifactSize = statSync(artifactPath).size;
    if (artifactSize <= 27 || artifactSize > S8_LIMITS.artifactBytes) fail("S8_ARTIFACT_RESOURCE_LIMIT");
    const artifact = readFileSync(artifactPath);
    const receiptBytes = readFileSync(receiptPath);
    const receipt = parseReceipt(receiptBytes, s8Sha256(payloadBytes), writerSha256, executableSha256, artifact, privateExporterSha256, manifestSha256);
    return { artifact, receipt, stdout, stderr };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
