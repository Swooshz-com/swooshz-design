import assert from "node:assert/strict";
import test from "node:test";
import { decideS8NativeAdmission, requireS8NativeAdmissionOpen } from "../src/lib/s8-native-admission";

test("native admission remains closed when capacity proof or verifier trust is absent", () => {
  assert.deepEqual(decideS8NativeAdmission(null, undefined, 1_800_000_000_000), {
    state: "CLOSED", reason: "PROOF_MISSING", proofSha256: null, observedAt: null,
  });
  assert.deepEqual(decideS8NativeAdmission({} as never, undefined, 1_800_000_000_000), {
    state: "CLOSED", reason: "TRUST_KEY_MISSING", proofSha256: null, observedAt: null,
  });
});

test("malformed native admission envelopes fail closed and cannot be opened by a caller", () => {
  const decision = decideS8NativeAdmission({ capacity: {} as never, launcher: {} as never }, {
    capacityAuthorityKeys: {}, launcherKeys: {},
  }, 1_800_000_000_000);
  assert.equal(decision.state, "CLOSED");
  assert.equal(decision.reason, "PROOF_INVALID");
  assert.throws(() => requireS8NativeAdmissionOpen(decision), (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "S8_WORKER_ADMISSION_CLOSED");
});
