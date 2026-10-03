import { closeSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { jcs, sha256 } from "./protocol.mjs";

const OPERATION = process.env.S8_OPERATION;
const WRITER_MAX = 256 * 1024 * 1024;
const VALIDATOR_MAX = 128 * 1024 * 1024;
const OUTPUT_MAX = 128 * 1024 * 1024;
const RECEIPT_MAX = 1024 * 1024;
const RUNNER = "/usr/local/bin/s8-process-runner";
const WORK = "/work";

function writeExclusive(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

async function readWorkerInput(maximum) {
  const iterator = process.stdin[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function readBytes(length) {
    const chunks = [];
    let total = 0;
    while (total < length) {
      if (pending.length === 0) {
        const next = await iterator.next();
        if (next.done) throw new Error("input-truncated");
        pending = Buffer.from(next.value);
      }
      const take = Math.min(length - total, pending.length);
      chunks.push(pending.subarray(0, take));
      total += take;
      pending = pending.subarray(take);
    }
    return Buffer.concat(chunks, total);
  }
  const lengthHeader = await readBytes(8);
  const inputLength = lengthHeader.readBigUInt64BE(0);
  if (inputLength < 1 || inputLength > BigInt(maximum) || inputLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("input-limit");
  const input = await readBytes(Number(inputLength));
  process.stdout.write("S8_READY\n");
  const release = await readBytes(1);
  if (release[0] !== 0x52) throw new Error("launch-not-authorized");
  if (pending.length !== 0) throw new Error("input-trailing");
  const trailing = await iterator.next();
  if (!trailing.done && trailing.value.length !== 0) throw new Error("input-trailing");
  return input;
}

function runRunner(args, maximumStdout, maximumStderr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUNNER, args, {
      cwd: WORK,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: WORK,
        TMPDIR: WORK,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONNOUSERSITE: "1",
        BLENDER_USER_CONFIG: `${WORK}/blender-config`,
        BLENDER_USER_SCRIPTS: `${WORK}/blender-scripts`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let finished = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5000);
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maximumStdout + 64 * 1024) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrLength += chunk.length;
      if (stderrLength > maximumStderr) child.kill("SIGKILL");
      else stderr.push(chunk);
    });
    child.on("error", () => finish(new Error("runner-launch")));
    child.on("close", (code, signal) => finish(null, {
      code,
      signal,
      stdout: Buffer.concat(stdout, stdoutLength),
      stderrBytes: stderrLength,
      stderrSha256: sha256(Buffer.concat(stderr, stderrLength)),
    }));
  });
}

function parseRunnerOutput(bytes) {
  const prefix = Buffer.from("S8_RUNNER_RECEIPT:", "ascii");
  if (!bytes.subarray(0, prefix.length).equals(prefix)) throw new Error("runner-evidence");
  const newline = bytes.indexOf(0x0a, prefix.length);
  if (newline <= prefix.length || bytes.indexOf(prefix, prefix.length) !== -1) throw new Error("runner-evidence");
  const receiptBytes = bytes.subarray(prefix.length, newline);
  const text = receiptBytes.toString("ascii");
  const receipt = JSON.parse(text);
  if (JSON.stringify(receipt) !== text) throw new Error("runner-evidence");
  return { receipt, targetStdout: bytes.subarray(newline + 1) };
}

function encodeResult(header, output, auxiliary) {
  const headerBytes = Buffer.from(jcs(header), "utf8");
  const prefix = Buffer.alloc(4 + headerBytes.length + 8);
  prefix.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(prefix, 4);
  prefix.writeBigUInt64BE(BigInt(output.length), 4 + headerBytes.length);
  const suffix = Buffer.alloc(8);
  suffix.writeBigUInt64BE(BigInt(auxiliary.length), 0);
  process.stdout.write(Buffer.concat([prefix, output, suffix, auxiliary]));
}

function argsFor(operation) {
  if (operation === "WRITER") return [
    "--address-space-bytes", String(4 * 1024 ** 3),
    "--file-bytes", String(128 * 1024 ** 2),
    "--timeout-ms", "300000",
    "--stdout-bytes", String(1024 * 1024),
    "--stderr-bytes", String(1024 * 1024),
    "--max-children", "0", "--",
    "/opt/blender/blender", "--background", "--python", "/opt/s8/writer.py",
  ];
  if (operation === "VALIDATOR") return [
    "--address-space-bytes", String(1536 * 1024 ** 2),
    "--file-bytes", String(256 * 1024 ** 2),
    "--timeout-ms", "120000",
    "--stdout-bytes", String(8 * 1024 * 1024),
    "--stderr-bytes", String(1024 * 1024),
    "--max-children", "0", "--",
    "/usr/local/bin/s8-fbx-validator", `${WORK}/input.fbx`,
  ];
  throw new Error("operation-invalid");
}

async function main() {
  if (OPERATION !== "WRITER" && OPERATION !== "VALIDATOR") throw new Error("operation-invalid");
  const maximumInput = OPERATION === "WRITER" ? WRITER_MAX : VALIDATOR_MAX;
  const input = await readWorkerInput(maximumInput);
  if (input.length === 0) throw new Error("input-empty");
  const inputPath = OPERATION === "WRITER" ? `${WORK}/input.json` : `${WORK}/input.fbx`;
  writeExclusive(inputPath, input);
  const result = await runRunner(argsFor(OPERATION), OPERATION === "WRITER" ? 1024 * 1024 : 8 * 1024 * 1024, 1024 * 1024, OPERATION === "WRITER" ? 300000 : 120000);
  if (result.code !== 0 || result.signal !== null) process.exit(result.code ?? 1);
  const { receipt: runnerEvidence, targetStdout } = parseRunnerOutput(result.stdout);
  if (runnerEvidence.result?.stdoutBytes !== targetStdout.length || runnerEvidence.result?.stderrBytes !== result.stderrBytes) throw new Error("runner-count-mismatch");
  let output;
  let auxiliary = Buffer.alloc(0);
  if (OPERATION === "WRITER") {
    if (targetStdout.length !== 0) throw new Error("writer-stdout");
    output = readFileSync(`${WORK}/artifact.fbx`);
    auxiliary = readFileSync(`${WORK}/writer-receipt.json`);
    if (output.length <= 27 || output.length > OUTPUT_MAX || auxiliary.length === 0 || auxiliary.length > RECEIPT_MAX) throw new Error("writer-output-limit");
  } else {
    if (targetStdout.length === 0 || targetStdout.length > 8 * 1024 * 1024) throw new Error("validator-output-limit");
    const readback = JSON.parse(targetStdout.toString("utf8"));
    output = Buffer.from(jcs(readback), "utf8");
    if (output.length === 0 || output.length > 8 * 1024 * 1024) throw new Error("validator-output-limit");
  }
  const header = {
    schemaVersion: "s8-container-result-v1",
    operation: OPERATION,
    runnerEvidence,
    outerExitStatus: result.code,
    outerSignal: result.signal,
    targetStdoutBytes: targetStdout.length,
    targetStdoutSha256: sha256(targetStdout),
    outerStderrBytes: result.stderrBytes,
    outerStderrSha256: result.stderrSha256,
    outputSha256: sha256(output),
    auxiliarySha256: sha256(auxiliary),
  };
  encodeResult(header, output, auxiliary);
}

try { await main(); }
catch {
  process.stderr.write("S8_WORKER_OPERATION_FAILED\n");
  process.exitCode = 1;
}
