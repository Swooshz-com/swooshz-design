import { appendFileSync, readFileSync } from "node:fs";
import { AppError } from "../src/lib/types";
import { PrivateObjectStore } from "../src/lib/store";
import { sha256 } from "../src/lib/utils";

const [root, barrier, key, hex] = process.argv.slice(2);
if (!root || !barrier || !key || !hex) throw new Error("invalid race fixture");

appendFileSync(barrier, String(process.pid) + "\n", { encoding: "utf8" });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10_000;
while (true) {
  let participants = 0;
  try { participants = readFileSync(barrier, "utf8").trim().split(/\r?\n/).filter(Boolean).length; } catch { /* wait for the barrier file */ }
  if (participants >= 2) break;
  if (Date.now() >= deadline) throw new Error("store race barrier timed out");
  Atomics.wait(sleeper, 0, 0, 5);
}

const bytes = Buffer.from(hex, "hex");
try {
  new PrivateObjectStore(root).put(key, bytes);
  process.stdout.write("won:" + sha256(bytes));
} catch (error) {
  if (error instanceof AppError && error.code === "PERSISTENCE_FAILED") {
    process.stdout.write("lost:PERSISTENCE_FAILED");
  } else {
    throw error;
  }
}
