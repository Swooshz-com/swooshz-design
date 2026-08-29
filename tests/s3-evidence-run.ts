import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareClaimProofs, deriveClaimManifest, VARIANTS, type S3ClaimProofRecord, type S3EvidenceClass } from "./s3-evidence-manifest";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type S3EvidenceRecord = Omit<S3ClaimProofRecord, "status"> & {
  candidateHeadSha: string;
  candidateTreeSha: string;
  executionId: string;
  safeReference: string;
};

type ValidationResult = { label: string; output: string };

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function runValidation(
  command: string,
  args: string[],
  label: string,
  expectedOutput?: RegExp,
  environment: Record<string, string> = {},
): ValidationResult {
  let output: string;
  try {
    const executable = command === "pnpm.cmd" ? (process.env.ComSpec ?? "cmd.exe") : command;
    const invocation = command === "pnpm.cmd" ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] : args;
    output = execFileSync(executable, invocation, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...environment },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(label + " failed: " + (error instanceof Error ? error.message : String(error)));
  }
  if (expectedOutput && !expectedOutput.test(output)) throw new Error(label + " did not report the expected result");
  return { label, output };
}

function checkedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid evidence " + name);
  return value;
}

function proofRecord(value: unknown, line: number): S3ClaimProofRecord {
  if (typeof value !== "object" || value === null) throw new Error("invalid proof record at line " + line);
  const record = value as Record<string, unknown>;
  if (record.status !== "passed" && record.status !== "skipped") throw new Error("invalid proof status at line " + line);
  if (!Array.isArray(record.observationFacts) || record.observationFacts.some((item) => typeof item !== "string")) throw new Error("invalid proof observations at line " + line);
  return record as unknown as S3ClaimProofRecord;
}

const candidateHeadSha = git("rev-parse", "HEAD");
const candidateTreeSha = git("rev-parse", "HEAD^{tree}");
if (!SHA.test(candidateHeadSha) || !SHA.test(candidateTreeSha)) throw new Error("candidate identity is not a 40-hex git object");

const proofDirectory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "swooshz-s3-g3-proof-"));
const proofPath = join(proofDirectory, "claims.ndjson");
const focused = runValidation(
  "node",
  ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s3.test.ts", "tests/s3-evidence.test.ts"],
  "s3FocusedTests",
  /fail\s+0/,
  { S3_EVIDENCE_PROOF_PATH: proofPath },
);
const validationRuns: ValidationResult[] = [
  focused,
  runValidation("pnpm.cmd", ["test"], "s1S2RegressionTests", /fail\s+0/),
  runValidation("pnpm.cmd", ["run", "typecheck"], "typecheck"),
  runValidation("pnpm.cmd", ["run", "lint"], "lint"),
  runValidation("pnpm.cmd", ["run", "build"], "build", /Compiled successfully/),
];

if (git("rev-parse", "HEAD") !== candidateHeadSha || git("rev-parse", "HEAD^{tree}") !== candidateTreeSha) {
  throw new Error("candidate changed during evidence validation");
}

const manifest = deriveClaimManifest(VARIANTS);
if (manifest.rowCount !== 22 || manifest.claimCount !== 189) throw new Error("S3 evidence manifest cardinality is not derived as 22 rows / 189 claims");
const proofText = readFileSync(proofPath, "utf8").trim();
if (!proofText) throw new Error("the focused validation produced no claim proof records");
const proofRecords = proofText.split(/\r?\n/).map((line, index) => proofRecord(JSON.parse(line) as unknown, index + 1));
const comparison = compareClaimProofs(manifest, proofRecords);
if (comparison.missingClaims !== 0 || comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || comparison.skippedClaims !== 0) {
  throw new Error("S3 evidence completeness failed: missing=" + comparison.missingClaims + " unknown=" + comparison.unknownClaims + " duplicate=" + comparison.duplicateClaims + " skipped=" + comparison.skippedClaims);
}
if (comparison.passedRecords.length !== manifest.claimCount) throw new Error("not every expected claim has a passing proof record");

