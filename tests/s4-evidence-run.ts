import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compareClaimProofs, deriveClaimManifest, type S4ClaimProofComparison, type S4ClaimProofRecord } from "./s4-evidence-manifest";
import { proveS4Claim } from "./s4-proof";
import { auditRepositorySurfaces, type S4DependencyAudit, type S4ScriptAudit } from "./s4-repository-audit";
import { S4_G3_AUTHORIZED_DEPENDENCY_METADATA } from "./s4-dependency-authority";
import { jcs, sha256 } from "../src/lib/utils";
import { OpenAIS4Provider } from "../src/lib/s4-provider";

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_MAIN_SHA = "a43c833c8da57814d2e97ebf014c1d2762cb2d80";
const CANONICAL_MAIN_TREE = "b8b3810cfdc0334441a0e8aacde39257ac020c27";
const CANONICAL_BASE_SHA = "2e01a90b6b2f40f4729764970a8cb89f25bbe0c8";
const CANONICAL_BASE_TREE = "b144ae4bc0bb80bee82d696be0f7e550af0a3ae9";
const RUNNER_TEST_IDS = new Set(["REGRESSION-001", "EVIDENCE-001", "GATE-001"]);
const PROVIDER_CREDENTIAL_NAMES = ["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"] as const;
const AUTHORITY_REF = "5481945791";
const PRIOR_AUTHORITY_REFS = ["5476041097", "5477010746"];
const AUTHORIZED_PACKAGE_NAME = "react-test-renderer";
const AUTHORIZED_PACKAGE_VERSION = "19.2.8";
const AUTHORIZED_DEPENDENCY_PURPOSE = "direct in-process rendered S4Screen component/event evidence for submit, image retry, assessment retry and rollback.";
const BASE_TEST_SCRIPT = "tsx --test tests/g3.test.ts tests/s2-evidence.test.ts tests/s2-lifecycle.test.ts";
const CANDIDATE_TEST_SCRIPT = "tsx --test tests/g3.test.ts tests/s2-evidence.test.ts tests/s2-lifecycle.test.ts tests/s3.test.ts tests/s3-evidence.test.ts tests/s4.test.ts tests/s4-evidence.test.ts";
const PRESERVED_REQUIRED_VALIDATION = [
  "testScriptBase=" + BASE_TEST_SCRIPT,
  "testFile=tests/g3.test.ts",
  "testFile=tests/s2-evidence.test.ts",
  "testFile=tests/s2-lifecycle.test.ts",
  "build=next build",
  "lint=tsc --noEmit",
  "typecheck=tsc --noEmit",
];

type ValidationResult = {
  label: string;
  command: string;
  args: string[];
  output: string;
  exitCode: 0;
  providerCredentialEnvironmentBlanked: true;
  blankedProviderCredentialNames: string[];
};

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

function git(...args: string[]): string {
  const environment = { ...process.env };
  for (const name of PROVIDER_CREDENTIAL_NAMES) environment[name] = "";
  return execFileSync("git", args, { encoding: "utf8", env: environment }).trim();
}

function gitSucceeds(...args: string[]): boolean {
  try { git(...args); return true; } catch { return false; }
}

function safeValidationEnvironment(environment: Record<string, string>): { values: NodeJS.ProcessEnv; names: string[] } {
  const values = { ...process.env, ...environment };
  for (const name of PROVIDER_CREDENTIAL_NAMES) values[name] = "";
  return { values, names: Array.from(PROVIDER_CREDENTIAL_NAMES) };
}

function assertCandidateIdentity(expectedSha: string, expectedTree: string): void {
  if (git("rev-parse", "HEAD") !== expectedSha || git("rev-parse", "HEAD^{tree}") !== expectedTree) {
    throw new Error("candidate identity mismatch");
  }
}

function assertCandidateWorktreeClean(): void {
  if (git("status", "--porcelain") !== "") throw new Error("candidate worktree changed during evidence execution");
}

function runValidation(command: string, args: string[], label: string, environment: Record<string, string> = {}): ValidationResult {
  assertCandidateIdentity(candidateCommitSha, candidateTree);
  assertCandidateWorktreeClean();
  const safeEnvironment = safeValidationEnvironment(environment);
  let output: string;
  try {
    const executable = command === "pnpm.cmd" ? (process.env.ComSpec ?? "cmd.exe") : command;
    const invocation = command === "pnpm.cmd" ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")] : args;
    output = execFileSync(executable, invocation, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment.values,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(label + " failed: " + (error instanceof Error ? error.message : String(error)));
  }
  assertCandidateIdentity(candidateCommitSha, candidateTree);
  assertCandidateWorktreeClean();
  return {
    label,
    command,
    args: Array.from(args),
    output,
    exitCode: 0,
    providerCredentialEnvironmentBlanked: true,
    blankedProviderCredentialNames: safeEnvironment.names,
  };
}

function checkedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid evidence " + name);
  return value;
}

function proofRecord(value: unknown, line: number): S4ClaimProofRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid proof record at line " + line);
  const record = value as Record<string, unknown>;
  const expectedKeys = ["testId", "claimId", "variantId", "normativeRowText", "evidenceClass", "fixtureSetup", "status", "expectedResult", "actualResult", "provingTest", "assertionId", "observationFacts"].sort();
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("proof record shape mismatch at line " + line);
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "skipped") throw new Error("invalid proof status at line " + line);
  if (!Array.isArray(record.observationFacts) || record.observationFacts.some((item) => typeof item !== "string")) throw new Error("invalid proof observations at line " + line);
  for (const field of ["testId", "claimId", "variantId", "normativeRowText", "evidenceClass", "fixtureSetup", "expectedResult", "actualResult", "provingTest", "assertionId"]) {
    if (typeof record[field] !== "string" || record[field].length === 0) throw new Error("invalid proof field " + field + " at line " + line);
  }
  return record as unknown as S4ClaimProofRecord;
}

