import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalS8ConfigBytes, createS8BrokerRequest, parseS8BrokerResponse, parseS8RunnerReceipt, runS8NativeValidator, validateS8BrokerResponseIdentity, type S8RunnerLimits, type S8WorkerConfig } from "../src/lib/s8-fbx-worker";
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

function receipt(mutator?: (value: MutableReceipt) => void, targetOutput = "child-output"): Buffer {
  const value = receiptValue();
  value.result.stdoutBytes = Buffer.byteLength(targetOutput);
  mutator?.(value);
  return Buffer.from(`S8_RUNNER_RECEIPT:${JSON.stringify(value)}\n${targetOutput}`, "utf8");
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
    sandboxExecutable: "/usr/local/libexec/swooshz-s8/s8-sandbox",
    sandboxPolicySha256: runnerHash,
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

test("partial native worker configuration fails closed and local executable settings cannot activate it", () => {
  assert.throws(() => readS8RuntimeConfig({ S8_WORKER_GATEWAY_URL: "https://worker.example" }), /S8_NATIVE_WORKER_CONFIG_INVALID/);
  assert.equal(readS8RuntimeConfig({ S8_APP_SIGNING_KEY_ID: "application-key", S8_APP_SIGNING_PRIVATE_KEY_PEM: "application-key-material" }), undefined);
  assert.equal(readS8RuntimeConfig({ S8_BLENDER_RUNTIME_ROOT: "C:/runtime" }), undefined);
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

test("native v2 code, name, termination, and captured byte counts must agree", () => {
  invalid(receipt((value) => { value.result.code = 79; }));
  invalid(receipt((value) => { value.result.name = "S8_RUNNER_TARGET_EXIT_NONZERO"; }));
  invalid(receipt((value) => { value.result.terminationClass = "target-exit-nonzero"; }));
  invalid(receipt((value) => { value.result.targetExit = 1; }));
  invalid(receipt((value) => { value.result.targetSignal = 9; }));
  invalid(receipt((value) => {
    value.result.code = 124;
    value.result.name = "S8_RUNNER_TIMEOUT";
    value.result.terminationClass = "wall-timeout";
    value.result.targetExit = 0;
  }));
  invalid(receipt((value) => { value.result.stdoutBytes = 0; }));
});

test("caller records the raw stdout byte count before UTF-8 decoding", () => {
  const value = receiptValue();
  value.result.stdoutBytes = 1;
  const line = Buffer.from(`S8_RUNNER_RECEIPT:${JSON.stringify(value)}\n`, "utf8");
  const parsed = parseS8RunnerReceipt(Buffer.concat([line, Buffer.from([0xff])]), runnerLimits, runnerHash);
  assert.equal(parsed.evidence.verifiedByCaller.observedStdoutBytes, 1);
});

test("native v2 mapping validates every defined runner result and preserves outer observations", () => {
  const cases: Array<{ code: number; name: string; terminationClass: string; update?: (value: MutableReceipt) => void }> = [
    { code: 0, name: "S8_RUNNER_SUCCESS", terminationClass: "target-exit-zero" },
    { code: 70, name: "S8_RUNNER_INTERNAL", terminationClass: "runner-internal", update: (value) => { value.runnerParentVerification = { status: "PASS", mismatchCode: "CAPTURE_INIT" }; } },
    { code: 71, name: "S8_RUNNER_CHILD_SETUP_FAILED", terminationClass: "child-setup-failed", update: (value) => { value.runnerParentVerification = { status: "FAIL", mismatchCode: null }; value.appliedByChild = { rlimitAsBytes: 0, rlimitFsizeBytes: 0, rlimitCpuSeconds: 0, rlimitNproc: 0, noNewPrivs: 0, seccompMode: 0 }; value.observedByRunnerParent = { rlimitAsBytes: 0, rlimitFsizeBytes: 0, rlimitCpuSeconds: 0, rlimitNproc: 0, noNewPrivs: 0, seccompMode: 0 }; value.result.setupStage = "seccomp"; value.result.stdoutBytes = 0; } },
    { code: 72, name: "S8_RUNNER_EVIDENCE_INVALID", terminationClass: "evidence-failed", update: (value) => { value.runnerParentVerification = { status: "FAIL", mismatchCode: "CHILD_EVIDENCE_MALFORMED" }; value.result.evidenceCode = "CHILD_EVIDENCE_MALFORMED"; } },
    { code: 73, name: "S8_RUNNER_EXEC_FAILED", terminationClass: "exec-failed" },
    { code: 74, name: "S8_RUNNER_STDOUT_LIMIT", terminationClass: "stdout-limit" },
    { code: 75, name: "S8_RUNNER_STDERR_LIMIT", terminationClass: "stderr-limit" },
    { code: 76, name: "S8_RUNNER_TARGET_EXIT_NONZERO", terminationClass: "target-exit-nonzero", update: (value) => { value.result.targetExit = 3; } },
    { code: 77, name: "S8_RUNNER_TARGET_SIGNAL", terminationClass: "target-signal", update: (value) => { value.result.targetSignal = 9; } },
    { code: 124, name: "S8_RUNNER_TIMEOUT", terminationClass: "wall-timeout" },
  ];
  for (const item of cases) {
    let parsed: ReturnType<typeof parseS8RunnerReceipt>;
    try {
      parsed = parseS8RunnerReceipt(
        receipt((value) => {
          value.result.code = item.code;
          value.result.name = item.name;
          value.result.terminationClass = item.terminationClass;
          if (item.code !== 0) { value.result.targetExit = null; value.result.targetSignal = null; }
          item.update?.(value);
        }, item.code === 71 ? "" : "child-output"),
        runnerLimits,
        runnerHash,
        runnerHash,
        { status: item.code, signal: null, stderr: Buffer.alloc(0) },
      );
    } catch (error) {
      throw new Error(`native runner result ${item.code} rejected: ${(error as Error).message}`);
    }
    assert.equal(parsed.evidence.verifiedByCaller.outerExitStatus, item.code);
  }
});

test("outer runner status, signal, stderr count, setup, evidence, and pre-receipt argument failures reject", () => {
  assert.throws(() => parseS8RunnerReceipt(receipt(), runnerLimits, runnerHash, runnerHash, { status: 1, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt(), runnerLimits, runnerHash, runnerHash, { status: 0, signal: "SIGKILL", stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => { value.result.stderrBytes = 1; }), runnerLimits, runnerHash, runnerHash, { status: 0, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => { value.result.code = 71; value.result.name = "S8_RUNNER_CHILD_SETUP_FAILED"; value.result.terminationClass = "child-setup-failed"; }), runnerLimits, runnerHash, runnerHash, { status: 71, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => { value.result.code = 72; value.result.name = "S8_RUNNER_EVIDENCE_INVALID"; value.result.terminationClass = "evidence-failed"; }), runnerLimits, runnerHash, runnerHash, { status: 72, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(Buffer.alloc(0), runnerLimits, runnerHash, runnerHash, { status: 64, signal: null, stderr: Buffer.from("usage") }), /S8_PROCESS_RUNNER_ARGUMENT_INVALID/);
});

test("native runner internal failures accept only its exact internal mismatch semantics", () => {
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => {
    value.result.code = 70;
    value.result.name = "S8_RUNNER_INTERNAL";
    value.result.terminationClass = "runner-internal";
    value.runnerParentVerification = { status: "FAIL", mismatchCode: "PARENT_PROC_STATUS" };
  }), runnerLimits, runnerHash, runnerHash, { status: 70, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => {
    value.result.code = 70;
    value.result.name = "S8_RUNNER_INTERNAL";
    value.result.terminationClass = "runner-internal";
    value.runnerParentVerification = { status: "PASS", mismatchCode: "INVENTED" };
  }), runnerLimits, runnerHash, runnerHash, { status: 70, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => {
    value.result.code = 70;
    value.result.name = "S8_RUNNER_INTERNAL";
    value.result.terminationClass = "runner-internal";
    value.runnerParentVerification = { status: "PASS", mismatchCode: "PARENT_SETPGID" };
  }), runnerLimits, runnerHash, runnerHash, { status: 70, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => {
    value.result.code = 72;
    value.result.name = "S8_RUNNER_EVIDENCE_INVALID";
    value.result.terminationClass = "evidence-failed";
    value.result.evidenceCode = "INVENTED";
    value.runnerParentVerification = { status: "FAIL", mismatchCode: "INVENTED" };
  }), runnerLimits, runnerHash, runnerHash, { status: 72, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  assert.throws(() => parseS8RunnerReceipt(receipt((value) => {
    value.result.code = 76;
    value.result.name = "S8_RUNNER_TARGET_EXIT_NONZERO";
    value.result.terminationClass = "target-exit-nonzero";
    value.result.targetExit = 256;
  }), runnerLimits, runnerHash, runnerHash, { status: 76, signal: null, stderr: Buffer.alloc(0) }), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
});

test("broker request uses the fixed binary protocol and binds payload, policy, and canonical config", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-broker-frame-"));
  try {
    const workerConfig = config(root);
    const payload = Buffer.from("original-payload\0bytes", "utf8");
    const requestId = Buffer.alloc(16, 0x5a);
    const request = createS8BrokerRequest("WRITER", payload, workerConfig, requestId);
    assert.equal(request.bytes.length, 160 + payload.length);
    assert.equal(request.bytes.toString("ascii", 0, 8), "S8BRQ001");
    assert.equal(request.bytes.readUInt16BE(8), 1);
    assert.equal(request.bytes[10], 1);
    assert.equal(request.bytes[11], 0);
    assert.equal(request.bytes.subarray(12, 28).toString("hex"), requestId.toString("hex"));
    assert.equal(request.bytes.subarray(28, 60).toString("hex"), workerConfig.sandboxPolicySha256);
    assert.equal(request.bytes.readBigUInt64BE(92), BigInt(payload.length));
    assert.equal(request.bytes.subarray(100, 132).toString("hex"), createHash("sha256").update(payload).digest("hex"));
    assert.equal(request.bytes.subarray(132, 160).every((byte) => byte === 0), true);
    assert.equal(request.bytes.subarray(160).equals(payload), true);
    assert.match(request.configSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final config canonical bytes retain the Run-106 policy digest and fixed Q oracle", () => {
  const workerConfig: S8WorkerConfig = {
    blenderRuntimeRoot: "/opt/blender",
    blenderExecutable: "/opt/blender/blender",
    writerScript: "/opt/swooshz/writer.py",
    privateWorkRoot: "/var/lib/swooshz/s8",
    processRunnerExecutable: "/usr/local/libexec/swooshz-s8/s8-process-runner",
    sandboxExecutable: "/usr/local/libexec/swooshz-s8/s8-sandbox",
    nativeValidatorExecutable: "/usr/local/libexec/swooshz-s8/s8-native-validator",
    blenderExecutableSha256: "1".repeat(64),
    sandboxPolicySha256: "73fa2120547140c024f40eb43399649949f7da1bb152622b018df588e886013f",
  };
  const bytes = canonicalS8ConfigBytes(workerConfig);
  assert.equal(bytes.length, 561);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "f3359c5e130c7806750275d6a2eb01ca9c214a07fb2f472f86db8daa8c2007ce");
  assert.match(bytes.toString("utf8"), /"nativeValidatorExecutable":.*"blenderExecutableSha256":.*"sandboxPolicySha256":/u);
  assert.throws(() => canonicalS8ConfigBytes({ ...workerConfig, blenderRuntimeRoot: `/opt/\ud800` }), /S8_BROKER_CONFIG_INVALID/);
});

test("broker response validates exact header, section lengths, request binding, and section digest", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-broker-response-"));
  try {
    const workerConfig = config(root);
    const request = createS8BrokerRequest("VALIDATOR", Buffer.from("fbx"), workerConfig, Buffer.alloc(16, 0x22));
    const metadata = Buffer.from('{"schemaVersion":"s8-sandbox-broker-metadata-v1"}', "utf8");
    const native = Buffer.from("native-receipt-and-output", "utf8");
    const sections = [Buffer.alloc(0), Buffer.alloc(0), native, Buffer.alloc(0), metadata];
    const header = Buffer.alloc(320);
    header.write("S8BRS001", 0, "ascii");
    header.writeUInt16BE(1, 8);
    header[10] = 2;
    Buffer.from(request.requestId, "hex").copy(header, 12);
    header.writeUInt16BE(0, 28);
    header.writeInt32BE(0, 32);
    header.writeInt32BE(-1, 36);
    Buffer.alloc(16, 0x44).copy(header, 40);
    Buffer.from(runnerHash, "hex").copy(header, 56);
    Buffer.from(runnerHash, "hex").copy(header, 88);
    Buffer.from(workerConfig.sandboxPolicySha256, "hex").copy(header, 120);
    Buffer.from(request.configSha256, "hex").copy(header, 152);
    sections.forEach((section, index) => header.writeBigUInt64BE(BigInt(section.length), 184 + (8 * index)));
    createHash("sha256").update(Buffer.concat(sections)).digest().copy(header, 224);
    const frame = Buffer.concat([header, ...sections]);
    const response = parseS8BrokerResponse(frame, { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 });
    assert.equal(response.brokerStatus, 0);
    assert.equal(response.identityBound, true);
    assert.equal(response.allocationId, "44".repeat(16));
    assert.equal(response.nativeStdout.equals(native), true);
    assert.equal(response.metadata.equals(metadata), true);
    assert.throws(() => parseS8BrokerResponse(frame.subarray(0, frame.length - 1), { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 }), /S8_BROKER_RESPONSE_INVALID/);
    const tampered = Buffer.from(frame);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => parseS8BrokerResponse(tampered, { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 }), /S8_BROKER_RESPONSE_DIGEST_MISMATCH/);
    const stalePolicy = Buffer.from(frame);
    stalePolicy[120] ^= 1;
    const successfulWrongPolicy = parseS8BrokerResponse(stalePolicy, { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 });
    assert.equal(successfulWrongPolicy.brokerStatus, 0);
    assert.equal(successfulWrongPolicy.identityBound, false);
    assert.throws(() => validateS8BrokerResponseIdentity(successfulWrongPolicy), /S8_OUTPUT_OR_RECEIPT_INVALID/);
    const failedWrongPolicy = Buffer.from(stalePolicy);
    failedWrongPolicy.writeUInt16BE(65, 28);
    const brokerFailure = parseS8BrokerResponse(failedWrongPolicy, { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 });
    validateS8BrokerResponseIdentity(brokerFailure);
    assert.equal(brokerFailure.brokerStatus, 65);
    const staleConfig = Buffer.from(frame);
    staleConfig[152] ^= 1;
    const successfulWrongConfig = parseS8BrokerResponse(staleConfig, { operation: "VALIDATOR", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 });
    assert.equal(successfulWrongConfig.brokerStatus, 0);
    assert.equal(successfulWrongConfig.identityBound, false);
    assert.throws(() => validateS8BrokerResponseIdentity(successfulWrongConfig), /S8_OUTPUT_OR_RECEIPT_INVALID/);
    assert.throws(() => parseS8BrokerResponse(frame, { operation: "WRITER", requestId: request.requestId, policySha256: workerConfig.sandboxPolicySha256, configSha256: request.configSha256 }), /S8_BROKER_RESPONSE_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct Bubblewrap paths and malformed policy digests fail closed before launch", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-broker-config-"));
  try {
    const payload = Buffer.from("payload");
    assert.throws(() => createS8BrokerRequest("WRITER", payload, { ...config(root), sandboxExecutable: "/usr/bin/bwrap" }), /S8_WORKER_SANDBOX_REQUIRED/);
    assert.throws(() => createS8BrokerRequest("WRITER", payload, { ...config(root), sandboxPolicySha256: "not-a-sha" }), /S8_BROKER_POLICY_IDENTITY_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const workflowSizeBase = "578ac98aa974fa0ec3a65bcade1c505ac5c80dcb";
const workflowSizeLimitBytes = 512_000;
const workflowSizePath = ".github/workflows/s8-fbx.yml";
const run089Head = "c620d7eda702be8149f69bff546b97e214e2fab6";
const originalWorkflowHead = "5a78ccdda307dd7dc3052aaaae5d033b7bf06c43";

type WorkflowSizeSource = "WORKTREE" | "INDEX" | "COMMIT" | "INVALID";
type WorkflowSizeRecord = {
  path: string;
  bytes: number | null;
  ref: string;
  blob: string;
  verdict: "PASS" | "REJECT";
};
type WorkflowSizeResult = { pass: boolean; records: WorkflowSizeRecord[] };
type WorkflowSizeIo = {
  git: (args: string[], cwd: string) => Buffer;
  read: (path: string) => Buffer;
};

function decodeUtf8Strict(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function splitNulDelimited(bytes: Buffer): Buffer[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error("GIT_NUL_LIST_INVALID");
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error("GIT_NUL_LIST_INVALID");
    fields.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function changedWorkflowDestinations(bytes: Buffer): string[] {
  const fields = splitNulDelimited(bytes);
  const destinations: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = decodeUtf8Strict(fields[index++]!);
    if (/^[RC][0-9]+$/.test(status)) {
      if (index + 1 >= fields.length) throw new Error("GIT_NAME_STATUS_INVALID");
      decodeUtf8Strict(fields[index++]!);
      destinations.push(decodeUtf8Strict(fields[index++]!));
    } else if (/^[AMT]$/.test(status)) {
      if (index >= fields.length) throw new Error("GIT_NAME_STATUS_INVALID");
      destinations.push(decodeUtf8Strict(fields[index++]!));
    } else {
      throw new Error("GIT_NAME_STATUS_INVALID");
    }
  }
  return destinations.filter((path) => /^\.github\/workflows\/.+\.(?:yml|yaml)$/i.test(path));
}

function workflowSizeRecord(path: string, bytes: Buffer, ref: string, blob: string): WorkflowSizeRecord {
  let verdict: WorkflowSizeRecord["verdict"] = "PASS";
  try {
    decodeUtf8Strict(bytes);
  } catch {
    verdict = "REJECT";
  }
  if (bytes.length > workflowSizeLimitBytes) verdict = "REJECT";
  return { path, bytes: bytes.length, ref, blob, verdict };
}

function workflowSizeFailure(path: string, ref: string): WorkflowSizeResult {
  return { pass: false, records: [{ path, bytes: null, ref, blob: "UNAVAILABLE", verdict: "REJECT" }] };
}

function makeWorkflowSizeIo(root: string): WorkflowSizeIo {
  return {
    git: (args, cwd) => execFileSync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }),
    read: (path) => readFileSync(join(root, path)),
  };
}

function runWorkflowSizeGate(root: string, reference: string | undefined, io = makeWorkflowSizeIo(root)): WorkflowSizeResult {
  const source: WorkflowSizeSource = reference === undefined ? "WORKTREE" : reference === "INDEX" ? "INDEX" : /^[0-9a-f]{40}$/.test(reference) ? "COMMIT" : "INVALID";
  if (source === "INVALID") return workflowSizeFailure("<ref>", "INVALID");
  const ref = source === "COMMIT" ? reference! : source;
  let changedPaths: string[];
  try {
    if (source === "INDEX") {
      if (io.git(["ls-files", "--unmerged", "-z"], root).length !== 0) throw new Error("INDEX_UNRESOLVED");
    } else if (source === "COMMIT") {
      io.git(["cat-file", "-e", reference + "^{commit}"], root);
    }
    const diffArgs = source === "INDEX"
      ? ["diff", "--cached", "--name-status", "-z", "--diff-filter=ACMRT", "--find-renames", "--find-copies-harder", workflowSizeBase, "--"]
      : source === "COMMIT"
        ? ["diff", "--name-status", "-z", "--diff-filter=ACMRT", "--find-renames", "--find-copies-harder", workflowSizeBase, reference!, "--"]
        : ["diff", "--name-status", "-z", "--diff-filter=ACMRT", "--find-renames", "--find-copies-harder", workflowSizeBase, "--"];
    changedPaths = changedWorkflowDestinations(io.git(diffArgs, root));
    if (source === "WORKTREE") {
      changedPaths.push(...splitNulDelimited(io.git(["ls-files", "--others", "--exclude-standard", "-z"], root))
        .map(decodeUtf8Strict)
        .filter((path) => /^\.github\/workflows\/.+\.(?:yml|yaml)$/i.test(path)));
    }
  } catch {
    return workflowSizeFailure("<enumeration>", ref);
  }

  const paths = [...new Set([workflowSizePath, ...changedPaths])].sort();
  const records: WorkflowSizeRecord[] = [];
  for (const path of paths) {
    try {
      if (source === "WORKTREE") {
        records.push(workflowSizeRecord(path, io.read(path), ref, "WORKTREE"));
        continue;
      }
      const object = source === "INDEX" ? ":" + path : reference + ":" + path;
      const blobId = decodeUtf8Strict(io.git(["rev-parse", "--verify", object], root)).trim();
      if (!/^[0-9a-f]{40}$/.test(blobId)) throw new Error("GIT_BLOB_ID_INVALID");
      const bytes = io.git(["cat-file", "blob", blobId], root);
      records.push(workflowSizeRecord(path, bytes, ref, blobId));
    } catch {
      records.push({ path, bytes: null, ref, blob: "UNAVAILABLE", verdict: "REJECT" });
    }
  }
  return { pass: records.every((record) => record.verdict === "PASS"), records };
}

function emitWorkflowSizeResult(result: WorkflowSizeResult): void {
  for (const record of result.records) console.log(JSON.stringify(record));
}

const workerJobMarker = "  s8-workers:";
const exactHeadStepMarker = "      - name: Verify exact PR head";
const setupNodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const setupNodeStep = [
  "      - name: Setup Node 22",
  "        uses: " + setupNodeAction,
  "        with:",
  "          node-version: 22",
].join("\n");
const workerRegressionStep = [
  "      - name: Native worker protocol and launcher regressions",
  "        shell: bash",
  "        run: |",
  "          set -euo pipefail",
  "          node --test native/s8-worker-common/*.test.mjs native/s8-worker-gateway/*.test.mjs native/s8-worker-launcher/*.test.mjs",
].join("\n");

function countText(source: string, value: string): number {
  return source.split(value).length - 1;
}

function workerWorkflowSourceIsValid(workflow: string): boolean {
  const source = workflow.replace(/\r\n/g, "\n");
  if (countText(source, workerJobMarker) !== 1) return false;
  const job = source.slice(source.indexOf(workerJobMarker));
  const checkout = job.indexOf("uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
  const verify = job.indexOf(exactHeadStepMarker);
  const setup = job.indexOf(setupNodeStep);
  const regressions = job.indexOf(workerRegressionStep);
  const writer = job.indexOf("      - name: Writer contract regression");
  const python = job.indexOf("      - name: Python syntax");
  if (checkout < 0 || verify <= checkout || setup <= verify || regressions <= setup || writer <= regressions || python <= writer) return false;
  if (!job.slice(verify, setup).includes('run: test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"')) return false;
  if (countText(job, setupNodeStep) !== 1 || countText(job, workerRegressionStep) !== 1 ||
      countText(job, "node --test native/s8-worker-common/*.test.mjs native/s8-worker-gateway/*.test.mjs native/s8-worker-launcher/*.test.mjs") !== 1 ||
      countText(job, "run: python3 scripts/s8/blender_writer_contract_regression.py") !== 1 ||
      countText(job, "run: python3 -m py_compile blender/s8-fbx-writer/writer.py scripts/s8/*.py") !== 1 ||
      job.includes("s8_application_boundary_proof") || job.includes("s8_runtime_sensitivity")) return false;
  return true;
}
function fakeWorkflowSizeIo(options: {
  diff?: Buffer;
  untracked?: Buffer;
  unmerged?: Buffer;
  blobs?: Record<string, Buffer>;
  files?: Record<string, Buffer>;
  fail?: "enumeration" | "read" | "blob" | "commit";
} = {}): WorkflowSizeIo {
  let selectedPath = "";
  return {
    git: (args) => {
      if (args[0] === "ls-files" && args[1] === "--unmerged") return options.unmerged ?? Buffer.alloc(0);
      if (args[0] === "ls-files" && args[1] === "--others") return options.untracked ?? Buffer.alloc(0);
      if (args[0] === "diff") {
        if (options.fail === "enumeration") throw new Error("GIT_ENUMERATION_FAILED");
        return options.diff ?? Buffer.alloc(0);
      }
      if (args[0] === "cat-file" && args[1] === "-e") {
        if (options.fail === "commit") throw new Error("GIT_COMMIT_MISSING");
        return Buffer.alloc(0);
      }
      if (args[0] === "rev-parse") {
        selectedPath = args[2]!.slice(args[2]!.indexOf(":") + 1);
        if (options.fail === "blob" || !options.blobs?.[selectedPath]) throw new Error("GIT_BLOB_MISSING");
        return Buffer.from("b".repeat(40) + "\n");
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        const blob = options.blobs?.[selectedPath];
        if (!blob) throw new Error("GIT_BLOB_MISSING");
        return blob;
      }
      throw new Error("GIT_FIXTURE_UNEXPECTED");
    },
    read: (path) => {
      if (options.fail === "read" || !options.files?.[path]) throw new Error("WORKTREE_READ_FAILED");
      return options.files[path]!;
    },
  };
}

function nameStatusZ(...entries: string[][]): Buffer {
  return Buffer.from(entries.flat().join("\0") + "\0", "utf8");
}

test("workflow UTF-8 size gate checks the selected raw bytes and rejects every failed input", () => {
  const root = resolve(process.cwd());
  const actual = runWorkflowSizeGate(root, process.env.S8_WORKFLOW_SIZE_REF);
  emitWorkflowSizeResult(actual);
  assert.equal(actual.pass, true, "WORKFLOW_SIZE_GATE_REJECTED");

  const primary = workflowSizePath;
  const sizeAtLimit = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), blobs: { [primary]: Buffer.alloc(512_000, 0x61) },
  }));
  assert.equal(sizeAtLimit.pass, true);

  const overLimit = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), blobs: { [primary]: Buffer.alloc(512_001, 0x61) },
  }));
  assert.equal(overLimit.pass, false);

  const multibyteAtLimit = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), blobs: { [primary]: Buffer.from("é".repeat(256_000), "utf8") },
  }));
  assert.equal(multibyteAtLimit.records[0]?.bytes, 512_000);
  assert.equal(multibyteAtLimit.pass, true);

  const multibyteOverLimit = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), blobs: { [primary]: Buffer.from("é".repeat(256_001), "utf8") },
  }));
  assert.equal(multibyteOverLimit.records[0]?.bytes, 512_002);
  assert.equal(multibyteOverLimit.pass, false);

  const invalidUtf8 = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), blobs: { [primary]: Buffer.from([0xff]) },
  }));
  assert.equal(invalidUtf8.pass, false);

  const missingBlob = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary]), fail: "blob",
  }));
  assert.equal(missingBlob.pass, false);

  const missingCommit = runWorkflowSizeGate("fixture", "a".repeat(40), fakeWorkflowSizeIo({ fail: "commit" }));
  assert.equal(missingCommit.pass, false);

  const unresolvedIndex = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    unmerged: Buffer.from("100644 missing 1\tconflicted.txt\0", "utf8"),
  }));
  assert.equal(unresolvedIndex.pass, false);

  const enumerationFailure = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({ fail: "enumeration" }));
  assert.equal(enumerationFailure.pass, false);

  const readFailure = runWorkflowSizeGate("fixture", undefined, fakeWorkflowSizeIo({ fail: "read" }));
  assert.equal(readFailure.pass, false);

  const secondary = ".github/workflows/secondary.yaml";
  const addedWorkflow = ".github/workflows/added.yml";
  const copiedWorkflow = ".github/workflows/copied.yaml";
  const mixedWorkflows = runWorkflowSizeGate("fixture", "INDEX", fakeWorkflowSizeIo({
    diff: nameStatusZ(["M", primary], ["A", addedWorkflow], ["R100", ".github/workflows/old.yml", secondary], ["C100", ".github/workflows/source.yml", copiedWorkflow]),
    blobs: {
      [primary]: Buffer.from("valid", "utf8"),
      [addedWorkflow]: Buffer.from("added", "utf8"),
      [secondary]: Buffer.alloc(512_001, 0x61),
      [copiedWorkflow]: Buffer.from("copied", "utf8"),
    },
  }));
  assert.equal(mixedWorkflows.records.some((record) => record.path === secondary), true);
  assert.equal(mixedWorkflows.records.some((record) => record.path === addedWorkflow), true);
  assert.equal(mixedWorkflows.records.some((record) => record.path === copiedWorkflow), true);
  assert.equal(mixedWorkflows.pass, false);

  const rootWorkflow = (revision: string) => execFileSync("git", ["cat-file", "blob", revision + ":" + workflowSizePath], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const originalWorkflow = rootWorkflow(originalWorkflowHead);
  assert.equal(originalWorkflow.length, 500_368);
  assert.equal(workflowSizeRecord(workflowSizePath, originalWorkflow, originalWorkflowHead, "historical-blob").verdict, "PASS");
  const run089Workflow = rootWorkflow(run089Head);
  assert.equal(run089Workflow.length, 517_745);
  assert.equal(workflowSizeRecord(workflowSizePath, run089Workflow, run089Head, "run089-blob").verdict, "REJECT");
  assert.equal(runWorkflowSizeGate(root, originalWorkflowHead).pass, true);
  assert.equal(runWorkflowSizeGate(root, run089Head).pass, false);
});

