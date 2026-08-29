import { appendFileSync } from "node:fs";
import { compareClaimProofs, deriveClaimManifest, type S3ClaimProofRecord } from "./s3-evidence-manifest";

export const S3_SOURCE_ELIGIBILITY_TEST_NAME = "S3 source eligibility keeps original and repaired classes separate";

type ClaimProofInput = {
  testId: string;
  variantId: string;
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  observationFacts: string[];
};

export function recordS3ClaimProof(input: ClaimProofInput): void {
  const outputPath = process.env.S3_EVIDENCE_PROOF_PATH;
  if (!outputPath) return;
  const manifest = deriveClaimManifest();
  const claim = manifest.claims.find((item) => item.testId === input.testId && item.variantId === input.variantId);
  if (!claim) throw new Error("proof is outside the fixed S3 evidence matrix: " + input.testId + ":" + input.variantId);
  const record: S3ClaimProofRecord = {
    ...claim,
    status: "passed",
    expectedResult: input.expectedResult,
    actualResult: input.actualResult,
    provingTest: input.provingTest,
    observationFacts: input.observationFacts,
  };
  const comparison = compareClaimProofs(manifest, [record]);
  if (comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || comparison.skippedClaims !== 0) {
    throw new Error("invalid S3 claim proof identity: " + record.claimId);
  }
  if (!record.expectedResult || !record.actualResult || !record.provingTest || record.observationFacts.length === 0) {
    throw new Error("incomplete S3 claim proof: " + record.claimId);
  }
  appendFileSync(outputPath, JSON.stringify(record) + "\n", { encoding: "utf8" });
}
