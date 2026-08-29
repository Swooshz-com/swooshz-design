export const VARIANTS = {
  "MODEL-001": ["defaults", "backward-load", "s3-validation", "unknown-s3-reject"],
  "SOURCE-001": ["s1-pass", "s1-warning", "s2-repaired-pass", "s2-repaired-warning", "original-retained", "failed-reject", "object-integrity", "generation-binding"],
  "SELECT-001": ["root-create", "source-reselect", "rollback", "version-cas", "active-pointer", "busy-block", "dead-end-reject", "retry-waived", "idempotent"],
  "GRAPH-001": ["immutable", "parent-exact", "stale-sibling", "no-branch", "cross-generation", "source-provenance", "assessment-provenance"],
  "CYCLE-001": ["slot-one", "slot-two", "third-reject", "failed-consumes", "replay-no-consume", "second-from-tip", "rollback-not-parent", "exhausted"],
  "IMAGE-001": ["edit-endpoint", "source-only", "model", "n-one", "size-quality-png", "no-mask", "no-hidden-retry", "attempt-two", "absolute-four", "malformed"],
  "ASSESS-001": ["own-record", "exact-bytes", "frozen-s2", "new-schema", "strict", "pass", "warning", "material", "pending-running", "provider-unavailable"],
  "ASSESS-RETRY-001": ["attempt-two", "same-asset", "same-hash", "no-image", "retryable-only", "ambiguous", "exhausted", "absolute-four"],
  "ACTIVATE-001": ["pass-current", "warning-current", "stale-pass", "stale-warning", "material-no", "unavailable-no", "prior-tip", "same-transaction", "sequence"],
  "INTENT-001": ["exact-body", "nfc", "codepoint-bound", "utf8-bound", "control-reject", "untrusted", "hard-facts-server", "no-semantic-claim"],
  "HASH-001": ["source-binding", "intent", "refinement-input", "prompt", "assessment-input", "assessment-prompt", "independent", "excluded-nondeterminism", "user-text-sensitive"],
  "MEDIA-001": ["reuse-profile", "png", "no-transform", "limits", "animated-reject", "hash", "output-bytes", "exact-1536x1024", "reject-1535x1024", "reject-1536x1023", "reject-1537x1024", "reject-1536x1025", "broad-limits-insufficient", "no-transformation-rescue"],
  "PUB-001": ["private-key", "staging", "promote", "commit", "no-overwrite", "crash-promoted", "mismatch-abort", "preview-no-store"],
  "CONC-001": ["repo-lock", "selection-tabs", "same-idem", "different-key-busy", "claim-unique", "image-stale", "assessment-stale", "pointer-race", "dead-vs-unknown"],
  "RECOVERY-001": ["pre-dispatch", "ambiguous-image", "post-output", "pre-assessment", "ambiguous-assessment", "post-response", "publication", "pointer-atomic", "no-redispatch"],
  "FAIL-001": ["provider-failure", "invalid-media", "publication-failure", "material-fail", "qa-retryable", "qa-terminal", "no-fake-success", "source-preserved"],
  "ROUTE-001": ["auth-first", "unauth-404", "method-body", "idempotency", "statuses", "safe-envelope", "preview", "cross-project"],
  "DTO-001": ["state-allowlist", "history", "assessment-state", "no-storage", "no-hash", "no-prompt", "no-provider", "no-claim"],
  "UI-001": ["sources", "selection", "generating", "pending", "assessment-running", "pass", "warning", "material", "unavailable", "image-retry", "assessment-retry", "history", "rollback", "second-cycle", "no-mask"],
  "PRIV-001": ["logs", "payload", "bytes", "credential", "provider-id", "private-object", "cross-project", "live-call-guard"],
  "AUTH-001": ["ownership", "uuid-not-auth", "missing-hook-blocks", "synthetic-test-only"],
  "REG-001": ["s1-regression", "s2-regression", "typecheck", "lint", "build", "no-dependency", "candidate-head-binding", "stale-head-reject"],
} as const;

export type S3EvidenceClass =
  | "behavioral"
  | "concurrency"
  | "failure-injection"
  | "boundary"
  | "static"
  | "persistence/restart"
  | "client/API"
  | "other";

