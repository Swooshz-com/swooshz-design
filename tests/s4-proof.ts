import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { compareClaimProofs, deriveClaimManifest, type S4ClaimProofRecord } from "./s4-evidence-manifest";
import { jcs, sha256 } from "../src/lib/utils";

type S4ClaimExecution = {
  schemaVersion: "s4-claim-execution-v1";
  receiptId: string;
  claimId: string;
  provingTest: string;
  assertionId: string;
  scenario: string;
  observationHash: string;
  assertionPassed: true;
};

type S4ClaimProofInput = {
  testId: string;
  variantId: string;
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  assertionId: string;
  scenario: string;
  observationFacts?: string[];
};

function appendExecutionReceipt(receipt: S4ClaimExecution): void {
  const executionPath = process.env.S4_EVIDENCE_EXECUTION_PATH;
  if (!executionPath) throw new Error("S4 execution receipt path is required when proof output is enabled");
  appendFileSync(executionPath, JSON.stringify(receipt) + "\n", { encoding: "utf8" });
}

function appendProofRecord(record: S4ClaimProofRecord): void {
  const outputPath = process.env.S4_EVIDENCE_PROOF_PATH;
  if (!outputPath) return;
  appendFileSync(outputPath, JSON.stringify(record) + "\n", { encoding: "utf8" });
}

/**
 * Run the assertion first. A runtime proof record and its separate execution
 * receipt are emitted only after the assertion returns successfully.
 */
export async function proveS4Claim(input: S4ClaimProofInput, assertion: () => void | Promise<void>): Promise<void> {
  await assertion();
  if (!process.env.S4_EVIDENCE_PROOF_PATH) return;

  const manifest = deriveClaimManifest();
  const claim = manifest.claims.find((item) => item.testId === input.testId && item.variantId === input.variantId);
  if (!claim) throw new Error("proof is outside the fixed S4 evidence matrix: " + input.testId + ":" + input.variantId);
  if (!input.expectedResult || !input.actualResult || !input.provingTest || !input.assertionId || !input.scenario) {
    throw new Error("incomplete S4 claim proof: " + claim.claimId);
  }

  const observationFacts = [
    "claimId=" + claim.claimId,
    "assertionId=" + input.assertionId,
    "scenario=" + input.scenario,
    ...(input.observationFacts ?? []),
  ];
  const observationHash = sha256(Buffer.from(jcs({
    claimId: claim.claimId,
    provingTest: input.provingTest,
    assertionId: input.assertionId,
    scenario: input.scenario,
    observationFacts,
  }), "utf8"));
  const receipt: S4ClaimExecution = {
    schemaVersion: "s4-claim-execution-v1",
    receiptId: randomUUID(),
    claimId: claim.claimId,
    provingTest: input.provingTest,
    assertionId: input.assertionId,
    scenario: input.scenario,
    observationHash,
    assertionPassed: true,
  };
  appendExecutionReceipt(receipt);

  const record: S4ClaimProofRecord = {
    ...claim,
    status: "passed",
    expectedResult: input.expectedResult,
    actualResult: input.actualResult,
    provingTest: input.provingTest,
    assertionId: input.assertionId,
    observationFacts: [...observationFacts, "executionReceiptId=" + receipt.receiptId, "executionObservationHash=" + receipt.observationHash],
  };
  const comparison = compareClaimProofs(manifest, [record]);
  if (comparison.failedClaims !== 0 || comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || comparison.skippedClaims !== 0) {
    throw new Error("invalid S4 claim proof identity: " + record.claimId);
  }
  appendProofRecord(record);
}

export async function proveS4Claims(
  testId: string,
  provingTest: string,
  claims: ReadonlyArray<{
    variantId: string;
    assertionId: string;
    scenario: string;
    expectedResult: string;
    actualResult: string;
    observationFacts?: string[];
    assertion: () => void | Promise<void>;
  }>,
): Promise<void> {
  for (const claim of claims) {
    await proveS4Claim({
      testId,
      variantId: claim.variantId,
      provingTest,
      assertionId: claim.assertionId,
      scenario: claim.scenario,
      expectedResult: claim.expectedResult,
      actualResult: claim.actualResult,
      observationFacts: claim.observationFacts,
    }, claim.assertion);
  }
}
