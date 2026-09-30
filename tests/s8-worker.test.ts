import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { S8ExportService } from "../src/lib/s8";
import { S8_FBX_PROFILE, S8_PROTOCOL_VERSION } from "../src/lib/s8-fbx-profile";
import { JsonRepository } from "../src/lib/store";
import { readS8RuntimeConfig } from "../src/lib/s8-fbx-config";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../src/lib/s8-native-admission";
import { jcs, sha256 } from "../src/lib/utils";
import { createS8NativeRequestFrame, S8NativeSignedFailure } from "../src/lib/s8-native-protocol";
import { S8NativeWorkerClient } from "../src/lib/s8-native-worker-client";
import type { S8NativeWorkerConfig } from "../src/lib/s8-fbx-config";

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


const prepublicationJobMarker = "  s8-native-prepublication:";
const exactHeadStepMarker = "      - name: Verify exact PR head";
const setupNodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const pinnedPnpm = "corepack pnpm@12.6.0";
const focusedTypescript = "tests/s8-native-admission.test.ts tests/s8-native-release.test.ts tests/s8-native-policy-crosscheck.test.ts tests/s8-publication.test.ts tests/s8-worker.test.ts";
const focusedNative = "native/s8-worker-common/protocol.test.mjs native/s8-worker-common/admission.test.mjs native/s8-worker-launcher/capacity.test.mjs native/s8-worker-launcher/ledger.test.mjs native/s8-worker-launcher/container-runtime.test.mjs native/s8-worker-launcher/result.test.mjs native/s8-worker-gateway/gateway.test.mjs";

function countText(source: string, value: string): number {
  return source.split(value).length - 1;
}

function nativePrepublicationSourceIsValid(workflow: string): boolean {
  const source = workflow.replace(/\r\n/g, "\n");
  if (countText(source, prepublicationJobMarker) !== 1) return false;
  const start = source.indexOf(prepublicationJobMarker);
  const job = source.slice(start);
  const forbiddenClaims = [
    "G3_RESULT=",
    "G4_AUTHORISED=YES",
    "NATIVE_OPEN_PROVEN=YES",
    "REAL_ROOTLESS_DOCKER_ENFORCEMENT=PASS",
    "REAL_HOST_CONTENTION=PASS",
    "APPARMOR_HOST_ENFORCEMENT=PASS",
  ];
  if (forbiddenClaims.some((claim) => job.includes(claim))) return false;
  const required = [
    "name: S8 native worker repository prepublication",
    "runs-on: ubuntu-24.04",
    "timeout-minutes: 25",
    "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "ref: ${{ github.event.pull_request.head.sha }}",
    exactHeadStepMarker,
    "EXPECTED_HEAD: ${{ github.event.pull_request.head.sha }}",
    'run: test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"',
    setupNodeAction,
    "node-version: 22",
    'COREPACK_ENABLE_AUTO_PIN: "0"',
    pinnedPnpm + " --version",
    pinnedPnpm + " install --frozen-lockfile --ignore-scripts --prod=false",
    pinnedPnpm + ' exec tsx "$smoke"',
    pinnedPnpm + " exec tsx --test " + focusedTypescript,
    "node --test " + focusedNative,
    "git status --porcelain=v1 --untracked-files=all",
    "status_before=",
    "status_after=",
    "trap ",
    "set -Eeuo pipefail",
    "HOSTED_SCOPE=REPOSITORY_ONLY",
    "NATIVE_OPEN_PROVEN=NO",
    "REAL_HOST_PROOFS=DEFERRED_TO_ISSUE_70",
  ];
  const unpinnedPackageManager = job.replaceAll(pinnedPnpm, "").replaceAll("pnpm-lock.yaml", "");
  const hostOperations = /\\b(?:docker|systemctl|sysctl|apparmor_parser|aa-enforce|aa-disable|mount|umount)\\b/iu;
  return required.every((value) => job.includes(value))
    && !/\\bpnpm\\b/u.test(unpinnedPackageManager)
    && !hostOperations.test(job)
    && job.indexOf(exactHeadStepMarker) < job.indexOf("Setup Node 22 for hosted toolchain")
    && job.indexOf("status_after=") > job.indexOf("node --test " + focusedNative);
}

function mutatePrepublicationJob(workflow: string, mutate: (job: string) => string): string {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(prepublicationJobMarker);
  if (start < 0) return normalized;
  return normalized.slice(0, start) + mutate(normalized.slice(start));
}

test("native prepublication workflow proves only the repository contract on the exact PR head", () => {
  const root = resolve(process.cwd());
  const workflow = readFileSync(join(root, workflowSizePath), "utf8");
  assert.equal(nativePrepublicationSourceIsValid(workflow), true);
  for (const path of [
    "tests/s8-native-admission.test.ts",
    "tests/s8-native-release.test.ts",
    "tests/s8-native-policy-crosscheck.test.ts",
    "tests/s8-publication.test.ts",
    "tests/s8-worker.test.ts",
    "native/s8-worker-common/protocol.test.mjs",
    "native/s8-worker-common/admission.test.mjs",
    "native/s8-worker-launcher/capacity.test.mjs",
    "native/s8-worker-launcher/ledger.test.mjs",
    "native/s8-worker-launcher/container-runtime.test.mjs",
    "native/s8-worker-launcher/result.test.mjs",
    "native/s8-worker-gateway/gateway.test.mjs",
  ]) assert.equal(workflow.includes(path), true, path);

  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace(setupNodeAction, "actions/setup-node@deadbeef"))), false);
  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace("node-version: 22", "node-version: 20"))), false);
  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace("install --frozen-lockfile", "install"))), false);
  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace("tests/s8-native-release.test.ts ", ""))), false);
  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace("status_after=", ""))), false);
  assert.equal(nativePrepublicationSourceIsValid(mutatePrepublicationJob(workflow, (job) => job.replace("NATIVE_OPEN_PROVEN=NO", "NATIVE_OPEN_PROVEN=YES"))), false);
  assert.equal(nativePrepublicationSourceIsValid(workflow + "\n" + prepublicationJobMarker), false);
});

