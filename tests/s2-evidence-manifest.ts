export type EvidenceType =
  | "behavioral" | "concurrency" | "failure-injection" | "boundary" | "static"
  | "persistence/restart" | "client/API" | "other";

export type ClaimDefinition = {
  testId: string;
  claimId: string;
  variantId: string;
  normativeRowText: string;
  evidenceType: EvidenceType;
  fixtureSetup: string;
};

const VARIANTS: Record<string, string[]> = {
  "MEDIA-001": ["upload", "original-persistence", "normalized-persistence"],
  "MEDIA-002": ["static-jpeg", "jpg-alias"],
  "MEDIA-003": ["vp8", "vp8l"],
  "MEDIA-004": ["png-malformed", "jpeg-malformed", "webp-malformed"],
  "MEDIA-005": ["mime-mismatch", "extension-mismatch"],
  "MEDIA-006": ["svg", "gif", "tiff", "bmp", "ico", "pdf", "heic", "avif"],
  "MEDIA-007": ["apng", "animated-webp"],
  "MEDIA-008": ["truncated", "corrupt", "decoder-warning", "multi-frame"],
  "MEDIA-009": ["exact-accepted", "next-rejected"],
  "MEDIA-010": ["body-boundary"],
  "MEDIA-011": ["exact-4096", "over-4096"],
  "MEDIA-012": ["exact-max-square", "pixel-guard-fixed", "unrepresentable-plus-one"],
  "MEDIA-013": ["aggregate-exact", "aggregate-plus-one-bind"],
  "MEDIA-014": ["per-asset-exact", "aggregate-max-representable", "guards-configured"],
  "MEDIA-015": ["exact-normalized", "next-byte"],
  "MEDIA-016": ["exif-orientation"],
  "MEDIA-017": ["icc", "exif", "xmp", "iptc", "png-text", "comments", "filename"],
  "MEDIA-018": ["alpha-preserved", "opaque-no-background"],
  "MEDIA-019": ["png", "srgb8", "deterministic", "no-transform"],
  "MEDIA-020": ["original-hash", "normalized-hash"],
  "MEDIA-021": ["failOn", "limitInputPixels", "pages", "animated", "no-unlimited"],
  "MEDIA-022": ["validation-cleanup", "normalization-cleanup"],
  "DRAFT-001": ["revision", "editable", "empty-reference", "empty-logo"],
  "DRAFT-002": ["upload-no-order"],
  "DRAFT-003": ["add", "remove", "reorder", "full-array-revision"],
  "DRAFT-004": ["noop-revision", "stale-conflict"],
  "DRAFT-005": ["duplicate", "wrong-kind", "deleted", "cross-project", "missing"],
  "DRAFT-006": ["six-references", "two-logos", "seventh-reference", "third-logo", "ninth-total"],
  "DRAFT-007": ["empty-bind"],
  "DRAFT-008": ["freeze", "later-write"],
  "DRAFT-009": ["failed-bind-no-freeze", "no-increment-rollback"],
  "BIND-001": ["succeeded-only", "four-exact"],
  "BIND-002": ["candidate-id", "index", "s1-asset-id", "byte-identity", "dimensions", "decoded-safety"],
  "BIND-003": ["brief-snapshot", "geometry-snapshot"],
  "BIND-004": ["input-hash", "requirement-hash", "binding-hash", "independent-jcs"],
  "BIND-005": ["input-one", "run-one", "four-queued-transaction"],
  "BIND-006": ["concurrent-one"],
  "BIND-007": ["same-replay", "changed-reject"],
  "BIND-008": ["second-bind-conflict"],
  "BIND-009": ["encoded-aggregate", "decoded-aggregate", "exact-32MiB", "max-representable-rgba"],
  "BIND-010": ["read-private", "verify-identity", "no-mutate-renorm"],
  "QA-001": ["one-per-candidate", "source-only"],
  "QA-002": ["model", "store-false", "high-detail", "strict-schema"],
  "QA-003": ["requirements-coverage", "rules-coverage", "server-findings"],
  "QA-004": ["missing", "duplicate", "unknown", "non-applicable", "extra-property", "wrong-type", "out-of-range"],
  "QA-005": ["expected-values", "counts", "applicability", "echo-mismatch"],
  "QA-006": ["below-0.75", "null-count", "exact-0.75"],
  "QA-007": ["present", "absent", "exact-count", "uncertain-null", "prohibited", "compliant", "non-compliant"],
  "QA-008": ["severity", "verdict", "criticality", "repair-flags"],
  "QA-009": ["complete-pass", "null-height-pass"],
  "QA-010": ["uncertain", "not-verifiable", "warning-level", "null-count-valid"],
  "QA-011": ["complete-material", "high-confidence", "overhead-scale"],
  "QA-012": ["incomplete", "timeout", "decoder", "persistence", "refusal", "provider"],
  "QA-013": ["counters", "order"],
  "QA-014": ["bound-400", "not-logged"],
  "QA-015": ["null-omits", "supplied-applies"],
  "RETRY-001": ["retryable-visible", "terminal-hidden"],
  "RETRY-002": ["attempt2", "same-input", "same-run", "no-new-draft"],
  "RETRY-003": ["terminal-reject", "attempt2-exhausted"],
  "RETRY-004": ["no-hidden", "one-call"],
  "RETRY-005": ["late-fences-attempt2", "late-fences-terminal"],
  "REPAIR-001": ["complete-material", "allowlist", "overhead-scale"],
  "REPAIR-002": ["warning", "pass", "unavailable", "uncertain", "not-verifiable"],
  "REPAIR-003": ["footprint", "access", "circulation", "zones", "no-floating", "screen-support", "overhead-support", "scale", "intersections", "branding", "functional", "mandatory"],
  "REPAIR-004": ["spatial-pair", "spatial-triple", "two-fail", "matrix-exact"],
  "REPAIR-005": ["max-height", "style", "rigging", "budget", "free-text", "hard-facts", "overhead-scale-eligible", "uncertainty-ineligible"],
  "REPAIR-006": ["geometry", "open-side", "source-lineage", "brief"],
  "REPAIR-007": ["already-exists", "exhausted"],
  "REPAIR-008": ["source-first", "refs-order", "logos-order"],
  "REPAIR-009": ["count", "decoded", "rgba", "encoded-precall"],
  "REPAIR-010": ["repeated-images", "model", "n-one", "size", "medium", "png", "no-mask-fidelity"],
  "REPAIR-011": ["empty", "multiple", "non-png", "invalid-base64", "oversized", "corrupt-truncated"],
  "REPAIR-012": ["stable", "input-change"],
  "REPAIR-013": ["evidence-ignored"],
  "REPAIR-014": ["staging", "stale-claim", "publication"],
  "REPAIR-015": ["bounded-support", "no-approval"],
  "REPAIR-016": ["bounded-scale", "no-hard-geometry", "no-engineering-venue"],
  "REQA-001": ["one-created", "after-valid"],
  "REQA-002": ["hard-facts", "requirements", "schema", "model", "algorithm"],
  "REQA-003": ["pass", "warning", "material-fail", "unavailable"],
  "REQA-004": ["no-retry", "no-second-repair"],
  "REQA-005": ["derived-immutable", "source-immutable", "repair-linked", "reqa-linked"],
  "CONC-001": ["claim-uniqueness", "no-duplicate-call"],
  "CONC-002": ["dead-requeue", "unknown-busy"],
  "CONC-003": ["upload-active", "bind-active", "qa-active", "repair-active", "reqa-active"],
  "CONC-004": ["late-fence", "owned-cleanup"],
  "CONC-005": ["no-missing-object", "no-false-terminal"],
  "CONC-006": ["no-overwrite", "no-duplicate"],
  "ROUTE-001": ["auth-all"],
  "ROUTE-002": ["method", "body", "key", "status", "envelope"],
  "ROUTE-003": ["idempotent-replay"],
  "ROUTE-004": ["202-refresh", "timeout-refresh", "restart-refresh", "browser-refresh"],
  "ROUTE-005": ["frozen-readonly", "empty-valid"],
  "ROUTE-006": ["repair-control", "retry-control"],
  "PRIV-001": ["image-bytes", "base64", "prompt", "provider-payload", "evidence", "private-path"],
  "PRIV-002": ["credential", "token", "private-key", "env", "auth-header"],
  "PRIV-003": ["cross-project", "private-preview"],
  "PRIV-004": ["generated-keys", "traversal"],
  "PRIV-005": ["secret-scan", "dependency-review", "no-live-provider"],
  "UI-001": ["references-disclaimer", "qa-disclaimer"],
  "UI-002": ["ordered-candidates", "state-distinguishable"],
  "UI-003": ["unavailable-not-pass"],
  "UI-004": ["no-prompt-edit", "no-model-edit", "no-verdict-edit", "no-hard-fact-edit", "no-hash-edit"],
};

