<!-- Source: #72:5924415505 (G2 artifact SHA-256 25c70e15004fb8c772c4d729fb9de57dfbb21256efdf92509c32698a4f1480f9), incorporating #29:5909646454 (Run-130 artifact SHA-256 178074bbbfedcabf8e30c4f16688f30f64953139eefd1fd890d5847fbe5adbec). Markdown backtick escaping is normalized for this repository document. Accepted amendments below supersede only their named boundaries. -->

## Accepted successor amendments

Current executable authority is [Run-140 acceptance](https://github.com/Swooshz-com/swooshz-design/issues/72#issuecomment-5953789279)
and its [Run-136 resume handoff](https://github.com/Swooshz-com/swooshz-design/issues/72#issuecomment-5953818081),
with [Run-137 provenance](https://github.com/Swooshz-com/swooshz-design/issues/72#issuecomment-5929841901)
and [Run-138 release binding](https://github.com/Swooshz-com/swooshz-design/issues/72#issuecomment-5935941657).
The original G135 and Run-130 artifacts remain below for complete evidence and
unchanged obligations. Their historical path counts and challenge model labels
are superseded by this section.

```text
G3_MUTATION_CEILING=95_PATHS
SUCCESSOR_PR_CHANGED_PATH_CEILING=95_PATHS
REIMPLEMENT_SUCCESSOR=35
TRANSPLANT_EXACT_BLOBS=51
TRANSPLANT_EXACT_DELETIONS=7
NEW_FILE_COUNT=2
MAX_ADDED_PATHS_RELATIVE_TO_BASE=57
MAX_DELETED_PATHS_RELATIVE_TO_BASE=7
RENAMES_AUTHORISED=NO
S6_VALIDATOR_VERSION=s6-validator-v2
S6_VALIDATION_ORDER_VERSION=s6-validation-order-v1
G3_ROUTE=openai/gpt-6-luna__max
G3_ADVERSARIAL_CHALLENGE_ROUTE=openai/gpt-6.1-sol__high
```

Run-137 adds `src/lib/s8-fbx-payload.ts` and `tests/s8-payload.test.ts` to
REIMPLEMENT_SUCCESSOR. Its exact provenance shape accepts either boolean value
of `acceptedByUser`; field-level provenance is preserved unchanged. The resolved
kinds are `confirmed_project_input`, `user_confirmed_design_decision` and
`bounded_design_inference`. Unresolved/malformed provenance remains rejected.

Run-138 reclassifies only `tests/s8-native-release.test.ts` from exact transplant
to REIMPLEMENT_SUCCESSOR. Production admission/release blobs and launcher
`releaseManifestSha256` binding remain strict. Positive fixtures require a
complete signed canonical admission envelope; omission is negative-only.

Run-140 additionally admits these existing clean-base paths:

```text
src/lib/s6-compiler.ts
src/lib/s6-validation.ts
src/lib/s6-canonical.ts
src/lib/s6-persistence.ts
src/lib/s6-handoff.ts
tests/s6-compiler.test.ts
tests/s6-validation.test.ts
tests/s6-lifecycle.test.ts
tests/s6-persistence.test.ts
tests/s6-handoff.test.ts
```

Already admitted Run-140 changes are bounded to `src/lib/types.ts`,
`tests/s8-publication.test.ts`, `tests/s8-native-proof.test.ts` and these two
canonical architecture/contract documents. No amendment authorizes changes to
`s6-correction.ts`, `s6-source.ts`, `tests/s6-fixture.ts`, S5 product semantics or
S7 product semantics. All 51 retained transplant blob identities and seven
deletion identities below remain exact.

### One S6 requirement-satisfaction authority

`src/lib/s6-validation.ts` owns the finite resolver and evaluator. The compiler
consumes the resolver; validation evaluates requirements in deterministic ID
order. Derived results are recomputed from current source/model and cannot grant
authority when supplied by a caller. They are not reusable persisted approvals.

| Category | Required evidence |
|---|---|
| Geometry | Exact requirement/source/booth agreement, immutable floor, valid enclosure and transformed height |
| Functional | Distinct compatible object allocations or an explicitly resolved valid metric zone |
| Mandatory/free text | Complete supported object, zone or deterministic scene-predicate meaning |
| Prohibited | Complete-scene absence independent of requirement tags |

The canonical geometry IDs are `geometry.width`, `geometry.depth`,
`access.open-sides` and `geometry.max-height`. They require `category=geometry`,
`source=geometry_snapshot`, `expected=present`, `expectedCount=null`, and forbid
object requirement mappings. Width/depth/known maximum height are finite safe
integer millimetres with exact equality and no coercion. Open-side values are
valid, duplicate-free comma-separated tokens from `north,east,south,west`;
source order may differ, model order is canonical. Null source height stays
unknown and never acquires a fabricated maximum-height requirement.

Object `present` means one or more; `exact_count=N` means N distinct compatible
allocations; `absent` and exact count zero require scene-wide absence. Present
and absent have null expected counts; exact counts are safe nonnegative integers
within existing resource limits. Invalid/excessive counts are blocking and are
never clamped. Duplicate IDs, wrong-family tags, zone/floor/wall substitutes and
unallocated compatible extras cannot manufacture satisfaction. Separate
functional requirements need separate allocations unless the source explicitly
allows shared representation. Zones require unique identities, matching
association/category, valid referenced metric regions and containment; a zone
and its region count once.

Resolution preserves complete meaning, qualifiers and negation. Unsupported or
partially understood requirements remain blocking even when their upstream
criticality is warning. Supported false evidence is `unsatisfied`; unknown
meaning/evidence is `unresolved`. Both block acceptance. Notes, confirmation,
resolved flags and simplification do not waive constraints. Typed corrections
must produce evidence that passes re-evaluation; upstream meaning changes need
the upstream confirmation/approval route and a new source fingerprint.

### Bounded scene predicates and receipt migration

Supported predicates cover booth containment, confirmed maximum height, entry
clearance and forbidden-family absence. Only the complete normalized expression
`Keep the entry clear.` resolves to `entry-clear-v1`:

```text
ENTRY_WIDTH_MM=900
ENTRY_DEPTH_MM=900
ENTRY_HEIGHT_MM=2100
```

For every confirmed open side, center the inward volume using tangential lower
coordinate `floor((sideLength - 900) / 2)`. It must fit fully within the booth
and confirmed height envelope. Positive-volume intersections with physical
world geometry, including transformed children, walls and overheads, fail.
Boundary-only contact passes. Exclude only immutable floor and nonphysical zone
regions. Do not shrink or relocate the volume automatically. This is a concept
layout policy, not regulatory accessibility certification.

`No enclosed ceiling.` is a supported absence predicate. Closed solid overheads
fail; ambiguous potential ceiling geometry remains unresolved. Removing tags,
changing labels or confirming a note does not establish absence.

New validation emits v2. Historical v1 receipts remain readable and byte-for-byte
historical; they are not relabeled, rehashed or upgraded. Current acceptance and
`buildS6ToS7Handoff()` require current receipt authority. Handoff also evaluates
the current source/model through the shared satisfaction authority. A legacy
accepted model must follow legitimate current validation and acceptance.

### Run-140 assurance and continuation

Required oracle families are G140-G01..G04 (geometry), F01..F03 (object/zone
allocation), C01..C02 (constraints), P01..P02 (absence), U01..U02 (correction),
S01 (source), V01 (receipt), H01 (handoff), and I01..I02 (production integration).
Every negative must have a same-boundary passing control and recompute otherwise
valid model/camera hashes when needed to reach the semantic invariant.

I01 preserves all geometry, entry-clear and ceiling requirements through the
actual confirmed brief/S2, selected source, S5 approval and committed outputs,
ready projection, S6 generation and typed correction/review, v2 validation and
acceptance, equal direct/delegated handoffs, committed S7 export and S8 verified
native publication flow. I02 independently obstructs entry, changes counts,
introduces prohibited content and stales source; each stops before downstream
publication authority. Synthetic source/accepted state or removed requirements
cannot substitute for this integration proof.

Run compiler/validation tests first, persistence/lifecycle/handoff tests second,
publication tests third, then affected retained S6/S7 suites. Close TypeScript,
build, canonical `pnpm test`, all inherited G135/130/137/138 floors and exact
95/35/51/7/2 checks. Preserve verified checkpoints after material phases. Product
corrections stay local; `swooshz-vps` is an exact-checkpoint validation carrier.
Only a fully green pre-candidate floor permits candidate freeze, then a fresh
first challenge, conditional draft publication, five exact-head hosted checks
and a fresh second challenge. G4, Ready, merge, deployment, infrastructure
mutation and native admission opening remain unauthorized.

The existing five-job hosted workflow retains exact-head checkout, secret
preflight, TypeScript, canonical tests, build, native regressions and both pinned
actionlint platforms. It also runs the mandatory Linux durability selection
with `S8_G135_REQUIRE_LINUX=1` and the candidate Git/blob selection with
`S8_G135_CANDIDATE` bound to the exact pull-request head. The workflow adds no
deployment or native admission action.

## G2 terminal contract — proof-derived native authority — Part 1 of 4

```text
RESULT=G2_PASS_PROOF_DERIVED_NATIVE_AUTHORITY_CONTRACT
RUN=S8_G2_PROOF_DERIVED_NATIVE_AUTHORITY_135
LOCK=DL-SD-S8-G2-PROOF-DERIVED-NATIVE-AUTHORITY-001
GATE=G2

CURRENT_CHILD=72
PROGRAMME_PARENT=1
PREDECESSOR_CHILD=29
EVIDENCE_PR=71

REPOSITORY_MUTATION=NONE
GITHUB_MUTATION=NONE
SUBAGENTS_USED=0
G3_SELF_LAUNCH=NO
NATIVE_WORKER_ADMISSION=CLOSED
```

This is the successor implementation contract. It grants no G3 execution, publication, deployment, admission, G4, Ready, or merge authority.

## 0. Verified inputs and precedence

Authenticated local `gh` verified `github.com`, active account `weijunswj`, and repository `Swooshz-com/swooshz-design`.

Verified inputs:

- G1-to-G2 manifest #72:5923994288 — bound.
- Part 1 G1 terminal packet #72:5923965370 — 12,690 UTF-8 bytes; SHA-256 `733a34ff248ff5a671f09221537edd47cb5fe72eaff81ddee17a253517328d90`.
- Part 2 controlling authority #72:5923984981 — 12,599 UTF-8 bytes; SHA-256 `9afd6ea5093cb6e3010b1b8637b7e98f835ac35acd8913db4cdd3c7e7bb8b895`.
- Reassembly `part1 + LF + LF + part2` — 25,291 bytes; SHA-256 `cd6546d230f7b699f61783a576addf5741d95697f10eaf27ed64cbdff216f6df`.
- Complete Run-130 manifest #29:5909646454 — all three part lengths/hashes verified; reassembly 52,255 bytes; SHA-256 `178074bbbfedcabf8e30c4f16688f30f64953139eefd1fd890d5847fbe5adbec`.
- Predecessor challenge #29:5923554662 — bound.
- Predecessor adjudication #29:5923558953 — bound.
- Parent receipt #1:5923999595 — bound.
- Clean base `ff6a9bada283d36b92637a810a7e9d691b92193e`.
- Clean-base tree `cd7ad2ad1e494a733468ecbb883be1afda644c49`.
- PR #71 open/draft at `c440ff2723176f3364fae4d8ec916fd0f0e810e4`.
- PR #71 tree `88f9bd8c40ca1bd778ceb3b6023310331c48343d`.

Normative precedence: controlling G1 architecture, this successor contract, then the incorporated Run-130 contract. Run-130’s exact acceptance body, clock witness, v2 attempt, retry evidence, native wire semantics, and A/B/C rules remain normative. Its old 16-path ceiling and distributed proof-reader placement are superseded.

The inspected PR #71 head still contains v1 attempts. Its code is not an implementation of Run-130 acceptance capabilities or historical-key verification.

## 1. Sole proof module and private authority

### 1.1 Ownership

`src/lib/s8-native-proof.ts` owns:

- S8 graph, acceptance, retry, checkpoint, receipt, and object validation.
- Lifecycle derivation.
- Checkpoint construction and fixed-domain signing.
- Repository-issued proof projections.
- S8 transition validation against the durable baseline.
- Migration selection and quarantine validation.

`src/lib/s8-fbx-persistence.ts` retains structural adapters and constants but delegates every proof-dependent decision to this module. It must not retain a second success validator.

### 1.2 Factory and runtime boundary

The sole factory is:

```ts
createS8NativeProofAuthority(
  binding: S8RepositoryProofBinding
): S8RepositoryProofAuthority
```

`S8RepositoryProofBinding` is an opaque object registered in a module-private `WeakMap` in `store.ts`. Only the private `JsonRepository` bootstrap path registers it. A public runtime predicate may test registration; no exported function registers caller objects.

The binding’s private record contains exactly:

```ts
{
  repositoryIdentity: object;
  canonicalRoot: string;
  objectRoot: string;
  trust: S8ImmutableApplicationTrust;
  readObjectExact: S8LockedObjectReader;
  readSourceView: S8LockedSourceReader;
  assertLiveLease: (lease: S8RepositoryLease) => void;
}
```

These are bootstrap dependencies, not user-supplied factory options:

- `objectRoot` is the repository’s resolved `objects` directory.
- Trust comes from validated production runtime configuration.
- Reader implementations are fixed application code.
- The lease is privately registered by the owning repository.
- Production service options cannot replace trust, clocks used for acceptance, proof readers, object roots, issuers, or source readers.

The factory rejects an unregistered binding or a second authority for the same binding.

The returned authority is retained in an ECMAScript-private repository field. It is never returned by a public repository method.

### 1.3 Internal authority surface

The authority provides these repository-only operations:

```ts
validateLocked(lease, graph, baseline): ValidatedS8Graph
projectLocked(lease, validatedGraph, projectId, artifactId): S8ProofProjection
applyLocked(lease, baseline, workingGraph, command): S8CommandResult
migrateLocked(lease, decodedLegacyGraph): S8MigrationResult
```

`ValidatedS8Graph`, leases, commands that carry native acceptance events, and migration results have private runtime provenance. None can be supplied through serialized state.

`validateLocked` verifies both:

1. The complete candidate graph and its evidence.
2. The permitted transition from the durable baseline.

Thus removing an entire history and resetting a record to `queued` cannot evade proof validation.

### 1.4 Immutable trust

Trust contains:

- Current application signing key ID.
- Current Ed25519 signing `KeyObject`.
- Current and historical Ed25519 verification keys.
- Normalized SPKI DER identities.
- Fixed acceptance, retry, and checkpoint domains.
- Fixed native/profile/resource-policy versions.
- A process bootstrap identity.

The configuration object and key lookup table are copied and frozen at bootstrap. No mutable caller map or PEM object is retained.

Use Run-130’s exact `S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON` schema and validation. Extend its dependency inventory to checkpoint records and quarantined v2 acceptance/retry records.

Reject:

- Duplicate key IDs.
- One normalized public key under multiple IDs.
- Current public/private mismatch.
- Private PEM material in the public keyset.
- Unknown historical keys required by retained evidence.

Rotation requires a new process bootstrap. Historical signatures remain bound to their original key IDs. Never resign historical evidence during rotation.

### 1.5 Synchronous boundary

The current `PrivateObjectStore` is synchronous. The successor proof path remains synchronous.

All authoritative object reads occur while holding the repository mutex. There is no `await`, Promise-returning reader, network lookup, or async callback inside proof validation or checkpoint issuance.

Native HTTPS work occurs outside the repository mutex. Its result is accepted later in a synchronous locked transaction.

A reader or transaction callback returning a thenable is rejected. This closes the async-read boundary without adding a second lock protocol.

### 1.6 Projection provenance and lifetime

A projection is a frozen object whose methods validate `this` against a module-private:

```ts
WeakMap<object, {
  repositoryIdentity: object;
  canonicalStateSha256: Sha256;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  lifecycle: S8DerivedLifecycle;
  sourceDisposition: "CURRENT" | "STALE" | "NOT_READY";
  evidence: PrivateVerifiedEvidence;
}>
```

Rules:

- No exported projection constructor.
- No structural “is projection” test.
- Borrowed methods reject an unregistered receiver.
- JSON serialization, object spread, `structuredClone`, and type assertions do not preserve authority.
- Public JSON snapshots are not registered as projections.
- A projection is reusable for reading its immutable snapshot.
- It is never accepted as input to a subsequent mutation or freshness check.
- Consequential operations reacquire the repository lock and derive a fresh projection.

Plain objects and arrays are deeply frozen. Private byte buffers remain private; methods return fresh copies. Do not attempt to freeze nonempty Node buffers and call that byte immutability.

### 1.7 Data allowed to leave

Public DTOs contain only existing public artifact/job fields derived by the module. They contain no private keys, signatures, native request nonces, release handles, object paths, or raw proof graph.

Internal operation accessors may return:

- Bound IDs and digests.
- Exact object manifests.
- Fresh copies of accepted/stored bytes.
- The original release handle to the native Validator transport.

These values are data. They cannot issue acceptance, checkpoints, retry entitlement, or status authority.

Verified native-result capabilities remain **single-use**. Snapshot projections are **reusable read capabilities**. Neither is reconstructible from DTOs.

## 2. Exact persisted successor schema

### 2.1 Common rules

Use Run-130’s exact rules for `Uuid`, `Sha256`, `KeyId`, `Nonce`, `Signature`, `UnixMs`, `Ns`, and canonical timestamps.

Additionally:

```ts
type Sequence = number; // safe integer, 1..2147483647
type ProcessId = number; // integer, 1..2147483647
type OwnerId = string; // 1..240 Unicode code points; no control characters
type Attempt = 1 | 2;
```

All listed properties are required. Nullable means explicit `null`. Unknown and duplicate JSON keys are invalid. Signed objects use UTF-8 JCS without BOM or trailing newline.

### 2.2 StoreState fields

The successor requires:

```ts
s8NativeEvidenceVersion: 3;
s8NativeProofSchemaVersion: "s8-native-proof-v1";

s8ExportJobs: S8ExportJobV3[];
s8Artifacts: S8ArtifactV3[];
s8ValidationReceipts: S8ValidationReceiptV3[];
s8ValidationReceiptBytes: S8ValidationReceiptBytesV1[];
s8IdempotencyRecords: S8IdempotencyRecordV2[];

s8NativeOperationAttempts: NativeAttemptV2[];
s8NativeProofCheckpoints: S8Checkpoint[];
s8NativeTerminalOutcomes: S8TerminalOutcome[];
s8NativeAttemptQuarantines: S8QuarantineV2[];
```

No array is optional in a version-3 canonical state.

`NativeAttemptV2`, acceptance receipts, retry evidence, and their exact nested schemas are incorporated unchanged from Run-130 §§6, 9, and 10.

### 2.3 Job and artifact changes

`S8ExportJobV3` retains every field of the pinned `S8ExportJob` with these exact changes:

```ts
schemaVersion: "s8-export-job-v3";
nativeClaimToken: Uuid | null;
headCheckpointSha256: Sha256 | null;
terminalOutcomeId: Uuid | null;
quarantineId: Uuid | null;
retryDecisionId: Uuid | null;
```

Its complete key set is:

```text
schemaVersion jobId projectId artifactId source inputHash idempotencyKey
status publicationPhase attempt claimToken nativeClaimToken ownerId
ownerProcessId claimedAt heartbeatAt createdAt updatedAt terminalAt
failureCode headCheckpointSha256 terminalOutcomeId quarantineId retryDecisionId
```

`S8ArtifactV3` retains every pinned artifact field with these changes:

```ts
schemaVersion: "s8-artifact-v3";
privateStagingPrefix: string | null;
privateFinalPrefix: string | null;
headCheckpointSha256: Sha256 | null;
terminalOutcomeId: Uuid | null;
quarantineId: Uuid | null;
```

Its complete key set is:

```text
schemaVersion artifactId projectId jobId source inputHash profile format
mimeType downloadFileName status publicationPhase payloadSha256 objectHashes
writerReceiptHash nativeReadbackHash semanticReceiptHash publicationReceiptHash
validationReceiptId validationReceiptHash immutableReuseFingerprint
privateStagingPrefix privateFinalPrefix attempt retryOfArtifactId failureCode
createdAt updatedAt committedAt staleAt headCheckpointSha256 terminalOutcomeId
quarantineId
```

Pinned literal profile, format, MIME, filename, source-stamp shape, and `retryOfArtifactId: null` remain unchanged.

`nativeClaimToken` identifies the original native pair’s claim. `claimToken` identifies the current publication owner. Recovery may change only the latter.

### 2.4 Object references

```ts
type S8ObjectRef = {
  name:
    | "artifact.fbx"
    | "writer-receipt.json"
    | "native-readback.json"
    | "semantic-validation-receipt.json"
    | "publication-receipt.json";
  contentType: "application/octet-stream" | "application/json";
  key: string;
  sha256: Sha256;
  byteSize: number;
};
```

`artifact.fbx` uses `application/octet-stream` and 28..134217728 bytes.

The Writer receipt uses `application/json` and 1..1048576 bytes.

Each remaining JSON object uses `application/json` and 1..8388608 bytes.

Keys must equal the formulas in §6. Arbitrary paths, traversal, alternate separators, symlinks, and nonregular files are rejected.

Manifests are ordered tuples, not unordered maps:

```ts
type StagedManifest = [ArtifactRef, WriterReceiptRef];
type ValidatedManifest = [
  ArtifactRef, WriterReceiptRef, NativeReadbackRef, SemanticReceiptRef
];
type FinalManifest = [
  ArtifactRef, WriterReceiptRef, NativeReadbackRef,
  SemanticReceiptRef, PublicationReceiptRef
];
```

### 2.5 Checkpoint envelope and common body

```ts
type S8Checkpoint = {
  body: S8CheckpointBody;
  signature: Signature;
  checkpointSha256: Sha256;
};

type CheckpointCommon = {
  schemaVersion: "s8-native-proof-checkpoint-v1";
  kind: "STAGED" | "VALIDATED" | "PROMOTED" | "COMMITTED";
  checkpointId: Uuid;
  keyId: KeyId;
  sequence: Sequence;
  previousCheckpointSha256: Sha256 | null;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  nativeClaimToken: Uuid;
  source: S8SourceStamp;
  acceptedSourceDigest: Sha256;
  payloadSha256: Sha256;
  writerAttemptId: Uuid;
  writerAcceptanceSha256: Sha256;
  releaseManifestSha256: Sha256;
  resourcePolicySha256: Sha256;
  issuedAt: Timestamp;
};
```

`acceptedSourceDigest = SHA256(UTF8(JCS(source)))`.

The Writer attempt and acceptance bind the remaining native configuration, request, response, runner, image, deadline, input, output, auxiliary, and release-handle values.

Each kind adds exactly the following fields.

**STAGED**

```ts
{
  kind: "STAGED";
  sequence: 1;
  previousCheckpointSha256: null;
  stagedObjects: StagedManifest;
}
```

**VALIDATED**

```ts
{
  kind: "VALIDATED";
  sequence: 2;
  previousCheckpointSha256: Sha256; // STAGED
  stagedCheckpointSha256: Sha256;
  validatorAttemptId: Uuid;
  validatorAcceptanceSha256: Sha256;
  validationReceiptId: Uuid;
  validationReceiptHash: Sha256;
  validationReceiptObjectSha256: Sha256;
  validationReceiptObjectBytes: number; // 1..8388608
  validatedObjects: ValidatedManifest;
  semanticReceiptSha256: Sha256;
  semanticOutcome: "pass";
}
```

**PROMOTED**

```ts
{
  kind: "PROMOTED";
  validatedCheckpointSha256: Sha256;
  validatorAttemptId: Uuid;
  validatorAcceptanceSha256: Sha256;
  validationReceiptId: Uuid;
  validationReceiptHash: Sha256;
  publicationClaim: PublicationClaim;
  sourceFence: SourceFence;
  publicationReceiptSha256: Sha256;
  publicationReceiptBytes: number; // 1..8388608
  finalObjects: FinalManifest;
  readbackManifest: ReadbackManifest;
  readbackManifestSha256: Sha256;
}
```

**COMMITTED**

```ts
{
  kind: "COMMITTED";
  promotionCheckpointSha256: Sha256;
  validatedCheckpointSha256: Sha256;
  validatorAttemptId: Uuid;
  validatorAcceptanceSha256: Sha256;
  validationReceiptId: Uuid;
  validationReceiptHash: Sha256;
  publicationClaim: PublicationClaim;
  sourceFence: SourceFence;
  finalObjects: FinalManifest;
  publicationReceiptSha256: Sha256;
  readbackManifestSha256: Sha256;
  committedAt: Timestamp;
}
```

Supporting exact shapes:

```ts
type PublicationClaim = {
  claimToken: Uuid;
  ownerId: OwnerId;
  ownerProcessId: ProcessId;
  claimedAt: Timestamp;
};

type SourceFence = {
  source: S8SourceStamp;
  checkedAt: Timestamp;
};

type ReadbackManifest = {
  schemaVersion: "s8-native-final-readback-v1";
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  publicationClaimToken: Uuid;
  validatedCheckpointSha256: Sha256;
  checkedAt: Timestamp;
  objects: FinalManifest;
};
```

Every repeated field must equal its referenced proof. Redundancy is checked, not trusted.

### 2.6 Terminal outcome

```ts
type S8TerminalOutcome = {
  schemaVersion: "s8-native-terminal-outcome-v1";
  outcomeId: Uuid;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  kind: "FAILED_TERMINAL" | "STALE" | "ABORTED";
  reason:
    | "NATIVE_PERMANENT_FAILURE"
    | "NATIVE_TIMEOUT"
    | "NATIVE_CLOCK_INVALID"
    | "SOURCE_STALE"
    | "SOURCE_NOT_READY"
    | "SEMANTIC_FAILED"
    | "ACCEPTED_BYTES_UNAVAILABLE"
    | "PUBLICATION_FAILED"
    | "RECONCILIATION_REQUIRED"
    | "LEGACY_PROOF_UNPROVEN"
    | "ABORTED_BEFORE_DISPATCH";
  nativeAttemptId: Uuid | null;
  headCheckpointSha256: Sha256 | null;
  quarantineId: Uuid | null;
  recordedAt: Timestamp;
};
```

An outcome can only reduce available operations. It grants no native success, retry, publication, or download authority.

A terminal outcome cannot hide invalid retained successor proofs: those proofs are still validated.

## 3. Checkpoint signatures, chain, and replay

The exact domain bytes are:

```text
STAGED:    ASCII("S8-NATIVE-PROOF-STAGED-V1")    || 0x00
VALIDATED: ASCII("S8-NATIVE-PROOF-VALIDATED-V1") || 0x00
PROMOTED:  ASCII("S8-NATIVE-PROOF-PROMOTED-V1")  || 0x00
COMMITTED: ASCII("S8-NATIVE-PROOF-COMMITTED-V1") || 0x00
```

For each kind:

```text
bodyBytes = UTF8(JCS(body))
signatureBytes = Ed25519.sign(currentApplicationKey, domain || bodyBytes)
signature = canonical unpadded base64url(signatureBytes)

checkpointSha256 =
  lowercase_hex(SHA256(UTF8(JCS({body, signature}))))
```

The signature is exactly 64 decoded bytes and 86 base64url characters. Decode/re-encode equality is mandatory. `checkpointSha256` is excluded from its own hash.

Historical verification performs exact `body.keyId` lookup in the immutable application key history. There is no “try every key” fallback and no caller-selected domain.

### Chain rules

One chain exists for each `(projectId, jobId, artifactId, attempt)`:

```text
STAGED -> VALIDATED -> PROMOTED [-> PROMOTED ...] -> COMMITTED
```

- Sequence starts at 1 and increases by exactly 1.
- Every predecessor digest names the immediately preceding checkpoint.
- The first promotion follows `VALIDATED`.
- A replacement promotion follows the latest `PROMOTED`, references the same `VALIDATED`, and has a new publication claim.
- `COMMITTED` follows the latest promotion.
- No checkpoint follows `COMMITTED`.
- At most one `STAGED`, one `VALIDATED`, and one `COMMITTED` exist per chain.
- Attempt 2 has its own chain; attempt-1 evidence remains retained and validated.

A repeated promotion is allowed only through claim-fenced recovery after the prior owner is conclusively dead. It is not an alternate success path.

Checkpoint IDs are canonical lowercase UUIDv4 values and globally unique across retained active and quarantine history. The same applies to attempt, acceptance, retry-decision, and receipt identities within their identity classes.

Rereading the same stored record is allowed. A second record with the same ID, copied envelope, or replayed acceptance is rejected even when byte-identical.

The active head is computed from the validated chain. Stored head pointers must equal it. A caller cannot select an earlier checkpoint by changing a pointer.

## 4. Total lifecycle derivation

Derivation first validates schemas, graph ownership, signatures, hashes, byte custody, uniqueness, and chain structure. Corruption produces an error; it is not converted into a weaker lifecycle.

Then derive the current attempt using this table:

- `queued`: pristine attempt 1, or durably authorized attempt 2; no current-attempt native attempt or checkpoint; no claim. Persisted job/artifact status `queued`; phase `source_admission`.
- `running`: complete current owner claim; no checkpoint; zero or valid current-attempt Writer progress. Status `running`; phase `claim`.
- `staged`: durable Writer B, exact two staged objects, valid STAGED; no stronger checkpoint. Status `staged`; phase `private_staging`.
- `validated`: matching durable Writer/Validator B pair, exact four objects, semantic pass, exact receipt, valid VALIDATED. Status `validated`; phase `independent_validation`.
- `promoted`: valid pair and validation; five final objects; exact readback; durable signed PROMOTED. Status `promoted`; phase `verified_readback`.
- `committed`: valid COMMITTED chain and all bound final evidence. Status `committed`; phase `commit`.
- `failed_retryable`: valid durable attempt-1 transient retry evidence; proven disposal; no attempt-2 schedule yet. Status `failed_retryable`; phase last completed checkpoint phase or `claim`.
- `failed_terminal`: valid terminal outcome; no quarantine or unresolved-disposal override. Status `failed_terminal`; phase last completed checkpoint phase, otherwise `claim` or `source_admission`.
- `stale`: valid STALE terminal outcome. Status `stale`; phase last completed checkpoint phase, otherwise `claim` or `source_admission`.
- `aborted`: ABORTED_BEFORE_DISPATCH; no prepared request or acceptance. Status `aborted`; phase `source_admission`.
- `quarantined`: exact quarantine record and terminal shells. Status `failed_terminal`; phase `source_admission`.
- `reconciliation_required`: UNKNOWN, orphaned prepared dispatch, or quarantine admission block. Status `failed_terminal` after recovery transition; phase last completed proof phase or `claim`; quarantine uses `source_admission`.

Additional rules:

1. **No descriptive lag or lead is permitted in a canonical checkpoint state.** Checkpoint insertion, pointers, statuses, hashes, and phase are persisted together.
2. Writer B may exist while lifecycle remains `running`; B alone is not a staging checkpoint.
3. Validator B may exist while lifecycle remains `staged`; B alone is not semantic validation.
4. Partial final-object creation leaves lifecycle `validated`.
5. `source_claim_recheck` and `immutable_promotion` are operation events, not persisted successor phases.
6. A prepared dispatch owned by the live initiating operation remains in its existing lifecycle and blocks duplicate dispatch. At startup or confirmed owner death, unresolved prepared dispatch is durably changed to Run-130 UNKNOWN with the reconciliation outcome.
7. Native attempts, checkpoints, and receipts from attempt 1 cannot satisfy attempt 2.
8. Failure or quarantine disables all continuation accessors, even when historical checkpoints remain valid.
9. Invalid proof cannot be hidden by setting a failed status.
10. A status, phase, head pointer, receipt pointer, or public hash that disagrees with derivation produces `S8_PROOF_STATUS_MISMATCH`; authoritative repository exposure fails.

### Source staleness

Historical publication lifecycle and **current-source disposition** are separate facts.

A valid historical `COMMITTED` checkpoint remains committed evidence after S6/S7 changes. Its projection has `sourceDisposition="STALE"` or `"NOT_READY"`. Reuse and download reject it.

This avoids making unrelated S5–S7 transactions depend on rewriting every historical S8 record. An explicit stale terminal transition may subsequently set descriptive `stale`; it cannot restore availability.

**Continues in Part 2.**


## G2 terminal contract — proof-derived native authority — Part 2 of 4

Continuation of Part 1: #72:5924369770

## 5. Validation receipt and exact bytes

### 5.1 Exact receipt

`S8ValidationReceiptV3` has exactly:

```ts
{
  schemaVersion: "s8-validation-receipt-v3";
  receiptId: Uuid;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  nativeClaimToken: Uuid;
  source: S8SourceStamp;
  acceptedSourceDigest: Sha256;
  payloadSha256: Sha256;

  writerAttemptId: Uuid;
  writerAcceptanceSha256: Sha256;
  validatorAttemptId: Uuid;
  validatorAcceptanceSha256: Sha256;
  stagedCheckpointSha256: Sha256;

  releaseManifestSha256: Sha256;
  resourcePolicySha256: Sha256;
  artifactSha256: Sha256;
  artifactByteSize: number; // 28..134217728
  writerReceiptHash: Sha256;
  writerReceiptBytes: number; // 1..1048576
  nativeReadbackHash: Sha256;
  nativeReadbackBytes: number; // 1..8388608
  semanticReceiptHash: Sha256;
  semanticReceiptBytes: number; // 1..8388608

  nativeOutcome: "pass";
  semanticOutcome: "pass";
  fingerprintVersion: "s8-immutable-reuse-fingerprint-v3";
  immutableReuseFingerprint: Sha256;
  resourceLimitsHash: Sha256;
  checkedAt: Timestamp;
  receiptHash: Sha256;
}
```

```text
receiptHash = SHA256(UTF8(JCS(receipt with only receiptHash removed)))
receiptBytes = UTF8(JCS(complete receipt))
```

The hash exclusion removes exactly one top-level field. No nested field is excluded.

The matching byte record is:

```ts
{
  schemaVersion: "s8-validation-receipt-bytes-v1";
  receiptId: Uuid;
  canonicalBase64url: string;
  byteSize: number; // 1..8388608
  sha256: Sha256;
}
```

Its base64url is canonical, unpadded, and decodes to the original application-generated canonical receipt bytes. On read:

- Recompute raw byte length and SHA-256.
- Strictly decode the JSON.
- Require canonical-byte equality.
- Require exact equality with the receipt collection entry.
- Recompute `receiptHash`.
- Verify the `VALIDATED` checkpoint binds both `receiptHash` and the complete receipt-byte SHA-256.

The receipt is retained inside canonical state, not added as a sixth final object.

### 5.2 Pair relationships

Writer and Validator must match on:

```text
projectId jobId artifactId attempt native claim source digest
profile native protocol config digest release manifest resource policy release handle
```

Validator input hash and length equal Writer output hash and length.

Writer auxiliary hash/length equal the original Writer receipt bytes. Validator output hash/length equal the original native-readback bytes.

The receipt’s `payloadSha256` equals Writer input SHA-256.

### 5.3 Semantic receipt

Exact wrapper:

```ts
{
  schemaVersion: "s8-semantic-validation-receipt-v3";
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  source: S8SourceStamp;
  writerAttemptId: Uuid;
  writerAcceptanceSha256: Sha256;
  validatorAttemptId: Uuid;
  validatorAcceptanceSha256: Sha256;
  nativeReadbackSha256: Sha256;
  outcome: "pass";
  result: S8SemanticResult;
}
```

`result` is the exact output of the preserved `compareS8UfbxReadback` implementation on the authoritative source view and the accepted Validator bytes. No injected semantic adapter is accepted in production.

At issuance, the module recomputes the semantic result and canonical bytes. Later reads verify their exact bytes, bindings, and signed checkpoint.

### 5.4 Reuse fingerprint

```text
immutableReuseFingerprint =
  SHA256(UTF8(JCS({
    fingerprintVersion: "s8-immutable-reuse-fingerprint-v3",
    source,
    payloadSha256,
    writerAcceptanceSha256,
    validatorAcceptanceSha256,
    releaseManifestSha256,
    resourcePolicySha256,
    resourceLimitsHash,
    artifactSha256,
    artifactByteSize,
    writerReceiptHash,
    writerReceiptBytes,
    nativeReadbackHash,
    nativeReadbackBytes,
    semanticReceiptHash,
    semanticReceiptBytes
  })))
```

It excludes current publication claim and storage location. It does not independently authorize reuse.

**Bypass closure:** a stale hash fails receipt recomputation. Updating an unsigned hash still fails the signed `VALIDATED` binding. Updating object metadata still fails exact-byte readback and the checkpoint chain.

## 6. Promotion and readback

### 6.1 Keys

Let `P/J/A/N/C` denote project ID, job ID, artifact ID, native attempt number, and publication claim token.

Original native staging:

```text
private/projects/P/s8/staging/A/nativeClaimToken/<object-name>
```

It contains the first four object names as they become proven.

Publication-receipt staging:

```text
private/projects/P/s8/publication-staging/J/A/N/C/publication-receipt.json
```

Final prefix:

```text
private/projects/P/s8/committed/sourceRevisionHash/artifactSha256/A/N/C
```

Final keys append the five exact names in §2.4.

Including artifact, attempt, and publication claim prevents different publication receipts from colliding when FBX bytes are identical.

### 6.2 Publication receipt

Exact canonical object:

```ts
{
  schemaVersion: "s8-publication-receipt-v3";
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: Attempt;
  nativeClaimToken: Uuid;
  publicationClaim: PublicationClaim;
  source: S8SourceStamp;
  validatedCheckpointSha256: Sha256;
  writerAcceptanceSha256: Sha256;
  validatorAcceptanceSha256: Sha256;
  validationReceiptId: Uuid;
  validationReceiptHash: Sha256;
  immutableReuseFingerprint: Sha256;
  finalPrefix: string;
  objects: ValidatedManifest; // first four entries, using their final keys
  createdAt: Timestamp;
  complete: true;
}
```

It does not include its own hash, length, or readback manifest. This avoids circular hashing.

`complete: true` means the receipt describes a complete intended publication. It is not a readback assertion and cannot derive `promoted`.

### 6.3 Ordering

Promotion is one synchronous, locked repository operation:

1. Load, stabilize, and validate durable baseline.
2. Require fresh `validated` proof, or valid recovery authorization from §9.
3. Check authoritative current source.
4. Check current publication claim and owner.
5. Construct publication receipt internally.
6. Durably write its staging object.
7. Promote/copy all five objects to their exact final keys.
8. Fsync final objects and containing directories.
9. Read all five final objects back through the fixed reader.
10. Compare each raw hash, length, name, content type, and key.
11. Recheck source and claim.
12. Construct the exact readback manifest.
13. Sign `PROMOTED`.
14. In one canonical transaction insert the checkpoint and update head pointers, public hashes, final prefix, statuses, and phase.
15. Complete candidate fsync, rename, and directory fsync.
16. Only then issue the promoted projection.

For S8, promotion preserves the original proof-dependent staging objects. Do not use the current source-removing promotion behavior.

Exact existing final bytes may be reused only after equality verification and fsync. A differing existing final object is an error; it is never overwritten.

Partial object operations create no checkpoint authority. Unindexed objects do not fill missing graph edges.

## 7. Commit and crash behavior

Commit is a new locked transaction, requiring fresh `promoted` proof.

### Current-source check

Using the same working graph and fixed read-only source reader, require:

- Current S5 source fingerprint remains the bound fingerprint.
- S6 is the current accepted model, source-current and not stale.
- S6 revision ID/hash, validation receipt ID/hash, and canonical handoff digest equal the full bound source stamp.
- The selected current committed S7 export is the same artifact.
- S7 artifact hash, readback hash, manifest ID/hash, and S6 source relationship match.
- S7 required objects/readback remain valid.

Selection preserves the existing S6/S7 rules. Equal S7 commit timestamps retain canonical collection order, matching the existing stable sort.

### Claim and commit transaction

Require current claim token, owner ID, process ID, and claim timestamp to equal the latest promotion’s publication claim.

Within the same transaction:

- Read and reverify the five final objects.
- Bind the latest promotion digest and final manifest.
- Generate `committedAt`.
- Set `sourceFence.checkedAt = committedAt`.
- Set checkpoint `issuedAt = committedAt`.
- Sign `COMMITTED`.
- Append the checkpoint.
- Update both head pointers.
- Set job/artifact status to `committed` and phase to `commit`.
- Set artifact `committedAt`, job `terminalAt`, and both `updatedAt` to that timestamp.
- Clear active owner/claim/heartbeat fields.
- Preserve `nativeClaimToken` and original native evidence.

Checkpoint timestamps use validated wall time clamped no earlier than the preceding checkpoint’s timestamp. They are not native acceptance clocks.

### Durability and recovery

- Before candidate creation: old canonical state controls.
- During candidate write: temporary file grants no authority.
- After candidate fsync, before rename: old canonical state controls.
- After rename, before directory fsync: no return of new authority; instance is poisoned on reported failure.
- After directory fsync: new canonical state may be returned.
- Process death with old canonical surviving: validate and stabilize old canonical.
- Process death with complete new canonical surviving: validate proofs and objects; fsync canonical file and directory before exposure.
- Malformed canonical: `PERSISTENCE_FAILED`; no empty-state fallback.
- Stray candidate: never promoted during recovery.

No persistent “fsync acknowledged” flag is introduced.

B or C completing after the original native deadline does not invalidate timely A. There is no post-A native deadline commit fence.

## 8. JsonRepository integration

### 8.1 Public APIs

```ts
state(): DeepReadonly<StoreState>;
snapshot(): DeepReadonly<StoreState>;
transact<T>(mutation: (working: StoreState) => T): Detached<T>;

readS8(projectId: Uuid, artifactId: Uuid): S8ProofProjection;
```

`state()` and `snapshot()` have identical authoritative-read semantics.

S8 mutations use repository-owned commands. The service supplies selectors and its privately registered owner/session handle, never checkpoint bodies, receipt hashes, status values, or trust options.

Required command operations are:

```text
createQueued
claimQueued
beginNativeAttempt
prepareNativeAttempt
persistNativeAcceptance
persistNativeFailure
stageAcceptedWriter
validateAcceptedPair
promoteValidated
commitPromoted
recordTerminalFailure
scheduleRetry
reclaimPublication
reconcilePreparedAttempt
```

Each operation has a fixed transition described in this contract or incorporated Run-130. There is no generic `setStatus`, `markVerified`, or `signCheckpoint` service API.

Generic `transact()` cannot alter S8 collections. Internally, S8 commands use the same transaction engine with a private command capability. Attempting S8 changes through generic mutation fails before persistence.

### 8.2 Bootstrap

```text
read runtime configuration
-> validate immutable application key history
-> construct repository/object binding
-> acquire OS mutex
-> read canonical file through one regular-file descriptor
-> strict decode
-> recognize version and migrate if required
-> validate S2-S7 graph
-> derive read-only source views
-> validate S8 graph, signatures, receipts and exact object bytes
-> persist migration if needed
-> fsync canonical file and directory
-> install frozen durable baseline
-> release mutex
-> expose repository readiness
-> construct workflow services
-> perform existing recovery
-> evaluate admission prerequisites
```

No service recovery runs before repository readiness.

A supplied repository must carry matching private bootstrap identity and root/trust binding. Structural dependency injection is insufficient.

### 8.3 Source-reader extraction

To avoid recursive transactions, add these pure read functions by extracting existing logic:

```ts
readS5ToS6Projection(state, objects, projectId): S5ToS6Projection
readS6ToS7Handoff(state, objects, projectId): S6ToS7Handoff
readS7ToS8Handoff(state, objects, projectId): S7ToS8Handoff
```

Ownership:

- `s5.ts`: extract `getS6ReadOnlyProjection`’s existing body.
- `s6.ts`: extract `getS7Handoff`’s selection and `buildS6ToS7Handoff` path.
- `s7-cad.ts`: extract current handoff selection and exact download/readback checks.

These functions do not construct workflow services, recover jobs, reconcile statuses, transact, or call `repository.state()`.

Existing service methods delegate to them while preserving their existing reconciliation behavior outside the pure functions.

Only the proof authority’s fixed source reader may use their output as an authoritative S8 input. Caller-supplied handoffs do not qualify.

### 8.4 Transaction sequence

1. Acquire mutex.
2. Load, validate, and stabilize canonical state.
3. Keep a private deeply frozen durable baseline.
4. Make a separate mutable working graph.
5. Invoke one synchronous mutation.
6. Reject thenables and nested mutation transactions.
7. Freeze the working graph after callback exit, including exceptional exits.
8. Strictly validate the complete candidate and baseline-to-candidate transition.
9. Read required candidate objects synchronously under the same mutex.
10. Persist candidate through write/fsync/rename/directory-fsync.
11. Install a detached frozen baseline.
12. Return detached result data.
13. Release mutex.

A synchronous reentrant `state()` call returns a detached frozen copy of the durable baseline. It never returns the working graph or reacquires the mutex.

Private source validation receives the explicit working graph; it does not use that public reentrant accessor.

Failed canonical stabilization or uncertain replacement poisons the instance. A new instance must repeat locked validation and stabilization. Poison cannot be cleared by an ordinary method call.

## 9. Consumer interface

Projection accessors are:

```text
publicArtifact()
publicJob()
writerContinuation()
validatorInput()
publicationInput()
commitInput()
recoveryInput()
idempotencyResult()
retryInput()
reuseInput()
download()
```

Each checks private provenance before reading its record. None accepts another projection, raw status, receipt, or graph.

Consumer requirements:

- `getExport`: fresh projection; `publicArtifact()` returns validated public DTO. Native progress comes only from derived lifecycle.
- API status: calls service `getExport`; no independent status path.
- Writer continuation: durable Writer B plus privately retained accepted FBX/auxiliary bytes; returns fresh copies and acceptance bindings.
- Validator admission: `staged`, current source/claim, exact staged FBX; returns FBX bytes, Writer acceptance ID/digest, original release handle and release manifest.
- Publication: `validated`; returns four exact proven objects, receipt identity/hash and validated checkpoint digest.
- Commit: `promoted`; returns latest promotion digest, publication claim and exact five-object manifest.
- Recovery: valid existing proofs; returns a fixed action classification and needed copied bytes/manifests.
- Idempotency replay: fresh linked projection and original request/source identity; no cached result JSON.
- Retry: valid Run-130 durable retry evidence, attempt 1, disposal proven, companion proof valid, current source/claim.
- Reuse: fresh `committed`, `CURRENT` source, all five objects verified; returns derived public DTO/fingerprint.
- Download: fresh `committed`, `CURRENT` source; returns copied and rehashed final FBX bytes, fixed MIME and filename.

A structurally valid projection lacking an operation’s prerequisites throws:

```text
S8_PROOF_REQUIRED
```

Malformed persisted evidence instead raises its integrity error from §13.

### Recovery actions

`recoveryInput()` returns exactly one of:

```text
NO_ACTION
RESET_PRISTINE_CLAIM
RECONCILE_PREPARED
TERMINATE_ACCEPTED_BYTES_UNAVAILABLE
RESUME_VALIDATED_PUBLICATION
REPROMOTE_WITH_NEW_CLAIM
RETURN_COMMITTED
```

Rules:

- Reset only a dead claim with no native-attempt, checkpoint, retry, or quarantine history.
- Never redispatch a prepared or accepted operation.
- Lost volatile accepted bytes without a sufficient durable object checkpoint yield terminal failure, not reconstructed success.
- A valid `VALIDATED` chain can publish under a new claim.
- A valid old promotion can be repromoted under a new claim.
- New publication claims never rewrite native acceptance claims.
- Recovery performs new object operations/readback and appends a new promotion checkpoint.
- No temporary “committed-shaped” artifact is constructed for verification.
- UNKNOWN and quarantine blocks remain closed pending existing authenticated reconciliation.

**Continues in Part 3.**


## G2 terminal contract — proof-derived native authority — Part 3 of 4

Continuation:
- Part 1: #72:5924369770
- Part 2: #72:5924380442

## 10. Run-130 A/B integration

The exact Run-130 mechanisms are implemented afresh in the successor.

### A: logical acceptance

Keep the sole ECMAScript-private issuer:

```text
S8ExportService.#acceptVerifiedNativeResult
```

It consumes:

- An authentic unconsumed result capability from the owning native client.
- The original private operation-clock context.
- A live repository transaction context.
- The authoritative current source and claim.

Before A, complete all native framing, signatures, pair/context, runner, resource, disposal, raw-byte, Writer receipt or Validator provenance checks.

The final effective-clock observation and private event creation remain adjacent synchronous operations. Equality with the deadline is timeout.

### B: durable acceptance

After A:

- Sign the immutable event.
- Persist the exact v2 attempt and acceptance receipt.
- Complete real fsync/rename/directory-fsync.
- Only then permit Writer continuation or Validator B consumption.

The native client retains privately copied output and auxiliary bytes in its capability custody. Consuming the capability transfers those copies to private acceptance custody until staging or terminal failure.

A volatile acceptance event cannot grant public progress or replacement dispatch.

### Original deadlines and clocks

Preserve:

```text
Writer duration:    510000 ms
Validator duration: 330000 ms
```

The original deadline is created before admission, input hashing, attempt persistence, request construction, or transport. Request constructors require it; they cannot default or recompute it.

Use Run-130’s exact conservative wall/monotonic clock formula, process epoch, witness fields, strict inequalities, overflow checks, and timeout latch.

Production clock injection is prohibited. Tests control clock primitives only in isolated processes.

### Retry and UNKNOWN

Use Run-130’s signed retry evidence and fixed domain unchanged.

A public `S8NativeSignedFailure` is descriptive only. Its constructor grants no retry entitlement.

Scheduling attempt 2:

- Revalidates durable retry evidence under lock.
- Requires proven disposal.
- Preserves attempt-1 records and proof-dependent objects.
- Persists attempt advancement and `retryDecisionId` atomically.
- Clears the current claim.
- Allows no third attempt.

Post-A persistence failure produces no native transient classification, replacement dispatch, or retry. Prepared unresolved canonical attempts become UNKNOWN through recovery.

### PR #71 reuse boundary

Transplant its reviewed wire, gateway, launcher, release, admission/resource-policy code as listed in §11.

Reimplement:

- Private result/clock custody.
- Acceptance and retry issuers.
- Key history.
- v2 attempts.
- Original-deadline enforcement at A.
- Repository authority.
- All lifecycle, receipt, publication, recovery, reuse, and download consumers.

Do not transplant PR #71’s `completeNativeAttempt`, status-based graph authority, pre-readback promotion, receipt-based reuse authority, or recovery status fabrication.

## 11. Clean-base construction and path ceiling

### 11.1 Exact ceiling

```text
BASE=ff6a9bada283d36b92637a810a7e9d691b92193e
PROPOSED_G3_MUTATION_CEILING=83_PATHS
PROPOSED_SUCCESSOR_PR_CHANGED_PATH_CEILING=83_PATHS

REIMPLEMENT_SUCCESSOR=22
TRANSPLANT_EXACT_BLOBS=52
TRANSPLANT_EXACT_DELETIONS=7
NEW_FILE=2

MAX_ADDED_PATHS_RELATIVE_TO_BASE=57
MAX_DELETED_PATHS_RELATIVE_TO_BASE=7
RENAMES=0
```

The 57 additions include native material absent from the clean base. They are not 57 discretionary new files.

All mutation authority remains contingent on separate G3 admission.

### 11.2 REIMPLEMENT_SUCCESSOR: exact paths and ownership

- `src/lib/types.ts` — exact successor schemas and incorporated Run-130 types.
- `src/lib/s8-fbx-persistence.ts` — structural adapters, successor keys; delegate proof authority.
- `src/lib/store.ts` — binding, locked reads, baseline/working separation, transition validation, readback, stabilization.
- `src/lib/workflow.ts` — configuration-before-repository bootstrap and fixed dependency binding.
- `src/lib/s8.ts` — private A issuer and projection/command consumers.
- `src/lib/s8-fbx-config.ts` — immutable runtime configuration and Run-130 key history.
- `src/lib/s8-native-protocol.ts` — preserve pinned wire semantics; require original deadline; strict encoding; no generic acceptance signer.
- `src/lib/s8-native-worker-client.ts` — preserve HTTPS framing; add private capabilities, observations and exact-byte custody.
- `src/lib/s5.ts` — pure source-reader extraction only.
- `src/lib/s6.ts` — pure handoff-reader extraction only.
- `src/lib/s7-cad.ts` — pure handoff/readback extraction only.
- `src/lib/api.ts` — await asynchronous export creation; consume derived results; safe error mapping.
- `tests/g3.test.ts` — shared repository, locking, alias, reentrancy and crash regressions.
- `tests/s8-api.test.ts` — consequential public-boundary positive/negative controls.
- `tests/s8-persistence.test.ts` — schemas, migration, keys and canonical recovery.
- `tests/s8-publication.test.ts` — actual verified native fixtures; publication/recovery/bytes.
- `tests/s8-worker.test.ts` — Run-130 mechanisms and preserved native/CI guardrails.
- `tests/s8-native-admission.test.ts` — UNKNOWN/quarantine/bootstrap blocking.
- `docs/ARCHITECTURE.md` — final authority and durability design.
- `docs/G2_S8_NATIVE_WORKER_CONTRACT.md` — this contract and complete incorporated Run-130 requirements.
- `package.json` — test command membership only; no dependency/version changes.
- `.github/workflows/s8-fbx.yml` — carry pinned CI guards; add successor proof/Linux test execution.

The API change is required because clean-base export handling is synchronous while native operations are asynchronous. No independent API success reconstruction is permitted.

For the workflow, preserve PR #71’s pinned checkout/actions, exact-head checks, actionlint verification, secret-scanner controls, native builds, and admission-closed scope. New edits are limited to successor test membership and mandatory Linux oracle execution.

### 11.3 NEW_FILE

```text
src/lib/s8-native-proof.ts
tests/s8-native-proof.test.ts
```

No other discretionary new file is allowed.

### 11.4 TRANSPLANT_FROM_PR71_EXACT_HEAD

Every blob below comes from:

```text
c440ff2723176f3364fae4d8ec916fd0f0e810e4
```

These files implement native transport, isolation, release/admission/resource policy, deployment reference material, or their tests. They do not derive application artifact lifecycle from persisted S8 status.

```text
native/s8-sandbox-broker/README.md
  92a7e00b9a03fa34767912859273e357f7c63105
native/s8-worker-common/admission.mjs
  06ff6d506d4ef3d0914feee7fe9783c62232105a
native/s8-worker-common/admission.test.mjs
  8cbe8de19a0b6a856229f9019d75a8da31d35a5a
native/s8-worker-common/protocol.mjs
  8fec1694a7484029e881f85c3a6a2d8629c026b3
native/s8-worker-common/protocol.test.mjs
  c5c3a270d4e1a04939b961463f7e5e6aa4b52f6c
native/s8-worker-common/resource-policy.d.mts
  cec90babd491eaf9375a64e38a4398a641c21695
native/s8-worker-common/resource-policy.mjs
  a5288f36d767e0430fec3e56f55ccad041025ece
native/s8-worker-common/worker-entrypoint.mjs
  1c816ddc308aeedef1780cccfc03ae3579c249c2
native/s8-worker-gateway/Dockerfile
  0d0a85c05c28ff4c7f5642ecb5b7f3917b2df0d8
native/s8-worker-gateway/README.md
  c5d62ba1c55972497914db0db4623c05909a0442
native/s8-worker-gateway/compose.yaml
  ef66d10c5662df2ba767d530077ed69059c48284
native/s8-worker-gateway/gateway.mjs
  32d7c0502c6a55a2c693c2921070ba40a10e90d1
native/s8-worker-gateway/gateway.test.mjs
  9439d1cfc31880e1666563dc1de002e033cd2e73
native/s8-worker-images/build-image.sh
  9af9c2f707adff4f565b865bdfbcfd8f15f7b15e
native/s8-worker-images/validator/Dockerfile
  b23685230e85fed27049d287cf683ccd8ca64cba
native/s8-worker-images/writer/Dockerfile
  d80cfa213cacd56d7f26a223558241de4fde33bd
native/s8-worker-launcher/README.md
  ef321172068625fa8f30123fb71891e7d2a38303
native/s8-worker-launcher/capacity.mjs
  e5b8da19b3eb8f3208cecbb183c315d4abf1bee2
native/s8-worker-launcher/capacity.test.mjs
  8edadb96847fe0a90a9406ab053678ae497d4254
native/s8-worker-launcher/config.mjs
  72c461ae66f4e02544457360e2402ce09a1ed378
native/s8-worker-launcher/container-runtime.mjs
  966cea5287ad2a7cb3f365b2ad530c827b2a3770
native/s8-worker-launcher/container-runtime.test.mjs
  29425dc1a961c1e5df4d3ea2b3ef41966d0b5c4d
native/s8-worker-launcher/deploy/swooshz-design-application.slice
  ef0b473a672157191c36ae59dcf3172e4b7804c9
native/s8-worker-launcher/deploy/swooshz-design-gateway.slice
  3b906cb770aa246be33d04c93ff59afe52514cb6
native/s8-worker-launcher/deploy/swooshz-design-launcher.slice
  354feaecf083dec4592a2cf47c0d501dc65b57db
native/s8-worker-launcher/deploy/swooshz-design-rootless-docker.slice
  c1fa0639e282959e3d9a38c70009a1e802ee73d5
native/s8-worker-launcher/deploy/swooshz-design-systemd.slice
  daedbb71bd73c544aba743803862cfb1d4823024
native/s8-worker-launcher/deploy/swooshz-design.slice
  442ac0c6659d1b359e79d9efbf7e24f78e5a617f
native/s8-worker-launcher/deploy/swooshz-host-reserve.slice
  1793b5596fc48e7cc1c603bbaeaf549beee46f08
native/s8-worker-launcher/deploy/swooshz-non-design-future-non-design.slice
  25b2958ebe263b3269b10e9ac9d1882a6d05b02e
native/s8-worker-launcher/deploy/swooshz-non-design-n8n.slice
  bbf6372c4135fc558f04ae43948c5b1aee786de0
native/s8-worker-launcher/deploy/swooshz-non-design-other-siblings.slice
  998ccc0e5415c62cc6eeb5b1c5279a66f6d8c3b7
native/s8-worker-launcher/deploy/swooshz-non-design-quote.slice
  e5d834e197d6f32da758ed34998e28a3e75d72a1
native/s8-worker-launcher/deploy/swooshz-non-design-wordpress.slice
  b3e5cff3d8a3971d18d88ef6638b5783e94c906f
native/s8-worker-launcher/deploy/swooshz-non-design.slice
  f1189f66ea1f6218fb36e033c167c3d6d663ebfb
native/s8-worker-launcher/deploy/swooshz-s8-worker-launcher.service
  83d09bcaff9ca0a2de32c99ad8c39340e29d93aa
native/s8-worker-launcher/deploy/swooshz.slice
  3adf8f29297a84180a1271d8d38fb2ec6b153eb6
native/s8-worker-launcher/deploy/user-manager/swooshz-s8-runtime.tmpfiles.conf
  2bc3d36129bb81e3eed844a9429d64253859439c
native/s8-worker-launcher/deploy/user-manager/user-at-UID.service.d/60-swooshz-s8.conf.template
  9bb33ff16db090e710e58ab979e76a7b9ab2a389
native/s8-worker-launcher/deploy/user/swooshz-s8-rootless-docker.service
  c8122de7da75796d341f8a3cfd1ae153f558dbde
native/s8-worker-launcher/deploy/user/swooshz-s8-workers.slice
  223011a1648d80ce2cfc02932af0a8e721d57a90
native/s8-worker-launcher/host-state.mjs
  e6c5501494d21c948d678090204bc18338307cde
native/s8-worker-launcher/launcher.mjs
  2b16e7b3f860dd64887bbe4509f11f85f31368a5
native/s8-worker-launcher/ledger.mjs
  92743cf4b8010786db380f9b14cc38ec5abebb38
native/s8-worker-launcher/ledger.test.mjs
  f5e8048c6114b42e79d7cea45e8c22ef85d7b40e
native/s8-worker-launcher/operation.mjs
  1f3ecd56a29e64a8b5b326af7f10a30c81c2fb60
native/s8-worker-launcher/result.mjs
  dd1d12ec40ce222b6e136af377298a987fb818af
native/s8-worker-launcher/result.test.mjs
  f230fab3e942d7a22025e8a5020ef5db0f14a7ad
src/lib/s8-native-admission.ts
  fab56d2a11fc124874336aa1948fc7576fa3c822
src/lib/s8-native-release.ts
  4e944693ee5730c3dd6ea20636e0f4e8b0728a36
tests/s8-native-policy-crosscheck.test.ts
  6d17e77b740ac432297176858caeeaecd54ec905
tests/s8-native-release.test.ts
  57cd41e51216d9f412e15d4934c64354da1992b8
```

Deployment files are copied as unchanged repository material. No service installation, configuration, restart, image publication, or host mutation is included.

### 11.5 Exact deletion patches

Transplant only the PR #71 deletion of these paths:

```text
native/s8-sandbox-broker/deploy/s8-sandbox
native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service
native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer
native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in
scripts/s8/s8_application_boundary_proof.mts
scripts/s8/s8_application_boundary_proof.sh
scripts/s8/s8_runtime_sensitivity.py
```

Patch ownership is exactly the deletion portion of:

```text
ff6a9bada283d36b92637a810a7e9d691b92193e
..c440ff2723176f3364fae4d8ec916fd0f0e810e4
```

These remove the retired local-broker selection routes. They are independent of successor proof semantics and are required by the retained native reachability guardrails.

### 11.6 Remaining classifications

- **CLEAN_BASE_KEEP:** `app/components/S8Client.tsx`.
- **REGRESSION_ONLY:** unchanged S2–S7 services/tests except the three bounded source-reader extractions; S8 geometry/payload/profile/semantic/oracle code and tests; `s8-fbx-worker.ts`; Writer Python; process runner; validator; vendored ufbx.
- **NO_CHANGE:** dependency versions, lockfile, source geometry/profile/resource-policy values, secrets, environment values, runtime data, admission state, and every path outside the ceiling.

No merge, cherry-pick, or whole-tree inheritance of PR #71 is allowed.

## 12. Migration and quarantine

### Recognition

- Missing evidence version: recognize the exact clean-base/predecessor shapes.
- Evidence version `1`: accept only recognized legacy v1 attempt shapes.
- Evidence version `2`: require exact Run-130 schemas.
- Evidence version `3`: require every successor field and full successor validation.
- Other versions or mixed undeclared schemas fail.

A malformed version-3 state is not automatically quarantined. It fails closed.

### Preservation rule

A pristine queued record may survive migration only when it has:

- No native attempts.
- No validation receipt.
- No checkpoint.
- No object/publication proof metadata.
- No dispatch history.
- No retry or quarantine history.
- No active claim.

Convert its job/artifact schema to v3 with new nullable fields set to `null`. This creates no proof.

Every other predecessor native-derived record is quarantined.

### Exact quarantine shape

```ts
{
  schemaVersion: "s8-native-proof-quarantine-v2";
  quarantineId: Uuid; // original jobId
  reason: "SUCCESSOR_NATIVE_PROOF_UNPROVEN";
  predecessorEvidenceVersion: 1 | 2 | null;
  migratedAt: Timestamp;
  admissionBlock: "NONE" | "RECONCILIATION_REQUIRED";
  originalJob: LegacyJob;
  originalArtifact: LegacyArtifact;
  originalAttempts: Array<LegacyV1Attempt | NativeAttemptV2>;
  originalValidationReceipts: LegacyValidationReceipt[];
  originalIdempotencyRecords: S8IdempotencyRecordV2[];
}
```

The legacy unions are restricted to the pinned clean-base/PR #71 and incorporated Run-130 schemas. They are not arbitrary JSON.

Preserve original values. Validate v2 signatures and bindings even in quarantine; quarantine cannot hide a bad v2 receipt or missing historical key.

### Active terminal representation

For each quarantine:

- Preserve active job/artifact IDs and idempotency references.
- Change active job/artifact to v3 terminal shells.
- Set status `failed_terminal`, phase `source_admission`.
- Set `failureCode="S8_NATIVE_LEGACY_UNPROVEN"`.
- Link `quarantineId` and a matching terminal outcome.
- Clear active claim, owner, heartbeat, and active proof pointers.
- Keep original evidence only in quarantine.
- Remove quarantined attempts/receipts from active collections.
- Do not remove underlying objects.

Original and terminal-shell copies represent one logical job/artifact identity. Their prescribed linkage is allowed; reuse of those identities for a different entity is not.

### Reconciliation and idempotence

`DISPATCHING`, `UNKNOWN`, or any unproven disposal retains `RECONCILIATION_REQUIRED`.

Migration cannot clear that block, infer disposal, restore success, or grant retry. Elapsed time and object existence are insufficient.

Quarantine IDs equal original job IDs, making selection deterministic. After a successful version-3 commit, restart does not repeat migration.

On migration persistence failure:

- Return no readiness.
- Preserve poison semantics.
- Reopen under the mutex.
- Migrate the surviving predecessor canonical state again, or validate/stabilize the surviving complete successor canonical state.
- Never recover from a temporary file.

Historical keys remain required while any active or quarantined dependent acceptance, retry record, or checkpoint remains retained. Key removal is not part of this G3.

## 13. Error taxonomy

Internal failures use `S8ProofError` with only:

```ts
{
  code: S8ProofErrorCode;
  referenceId: Uuid;
}
```

No key material, PEM, signature bytes, raw receipt, private path, or payload is included.

Exact internal codes:

- Malformed schema, checkpoint, encoding, graph: `S8_PROOF_MALFORMED`.
- Valid state lacks operation prerequisite: `S8_PROOF_REQUIRED`.
- Status/phase/pointer/hash description differs from derivation: `S8_PROOF_STATUS_MISMATCH`.
- Unknown retained historical key: `S8_PROOF_KEY_UNKNOWN`.
- Duplicate/colliding/mismatched key configuration: `S8_PROOF_KEYSET_INVALID`.
- Stale validation receipt hash or byte representation: `S8_PROOF_RECEIPT_HASH_MISMATCH`.
- Recomputed unsigned receipt differs from signed checkpoint: `S8_PROOF_RECEIPT_BINDING_MISMATCH`.
- Invalid checkpoint signature or domain: `S8_PROOF_SIGNATURE_INVALID`.
- Invalid checkpoint envelope hash: `S8_PROOF_CHECKPOINT_HASH_MISMATCH`.
- Duplicate/replayed identity: `S8_PROOF_REPLAY`.
- Object bytes/key/length mismatch: `S8_PROOF_READBACK_MISMATCH`.
- Current source mismatch: `S8_SOURCE_STALE`.
- Current source unavailable: `S8_SOURCE_NOT_READY`.
- Claim/owner/session mismatch: `S8_CLAIM_FENCED`.
- UNKNOWN or required reconciliation: `S8_RECONCILIATION_REQUIRED`.
- Forbidden baseline-to-candidate mutation: `S8_PROOF_TRANSITION_INVALID`.
- Invalid projection/capability provenance: `S8_PROOF_PROVENANCE_INVALID`.
- Canonical persistence/stabilization failure: `PERSISTENCE_FAILED`.
- Mutex unavailable within bound: `PERSISTENCE_BUSY`.

Repository load/precommit integrity errors block the entire authoritative snapshot and surface as `PERSISTENCE_FAILED` with the same support reference retained in minimized server diagnostics.

At the S8 API boundary, integrity/persistence errors map to generic `S8_INTERNAL_ERROR` HTTP 500 with that reference. Operation insufficiency maps to `S8_PROOF_REQUIRED` HTTP 409. Reconciliation maps to HTTP 503. Existing source/claim errors retain HTTP 409.

**Continues in Part 4.**


## G2 terminal contract — proof-derived native authority — Part 4 of 4

Continuation:
- Part 1: #72:5924369770
- Part 2: #72:5924380442
- Part 3: #72:5924393226

## 14. Deterministic oracle matrix

Tests use ephemeral keys and real protocol verification. Test signers are fixture code; no production factory accepts preverified results or custom signing domains.

Positive controls:

- `G135-P01`: pristine queued graph projects `queued`.
- `G135-P02`: valid claim/native progress projects `running`.
- `G135-P03`: Writer B + two exact objects + STAGED projects `staged`.
- `G135-P04`: valid pair/semantic/receipt/VALIDATED projects `validated`.
- `G135-P05`: five exact finals/readback/PROMOTED projects `promoted`.
- `G135-P06`: same-transaction COMMITTED evidence projects `committed`; download returns exact FBX.
- `G135-P07`: valid transient retry evidence schedules attempt 2 once.
- `G135-P08`: valid historical key retained across rotation verifies.
- `G135-P09`: valid new-claim recovery appends promotion and commits without changing acceptances.
- `G135-P10`: pristine legacy queued migration preserves queued state.

Each negative row is paired with a valid control through the **same repository/service/API boundary**, immediately before or after the malformed case.

- `G135-N01`: set staged status without STAGED checkpoint -> status mismatch; P03.
- `G135-N02`: set validated without VALIDATED -> status mismatch; P04.
- `G135-N03`: set promoted before final readback/checkpoint -> status mismatch; P05.
- `G135-N04`: set committed without COMMITTED -> status mismatch; P06.
- `G135-N05`: remove Writer from valid pair -> malformed/missing graph edge; P04.
- `G135-N06`: remove Validator from valid pair -> malformed/missing graph edge; P04.
- `G135-N07`: substitute another job ID -> binding rejection; P04.
- `G135-N08`: substitute another artifact ID -> binding rejection; P04.
- `G135-N09`: substitute attempt-1 proof into attempt 2 -> binding rejection; P04.
- `G135-N10`: substitute native claim -> binding rejection; P04.
- `G135-N11`: substitute release manifest or handle -> binding rejection; P04.
- `G135-N12`: mutate receipt field, retain receiptHash -> receipt hash mismatch; P04.
- `G135-N13`: mutate receipt and recompute unsigned hashes/byte record -> signed receipt binding rejection; P04.
- `G135-N14`: mutate final object byte, length, or readback entry independently -> readback mismatch; P05.
- `G135-N15`: mutate publication claim, final prefix, complete flag, or validation hash independently -> receipt/checkpoint binding rejection; P05.
- `G135-N16`: mutate checkpoint body without resigning -> signature/hash rejection; corresponding P03–P06.
- `G135-N17`: flip one signature byte -> signature rejection; P05.
- `G135-N18`: replace checkpointSha256 only -> checkpoint hash mismatch; P05.
- `G135-N19`: sign valid body using another checkpoint kind’s domain -> signature rejection; P05.
- `G135-N20`: remove historical key needed by retained proof -> bootstrap key failure; P08.
- `G135-N21`: duplicate key ID, alias same SPKI, or mismatch current pair -> keyset failure; P08.
- `G135-N22`: insert duplicate checkpoint ID/envelope -> replay rejection; P05.
- `G135-N23`: insert/rebind duplicate acceptance ID/envelope -> replay rejection; P04.
- `G135-N24`: mutate detached snapshot and retained nested references -> throws or has no canonical effect; fresh P06 remains unchanged.
- `G135-N25`: generic transaction edits S8 proof/status or deletes complete history -> transition rejection before write; P02/P06.
- `G135-N26`: timely A, then fail B persistence -> no public success, retry, or replacement dispatch; timely successful B control.
- `G135-N27`: hold real B directory fsync until after deadline -> B succeeds with original timely A; compare A-at-deadline rejection.
- `G135-N28`: kill during candidate write/fsync -> old canonical controls; successful same-path commit control.
- `G135-N29`: kill after rename before directory fsync -> surviving canonical requires validation/stabilization; successful fsync control.
- `G135-N30`: kill after directory fsync -> complete canonical remains valid; P06.
- `G135-N31`: recover valid pair under new claim but alter original acceptance claims -> reject; P09 preserves originals.
- `G135-N32`: restart with unresolved prepared attempt -> UNKNOWN/reconciliation, zero dispatch; clean new-operation control.
- `G135-N33`: legacy v1 success/failure/dispatch/UNKNOWN or predecessor progress -> exact quarantine disposition; P10.
- `G135-N34`: `getExport` receives forged native progress via canonical fields -> no successful status response; corresponding valid API control.
- `G135-N35`: status API reaches orphan promoted/committed state -> generic integrity failure; P05/P06 API controls.
- `G135-N36`: reuse has valid status but altered/missing pair or receipt -> reject; P06 reuse control.
- `G135-N37`: download has valid status but altered final bytes -> reject without returned FBX; P06 download control.
- `G135-N38`: JSON/spread/clone projection; borrow accessor onto forged receiver -> provenance rejection; genuine projection control.
- `G135-N39`: async transaction, nested transaction, retained callback alias -> immediate rejection/no uncommitted exposure; synchronous baseline-read control.
- `G135-N40`: two jobs produce identical FBX with different publication metadata -> distinct final namespaces; both valid; forced shared-key mutation rejects.
- `G135-N41`: S6/S7 changes while waiting for A or commit mutex -> final source fence rejects; unchanged-source control.
- `G135-N42`: delete staging referenced by retained checkpoint after promotion -> readback failure; retained-staging P06 control.
- `G135-N43`: remove proof and lower status to queued to request redispatch -> baseline transition rejection; genuine pristine P01 control.
- `G135-N44`: fail migration before/after rename -> no readiness until valid canonical stabilization; P10 durable migration control.
- `G135-N45`: source reader invokes nested mutation or supplies caller handoff -> reject; fixed pure-reader equivalence control.
- `G135-N46`: use stale committed projection after source/claim changes -> consequential operation performs fresh read and rejects; fresh-current control.
- `G135-N47`: lose accepted volatile bytes before staging -> terminal unavailable-bytes result; no reconstruction/retry; retained-byte P03 control.
- `G135-N48`: mutate symlink/type/root identity for a referenced object -> reject before bytes leave authority; regular-file control.

Retain Run-130 oracles A–X as `G135-R130-A` through `G135-R130-X`, including:

- Before/equal/after deadline.
- Backward and forward-then-backward wall movement.
- Monotonic regression/overflow/witness mutation.
- Exact native byte mutation.
- True transient retry and attempt ceiling.
- Forged failure/result capabilities.
- Post-A poison/reopen.
- Independent readers and reentrant baseline reads.
- UNKNOWN and original-claim recovery.

Linux cases use actual flock, regular files, fsync, atomic rename, directory fsync, two processes, and explicit barriers. A delayed fsync must eventually execute the real syscall. Skips or no-op sync functions do not count as evidence.

## 15. G3 validation floor

These are future G3 commands. They were not run during this read-only gate.

### Application and proof tests

```sh
pnpm exec tsx --test tests/s8-native-proof.test.ts

pnpm exec tsx --test \
  tests/s8-worker.test.ts \
  tests/s8-persistence.test.ts \
  tests/s8-publication.test.ts \
  tests/s8-api.test.ts \
  tests/s8-native-admission.test.ts \
  tests/s8-native-release.test.ts \
  tests/s8-native-policy-crosscheck.test.ts

pnpm exec tsx --test tests/g3.test.ts
pnpm test
pnpm exec tsc --noEmit --pretty false
pnpm run build
```

`pnpm test` must include the new proof suite and all retained S2–S7/S8/native suites. No test removal or skip is allowed to satisfy the floor.

### Writer and Python

```sh
python3 scripts/s8/blender_writer_contract_regression.py
python3 -m py_compile blender/s8-fbx-writer/writer.py scripts/s8/*.py
```

### Native JavaScript

```sh
node --test \
  native/s8-worker-common/protocol.test.mjs \
  native/s8-worker-common/admission.test.mjs \
  native/s8-worker-launcher/capacity.test.mjs \
  native/s8-worker-launcher/ledger.test.mjs \
  native/s8-worker-launcher/container-runtime.test.mjs \
  native/s8-worker-launcher/result.test.mjs \
  native/s8-worker-gateway/gateway.test.mjs
```

### Runner and validator on Linux

```sh
cmake -S native/s8-process-runner \
  -B "$RUNNER_TEMP/s8-runner" -DCMAKE_BUILD_TYPE=Release
cmake --build "$RUNNER_TEMP/s8-runner" --config Release --parallel

registered="$(ctest --test-dir "$RUNNER_TEMP/s8-runner" -N |
  awk 'index($0, "s8-runner.") { count += 1 } END { print count + 0 }')"
test "$registered" -eq 20

ctest --test-dir "$RUNNER_TEMP/s8-runner" \
  -R '^s8-runner\.' --output-on-failure

cmake -S native/s8-fbx-validator \
  -B "$RUNNER_TEMP/s8-validator" -DCMAKE_BUILD_TYPE=Release
cmake --build "$RUNNER_TEMP/s8-validator" --config Release --parallel
ctest --test-dir "$RUNNER_TEMP/s8-validator" --output-on-failure
"$RUNNER_TEMP/s8-validator/s8-fbx-validator" --self-test
```

### Mandatory real Linux durability/concurrency

```sh
S8_G135_REQUIRE_LINUX=1 pnpm exec tsx --test \
  --test-name-pattern='^G135-LINUX-' \
  tests/s8-native-proof.test.ts tests/g3.test.ts
```

The required test names cover N26–N30, N32, N39, N41, N44 and Run-130 A, D–G, K, L, X. The environment flag makes unsupported platform, missing flock, missing directory fsync, skipped case, or absent barrier evidence a failure.

Use a disposable real Linux filesystem carrier. Windows-only results cannot satisfy this floor.

### Secret/preflight and workflow guards

Run the exact preserved `Secret preflight` workflow block, including synthetic match, clean, status-2, status-128, and unavailable-scanner controls:

```sh
GITHUB_WORKSPACE="$PWD" python3 - <<'PY'
from pathlib import Path
import subprocess

text = Path(".github/workflows/s8-fbx.yml").read_text()
marker = "      - name: Secret preflight\n"
start = text.index(marker)
end = text.index("\n      - name:", start + len(marker))
step = text[start:end]
body = step.split("        run: |\n", 1)[1]
script = "\n".join(line[10:] if line.startswith("          ") else line
                  for line in body.splitlines())
subprocess.run(["bash", "-euo", "pipefail", "-c", script], check=True)
PY

pnpm exec tsx --test \
  --test-name-pattern='workflow|legacy broker|partial native configuration' \
  tests/s8-worker.test.ts
```

Run pinned actionlint 1.7.12 on Linux and Windows using the preserved acquisition/checksum procedures and these invocation arguments:

```text
actionlint -shellcheck= -pyflakes= .github/workflows/s8-fbx.yml
```

The pinned archive hashes remain those in PR #71’s workflow. Tool acquisition/environment failure is a hold, not a pass.

### Git identity, path, blob, and patch checks

```sh
git diff --check
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git merge-base --is-ancestor \
  ff6a9bada283d36b92637a810a7e9d691b92193e HEAD
git diff --name-status \
  ff6a9bada283d36b92637a810a7e9d691b92193e HEAD
git log --format='%H %an <%ae> | %cn <%ce>' \
  ff6a9bada283d36b92637a810a7e9d691b92193e..HEAD

S8_G135_CANDIDATE="$(git rev-parse HEAD)" pnpm exec tsx --test \
  --test-name-pattern='^G135-GIT-' tests/s8-native-proof.test.ts
```

`G135-GIT-*` must encode this packet’s exact 83-path ceiling, 52 blob IDs, seven absent paths, 57-addition limit, no-renames rule, unchanged dependency/lockfile constraints, base ancestry, and required author/committer. It must inspect the selected Git commit, not just worktree files.

### Hosted exact-head checks

After separately authorized publication:

```sh
gh pr view <successor-pr> \
  --repo Swooshz-com/swooshz-design \
  --json headRefOid,baseRefName,isDraft,state

gh pr checks <successor-pr> \
  --repo Swooshz-com/swooshz-design --watch

gh run list \
  --repo Swooshz-com/swooshz-design \
  --workflow s8-fbx.yml --commit <published-sha> \
  --json databaseId,headSha,status,conclusion,url
```

Require all five exact-head checks:

1. S8 pinned actionlint linux/amd64.
2. S8 pinned actionlint windows/amd64.
3. S8 static and TypeScript floor.
4. S8 native validator and process runner.
5. S8 native worker repository prepublication.

The hosted workflow must execute the successor proof suite and mandatory Linux durability cases. Old-head green checks do not count.

### Fresh challenges

Two separate fresh **Sol Max** challenges are required:

- Frozen local candidate before any successor branch publication.
- Exact published SHA after hosted CI.

Each receives this complete contract, incorporated Run-130, exact diff/tree, path/blob results, and local/Linux evidence. Each independently attempts the negative families at repository and public-consumer boundaries.

A material finding invalidates the challenged candidate. Any correction changes the candidate identity and requires renewed affected validation and a fresh challenge. G3 cannot self-certify challenge cleanliness.

## 16. Successor publication topology

The required sequence is:

```text
verified clean base
-> isolated detached G3 worktree
-> bounded implementation
-> complete local and real Linux validation
-> freeze candidate commit/tree and evidence
-> fresh Sol Max prepublication challenge
-> only if clean, create successor branch and publish non-force
-> create draft successor PR
-> exact-head hosted CI
-> fresh exact-published-head Sol Max challenge
-> G3_PASS to Web only when all evidence is clean
```

### Branch and PR

Proposed successor branch:

```text
codex/s8-proof-derived-native-authority
```

If that branch already exists, stop for controller reconciliation. Do not reuse an unrelated branch, force-push, or silently choose another lineage.

The verified clean-base carrier branch is:

```text
codex/s8-g3-native-process-boundary-hosted-carrier-001
```

The successor PR targets that branch only while its head remains:

```text
ff6a9bada283d36b92637a810a7e9d691b92193e
```

Verify the ref immediately before publication. A moved base requires Web reconciliation; do not silently rebase onto `main`.

All candidate commits use:

```text
Author=WJ <10020253+weijunswj@users.noreply.github.com>
Committer=WJ <10020253+weijunswj@users.noreply.github.com>
```

The PR:

- Remains draft.
- References successor issue #72.
- Identifies #71 and #29 as predecessor evidence.
- Does not close #72 while G4/UAT/other gates remain.
- Does not mutate, replace, or mark #71 ready.

### Evidence and cleanup

Retain:

- Frozen candidate and published SHA/tree.
- Exact path/blob/patch inventory.
- Test counts and command exit statuses.
- Linux syscall/barrier evidence.
- Both challenge packets.
- Hosted run/check URLs.

Do not remove referenced object evidence, failed-candidate evidence, or shared worktrees during G3. Disposable test carriers may be cleaned only after their evidence is captured and the paths are verified as task-owned.

No self-G4, Ready, merge, deployment, or native admission opening is included. Issue #70 continues to own realized host capacity and OPEN admission.

## G2 closure

The contract closes all 16 requested boundaries, including the receipt mutation bypass and pre-readback promotion failure class.

Performed:
- authenticated read-only evidence retrieval;
- exact handoff hashing;
- clean-base verification;
- pinned source/schema/consumer/CI inspection;
- path/blob classification;
- final PR identity recheck.

Not performed:
- implementation;
- tests/builds;
- repository or documentation edits;
- branch/PR changes;
- infrastructure actions;
- G3 launch.

Existing working-tree changes were left untouched; generated outputs and documentation were unchanged.

Instruction sources used: the attached request, supplied/root repository rules, baseline/local-doc playbooks, verified G1 authority and manifest, complete Run-130 contract, predecessor terminal evidence, and pinned repository source.

```text
RESULT=G2_PASS_PROOF_DERIVED_NATIVE_AUTHORITY_CONTRACT
RUN=S8_G2_PROOF_DERIVED_NATIVE_AUTHORITY_135
LOCK=DL-SD-S8-G2-PROOF-DERIVED-NATIVE-AUTHORITY-001
GATE=G2
RETURN_TO_WEB=YES
```


## Run-130 exact G2 contract artifact — Part 1 of 3

This is the durable, implementation-controlling reproduction of the **G2_PASS** packet for:

```text
RUN=S8_G2_PR71_TIMELY_ACCEPTANCE_DURABILITY_CONTRACT_130
LOCK=DL-SD-S8-G2-PR71-TIMELY-ACCEPTANCE-DURABILITY-CONTRACT-001
ROOT=R127_END_TO_END_DEADLINE
REPOSITORY=Swooshz-com/swooshz-design
PR=71

HEAD=c440ff2723176f3364fae4d8ec916fd0f0e810e4
TREE=88f9bd8c40ca1bd778ceb3b6023310331c48343d
PARENT=6fef13bc324cdd7dc6b77fac35537a6c3a6b0019
BASE=ff6a9bada283d36b92637a810a7e9d691b92193e

ACTIVE_CONTROLLER_BLOB=86b54185420d37352f4af30bec3df9f1afa5f56c
STACK_REGISTRY_V2_BLOB=01dfe152208338a552c892cb44ef28d064aa743d
STACK=owner-openai-default
BOUND_G2_ROUTE=openai/gpt-6-astra__high
SUBAGENTS_USED=0

ATTEMPTS_CONSUMED=3
ATTEMPT4_AUTHORISED=NO
MUTATION_AUTHORISED=NO
G4_AUTHORISED=NO
READY_AUTHORISED=NO
MERGE_AUTHORISED=NO
NEXT=RETURN_TO_WEB_FOR_EXPLICIT_ATTEMPT4_ADMISSION
```

The contract closes the accepted A/B/C model:

- **A:** trusted application logical acceptance strictly before the original deadline.
- **B:** durable native-attempt `SUCCEEDED`, carrying authenticated evidence of A. Persistence may finish later.
- **C:** separate durable artifact publication.

### 1. Evidence and scope

Authenticated `gh` verified `github.com`, active account `weijunswj`, the intended repository, and the exact PR identities above. PR #71 remains open and draft.

Controlling evidence:

- Owner semantic decision: #29:5905024629
- Web acceptance of G1 and Run-130 authority: #29:5905610139
- Parent receipt: #1:5905612836

Pinned-source consequential gaps:

- `S8ExportService.completeNativeAttempt()` persists success without an acceptance receipt or persisted original start/deadline.
- Some Writer receipt, runner, and Validator readback checks occur after that completion.
- `JsonRepository.state()` returns mutable transaction state or performs an unlocked load.
- Runtime configuration has application signing credentials but no acceptance verification-key history.
- Writer auxiliary bytes are parsed and subsequently reserialized.
- Recovery/publication and retry contain state-based checks without the proposed authenticated proof boundary.

### 2. Common encoding and validation rules

| Name | Exact rule |
|---|---|
| `Uuid` | Lowercase canonical UUID v4, matching the current native protocol UUID expression |
| `Sha256` | Exactly 64 lowercase hexadecimal characters |
| `KeyId` | `^[A-Za-z0-9._-]{1,80}$` |
| `Nonce` | Canonical unpadded base64url encoding of exactly 32 bytes; 43 characters; decode/re-encode equality required |
| `Signature` | Canonical unpadded base64url encoding of exactly 64 bytes; 86 characters; decode/re-encode equality required |
| `UnixMs` | JSON number, safe integer, not negative zero, between `0` and `8640000000000000` inclusive |
| `Ns` | Decimal string matching `0|[1-9][0-9]*`, representing an integer between `0` and `18446744073709551615` inclusive |
| `AttemptNumber` | Integer `1` or `2` |
| `Operation` | Exactly `WRITER` or `VALIDATOR` |
| `Timestamp` | Canonical `Date.toISOString()` representation of a valid `UnixMs` |

All described object shapes have exact keys. Every listed field is required. Nullable fields must be explicitly `null`; omission is invalid. Reject unknown keys, duplicate JSON object keys, invalid UTF-8, nonfinite numbers, unsafe integers, and invalid primitive types.

Canonical encoding is UTF-8 JCS using the repository's `jcs` representation, with no BOM or trailing newline. Signed envelopes received as bytes must equal their canonical encoding. Repository decoding must detect duplicate keys before ordinary JSON parsing can discard them.

Hashes bind the representations explicitly identified below. A hash of a parsed object is not a substitute for a required raw-byte hash.

### 3. Operation start and original deadline custody

Replace the current independently supplied/recomputed deadline flow with one private operation context created at entry to `S8ExportService.writer()` or `nativeValidator()`.

Creation precedes operation admission, input hashing, attempt persistence, request construction, and transport:

```text
m0 = process.hrtime.bigint()
w0 = Date.now()
start = validated w0
duration = WRITER ? 510000 : 330000
deadline = checked_integer_add(start, duration)
```

Reading the monotonic origin before the wall origin conservatively includes the interval between those readings.

The private context contains:

```text
operation
operationStartedAtUnixMs
deadlineUnixMs
clockModelVersion
processClockEpoch
operationStartMonotonicNs
effectiveHighWaterUnixMs
expired
terminalDecision
```

It is registered in a module-private `WeakMap`; a serialized object, type assertion, copied object, or caller-provided timestamps cannot reconstruct it.

`beginNativeAttempt()` durably writes the v2 `DISPATCHING` record with the original start, deadline, epoch and monotonic origin before any operation-specific remote request. Before native dispatch, `prepareNativeAttempt()` durably adds the complete signed request, request hash and nonce.

Failure to persist either boundary prevents dispatch.

The same `deadlineUnixMs` is used by:

- The durable attempt.
- The signed native request.
- Admission and transport bounds.
- Gateway forwarding.
- Launcher operation lifecycle.
- Application response admission.
- Acceptance receipt.

Remove deadline-default/recomputation paths from production operation calls. Request construction may validate the remaining interval, but cannot assign a replacement deadline. Recovery never creates an operation clock for an existing dispatched attempt.

Validate `start <= MAX_UNIX_MS - duration` and exact equality:

```text
deadlineUnixMs - operationStartedAtUnixMs
== (operation == WRITER ? 510000 : 330000)
```

Each permitted retry has new operations and new starts/deadlines. It does not extend its predecessor.

### 4. Clock mechanics and recovery-verifiable witness

Use:

```text
clockModelVersion = "s8-effective-unix-ms-v1"
```

`processClockEpoch` is a cryptographically generated UUID v4 created once per application process bootstrap. It is never restored after restart.

For every authoritative clock observation:

```text
wall = Date.now()
mono = process.hrtime.bigint()
elapsedNs = mono - m0

elapsedMs = (elapsedNs + 999999n) / 1000000n
advanced = BigInt(start) + elapsedMs

effectiveNow = max(
  validated wall,
  checked_Number(advanced),
  previousEffectiveHighWater
)

expired = expired OR effectiveNow >= deadline
effectiveHighWater = effectiveNow
```

All arithmetic through `advanced` uses `BigInt`. Reject negative elapsed time, monotonic regression, overflow, invalid wall readings, or values outside the declared ranges. Invalid clock evidence is nonretryable and cannot produce acceptance.

Backwards wall movement never reduces effective time. Forward movement is retained by the high-water mark even if wall time later moves backwards.

The receipt's exact `clockWitness` shape is:

```ts
{
  operationStartMonotonicNs: Ns;
  responseWallUnixMs: UnixMs;
  responseMonotonicElapsedNs: Ns;
  responsePriorEffectiveUnixMs: UnixMs;
  decisionWallUnixMs: UnixMs;
  decisionMonotonicElapsedNs: Ns;
  decisionPriorEffectiveUnixMs: UnixMs;
}
```

The response observation occurs after the complete bounded response has been assembled into privately owned bytes, before response verification. Receiving the first byte or response headers is insufficient.

Recovery verifies:

```text
responseElapsed <= decisionElapsed
start <= responsePriorEffective <= responseObservedAt
responseObservedAt <= decisionPriorEffective <= logicalAcceptedAt

responseObservedAt =
  max(responseWall,
      start + ceil(responseElapsedNs / 1000000),
      responsePriorEffective)

logicalAcceptedAt =
  max(decisionWall,
      start + ceil(decisionElapsedNs / 1000000),
      decisionPriorEffective)

start <= responseObservedAt <= logicalAcceptedAt < deadline
```

Checked sums must remain representable. The monotonic origin plus each elapsed witness must fit `Ns`.

Recovery verifies the signed attestation and arithmetic. It does not claim to reconstruct the former process's monotonic clock or prove wall-clock accuracy independently of the trusted application.

### 5. Exact logical acceptance boundary

The sole success issuer is an ECMAScript-private method:

```text
S8ExportService.#acceptVerifiedNativeResult(...)
```

TypeScript `private` alone is insufficient for this boundary.

Its accepted inputs are:

- An authentic, unconsumed verified-result capability from the owning `S8NativeWorkerClient`.
- The owning private operation-clock context.
- A live repository transaction context.
- Authoritative application state obtained within that transaction.

It does not accept a receipt body, timestamp, clock callback, `verified` boolean, or caller-selected hashes.

Before A, it must complete:

1. Complete response framing, canonical encoding and signature verification.
2. Exact request/project/job/artifact/attempt/operation/source/input bindings.
3. Exact release, image, resource-policy, runner and release-handle bindings.
4. `EXIT_0` and verified `REAPED_REMOVED`.
5. Raw output/auxiliary hash and length verification.
6. Writer-specific receipt and runner checks, or Validator-specific readback, identity, runner and provenance checks.
7. Validation of the corresponding v2 attempt and expected prior state.
8. Current claim, owner, process, attempt and job-status checks.
9. The final authoritative current S6/S7 source check under the repository mutex.
10. The final effective clock reading.

For Writer, move `validateWriterReceipt()` and `assertRunnerEvidence()` before A.

For Validator, move the native readback schema, exact-byte parsing, validator identity, runner and physical/root provenance checks before A. The later semantic comparison and artifact publication remain separate application-validation work; they cannot repair invalid native acceptance.

The exact linearization is the synchronous creation and freezing of the private acceptance event immediately following the final clock decision:

```text
if clock.expired OR effectiveNow >= originalDeadline:
  reject S8_NATIVE_OPERATION_TIMEOUT
else:
  create and freeze acceptance event
  consume verified-result capability
  latch terminalDecision = ACCEPTED
```

There is no await, callback, hook, I/O, caller code, source lookup or asynchronous work between the final reading and event creation. Acceptance ID generation, key availability checks and other preparatory work occur before that reading.

Equality is timeout. A response at `deadline - 1` is insufficient when verification or lock/source checks reach the deadline.

Signing the immutable event and persisting it follow A. Their latency cannot retroactively turn A into timeout. Signing failure produces no durable success and no retry entitlement.

### 6. Exact acceptance receipt

The persisted envelope has exactly:

```ts
{
  body: AcceptanceBody;
  signature: Signature;
  receiptSha256: Sha256;
}
```

`AcceptanceBody` has exactly:

```ts
{
  schemaVersion: "s8-native-acceptance-v1";
  acceptanceId: Uuid;
  keyId: KeyId;

  operationStartedAtUnixMs: UnixMs;
  deadlineUnixMs: UnixMs;
  responseObservedAtUnixMs: UnixMs;
  logicalAcceptedAtUnixMs: UnixMs;

  clockModelVersion: "s8-effective-unix-ms-v1";
  processClockEpoch: Uuid;
  clockWitness: ClockWitness;

  attemptId: Uuid;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  attempt: 1 | 2;
  operation: "WRITER" | "VALIDATOR";

  claimToken: Uuid;
  acceptedSourceDigest: Sha256;
  profile: "swooshz-fbx-static-mesh-v1";
  protocolVersion: "s8-native-worker-v1";
  configSha256: Sha256;

  requestSha256: Sha256;
  requestNonce: Nonce;
  inputSha256: Sha256;
  inputBytes: number;

  responseSha256: Sha256;
  outputSha256: Sha256;
  outputBytes: number;
  auxiliarySha256: Sha256;
  auxiliaryBytes: number;

  releaseManifestSha256: Sha256;
  resourcePolicySha256: Sha256;
  imageDigest: string;
  containerId: Sha256;
  runnerBinarySha256: Sha256;
  runnerEvidenceSha256: Sha256;
  releaseHandle: Nonce;
  validatorIdentity: string | null;

  disposalState: "REAPED_REMOVED";
  nativeOutcome: "EXIT_0";
}
```

Additional exact rules:

- Writer input: `1..268435456` bytes.
- Writer output: `28..134217728` bytes.
- Writer auxiliary: `1..1048576` bytes.
- Validator input: `28..134217728` bytes.
- Validator output: `1..8388608` bytes.
- Validator auxiliary: exactly zero bytes; its hash is SHA-256 of the empty buffer.
- Byte counts are safe integers.
- `imageDigest` matches `^sha256:[0-9a-f]{64}$`.
- Writer `validatorIdentity` is `null`.
- Validator identity is exactly `s8-validator-sha256:` followed by its verified executable SHA-256.
- `runnerEvidenceSha256 = SHA256(UTF8(JCS(complete verified runner evidence)))`, including its caller-verification envelope.
- `acceptedSourceDigest = SHA256(UTF8(JCS(job.source)))`.
- `configSha256` retains the current request configuration formula.
- Request and response hashes retain the current meanings: hashes of their complete canonical signed envelopes, not raw binary frames.
- Output and auxiliary hashes bind raw bytes.
- The Writer's returned release handle is mandatory; Validator uses exactly that handle.

Signing representation:

```text
signature =
  Ed25519(
    existing application private key,
    ASCII("S8-NATIVE-ACCEPTANCE-V1\\0") || UTF8(JCS(body))
  )

receiptSha256 =
  SHA256(UTF8(JCS({body, signature})))
```

The terminal NUL is one byte. `receiptSha256` is excluded from its own hash.

### 7. Issuer capability and verification boundary

`S8NativeWorkerClient` stores privately copied response bytes, signed envelopes, verified release identity and observation evidence in a private `WeakMap`, keyed by an opaque object with no reconstructible authority-bearing properties.

Only its real verification path can register such a capability. Public Writer/Validator calls return the opaque capability; ordinary result objects cannot substitute for it.

The service's private issuer:

- Checks capability ownership and single-use status.
- Checks the operation-clock identity and attempt identity.
- Revalidates consequential bytes before A.
- Builds every receipt field itself.
- Uses the existing application Ed25519 authority.

No exported generic acceptance signer is permitted. Existing request/status signers remain fixed to their existing domains. No API accepts a signing domain supplied by callers.

Production constructors must not accept an injected acceptance clock or issuer. Existing descriptive `clock` options cannot influence acceptance evidence. Test transport seams may supply raw frames for verification; they cannot supply a verified capability, acceptance time or pre-signed application receipt.

Deterministic tests may control process clock primitives in an isolated test process using ephemeral test keys. That harness control must not become a production factory or JSON escape hatch.

The verifier in `s8-fbx-persistence.ts` performs:

1. Exact structural/range/canonical validation.
2. Application-key lookup.
3. Domain-separated signature verification.
4. Receipt hash verification.
5. Clock arithmetic and strict timeliness validation.
6. Complete attempt/request/response/source/configuration/release binding checks.
7. Duplicate/replay checks.
8. Operation-specific success checks.

On recovery, the application signature attests that the launcher response was verified at A. Recovery binds the stored canonical response and its signature through `responseSha256`; it does not need a currently active launcher key to reinterpret an already accepted success. The original request signature remains verifiable using retained application keys.

This boundary protects against ordinary caller data and deserialized records. It does not pretend to protect against arbitrary execution inside the trusted application with access to its private key.

### 8. Current and historical keys

Add one public configuration surface:

```text
S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON
```

Its exact shape is:

```ts
{
  schemaVersion: "s8-app-acceptance-keyset-v1";
  keys: Array<{
    keyId: KeyId;
    publicKeyPem: string;
  }>;
}
```

Rules:

- Exact keys throughout; duplicate JSON keys rejected.
- At least one entry.
- Each PEM is `1..16384` characters and parses as an Ed25519 public key.
- Reject private-key PEM material.
- Key IDs are unique.
- Compare normalized SPKI DER bytes, not PEM formatting.
- Reject the same public key assigned to multiple IDs.
- The current `S8_APP_SIGNING_KEY_ID` appears exactly once.
- Its configured public key must equal the public key derived from `S8_APP_SIGNING_PRIVATE_KEY_PEM`.

A historical entry colliding with the current ID is a duplicate and is rejected, even if its bytes match.

Rotation is a configuration change while admission is closed: install the new current signing pair and retain prior public keys. Configuration is immutable for the process lifetime; no in-flight operation switches signing identity.

Removal is allowed only after an exclusive dependency inventory proves no retained acceptance or retry-evidence record depends on that key. Missing keys for retained dependent records fail repository initialization/validation; they never downgrade to unverified success.

An incomplete configured runtime, mismatched current public/private pair, malformed keyset or unknown receipt key fails closed before S8 readiness. There is no new private credential.

When all native runtime configuration is absent, admission remains closed. A repository containing receipts still requires their verification keys before those records can become authoritative.

**Continues in Part 2.**


## Run-130 exact G2 contract artifact — Part 2 of 3

Continuation of Part 1: #29:5906439248

### 9. Exact native-attempt v2 persisted shape

Every current attempt has exactly:

```ts
{
  schemaVersion: "s8-native-operation-attempt-v2";

  attemptId: Uuid;
  projectId: Uuid;
  jobId: Uuid;
  artifactId: Uuid;
  claimToken: Uuid;
  attempt: 1 | 2;
  operation: "WRITER" | "VALIDATOR";
  state: "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

  acceptedSourceDigest: Sha256;
  profile: "swooshz-fbx-static-mesh-v1";
  protocolVersion: "s8-native-worker-v1";
  configSha256: Sha256;
  resourcePolicySha256: Sha256;

  operationStartedAtUnixMs: UnixMs;
  deadlineUnixMs: UnixMs;
  clockModelVersion: "s8-effective-unix-ms-v1";
  processClockEpoch: Uuid;
  operationStartMonotonicNs: Ns;

  inputSha256: Sha256;
  inputBytes: number;

  requestSha256: Sha256 | null;
  requestNonce: Nonce | null;
  signedRequest: S8SignedNativeRequest | null;

  responseSha256: Sha256 | null;
  signedResponse: S8SignedNativeResponse | null;

  releaseManifestSha256: Sha256;
  acceptanceReceipt: AcceptanceReceipt | null;
  retryEvidence: RetryEvidence | null;

  failureClass: "PERMANENT" | "TRANSIENT" | "UNCERTAIN" | null;
  failureCode:
    | "TIMEOUT"
    | "CLOCK_INVALID"
    | "SOURCE_OR_CLAIM_FENCED"
    | "ADMISSION_CLOSED"
    | "PROTOCOL_OR_SIGNATURE"
    | "NATIVE_OR_RESOURCE"
    | "TRANSIENT_INFRASTRUCTURE"
    | "PERSISTENCE_UNCERTAIN"
    | "RECONCILIATION_REQUIRED"
    | null;

  disposalState: "NOT_STARTED" | "REAPED_REMOVED" | "UNKNOWN";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt: Timestamp | null;
}
```

`S8SignedNativeRequest` and `S8SignedNativeResponse` retain the exact pinned v1 envelope/body key sets and wire semantics. They are stored as metadata, without output or payload bytes. Their nested runner evidence must satisfy the existing runner/caller-evidence contract; accepting an unchecked `unknown` value is insufficient.

The release-manifest hash is bound from verified application configuration when beginning the attempt, then matched against operation admission. Validator additionally requires the Writer's release identity.

State invariants:

| State | Required invariants |
|---|---|
| Unprepared `DISPATCHING` | Request triple null; response pair null; both evidence fields null; failure fields null; completion null; disposal `NOT_STARTED` |
| Prepared `DISPATCHING` | Complete request triple; response pair null; both evidence fields null; failure fields null; completion null; disposal `UNKNOWN` |
| `SUCCEEDED` | Complete request and response; exactly one valid acceptance receipt; retry evidence null; failure fields null; completion nonnull; disposal `REAPED_REMOVED` |
| Permanent `FAILED` | Acceptance/retry evidence null; permanent failure and nonnull failure code; completion nonnull; disposal `NOT_STARTED` or `REAPED_REMOVED` |
| Transient `FAILED` | Complete request and signed transient response; valid retry evidence; code `TRANSIENT_INFRASTRUCTURE`; disposal `REAPED_REMOVED`; completion nonnull |
| `UNKNOWN` | Acceptance/retry evidence null; class `UNCERTAIN`; code `PERSISTENCE_UNCERTAIN` or `RECONCILIATION_REQUIRED`; disposal `UNKNOWN`; completion nonnull |

Request fields are all-null or all-present. Response fields are all-null or all-present. Once assigned, original identity, input, clock, request and release fields are immutable.

For a local timeout with uncertain disposal, persist `UNKNOWN` and return the timeout error to the caller; uncertainty is not fabricated into proven disposal. If verified disposal is already available, a permanent `FAILED/TIMEOUT` is permissible.

`completedAt` is descriptive terminal-record metadata. It is never an acceptance or retry oracle.

Graph constraints include:

- Unique `attemptId`.
- Unique `(jobId, attempt, operation)`.
- Unique request nonces and acceptance IDs across current retained records.
- Exact ownership/source linkage to job and artifact.
- Validator requires validated Writer success for the same job, artifact, attempt, original claim, source and release.
- Validator input equals the Writer acceptance output hash and length.
- Both operations bind the same release handle.
- An identical idempotent read of one record is allowed; insertion/rebinding of its receipt into another record is rejected.

### 10. Retry proof and state machine

A public `S8NativeSignedFailure` instance is an error description, not retry authority. Its currently exported constructor must not allow callers to manufacture retry entitlement.

To preserve durable, delayed-persistence retry decisions without trusting unsigned timing fields, add this narrowly scoped metadata envelope in the existing files:

```ts
RetryEvidence = {
  body: {
    schemaVersion: "s8-native-retry-evidence-v1";
    decisionId: Uuid;
    keyId: KeyId;
    attemptBindingSha256: Sha256;
    responseSha256: Sha256;
    responseObservedAtUnixMs: UnixMs;
    failureAcceptedAtUnixMs: UnixMs;
    clockWitness: ClockWitness;
    nativeOutcome: "TRANSIENT_INFRASTRUCTURE_FAILURE";
    disposalState: "REAPED_REMOVED";
  };
  signature: Signature;
  receiptSha256: Sha256;
};
```

The exact attempt-binding object contains these v2 fields:

```text
attemptId, projectId, jobId, artifactId, claimToken, attempt, operation,
acceptedSourceDigest, profile, protocolVersion, configSha256,
resourcePolicySha256, operationStartedAtUnixMs, deadlineUnixMs,
clockModelVersion, processClockEpoch, operationStartMonotonicNs,
inputSha256, inputBytes, requestSha256, requestNonce,
releaseManifestSha256
```

Hash its canonical encoding. All fields must be nonnull where nullable in v2.

Use the existing application key and distinct domain:

```text
S8-NATIVE-RETRY-EVIDENCE-V1\0
```

Envelope hash and encoding follow the acceptance-envelope rule. The private verified-failure path alone issues it after authenticated non-timeout transient failure and proven disposal, with the same conservative clock validation and strict decision-before-deadline rule. It cannot issue success.

This closes the forged-error, late-failure and restart retry bypass without changing launcher taxonomy.

The state machine is:

```text
new operation
 -> durable unprepared DISPATCHING
 -> durable prepared DISPATCHING
 -> remote operation

verified timely native success
 -> volatile ACCEPTED_PENDING_DURABILITY
 -> durable SUCCEEDED

verified timely transient infrastructure failure + disposal
 -> durable FAILED with retryEvidence
 -> scheduleNativeRetry may advance job attempt 1 -> 2 once

permanent failure / true timeout
 -> FAILED if disposal is proven, otherwise UNKNOWN
 -> no retry

uncertain transport / disposal / interrupted dispatch
 -> UNKNOWN
 -> no retry
```

`scheduleNativeRetry()` must re-read and validate durable failure evidence under the transaction mutex. It also rechecks source, claim, owner, attempt, matching request/response/release and all companion attempts.

Validator failure requires validated Writer success from that same attempt. Advancing to attempt 2 and clearing the current claim is one durable transaction. A crash after that transaction may resume the already-authorized queued attempt 2; a crash before it does not infer retry permission from an error object.

There is no third attempt. Persistence failure after either logical success or a failure decision cannot create a retry.

### 11. Volatile acceptance and persistence failure

`ACCEPTED_PENDING_DURABILITY` exists only in private memory. It means:

- A has occurred.
- Its immutable event and signature are available or being completed.
- B has not yet returned successfully.
- No public success, Validator dispatch, publication or download is authorized by that volatile state.

The lifetime ends at successful B, process death, or an unrecoverable signing/persistence error.

After A, remove the native deadline commit fence. Preserve candidate-file fsync, atomic rename and directory fsync. Do not replace them with a deadline-bounded best effort.

On persistence failure:

- Return a generic non-success response with the existing support-safe reference mechanism.
- Never report a native transient failure.
- Never dispatch a replacement native operation.
- Do not overwrite a possibly surviving canonical success with an invented failure.
- Preserve repository poison semantics after uncertain canonical replacement.
- A remaining prepared `DISPATCHING` record is conservatively reconciled to `UNKNOWN`.

A crash before canonical evidence survives cannot recover success from memory, a temporary candidate, launcher status or object existence.

A complete valid canonical receipt that survives an interrupted commit may become authoritative only through the stabilization procedure below.

### 12. Repository lock, read and transaction API

Retain the OS-backed mutex and current owner-record protocol. Separate these meanings:

```text
state()/snapshot()
   externally authoritative, detached durable snapshot

transact(callback)
   exclusive synchronous mutation using private working state

private transaction view
   callback state only; never an external success snapshot
```

Concrete behavior:

1. Constructor/bootstrap acquires the repository lock before loading, migration, validation or exposure.
2. A transaction acquires the same lock and loads/stabilizes canonical state.
3. It retains an immutable **durable baseline** and creates a separate working copy.
4. The callback receives only that working copy.
5. `state()` called synchronously inside that transaction returns a deep-cloned, frozen durable baseline. It does not reacquire the mutex and does not return the working copy.
6. Transaction code needing its own writes uses the callback state explicitly.
7. External `state()` acquires the lock, stabilizes canonical state, validates, clones/freezes the result, releases the lock, then returns.
8. Nested mutation transactions fail immediately; they do not wait on themselves.
9. Thenable/async transaction callbacks are rejected. Working state is frozen when callback execution ends, including exceptional exits.
10. Transaction results are detached copies returned only after successful durable commit. No cached/current state aliases the callback's mutable graph.

This prevents both recursive-lock deadlock and uncommitted success leakage.

The inspected S2–S5 mutation paths pass working state to their internal mutation helpers. S6 transaction source checks read S5 state; S7 transaction source checks read S6/S5 state; those upstream collections are unchanged by the respective transaction. S8's final source check likewise reads unchanged upstream state. The durable-baseline reentrant read therefore preserves these source checks without broad service rewrites.

Required compatibility tests must prove that assumption at the actual S2–S7 workflows. A future transaction requiring read-your-own-writes must use its explicit working state; it must not change public `state()` back into a working-state accessor.

Writer death releases the OS mutex. Stale owner records are processed only while holding that mutex. Preserve existing conservative liveness rules: unknown/live owners are not stolen based on elapsed time.

The mutex inode must remain stable; do not unlink/recreate it as stale-lock recovery.

Readers during rename/directory-fsync wait or receive `PERSISTENCE_BUSY`. A same-process reentrant read may return the earlier durable baseline. Neither case exposes the replacement before durability.

### 13. Canonical crash stabilization

Every authoritative load under the lock performs:

```text
read canonical state.json
-> strict structural parsing
-> migration when required
-> collection and graph validation
-> acceptance/retry signature and binding validation
-> timely-decision validation
-> fsync canonical file
-> fsync containing directory
-> expose detached snapshot
```

Hold the mutex throughout. Open/read/fsync the same regular canonical file; reject symlink/type or identity substitution. No other repository writer may replace it during stabilization.

If migration changes state, use the ordinary durable candidate-write/fsync/rename/directory-fsync sequence before exposure.

| Surviving state | Result |
|---|---|
| Old canonical survives | Validate/stabilize old state; no newer success inferred |
| New complete canonical survives | Validate every proof and stabilize before exposure |
| Malformed/truncated canonical | `PERSISTENCE_FAILED`; no empty-state fallback |
| Valid timely v2 success | Consumable after stabilization |
| Missing/invalid success receipt | Validation failure; no success |
| Directory fsync was never acknowledged by dead writer | Successor performs stabilization; no extra persistent acknowledgement marker |
| Stray candidate/temp file | Never promoted or used as success evidence |

A fresh empty repository remains distinguishable from malformed state. An absent canonical file cannot authorize recovery from temporary files.

Any failed stabilization poisons that repository instance for authoritative reads/writes. Reopening a new instance retries locked canonical validation/stabilization; it does not bypass it.

### 14. Legacy v1 migration and quarantine

Add these StoreState fields:

```ts
s8NativeEvidenceVersion: 2;
s8NativeAttemptQuarantines: LegacyQuarantine[];
```

A missing evidence version selects the exclusive bootstrap migration. Any other supplied version is rejected.

Each quarantine record has exactly:

```ts
{
  schemaVersion: "s8-native-legacy-quarantine-v1";
  quarantineId: Uuid; // equal to original jobId
  reason: "LEGACY_NATIVE_ACCEPTANCE_UNPROVEN";
  migratedAt: Timestamp;
  admissionBlock: "NONE" | "RECONCILIATION_REQUIRED";
  originalJob: S8ExportJob;
  originalArtifact: S8Artifact;
  originalAttempts: Array<LegacyV1Attempt | NativeAttemptV2>;
  originalValidationReceipts: S8ValidationReceipt[];
}
```

Embedded legacy objects retain their original exact schema and values. Valid v2 objects are not allowed to evade validation merely by being placed in quarantine.

Migration runs after key configuration and while holding the repository lock, before service recovery or consumers:

- Validate legacy shapes and relationships.
- Quarantine every job containing a v1 native attempt.
- Also quarantine legacy jobs/artifacts claiming native-derived progress or publication without the required v2 proof.
- Preserve original job/artifact/attempt/receipt metadata in the quarantine record.
- Remove quarantined attempts from the active native-attempt collection.
- Change the affected active job and artifact together to `failed_terminal`, with `failureCode="S8_NATIVE_LEGACY_UNPROVEN"`.
- Clear active claim/owner/heartbeat fields.
- Keep idempotency records pointing to the terminal result.
- Retain existing object/hash/receipt metadata as audit data; it provides no success authority.
- Do not delete object bytes as part of this migration.
- Persist the migration and evidence version durably before readiness.

Specific dispositions:

| Legacy state | Current authority |
|---|---|
| `SUCCEEDED` | Quarantined; cannot publish, reuse or download |
| `FAILED` | Quarantined; no inherited retry entitlement |
| `DISPATCHING` | Quarantined; reconciliation-required admission block |
| `UNKNOWN` | Quarantined; reconciliation-required admission block |

Any legacy record with unproven disposal also retains the admission block.

Quarantine records are not active attempts and do not have fabricated v2 deadlines. Their admission block cannot be cleared merely by migration, elapsed time, process death or object inspection. Existing authenticated reconciliation requirements remain controlling; this G2 does not authorize a new operator reconciliation action.

Pristine legacy queued records with no native execution evidence may remain queued and subsequently create genuine v2 attempts. They do not acquire synthetic success.

### 15. Trusted success reader and consumer inventory

Add one proof-validation implementation in `s8-fbx-persistence.ts`, with two explicit uses:

```text
validateS8NativeAttemptSuccess(attempt, authoritativeContext, trust)
requireS8NativeSuccessPair(snapshotOrTransactionContext, jobId, attempt)
```

An external call accepts only a repository-issued durable snapshot. A transaction call uses its locked context and distinguishes baseline durable successes from newly proposed state.

The pair accessor returns immutable validated proof projections. It verifies both receipts, their graph bindings and their relationship to artifact/validation metadata. A raw `state === "SUCCEEDED"` expression does not grant authority.

Required consumer mapping:

| Existing boundary | Required proof |
|---|---|
| `writer()` return / `runClaimedExport()` Writer continuation | Durable Writer acceptance before staging |
| `nativeValidator()` / `beginNativeAttempt(VALIDATOR)` | Durable Writer proof; exact input and release handle |
| `runClaimedExport()` validation and publication construction | Matching Writer/Validator pair |
| `verifyPublishedObjects()` | Byte hashes/lengths matched to the pair |
| `verifyPublicationState()` | Pair plus existing publication, source, semantic and object checks |
| `commit()` | Pair and final source/current-publication-claim checks under lock |
| `verifyReuse()` | Valid pair and verified committed publication |
| `download()` | Same trusted publication proof and exact object readback |
| `createExport()` existing-idempotency and collision branches | Revalidate current durable result; never trust cached success JSON |
| `getExport()` / public artifact projection | No native-derived successful status without required proof |
| `recoverPending()` | Stabilized proofs before promotion/commit recovery |
| `reclaim()` | Claim transfer grants publication custody only |
| `resetAfterDeadClaim()` | Cannot reset/re-dispatch a job with native-attempt or quarantine history |
| `markUncertainNativeAttempts()` | No success reconstruction |
| `scheduleNativeRetry()` | Valid durable retry evidence; companion successes through accessor |
| `validateS8Graph()` | Enforce proof-dependent state relationships |
| API `handleS8()` export/status/download routes | Consume service projections; no independent success shortcut |
| `S8Client` committed download link | Display-only consumer of verified API status; server download independently validates |

For progress states: `staged` requires Writer proof; `validated`, `promoted` and `committed` require the pair. Purely queued/running state does not imply native success.

Recovery may use a new publication claim token. It must preserve the original acceptance claim tokens and require that the two native operations share their original attempt/claim. It never rewrites receipts to match a reclaimed publication claim.

### 16. Exact byte custody

The native client must privately copy and retain:

- Writer FBX output bytes.
- Writer auxiliary receipt bytes.
- Validator input FBX bytes.
- Validator output/readback bytes.

A capability owns those bytes; caller-owned mutable buffers are not its authority.

Before A, hash and verify those exact bytes. After B:

- Stage the original Writer auxiliary bytes, not `jsonBytes(written.receipt)`.
- Parse Writer metadata from those same bytes.
- Re-hash FBX and auxiliary data immediately before staging.
- Verify staged bytes through readback before Validator admission.
- Bind Validator input hash/length to the Writer receipt.
- Stage the original Validator output bytes.
- Compare parsed readback to the exact output representation.
- Recheck hashes/lengths against both acceptance receipts during promotion, publication validation, reuse and download.

The current native auxiliary/readback canonical JSON requirement remains. Parsing and canonical re-encoding may be used as a validation equality check; it does not replace the accepted byte buffer.

Semantic and publication receipts are application-generated objects and retain their existing canonical encoding. They cannot substitute for native-byte evidence.

**Continues in Part 3.**


## Run-130 exact G2 contract artifact — Part 3 of 3

Continuation:
- Part 1: #29:5906439248
- Part 2: #29:5906458530

### 17. Native, gateway and launcher impact

The application persistence change requires no native wire version change.

The existing request already carries the absolute deadline. The existing signed response binds the request hash, which transitively binds that deadline. Acceptance adds application-owned start and clock evidence without adding launcher-selected acceptance time.

Preserve unchanged:

- Native request/response/status version and signing domains.
- Gateway propagation and deadline checks.
- Launcher timeout, kill/reap/removal and response admission.
- Replay ledger semantics.
- Transient/permanent/uncertain taxonomy.
- Release, resource-policy and capacity bindings.
- UNKNOWN admission latch and complete reconciliation.
- Issue #70 ownership of real-host capacity and OPEN admission.

Application protocol helpers may change only to require the original deadline, tighten custody, and provide validation support. Native protocol, gateway and launcher files require regression evidence, not mutation.

### 18. Bootstrap and exact mutation ceiling

Startup order is mandatory:

```text
read runtime configuration
-> validate current/historical acceptance keys
-> construct repository with immutable public trust
-> acquire repository mutex
-> decode and validate existing evidence
-> exclusive legacy migration
-> canonical file/directory stabilization
-> complete repository graph validation
-> expose repository readiness
-> construct workflow services
-> native-attempt/publication recovery and reconciliation
-> evaluate existing native admission requirements
```

`startupReconciled` begins false. A supplied repository must prove it was initialized with the same trust configuration; dependency injection cannot bypass bootstrap.

No S8 success consumer runs before repository readiness. No successful migration or key initialization itself opens native admission.

The frozen ceiling is **16 existing files, no new files**:

| Classification | Exact path | Scope |
|---|---|---|
| MUTATE_REQUIRED | `src/lib/types.ts` | Acceptance/retry/v2/quarantine types and StoreState fields |
| MUTATE_REQUIRED | `src/lib/s8-fbx-persistence.ts` | Exact validators, migration, proof readers, graph/admission rules |
| MUTATE_REQUIRED | `src/lib/store.ts` | Locked bootstrap/snapshots, durable baseline, stabilization, alias/poison rules |
| MUTATE_REQUIRED | `src/lib/s8-native-protocol.ts` | Mandatory deadline custody and fixed-domain validation support; no wire bump |
| MUTATE_REQUIRED | `src/lib/s8-native-worker-client.ts` | Private capabilities, observation custody, exact buffers |
| MUTATE_REQUIRED | `src/lib/s8-fbx-config.ts` | Public verification keyset and key validation |
| MUTATE_REQUIRED | `src/lib/workflow.ts` | Configuration-before-repository bootstrap |
| MUTATE_REQUIRED | `src/lib/s8.ts` | Private issuer, A/B ordering, consumers, retry and recovery |
| MUTATE_REQUIRED | `tests/s8-worker.test.ts` | Acceptance, clock, signing, retry and boundary tests |
| MUTATE_REQUIRED | `tests/s8-persistence.test.ts` | Schemas, keys, migration and canonical recovery |
| MUTATE_REQUIRED | `tests/s8-publication.test.ts` | Real verified-protocol fixture path, pair/byte/publication coverage |
| MUTATE_REQUIRED | `tests/s8-api.test.ts` | Consequential status/replay/download rejection and positive controls |
| MUTATE_REQUIRED | `tests/s8-native-admission.test.ts` | Quarantine/UNKNOWN/bootstrap admission behavior |
| MUTATE_REQUIRED | `tests/g3.test.ts` | Shared repository reader/transaction/crash regressions |
| MUTATE_REQUIRED | `docs/ARCHITECTURE.md` | A/B/C, trust, migration and reader semantics |
| MUTATE_REQUIRED | `docs/G2_S8_NATIVE_WORKER_CONTRACT.md` | Canonical executable contract and validation obligations |

Additional classifications:

| Classification | Paths |
|---|---|
| REGRESSION_ONLY | `src/lib/s8-fbx-worker.ts`, `src/lib/api.ts`, `app/components/S8Client.tsx` |
| REGRESSION_ONLY | Existing S2–S7 services, persistence validators and tests |
| REGRESSION_ONLY | Native common protocol/admission, gateway and launcher implementations and suites |
| REGRESSION_ONLY | Native process runner, validator, Writer regression and existing CI workflow |
| NO_CHANGE | Resource-policy values, capacity architecture, deployment files, images, secrets/environment values, package manifests/lockfile, vendored code, source geometry/profile semantics |

Existing test files may contain child-process fixture entry modes for crash tests; no separate test-helper file is required.

Any required mutation outside these 16 paths is a scope finding for Web, not inherited permission from the earlier 76-path ceiling.

### 19. Deterministic oracle matrix

Every row must exercise the production acceptance/persistence/consumer path, with ephemeral test keys and controlled raw native frames. Helper-only tests are supplemental.

| ID | Deterministic stimulus | Required result |
|---|---|---|
| A | Response and A before D; hold real directory fsync until clock exceeds D | Valid durable `SUCCEEDED`; no timeout reclassification |
| B | Final effective acceptance reading equals D | Timeout; zero acceptance receipts; no continuation |
| C | Final acceptance reading exceeds D | Same non-success result |
| D | Kill after A before durable success mutation | No recovered success; no recreated acceptance or retry |
| E | Kill during candidate write or candidate fsync | Candidate never promoted; old canonical controls |
| F | Kill after rename before directory fsync | Surviving valid canonical is exposed only after successor stabilization; invalid canonical fails |
| G | Persist after D, restart | Original timely receipt remains valid |
| H | Missing, corrupt, wrong-domain, wrong-signature or unknown-key receipt | No authoritative success |
| I | Supply timing/verified flags/hashes through JSON, forged result objects, constructor error objects or serialized capabilities | No valid acceptance/retry authority |
| J | Each v1 state, including committed artifact dependencies | Exact quarantine disposition; no legacy download/reuse |
| K | Independent reader process during rename/fsync barrier | Wait or busy error; no unsynchronized success |
| L | Transaction reads plus retained callback/result references | No deadlock; public read sees baseline; no mutable alias changes authority |
| M | Timely A followed by slow/failed persistence | Zero extra native dispatches and no transient retry |
| N | True timeout, including forward-then-backwards wall movement | Latched nonretryable outcome |
| O | Valid timely signed transient failure and proven disposal | Exactly one durable attempt-2 schedule; no third attempt |
| P | Writer succeeds on time, Validator reaches its own deadline | Writer proof does not authorize Validator success |
| Q | Missing/mismatched/swapped pair across job, artifact, attempt, claim or release | Publication, replay, status success, reuse and download reject |
| R | Mutate FBX, Writer auxiliary, Validator input or readback after verification | Byte mismatch before use; zero successful publication/download |
| S | Rotate signing key with historical public key retained; then remove/collide/mismatch keys | Retained history verifies; invalid configuration fails closed |
| T | Backwards wall time, fractional/unsafe values, monotonic regression, overflow, altered epoch/witness | Valid conservative case passes; malformed/inconsistent evidence fails |
| U | Reclaim publication claim after valid pair survives | Existing proof can finish valid publication; receipts remain unchanged |
| V | Source/claim changes while waiting for acceptance mutex | Final authoritative check rejects; no A |
| W | Replay one authentic receipt into a second tuple or duplicate acceptance ID | Graph validation rejects |
| X | Post-A persistence exception followed by poison/reopen | Old canonical gives non-success or surviving valid canonical stabilizes; neither path dispatches again |

Positive controls accompany each rejection family: same boundary, valid proof/bytes/configuration, successful expected effect.

For A, D–G, K, L and X, use a real Linux filesystem and actual OS mutex, file fsync, rename and directory fsync. Use two processes and explicit barriers, not timing sleeps alone.

A delay hook must eventually execute the real fsync. A failure hook may throw to test failure, but cannot count as successful durability evidence. A no-op `syncDirectory` fixture cannot establish these cases.

Record child exit/kill point, canonical content identity, lock behavior, actual syscall completion/failure and consumer outcome. Process-kill tests establish process-crash recovery; do not label them physical power-loss certification.

### 20. Required G3 floor, challenge closure and disposition

After explicit Web admission, the successor must pass:

1. Focused acceptance/clock/key/migration/locking tests in the named files.
2. Integrated S8 publication/API/admission tests using actual verified protocol paths.
3. Shared repository regressions, including S2–S7 lifecycle/source/reentrancy behavior.
4. All native JavaScript suites, including `native/s8-worker-common/admission.test.mjs`.
5. TypeScript typecheck.
6. Full repository test suite.
7. Writer contract regression.
8. Python syntax checks.
9. Production application build.
10. Existing secret/preflight and workflow guardrails.
11. Native process-runner build and all 20 registered runner contract tests.
12. Native validator build, CTest and executable self-test.
13. Linux durability oracle evidence.
14. Canonical Git identity, scoped diff and author/committer checks.
15. Exact-successor hosted S8 CI, all five checks.
16. Fresh Sol Max challenge against the exact published successor SHA.

The inherited commands include:

```sh
pnpm exec tsx --test \
  tests/s8-worker.test.ts \
  tests/s8-persistence.test.ts \
  tests/s8-publication.test.ts \
  tests/s8-api.test.ts \
  tests/s8-native-admission.test.ts

pnpm exec tsx --test tests/g3.test.ts

node --test \
  native/s8-worker-common/protocol.test.mjs \
  native/s8-worker-common/admission.test.mjs \
  native/s8-worker-launcher/capacity.test.mjs \
  native/s8-worker-launcher/ledger.test.mjs \
  native/s8-worker-launcher/container-runtime.test.mjs \
  native/s8-worker-launcher/result.test.mjs \
  native/s8-worker-gateway/gateway.test.mjs

pnpm exec tsc --noEmit --pretty false
pnpm test
python3 scripts/s8/blender_writer_contract_regression.py
python3 -m py_compile blender/s8-fbx-writer/writer.py scripts/s8/*.py
pnpm run build
git diff --check
```

Native builds must use disposable carrier directories:

```sh
cmake -S native/s8-process-runner -B "$RUNNER_TEMP/s8-runner" -DCMAKE_BUILD_TYPE=Release
cmake --build "$RUNNER_TEMP/s8-runner" --config Release --parallel
ctest --test-dir "$RUNNER_TEMP/s8-runner" -N
ctest --test-dir "$RUNNER_TEMP/s8-runner" -R '^s8-runner\.' --output-on-failure

cmake -S native/s8-fbx-validator -B "$RUNNER_TEMP/s8-validator" -DCMAKE_BUILD_TYPE=Release
cmake --build "$RUNNER_TEMP/s8-validator" --config Release --parallel
ctest --test-dir "$RUNNER_TEMP/s8-validator" --output-on-failure
"$RUNNER_TEMP/s8-validator/s8-fbx-validator" --self-test
```

Require exactly 20 registered runner cases, not merely a successful empty CTest invocation. Preserve the workflow's secret-scanner failure/positive controls and exact-head verification.

The later Git identity must use:

```text
Author=WJ <10020253+weijunswj@users.noreply.github.com>
Committer=WJ <10020253+weijunswj@users.noreply.github.com>
```

Required hosted membership:

- S8 pinned actionlint linux/amd64.
- S8 pinned actionlint windows/amd64.
- S8 static and TypeScript floor.
- S8 native validator and process runner.
- S8 native worker repository prepublication.

The strict G3 prepublication adversarial challenge remains required; the requested fresh challenge against the published successor SHA additionally binds the published candidate. Neither may use the old head's green checks as successor proof.

Internal challenge/refinement closed these counterexamples:

- Moving only the fsync deadline check would still accept incompletely verified native output.
- An exported timestamp-taking signer would authenticate forged timing.
- Recursively locking `state()` would deadlock; returning transaction state would leak uncommitted authority.
- Loading a surviving rename without stabilization would expose unacknowledged durability.
- Preserving v1 `SUCCEEDED` would leave publication/reuse bypasses.
- A public signed-failure error constructor plus state flags would manufacture retry authority.
- Reserializing Writer metadata could break exact-byte custody.
- Requiring acceptance claim tokens to equal a later recovery claim would incorrectly invalidate legitimate publication recovery.

The resulting contract keeps one deadline, one application signing authority, the existing native protocol, existing durability guarantees and the original retry ceiling. It is feasible within one materially narrowed R127 attempt 4, subject to its required implementation and challenge evidence.

Requirement disposition is complete:

- request items 1–14 and 16: `IMPLEMENT_IN_THIS_CANDIDATE`
- item 15: `ALREADY_SATISFIED_WITH_EXACT_EVIDENCE` plus regression validation
- API/UI consumer behavior: `UNCHANGED_REQUIRED_CONSUMER`
- items 17–20: frozen by this packet
- real-host provisioning and OPEN admission: `OUT_OF_SCOPE_WITH_EXPLICIT_CONTINUING_OWNER`, issue #70

No repository/source files were changed, no tests or builds were run, and no commit, push or GitHub governance write occurred during Run-130.

**Run-130 G2 terminal disposition: G2_PASS. Web must explicitly admit attempt 4 before implementation begins.**

Web subsequently admitted attempt 4 at #29:5906103810.
