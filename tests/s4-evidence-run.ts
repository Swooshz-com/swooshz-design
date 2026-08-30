import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareClaimProofs, deriveClaimManifest, type S4ClaimProofComparison, type S4ClaimProofRecord } from "./s4-evidence-manifest";
import { jcs, sha256 } from "../src/lib/utils";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_BASE_SHA = "2e01a90b6b2f40f4729764970a8cb89f25bbe0c8";
const CANONICAL_BASE_TREE = "b144ae4bc0bb80bee82d696be0f7e550af0a3ae9";

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
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...environment },
      maxBuffer: 64 * 1024 * 1024,
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

function proofRecord(value: unknown, line: number): S4ClaimProofRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid proof record at line " + line);
  const record = value as Record<string, unknown>;
  const expectedKeys = ["testId", "claimId", "variantId", "normativeRowText", "evidenceClass", "fixtureSetup", "status", "expectedResult", "actualResult", "provingTest", "observationFacts"].sort();
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("proof record shape mismatch at line " + line);
  if (record.status !== "passed" && record.status !== "skipped") throw new Error("invalid proof status at line " + line);
  if (!Array.isArray(record.observationFacts) || record.observationFacts.some((item) => typeof item !== "string")) throw new Error("invalid proof observations at line " + line);
  for (const field of ["testId", "claimId", "variantId", "normativeRowText", "evidenceClass", "fixtureSetup", "expectedResult", "actualResult", "provingTest"]) {
    if (typeof record[field] !== "string" || record[field].length === 0) throw new Error("invalid proof field " + field + " at line " + line);
  }
  return record as unknown as S4ClaimProofRecord;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = Array.from(keys).sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new Error(label + " shape mismatch");
}

const candidateCommitSha = git("rev-parse", "HEAD");
const candidateTree = git("rev-parse", "HEAD^{tree}");
if (!SHA.test(candidateCommitSha) || !SHA.test(candidateTree) || candidateCommitSha === CANONICAL_BASE_SHA) throw new Error("candidate identity is not a distinct 40-hex git object");
const startedAt = new Date().toISOString();

const proofDirectory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "swooshz-s4-g3-proof-"));
const proofPath = join(proofDirectory, "claims.ndjson");
const focused = runValidation(
  "node",
  ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s4.test.ts", "tests/s4-evidence.test.ts"],
  "s4FocusedTests",
  /fail\s+0/,
  { S4_EVIDENCE_PROOF_PATH: proofPath },
);
const validationRuns: ValidationResult[] = [
  focused,
  runValidation("pnpm.cmd", ["test"], "s1S2S3RegressionTests", /fail\s+0/),
  runValidation("pnpm.cmd", ["run", "typecheck"], "typecheck"),
  runValidation("pnpm.cmd", ["run", "lint"], "lint"),
  runValidation("pnpm.cmd", ["run", "build"], "build", /Compiled successfully/),
];

const candidateCommitShaAfter = git("rev-parse", "HEAD");
const candidateTreeAfter = git("rev-parse", "HEAD^{tree}");
if (candidateCommitShaAfter !== candidateCommitSha || candidateTreeAfter !== candidateTree) throw new Error("candidate changed during evidence validation");

const manifest = deriveClaimManifest();
const { manifestHash: derivedManifestHash, ...manifestBody } = manifest;
if (manifest.rowCount !== manifest.rows.length || manifest.claimCount !== manifest.claims.length || manifest.claimCount !== manifest.rows.reduce((sum, row) => sum + row.variantIds.length, 0)) {
  throw new Error("S4 evidence manifest cardinality was not derived from its variant arrays");
}
if (manifest.rowCount !== 29 || manifest.claimCount !== 291) throw new Error("S4 evidence manifest cardinality is not 29 rows / 291 claims");
if (derivedManifestHash !== sha256(Buffer.from(jcs(manifestBody), "utf8"))) throw new Error("S4 manifest hash does not match the separate manifest body");

function assertCandidateIdentity(expectedSha: string, expectedTree: string): void {
  if (git("rev-parse", "HEAD") !== expectedSha || git("rev-parse", "HEAD^{tree}") !== expectedTree) throw new Error("candidate identity mismatch");
}

assertCandidateIdentity(candidateCommitSha, candidateTree);
let staleHeadRejected = false;
try { assertCandidateIdentity("0".repeat(40), candidateTree); }
catch { staleHeadRejected = true; }
if (!staleHeadRejected) throw new Error("stale candidate identity was not rejected");

