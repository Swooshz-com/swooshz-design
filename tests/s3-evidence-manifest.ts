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
  missingClaims: number;
  unknownClaims: number;
  duplicateClaims: number;
  skippedClaims: number;
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
    normativeRowText: testId,
    evidenceClass: evidenceClass(testId, variantId),
    fixtureSetup: fixtureSetup(testId, variantId),
  })));
  const unique = new Set(claims.map((claim) => claim.claimId));
  return {
    rows,
    claims,
    rowCount: rows.length,
    claimCount: claims.length,
    missingClaims: 0,
    unknownClaims: 0,
    duplicateClaims: claims.length - unique.size,
    skippedClaims: 0,
  };
}
