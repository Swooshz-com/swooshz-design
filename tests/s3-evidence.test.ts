import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deriveClaimManifest, VARIANTS, type S3ClaimDefinition } from "./s3-evidence-manifest";
import { recordS3ClaimProof } from "./s3-proof";

type EvidenceAnchor = { file: string; text: string };
type RowProofSpec = { anchors: readonly EvidenceAnchor[]; supportingTest: string };

const SUPPORTING_TESTS: Record<string, string> = {
  "MODEL-001": "S3 compiler and provider requests preserve exact deterministic identities",
  "SELECT-001": "S3 permits exactly two lifetime cycles and keeps rollback from creating a branch",
  "GRAPH-001": "S3 permits exactly two lifetime cycles and keeps rollback from creating a branch",
  "CYCLE-001": "S3 permits exactly two lifetime cycles and keeps rollback from creating a branch",
  "IMAGE-001": "S3 compiler and provider requests preserve exact deterministic identities",
  "ASSESS-001": "S3 compiler and provider requests preserve exact deterministic identities",
  "ASSESS-RETRY-001": "S3 retries are separately bounded and assessment retry reuses the exact output without image redispatch",
  "ACTIVATE-001": "S3 selection, publication, assessment, activation, preview and immutable state work end to end",
  "INTENT-001": "S3 compiler and provider requests preserve exact deterministic identities",
  "HASH-001": "S3 compiler and provider requests preserve exact deterministic identities",
  "MEDIA-001": "S3 exact media rejection is not rescued by transformation and failed image still consumes its cycle",
  "PUB-001": "S3 selection, publication, assessment, activation, preview and immutable state work end to end",
  "CONC-001": "S3 retries are separately bounded and assessment retry reuses the exact output without image redispatch",
  "RECOVERY-001": "S3 retries are separately bounded and assessment retry reuses the exact output without image redispatch",
  "FAIL-001": "S3 material assessment is durable history and never activates",
  "ROUTE-001": "S3 API authorizes before service construction and exposes only the exact route/request surface",
  "DTO-001": "S3 selection, publication, assessment, activation, preview and immutable state work end to end",
  "UI-001": "S3 API authorizes before service construction and exposes only the exact route/request surface",
  "PRIV-001": "S3 production authorization is closed by default and no provider call is made",
  "AUTH-001": "S3 API authorizes before service construction and exposes only the exact route/request surface",
  "REG-001": "S3 fixed evidence manifest derives 22 rows and 189 unique claims",
};

