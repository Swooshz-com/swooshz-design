import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildS8BlenderSandboxCommand, buildS8ValidatorSandboxCommand, parseS8RunnerReceipt, runS8NativeValidator, S8_SYSTEM_RUNTIME_BIND_PATHS, type S8RunnerLimits, type S8WorkerConfig } from "../src/lib/s8-fbx-worker";
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

test("application sandbox argv uses only the accepted read-only runtime binds and cleared environment", () => {
  assert.equal(S8_SYSTEM_RUNTIME_BIND_PATHS.length, 27);
  assert.equal(new Set(S8_SYSTEM_RUNTIME_BIND_PATHS).size, 27);
  const root = mkdtempSync(join(tmpdir(), "s8-sandbox-"));
  try {
    const sandboxPath = join(root, "sandbox");
    writeFileSync(sandboxPath, "sandbox");
    const workerConfig = { ...config(root), sandboxExecutable: sandboxPath };
    const writer = buildS8BlenderSandboxCommand(workerConfig, root, join(root, "blender"), join(root, "writer.py"), join(root, "export_fbx_bin.py"), join(root, "patch-manifest.json"), join(root, "work"));
    const validator = buildS8ValidatorSandboxCommand(workerConfig, join(root, "validator"), join(root, "work"));
    for (const command of [writer, validator]) {
      for (const flag of ["--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--clearenv"]) {
        assert.equal(command.args.filter((value) => value === flag).length, 1, `${flag} must appear exactly once`);
      }
      for (const [option, value] of [["--uid", "65534"], ["--gid", "65534"], ["--cap-drop", "ALL"], ["--proc", "/proc"], ["--dev", "/dev"], ["--tmpfs", "/tmp"], ["--chdir", "/work"]] as const) {
        assert.equal(command.args.filter((argument, index) => argument === option && command.args[index + 1] === value).length, 1, `${option} ${value} must appear exactly once`);
      }
      assert.equal(command.args.filter((value) => value === "--setenv" || value.startsWith("--setenv=")).length, 0);
      const bindPairs = command.args.flatMap((option, index, values) => option.includes("bind") ? [{ option, source: values[index + 1], destination: values[index + 2] }] : []);
      const broadRuntimePaths = new Set(["/", "/usr", "/lib", "/lib64", "/etc"]);
      assert.equal(bindPairs.some(({ source, destination }) => broadRuntimePaths.has(source ?? "") || broadRuntimePaths.has(destination ?? "")), false);
      const identityBinds = bindPairs.filter(({ source, destination }) => source === destination);
      assert.ok(identityBinds.every(({ option }) => option === "--ro-bind"));
      assert.deepEqual(identityBinds.map(({ source }) => source), [...S8_SYSTEM_RUNTIME_BIND_PATHS]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const workflowSizeBase = "578ac98aa974fa0ec3a65bcade1c505ac5c80dcb";
const workflowSizeLimitBytes = 512_000;
const workflowSizePath = ".github/workflows/s8-fbx.yml";
const workflowProofHelperPath = "scripts/s8/s8_application_boundary_proof.mts";
const workflowProofHelperBytes = 7_531;
const workflowProofHelperSha256 = "53a696c1821c9a9057201ebb2180337ac9e67e95b72bb56e70e0e549114c275f";
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

const helperInstallLine = '/usr/bin/install -m 0600 -- "$GITHUB_WORKSPACE/scripts/s8/s8_application_boundary_proof.mts" "$app_proof"';
const helperExecutionLine = '/usr/bin/pnpm exec tsx "$app_proof"';

function helperExtractionIsValid(workflow: string, helper: Buffer | undefined): boolean {
  if (!helper || helper.length !== workflowProofHelperBytes) return false;
  let helperText: string;
  try {
    helperText = decodeUtf8Strict(helper);
  } catch {
    return false;
  }
  const helperHash = createHash("sha256").update(helper).digest("hex");
  return !helperText.includes("\r")
    && helperHash === workflowProofHelperSha256
    && workflow.split(helperInstallLine).length - 1 === 1
    && workflow.split(helperExecutionLine).length - 1 === 1
    && !workflow.includes('cat > "$app_proof" <<\'TS\'');
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

test("workflow application proof helper extraction and the two runtime consumers remain exact", () => {
  const root = resolve(process.cwd());
  const workflow = readFileSync(join(root, workflowSizePath), "utf8");
  const helper = readFileSync(join(root, workflowProofHelperPath));
  assert.equal(helperExtractionIsValid(workflow, helper), true);
  assert.equal(workflow.split(workflowProofHelperPath).length - 1, 2);
  assert.equal(workflow.split(helperInstallLine).length - 1, 1);
  assert.equal(workflow.split(helperExecutionLine).length - 1, 1);
  assert.equal(helperExtractionIsValid(workflow, undefined), false);

  const altered = Buffer.from(helper);
  altered[0] = altered[0]! ^ 1;
  assert.equal(helperExtractionIsValid(workflow, altered), false);
  assert.equal(helperExtractionIsValid(workflow.replace(helperInstallLine, ""), helper), false);
  assert.equal(helperExtractionIsValid(workflow.replace(helperExecutionLine, ""), helper), false);
  assert.equal(helperExtractionIsValid(workflow + "\n" + helperExecutionLine, helper), false);
  assert.equal(helperExtractionIsValid(workflow + '\ncat > "$app_proof" <<\'TS\'', helper), false);
});