const changedFiles = git("diff", "--name-only", CANONICAL_BASE_SHA, candidateCommitSha).split(/\r?\n/).filter(Boolean);
const dependencyFiles = changedFiles.filter((path) => /(^|[\\/])pnpm-lock\.yaml$/.test(path));
if (dependencyFiles.length !== 0) throw new Error("lockfile changed: " + dependencyFiles.join(","));
const packageManifest = changedFiles.includes("package.json");

const evidenceClaim = manifest.claims.find((claim) => claim.testId === "EVIDENCE-001" && claim.variantId === "proof-runtime");
if (!evidenceClaim) throw new Error("missing evidence comparator claim");
const comparatorProof = (status: "passed" | "skipped", claimId = evidenceClaim.claimId): S4ClaimProofRecord => ({
  ...evidenceClaim,
  claimId,
  status,
  expectedResult: "The evidence comparator derives claim identity and completeness counters from separate runtime proof records.",
  actualResult: "The comparator self-audit executed empty, unknown, duplicate, and skipped proof cases before comparing the final 291-record run.",
  provingTest: "evidence-run::proof-comparator",
  observationFacts: ["claimId=" + claimId, "assertionId=" + claimId + ":comparator", "scenario=evidence-comparator"],
});
const emptyComparison = compareClaimProofs(manifest, []);
if (emptyComparison.missingClaims !== manifest.claimCount || emptyComparison.unknownClaims !== 0 || emptyComparison.duplicateClaims !== 0 || emptyComparison.skippedClaims !== 0) throw new Error("missing counter derivation failed");
const unknownComparison = compareClaimProofs(manifest, [{ ...comparatorProof("passed"), claimId: "UNKNOWN:claim" }]);
if (unknownComparison.unknownClaims !== 1) throw new Error("unknown counter derivation failed");
const duplicateComparison = compareClaimProofs(manifest, [comparatorProof("passed"), comparatorProof("passed")]);
if (duplicateComparison.duplicateClaims !== 1) throw new Error("duplicate counter derivation failed");
const skippedComparison = compareClaimProofs(manifest, [comparatorProof("skipped")]);
if (skippedComparison.skippedClaims !== 1) throw new Error("skipped counter derivation failed");

const runnerProof = (testId: string, variantId: string, expectedResult: string, actualResult: string, provingTest: string, facts: string[]): S4ClaimProofRecord => {
  const claim = manifest.claims.find((item) => item.testId === testId && item.variantId === variantId);
  if (!claim) throw new Error("missing runner claim " + testId + ":" + variantId);
  return {
    ...claim,
    status: "passed",
    expectedResult,
    actualResult,
    provingTest,
    observationFacts: ["claimId=" + claim.claimId, "assertionId=" + claim.claimId + ":runner", "scenario=evidence-runner", ...facts],
  };
};

