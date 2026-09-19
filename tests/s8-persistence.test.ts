import assert from "node:assert/strict";
import test from "node:test";
import { advanceS8Publication, assertS8SourceFence, mayReclaimS8Claim, S8_STALE_CLAIM_MS, type S8PublicationRecord } from "../src/lib/s8-fbx-persistence";

function record(): S8PublicationRecord {
  return { projectId: "p", artifactId: "a", sourceRevisionId: "r", sourceRevisionHash: "h", claimToken: "c", ownerId: "o", phase: "source_admission", heartbeatAtMs: 0, stagingKey: "stage", finalKey: "final", artifactSha256: null, validatorReceiptHash: null, committedAtMs: null, failureCode: null };
}

test("publication phases are monotonic and source movement always fences", () => {
  let value = record();
  for (const phase of ["claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"] as const) value = advanceS8Publication(value, "c", "o", phase, value.heartbeatAtMs + 1);
  assert.equal(value.phase, "commit");
  assert.throws(() => assertS8SourceFence(value, "new", "new"), /S8_SOURCE_STALE/);
  assert.throws(() => advanceS8Publication(record(), "c", "o", "commit", 1), /S8_PUBLICATION_PHASE_INVALID/);
});
test("reclaim needs expiry plus positive dead-owner proof", () => {
  const value = record();
  assert.equal(mayReclaimS8Claim(value, S8_STALE_CLAIM_MS, "dead"), false);
  assert.equal(mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "dead"), true);
  assert.throws(() => mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "live"), /S8_CONTROLLER_REQUIRED/);
  assert.throws(() => mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "unknown"), /S8_CONTROLLER_REQUIRED/);
});
