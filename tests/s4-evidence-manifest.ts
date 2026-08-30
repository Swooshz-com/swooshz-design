import { jcs, sha256 } from "../src/lib/utils";

export type S4EvidenceClass =
  | "static"
  | "boundary"
  | "behavioral"
  | "client/API"
  | "concurrency"
  | "failure-injection"
  | "persistence/restart";

export const VARIANTS = {
  "IDENTITY-001": ["canonical-g2-base", "g1-lock", "g2-lock", "contract-identity", "provider-contract"],
  "MODEL-001": ["s4-collections", "global-idempotency", "s3-union-unchanged", "s3-counters-unchanged", "migration-empty-default", "closed-record-keys"],
  "RESOLVE-001": ["s3-source", "s3-refinement", "s4-revision", "duplicate-id-fail", "foreign-project", "foreign-generation", "lineage", "quality", "pointer-only", "public-kind"],
  "STAGE-001": ["not-started", "mask-preparation", "failed-first", "second-admit", "third-reject", "replay-no-cycle", "s3-close", "rollback-no-reset", "later-waives", "inflight-busy"],
  "MASK-API-001": ["exact-body", "rectangle", "brush", "primitive-count", "q16-range", "q8-radius", "ordering", "duplicates", "degenerate", "body-limit", "clear-client-only"],
  "RASTER-001": ["half-open", "pixel-center", "disk", "capsule", "segment-rational", "union", "clip-no-wrap", "empty", "min-area", "max-area", "full-image", "comparison-min", "binary-layout", "canonical-hash"],
  "MASK-PNG-001": ["dimensions", "rgba", "protected-opaque", "editable-transparent", "stored-deflate", "no-metadata", "hash-distinct", "filename", "editable-fixture"],
  "IMAGE-001": ["endpoint", "snapshot", "one-source", "one-mask", "n-one", "size", "quality", "png", "omit-fidelity", "no-references", "no-hidden-retry", "one-output", "response-validate"],
  "INSTRUCTION-001": ["nfc", "trim", "scalar-bound", "utf8-bound", "controls", "surrogate", "no-keyword-parser", "untrusted", "server-facts", "hash"],
  "IDENTITY-BIND-001": ["project-generation", "selection-version", "source-type-parent", "source-bytes", "source-quality", "brief-geometry", "requirements-rules", "sequence-mask", "instruction", "provider-request", "exclude-time", "assessment-independent"],
  "REVISION-001": ["s4-own", "immutable", "parent-exact", "lineage", "no-copy", "derived-activation", "historical-projection", "asset-link"],
  "PRESERVE-001": ["decode-rgba", "dimensions", "mask-exclusion", "guard-dilation", "rgb", "alpha", "components", "aggregate", "pass", "material", "qa-unavailable", "no-warning", "no-ai", "no-op"],
  "CALIBRATION-001": ["identical", "inside", "guard", "tiny", "noise", "sparse", "connected", "catastrophic", "alpha", "edge", "large", "comparison", "thresholds", "derived", "polarity"],
  "ASSESS-001": ["own-compiler", "own-schema", "model", "source-bind", "edited-bind", "mask-bind", "instruction-bind", "frozen-facts", "quality", "strict", "observations", "satisfaction", "overall", "reducer"],
  "ASSESS-RETRY-001": ["initial", "retryable", "one-retry", "same-bytes", "same-input", "no-image", "valid-no-retry", "uncertainty-no-retry", "terminal-no-retry"],
  "ACTIVATE-001": ["pass", "warning", "preserve-fail", "material-no", "qa-no", "stale-pass", "stale-warning", "no-op-no", "cas", "atomic", "version-increment", "s3-counters"],
  "ROLLBACK-001": ["shared-route", "s3-target", "s4-target", "same-lineage", "usable", "inflight-block", "retry-waiver", "no-reset", "no-latest-jump", "next-edit-target", "immutable"],
  "CONCURRENCY-001": ["repo-lock", "same-key", "s4-idempotency-reuse", "different-key-busy", "claims", "image-stale", "preserve-stale", "assessment-stale", "pointer-race", "dead-pre", "unknown-hold", "ceiling"],
  "RETRY-001": ["image-classes", "ambiguous-transport", "image-one", "assessment-classes", "assessment-one", "no-extra-cycle", "no-redispatch", "waiver"],
  "DISPATCH-001": ["image-four", "assessment-four", "preserve-zero", "count-may", "count-consumed", "no-decrement"],
  "RECOVERY-001": ["mask-intent-crash", "pre-dispatch", "ambiguous", "response-lost", "staging", "promotion", "publication-abort", "preserve-restart", "assessment-restart", "activation-crash", "no-fake", "no-overwrite"],
  "KEYS-001": ["mask-raster", "mask-provider", "staged", "committed", "preserve-evidence", "assessment-evidence", "private", "no-user-key"],
  "AUTH-API-001": ["auth-first", "default-deny", "cross-project", "routes", "methods", "headers", "statuses", "preview", "errors", "dto"],
  "PRIVACY-001": ["no-keys", "no-hashes", "no-prompts", "no-provider", "no-claims", "no-evidence", "no-credentials", "safe-log"],
  "CLIENT-001": ["mask-ready", "rectangle-ui", "brush-ui", "clear", "bounds", "submit", "poll", "retry", "preservation", "assessment", "history", "rollback", "budget", "no-infer"],
  "S5-001": ["optional", "active-s3", "active-s4", "quality", "selection-version", "projection", "no-s5"],
  "REGRESSION-001": ["s1", "s2", "s3", "typecheck", "lint", "build", "no-dependencies", "candidate-head-tree"],
  "EVIDENCE-001": ["manifest-separate", "proof-runtime", "missing-derived", "unknown-derived", "duplicate-derived", "skipped-derived", "head-movement-fail", "static-only", "exact-schema"],
  "GATE-001": ["executor-no-self-finalize", "candidate-not-merged", "no-live-provider", "no-customer-private-data", "parent-child-reconciled", "gate-reentry"],
} as const;