test("legacy broker, Bubblewrap, helper, and deployment routes are not product-selectable", () => {
  const root = resolve(process.cwd());
  const app = readFileSync(join(root, "src/lib/s8.ts"), "utf8");
  const workerClient = readFileSync(join(root, "src/lib/s8-native-worker-client.ts"), "utf8");
  const configSource = readFileSync(join(root, "src/lib/s8-fbx-config.ts"), "utf8");
  const workflow = readFileSync(join(root, workflowSizePath), "utf8");
  const brokerReadme = readFileSync(join(root, "native/s8-sandbox-broker/README.md"), "utf8");

  assert.match(app, /import type .*from "\.\/s8-fbx-worker"/u);
  assert.doesNotMatch(app, /import\s+\{[^}]*\}\s+from "\.\/s8-fbx-worker"/su);
  assert.doesNotMatch(app, /(?:createS8BrokerRequest|parseS8BrokerResponse|runS8NativeValidator|sandboxExecutable)/u);
  assert.match(workerClient, /import type .*from "\.\/s8-fbx-worker"/u);
  assert.doesNotMatch(workerClient, /(?:createS8BrokerRequest|parseS8BrokerResponse|runS8NativeValidator|brokerIdentity:|brokerMetadata:|execFile|spawn\()/u);
  assert.match(workerClient, /from "node:https"/u);
  assert.match(app, /NODE_ENV === "production" && options\.adapters/u);
  assert.match(app, /fail\(503, "S8_WORKER_ADMISSION_CLOSED"\)/u);
  assert.doesNotMatch(configSource, /(?:S8_APP_SANDBOX|BUBBLEWRAP|S8_BROKER_SOCKET|ROOT_BROKER)/iu);
  assert.doesNotMatch(workflow, /s8-pinned-blender|s8_application_boundary_proof|Bubblewrap|s8_runtime_sensitivity|broker-recover|s8-sandbox/u);
  assert.match(workflow, /s8-native-prepublication/u);
  assert.match(workflow, /s8-actionlint/u);
  assert.match(workflow, /s8-static/u);
  assert.match(workflow, /s8-native:/u);
  assert.match(brokerReadme, /historical reference only/u);
  assert.match(brokerReadme, /not used by the application, deployment, or active CI/u);

  for (const path of [
    "scripts/s8/s8_application_boundary_proof.mts",
    "scripts/s8/s8_application_boundary_proof.sh",
    "scripts/s8/s8_runtime_sensitivity.py",
    "native/s8-sandbox-broker/deploy/s8-sandbox",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in",
  ]) assert.equal(existsSync(join(root, path)), false, path);
});

test("a persisted UNKNOWN native attempt globally overrides a fresh OPEN worker admission observation", async () => {
  let admissionReads = 0;
  const open = { state: "OPEN" as const, reason: null, proofSha256: "a".repeat(64), observedAt: "2026-09-29T00:00:00.000Z" };
  const blocked = new S8ExportService({
    repository: { state: () => ({ s8NativeOperationAttempts: [{ state: "UNKNOWN", projectId: "another-project" }] }) },
    admissionReader: async () => { admissionReads += 1; return open; },
  } as never);

  assert.deepEqual(await blocked.getAdmissionStatus(), {
    state: "CLOSED",
    reason: "OBSERVATION_INVALID",
    proofSha256: null,
    observedAt: null,
  });
  assert.equal(admissionReads, 0);

  const reconciled = new S8ExportService({
    repository: { state: () => ({ s8NativeOperationAttempts: [{ state: "FAILED" }, { state: "SUCCEEDED" }] }) },
    admissionReader: async () => open,
  } as never);
  assert.deepEqual(await reconciled.getAdmissionStatus(), open);
});
test("partial native configuration is absent or invalid and production adapters fail closed", () => {
  assert.equal(readS8RuntimeConfig({}), undefined);
  assert.throws(() => readS8RuntimeConfig({ S8_WORKER_GATEWAY_URL: "https://s8-worker-gateway.internal" }), /S8_NATIVE_WORKER_CONFIG_INVALID/u);

  const environment = process.env as unknown as Record<string, string | undefined>;
  const previous = environment.NODE_ENV;
  environment.NODE_ENV = "production";
  try {
    const options = { adapters: { writer: () => { throw new Error("unexpected writer adapter call"); }, nativeValidator: () => { throw new Error("unexpected validator adapter call"); } } };
    assert.throws(() => new S8ExportService(options as never), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "S8_WORKER_ADMISSION_CLOSED");
      return true;
    });
  } finally {
    if (previous === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = previous;
  }
});


test("UNKNOWN arriving during admission read closes the decision after the await", async () => {
  const state: { s8NativeOperationAttempts: Array<{ state: string }> } = { s8NativeOperationAttempts: [] };
  const open = { state: "OPEN" as const, reason: null, proofSha256: "a".repeat(64), observedAt: "2026-09-29T00:00:00.000Z" };
  let markStarted!: () => void;
  let resolveRead!: (value: typeof open) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const read = new Promise<typeof open>((resolve) => { resolveRead = resolve; });
  const service = new S8ExportService({
    repository: { state: () => state },
    admissionReader: async () => { markStarted(); return read; },
  } as never);

  const pending = service.getAdmissionStatus();
  await started;
  state.s8NativeOperationAttempts.push({ state: "UNKNOWN" });
  resolveRead(open);
  assert.deepEqual(await pending, {
    state: "CLOSED",
    reason: "OBSERVATION_INVALID",
    proofSha256: null,
    observedAt: null,
  });
});

