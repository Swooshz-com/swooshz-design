import { appendFileSync } from "node:fs";
import { compareClaimProofs, deriveClaimManifest, type S4ClaimProofRecord } from "./s4-evidence-manifest";

export function recordS4ClaimProof(input: {
  testId: string;
  variantId: string;
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  observationFacts: string[];
}): void {
  const outputPath = process.env.S4_EVIDENCE_PROOF_PATH;
  if (!outputPath) return;
  const manifest = deriveClaimManifest();
  const claim = manifest.claims.find((item) => item.testId === input.testId && item.variantId === input.variantId);
  if (!claim) throw new Error("proof is outside the fixed S4 evidence matrix: " + input.testId + ":" + input.variantId);
  const record: S4ClaimProofRecord = {
    ...claim,
    status: "passed",
    expectedResult: input.expectedResult,
    actualResult: input.actualResult,
    provingTest: input.provingTest,
    observationFacts: input.observationFacts,
  };
  const comparison = compareClaimProofs(manifest, [record]);
  if (comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || comparison.skippedClaims !== 0) {
    throw new Error("invalid S4 claim proof identity: " + record.claimId);
  }
  if (!record.expectedResult || !record.actualResult || !record.provingTest || record.observationFacts.length === 0) {
    throw new Error("incomplete S4 claim proof: " + record.claimId);
  }
  if (!record.observationFacts.includes("claimId=" + record.claimId)) {
    throw new Error("claim proof is not claim-bound: " + record.claimId);
  }
  if (!record.observationFacts.some((fact) => fact.startsWith("assertionId=") && fact.length > "assertionId=".length)) {
    throw new Error("claim proof has no assertion identity: " + record.claimId);
  }
  if (!record.observationFacts.some((fact) => fact.startsWith("scenario=") && fact.length > "scenario=".length)) {
    throw new Error("claim proof has no executed scenario: " + record.claimId);
  }
  appendFileSync(outputPath, JSON.stringify(record) + "\n", { encoding: "utf8" });
}