function executionReceipt(value: unknown, line: number): S4ClaimExecution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid execution receipt at line " + line);
  const receipt = value as Record<string, unknown>;
  const expectedKeys = ["schemaVersion", "receiptId", "claimId", "provingTest", "assertionId", "scenario", "observationHash", "assertionPassed"].sort();
  const actualKeys = Object.keys(receipt).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new Error("execution receipt shape mismatch at line " + line);
  if (receipt.schemaVersion !== "s4-claim-execution-v1" || receipt.assertionPassed !== true) throw new Error("invalid execution receipt status at line " + line);
  for (const field of ["receiptId", "claimId", "provingTest", "assertionId", "scenario"]) {
    if (typeof receipt[field] !== "string" || receipt[field].length === 0) throw new Error("invalid execution receipt field " + field + " at line " + line);
  }
  if (!UUID.test(receipt.receiptId as string) || typeof receipt.observationHash !== "string" || !HASH.test(receipt.observationHash)) {
    throw new Error("invalid execution receipt identity at line " + line);
  }
  return receipt as unknown as S4ClaimExecution;
}

function readNdjson(path: string): unknown[] {
  if (!existsSync(path)) throw new Error("missing evidence stream " + path);
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error("invalid JSON in " + path + " at line " + (index + 1) + ": " + (error instanceof Error ? error.message : String(error)));
    }
  });
}

function readProofRecords(path: string): S4ClaimProofRecord[] {
  return readNdjson(path).map((value, index) => proofRecord(value, index + 1));
}

function readExecutionReceipts(path: string): S4ClaimExecution[] {
  return readNdjson(path).map((value, index) => executionReceipt(value, index + 1));
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = Array.from(keys).sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new Error(label + " shape mismatch");
}

const candidateCommitSha = git("rev-parse", "HEAD");
const candidateTree = git("rev-parse", "HEAD^{tree}");
if (!SHA.test(candidateCommitSha) || !SHA.test(candidateTree) || candidateCommitSha === CANONICAL_BASE_SHA) throw new Error("candidate identity is not a distinct 40-hex git object");
if (git("rev-parse", "origin/main") !== CANONICAL_MAIN_SHA || git("rev-parse", "origin/main^{tree}") !== CANONICAL_MAIN_TREE) throw new Error("canonical main identity changed during evidence execution");
assertCandidateWorktreeClean();
const startedAt = new Date().toISOString();

