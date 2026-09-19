import { AppError } from "./types";
import type { S8WorkerConfig } from "./s8-fbx-worker";

const PATH_KEYS = [
  "S8_BLENDER_RUNTIME_ROOT",
  "S8_BLENDER_EXECUTABLE",
  "S8_WRITER_SCRIPT",
  "S8_PRIVATE_WORK_ROOT",
  "S8_PROCESS_RUNNER_EXECUTABLE",
  "S8_SANDBOX_EXECUTABLE",
  "S8_NATIVE_VALIDATOR_EXECUTABLE",
  "S8_BLENDER_EXECUTABLE_SHA256",
] as const;

type S8PathEnvironment = Partial<Record<(typeof PATH_KEYS)[number], string | undefined>>;

function fail(code: string, field: string): never {
  throw new AppError(500, code, [{ field, code }]);
}

export function readS8RuntimeConfig(environment: S8PathEnvironment = process.env as S8PathEnvironment): S8WorkerConfig | undefined {
  const values = PATH_KEYS.map((key) => environment[key]);
  if (values.every((value) => value === undefined || value === "")) return undefined;
  const missing = PATH_KEYS.filter((key) => typeof environment[key] !== "string" || environment[key]!.length === 0);
  if (missing.length) fail("S8_RUNTIME_CONFIG_INVALID", missing[0]!);
  return {
    blenderRuntimeRoot: environment.S8_BLENDER_RUNTIME_ROOT!,
    blenderExecutable: environment.S8_BLENDER_EXECUTABLE!,
    writerScript: environment.S8_WRITER_SCRIPT!,
    privateWorkRoot: environment.S8_PRIVATE_WORK_ROOT!,
    processRunnerExecutable: environment.S8_PROCESS_RUNNER_EXECUTABLE!,
    sandboxExecutable: environment.S8_SANDBOX_EXECUTABLE!,
    nativeValidatorExecutable: environment.S8_NATIVE_VALIDATOR_EXECUTABLE!,
    blenderExecutableSha256: environment.S8_BLENDER_EXECUTABLE_SHA256!,
  };
}