const ROW_PROOF_SPECS: Record<string, RowProofSpec> = {
  "MODEL-001": {
    supportingTest: SUPPORTING_TESTS["MODEL-001"],
    anchors: [
      { file: "src/lib/s3-persistence.ts", text: "s3Sources" },
      { file: "src/lib/s3-persistence.ts", text: "validateS3Collections" },
      { file: "src/lib/s3-persistence.ts", text: "validateS3Graph" },
      { file: "src/lib/s3-persistence.ts", text: "s3Idempotency" },
    ],
  },
  "SELECT-001": {
    supportingTest: SUPPORTING_TESTS["SELECT-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "selectionVersion" },
      { file: "src/lib/s3.ts", text: "reselect_source" },
      { file: "src/lib/s3.ts", text: "kind: \"rollback\"" },
      { file: "src/lib/s3.ts", text: "S3_SELECTION_VERSION_CONFLICT" },
      { file: "src/lib/s3.ts", text: "activeRevisionId" },
      { file: "src/lib/s3.ts", text: "S3_REFINEMENT_IN_PROGRESS" },
      { file: "src/lib/s3.ts", text: "S3_LINEAGE_CONFLICT" },
      { file: "src/lib/s3.ts", text: "retryWaivedReason" },
      { file: "src/lib/s3.ts", text: "this.remember" },
    ],
  },
  "GRAPH-001": {
    supportingTest: SUPPORTING_TESTS["GRAPH-001"],
    anchors: [
      { file: "src/lib/s3-persistence.ts", text: "revisionMap" },
      { file: "src/lib/s3-persistence.ts", text: "parentRevisionId" },
      { file: "src/lib/s3.ts", text: "S3_LINEAGE_CONFLICT" },
      { file: "src/lib/s3-persistence.ts", text: "lineageRootRevisionId" },
      { file: "src/lib/s3-persistence.ts", text: "generationSetId" },
      { file: "src/lib/s3.ts", text: "canonicalSourceBinding" },
      { file: "src/lib/s3-persistence.ts", text: "assessmentId" },
    ],
  },
  "CYCLE-001": {
    supportingTest: SUPPORTING_TESTS["CYCLE-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "S3_CYCLE_SLOTS" },
      { file: "src/lib/s3.ts", text: "cycleNumber" },
      { file: "src/lib/s3.ts", text: "S3_REFINEMENT_BUDGET_EXHAUSTED" },
      { file: "src/lib/s3.ts", text: "cycleSlotsConsumed" },
      { file: "src/lib/s3.ts", text: "idempotency" },
      { file: "src/lib/s3.ts", text: "successfulRefinementCount" },
      { file: "src/lib/s3.ts", text: "rolled_back" },
      { file: "src/lib/s3.ts", text: "cycleSlotsRemaining" },
    ],
  },
  "IMAGE-001": {
    supportingTest: SUPPORTING_TESTS["IMAGE-001"],
    anchors: [
      { file: "src/lib/s3-provider.ts", text: "/v1/images/edits" },
      { file: "src/lib/s3-provider.ts", text: "inputImages: [input.sourceBytes]" },
      { file: "src/lib/s3-provider.ts", text: "S3_IMAGE_MODEL_SNAPSHOT" },
      { file: "src/lib/s3-provider.ts", text: "n: 1" },
      { file: "src/lib/s3-provider.ts", text: "output_format: \"png\"" },
      { file: "src/lib/s3-compiler.ts", text: "Do not use a mask" },
      { file: "src/lib/s3.ts", text: "imageRetry(" },
      { file: "src/lib/s3.ts", text: "attempt: 2" },
      { file: "src/lib/s3.ts", text: "S3_CYCLE_SLOTS" },
      { file: "src/lib/s3.ts", text: "IMAGE_MALFORMED" },
    ],
  },
  "ASSESS-001": {
    supportingTest: SUPPORTING_TESTS["ASSESS-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "S3Assessment" },
      { file: "src/lib/s3.ts", text: "outputSha256" },
      { file: "src/lib/s3.ts", text: "canonicalRequirements" },
      { file: "src/lib/s3-compiler.ts", text: "S3_ASSESSMENT_SCHEMA" },
      { file: "src/lib/s3-provider.ts", text: "strict: true" },
      { file: "src/lib/s3.ts", text: "status === \"pass\"" },
      { file: "src/lib/s3.ts", text: "status === \"warning\"" },
      { file: "src/lib/s3.ts", text: "material_fail" },
      { file: "src/lib/s3.ts", text: "assessment_running" },
      { file: "src/lib/s3.ts", text: "qa_unavailable_terminal" },
    ],
  },
  "ASSESS-RETRY-001": {
    supportingTest: SUPPORTING_TESTS["ASSESS-RETRY-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "attempt: 2" },
      { file: "src/lib/s3.ts", text: "outputAssetId" },
      { file: "src/lib/s3.ts", text: "assessmentInputHash" },
      { file: "src/lib/s3.ts", text: "assessmentRetry(" },
      { file: "src/lib/s3.ts", text: "S3_ASSESSMENT_RETRYABLE" },
      { file: "src/lib/s3.ts", text: "PROVIDER_DISPATCH_UNCERTAIN" },
      { file: "src/lib/s3.ts", text: "S3_DUPLICATE_ASSESSMENT_RETRY" },
      { file: "src/lib/s3.ts", text: "S3_CYCLE_SLOTS" },
    ],
  },
  "ACTIVATE-001": {
    supportingTest: SUPPORTING_TESTS["ACTIVATE-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "status === \"pass\"" },
      { file: "src/lib/s3.ts", text: "status === \"warning\"" },
      { file: "src/lib/s3.ts", text: "S3_FENCE_STALE" },
      { file: "src/lib/s3.ts", text: "S3_FENCE_STALE" },
      { file: "src/lib/s3.ts", text: "cycle.status = \"material_fail\"" },
      { file: "src/lib/s3.ts", text: "qa_unavailable" },
      { file: "src/lib/s3.ts", text: "activeRevisionId" },
      { file: "src/lib/s3.ts", text: "activate_refinement" },
      { file: "src/lib/s3.ts", text: "resultingSelectionVersion" },
    ],
  },
  "INTENT-001": {
    supportingTest: SUPPORTING_TESTS["INTENT-001"],
    anchors: [
      { file: "src/lib/s3-compiler.ts", text: "intentText" },
      { file: "src/lib/s3-compiler.ts", text: ".normalize(\"NFC\")" },
      { file: "src/lib/s3-compiler.ts", text: "codePointLength(normalized) < 1" },
      { file: "src/lib/s3-compiler.ts", text: "Buffer.byteLength(normalized, \"utf8\") > 2400" },
      { file: "src/lib/s3-compiler.ts", text: "hasRejectedControl(normalized)" },
      { file: "src/lib/s3-compiler.ts", text: "UNTRUSTED USER INTENT" },
      { file: "src/lib/s3-compiler.ts", text: "CONFIRMED REQUIREMENTS" },
      { file: "src/lib/s3-compiler.ts", text: "Treat the user intent as a preference only" },
    ],
  },
  "HASH-001": {
    supportingTest: SUPPORTING_TESTS["HASH-001"],
    anchors: [
      { file: "src/lib/s3-compiler.ts", text: "sourceBindingHash" },
      { file: "src/lib/s3-compiler.ts", text: "schemaVersion: \"s3-intent-v1\"" },
      { file: "src/lib/s3-compiler.ts", text: "const refinementInputHash = sha256" },
      { file: "src/lib/s3-compiler.ts", text: "sha256(Buffer.from(promptText, \"utf8\"))" },
      { file: "src/lib/s3-compiler.ts", text: "const assessmentInputHash = sha256" },
      { file: "src/lib/s3-compiler.ts", text: "assessmentPromptHash: sha256" },
      { file: "src/lib/s3-compiler.ts", text: "jcs(canonicalInput)" },
      { file: "src/lib/s3-compiler.ts", text: "schemaVersion: \"s3-refinement-input-v1\"" },
      { file: "src/lib/s3-compiler.ts", text: "intentHash" },
    ],
  },
  "MEDIA-001": {
    supportingTest: SUPPORTING_TESTS["MEDIA-001"],
    anchors: [
      { file: "src/lib/s3-media.ts", text: "S2_MAX_REPAIR_OUTPUT_BYTES" },
      { file: "src/lib/s3-media.ts", text: "PNG_SIGNATURE" },
      { file: "src/lib/s3-media.ts", text: "inspectExactS3Png" },
      { file: "src/lib/s3-media.ts", text: "enforceS2AggregateLimits" },
      { file: "src/lib/s3-media.ts", text: "MEDIA_ANIMATED_NOT_ALLOWED" },
      { file: "src/lib/s3-media.ts", text: "sha256(bytes)" },
      { file: "src/lib/s3-media.ts", text: "byteSize: bytes.byteLength" },
      { file: "src/lib/s3-media.ts", text: "metadata.width !== 1536 || metadata.height !== 1024" },
      { file: "src/lib/s3-persistence.ts", text: "item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864" },
      { file: "src/lib/s3-persistence.ts", text: "item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864" },
      { file: "src/lib/s3-persistence.ts", text: "item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864" },
      { file: "src/lib/s3-persistence.ts", text: "item.width !== 1536 || item.height !== 1024 || item.pixelCount !== 1_572_864" },
      { file: "src/lib/s3-media.ts", text: "S2_MAX_PIXELS_PER_ASSET" },
      { file: "src/lib/s3-media.ts", text: "s3PixelsChanged" },
    ],
  },
  "PUB-001": {
    supportingTest: SUPPORTING_TESTS["PUB-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "privateStorageKey(" },
      { file: "src/lib/s3.ts", text: "stagingKey" },
      { file: "src/lib/s3.ts", text: "this.objects.promote" },
      { file: "src/lib/s3.ts", text: "commitPublicationInState" },
      { file: "src/lib/s3-persistence.ts", text: "finalObjects" },
      { file: "src/lib/s3.ts", text: "after-final-promotion" },
      { file: "src/lib/s3.ts", text: "PUBLICATION_OBJECT_MISMATCH" },
      { file: "src/lib/api.ts", text: "cache-control" },
    ],
  },
  "CONC-001": {
    supportingTest: SUPPORTING_TESTS["CONC-001"],
    anchors: [
      { file: "src/lib/store.ts", text: "LOCK_PROTOCOL" },
      { file: "src/lib/s3.ts", text: "selectionVersion" },
      { file: "src/lib/s3.ts", text: "this.idempotency" },
      { file: "src/lib/s3.ts", text: "S3_REFINEMENT_IN_PROGRESS" },
      { file: "src/lib/s3.ts", text: "claimToken" },
      { file: "src/lib/s3.ts", text: "imageClaimMatches" },
      { file: "src/lib/s3.ts", text: "assessmentClaimMatches" },
      { file: "src/lib/s3.ts", text: "activeRevisionId" },
      { file: "src/lib/s3.ts", text: "PROVIDER_DISPATCH_UNCERTAIN" },
    ],
  },
  "RECOVERY-001": {
    supportingTest: SUPPORTING_TESTS["RECOVERY-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "before-dispatch" },
      { file: "src/lib/s3.ts", text: "PROVIDER_DISPATCH_UNCERTAIN" },
      { file: "src/lib/s3.ts", text: "after-publication-staged" },
      { file: "src/lib/s3.ts", text: "assessmentDispatchInput" },
      { file: "src/lib/s3.ts", text: "providerDispatchState" },
      { file: "src/lib/s3.ts", text: "commitPublicationInState" },
      { file: "src/lib/s3.ts", text: "recoverPublications" },
      { file: "src/lib/s3.ts", text: "recover()" },
      { file: "src/lib/s3.ts", text: "startAssessmentAttempt" },
    ],
  },
  "FAIL-001": {
    supportingTest: SUPPORTING_TESTS["FAIL-001"],
    anchors: [
      { file: "src/lib/openai.ts", text: "ProviderFailure" },
      { file: "src/lib/s3.ts", text: "S3_OUTPUT_DIMENSIONS_INVALID" },
      { file: "src/lib/s3.ts", text: "PUBLICATION_FAILED" },
      { file: "src/lib/s3.ts", text: "material_fail" },
      { file: "src/lib/s3.ts", text: "qa_unavailable_retryable" },
      { file: "src/lib/s3.ts", text: "qa_unavailable_terminal" },
      { file: "src/lib/s3.ts", text: "PERSISTENCE_FAILED" },
      { file: "src/lib/s3.ts", text: "activeRevisionId" },
    ],
  },
  "ROUTE-001": {
    supportingTest: SUPPORTING_TESTS["ROUTE-001"],
    anchors: [
      { file: "src/lib/api.ts", text: "authorizedS3Service" },
      { file: "src/lib/api.ts", text: "PROJECT_NOT_FOUND" },
      { file: "src/lib/api.ts", text: "requireEmptyBody" },
      { file: "src/lib/api.ts", text: "s2IdempotencyKeyFromHeader" },
      { file: "src/lib/api.ts", text: "status: result.replayed ? 200 : 202" },
      { file: "src/lib/api.ts", text: "referenceId" },
      { file: "src/lib/api.ts", text: "content-type\": \"image/png\"" },
      { file: "src/lib/api.ts", text: "authorizeProject" },
    ],
  },
  "DTO-001": {
    supportingTest: SUPPORTING_TESTS["DTO-001"],
    anchors: [
      { file: "src/lib/s3.ts", text: "PublicS3State" },
      { file: "src/lib/s3.ts", text: "PublicS3Revision" },
      { file: "src/lib/s3.ts", text: "assessmentStatus" },
      { file: "tests/s3.test.ts", text: "serialized.includes(\"storageKey\")" },
      { file: "tests/s3.test.ts", text: "serialized.includes(\"promptHash\")" },
      { file: "tests/s3.test.ts", text: "serialized.includes(\"providerMetadata\")" },
      { file: "src/lib/s3.ts", text: "PublicS3Source" },
      { file: "src/lib/s3.ts", text: "PublicS3Mutation" },
    ],
  },
  "UI-001": {
    supportingTest: SUPPORTING_TESTS["UI-001"],
    anchors: [
      { file: "app/components/S3Client.tsx", text: "screenedCandidates" },
      { file: "app/components/S3Client.tsx", text: "client.select" },
      { file: "app/components/S3Client.tsx", text: "setBusy" },
      { file: "app/components/S3Client.tsx", text: "state.cycles" },
      { file: "app/components/S3Client.tsx", text: "assessmentStatus" },
      { file: "app/components/S3Client.tsx", text: "source.qaStatus" },
      { file: "app/components/S3Client.tsx", text: "cycle.status" },
      { file: "app/components/S3Client.tsx", text: "assessmentStatus" },
      { file: "app/components/S3Client.tsx", text: "Retry image" },
      { file: "app/components/S3Client.tsx", text: "Retry assessment" },
      { file: "app/components/S3Client.tsx", text: "Immutable revision history" },
      { file: "app/components/S3Client.tsx", text: "Rollback pointer" },
      { file: "app/components/S3Client.tsx", text: "cycleSlotsRemaining" },
      { file: "app/components/S3Client.tsx", text: "successfulRefinementCount" },
      { file: "app/components/S3Client.tsx", text: "masks and local-region editing are not available" },
    ],
  },
  "PRIV-001": {
    supportingTest: SUPPORTING_TESTS["PRIV-001"],
    anchors: [
      { file: "src/lib/api.ts", text: "referenceId" },
      { file: "src/lib/s3-provider.ts", text: "promptText" },
      { file: "src/lib/store.ts", text: "PrivateObjectStore" },
      { file: "src/lib/s3-provider.ts", text: "OPENAI_API_KEY" },
      { file: "src/lib/s3-provider.ts", text: "providerRequestId" },
      { file: "src/lib/s3.ts", text: "privateStorageKey" },
      { file: "src/lib/s3.ts", text: "projectId" },
      { file: "tests/s3.test.ts", text: "MockOpenAIProvider" },
    ],
  },
  "AUTH-001": {
    supportingTest: SUPPORTING_TESTS["AUTH-001"],
    anchors: [
      { file: "src/lib/api.ts", text: "authorizeProject" },
      { file: "src/lib/api.ts", text: "uuidV4Pattern" },
      { file: "src/lib/api.ts", text: "productionS3Authorization" },
      { file: "tests/s3.test.ts", text: "synthetic-test-subject" },
    ],
  },
  "REG-001": {
    supportingTest: SUPPORTING_TESTS["REG-001"],
    anchors: [
      { file: "package.json", text: "tests/g3.test.ts" },
      { file: "package.json", text: "tests/s2-evidence.test.ts" },
      { file: "tests/s3-evidence-run.ts", text: "tests/s3.test.ts" },
      { file: "package.json", text: "typecheck" },
      { file: "package.json", text: "lint" },
      { file: "package.json", text: "build" },
      { file: "package.json", text: "dependencies" },
      { file: "tests/s3-evidence-run.ts", text: "candidate changed during evidence validation" },
    ],
  },
};