const proofDirectory = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "swooshz-s4-g3-proof-"));
const proofPath = join(proofDirectory, "claims.ndjson");
const executionPath = join(proofDirectory, "executions.ndjson");
const noProviderCredentialEnvironment = Object.fromEntries(PROVIDER_CREDENTIAL_NAMES.map((name) => [name, ""]));
const proofEnvironment = { S4_EVIDENCE_PROOF_PATH: proofPath, S4_EVIDENCE_EXECUTION_PATH: executionPath, ...noProviderCredentialEnvironment };
const noProofEnvironment = { S4_EVIDENCE_PROOF_PATH: "", S4_EVIDENCE_EXECUTION_PATH: "" };
const s4ImplementationTests = runValidation(
  "node",
  ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s4.test.ts"],
  "s4ImplementationTests",
  proofEnvironment,
);
const s4EvidenceSuite = runValidation(
  "node",
  ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s4-evidence.test.ts"],
  "s4EvidenceSuite",
  proofEnvironment,
);
const s1Tests = runValidation("node", ["node_modules/tsx/dist/cli.mjs", "--test", "tests/g3.test.ts"], "s1Tests", noProofEnvironment);
const s2Tests = runValidation("node", ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s2-evidence.test.ts", "tests/s2-lifecycle.test.ts"], "s2Tests", noProofEnvironment);
const s3Tests = runValidation("node", ["node_modules/tsx/dist/cli.mjs", "--test", "tests/s3.test.ts", "tests/s3-evidence.test.ts"], "s3Tests", noProofEnvironment);
const fullRegressionTests = runValidation("pnpm.cmd", ["test"], "fullRegressionTests", noProofEnvironment);
const typecheck = runValidation("pnpm.cmd", ["run", "typecheck"], "typecheck", noProofEnvironment);
const lint = runValidation("pnpm.cmd", ["run", "lint"], "lint", noProofEnvironment);
const build = runValidation("pnpm.cmd", ["run", "build"], "build", noProofEnvironment);
const diffCheck = runValidation("git", ["diff", "--check", CANONICAL_BASE_SHA, candidateCommitSha], "diffCheck", noProofEnvironment);
const validationRuns: ValidationResult[] = [s4ImplementationTests, s4EvidenceSuite, s1Tests, s2Tests, s3Tests, fullRegressionTests, typecheck, lint, build, diffCheck];
const validationCandidateCommitShaAfter = git("rev-parse", "HEAD");
const validationCandidateTreeAfter = git("rev-parse", "HEAD^{tree}");
assertCandidateIdentity(candidateCommitSha, candidateTree);
assert.equal(validationCandidateCommitShaAfter, candidateCommitSha);
assert.equal(validationCandidateTreeAfter, candidateTree);
assertCandidateWorktreeClean();

const manifest = deriveClaimManifest();
const { manifestHash: derivedManifestHash, ...manifestBody } = manifest;
if (manifest.rowCount !== manifest.rows.length || manifest.claimCount !== manifest.claims.length || manifest.claimCount !== manifest.rows.reduce((sum, row) => sum + row.variantIds.length, 0)) {
  throw new Error("S4 evidence manifest cardinality was not derived from its variant arrays");
}
if (manifest.rowCount !== 29 || manifest.claimCount !== 291) throw new Error("S4 evidence manifest cardinality is not 29 rows / 291 claims");
if (derivedManifestHash !== sha256(Buffer.from(jcs(manifestBody), "utf8"))) throw new Error("S4 manifest hash does not match the separate manifest body");

const runnerClaims = manifest.claims.filter((claim) => RUNNER_TEST_IDS.has(claim.testId));
const focusedClaims = manifest.claims.filter((claim) => !RUNNER_TEST_IDS.has(claim.testId));
const focusedClaimIds = new Set(focusedClaims.map((claim) => claim.claimId));

function factValue(facts: string[], prefix: string, label: string): string {
  const matches = facts.filter((fact) => fact.startsWith(prefix));
  if (matches.length !== 1) throw new Error(label + " must have exactly one " + prefix + " fact");
  return checkedString(matches[0].slice(prefix.length), label);
}

function assertExecutionBinding(records: S4ClaimProofRecord[], receipts: S4ClaimExecution[]): void {
  const receiptsById = new Map<string, S4ClaimExecution>();
  for (const receipt of receipts) {
    if (receiptsById.has(receipt.receiptId)) throw new Error("duplicate execution receipt " + receipt.receiptId);
    receiptsById.set(receipt.receiptId, receipt);
  }

  const usedReceiptIds = new Set<string>();
  for (const record of records) {
    const receiptFact = record.observationFacts.find((fact) => fact.startsWith("executionReceiptId="));
    const hashFact = record.observationFacts.find((fact) => fact.startsWith("executionObservationHash="));
    if (record.status !== "passed") {
      if (receiptFact || hashFact) throw new Error("non-passed proof contains execution metadata " + record.claimId);
      continue;
    }
    if (record.claimId !== record.testId + ":" + record.variantId) throw new Error("claim identity mismatch " + record.claimId);
    const claimFact = factValue(record.observationFacts, "claimId=", record.claimId);
    if (claimFact !== record.claimId) throw new Error("proof claim fact mismatch " + record.claimId);
    const assertionId = factValue(record.observationFacts, "assertionId=", record.claimId);
    if (record.assertionId !== assertionId) throw new Error("proof assertion ID mismatch " + record.claimId);
    const scenario = factValue(record.observationFacts, "scenario=", record.claimId);
    const receiptId = factValue(record.observationFacts, "executionReceiptId=", record.claimId);
    const observationHash = factValue(record.observationFacts, "executionObservationHash=", record.claimId);
    if (receiptFact !== "executionReceiptId=" + receiptId || hashFact !== "executionObservationHash=" + observationHash) {
      throw new Error("proof execution metadata is not unique " + record.claimId);
    }
    const receipt = receiptsById.get(receiptId);
    if (!receipt) throw new Error("proof has no matching execution receipt " + record.claimId);
    if (usedReceiptIds.has(receiptId)) throw new Error("execution receipt reused " + receiptId);
    if (receipt.claimId !== record.claimId || receipt.provingTest !== record.provingTest || receipt.assertionId !== assertionId || receipt.scenario !== scenario || receipt.observationHash !== observationHash || receipt.assertionPassed !== true) {
      throw new Error("execution receipt does not match proof " + record.claimId);
    }
    const observationFacts = record.observationFacts.filter((fact) => !fact.startsWith("executionReceiptId=") && !fact.startsWith("executionObservationHash="));
    const expectedHash = sha256(Buffer.from(jcs({
      claimId: record.claimId,
      provingTest: record.provingTest,
      assertionId,
      scenario,
      observationFacts,
    }), "utf8"));
    if (expectedHash !== receipt.observationHash) throw new Error("execution observation hash mismatch " + record.claimId);
    usedReceiptIds.add(receiptId);
  }
  if (usedReceiptIds.size !== receipts.length) throw new Error("execution receipt stream contains an orphan receipt");
}

function assertClaimSet(records: S4ClaimProofRecord[], expectedClaims: Array<{ claimId: string }>, label: string): void {
  const expectedIds = new Set(expectedClaims.map((claim) => claim.claimId));
  const actualIds = new Set(records.map((record) => record.claimId));
  assert.equal(records.length, expectedClaims.length, label + " count");
  assert.equal(actualIds.size, records.length, label + " duplicate identity");
  for (const claim of expectedClaims) assert.equal(actualIds.has(claim.claimId), true, label + " missing " + claim.claimId);
  for (const record of records) assert.equal(expectedIds.has(record.claimId), true, label + " unexpected " + record.claimId);
}

function loadFocusedProofState(): { records: S4ClaimProofRecord[]; receipts: S4ClaimExecution[]; comparison: S4ClaimProofComparison } {
  const allRecords = readProofRecords(proofPath);
  const allReceipts = readExecutionReceipts(executionPath);
  const unexpectedRecords = allRecords.filter((record) => !focusedClaimIds.has(record.claimId) && !RUNNER_TEST_IDS.has(record.testId));
  if (unexpectedRecords.length !== 0) throw new Error("unexpected pre-runner proof record " + unexpectedRecords[0].claimId);
  const records = allRecords.filter((record) => focusedClaimIds.has(record.claimId));
  const receipts = allReceipts.filter((receipt) => focusedClaimIds.has(receipt.claimId));
  assertClaimSet(records, focusedClaims, "focused proof");
  assert.equal(records.every((record) => record.status === "passed"), true, "focused proof status");
  assert.equal(receipts.length, records.length, "focused receipt count");
  assertExecutionBinding(records, receipts);
  const comparison = compareClaimProofs(manifest, records);
  assert.equal(comparison.failedClaims, 0, "focused failed claims");
  assert.equal(comparison.missingClaims, runnerClaims.length, "focused missing runner rows");
  assert.equal(comparison.unknownClaims, 0, "focused unknown claims");
  assert.equal(comparison.duplicateClaims, 0, "focused duplicate claims");
  assert.equal(comparison.skippedClaims, 0, "focused skipped claims");
  return { records, receipts, comparison };
}

const focusedProofState = loadFocusedProofState();

const changedFiles = git("diff", "--name-only", CANONICAL_BASE_SHA, candidateCommitSha).split(/\r?\n/).filter(Boolean);
const contractText = readFileSync("docs/G2_S4_CONTRACT.md", "utf8");
const candidateSourceFiles = Object.fromEntries(
  git("ls-files", "--").split(/\r?\n/).filter((path) => /\.(?:c|m)?tsx?$|\.(?:c|m)?jsx?$/.test(path)).map((path) => [path, readFileSync(path, "utf8")]),
);
const executedValidationReceipts = validationRuns.map((run) => run.label + "=exitCode:" + run.exitCode);
const repositoryAudit = auditRepositorySurfaces({
  basePackageText: git("show", CANONICAL_BASE_SHA + ":package.json"),
  candidatePackageText: readFileSync("package.json", "utf8"),
  baseLockfileText: git("show", CANONICAL_BASE_SHA + ":pnpm-lock.yaml"),
  candidateLockfileText: readFileSync("pnpm-lock.yaml", "utf8"),
  sourceFiles: candidateSourceFiles,
  dependencyAuthority: {
    packageName: AUTHORIZED_PACKAGE_NAME,
    packageVersion: AUTHORIZED_PACKAGE_VERSION,
    baseManifestValue: null,
    manifestPath: "devDependencies",
    purpose: AUTHORIZED_DEPENDENCY_PURPOSE,
    allowedImportSurface: ["tests/s4.test.ts", "tests/s4-evidence.test.ts", "tests/s4-evidence-run.ts", "tests/react-test-renderer.d.ts"],
    authorityRefs: [AUTHORITY_REF, ...PRIOR_AUTHORITY_REFS],
    requiredAuthorityRef: AUTHORITY_REF,
    baselineSha: CANONICAL_BASE_SHA,
    baselineTree: CANONICAL_BASE_TREE,
    expectedMetadata: S4_G3_AUTHORIZED_DEPENDENCY_METADATA,
  },
  scriptAuthority: {
    scriptName: "test",
    baseValue: BASE_TEST_SCRIPT,
    candidateValue: CANDIDATE_TEST_SCRIPT,
    purpose: "Expand the default repository regression suite to include S3 and S4 tests while retaining every baseline test.",
    authorityRefs: [AUTHORITY_REF],
    requiredAuthorityRef: AUTHORITY_REF,
    preservedRequiredValidation: PRESERVED_REQUIRED_VALIDATION,
    removedRequiredValidation: [],
    executedRequiredValidation: executedValidationReceipts,
    requiredValidationLabels: ["s1Tests", "s2Tests", "s3Tests", "s4ImplementationTests", "s4EvidenceSuite", "fullRegressionTests", "typecheck", "lint", "build", "diffCheck"],
  },
});
const dependencyAudit: S4DependencyAudit = repositoryAudit.dependencyAudit;
const scriptAudit: S4ScriptAudit = repositoryAudit.scriptAudit;

function assertValidationPassed(label: string): void {
  const run = validationRuns.find((item) => item.label === label);
  assert.ok(run, "missing validation " + label);
  assert.equal(run.exitCode, 0, label + " did not exit successfully");
}

const evidenceClaim = manifest.claims.find((claim) => claim.testId === "EVIDENCE-001" && claim.variantId === "proof-runtime");
if (!evidenceClaim) throw new Error("missing evidence comparator claim");
const comparatorProof = (status: "passed" | "failed" | "skipped", claimId = evidenceClaim.claimId): S4ClaimProofRecord => ({
  ...evidenceClaim,
  claimId,
  status,
  expectedResult: "The evidence comparator derives claim identity and completeness counters from separate runtime proof records.",
  actualResult: "The comparator self-audit executed empty, unknown, duplicate, failed, and skipped proof cases before comparing the final run.",
  provingTest: "evidence-run::comparator-self-audit",
  assertionId: claimId + ":comparator",
  observationFacts: ["claimId=" + claimId, "assertionId=" + claimId + ":comparator", "scenario=evidence-comparator"],
});

async function runnerProof(
  testId: string,
  variantId: string,
  expectedResult: string,
  actualResult: string,
  provingTest: string,
  facts: string[],
  assertion: () => void | Promise<void>,
): Promise<void> {
  const claim = manifest.claims.find((item) => item.testId === testId && item.variantId === variantId);
  if (!claim) throw new Error("missing runner claim " + testId + ":" + variantId);
  await proveS4Claim({
    testId,
    variantId,
    expectedResult,
    actualResult,
    provingTest: "evidence-run::" + provingTest,
    assertionId: claim.claimId + ":runner",
    scenario: "evidence-runner/" + testId + "/" + variantId,
    observationFacts: facts,
  }, assertion);
}

const emptyComparison = compareClaimProofs(manifest, []);
const unknownComparison = compareClaimProofs(manifest, [{ ...comparatorProof("passed"), claimId: "UNKNOWN:claim" }]);
const duplicateComparison = compareClaimProofs(manifest, [comparatorProof("passed"), comparatorProof("passed")]);
const failedComparison = compareClaimProofs(manifest, [comparatorProof("failed")]);
const skippedComparison = compareClaimProofs(manifest, [comparatorProof("skipped")]);

process.env.S4_EVIDENCE_PROOF_PATH = proofPath;
process.env.S4_EVIDENCE_EXECUTION_PATH = executionPath;

async function main(): Promise<void> {
await runnerProof("REGRESSION-001", "s1", "The S1 regression suite passes in the final candidate.", "The repository-native S1 command exited successfully on the exact candidate checkout.", "s1Tests", ["validation=s1Tests", "scope=s1", "exitCode=" + s1Tests.exitCode], () => {
  assertValidationPassed("s1Tests");
});
await runnerProof("REGRESSION-001", "s2", "The S2 regression suite passes in the final candidate.", "The repository-native S2 command exited successfully on the exact candidate checkout.", "s2Tests", ["validation=s2Tests", "scope=s2", "exitCode=" + s2Tests.exitCode], () => {
  assertValidationPassed("s2Tests");
});
await runnerProof("REGRESSION-001", "s3", "The S3 regression suite passes in the final candidate.", "The repository-native S3 command exited successfully on the exact candidate checkout.", "s3Tests", ["validation=s3Tests", "scope=s3", "exitCode=" + s3Tests.exitCode], () => {
  assertValidationPassed("s3Tests");
});
await runnerProof("REGRESSION-001", "typecheck", "The final candidate passes the documented typecheck.", "pnpm run typecheck exited successfully on the exact candidate checkout.", "typecheck", ["validation=typecheck", "exitCode=" + typecheck.exitCode], () => {
  assertValidationPassed("typecheck");
});
await runnerProof("REGRESSION-001", "lint", "The final candidate passes the documented lint command.", "pnpm run lint exited successfully on the exact candidate checkout.", "lint", ["validation=lint", "exitCode=" + lint.exitCode], () => {
  assertValidationPassed("lint");
});
await runnerProof("REGRESSION-001", "build", "The final candidate passes the documented production build.", "pnpm run build exited successfully on the exact candidate checkout.", "build", ["validation=build", "exitCode=" + build.exitCode], () => {
  assertValidationPassed("build");
});
await runnerProof("REGRESSION-001", "no-dependencies", "The candidate has no unapproved dependency/runtime/package/script expansion; all governed deltas are complete and conformant.", "The executed complete dependency/lockfile audit and complete script-map audit classified the authorized react-test-renderer dev-only closure and test-script expansion as changed_authorized_conformant, with the production graph unchanged and no runtime reachability.", "scope-audit", [
  "changedFiles=" + changedFiles.length,
  "dependencyAuditState=" + dependencyAudit.auditState,
  "dependencyDisposition=" + dependencyAudit.disposition,
  "scriptAuditState=" + scriptAudit.auditState,
  "scriptDisposition=" + scriptAudit.disposition,
  "completeMapEqual=" + scriptAudit.completeMapEqual,
  "authorizedPackage=react-test-renderer@19.2.8",
  "authorityRefs=" + AUTHORITY_REF + "," + PRIOR_AUTHORITY_REFS.join(","),
  "productionGraphUnchanged=" + dependencyAudit.productionGraphUnchanged,
  "testOnlyRuntimeReachabilityAbsent=" + dependencyAudit.testOnlyRuntimeReachabilityAbsent,
  "lockfileDeltaCount=" + dependencyAudit.deltas.filter((delta) => delta.surface === "lockfile").length,
  "scriptDeltaCount=" + scriptAudit.changedScripts.length,
  ...PRESERVED_REQUIRED_VALIDATION,
], () => {
  assert.equal(dependencyAudit.auditState, "complete");
  assert.equal(scriptAudit.auditState, "complete");
  assert.equal(dependencyAudit.disposition, "changed_authorized_conformant");
  assert.equal(scriptAudit.disposition, "changed_authorized_conformant");
  assert.equal(dependencyAudit.productionGraphUnchanged, true);
  assert.equal(dependencyAudit.testOnlyRuntimeReachabilityAbsent, true);
  assert.equal(scriptAudit.completeMapEqual, false);
  assert.deepEqual(dependencyAudit.deltas.map((delta) => delta.path).sort(), [
    "package.json.devDependencies.react-test-renderer",
    "pnpm-lock.yaml.importers[\".\"].devDependencies.react-test-renderer",
    "pnpm-lock.yaml.packages.react-is@19.2.8",
    "pnpm-lock.yaml.packages.react-test-renderer@19.2.8",
    "pnpm-lock.yaml.snapshots.react-is@19.2.8",
    "pnpm-lock.yaml.snapshots.react-test-renderer@19.2.8(react@19.2.8)",
  ].sort());
  assert.equal(dependencyAudit.deltas.every((delta) => delta.disposition === "changed_authorized_conformant"), true);
  assert.equal(dependencyAudit.deltas.every((delta) => delta.authorityRefs.includes(AUTHORITY_REF)), true);
  const manifestDelta = dependencyAudit.deltas.find((delta) => delta.path === "package.json.devDependencies.react-test-renderer");
  assert.ok(manifestDelta);
  assert.equal(manifestDelta.baseValue, null);
  assert.equal(manifestDelta.candidateValue, AUTHORIZED_PACKAGE_VERSION);
  assert.equal(manifestDelta.purpose, AUTHORIZED_DEPENDENCY_PURPOSE);
  const lockDeltas = dependencyAudit.deltas.filter((delta) => delta.surface === "lockfile");
  assert.equal(lockDeltas.every((delta) => delta.evidenceFacts.some((fact) => fact.startsWith("lockfileDeltaPaths="))), true);
  assert.equal(lockDeltas.filter((delta) => delta.path.includes("packages.")).every((delta) => delta.candidateValue?.includes("sha512-")), true);
  assert.equal(scriptAudit.changedScripts.length, 1);
  const testDelta = scriptAudit.changedScripts[0];
  assert.equal(testDelta.scriptName, "test");
  assert.equal(testDelta.baseValue, BASE_TEST_SCRIPT);
  assert.equal(testDelta.candidateValue, CANDIDATE_TEST_SCRIPT);
  assert.equal(testDelta.disposition, "changed_authorized_conformant");
  assert.equal(testDelta.purpose, "Expand the default repository regression suite to include S3 and S4 tests while retaining every baseline test.");
  assert.deepEqual(testDelta.removedRequiredValidation, []);
  assert.deepEqual(testDelta.preservedRequiredValidation, PRESERVED_REQUIRED_VALIDATION);
  assert.equal(testDelta.executedRequiredValidation.length, validationRuns.length);
  assert.equal(testDelta.executedRequiredValidation.every((item) => /exitCode:0$/.test(item)), true);
});
await runnerProof("REGRESSION-001", "candidate-head-tree", "The candidate head and tree remain bound to the execution.", "The candidate commit and tree matched before and after every validation command.", "candidate-identity", ["candidateCommitSha=" + candidateCommitSha, "candidateTree=" + candidateTree, "candidateCommitShaAfter=" + validationCandidateCommitShaAfter, "candidateTreeAfter=" + validationCandidateTreeAfter], () => {
  assertCandidateIdentity(candidateCommitSha, candidateTree);
  assert.equal(validationCandidateCommitShaAfter, candidateCommitSha);
  assert.equal(validationCandidateTreeAfter, candidateTree);
  assertCandidateWorktreeClean();
});

await runnerProof("EVIDENCE-001", "manifest-separate", "The manifest is a separate static source from runtime proof records.", "The runner loaded the fixed manifest module and read claim proof and execution receipts from separate temporary streams.", "manifest-separate", ["manifestSource=tests/s4-evidence-manifest.ts", "proofSource=" + proofPath, "executionSource=" + executionPath], () => {
  assert.notEqual(resolve(process.cwd(), "tests/s4-evidence-manifest.ts"), resolve(proofPath));
  assert.notEqual(resolve(proofPath), resolve(executionPath));
  assert.equal(manifest.claimCount, 291);
  assert.equal(existsSync(proofPath), true);
  assert.equal(existsSync(executionPath), true);
});
await runnerProof("EVIDENCE-001", "proof-runtime", "Every non-static claim has executed proof, and failed/skipped records cannot be promoted.", "The runner parsed claim records and execution receipts, verified a hash-bound successful assertion for every focused runtime claim, and separately derived failed/skipped comparator counters before adding runner claims.", "proof-runtime", ["focusedProofRecords=" + focusedProofState.records.length, "focusedExecutionReceipts=" + focusedProofState.receipts.length, "focusedClaims=" + focusedClaims.length, "runnerClaims=" + runnerClaims.length, "syntheticFailedClaims=" + failedComparison.failedClaims, "syntheticSkippedClaims=" + skippedComparison.skippedClaims, "syntheticFailedPassedRecords=" + failedComparison.passedRecords.length], () => {
  const state = loadFocusedProofState();
  assert.equal(state.records.length, focusedClaims.length);
  assert.equal(state.receipts.length, focusedClaims.length);
  assert.equal(state.records.filter((record) => record.evidenceClass !== "static").length, 263);
  assert.equal(failedComparison.failedClaims, 1);
  assert.equal(failedComparison.passedRecords.length, 0);
  assert.equal(skippedComparison.skippedClaims, 1);
});
await runnerProof("EVIDENCE-001", "missing-derived", "Missing claims are derived from manifest/proof set comparison.", "The comparator derived missingClaims=" + emptyComparison.missingClaims + " from the empty proof set against the 291-claim manifest.", "missing-counter", ["missingClaims=" + emptyComparison.missingClaims, "failedClaims=" + emptyComparison.failedClaims, "unknownClaims=" + emptyComparison.unknownClaims, "duplicateClaims=" + emptyComparison.duplicateClaims, "skippedClaims=" + emptyComparison.skippedClaims], () => {
  const result = compareClaimProofs(manifest, []);
  assert.equal(result.failedClaims, 0);
  assert.equal(result.missingClaims, manifest.claimCount);
  assert.equal(result.unknownClaims, 0);
  assert.equal(result.duplicateClaims, 0);
  assert.equal(result.skippedClaims, 0);
});
await runnerProof("EVIDENCE-001", "unknown-derived", "Unknown claims are derived from proof set comparison.", "The comparator derived unknownClaims=" + unknownComparison.unknownClaims + " from a synthetic unknown claim.", "unknown-counter", ["unknownClaims=" + unknownComparison.unknownClaims], () => {
  const result = compareClaimProofs(manifest, [{ ...comparatorProof("passed"), claimId: "UNKNOWN:claim" }]);
  assert.equal(result.unknownClaims, 1);
});
await runnerProof("EVIDENCE-001", "duplicate-derived", "Duplicate claims are derived from proof set comparison.", "The comparator derived duplicateClaims=" + duplicateComparison.duplicateClaims + " from a synthetic duplicate claim pair.", "duplicate-counter", ["duplicateClaims=" + duplicateComparison.duplicateClaims], () => {
  const result = compareClaimProofs(manifest, [comparatorProof("passed"), comparatorProof("passed")]);
  assert.equal(result.duplicateClaims, 1);
});
await runnerProof("EVIDENCE-001", "skipped-derived", "Skipped claims are derived from proof set comparison.", "The comparator derived skippedClaims=" + skippedComparison.skippedClaims + " from a synthetic skipped claim.", "skipped-counter", ["skippedClaims=" + skippedComparison.skippedClaims], () => {
  const result = compareClaimProofs(manifest, [comparatorProof("skipped")]);
  assert.equal(result.skippedClaims, 1);
});
await runnerProof("EVIDENCE-001", "head-movement-fail", "The evidence identity guard rejects a stale candidate head.", "The exact candidate identity guard rejected a stale head and accepted the unchanged candidate.", "stale-head-guard", ["staleRejected=true", "guard=exact-head-tree"], () => {
  assert.throws(() => assertCandidateIdentity("0".repeat(40), candidateTree));
  assertCandidateIdentity(candidateCommitSha, candidateTree);
});
await runnerProof("EVIDENCE-001", "static-only", "Static evidence is limited to the accepted static identity row.", "The derived manifest classified exactly five IDENTITY-001 claims as static and all other claims as runtime-bound.", "static-classification", ["staticClaimCount=" + manifest.claims.filter((claim) => claim.evidenceClass === "static").length, "nonStaticClaimCount=" + manifest.claims.filter((claim) => claim.evidenceClass !== "static").length], () => {
  const staticClaims = manifest.claims.filter((claim) => claim.evidenceClass === "static");
  assert.deepEqual(staticClaims.map((claim) => claim.testId), Array.from({ length: staticClaims.length }, () => "IDENTITY-001"));
  assert.equal(staticClaims.length, 5);
  assert.equal(manifest.claims.filter((claim) => claim.evidenceClass !== "static").length, 286);
});
await runnerProof("EVIDENCE-001", "exact-schema", "The execution artifact uses the exact frozen schema keys.", "The runner checked the exact artifact and nested proof-comparison key sets before writing the final artifact.", "artifact-schema", ["schema=s4-evidence-v1-execution-bound", "exactKeys=true"], () => {
  const probe = {
    schemaVersion: "s4-evidence-v1-execution-bound",
    executionId: "00000000-0000-4000-8000-000000000000",
    contractPath: "docs/G2_S4_CONTRACT.md",
    canonicalBaseSha: CANONICAL_BASE_SHA,
    canonicalBaseTree: CANONICAL_BASE_TREE,
    candidateCommitSha,
    candidateTree,
    candidateCommitShaAfter: candidateCommitSha,
    candidateTreeAfter: candidateTree,
    manifestHash: manifest.manifestHash,
    rowCount: manifest.rowCount,
    claimCount: manifest.claimCount,
    dependencyAudit,
    scriptAudit,
    proofComparison: { passedRecords: [], failedClaims: 0, missingClaims: 0, unknownClaims: 0, duplicateClaims: 0, skippedClaims: 0 },
    status: "passed",
    startedAt,
    completedAt: startedAt,
  };
  assertExactKeys(probe, ["schemaVersion", "executionId", "contractPath", "canonicalBaseSha", "canonicalBaseTree", "candidateCommitSha", "candidateTree", "candidateCommitShaAfter", "candidateTreeAfter", "manifestHash", "rowCount", "claimCount", "dependencyAudit", "scriptAudit", "proofComparison", "status", "startedAt", "completedAt"], "S4 evidence artifact");
  assertExactKeys(probe.proofComparison, ["passedRecords", "failedClaims", "missingClaims", "unknownClaims", "duplicateClaims", "skippedClaims"], "S4 proof comparison");
});
await runnerProof("GATE-001", "executor-no-self-finalize", "The executor remains a candidate producer and does not self-finalize G3.", "The evidence process stayed on web/s4-g3, wrote only candidate evidence, and performed no acceptance or later-stage operation.", "controller-gate", ["candidateOnly=true", "g3Accepted=false", "g4Authorized=false"], () => {
  assert.equal(git("branch", "--show-current"), "web/s4-g3");
  assert.equal(candidateCommitSha === CANONICAL_BASE_SHA, false);
  assertCandidateWorktreeClean();
});
await runnerProof("GATE-001", "candidate-not-merged", "The candidate remains unmerged into canonical main during execution while retaining the required canonical-main integration.", "The candidate contains canonical main as an ancestry-preserving integration and is not an ancestor of origin/main; this runner invoked only local validation commands.", "controller-gate", ["canonicalMainIntegrated=true", "candidateMergedToOriginMain=false", "mergeInvoked=false", "candidateOnly=true"], () => {
  assert.equal(gitSucceeds("merge-base", "--is-ancestor", CANONICAL_MAIN_SHA, candidateCommitSha), true);
  assert.equal(gitSucceeds("merge-base", "--is-ancestor", candidateCommitSha, "origin/main"), false);
  assertCandidateIdentity(candidateCommitSha, candidateTree);
});
const noLiveProviderFetchCalls = { count: 0 };
const noLiveProvider = new OpenAIS4Provider({
  apiKey: "",
  fetchImpl: async () => {
    noLiveProviderFetchCalls.count += 1;
    return new Response("{}", { status: 200 });
  },
});
await runnerProof("GATE-001", "no-live-provider", "The G3 candidate uses local provider fixtures only.", "The local OpenAI adapter rejected its blank configuration at the preflight boundary for both image and assessment, its injected transport was never called, and the S4 evidence child processes received named blank provider credential variables.", "controller-gate", ["providerMode=local-preflight", "liveProviderCalls=0", "blankedProviderVariables=OPENAI_API_KEY,OPENAI_ORG_ID,OPENAI_PROJECT_ID"], () => {
  assert.throws(() => noLiveProvider.assertS4ImageEditReady(), (error: unknown) => (error as { safeCode?: string }).safeCode === "PROVIDER_NOT_CONFIGURED");
  assert.throws(() => noLiveProvider.assertS4AssessmentReady(), (error: unknown) => (error as { safeCode?: string }).safeCode === "PROVIDER_NOT_CONFIGURED");
  assert.equal(noLiveProviderFetchCalls.count, 0);
  assert.deepEqual(Object.keys(noProviderCredentialEnvironment).sort(), Array.from(PROVIDER_CREDENTIAL_NAMES).sort());
  assert.equal(validationRuns.length, 10);
  assert.equal(validationRuns.every((run) => run.providerCredentialEnvironmentBlanked === true), true);
  assert.equal(validationRuns.every((run) => run.blankedProviderCredentialNames.length === PROVIDER_CREDENTIAL_NAMES.length), true);
  assert.equal(validationRuns.every((run) => PROVIDER_CREDENTIAL_NAMES.every((name) => run.blankedProviderCredentialNames.includes(name))), true);
  assert.equal(validationRuns.every((run) => ["node", "pnpm.cmd", "git"].includes(run.command)), true);
});
await runnerProof("GATE-001", "no-customer-private-data", "The evidence run uses no customer or private business data.", "The candidate evidence sources and local commands contain no customer-data fixture path, credential file, or external data operation.", "controller-gate", ["customerData=0", "privateBusinessData=0"], () => {
  assert.equal(changedFiles.some((path) => /(^|[\\/])(?:\.env|customer-data|private-data)(?:$|[\\/])/i.test(path)), false);
  assert.equal(validationRuns.every((run) => run.command !== "curl" && run.command !== "Invoke-WebRequest"), true);
});
await runnerProof("GATE-001", "parent-child-reconciled", "Parent and child gate state remains controller-owned and explicitly reported.", "The frozen contract preserves Web/controller ownership, the G3 lock boundary, and the later-stage hold for review.", "controller-gate", ["controllerReviewRequired=true", "parentReconciliation=reported"], () => {
  assert.match(contractText, /Web controls acceptance/i);
  assert.match(contractText, /GATE_REENTRY_REQUIRED/);
  assert.match(contractText, /S5 remains a later programme stage/i);
});
await runnerProof("GATE-001", "gate-reentry", "No gate re-entry is silently performed by the executor.", "The runner leaves any contract or authority change decision to the controller and records no G4 or merge action.", "controller-gate", ["gateReentryDecision=controller-owned", "executorDecision=false"], () => {
  assert.match(contractText, /MUST stop with GATE_REENTRY_REQUIRED/i);
  assert.equal(git("branch", "--show-current"), "web/s4-g3");
});

const finalProofRecords = readProofRecords(proofPath);
const finalExecutionReceipts = readExecutionReceipts(executionPath);
const comparison = compareClaimProofs(manifest, finalProofRecords);
const executedClaimIds = new Set(finalProofRecords.filter((record) => record.status === "passed").map((record) => record.claimId));
const unexecutedClaimIds = manifest.claims.filter((claim) => !executedClaimIds.has(claim.claimId)).map((claim) => claim.claimId);
const computedSkippedClaims = comparison.skippedClaims + unexecutedClaimIds.length;
if (comparison.missingClaims !== 0 || comparison.failedClaims !== 0 || comparison.unknownClaims !== 0 || comparison.duplicateClaims !== 0 || computedSkippedClaims !== 0) {
  throw new Error("S4 evidence completeness failed: missing=" + comparison.missingClaims + " failed=" + comparison.failedClaims + " unknown=" + comparison.unknownClaims + " duplicate=" + comparison.duplicateClaims + " skipped=" + computedSkippedClaims + " unexecuted=" + unexecutedClaimIds.length);
}
if (comparison.passedRecords.length !== manifest.claimCount || finalProofRecords.length !== manifest.claimCount || finalExecutionReceipts.length !== manifest.claimCount) {
  throw new Error("not every expected claim has one passing proof record and execution receipt");
}
assertExecutionBinding(finalProofRecords, finalExecutionReceipts);
for (const proof of comparison.passedRecords) {
  const expected = manifest.claims.find((claim) => claim.claimId === proof.claimId);
  if (!expected || proof.testId !== expected.testId || proof.variantId !== expected.variantId || proof.normativeRowText !== expected.normativeRowText || proof.evidenceClass !== expected.evidenceClass || proof.fixtureSetup !== expected.fixtureSetup) {
    throw new Error("proof does not match the fixed claim definition: " + proof.claimId);
  }
  checkedString(proof.expectedResult, "expectedResult");
  checkedString(proof.actualResult, "actualResult");
  if (proof.evidenceClass !== "static" && /(?:entire|overall|generic) suite passed/i.test(proof.actualResult)) throw new Error("non-static proof is generic " + proof.claimId);
}
const nonStaticClaimCount = manifest.claims.filter((claim) => claim.evidenceClass !== "static").length;
const actualExecutedScenarioCount = new Set(finalExecutionReceipts
  .filter((receipt) => manifest.claims.find((claim) => claim.claimId === receipt.claimId)?.evidenceClass !== "static")
  .map((receipt) => receipt.scenario)).size;
if (actualExecutedScenarioCount !== nonStaticClaimCount) throw new Error("non-static executed scenario count mismatch");

const candidateCommitShaAfter = git("rev-parse", "HEAD");
const candidateTreeAfter = git("rev-parse", "HEAD^{tree}");
assertCandidateIdentity(candidateCommitSha, candidateTree);
assert.equal(candidateCommitShaAfter, candidateCommitSha);
assert.equal(candidateTreeAfter, candidateTree);
assertCandidateWorktreeClean();

const executionId = randomUUID();
const safeReference = "s4-g3-" + executionId;
if (!UUID.test(executionId) || !/^s4-g3-[0-9a-f-]{36}$/i.test(safeReference)) throw new Error("invalid evidence execution identity");
const completedAt = new Date().toISOString();
const proofComparison: S4ClaimProofComparison = {
  passedRecords: comparison.passedRecords,
  failedClaims: comparison.failedClaims,
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
  dependencyAudit,
  scriptAudit,
  proofComparison,
  status: "passed" as const,
  startedAt,
  completedAt,
};
assertExactKeys(artifact, ["schemaVersion", "executionId", "contractPath", "canonicalBaseSha", "canonicalBaseTree", "candidateCommitSha", "candidateTree", "candidateCommitShaAfter", "candidateTreeAfter", "manifestHash", "rowCount", "claimCount", "dependencyAudit", "scriptAudit", "proofComparison", "status", "startedAt", "completedAt"], "S4 evidence artifact");
assertExactKeys(artifact.proofComparison, ["passedRecords", "failedClaims", "missingClaims", "unknownClaims", "duplicateClaims", "skippedClaims"], "S4 proof comparison");
if (artifact.status !== "passed" || artifact.canonicalBaseSha !== CANONICAL_BASE_SHA || artifact.canonicalBaseTree !== CANONICAL_BASE_TREE || artifact.candidateCommitSha !== artifact.candidateCommitShaAfter || artifact.candidateTree !== artifact.candidateTreeAfter || artifact.dependencyAudit.auditState !== "complete" || artifact.dependencyAudit.disposition === "unchanged" || artifact.dependencyAudit.disposition !== "changed_authorized_conformant" || artifact.scriptAudit.auditState !== "complete" || artifact.scriptAudit.disposition !== "changed_authorized_conformant" || artifact.proofComparison.failedClaims !== 0 || artifact.proofComparison.missingClaims !== 0 || artifact.proofComparison.unknownClaims !== 0 || artifact.proofComparison.duplicateClaims !== 0 || artifact.proofComparison.skippedClaims !== 0) throw new Error("S4 evidence artifact did not satisfy the passing invariants");

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
  executionSource: executionPath,
  rowCount: artifact.rowCount,
  claimCount: artifact.claimCount,
  missingClaims: artifact.proofComparison.missingClaims,
  failedClaims: artifact.proofComparison.failedClaims,
  unknownClaims: artifact.proofComparison.unknownClaims,
  duplicateClaims: artifact.proofComparison.duplicateClaims,
  skippedClaims: artifact.proofComparison.skippedClaims,
  dependencyAuditState: artifact.dependencyAudit.auditState,
  dependencyDisposition: artifact.dependencyAudit.disposition,
  productionGraphUnchanged: artifact.dependencyAudit.productionGraphUnchanged,
  testOnlyRuntimeReachabilityAbsent: artifact.dependencyAudit.testOnlyRuntimeReachabilityAbsent,
  scriptAuditState: artifact.scriptAudit.auditState,
  scriptDisposition: artifact.scriptAudit.disposition,
  completeMapEqual: artifact.scriptAudit.completeMapEqual,
  changedScripts: artifact.scriptAudit.changedScripts.map((delta) => ({ scriptName: delta.scriptName, baseValue: delta.baseValue, candidateValue: delta.candidateValue, disposition: delta.disposition })),
  staticClaimCount: manifest.claims.filter((claim) => claim.evidenceClass === "static").length,
  nonStaticClaimCount,
  actualExecutedScenarioCount,
  receiptCount: finalExecutionReceipts.length,
  validationFacts: validationRuns.map((run) => run.label + "=pass"),
}));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
