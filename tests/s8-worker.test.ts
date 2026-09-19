import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runS8BlenderWriter, runS8NativeValidator, type S8WorkerConfig } from "../src/lib/s8-fbx-worker";
import { readS8RuntimeConfig } from "../src/lib/s8-fbx-config";

function config(root: string): S8WorkerConfig {
  return { blenderRuntimeRoot: root, blenderExecutable: join(root, "blender"), writerScript: join(root, "writer.py"), privateWorkRoot: root, processRunnerExecutable: join(root, "runner"), sandboxExecutable: join(root, "sandbox"), nativeValidatorExecutable: join(root, "validator"), blenderExecutableSha256: "a".repeat(64) };
}

test("worker refuses to run without the native Linux process boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-worker-"));
  try {
    const value = config(root);
    if (process.platform === "linux" && process.arch === "x64") {
      assert.throws(() => runS8NativeValidator(Buffer.alloc(32), value), /S8_WORKER_PATH_INVALID/);
    } else {
      assert.throws(() => runS8NativeValidator(Buffer.alloc(32), value), /S8_TOOLING_HOLD_PLATFORM/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial runtime configuration fails closed instead of selecting a fallback", () => {
  assert.throws(() => readS8RuntimeConfig({ S8_BLENDER_RUNTIME_ROOT: "C:/runtime" }), /S8_RUNTIME_CONFIG_INVALID/);
});