const expectedById = new Map(manifest.claims.map((claim) => [claim.claimId, claim]));
for (const proof of comparison.passedRecords) {
  const expected = expectedById.get(proof.claimId);
  if (!expected || proof.testId !== expected.testId || proof.variantId !== expected.variantId || proof.normativeRowText !== expected.normativeRowText || proof.evidenceClass !== expected.evidenceClass || proof.fixtureSetup !== expected.fixtureSetup) {
    throw new Error("proof does not match the fixed claim definition: " + proof.claimId);
  }
  if (proof.claimId !== proof.testId + ":" + proof.variantId) throw new Error("claim identity mismatch " + proof.claimId);
  if (!checkedString(proof.expectedResult, "expectedResult") || !checkedString(proof.actualResult, "actualResult") || !checkedString(proof.provingTest, "provingTest") || proof.observationFacts.length === 0) {
    throw new Error("incomplete proof record " + proof.claimId);
  }
  const provingTestName = proof.provingTest.split("::").at(-1);
  if (!provingTestName || provingTestName === "validation-and-deriveClaimManifest(VARIANTS)" || !focused.output.includes("✔ " + provingTestName)) {
    throw new Error("proofing test did not execute successfully for " + proof.claimId);
  }
  const supportingTest = proof.observationFacts.find((fact) => fact.startsWith("supportingTest="))?.slice("supportingTest=".length);
  if (supportingTest && !focused.output.includes("✔ " + supportingTest)) throw new Error("supporting test did not execute successfully for " + proof.claimId);
  if (!proof.observationFacts.some((fact) => fact === "claimId=" + proof.claimId)) throw new Error("proof observation is not claim-bound " + proof.claimId);
}

const executionId = randomUUID();
const safeReference = "s3-g3-" + executionId;
if (!UUID.test(executionId) || !/^s3-g3-[0-9a-f-]{36}$/i.test(safeReference)) throw new Error("invalid evidence execution identity");

const validationFacts = validationRuns.map((run) => run.label + "=pass");
const records: S3EvidenceRecord[] = comparison.passedRecords.map(({ status: _status, ...proof }) => ({
  ...proof,
  candidateHeadSha,
  candidateTreeSha,
  executionId,
  safeReference,
  observationFacts: proof.observationFacts.concat("candidateHeadSha=git rev-parse HEAD", "candidateTreeSha=git rev-parse HEAD^{tree}", "executionId=" + executionId),
}));

for (const record of records) {
  if (record.candidateHeadSha !== candidateHeadSha || record.candidateTreeSha !== candidateTreeSha || record.executionId !== executionId || record.safeReference !== safeReference) throw new Error("evidence head/execution mismatch " + record.claimId);
}

const outputPath = process.argv[2] ?? join(process.env.TEMP ?? process.cwd(), "swooshz-s3-g3-evidence", safeReference + ".json");
mkdirSync(dirname(outputPath), { recursive: true });
const report = {
  schema: "s3-evidence-v1-execution-bound",
  contract: "docs/G2_S3_CONTRACT.md",
  g1Lock: "DL-SD-S3-G1-001",
  g2Lock: "DL-SD-S3-G2-001",
  canonicalBaseSha: "21754d6b66b9833981db0e513b2be6b3e89e0834",
  canonicalBaseTree: "0468a9630d484ea08b219ca3b853225a3d4de5e1",
  candidateHeadSha,
  candidateTreeSha,
  executionId,
  safeReference,
  rowCount: manifest.rowCount,
  claimCount: manifest.claimCount,
  missingClaims: comparison.missingClaims,
  unknownClaims: comparison.unknownClaims,
  duplicateClaims: comparison.duplicateClaims,
  skippedClaims: comparison.skippedClaims,
  records,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2), { encoding: "utf8" });
console.log(JSON.stringify({
  schema: report.schema,
  contract: report.contract,
  candidateHeadSha,
  candidateTreeSha,
  executionId,
  safeReference,
  evidenceArtifact: outputPath,
  proofSource: proofPath,
  rowCount: report.rowCount,
  claimCount: report.claimCount,
  missingClaims: report.missingClaims,
  unknownClaims: report.unknownClaims,
  duplicateClaims: report.duplicateClaims,
  skippedClaims: report.skippedClaims,
  validationFacts,
}));
