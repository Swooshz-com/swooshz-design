import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseS8RunnerReceipt, runS8BlenderWriter, runS8NativeValidator, type S8RunnerEvidence, type S8RunnerLimits, type S8WorkerConfig } from "../src/lib/s8-fbx-worker";
import { readS8RuntimeConfig } from "../src/lib/s8-fbx-config";

function config(root: string): S8WorkerConfig {
  return { blenderRuntimeRoot: root, blenderExecutable: join(root, "blender"), writerScript: join(root, "writer.py"), privateWorkRoot: root, processRunnerExecutable: join(root, "runner"), sandboxExecutable: join(root, "sandbox"), nativeValidatorExecutable: join(root, "validator"), blenderExecutableSha256: "a".repeat(64) };
}

test("worker refuses to run without the native Linux process boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-"));
  try {
    const value = config(root);
    if (process.platform === "linux" && process.arch === "x64") {
      assert.throws(() => runS8NativeValidator(Buffer.alloc(32), value), /S8_WORKER_PATH_INVALID/);
    } else {
      assert.throws(() => runS8NativeValidator(Buffer.alloc(32), value), /S8_TOOLING_HOLD_PLATFORM/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial runtime configuration fails closed instead of selecting a fallback", () => {
  assert.throws(() => readS8RuntimeConfig({ S8_BLENDER_RUNTIME_ROOT: "C:/runtime" }), /S8_RUNTIME_CONFIG_INVALID/);
});

function runnerReceipt(overrides: Record<string, unknown> = {}): Buffer {
  const value: S8RunnerEvidence = {
    schemaVersion: "s8-process-runner-receipt-v1",
    protocol: "s8-process-runner-receipt-v1",
    runnerSha256: "a".repeat(64),
    requestedAddressSpaceBytes: 1024,
    appliedAddressSpaceBytes: 1024,
    requestedFileBytes: 2048,
    appliedFileBytes: 2048,
    requestedTimeoutMs: 3000,
    appliedTimeoutMs: 3000,
    requestedStdoutBytes: 4096,
    appliedStdoutBytes: 4096,
    requestedStderrBytes: 4096,
    appliedStderrBytes: 4096,
    requestedMaxChildren: 0,
    appliedMaxChildren: 0,
    seccompPolicy: "s8-zero-child-seccomp-v1",
    limitsApplied: true,
    seccompEnabled: true,
    filterInstalled: true,
    ...overrides,
  };
  return Buffer.from(`S8_RUNNER_RECEIPT:${JSON.stringify({ ...value, ...overrides })}\nchild-output`, "utf8");
}

const runnerLimits: S8RunnerLimits = { addressSpaceBytes: 1024, fileBytes: 2048, timeoutMs: 3000, stdoutBytes: 4096, stderrBytes: 4096 };

test("runner receipt validation rejects missing, malformed, mismatched, and incomplete evidence", () => {
  const hash = "a".repeat(64);
  assert.equal(parseS8RunnerReceipt(runnerReceipt(), runnerLimits, hash).stdout, "child-output");
  assert.throws(() => parseS8RunnerReceipt(Buffer.from("child-output"), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(Buffer.from("S8_RUNNER_RECEIPT:{not-json}\nchild-output"), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ runnerSha256: "b".repeat(64) }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ appliedAddressSpaceBytes: 1023 }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ appliedTimeoutMs: 2999 }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ appliedMaxChildren: 1 }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ seccompEnabled: false }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(runnerReceipt({ filterInstalled: false }), runnerLimits, hash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
});
