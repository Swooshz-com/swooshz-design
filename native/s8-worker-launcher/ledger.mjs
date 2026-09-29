import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, lstatSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const RECORD_SCHEMA = "s8-launcher-ledger-record-v1";

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger-corrupt");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("ledger-corrupt");
}

export function operationTuple(body) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(body.jobId) || !Number.isInteger(body.attempt) || body.attempt < 1 || body.attempt > 2
    || !["WRITER", "VALIDATOR"].includes(body.operation)) throw new Error("tuple-invalid");
  return `${body.jobId}.${body.attempt}.${body.operation}`;
}

function recordPath(directory, tuple) {
  if (!/^[0-9a-f-]{36}\.[12]\.(WRITER|VALIDATOR)$/u.test(tuple)) throw new Error("tuple-invalid");
  return join(directory, `${tuple}.json`);
}

function syncDirectoryEntries(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensurePrivateDirectory(directory, syncDirectory = syncDirectoryEntries) {
  if (process.platform !== "linux") throw new Error("ledger-platform-unsupported");
  const absolute = resolve(directory);
  const chain = [];
  for (let current = absolute; ; current = dirname(current)) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
  }
  for (const current of chain.reverse()) {
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ledger-permissions");
    if (current === absolute && (info.mode & 0o077) !== 0) throw new Error("ledger-permissions");
    syncDirectory(dirname(current));
  }
  return absolute;
}

function readRecordFile(path, tuple) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0) throw new Error("ledger-corrupt");
  return validateRecord(JSON.parse(readFileSync(path, "utf8")), tuple);
}

function validateRecord(value, tuple) {
  exactKeys(value, ["schemaVersion", "tuple", "projectId", "artifactId", "sourceSha256", "inputSha256", "requestSha256", "nonceSha256", "state", "containerId", "releaseManifestSha256", "resourcePolicySha256", "createdAt", "updatedAt", "outcome", "disposalState", "responseSha256", "outputSha256", "releaseHandle", "failureClass", "signedFailureFrame"]);
  if (value.schemaVersion !== RECORD_SCHEMA || value.tuple !== tuple || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.projectId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.artifactId)
    || !/^[0-9a-f]{64}$/u.test(value.sourceSha256) || !/^[0-9a-f]{64}$/u.test(value.inputSha256) || !/^[0-9a-f]{64}$/u.test(value.requestSha256)
    || !/^[0-9a-f]{64}$/u.test(value.nonceSha256) || !["STARTED", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.state)
    || (value.containerId !== null && !/^[0-9a-f]{64}$/u.test(value.containerId))
    || !/^[0-9a-f]{64}$/u.test(value.releaseManifestSha256) || !/^[0-9a-f]{64}$/u.test(value.resourcePolicySha256)
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
    || (value.outcome !== null && !["EXIT_0", "TRANSIENT_INFRASTRUCTURE_FAILURE", "PERMANENT_FAILURE"].includes(value.outcome))
    || !["NOT_STARTED", "RUNNING", "REAPED_REMOVED", "UNKNOWN"].includes(value.disposalState)
    || (value.responseSha256 !== null && !/^[0-9a-f]{64}$/u.test(value.responseSha256))
    || (value.outputSha256 !== null && !/^[0-9a-f]{64}$/u.test(value.outputSha256))
    || (value.releaseHandle !== null && (typeof value.releaseHandle !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.releaseHandle)))
    || (value.failureClass !== null && !["TRANSIENT", "PERMANENT", "UNCERTAIN"].includes(value.failureClass))
    || (value.signedFailureFrame !== null && (typeof value.signedFailureFrame !== "string" || value.signedFailureFrame.length > 120000))) throw new Error("ledger-corrupt");
  return value;
}

function atomicWrite(directory, path, value, syncDirectory = syncDirectoryEntries) {
  const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  let fd = -1;
  let renamed = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const ownedFd = fd;
    fd = -1;
    closeSync(ownedFd);
    renameSync(temporary, path);
    renamed = true;
    syncDirectory(directory);
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    if (renamed) {
      const failure = new Error("ledger-durability-unknown");
      failure.durabilityUnproven = true;
      throw failure;
    }
    try { unlinkSync(temporary); } catch { /* temp may not exist */ }
    throw error;
  }
}

export class ReplayLedger {
  constructor(directory, options = {}) {
    this.syncDirectory = options.syncDirectory ?? syncDirectoryEntries;
    this.poisoned = false;
    this.directory = ensurePrivateDirectory(directory, this.syncDirectory);
  }

  assertHealthy() {
    if (this.poisoned) throw new Error("ledger-durability-unknown");
  }

  write(path, value) {
    this.assertHealthy();
    try { atomicWrite(this.directory, path, value, this.syncDirectory); }
    catch (error) {
      if (error && typeof error === "object" && error.durabilityUnproven === true) this.poisoned = true;
      throw error;
    }
  }

  get(body) {
    this.assertHealthy();
    const tuple = operationTuple(body);
    const path = recordPath(this.directory, tuple);
    try { return readRecordFile(path, tuple); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw new Error("ledger-corrupt");
    }
  }

  begin(body, requestSha256, releaseManifestSha256, resourcePolicySha256, now = new Date().toISOString()) {
    this.assertHealthy();
    const tuple = operationTuple(body);
    const path = recordPath(this.directory, tuple);
    try {
      lstatSync(path);
      throw new Error("tuple-replay");
    } catch (error) {
      if (error instanceof Error && error.message === "tuple-replay") throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("ledger-corrupt");
    }
    const record = {
      schemaVersion: RECORD_SCHEMA,
      tuple,
      projectId: body.projectId,
      artifactId: body.artifactId,
      sourceSha256: body.sourceSha256,
      inputSha256: body.inputSha256,
      requestSha256,
      nonceSha256: (awaitHash(body.nonce)),
      state: "STARTED",
      containerId: null,
      releaseManifestSha256,
      resourcePolicySha256,
      createdAt: now,
      updatedAt: now,
      outcome: null,
      disposalState: "RUNNING",
      responseSha256: null,
      outputSha256: null,
      releaseHandle: null,
      failureClass: null,
      signedFailureFrame: null,
    };
    this.write(path, record);
    return record;
  }

  update(body, update) {
    this.assertHealthy();
    const tuple = operationTuple(body);
    const path = recordPath(this.directory, tuple);
    const current = this.get(body);
    if (!current) throw new Error("ledger-missing");
    const next = validateRecord({ ...current, ...update, tuple, schemaVersion: RECORD_SCHEMA, updatedAt: new Date().toISOString() }, tuple);
    this.write(path, next);
    return next;
  }

  reconcileInflight() {
    this.assertHealthy();
    let changed = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^[0-9a-f-]{36}\.[12]\.(WRITER|VALIDATOR)\.json$/u.test(name)) throw new Error("ledger-corrupt");
      const tuple = name.slice(0, -5);
      const path = recordPath(this.directory, tuple);
      let value;
      try { value = readRecordFile(path, tuple); }
      catch { throw new Error("ledger-corrupt"); }
      if (value.state !== "STARTED") continue;
      this.write(path, { ...value, state: "UNKNOWN", outcome: null, disposalState: "UNKNOWN", failureClass: "UNCERTAIN", signedFailureFrame: null, updatedAt: new Date().toISOString() });
      changed += 1;
    }
    return changed;
  }
}

const awaitHash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
