import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { S8ExportService } from "../src/lib/s8";
import { readS8RuntimeConfig } from "../src/lib/s8-fbx-config";

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