export type S4ClaimDefinition = {
  testId: string;
  claimId: string;
  variantId: string;
  normativeRowText: string;
  evidenceClass: S4EvidenceClass;
  fixtureSetup: string;
};

export type S4ClaimManifest = {
  schemaVersion: "s4-claim-manifest-v1";
  contractPath: "docs/G2_S4_CONTRACT.md";
  rows: Array<{ testId: string; variantIds: string[] }>;
  claims: S4ClaimDefinition[];
  rowCount: number;
  claimCount: number;
  manifestHash: string;
};

export type S4ClaimProofRecord = S4ClaimDefinition & {
  status: "passed" | "skipped";
  expectedResult: string;
  actualResult: string;
  provingTest: string;
  observationFacts: string[];
};

export type S4ClaimProofComparison = {
  passedRecords: S4ClaimProofRecord[];
  missingClaims: number;
  unknownClaims: number;
  duplicateClaims: number;
  skippedClaims: number;
};

const NORMATIVE: Record<string, string> = {
  "IDENTITY-001": "The S4 implementation remains bound to the accepted G1/G2 decisions, canonical base, contract path, and provider contract.",
  "MODEL-001": "S4 uses exactly the eleven accepted collections, the global idempotency collection, and strict persisted records without rewriting S3.",
  "RESOLVE-001": "One pointer-first resolver resolves S3 and S4 revisions only when identity, ownership, lineage, quality, and object integrity are exact.",
  "STAGE-001": "S4 starts only on first admission, closes S3 refinement, consumes at most two cycles, and preserves retry and rollback semantics.",
  "MASK-API-001": "The S4 boundary accepts only the exact bounded rectangle/brush request and never treats client-local state as persisted truth.",
  "RASTER-001": "S4 mask rasterization is deterministic, fixed-point, pixel-center, clipped, unioned, and bounded by exact area rules.",
  "MASK-PNG-001": "The provider mask is a deterministic RGBA PNG with transparent editable pixels and opaque protected pixels.",
  "IMAGE-001": "The image provider request is fixed, single-output, source-and-mask bound, and strictly validates its response.",
  "INSTRUCTION-001": "Instruction text is normalized and bounded as untrusted data without a keyword parser or authority over server facts.",
  "IDENTITY-BIND-001": "Every S4 identity binds project, selection, source, frozen S2 facts, mask, instruction, and provider inputs while excluding time and response data.",
  "REVISION-001": "S4 revisions are immutable S4-owned descendants with exact parent links and derived current/history projections.",
  "PRESERVE-001": "Protected-region preservation is deterministic RGBA comparison with guard dilation, component metrics, fail-closed QA, and no-op detection.",
  "CALIBRATION-001": "Preservation calibration covers identical, leakage, noise, sparse, connected, alpha, edge, large, and threshold derivations.",
  "ASSESS-001": "S4 assessment uses its own frozen compiler, strict schema, source/output/mask/instruction bindings, and deterministic reducer.",
  "ASSESS-RETRY-001": "Assessment retry is explicit and bounded, reuses the exact committed output, and never retries valid or ambiguous results.",
  "ACTIVATE-001": "Only a fenced usable PASS/WARNING result activates atomically; failure, no-op, QA-unavailable, and stale results do not.",
  "ROLLBACK-001": "The shared rollback route resolves usable same-lineage S3/S4 targets, increments the pointer version once, and never resets budget or mutates history.",
  "CONCURRENCY-001": "Repository locks, idempotency, claims, liveness, stale fencing, pointer CAS, and dispatch ceilings prevent duplicate work.",
  "RETRY-001": "Retry classes are explicit, bounded, and conservative around ambiguous or consumed provider dispatch.",
  "DISPATCH-001": "Dispatch accounting is per lineage with exact possible/consumed ceilings and no decrement or hidden retry.",
  "RECOVERY-001": "Restart recovery distinguishes pre-dispatch, ambiguous, and post-consumed classification loss without manufacturing success or overwriting objects.",
  "KEYS-001": "Mask, publication, and evidence objects use private deterministic keys with exact identity and no user-controlled path material.",
  "AUTH-API-001": "The S4 API is authorization-first, default-deny, isolated, method/header/status exact, and privacy-safe in its DTO and errors.",
  "PRIVACY-001": "Public responses and safe logs exclude keys, hashes, prompts, provider data, claims, evidence, credentials, and private data.",
  "CLIENT-001": "The S4 client renders persisted truth for mask, generation, preservation, assessment, history, rollback, retry, and budget state.",
  "S5-001": "S4 exposes only an optional internal handoff projection and never creates or mutates S5 records.",
  "REGRESSION-001": "The candidate preserves S1/S2/S3 behavior and passes repository quality, dependency, and candidate identity gates.",
  "EVIDENCE-001": "The evidence artifact separates its manifest from executed proof, derives completeness counters, and binds runtime identity exactly.",
  "GATE-001": "The executor produces a candidate for controller review and does not self-finalize G3, authorize G4, merge, call live providers, or access private customer data.",
};