export type S3ClaimDefinition = {
  testId: string;
  claimId: string;
  variantId: string;
  normativeRowText: string;
  evidenceClass: S3EvidenceClass;
  fixtureSetup: string;
};

export type S3ClaimManifest = {
  rows: Array<{ testId: string; variantIds: string[] }>;
  claims: S3ClaimDefinition[];
  rowCount: number;
  claimCount: number;
};

export type S3ClaimProofRecord = S3ClaimDefinition & {
  status: "passed" | "skipped";
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  observationFacts: string[];
};

export type S3ClaimProofComparison = {
  passedRecords: S3ClaimProofRecord[];
  missingClaims: number;
  unknownClaims: number;
  duplicateClaims: number;
  skippedClaims: number;
};

const NORMATIVE_ROW_TEXT: Record<string, string> = {
  "MODEL-001": "The S3 StoreState model contains exactly the accepted eleven S3 collections and reuses the global idempotency collection.",
  "SOURCE-001": "S1-original and S2-repaired source eligibility are separate, provenance-bound classes with immutable source snapshots and exact object integrity.",
  "SELECT-001": "Selection, reselection, rollback, CAS, idempotency, busy fencing, and retry-waiver transitions preserve one authoritative selection pointer.",
  "GRAPH-001": "Source and refinement revisions are immutable, parent-bound, generation-bound, and cannot form a branch or cross-project lineage.",
  "CYCLE-001": "A project has exactly two lifetime whole-concept refinement slots; failed or replayed work cannot create a third or consume a slot twice.",
  "IMAGE-001": "Each image operation uses the fixed provider request and bounded dispatch opportunities with no mask, hidden retry, or media transformation rescue.",
  "ASSESS-001": "Every valid changed-pixel output receives an S3-owned assessment using the frozen canonical input, compiler, request, and strict schema.",
  "ASSESS-RETRY-001": "Assessment retry is separately bounded, reuses the exact committed output bytes, and never redispatches the image provider.",
  "ACTIVATE-001": "Only a current fenced PASS or WARNING assessment activates; failure, unavailability, and stale success remain history while the prior good tip remains authoritative.",
  "INTENT-001": "Refinement intent is untrusted, normalized and bounded exactly at the server boundary; semantic claims and hard facts remain server-owned.",
  "HASH-001": "Canonical JCS and SHA-256 identities bind source, intent, refinement input, prompt, assessment input, and assessment prompt without nondeterministic fields.",
  "MEDIA-001": "Accepted S3 media is PNG with the existing integrity profile and exact 1536x1024 dimensions, with no crop, pad, resize, rotation, or re-encode rescue.",
  "PUB-001": "Publication records intent before object writes, use the private staging/final key forms, preserve no-overwrite, and recover conservatively.",
  "CONC-001": "Repository locks, idempotency, claims, fencing, liveness, and conservative dead-versus-unknown handling prevent duplicate or stale mutation.",
  "RECOVERY-001": "Crash and ambiguity recovery never manufactures success and never redispatches an operation whose external dispatch outcome is unknown.",
  "FAIL-001": "Provider, media, publication, assessment, and source failures produce the fixed safe states while preserving the last authoritative good state.",
  "ROUTE-001": "The closed S3 API route, request, response, status, preview, idempotency, and safe-error contract is enforced after authorization.",
  "DTO-001": "Public DTOs expose only the closed S3 state/history projection and exclude private storage, hashes, prompts, provider metadata, claims, and credentials.",
  "UI-001": "The client renders persisted S3 truth states and retry/history controls without inferring completion or introducing masks or local-region editing.",
  "PRIV-001": "Logs, payloads, bytes, credentials, provider identifiers, private objects, and cross-project data remain outside public or unsafe observability surfaces.",
  "AUTH-001": "Authorization precedes workflow construction and every lookup or mutation; absent or failed production context collapses externally to PROJECT_NOT_FOUND.",
  "REG-001": "The final candidate preserves S1/S2 regressions, passes repository quality gates, changes no dependency, and binds evidence to the exact candidate head/tree.",
};

