import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, type StoreState } from "./types";

const LOCK_WAIT_MS = 15_000;
const LOCK_PROTOCOL = "swooshz-repository-lock-v2" as const;

export type RepositoryLockRecord = {
  protocol?: typeof LOCK_PROTOCOL;
  ownerToken: string;
  processId: number;
  acquiredAt: number;
};

export type RepositoryLockPhase =
  | "candidate-created"
  | "owner-data-before-write"
  | "owner-data-partial"
  | "owner-data-complete"
  | "owner-data-fsynced"
  | "before-canonical-claim"
  | "canonical-claiming"
  | "canonical-claimed"
  | "before-acquisition-return";

type RepositoryLock = {
  candidatePath: string;
  record: RepositoryLockRecord;
};

type ProcessLiveness = (processId: number) => boolean;
type LockPhaseHook = (
  phase: RepositoryLockPhase,
  record: RepositoryLockRecord,
  path: string,
) => void;

class LockHookError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("simulated repository lock interruption");
    this.original = original;
  }
}

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function emptyStoreState(): StoreState {
  return {
    projects: [],
    briefAssets: [],
    drafts: [],
    briefVersions: [],
    generationRequests: [],
    generationSets: [],
    prompts: [],
    conceptAssets: [],
    candidates: [],
    idempotency: [],
    extractionAttempts: {},
    extractionOperations: [],
    generationOperations: [],
  };
}

function assertPrivateKey(key: string): string[] {
  const parts = key.split("/");
  if (
    !key ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\"),
    )
  ) {
    throw new Error("Invalid private object key");
  }
  return parts;
}

export class PrivateObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, ...assertPrivateKey(key));
    const relativePath = relative(this.root, path);
    if (
      relativePath === ".." ||
      relativePath.startsWith(".." + sep)
    ) {
      throw new Error("Private object path escaped root");
    }
    return path;
  }

  put(key: string, bytes: Uint8Array): void {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: key });
    }
    const temporary = path + "." + randomUUID() + ".tmp";
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx");
      writeFileSync(descriptor, Buffer.from(bytes));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, path);
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence failure without exposing a path.
      }
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: key });
    }
  }

  promote(stagingKey: string, finalKey: string): void {
    const source = this.pathFor(stagingKey);
    const target = this.pathFor(finalKey);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: finalKey });
    }
    try {
      renameSync(source, target);
    } catch {
      throw new AppError(500, "PERSISTENCE_FAILED", [], { storageKey: finalKey });
    }
  }

  read(key: string): Buffer {
    try {
      return readFileSync(this.pathFor(key));
    } catch {
      throw new AppError(404, "ASSET_NOT_FOUND");
    }
  }

  remove(key: string): void {
    try {
      rmSync(this.pathFor(key), { force: true });
    } catch {
      // Cleanup is best effort. The workflow remains failed and never publishes
      // a candidate when cleanup cannot complete.
    }
  }

  exists(key: string): boolean {
    return existsSync(this.pathFor(key));
  }
}

type CanonicalLockInspection =
  | { kind: "missing" }
  | { kind: "valid"; record: RepositoryLockRecord }
  | { kind: "malformed" };

export class JsonRepository {
  readonly root: string;
  readonly statePath: string;
  readonly lockPath: string;
  private current: StoreState;
  private readonly beforeCommit: (() => void) | undefined;
  private readonly lockWaitMs: number;
  private readonly processId: number;
  private readonly isProcessAlive: ProcessLiveness;
  private readonly onLockPhase: LockPhaseHook | undefined;

  constructor(
    root: string,
    options: {
      beforeCommit?: () => void;
      lockWaitMs?: number;
      processId?: number;
      isProcessAlive?: ProcessLiveness;
      onLockPhase?: LockPhaseHook;
    } = {},
  ) {
    this.root = resolve(root);
    this.statePath = join(this.root, "state.json");
    this.lockPath = join(this.root, "state.json.lock");
    this.beforeCommit = options.beforeCommit;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.onLockPhase = options.onLockPhase;
    mkdirSync(this.root, { recursive: true });
    this.current = this.load();
  }