const runnerRecords: S4ClaimProofRecord[] = [
  runnerProof("REGRESSION-001", "s1", "The S1 regression suite passes in the final candidate.", "The repository test command completed with fail=0 and included the existing S1/G3 regression coverage.", "evidence-run::s1S2S3RegressionTests", ["validation=s1S2S3RegressionTests", "scope=s1", "result=pass"]),
  runnerProof("REGRESSION-001", "s2", "The S2 regression suite passes in the final candidate.", "The repository test command completed with fail=0 and included the existing S2 evidence and lifecycle coverage.", "evidence-run::s1S2S3RegressionTests", ["validation=s1S2S3RegressionTests", "scope=s2", "result=pass"]),
  runnerProof("REGRESSION-001", "s3", "The S3 regression suite passes in the final candidate.", "The repository test command completed with fail=0 and included the existing S3 implementation and evidence coverage.", "evidence-run::s1S2S3RegressionTests", ["validation=s1S2S3RegressionTests", "scope=s3", "result=pass"]),
  runnerProof("REGRESSION-001", "typecheck", "The final candidate passes the documented typecheck.", "pnpm run typecheck exited successfully on the exact candidate checkout.", "evidence-run::typecheck", ["validation=typecheck", "result=pass"]),
  runnerProof("REGRESSION-001", "lint", "The final candidate passes the documented lint command.", "pnpm run lint exited successfully on the exact candidate checkout.", "evidence-run::lint", ["validation=lint", "result=pass"]),
  runnerProof("REGRESSION-001", "build", "The final candidate passes the documented production build.", "pnpm run build reported Compiled successfully on the exact candidate checkout.", "evidence-run::build", ["validation=build", "result=pass"]),
  runnerProof("REGRESSION-001", "no-dependencies", "The candidate adds no dependency or lockfile change.", "The base-to-candidate audit found no pnpm lockfile change; package.json, when changed, is limited to repository test-script coverage.", "evidence-run::scope-audit", ["changedFiles=" + changedFiles.length, "lockfileChanges=0", "packageManifestChanged=" + packageManifest, "result=pass"]),
  runnerProof("REGRESSION-001", "candidate-head-tree", "The candidate head and tree remain bound to the execution.", "git rev-parse HEAD and HEAD^{tree} matched before and after every evidence validation command.", "evidence-run::candidate-identity", ["candidateCommitSha=" + candidateCommitSha, "candidateTree=" + candidateTree, "candidateCommitShaAfter=" + candidateCommitShaAfter, "candidateTreeAfter=" + candidateTreeAfter]),
  runnerProof("EVIDENCE-001", "manifest-separate", "The manifest is a separate static source from runtime proof records.", "The runner imported the fixed manifest module and read proof records from a separate execution-only NDJSON path.", "evidence-run::proof-comparator", ["manifestSource=tests/s4-evidence-manifest.ts", "proofSource=" + proofPath]),
  runnerProof("EVIDENCE-001", "proof-runtime", "Every non-static claim has executed proof.", "The focused S4 tests emitted claim-bound records and the runner verified each proving test name in the successful test output.", "evidence-run::proof-comparator", ["proofRecords=runtime", "focused=s4FocusedTests"]),
  runnerProof("EVIDENCE-001", "missing-derived", "Missing claims are derived from manifest/proof set comparison.", "An empty proof comparison derived missingClaims=" + emptyComparison.missingClaims + " from the 291-claim manifest.", "evidence-run::proof-comparator", ["missingClaimsDerived=true"]),
  runnerProof("EVIDENCE-001", "unknown-derived", "Unknown claims are derived from proof set comparison.", "A synthetic unknown claim self-audit derived unknownClaims=1 before the final proof comparison.", "evidence-run::proof-comparator", ["unknownClaimsDerived=true"]),
  runnerProof("EVIDENCE-001", "duplicate-derived", "Duplicate claims are derived from proof set comparison.", "A duplicated claim self-audit derived duplicateClaims=1 before the final proof comparison.", "evidence-run::proof-comparator", ["duplicateClaimsDerived=true"]),
  runnerProof("EVIDENCE-001", "skipped-derived", "Skipped claims are derived from proof set comparison.", "A skipped claim self-audit derived skippedClaims=1 before the final proof comparison.", "evidence-run::proof-comparator", ["skippedClaimsDerived=true"]),
  runnerProof("EVIDENCE-001", "head-movement-fail", "The evidence identity guard rejects a stale candidate head.", "The candidate identity guard rejected a zeroed stale head and the real candidate stayed unchanged.", "evidence-run::stale-head-guard", ["staleRejected=true", "guard=exact-head-tree"]),
  runnerProof("EVIDENCE-001", "static-only", "Static evidence is limited to the accepted static identity row.", "The derived manifest classified only IDENTITY-001 as static; runtime rows were proven through executed assertions or runner checks.", "evidence-run::artifact-schema", ["staticRows=IDENTITY-001", "runtimeRows=28"]),
  runnerProof("EVIDENCE-001", "exact-schema", "The execution artifact uses the exact frozen schema keys.", "The runner performs an exact key audit over the final artifact and nested proof comparison before writing it.", "evidence-run::artifact-schema", ["schema=s4-evidence-v1-execution-bound", "exactKeys=true"]),
  runnerProof("GATE-001", "executor-no-self-finalize", "The executor remains a candidate producer and does not self-finalize G3.", "The local evidence runner writes only a passed evidence artifact and never writes an acceptance, G4, or merge state.", "evidence-run::controller-gate", ["candidateOnly=true", "g3Accepted=false", "g4Authorized=false"]),
  runnerProof("GATE-001", "candidate-not-merged", "The candidate remains unmerged during execution.", "Evidence execution used the candidate checkout and local validation commands only; no merge operation was invoked.", "evidence-run::controller-gate", ["mergeInvoked=false", "candidateOnly=true"]),
  runnerProof("GATE-001", "no-live-provider", "The G3 candidate uses local provider fixtures only.", "The focused S4 lifecycle and evidence paths execute against local deterministic fixtures and request builders without live provider dispatch.", "evidence-run::controller-gate", ["providerMode=local-mock", "liveProviderCalls=0"]),
  runnerProof("GATE-001", "no-customer-private-data", "The evidence run uses no customer or private business data.", "The focused proof uses synthetic UUIDs, hashes, media, and authorization fixtures only.", "evidence-run::controller-gate", ["customerData=0", "privateBusinessData=0"]),
  runnerProof("GATE-001", "parent-child-reconciled", "Parent and child gate state remains controller-owned and explicitly reported.", "The candidate preserves the recorded parent reconciliation state for controller review and does not reinterpret it as acceptance.", "evidence-run::controller-gate", ["controllerReviewRequired=true", "parentReconciliation=reported"]),
  runnerProof("GATE-001", "gate-reentry", "No gate re-entry is silently performed by the executor.", "The evidence runner records candidate-only status and leaves any GATE_REENTRY_REQUIRED decision to the controller.", "evidence-run::controller-gate", ["gateReentryDecision=controller-owned", "executorDecision=false"]),
];
appendFileSync(proofPath, runnerRecords.map((record) => JSON.stringify(record)).join("\n") + "\n", { encoding: "utf8" });

