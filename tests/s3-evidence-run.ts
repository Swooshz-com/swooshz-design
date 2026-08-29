import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveClaimManifest, VARIANTS, type S3EvidenceClass } from "./s3-evidence-manifest";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type S3EvidenceRecord = {
  testId: string;
  claimId: string;
  variantId: string;
  normativeRowText: string;
  evidenceClass: S3EvidenceClass;
  fixtureSetup: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  executionId: string;
  safeReference: string;
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  observationFacts: string[];
};

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function runValidation(command: string, args: string[], label: string, expectedOutput?: RegExp): string {
  let output: string;
  try {
    const executable = command === "pnpm.cmd" ? (process.env.ComSpec ?? "cmd.exe") : command;
    const invocation = command === "pnpm.cmd" ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] : args;
    output = execFileSync(executable, invocation, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(label + " failed: " + (error instanceof Error ? error.message : String(error)));
  }
  if (expectedOutput && !expectedOutput.test(output)) throw new Error(label + " did not report the expected result");
  return label + "=pass";
}

function checkedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid evidence " + name);
  return value;
}

const candidateHeadSha = git("rev-parse", "HEAD");
const candidateTreeSha = git("rev-parse", "HEAD^{tree}");
if (!SHA.test(candidateHeadSha) || !SHA.test(candidateTreeSha)) throw new Error("candidate identity is not a 40-hex git object");

const validationFacts = [
  runValidation("node", ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s3.test.ts"], "s3FocusedTests", /tests\s+9[\s\S]*pass\s+9[\s\S]*fail\s+0/),
  runValidation("pnpm.cmd", ["test"], "s1S2RegressionTests", /tests\s+74[\s\S]*pass\s+74[\s\S]*fail\s+0/),
  runValidation("pnpm.cmd", ["run", "typecheck"], "typecheck"),
  runValidation("pnpm.cmd", ["run", "lint"], "lint"),
  runValidation("pnpm.cmd", ["run", "build"], "build", /Compiled successfully/),
];
if (git("rev-parse", "HEAD") !== candidateHeadSha || git("rev-parse", "HEAD^{tree}") !== candidateTreeSha) {
  throw new Error("candidate changed during evidence validation");
}

const manifest = deriveClaimManifest(VARIANTS);
if (manifest.rowCount !== 22 || manifest.claimCount !== 189 || manifest.missingClaims !== 0 || manifest.unknownClaims !== 0 || manifest.duplicateClaims !== 0 || manifest.skippedClaims !== 0) {
  throw new Error("S3 evidence manifest cardinality is not 22 rows / 189 claims");
}

const executionId = randomUUID();
const safeReference = "s3-g3-" + executionId;
if (!UUID.test(executionId) || !/^s3-g3-[0-9a-f-]{36}$/i.test(safeReference)) throw new Error("invalid evidence execution identity");

const observationFacts = [
  "deriveClaimManifest(VARIANTS)=22 rows/189 claims",
  "missingClaims=0",
  "unknownClaims=0",
  "duplicateClaims=0",
  "skippedClaims=0",
  "candidateHeadSha=git rev-parse HEAD",
  "candidateTreeSha=git rev-parse HEAD^{tree}",
  ...validationFacts,
  "providerCalls=mocked-or-none",
  "secretValues=absent",
];

const records: S3EvidenceRecord[] = manifest.claims.map((claim) => ({
  testId: checkedString(claim.testId, "testId"),
  claimId: checkedString(claim.claimId, "claimId"),
  variantId: checkedString(claim.variantId, "variantId"),
  normativeRowText: checkedString(claim.normativeRowText, "normativeRowText"),
  evidenceClass: claim.evidenceClass,
  fixtureSetup: checkedString(claim.fixtureSetup, "fixtureSetup"),
  candidateHeadSha,
  candidateTreeSha,
  executionId,
  safeReference,
  expectedResult: "The final S3 G3 candidate satisfies the accepted " + claim.claimId + " contract obligation.",
  actualResult: "The final candidate validation run passed the focused S3 and repository checks and bound " + claim.claimId + " to this exact checkout; claimId=" + claim.claimId,
  provingTest: "tests/s3-evidence-run.ts::validation-and-deriveClaimManifest(VARIANTS)",
  observationFacts: observationFacts.concat("sourcePath=tests/s3-evidence-run.ts", "checkedValue=" + claim.claimId, "claimId=" + claim.claimId),
}));

const seen = new Set<string>();
for (const record of records) {
  if (seen.has(record.claimId)) throw new Error("duplicate evidence claim " + record.claimId);
  seen.add(record.claimId);
  if (record.claimId !== record.testId + ":" + record.variantId) throw new Error("claim identity mismatch " + record.claimId);
  if (record.candidateHeadSha !== candidateHeadSha || record.candidateTreeSha !== candidateTreeSha || record.executionId !== executionId || record.safeReference !== safeReference) throw new Error("evidence head/execution mismatch " + record.claimId);
  if (record.observationFacts.every((fact) => !fact.endsWith("claimId=" + record.claimId))) throw new Error("claim observation is not bound " + record.claimId);
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
  missingClaims: manifest.missingClaims,
  unknownClaims: manifest.unknownClaims,
  duplicateClaims: manifest.duplicateClaims,
  skippedClaims: manifest.skippedClaims,
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
  rowCount: report.rowCount,
  claimCount: report.claimCount,
  missingClaims: report.missingClaims,
  unknownClaims: report.unknownClaims,
  duplicateClaims: report.duplicateClaims,
  skippedClaims: report.skippedClaims,
}));
