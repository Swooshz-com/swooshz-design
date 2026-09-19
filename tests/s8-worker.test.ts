import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseS8RunnerReceipt, runS8NativeValidator, type S8RunnerLimits, type S8WorkerConfig } from "../src/lib/s8-fbx-worker";
import { readS8RuntimeConfig } from "../src/lib/s8-fbx-config";

type MutableReceipt = {
  schemaVersion: string;
  protocol: string;
  policyId: string;
  requested: Record<string, unknown>;
  appliedByChild: Record<string, unknown>;
  observedByRunnerParent: Record<string, unknown>;
  runnerParentVerification: Record<string, unknown>;
  runnerBinary: Record<string, unknown>;
  result: Record<string, unknown>;
};

const runnerLimits: S8RunnerLimits = { addressSpaceBytes: 1024, fileBytes: 2048, timeoutMs: 3000, stdoutBytes: 4096, stderrBytes: 4096, maxChildren: 0 };
const runnerHash = "a".repeat(64);

function receiptValue(): MutableReceipt {
  return {
    schemaVersion: "s8-process-runner-receipt-v2",
    protocol: "s8-process-runner-receipt-v2",
    policyId: "s8-zero-child-seccomp-x86_64-v2",
    requested: { rlimitAsBytes: 1024, rlimitFsizeBytes: 2048, rlimitCpuSeconds: 4, rlimitNproc: 64, wallTimeoutMs: 3000, stdoutBytes: 4096, stderrBytes: 4096, maxChildren: 0 },
    appliedByChild: { rlimitAsBytes: 1024, rlimitFsizeBytes: 2048, rlimitCpuSeconds: 4, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    observedByRunnerParent: { rlimitAsBytes: 1024, rlimitFsizeBytes: 2048, rlimitCpuSeconds: 4, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    runnerParentVerification: { status: "PASS", mismatchCode: null },
    runnerBinary: { selfSha256: runnerHash },
    result: { code: 0, name: "S8_RUNNER_SUCCESS", terminationClass: "target-exit-zero", targetExit: 0, targetSignal: null, elapsedMs: 2, stdoutBytes: 0, stderrBytes: 0, setupStage: null, evidenceCode: null },
  };
}

function receipt(mutator?: (value: MutableReceipt) => void): Buffer {
  const value = receiptValue();
  mutator?.(value);
  return Buffer.from(`S8_RUNNER_RECEIPT:${JSON.stringify(value)}\nchild-output`, "utf8");
}

function invalid(value: Buffer, postHash = runnerHash): void {
  assert.throws(() => parseS8RunnerReceipt(value, runnerLimits, runnerHash, postHash), /S8_PROCESS_RUNNER_EVIDENCE_INVALID|S8_RUNNER_HASH_DRIFT/);
}

function config(root: string): S8WorkerConfig {
  return {
    blenderRuntimeRoot: root,
    blenderExecutable: join(root, "blender"),
    writerScript: join(root, "writer.py"),
    privateWorkRoot: root,
    processRunnerExecutable: join(root, "runner"),
    sandboxExecutable: join(root, "sandbox"),
    nativeValidatorExecutable: join(root, "validator"),
    blenderExecutableSha256: runnerHash,
  };
}

test("worker refuses to run without the native Linux process boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-"));
  try {
    if (process.platform === "linux" && process.arch === "x64") assert.throws(() => runS8NativeValidator(Buffer.alloc(32), config(root)), /S8_WORKER_PATH_INVALID/);
    else assert.throws(() => runS8NativeValidator(Buffer.alloc(32), config(root)), /S8_TOOLING_HOLD_PLATFORM/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial runtime configuration fails closed instead of selecting a fallback", () => {
  assert.throws(() => readS8RuntimeConfig({ S8_BLENDER_RUNTIME_ROOT: "C:/runtime" }), /S8_RUNTIME_CONFIG_INVALID/);
});

test("strict v2 caller parsing accepts only canonical, fully evidenced receipts", () => {
  const parsed = parseS8RunnerReceipt(receipt(), runnerLimits, runnerHash);
  assert.equal(parsed.stdout, "child-output");
  assert.equal(parsed.evidence.protocol, "s8-process-runner-receipt-v2");
  assert.equal(parsed.evidence.policyId, "s8-zero-child-seccomp-x86_64-v2");
  assert.equal(parsed.evidence.verifiedByCaller.status, "VERIFIED_BY_CALLER");
  assert.equal(parsed.evidence.verifiedByCaller.preLaunchSha256, runnerHash);
  assert.equal(parsed.evidence.verifiedByCaller.postLaunchSha256, runnerHash);
  assert.equal(parsed.evidence.verifiedByCaller.runnerReportedSelfSha256, runnerHash);
  assert.equal(parsed.evidence.verifiedByCaller.receiptSha256.length, 64);
});

test("v2 receipt negatives fail closed for missing, malformed, duplicate, unknown, and noncanonical input", () => {
  invalid(Buffer.from("child-output", "utf8"));
  invalid(Buffer.from("S8_RUNNER_RECEIPT:{not-json}\nchild-output", "utf8"));
  const validText = receipt().toString("utf8");
  invalid(Buffer.from(validText.replace(",\"policyId\"", ",\"protocol\":\"s8-process-runner-receipt-v2\",\"policyId\""), "utf8"));
  invalid(Buffer.from(validText.replace(",\"result\"", ",\"unknown\":1,\"result\""), "utf8"));
  invalid(Buffer.from(validText.replace(",\"protocol\"", ", \"protocol\""), "utf8"));
});

test("v2 receipt negatives reject identity, policy, requested, applied, observed, and seccomp mismatches", () => {
  invalid(receipt((value) => { value.schemaVersion = "s8-process-runner-receipt-v1"; }));
  invalid(receipt((value) => { value.protocol = "s8-process-runner-receipt-v1"; }));
  invalid(receipt((value) => { value.policyId = "wrong-policy"; }));
  invalid(receipt((value) => { value.requested.rlimitAsBytes = 1023; }));
  invalid(receipt((value) => { value.appliedByChild.rlimitFsizeBytes = 2047; }));
  invalid(receipt((value) => { value.observedByRunnerParent.rlimitCpuSeconds = 3; }));
  invalid(receipt((value) => { value.appliedByChild.seccompMode = 0; }));
  invalid(receipt((value) => { delete value.observedByRunnerParent.seccompMode; }));
});

test("caller hash verification rejects pre/post drift and runner-reported hash drift", () => {
  assert.throws(() => parseS8RunnerReceipt(receipt(), runnerLimits, runnerHash, "b".repeat(64)), /S8_RUNNER_HASH_DRIFT/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => { value.runnerBinary.selfSha256 = "b".repeat(64); }), runnerLimits, runnerHash), /S8_RUNNER_HASH_DRIFT/);
});