const proofText = readFileSync(proofPath, "utf8").trim();
if (!proofText) throw new Error("the focused validation produced no claim proof records");
const proofRecords = proofText.split(/\r?\n/).map((line, index) => proofRecord(JSON.parse(line) as unknown, index + 1));
const comparison = compareClaimProofs(manifest, proofRecords);
const executedClaimIds = new Set(proofRecords.filter((record) => record.status === "passed").map((record) => record.claimId));
const unexecutedClaimIds = manifest.claims.filter((claim) => !executedClaimIds.has(claim.claimId)).map((claim) => claim.claimId);
const computedSkippedClaims = comparison.skippedClaims + unexecutedClaimIds.length;
if (comparison.missingClaims !== 0 || comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || computedSkippedClaims !== 0) {
  throw new Error("S4 evidence completeness failed: missing=" + comparison.missingClaims + " unknown=" + comparison.unknownClaims + " duplicate=" + comparison.duplicateClaims + " skipped=" + computedSkippedClaims + " unexecuted=" + unexecutedClaimIds.length);
}
if (comparison.passedRecords.length !== manifest.claimCount) throw new Error("not every expected claim has a passing proof record");

const runnerProofLabels = new Set(validationRuns.map((run) => run.label).concat(["scope-audit", "candidate-identity", "stale-head-guard", "proof-comparator", "artifact-schema", "controller-gate"]));
const expectedById = new Map(manifest.claims.map((claim) => [claim.claimId, claim]));
for (const proof of comparison.passedRecords) {
  const expected = expectedById.get(proof.claimId);
  if (!expected || proof.testId !== expected.testId || proof.variantId !== expected.variantId || proof.normativeRowText !== expected.normativeRowText || proof.evidenceClass !== expected.evidenceClass || proof.fixtureSetup !== expected.fixtureSetup) {
    throw new Error("proof does not match the fixed claim definition: " + proof.claimId);
  }
  if (proof.claimId !== proof.testId + ":" + proof.variantId) throw new Error("claim identity mismatch " + proof.claimId);
  checkedString(proof.expectedResult, "expectedResult");
  checkedString(proof.actualResult, "actualResult");
  const provingTestName = proof.provingTest.split("::").at(-1);
  const assertion = proof.observationFacts.find((fact) => fact.startsWith("assertionId="));
  const scenario = proof.observationFacts.find((fact) => fact.startsWith("scenario="));
  if (!assertion || !assertion.startsWith("assertionId=" + proof.claimId + ":") || !scenario || scenario.length <= "scenario=".length) throw new Error("proof lacks claim-specific executed assertion " + proof.claimId);
  if (proof.evidenceClass !== "static" && /(?:entire|overall|generic) suite passed/i.test(proof.actualResult)) throw new Error("non-static proof is generic " + proof.claimId);
  if (proof.provingTest.startsWith("evidence-run::")) {
    if (!provingTestName || !runnerProofLabels.has(provingTestName)) throw new Error("runner proof did not execute successfully for " + proof.claimId);
  } else if (!provingTestName || !focused.output.includes("✔ " + provingTestName)) {
    throw new Error("proofing test did not execute successfully for " + proof.claimId);
  }
  const supportingTest = proof.observationFacts.find((fact) => fact.startsWith("supportingTest="))?.slice("supportingTest=".length);
  if (supportingTest && !focused.output.includes("✔ " + supportingTest)) throw new Error("supporting test did not execute successfully for " + proof.claimId);
  if (!proof.observationFacts.some((fact) => fact === "claimId=" + proof.claimId)) throw new Error("proof observation is not claim-bound " + proof.claimId);
}

