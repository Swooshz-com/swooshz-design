import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReplayLedger } from "./ledger.mjs";

const body = {
  projectId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  artifactId: "33333333-3333-4333-8333-333333333333",
  attempt: 1,
  operation: "WRITER",
  sourceSha256: "a".repeat(64),
  inputSha256: "b".repeat(64),
  nonce: "c".repeat(43),
};
const requestSha256 = "d".repeat(64);
const releaseSha256 = "e".repeat(64);
const policySha256 = "f".repeat(64);

test("metadata ledger is durable, replay fenced, and reconciles inflight attempts closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-"));
  try {
    if (process.platform !== "linux") {
      assert.throws(() => new ReplayLedger(directory), /ledger-platform-unsupported/u);
      return;
    }
    const ledger = new ReplayLedger(directory);
    const started = ledger.begin(body, requestSha256, releaseSha256, policySha256, "2026-09-29T00:00:00.000Z");
    assert.equal(started.state, "STARTED");
    assert.equal(started.nonceSha256, createHash("sha256").update(body.nonce).digest("hex"));
    assert.equal(ledger.get(body).requestSha256, requestSha256);
    assert.throws(() => ledger.begin(body, requestSha256, releaseSha256, policySha256), /tuple-replay/u);
    const raw = readFileSync(join(directory, readdirSync(directory).find((name) => name.endsWith(".json"))), "utf8");
    assert.equal(raw.includes(body.nonce), false);
    assert.equal(raw.includes(body.inputSha256), true);
    assert.equal(ledger.reconcileInflight(), 1);
    const recovered = ledger.get(body);
    assert.equal(recovered.state, "UNKNOWN");
    assert.equal(recovered.disposalState, "UNKNOWN");
    assert.equal(recovered.failureClass, "UNCERTAIN");
    assert.equal(recovered.signedFailureFrame, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ledger reconciliation rejects unknown and interrupted temporary entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-unknown-"));
  try {
    if (process.platform !== "linux") {
      assert.throws(() => new ReplayLedger(directory), /ledger-platform-unsupported/u);
      return;
    }
    const ledger = new ReplayLedger(directory);
    writeFileSync(join(directory, ".tmp-interrupted"), "partial");
    assert.throws(() => ledger.reconcileInflight(), /ledger-corrupt/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ledger refuses readback after a post-rename directory sync failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-sync-failure-"));
  try {
    if (process.platform !== "linux") {
      assert.throws(() => new ReplayLedger(directory), /ledger-platform-unsupported/u);
      return;
    }
    let failSync = false;
    const syncDirectory = (path) => {
      if (failSync) throw new Error("injected-directory-sync-failure");
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    };
    const ledger = new ReplayLedger(directory, { syncDirectory });
    failSync = true;
    assert.throws(
      () => ledger.begin(body, requestSha256, releaseSha256, policySha256, "2026-09-29T00:00:00.000Z"),
      /ledger-durability-unknown/u,
    );
    assert.throws(() => ledger.get(body), /ledger-durability-unknown/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unresolved ledger inspection stays non-mutating across restart and only clears for safe terminal disposal", () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-unresolved-"));
  try {
    if (process.platform !== "linux") {
      assert.throws(() => new ReplayLedger(directory), /ledger-platform-unsupported/u);
      return;
    }
    const original = new ReplayLedger(directory);
    original.begin(body, requestSha256, releaseSha256, policySha256, "2026-09-29T00:00:00.000Z");

    const restarted = new ReplayLedger(directory);
    assert.equal(restarted.reconcileInflight(), 1);
    const path = join(directory, readdirSync(directory).find((name) => name.endsWith(".json")));
    const unknownBytes = readFileSync(path);
    assert.equal(restarted.hasUnresolvedOperations(), true);
    assert.deepEqual(readFileSync(path), unknownBytes);

    restarted.update(body, { state: "FAILED", outcome: "PERMANENT_FAILURE", disposalState: "UNKNOWN", failureClass: "UNCERTAIN" });
    assert.equal(restarted.hasUnresolvedOperations(), true);
    restarted.update(body, { state: "FAILED", outcome: "PERMANENT_FAILURE", disposalState: "REAPED_REMOVED", failureClass: "PERMANENT" });
    const terminalBytes = readFileSync(path);
    assert.equal(restarted.hasUnresolvedOperations(), false);
    assert.deepEqual(readFileSync(path), terminalBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