  private load(): StoreState {
    if (!existsSync(this.statePath)) return emptyStoreState();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("invalid state");
      }
      const merged = { ...emptyStoreState(), ...(parsed as Partial<StoreState>) };
      if (!Array.isArray(merged.extractionOperations)) {
        merged.extractionOperations = [];
      }
      if (!Array.isArray(merged.generationOperations)) {
        merged.generationOperations = [];
      }
      return merged;
    } catch {
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  state(): StoreState {
    this.current = this.load();
    return this.current;
  }

  private parseLockRecord(value: unknown): RepositoryLockRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<RepositoryLockRecord> & {
      protocol?: unknown;
    };
    if (
      candidate.protocol !== undefined &&
      candidate.protocol !== LOCK_PROTOCOL
    ) {
      return null;
    }
    if (
      typeof candidate.ownerToken !== "string" ||
      candidate.ownerToken.length < 1 ||
      !Number.isInteger(candidate.processId) ||
      (candidate.processId as number) <= 0 ||
      typeof candidate.acquiredAt !== "number" ||
      !Number.isFinite(candidate.acquiredAt)
    ) {
      return null;
    }
    return {
      ...(candidate.protocol === LOCK_PROTOCOL
        ? { protocol: LOCK_PROTOCOL }
        : {}),
      ownerToken: candidate.ownerToken,
      processId: candidate.processId as number,
      acquiredAt: candidate.acquiredAt,
    };
  }

  private readRecordAt(path: string): RepositoryLockRecord | null {
    try {
      return this.parseLockRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private readLockRecord(): RepositoryLockRecord | null {
    return this.readRecordAt(this.lockPath);
  }

  private inspectCanonicalLock(): CanonicalLockInspection {
    if (!existsSync(this.lockPath)) return { kind: "missing" };
    try {
      if (!statSync(this.lockPath).isFile()) return { kind: "malformed" };
    } catch {
      return { kind: "malformed" };
    }
    const record = this.readLockRecord();
    return record ? { kind: "valid", record } : { kind: "malformed" };
  }

  private ownerIsLive(record: RepositoryLockRecord): boolean {
    try {
      // A liveness-check failure is held as live. It is safer to return a
      // bounded busy result than to reclaim an owner we cannot disprove.
      return this.isProcessAlive(record.processId);
    } catch {
      return true;
    }
  }

  private recordsMatch(
    left: RepositoryLockRecord,
    right: RepositoryLockRecord,
  ): boolean {
    return (
      left.ownerToken === right.ownerToken &&
      left.processId === right.processId &&
      left.acquiredAt === right.acquiredAt &&
      (left.protocol ?? null) === (right.protocol ?? null)
    );
  }

  private removeLockIfOwned(record: RepositoryLockRecord): boolean {
    const current = this.readLockRecord();
    if (!current || !this.recordsMatch(current, record)) return false;
    try {
      rmSync(this.lockPath, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  private removeCandidate(path: string): void {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // A recovery sweep can remove the artifact later. The canonical claim
      // remains authoritative and is never downgraded to an unsafe fallback.
    }
  }

  private emitLockPhase(
    phase: RepositoryLockPhase,
    record: RepositoryLockRecord,
    path: string,
  ): void {
    try {
      this.onLockPhase?.(phase, { ...record }, path);
    } catch (error) {
      throw new LockHookError(error);
    }
  }

  private candidatePath(record: RepositoryLockRecord): string {
    return this.lockPath + "." + record.ownerToken + ".candidate";
  }

  private recoverCandidateArtifacts(): void {
    const prefix = basename(this.lockPath) + ".";
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".candidate")) continue;
      const path = join(this.root, name);
      const record = this.readRecordAt(path);
      if (record && this.ownerIsLive(record)) continue;
      // Candidate files are never canonical owners. Incomplete or dead
      // candidates are safe to remove, while a live candidate is preserved.
      this.removeCandidate(path);
    }
  }

  private recoverMalformedCanonical(): void {
    const recoveryPath =
      this.lockPath + "." + randomUUID() + ".recovery";
    try {
      // Quarantine is a same-directory rename. It cannot replace a successor
      // canonical claim because the destination is unique and the source is
      // removed atomically from the canonical name.
      renameSync(this.lockPath, recoveryPath);
      this.removeCandidate(recoveryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new AppError(503, "PERSISTENCE_BUSY");
    }
  }

  private prepareCandidate(record: RepositoryLockRecord): string {
    const path = this.candidatePath(record);
    let descriptor: number | null = null;
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    const partialLength = Math.max(1, Math.floor(bytes.length / 2));
    try {
      descriptor = openSync(path, "wx", 0o600);
      this.emitLockPhase("candidate-created", record, path);
      this.emitLockPhase("owner-data-before-write", record, path);
      writeSync(descriptor, bytes, 0, partialLength, 0);
      this.emitLockPhase("owner-data-partial", record, path);
      writeSync(
        descriptor,
        bytes,
        partialLength,
        bytes.length - partialLength,
        partialLength,
      );
      this.emitLockPhase("owner-data-complete", record, path);
      fsyncSync(descriptor);
      this.emitLockPhase("owner-data-fsynced", record, path);
      closeSync(descriptor);
      descriptor = null;
      return path;
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // The process-crash simulation owns the incomplete artifact.
        }
      }
      if (error instanceof LockHookError) throw error;
      this.removeCandidate(path);
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  private acquireLock(): RepositoryLock {
    const deadline = Date.now() + this.lockWaitMs;
    const record: RepositoryLockRecord = {
      protocol: LOCK_PROTOCOL,
      ownerToken: randomUUID(),
      processId: this.processId,
      acquiredAt: Date.now(),
    };
    let candidate: string | null = null;
    try {
      this.recoverCandidateArtifacts();
      candidate = this.prepareCandidate(record);

      while (true) {
        const inspection = this.inspectCanonicalLock();
        if (inspection.kind === "missing") {
          this.emitLockPhase("before-canonical-claim", record, this.lockPath);
          this.emitLockPhase("canonical-claiming", record, this.lockPath);
          try {
            // The owner record is complete and fsynced before linkSync. A hard
            // link is atomic and cannot overwrite an existing canonical path.
            linkSync(candidate, this.lockPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") continue;
            throw new AppError(500, "PERSISTENCE_FAILED");
          }
          this.emitLockPhase("canonical-claimed", record, this.lockPath);
          this.removeCandidate(candidate);
          this.emitLockPhase("before-acquisition-return", record, this.lockPath);
          return { candidatePath: candidate, record };
        }

        if (inspection.kind === "malformed") {
          this.recoverMalformedCanonical();
          continue;
        }

        if (!this.ownerIsLive(inspection.record)) {
          this.removeLockIfOwned(inspection.record);
          continue;
        }

        if (Date.now() >= deadline) throw new AppError(503, "PERSISTENCE_BUSY");
        sleepSync(5);
      }
    } catch (error) {
      if (!(error instanceof LockHookError) && candidate !== null) {
        this.removeCandidate(candidate);
      }
      if (error instanceof LockHookError) throw error.original;
      if (error instanceof AppError) throw error;
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  private releaseLock(lock: RepositoryLock): void {
    // The canonical record is checked again immediately before removal. A
    // late release from an old owner therefore cannot delete a successor.
    this.removeLockIfOwned(lock.record);
    this.removeCandidate(lock.candidatePath);
  }

  private commit(state: StoreState): void {
    const temporary = this.statePath + "." + randomUUID() + ".tmp";
    let descriptor: number | null = null;
    try {
      this.beforeCommit?.();
      descriptor = openSync(temporary, "wx");
      writeFileSync(descriptor, JSON.stringify(state), { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.statePath);
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence failure without exposing a path.
      }
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  transact<T>(mutation: (state: StoreState) => T): T {
    const lock = this.acquireLock();
    try {
      const fresh = this.load();
      const result = mutation(fresh);
      this.commit(fresh);
      this.current = fresh;
      return result;
    } finally {
      this.releaseLock(lock);
    }
  }
}

export function defaultDataRoot(): string {
  return process.env.SWOOSHZ_DATA_ROOT ?? join(process.cwd(), ".swooshz-data");
}