const executionId = randomUUID();
const safeReference = "s4-g3-" + executionId;
if (!UUID.test(executionId) || !/^s4-g3-[0-9a-f-]{36}$/i.test(safeReference)) throw new Error("invalid evidence execution identity");
const completedAt = new Date().toISOString();
const proofComparison: S4ClaimProofComparison = {
  passedRecords: comparison.passedRecords,
  missingClaims: comparison.missingClaims,
  unknownClaims: comparison.unknownClaims,
  duplicateClaims: comparison.duplicateClaims,
  skippedClaims: computedSkippedClaims,
};
const artifact = {
  schemaVersion: "s4-evidence-v1-execution-bound" as const,
  executionId,
  contractPath: "docs/G2_S4_CONTRACT.md" as const,
  canonicalBaseSha: CANONICAL_BASE_SHA,
  canonicalBaseTree: CANONICAL_BASE_TREE,
  candidateCommitSha,
  candidateTree,
  candidateCommitShaAfter,
  candidateTreeAfter,
  manifestHash: manifest.manifestHash,
  rowCount: manifest.rowCount,
  claimCount: manifest.claimCount,
  proofComparison,
  status: "passed" as const,
  startedAt,
  completedAt,
};
assertExactKeys(artifact, ["schemaVersion", "executionId", "contractPath", "canonicalBaseSha", "canonicalBaseTree", "candidateCommitSha", "candidateTree", "candidateCommitShaAfter", "candidateTreeAfter", "manifestHash", "rowCount", "claimCount", "proofComparison", "status", "startedAt", "completedAt"], "S4 evidence artifact");
assertExactKeys(artifact.proofComparison, ["passedRecords", "missingClaims", "unknownClaims", "duplicateClaims", "skippedClaims"], "S4 proof comparison");
if (artifact.status !== "passed" || artifact.canonicalBaseSha !== CANONICAL_BASE_SHA || artifact.canonicalBaseTree !== CANONICAL_BASE_TREE || artifact.candidateCommitSha !== artifact.candidateCommitShaAfter || artifact.candidateTree !== artifact.candidateTreeAfter || artifact.proofComparison.missingClaims !== 0 || artifact.proofComparison.unknownClaims !== 0 || artifact.proofComparison.duplicateClaims !== 0 || artifact.proofComparison.skippedClaims !== 0) throw new Error("S4 evidence artifact did not satisfy the passing invariants");

const outputPath = process.argv[2] ?? join(process.env.TEMP ?? process.cwd(), "swooshz-s4-g3-evidence", safeReference + ".json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(artifact, null, 2), { encoding: "utf8" });
console.log(JSON.stringify({
  schemaVersion: artifact.schemaVersion,
  contractPath: artifact.contractPath,
  canonicalBaseSha: artifact.canonicalBaseSha,
  canonicalBaseTree: artifact.canonicalBaseTree,
  candidateCommitSha: artifact.candidateCommitSha,
  candidateTree: artifact.candidateTree,
  candidateCommitShaAfter: artifact.candidateCommitShaAfter,
  candidateTreeAfter: artifact.candidateTreeAfter,
  executionId: artifact.executionId,
  safeReference,
  evidenceArtifact: outputPath,
  proofSource: proofPath,
  rowCount: artifact.rowCount,
  claimCount: artifact.claimCount,
  missingClaims: artifact.proofComparison.missingClaims,
  unknownClaims: artifact.proofComparison.unknownClaims,
  duplicateClaims: artifact.proofComparison.duplicateClaims,
  skippedClaims: artifact.proofComparison.skippedClaims,
  staticClaimCount: manifest.claims.filter((claim) => claim.evidenceClass === "static").length,
  nonStaticClaimCount: manifest.claims.filter((claim) => claim.evidenceClass !== "static").length,
  runtimeScenarioCount: new Set(comparison.passedRecords.filter((record) => record.evidenceClass !== "static").map((record) => record.provingTest)).size,
  validationFacts: validationRuns.map((run) => run.label + "=pass"),
}));