function rowMap(contractText: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const match of contractText.matchAll(/^\|\s*([A-Z]+-\d{3})\s*\|\s*(.*?)\s*\|\s*$/gm)) rows.set(match[1], match[2]);
  return rows;
}

function typeFor(testId: string, variantId: string): EvidenceType {
  if (testId === "CONC-002" || testId === "CONC-003" || testId === "CONC-005") return "persistence/restart";
  if (testId.startsWith("CONC-")) return "concurrency";
  if (testId.startsWith("RETRY-005")) return "concurrency";
  if (testId === "MEDIA-014" && variantId === "guards-configured") return "static";
  if (testId.startsWith("MEDIA-") || testId.startsWith("DRAFT-") || testId.startsWith("BIND-") || testId.startsWith("QA-") ||
      testId.startsWith("REPAIR-") || testId.startsWith("REQA-")) return "behavioral";
  if (testId.startsWith("ROUTE-")) return "client/API";
  if (testId.startsWith("PRIV-002") || testId.startsWith("PRIV-005") || testId.startsWith("UI-")) return "static";
  return "other";
}

function fixtureFor(testId: string, variantId: string): string {
  if (testId === "MEDIA-008") return "Real sharp 0.35.3 decoder fixture for the " + variantId + " PNG/JPEG/WebP rejection class.";
  if (testId === "MEDIA-012") return variantId === "unrepresentable-plus-one"
    ? "Real 4,096 x 4,096 sharp raster plus MEDIA-011 4,097-dimension boundary; no impossible raster is constructed."
    : "Real sharp 0.35.3 4,096 x 4,096 raster through normalizeS2Media and inspectCanonicalS1Png.";
  if (testId === "MEDIA-013") return "Persisted S1 source and selected normalized asset fixtures through the real bind aggregate calculation.";
  if (testId === "MEDIA-015") return "Real normalized PNG output from the locked sharp pipeline at the exact 16 MiB boundary and next byte.";
  if (testId === "DRAFT-003") return "Two persisted ordered reference assets and one logo through full-array PATCH add/remove/reorder mutations.";
  if (testId === "BIND-009") return "Persisted S1 source PNGs plus selected normalized assets through the actual S2 bind boundary.";
  if (testId === "QA-012") return "Six named local provider failure fixtures mapped through the production QA aggregation boundary.";
  if (testId === "RETRY-005") return "Deferred attempt-1 provider response racing explicit attempt 2 and terminal state.";
  if (testId === "CONC-003") return "Local restart fixtures for upload, bind, QA, repair and re-QA with definite, live and uncertain liveness; repair/re-QA recovery preserves the completed source-QA run.";
  if (testId === "REPAIR-007") return "Real two-candidate repair workflow proving one repair per (qaRunId, candidateId), independent candidate repair, and same-candidate rejection.";
  if (testId === "REQA-003") return "Four real repair/re-QA workflows proving pass, warning, material-fail, and unavailable outcomes without changing source-QA completion.";
  if (testId === "REPAIR-011") return "Production OpenAIProvider.runS2Repair adapter with one controlled local response per locked output class.";
  if (testId === "PRIV-001") return "Real local S2 success/failure/error run with captured console sinks; each exact privacy marker is checked against captured logs and safe envelopes; production provider adapter markers and private object keys are exercised.";
  if (testId === "PRIV-002") return "Changed-client/provider boundary review for credentials, tokens, private keys, environment reads, and authorization headers.";
  if (testId === "PRIV-005") return "Canonical-base tracked changed-surface credential scan with controlled redaction negative, measured normal-run provider transport counters, a separate blocked guard probe, frozen dependency metadata, and product audit target.";
  if (testId === "UI-002") return "Shuffled QA projection derived from the actual persisted server projection, passed through the production candidate-order renderer helper, with real available and unavailable state projections.";
  if (testId.startsWith("UI-")) return "Local rendered S2 reference and QA screens with visual-only disclosure and state controls.";
  const family = testId.split("-")[0];
  return "Local deterministic " + family + " fixture exercising the exact " + testId + "/" + variantId + " claim.";
}

export function deriveClaimManifest(contractText: string): ClaimDefinition[] {
  const rows = rowMap(contractText);
  const claims: ClaimDefinition[] = [];
  for (const [testId, variants] of Object.entries(VARIANTS)) {
    const normativeRowText = rows.get(testId);
    if (!normativeRowText) throw new Error("Missing Section-24 row: " + testId);
    for (const variantId of variants) {
      claims.push({
        testId,
        claimId: testId + "/" + variantId,
        variantId,
        normativeRowText,
        evidenceType: testId === "MEDIA-012" && variantId === "unrepresentable-plus-one" ? "boundary" : typeFor(testId, variantId),
        fixtureSetup: fixtureFor(testId, variantId),
      });
    }
  }
  return claims;
}

export const manifestVariantCount = Object.values(VARIANTS).reduce((total, variants) => total + variants.length, 0);
export const manifestBaseRowCount = Object.keys(VARIANTS).length;
