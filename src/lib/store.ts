import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, type StoreState } from "./types";

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

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
  if (!key || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
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
    if (relativePath.startsWith("..") || relativePath.includes(`..${join("", "")}`)) {
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

export class JsonRepository {
  readonly root: string;
  readonly statePath: string;
  readonly lockPath: string;
  private current: StoreState;
  private readonly beforeCommit: (() => void) | undefined;

  constructor(root: string, options: { beforeCommit?: () => void } = {}) {
    this.root = resolve(root);
    this.statePath = join(this.root, "state.json");
    this.lockPath = join(this.root, "state.json.lock");
    this.beforeCommit = options.beforeCommit;
    mkdirSync(this.root, { recursive: true });
    this.current = this.load();
  }

  private load(): StoreState {
    if (!existsSync(this.statePath)) return emptyStoreState();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("invalid state");
      const merged = { ...emptyStoreState(), ...(parsed as Partial<StoreState>) };
      if (!Array.isArray(merged.extractionOperations)) merged.extractionOperations = [];
      if (!Array.isArray(merged.generationOperations)) merged.generationOperations = [];
      return merged;
    } catch {
      throw new AppError(500, "PERSISTENCE_FAILED");
    }
  }

  state(): StoreState {
    this.current = this.load();
    return this.current;
  }

  private acquireLock(): number {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(this.lockPath, "wx");
        writeFileSync(descriptor, process.pid + "\n");
        return descriptor;
      } catch (error) {
        if (descriptor !== null) {
          closeSync(descriptor);
          try {
            rmSync(this.lockPath, { force: true });
          } catch {
            // Preserve the original lock or persistence failure.
          }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw new AppError(500, "PERSISTENCE_FAILED");
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          // The owner may have released the lock between stat and removal.
        }
        if (Date.now() >= deadline) throw new AppError(503, "PERSISTENCE_BUSY");
        sleepSync(5);
      }
    }
  }

  private releaseLock(descriptor: number): void {
    try {
      closeSync(descriptor);
    } finally {
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // A later transaction can recover a stale lock after the bounded lease.
      }
    }
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