test("workflow runs the successor proof boundary and no deleted local-broker helper", () => {
  const root = resolve(process.cwd());
  const workflow = readFileSync(join(root, workflowSizePath), "utf8").replace(/\r\n/g, "\n");
  const service = readFileSync(join(root, "src/lib/s8.ts"), "utf8");
  const store = readFileSync(join(root, "src/lib/store.ts"), "utf8");
  const proof = readFileSync(join(root, "src/lib/s8-native-proof.ts"), "utf8");
  for (const retiredPath of [
    "scripts/s8/s8_application_boundary_proof.mts",
    "scripts/s8/s8_application_boundary_proof.sh",
    "scripts/s8/s8_runtime_sensitivity.py",
  ]) assert.equal(workflow.includes(retiredPath), false, `${retiredPath} must remain deleted and unused`);
  assert.match(workflow, /name: Successor proof boundary guard/u);
  assert.match(workflow, /node --test native\/s8-worker-common\/\*\.test\.mjs native\/s8-worker-gateway\/\*\.test\.mjs native\/s8-worker-launcher\/\*\.test\.mjs/u);
  assert.match(workflow, /run: pnpm test/u);
  assert.match(workflow, /ctest --test-dir "\$RUNNER_TEMP\/s8-runner"/u);
  assert.match(workflow, /ctest --test-dir "\$RUNNER_TEMP\/s8-validator"/u);
  assert.match(workflow, /Secret preflight/u);
  assert.match(workflow, /s8-actionlint/u);
  assert.doesNotMatch(service, /repository\.transact\s*\(/u);
  assert.match(store, /S8_COMMAND_REQUIRED/u);
  for (const command of ["createQueued", "claimQueued", "beginNativeAttempt", "prepareNativeAttempt", "persistNativeAcceptance",
    "persistNativeFailure", "stageAcceptedWriter", "validateAcceptedPair", "promoteValidated", "commitPromoted",
    "recordTerminalFailure", "scheduleRetry", "reclaimPublication", "reconcilePreparedAttempt"]) {
    assert.equal(proof.includes(`"${command}"`), true, `missing repository-owned command ${command}`);
  }
});

test("hosted worker workflow runs exact-head proof and native regressions", () => {
  const workflow = readFileSync(join(resolve(process.cwd()), workflowSizePath), "utf8").replace(/\r\n/g, "\n");
  assert.equal(workerWorkflowSourceIsValid(workflow), true);
  const wrongAction = setupNodeStep.replace(setupNodeAction, "actions/setup-node@deadbeef");
  const inWorkerJob = (mutate: (job: string) => string) => {
    const start = workflow.indexOf(workerJobMarker);
    return workflow.slice(0, start) + mutate(workflow.slice(start));
  };
  assert.equal(workerWorkflowSourceIsValid(workflow.replace(setupNodeStep, wrongAction)), false);
  assert.equal(workerWorkflowSourceIsValid(workflow.replace(setupNodeStep, setupNodeStep.replace("node-version: 22", "node-version: 20"))), false);
  assert.equal(workerWorkflowSourceIsValid(workflow.replace(workerRegressionStep, workerRegressionStep.replace("node --test", "node test"))), false);
  assert.equal(workerWorkflowSourceIsValid(workflow.replace(setupNodeStep, "")), false);
  assert.equal(workerWorkflowSourceIsValid(workflow.replace(workerJobMarker, "")), false);
  assert.equal(workerWorkflowSourceIsValid(inWorkerJob((job) => job.replace(exactHeadStepMarker, ""))), false);
  assert.equal(workerWorkflowSourceIsValid(inWorkerJob((job) => job.replace(setupNodeStep, setupNodeStep + "\n" + setupNodeStep))), false);
  assert.equal(workerWorkflowSourceIsValid(inWorkerJob((job) => job.replace(workerRegressionStep, workerRegressionStep + "\n" + workerRegressionStep))), false);
  const reversed = inWorkerJob((job) => job.replace(exactHeadStepMarker, "VERIFY_BOUNDARY_TEMP")
    .replace("      - name: Setup Node 22", exactHeadStepMarker)
    .replace("VERIFY_BOUNDARY_TEMP", "      - name: Setup Node 22"));
  assert.equal(workerWorkflowSourceIsValid(reversed), false);
});