function evidenceClass(testId: string): S4EvidenceClass {
  if (["IDENTITY-001"].includes(testId)) return "static";
  if (["MODEL-001", "RECOVERY-001", "KEYS-001"].includes(testId)) return "persistence/restart";
  if (["MASK-API-001", "RASTER-001", "MASK-PNG-001", "INSTRUCTION-001", "CALIBRATION-001", "DISPATCH-001"].includes(testId)) return "boundary";
  if (["ASSESS-RETRY-001", "RETRY-001"].includes(testId)) return "failure-injection";
  if (["ACTIVATE-001", "ROLLBACK-001", "CONCURRENCY-001"].includes(testId)) return "concurrency";
  if (["AUTH-API-001", "CLIENT-001"].includes(testId)) return "client/API";
  return "behavioral";
}

function fixtureSetup(testId: string): string {
  if (testId === "IDENTITY-001") return "Static accepted-contract and provider-constant identity checked without runtime behavior claims.";
  if (testId === "MODEL-001" || testId === "RECOVERY-001" || testId === "KEYS-001") return "Local JsonRepository and private-object fixtures with restart-safe state and no live provider.";
  if (testId === "AUTH-API-001" || testId === "CLIENT-001") return "Local API/client fixtures using synthetic authorization and persisted server projections.";
  if (testId === "REGRESSION-001") return "The exact candidate checkout with repository-native regression and quality commands.";
  return "Local deterministic S4 fixture exercising the exact " + testId + " contract surface; provider calls are mocked.";
}

export function deriveClaimManifest(): S4ClaimManifest {
  const rows = Object.entries(VARIANTS).map(([testId, variantIds]) => ({ testId, variantIds: Array.from(variantIds) }));
  const claims = rows.flatMap(({ testId, variantIds }) => variantIds.map((variantId) => ({
    testId,
    claimId: testId + ":" + variantId,
    variantId,
    normativeRowText: NORMATIVE[testId],
    evidenceClass: evidenceClass(testId),
    fixtureSetup: fixtureSetup(testId),
  })));
  const base = {
    schemaVersion: "s4-claim-manifest-v1" as const,
    contractPath: "docs/G2_S4_CONTRACT.md" as const,
    rows,
    claims,
    rowCount: rows.length,
    claimCount: claims.length,
  };
  return { ...base, manifestHash: sha256(Buffer.from(jcs(base), "utf8")) };
}

export function compareClaimProofs(manifest: S4ClaimManifest, records: S4ClaimProofRecord[]): S4ClaimProofComparison {
  const expectedIds = new Set(manifest.claims.map((claim) => claim.claimId));
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.claimId, (counts.get(record.claimId) ?? 0) + 1);
  return {
    passedRecords: records.filter((record) => record.status === "passed"),
    missingClaims: manifest.claims.filter((claim) => !counts.has(claim.claimId)).length,
    unknownClaims: records.filter((record) => !expectedIds.has(record.claimId)).length,
    duplicateClaims: Array.from(counts.values()).reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0),
    skippedClaims: records.filter((record) => expectedIds.has(record.claimId) && record.status === "skipped").length,
  };
}