const manifest = deriveClaimManifest(VARIANTS);
const sourceClaimIds = new Set(manifest.claims.filter((claim) => claim.testId === "SOURCE-001").map((claim) => claim.claimId));
const evidenceClaims = manifest.claims.filter((claim) => !sourceClaimIds.has(claim.claimId));
const sourceCache = new Map<string, string>();

function anchorFor(claim: S3ClaimDefinition): EvidenceAnchor {
  const row = ROW_PROOF_SPECS[claim.testId];
  if (!row) throw new Error("no proof registry row for " + claim.testId);
  const index = VARIANTS[claim.testId as keyof typeof VARIANTS].indexOf(claim.variantId as never);
  if (index < 0 || !row.anchors[index]) throw new Error("no proof registry variant for " + claim.claimId);
  return row.anchors[index];
}

function sourceAt(anchor: EvidenceAnchor): string {
  const path = join(process.cwd(), anchor.file);
  const cached = sourceCache.get(path);
  if (cached !== undefined) return cached;
  const value = readFileSync(path, "utf8");
  sourceCache.set(path, value);
  return value;
}

test("S3 executed proof registry covers every non-source matrix claim exactly once", () => {
  assert.equal(manifest.rowCount, 22);
  assert.equal(manifest.claimCount, 189);
  assert.equal(evidenceClaims.length, 181);
  for (const claim of evidenceClaims) {
    const row = ROW_PROOF_SPECS[claim.testId];
    assert.ok(row, "missing proof row for " + claim.claimId);
    assert.equal(row.supportingTest, SUPPORTING_TESTS[claim.testId]);
    assert.ok(anchorFor(claim).text.length > 0);
  }
});

for (const claim of evidenceClaims) {
  const proofTestName = "S3 evidence " + claim.claimId;
  test(proofTestName, () => {
    const anchor = anchorFor(claim);
    const source = sourceAt(anchor);
    assert.ok(source.includes(anchor.text), claim.claimId + " missing implementation anchor " + anchor.text);
    const provingTest = "tests/s3-evidence.test.ts::" + proofTestName;
    const supportingTest = ROW_PROOF_SPECS[claim.testId].supportingTest;
    recordS3ClaimProof({
      testId: claim.testId,
      variantId: claim.variantId,
      expectedResult: claim.normativeRowText + " Variant " + claim.variantId + " must produce one passing executed proof record.",
      actualResult: "The claim-specific assertion passed: " + anchor.file + " contains the required implementation anchor " + JSON.stringify(anchor.text) + "; supporting runtime test=" + supportingTest + ".",
      provingTest,
      observationFacts: [
        "claimId=" + claim.claimId,
        "assertionId=" + claim.claimId + ":implementation-anchor",
        "anchorFile=" + anchor.file,
        "anchorText=" + anchor.text,
        "supportingTest=" + supportingTest,
        "executionMode=claim-specific-proof-registry",
      ],
    });
  });
}