test("the final native preparation transaction blocks a concurrent UNKNOWN before request dispatch", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const artifactId = "33333333-3333-4333-8333-333333333333";
  const claimToken = "44444444-4444-4444-8444-444444444444";
  const context = { projectId, jobId, artifactId, claimToken, attempt: 1, source: {}, payload: {}, onHeartbeat: () => {} };
  const state = {
    s8ExportJobs: [{ jobId, projectId, artifactId, status: "running", claimToken, ownerId: "test-owner", ownerProcessId: 1234, attempt: 1 }],
    s8NativeOperationAttempts: [] as Array<Record<string, unknown>>,
  };
  const repository = {
    state: () => state,
    transact: (update: (value: typeof state) => void) => update(state),
  };
  const service = new S8ExportService({ repository, ownerId: "test-owner", processId: 1234 } as never);
  const methods = service as unknown as {
    beginNativeAttempt: (context: never, operation: "WRITER" | "VALIDATOR", inputSha256: string) => string;
    prepareNativeAttempt: (attemptId: string, requestSha256: string, requestNonce: string, releaseManifestSha256: string) => void;
  };
  const attemptId = methods.beginNativeAttempt(context as never, "WRITER", "b".repeat(64));
  state.s8NativeOperationAttempts.push({ state: "UNKNOWN" });

  let gatewayPostCount = 0;
  assert.throws(() => {
    methods.prepareNativeAttempt(attemptId, "c".repeat(64), "d".repeat(43), "e".repeat(64));
    gatewayPostCount += 1;
  }, (error: unknown) => (error as { code?: string }).code === "S8_WORKER_ADMISSION_CLOSED");
  assert.equal(gatewayPostCount, 0);
  assert.throws(() => methods.beginNativeAttempt(context as never, "VALIDATOR", "f".repeat(64)),
    (error: unknown) => (error as { code?: string }).code === "S8_WORKER_ADMISSION_CLOSED");
});

test("an OPEN worker with no UNKNOWN attempt permits exactly one prepared native dispatch", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  const artifactId = "33333333-3333-4333-8333-333333333333";
  const claimToken = "44444444-4444-4444-8444-444444444444";
  const context = { projectId, jobId, artifactId, claimToken, attempt: 1, source: {}, payload: {}, onHeartbeat: () => {} };
  const state = {
    s8ExportJobs: [{ jobId, projectId, artifactId, status: "running", claimToken, ownerId: "test-owner", ownerProcessId: 1234, attempt: 1 }],
    s8NativeOperationAttempts: [] as Array<Record<string, unknown>>,
  };
  const open = { state: "OPEN" as const, reason: null, proofSha256: "a".repeat(64), observedAt: "2026-09-29T00:00:00.000Z" };
  const repository = {
    state: () => state,
    transact: (update: (value: typeof state) => void) => update(state),
  };
  const service = new S8ExportService({
    repository,
    ownerId: "test-owner",
    processId: 1234,
    admissionReader: async () => open,
  } as never);
  assert.deepEqual(await service.getAdmissionStatus(), open);

  const methods = service as unknown as {
    beginNativeAttempt: (context: never, operation: "WRITER" | "VALIDATOR", inputSha256: string) => string;
    prepareNativeAttempt: (attemptId: string, requestSha256: string, requestNonce: string, releaseManifestSha256: string) => void;
  };
  const attemptId = methods.beginNativeAttempt(context as never, "WRITER", "b".repeat(64));
  methods.prepareNativeAttempt(attemptId, "c".repeat(64), "d".repeat(43), "e".repeat(64));
  let gatewayPostCount = 0;
  gatewayPostCount += 1;

  assert.equal(state.s8NativeOperationAttempts.length, 1);
  assert.equal(state.s8NativeOperationAttempts[0].state, "DISPATCHING");
  assert.equal(gatewayPostCount, 1);
});

