import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("metadata ledger is durable, replay fenced, and reconciles inflight attempts closed", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-"));
  try {
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

test("ledger reconciliation rejects unknown and interrupted temporary entries", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "s8-ledger-unknown-"));
  try {
    const ledger = new ReplayLedger(directory);
    writeFileSync(join(directory, ".tmp-interrupted"), "partial");
    assert.throws(() => ledger.reconcileInflight(), /ledger-corrupt/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
