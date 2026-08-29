import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compareClaimProofs, deriveClaimManifest, VARIANTS } from "./s3-evidence-manifest";

test("S3 fixed evidence manifest derives 22 rows and 189 unique claims", () => {
  const manifest = deriveClaimManifest(VARIANTS);
  assert.equal(manifest.rowCount, 22);
  assert.equal(manifest.claimCount, 189);
  assert.equal(new Set(manifest.claims.map((claim) => claim.claimId)).size, 189);
  assert.match(manifest.claims[0].normativeRowText, /StoreState/);
  const emptyComparison = compareClaimProofs(manifest, []);
  assert.equal(emptyComparison.missingClaims, 189);
  assert.equal(emptyComparison.unknownClaims, 0);
  assert.equal(emptyComparison.duplicateClaims, 0);
  assert.equal(emptyComparison.skippedClaims, 0);
  assert.equal(manifest.claims[0].claimId, "MODEL-001:defaults");
  assert.equal(manifest.claims.at(-1)?.claimId, "REG-001:stale-head-reject");
});