test("native response received at the shared operation deadline is rejected even when its signature is valid", async () => {
  const appKeys = generateKeyPairSync("ed25519");
  const launcherKeys = generateKeyPairSync("ed25519");
  const appPrivateKey = appKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const launcherPublicKey = launcherKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const releaseManifestSha256 = "a".repeat(64);
  const executableSha256 = "4".repeat(64);
  const imageDigest = "sha256:" + "3".repeat(64);
  const release = {
    writer: { imageDigest: "sha256:" + "1".repeat(64), writerScriptSha256: "2".repeat(64) },
    validator: { imageDigest, executableSha256 },
    processRunnerSha256: "5".repeat(64),
  };
  const config = {
    gatewayUrl: "https://gateway.invalid",
    appSigningKeyId: "app-2026",
    appSigningPrivateKeyPem: appPrivateKey,
    releaseManifest: {},
    releaseAuthorityKeys: {},
    capacityAuthorityKeys: {},
    launcherKeys: { "launcher-2026": launcherPublicKey },
    tlsCaPem: undefined,
    tlsClientCertPem: undefined,
    tlsClientKeyPem: undefined,
  } as unknown as S8NativeWorkerConfig;
  const payload = Buffer.from("native validator input");
  const context = {
    projectId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    attempt: 1,
    source: { revision: "test" },
    inputSha256: sha256(payload),
  };
  const releaseHandle = "r".repeat(43);
  const expectedDeadlineUnixMs = 1000 + 330_000;
  let nowMs = 1000;
  let deliverLate = false;
  let dispatchCount = 0;
  const makeResponseFrame = (frame: ReturnType<typeof createS8NativeRequestFrame>): Buffer => {
    const output = Buffer.from("validated-readback");
    const auxiliary = Buffer.alloc(0);
    const request = frame.request.body;
    const body = {
      schemaVersion: "s8-native-response-v1",
      launcherKeyId: "launcher-2026",
      requestSha256: frame.requestSha256,
      projectId: request.projectId,
      jobId: request.jobId,
      artifactId: request.artifactId,
      attempt: request.attempt,
      operation: request.operation,
      sourceSha256: request.sourceSha256,
      releaseManifestSha256,
      imageDigest,
      containerId: "d".repeat(64),
      inputSha256: request.inputSha256,
      inputBytes: payload.length,
      outputSha256: sha256(output),
      outputBytes: output.length,
      auxiliarySha256: sha256(auxiliary),
      auxiliaryBytes: auxiliary.length,
      exitClass: "EXIT_0",
      limitProfileSha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
      disposalState: "REAPED_REMOVED",
      releaseHandle,
      validatorIdentity: "s8-validator-sha256:" + executableSha256,
      runnerEvidence: null,
    };
    const signature = sign(null, Buffer.concat([
      Buffer.from("S8-NATIVE-RESPONSE-V1\0", "ascii"),
      Buffer.from(jcs(body), "utf8"),
    ]), launcherKeys.privateKey).toString("base64url");
    const header = Buffer.from(jcs({ body, signature }), "utf8");
    const frameBytes = Buffer.alloc(4 + header.length + 8 + output.length + 8 + auxiliary.length);
    frameBytes.writeUInt32BE(header.length, 0);
    header.copy(frameBytes, 4);
    frameBytes.writeBigUInt64BE(BigInt(output.length), 4 + header.length);
    output.copy(frameBytes, 4 + header.length + 8);
    frameBytes.writeBigUInt64BE(BigInt(auxiliary.length), 4 + header.length + 8 + output.length);
    return frameBytes;
  };
  const operationRequest = async (
    _url: URL,
    _agent: object,
    frame: ReturnType<typeof createS8NativeRequestFrame>,
    _payload: Buffer,
    _maximumResponseBytes: number,
    _timeoutMs: number,
    _heartbeat: () => void,
    requestDeadlineUnixMs: number,
  ): Promise<{ statusCode: number; bytes: Buffer }> => {
    assert.equal(frame.request.body.deadlineUnixMs, expectedDeadlineUnixMs);
    assert.equal(requestDeadlineUnixMs, expectedDeadlineUnixMs);
    dispatchCount += 1;
    nowMs = deliverLate ? expectedDeadlineUnixMs : expectedDeadlineUnixMs - 1;
    return { statusCode: 200, bytes: makeResponseFrame(frame) };
  };
  const worker = new S8NativeWorkerClient(config, async () => Buffer.alloc(0), () => nowMs, operationRequest as never);
  const probe = worker as unknown as {
    requireVerifiedOpen: (deadline: number) => Promise<{ releaseManifestSha256: string; release: typeof release }>;
    runOperation: (
      operation: "VALIDATOR",
      payload: Buffer,
      context: { projectId: string; jobId: string; artifactId: string; attempt: number; source: unknown; inputSha256: string },
      releaseHandle: string,
      heartbeat: () => void,
      expectedReleaseManifestSha256: string,
      onRequestPrepared: (requestSha256: string, requestNonce: string, releaseManifestSha256: string, deadline: number) => void,
      deadline?: number,
    ) => Promise<{ requestSha256: string }>;
  };
  let admissionDeadline = 0;
  probe.requireVerifiedOpen = async (deadline) => {
    admissionDeadline = deadline;
    nowMs = 1050;
    return { releaseManifestSha256, release };
  };
  let preparedDeadline = 0;
  const accepted = await probe.runOperation("VALIDATOR", payload, context, releaseHandle, () => {}, releaseManifestSha256,
    (_requestSha256, _nonce, _manifestSha256, deadline) => { preparedDeadline = deadline; });
  assert.equal(accepted.requestSha256.length, 64);
  assert.equal(dispatchCount, 1);
  assert.equal(admissionDeadline, expectedDeadlineUnixMs);
  assert.equal(preparedDeadline, expectedDeadlineUnixMs);

  nowMs = 1000;
  deliverLate = true;
  preparedDeadline = 0;
  await assert.rejects(
    probe.runOperation("VALIDATOR", payload, context, releaseHandle, () => {}, releaseManifestSha256,
      (_requestSha256, _nonce, _manifestSha256, deadline) => { preparedDeadline = deadline; }),
    /S8_NATIVE_OPERATION_TIMEOUT/u,
  );
  assert.equal(dispatchCount, 2);
  assert.equal(admissionDeadline, expectedDeadlineUnixMs);
  assert.equal(preparedDeadline, expectedDeadlineUnixMs);
});