function evidenceClass(testId: string, variantId: string): S3EvidenceClass {
  if (testId === "CONC-001" || testId === "SELECT-001" && ["version-cas", "busy-block", "idempotent"].includes(variantId)) return "concurrency";
  if (testId === "RECOVERY-001" || testId === "CONC-001" && ["dead-vs-unknown", "image-stale", "assessment-stale"].includes(variantId)) return "persistence/restart";
  if (testId === "IMAGE-001" && ["malformed", "attempt-two", "absolute-four"].includes(variantId)) return "failure-injection";
  if (testId === "ASSESS-001" && ["material", "provider-unavailable"].includes(variantId)) return "failure-injection";
  if (testId === "MEDIA-001" && variantId.startsWith("reject-")) return "boundary";
  if (testId === "ROUTE-001" || testId === "AUTH-001" || testId === "UI-001") return testId === "UI-001" ? "client/API" : "client/API";
  if (testId === "MODEL-001" || testId === "HASH-001" || testId === "PRIV-001" || testId === "REG-001") return "static";
  return "behavioral";
}

function fixtureSetup(testId: string, variantId: string): string {
  if (testId === "REG-001") return "The exact final candidate checkout after the implementation commit, with repository-native S1/S2 regressions, S3 tests, typecheck, lint, build, and clean-scope inspection run against it.";
  if (testId === "ROUTE-001" || testId === "AUTH-001") return "Local Request/Response fixtures through the production S3 API dispatcher with an explicit synthetic authorization seam and no live provider.";
  if (testId === "UI-001") return "Local S3 client projection and rendered screen using persisted server state; no mask or local-region editing control is present.";
  if (testId === "MEDIA-001") return "Local exact PNG fixtures and dimension-boundary outputs through the S3 media validator without transformation or provider access.";
  if (testId === "RECOVERY-001" || testId === "CONC-001") return "Local JsonRepository/private-object fixtures with claims, fences, failure injection, and restart/recovery observations.";
  if (testId === "ASSESS-001" || testId === "ASSESS-RETRY-001" || testId === "ACTIVATE-001") return "Local S3 assessment provider fixtures through the exact strict schema, frozen snapshots, retry boundary, and fenced activation transaction.";
  if (testId === "IMAGE-001" || testId === "PUB-001") return "Local S3 image-provider, exact-media, publication-intent, private-object, and no-overwrite fixtures; provider calls are mocked.";
  return "Local deterministic S3 fixture exercising the exact " + testId + "/" + variantId + " contract claim.";
}

export function deriveClaimManifest(variants: Record<string, readonly string[]> = VARIANTS): S3ClaimManifest {
  const rows = Object.entries(variants).map(([testId, variantIds]) => ({ testId, variantIds: Array.from(variantIds) }));
  const claims = rows.flatMap(({ testId, variantIds }) => variantIds.map((variantId) => ({
    testId,
    claimId: testId + ":" + variantId,
    variantId,
    normativeRowText: NORMATIVE_ROW_TEXT[testId] ?? "The accepted S3 contract obligation for " + testId + ".",
    evidenceClass: evidenceClass(testId, variantId),
    fixtureSetup: fixtureSetup(testId, variantId),
  })));
  return {
    rows,
    claims,
    rowCount: rows.length,
    claimCount: claims.length,
  };
}

export function compareClaimProofs(manifest: S3ClaimManifest, records: S3ClaimProofRecord[]): S3ClaimProofComparison {
  const expectedIds = new Set(manifest.claims.map((claim) => claim.claimId));
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.claimId, (counts.get(record.claimId) ?? 0) + 1);
  const missingClaims = manifest.claims.filter((claim) => !counts.has(claim.claimId)).length;
  const unknownClaims = records.filter((record) => !expectedIds.has(record.claimId)).length;
  const duplicateClaims = Array.from(counts.values()).reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);
  const skippedClaims = records.filter((record) => expectedIds.has(record.claimId) && record.status === "skipped").length;
  return {
    passedRecords: records.filter((record) => record.status === "passed"),
    missingClaims,
    unknownClaims,
    duplicateClaims,
    skippedClaims,
  };
}