test("writer deadline fence prevents a late durable success and permits an in-deadline success once", async () => {
  const originalDateNow = Date.now;
  const projectId = "11111111-1111-4111-8111-111111111111";
  const sourceRevisionId = "22222222-2222-4222-8222-222222222222";
  const s6ValidationReceiptId = "33333333-3333-4333-8333-333333333333";
  const s7ArtifactId = "44444444-4444-4444-8444-444444444444";
  const s7ManifestId = "55555555-5555-4555-8555-555555555555";
  const jobId = "66666666-6666-4666-8666-666666666666";
  const artifactId = "77777777-7777-4777-8777-777777777777";
  const claimToken = "88888888-8888-4888-8888-888888888888";
  const source = {
    projectId,
    sourceRevisionId,
    sourceRevisionHash: "a".repeat(64),
    sourceS5Fingerprint: "b".repeat(64),
    s6ValidationReceiptId,
    s6ValidationHash: "c".repeat(64),
    s6HandoffDigest: "d".repeat(64),
    s7ArtifactId,
    s7ArtifactHash: "e".repeat(64),
    s7ReadbackHash: "f".repeat(64),
    s7ManifestId,
    s7ManifestHash: "1".repeat(64),
    s8Profile: S8_FBX_PROFILE,
    s8ProtocolVersion: S8_PROTOCOL_VERSION,
  } as const;
  const now = "2026-09-30T00:00:00.000Z";
  const fixtureRoots: string[] = [];

  const makeFixture = (advanceAtCommitFence: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "s8-writer-deadline-"));
    fixtureRoots.push(root);
    let nowMs = 10_000;
    let fenceDeadline = 0;
    let advanceFence = false;
    const repository = new JsonRepository(root, {
      syncDirectory: () => {},
      beforeCommit: () => {
        if (!advanceFence) return;
        advanceFence = false;
        nowMs = fenceDeadline;
      },
    });
    repository.transact((state) => {
      state.s8ExportJobs!.push({
        schemaVersion: "s8-export-job-v2",
        jobId, projectId, artifactId, source, inputHash: "2".repeat(64), idempotencyKey: "deadline-fence-test",
        status: "running", publicationPhase: "private_staging", attempt: 1, claimToken, ownerId: "test-owner", ownerProcessId: 1234,
        claimedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now, terminalAt: null, failureCode: null,
      });
      state.s8Artifacts!.push({
        schemaVersion: "s8-artifact-v2",
        artifactId, projectId, jobId, source, inputHash: "2".repeat(64), profile: S8_FBX_PROFILE,
        format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx",
        status: "running", publicationPhase: "private_staging", payloadSha256: null, objectHashes: null,
        writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null,
        validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null,
        privateStagingPrefix: "private/projects/test/staging", privateFinalPrefix: "private/projects/test/final",
        attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: now, updatedAt: now, committedAt: null, staleAt: null,
      });
    });
    const service = new S8ExportService({
      repository,
      objects: {} as never,
      s6: {} as never,
      s7: {} as never,
      clock: () => now,
      ownerId: "test-owner",
      processId: 1234,
      admissionReader: async () => ({ state: "OPEN", reason: null, proofSha256: "3".repeat(64), observedAt: now }),
    });
    let dispatchCount = 0;
    const nativeWorker = {
      runWriter: async (
        _payload: Buffer,
        _context: unknown,
        _heartbeat: () => void,
        onRequestPrepared: (requestSha256: string, requestNonce: string, manifestSha256: string, deadline: number) => void,
        _deadline: number,
      ) => {
        dispatchCount += 1;
        onRequestPrepared("4".repeat(64), "n".repeat(43), "5".repeat(64), _deadline);
        if (advanceAtCommitFence) {
          fenceDeadline = _deadline;
          nowMs = _deadline - 1;
          advanceFence = true;
        } else {
          nowMs = _deadline - 1;
        }
        return {
          nativeRequestSha256: "4".repeat(64),
          nativeResponseSha256: "6".repeat(64),
          releaseManifestSha256: "5".repeat(64),
        } as never;
      },
    };
    (service as unknown as { nativeWorker: typeof nativeWorker }).nativeWorker = nativeWorker;
    const context = { projectId, jobId, artifactId, claimToken, attempt: 1, source, payload: {}, onHeartbeat: () => {} };
    const write = (service as unknown as { writer: (payload: Buffer, context: never) => Promise<unknown> }).writer;
    return { root, repository, service, nowMs: () => nowMs, dispatchCount: () => dispatchCount, write: () => write.call(service, Buffer.from("native writer input"), context as never) };
  };

  try {
    const late = makeFixture(true);
    Date.now = () => late.nowMs();
    await assert.rejects(late.write(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "S8_NATIVE_OPERATION_TIMEOUT");
      return true;
    });
    assert.equal(late.dispatchCount(), 1, "timeout must not trigger a retry");
    const lateReload = new JsonRepository(late.root);
    const lateState = lateReload.state();
    assert.equal(lateState.s8NativeOperationAttempts?.length, 1);
    assert.equal(lateState.s8NativeOperationAttempts?.[0]?.state, "UNKNOWN");
    assert.equal(lateState.s8NativeOperationAttempts?.some((attempt) => attempt.state === "SUCCEEDED"), false);
    assert.equal(lateState.s8Artifacts?.[0]?.status, "running");
    assert.equal(lateState.s8Artifacts?.[0]?.objectHashes, null);
    assert.equal(lateState.s8Artifacts?.[0]?.committedAt, null);

    const withinDeadline = makeFixture(false);
    Date.now = () => withinDeadline.nowMs();
    const accepted = await withinDeadline.write();
    assert.ok(accepted);
    assert.equal(withinDeadline.dispatchCount(), 1);
    const successReload = new JsonRepository(withinDeadline.root);
    const successState = successReload.state();
    assert.equal(successState.s8NativeOperationAttempts?.length, 1);
    assert.equal(successState.s8NativeOperationAttempts?.filter((attempt) => attempt.state === "SUCCEEDED").length, 1);
    assert.equal(successState.s8NativeOperationAttempts?.[0]?.disposalState, "REAPED_REMOVED");
    assert.equal(successState.s8Artifacts?.[0]?.objectHashes, null);
  } finally {
    Date.now = originalDateNow;
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  }
});
test("a bound signed transient survives persistence, retries once, and uses a fresh signed attempt", async () => {
  const appKeys = generateKeyPairSync("ed25519");
  const launcherKeys = generateKeyPairSync("ed25519");
  const appPrivateKey = appKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const launcherPublicKey = launcherKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const releaseManifestSha256 = "a".repeat(64);
  const release = {
    writer: { imageDigest: "sha256:" + "1".repeat(64), writerScriptSha256: "2".repeat(64) },
    validator: { imageDigest: "sha256:" + "3".repeat(64), executableSha256: "4".repeat(64) },
    processRunnerSha256: "5".repeat(64),
  };
  const config = {
    gatewayUrl: "https://gateway.invalid",
    appSigningKeyId: "app-2026",
    appSigningPrivateKeyPem: appPrivateKey,
    releaseManifest: {},
    releaseAuthorityKeys: {},
    capacityAuthorityKeys: {},
    launcherKeys: { "launcher-2026": launcherPublicKey },
    tlsCaPem: undefined,
    tlsClientCertPem: undefined,
    tlsClientKeyPem: undefined,
  } as unknown as S8NativeWorkerConfig;
  const source = {
    projectId: "11111111-1111-4111-8111-111111111111",
    sourceRevisionId: "22222222-2222-4222-8222-222222222222",
    sourceRevisionHash: "a".repeat(64),
    sourceS5Fingerprint: "b".repeat(64),
    s6ValidationReceiptId: "33333333-3333-4333-8333-333333333333",
    s6ValidationHash: "c".repeat(64),
    s6HandoffDigest: "d".repeat(64),
    s7ArtifactId: "44444444-4444-4444-8444-444444444444",
    s7ArtifactHash: "e".repeat(64),
    s7ReadbackHash: "f".repeat(64),
    s7ManifestId: "55555555-5555-4555-8555-555555555555",
    s7ManifestHash: "1".repeat(64),
    s8Profile: S8_FBX_PROFILE,
    s8ProtocolVersion: S8_PROTOCOL_VERSION,
  } as const;
  const projectId = source.projectId;
  const jobId = "66666666-6666-4666-8666-666666666666";
  const artifactId = "77777777-7777-4777-8777-777777777777";
  const claimToken = "88888888-8888-4888-8888-888888888888";
  const stagingPrefix = "private/projects/test/staging";
  const now = "2026-09-30T00:00:00.000Z";
  const payload = Buffer.from("native writer input");
  const root = mkdtempSync(join(tmpdir(), "s8-transient-retry-"));

  try {
    const repository = new JsonRepository(root, { syncDirectory: () => {} });
    repository.transact((state) => {
      state.s8ExportJobs!.push({
        schemaVersion: "s8-export-job-v2",
        jobId, projectId, artifactId, source, inputHash: "2".repeat(64), idempotencyKey: "transient-retry-test",
        status: "running", publicationPhase: "private_staging", attempt: 1, claimToken, ownerId: "test-owner", ownerProcessId: 1234,
        claimedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now, terminalAt: null, failureCode: null,
      });
      state.s8Artifacts!.push({
        schemaVersion: "s8-artifact-v2",
        artifactId, projectId, jobId, source, inputHash: "2".repeat(64), profile: S8_FBX_PROFILE,
        format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx",
        status: "running", publicationPhase: "private_staging", payloadSha256: null, objectHashes: null,
        writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null,
        validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null,
        privateStagingPrefix: stagingPrefix, privateFinalPrefix: "private/projects/test/final",
        attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: now, updatedAt: now, committedAt: null, staleAt: null,
      });
    });

    let exitClass: "TRANSIENT_INFRASTRUCTURE_FAILURE" | "EXIT_0" = "TRANSIENT_INFRASTRUCTURE_FAILURE";
    const frames: ReturnType<typeof createS8NativeRequestFrame>[] = [];
    const makeResponseFrame = (frame: ReturnType<typeof createS8NativeRequestFrame>): Buffer => {
      const succeeded = exitClass === "EXIT_0";
      const output = succeeded ? Buffer.from("Kaydara FBX Binary  \0" + "0".repeat(40), "ascii") : Buffer.alloc(0);
      const auxiliary = succeeded
        ? Buffer.from(jcs({ writerScriptSha256: release.writer.writerScriptSha256 }), "utf8")
        : Buffer.alloc(0);
      const request = frame.request.body;
      const body = {
        schemaVersion: "s8-native-response-v1",
        launcherKeyId: "launcher-2026",
        requestSha256: frame.requestSha256,
        projectId: request.projectId,
        jobId: request.jobId,
        artifactId: request.artifactId,
        attempt: request.attempt,
        operation: request.operation,
        sourceSha256: request.sourceSha256,
        releaseManifestSha256,
        imageDigest: release.writer.imageDigest,
        containerId: "d".repeat(64),
        inputSha256: request.inputSha256,
        inputBytes: payload.length,
        outputSha256: sha256(output),
        outputBytes: output.length,
        auxiliarySha256: sha256(auxiliary),
        auxiliaryBytes: auxiliary.length,
        exitClass,
        limitProfileSha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
        disposalState: "REAPED_REMOVED",
        releaseHandle: succeeded ? "r".repeat(43) : null,
        validatorIdentity: null,
        runnerEvidence: succeeded ? { runnerBinary: { selfSha256: release.processRunnerSha256 } } : null,
      };
      const signature = sign(null, Buffer.concat([
        Buffer.from("S8-NATIVE-RESPONSE-V1\0", "ascii"),
        Buffer.from(jcs(body), "utf8"),
      ]), launcherKeys.privateKey).toString("base64url");
      const header = Buffer.from(jcs({ body, signature }), "utf8");
      const frameBytes = Buffer.alloc(4 + header.length + 8 + output.length + 8 + auxiliary.length);
      frameBytes.writeUInt32BE(header.length, 0);
      header.copy(frameBytes, 4);
      frameBytes.writeBigUInt64BE(BigInt(output.length), 4 + header.length);
      output.copy(frameBytes, 4 + header.length + 8);
      frameBytes.writeBigUInt64BE(BigInt(auxiliary.length), 4 + header.length + 8 + output.length);
      auxiliary.copy(frameBytes, 4 + header.length + 8 + output.length + 8);
      return frameBytes;
    };
    const operationRequest = async (
      _url: URL,
      _agent: object,
      frame: ReturnType<typeof createS8NativeRequestFrame>,
    ): Promise<{ statusCode: number; bytes: Buffer }> => {
      frames.push(frame);
      return { statusCode: 200, bytes: makeResponseFrame(frame) };
    };
    const nativeWorker = new S8NativeWorkerClient(config, async () => Buffer.alloc(0), () => Date.now(), operationRequest as never);
    const workerInternals = nativeWorker as unknown as {
      requireVerifiedOpen: (deadline: number) => Promise<{ releaseManifestSha256: string; release: typeof release }>;
    };
    workerInternals.requireVerifiedOpen = async (deadline) => {
      assert.ok(deadline > Date.now());
      return { releaseManifestSha256, release };
    };

    const service = new S8ExportService({
      repository,
      objects: {} as never,
      s6: {} as never,
      s7: {} as never,
      clock: () => now,
      ownerId: "test-owner",
      processId: 1234,
      admissionReader: async () => ({ state: "OPEN", reason: null, proofSha256: "3".repeat(64), observedAt: now }),
    });
    const serviceInternals = service as unknown as {
      nativeWorker: S8NativeWorkerClient;
      writer: (payload: Buffer, context: never) => Promise<unknown>;
      scheduleNativeRetry: (jobId: string, claimToken: string, stagingPrefix: string, error: S8NativeSignedFailure) => boolean;
      claim: (jobId: string) => {
        acquired: boolean;
        job: { attempt: number };
        source: { source: unknown };
        claimToken: string | null;
      };
      admitSource: (projectId: string) => { source: unknown };
      requireCurrentSource: (projectId: string, expected: unknown) => void;
      cleanupStaging: (prefix: string) => void;
    };
    serviceInternals.nativeWorker = nativeWorker;
    let sourceFenceCalls = 0;
    serviceInternals.admitSource = (candidateProjectId) => {
      assert.equal(candidateProjectId, projectId);
      return { source };
    };
    serviceInternals.requireCurrentSource = (candidateProjectId, expected) => {
      sourceFenceCalls += 1;
      assert.equal(candidateProjectId, projectId);
      assert.deepEqual(expected, source);
    };
    let cleanupCalls = 0;
    serviceInternals.cleanupStaging = (prefix) => {
      cleanupCalls += 1;
      assert.equal(prefix, stagingPrefix);
    };

    const firstContext = { projectId, jobId, artifactId, claimToken, attempt: 1, source, payload, onHeartbeat: () => {} };
    let signedFailure: unknown;
    await assert.rejects(
      serviceInternals.writer.call(service, payload, firstContext as never),
      (error: unknown) => {
        signedFailure = error;
        return error instanceof S8NativeSignedFailure && error.failureClass === "TRANSIENT";
      },
    );
    assert.ok(signedFailure instanceof S8NativeSignedFailure);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.request.body.attempt, 1);
    assert.equal(frames[0]!.request.signature.length, 86);

    const firstReload = new JsonRepository(root);
    const firstState = firstReload.state();
    assert.equal(firstState.s8NativeOperationAttempts?.length, 1);
    const firstAttempt = firstState.s8NativeOperationAttempts![0]!;
    assert.equal(firstAttempt.state, "FAILED");
    assert.equal(firstAttempt.failureClass, "TRANSIENT");
    assert.equal(firstAttempt.disposalState, "REAPED_REMOVED");
    assert.ok(firstAttempt.completedAt);
    assert.equal(firstAttempt.requestSha256, frames[0]!.requestSha256);
    assert.equal(firstAttempt.requestNonce, frames[0]!.request.body.nonce);
    assert.equal(firstAttempt.responseSha256, (signedFailure as S8NativeSignedFailure).responseSha256);
    assert.equal(firstAttempt.releaseManifestSha256, releaseManifestSha256);

    const invalidTransientMutations = [
      { label: "NOT_STARTED disposal", patch: { disposalState: "NOT_STARTED" } },
      { label: "UNKNOWN disposal", patch: { disposalState: "UNKNOWN" } },
      { label: "missing request hash", patch: { requestSha256: null } },
      { label: "missing request nonce", patch: { requestNonce: null } },
      { label: "missing response hash", patch: { responseSha256: null } },
      { label: "missing release manifest hash", patch: { releaseManifestSha256: null } },
    ] as const;
    for (const invalid of invalidTransientMutations) {
      assert.throws(() => repository.transact((state) => {
        const attempt = state.s8NativeOperationAttempts?.find((item) => item.attemptId === firstAttempt.attemptId);
        assert.ok(attempt);
        Object.assign(attempt, invalid.patch);
      }), (error: unknown) => (error as { code?: string }).code === "PERSISTENCE_FAILED", invalid.label);
      assert.deepEqual(new JsonRepository(root).state().s8NativeOperationAttempts?.[0], firstAttempt, invalid.label);
    }

    const retry = serviceInternals.scheduleNativeRetry(jobId, claimToken, stagingPrefix, signedFailure as S8NativeSignedFailure);
    assert.equal(retry, true);
    assert.equal(serviceInternals.scheduleNativeRetry(jobId, claimToken, stagingPrefix, signedFailure as S8NativeSignedFailure), false);
    assert.equal(sourceFenceCalls, 1);
    assert.equal(cleanupCalls, 1);
    const retriedState = new JsonRepository(root).state();
    assert.equal(retriedState.s8ExportJobs?.[0]?.attempt, 2);
    assert.equal(retriedState.s8ExportJobs?.[0]?.status, "queued");
    assert.equal(retriedState.s8Artifacts?.[0]?.attempt, 2);
    assert.equal(retriedState.s8Artifacts?.[0]?.status, "queued");
    assert.equal(retriedState.s8NativeOperationAttempts?.length, 1);
    assert.equal(retriedState.s8NativeOperationAttempts?.[0]?.requestSha256, firstAttempt.requestSha256);

    const claimed = serviceInternals.claim(jobId);
    assert.equal(claimed.acquired, true);
    assert.equal(claimed.job.attempt, 2);
    assert.ok(claimed.claimToken);
    assert.notEqual(claimed.claimToken, claimToken);
    exitClass = "EXIT_0";
    const secondContext = {
      projectId,
      jobId,
      artifactId,
      claimToken: claimed.claimToken,
      attempt: 2,
      source: claimed.source.source,
      payload,
      onHeartbeat: () => {},
    };
    await serviceInternals.writer.call(service, payload, secondContext as never);

    assert.equal(frames.length, 2);
    assert.equal(frames[1]!.request.body.attempt, 2);
    assert.equal(frames[1]!.request.signature.length, 86);
    assert.equal(frames[1]!.request.body.nonce.length, 43);
    assert.notEqual(frames[1]!.requestSha256, frames[0]!.requestSha256);
    assert.notEqual(frames[1]!.request.body.nonce, frames[0]!.request.body.nonce);
    const finalState = new JsonRepository(root).state();
    assert.equal(finalState.s8NativeOperationAttempts?.length, 2);
    const secondAttempt = finalState.s8NativeOperationAttempts?.find((attempt) => attempt.attempt === 2);
    assert.equal(secondAttempt?.state, "SUCCEEDED");
    assert.equal(secondAttempt?.disposalState, "REAPED_REMOVED");
    assert.equal(secondAttempt?.requestSha256, frames[1]!.requestSha256);
    assert.equal(secondAttempt?.requestNonce, frames[1]!.request.body.nonce);
    assert.equal(finalState.s8ExportJobs?.[0]?.attempt, 2);
    assert.equal(finalState.s8Artifacts?.[0]?.objectHashes, null);

    const eagainJobId = "99999999-9999-4999-8999-999999999999";
    const eagainArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const eagainClaimToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const epipeJobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const epipeArtifactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const epipeClaimToken = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const addFailureFixture = (failureJobId: string, failureArtifactId: string, failureClaimToken: string, prefix: string) => {
      repository.transact((state) => {
        state.s8ExportJobs!.push({
          schemaVersion: "s8-export-job-v2",
          jobId: failureJobId, projectId, artifactId: failureArtifactId, source, inputHash: "2".repeat(64), idempotencyKey: prefix,
          status: "running", publicationPhase: "private_staging", attempt: 1, claimToken: failureClaimToken, ownerId: "test-owner", ownerProcessId: 1234,
          claimedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now, terminalAt: null, failureCode: null,
        });
        state.s8Artifacts!.push({
          schemaVersion: "s8-artifact-v2",
          artifactId: failureArtifactId, projectId, jobId: failureJobId, source, inputHash: "2".repeat(64), profile: S8_FBX_PROFILE,
          format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx",
          status: "running", publicationPhase: "private_staging", payloadSha256: null, objectHashes: null,
          writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null,
          validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null,
          privateStagingPrefix: prefix, privateFinalPrefix: "private/projects/test/final",
          attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt: now, updatedAt: now, committedAt: null, staleAt: null,
        });
      });
    };
    const eagainStagingPrefix = "private/projects/test/eagain";
    const epipeStagingPrefix = "private/projects/test/epipe";
    addFailureFixture(eagainJobId, eagainArtifactId, eagainClaimToken, eagainStagingPrefix);
    addFailureFixture(epipeJobId, epipeArtifactId, epipeClaimToken, epipeStagingPrefix);

    const rawFailureCalls = new Map<string, number>();
    serviceInternals.nativeWorker = {
      runWriter: async (
        _payload: Buffer,
        context: { jobId: string },
        _heartbeat: () => void,
        onRequestPrepared: (requestSha256: string, requestNonce: string, manifestSha256: string, deadline: number) => void,
        deadline: number,
      ) => {
        rawFailureCalls.set(context.jobId, (rawFailureCalls.get(context.jobId) ?? 0) + 1);
        if (context.jobId === eagainJobId) throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
        onRequestPrepared("f".repeat(64), "N".repeat(43), releaseManifestSha256, deadline);
        throw Object.assign(new Error("attached worker pipe closed"), { code: "EPIPE" });
      },
    } as unknown as S8NativeWorkerClient;
    await assert.rejects(
      serviceInternals.writer.call(service, payload, {
        projectId, jobId: eagainJobId, artifactId: eagainArtifactId, claimToken: eagainClaimToken,
        attempt: 1, source, payload, onHeartbeat: () => {},
      } as never),
      (error: unknown) => (error as { code?: string }).code === "EAGAIN",
    );
    await assert.rejects(
      serviceInternals.writer.call(service, payload, {
        projectId, jobId: epipeJobId, artifactId: epipeArtifactId, claimToken: epipeClaimToken,
        attempt: 1, source, payload, onHeartbeat: () => {},
      } as never),
      (error: unknown) => (error as { code?: string }).code === "EPIPE",
    );
    const rawFailureState = new JsonRepository(root).state();
    const eagainAttempt = rawFailureState.s8NativeOperationAttempts?.find((attempt) => attempt.jobId === eagainJobId);
    assert.equal(eagainAttempt?.state, "FAILED");
    assert.equal(eagainAttempt?.failureClass, "PERMANENT");
    assert.equal(eagainAttempt?.disposalState, "NOT_STARTED");
    const epipeAttempt = rawFailureState.s8NativeOperationAttempts?.find((attempt) => attempt.jobId === epipeJobId);
    assert.equal(epipeAttempt?.state, "UNKNOWN");
    assert.equal(epipeAttempt?.failureClass, "UNCERTAIN");
    assert.equal(epipeAttempt?.disposalState, "UNKNOWN");
    assert.equal(rawFailureState.s8ExportJobs?.find((job) => job.jobId === eagainJobId)?.attempt, 1);
    assert.equal(rawFailureState.s8ExportJobs?.find((job) => job.jobId === epipeJobId)?.attempt, 1);
    assert.equal(rawFailureState.s8NativeOperationAttempts?.filter((attempt) => attempt.jobId === eagainJobId).length, 1);
    assert.equal(rawFailureState.s8NativeOperationAttempts?.filter((attempt) => attempt.jobId === epipeJobId).length, 1);
    assert.equal(rawFailureCalls.get(eagainJobId), 1);
    assert.equal(rawFailureCalls.get(epipeJobId), 1);
    assert.equal((await service.getAdmissionStatus()).state, "CLOSED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});