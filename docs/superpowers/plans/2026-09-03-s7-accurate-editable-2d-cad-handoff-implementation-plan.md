# S7 G2: Accurate editable 2D CAD handoff implementation plan

Status: exact implementation map for the accepted S7 G2 contract.

The companion specification defines stable architecture and geometry. This
plan is the single detailed definition of persisted record shapes, API routes,
storage formulas, state transitions, implementation files, and G3 validation.
It must be read with the specification as one canonical pair.

## 1. Authority and implementation boundary

Implement only after the clean docs publication is accepted and merged. The
authority is `DL-SD-S7-G1-001: ACCEPTED` plus
`DL-SD-S7-G2-001: ACCEPTED`, G1 receipt `5511994922`, and controlling G2 Web
correction receipt `5513004637`. The docs-only publication base is main
`877a6ee81741be041f71bbcf36d385c64fda050d` with tree
`4e73fd4675c63db80309daa5553ad194d35e441d`.

This map does not authorise implementation in the G2 publication. It defines
the later G3 work only. No new runtime dependency is required. No product
StoreState collection, API, type, helper, fixture, or file may be added outside
this map without a later Web amendment.

## 2. Exact production and test file map

Existing bounded modifications:

```
src/lib/types.ts
src/lib/store.ts
src/lib/workflow.ts
src/lib/api.ts
package.json
```

New production files:

```
src/lib/s7-geometry.ts
src/lib/s7-dxf-writer.ts
src/lib/s7-dxf-readback.ts
src/lib/s7-persistence.ts
src/lib/s7-cad.ts
src/lib/s7-telemetry.ts
app/components/S7Client.tsx
app/projects/[projectId]/s7/page.tsx
```

Focused tests:

```
tests/s7-geometry.test.ts
tests/s7-dxf.test.ts
tests/s7-persistence.test.ts
tests/s7-api.test.ts
tests/s7-security.test.ts
tests/s7-handoff.test.ts
```

Fixtures:

```
tests/fixtures/s7/golden-plan-minimal.dxf
tests/fixtures/s7/hand-authored-valid-ac1015.dxf
```

Do not add `src/lib/s7-publication.ts`. Do not silently split the accepted
tests or fixtures into a larger map. `package.json` may be touched only for
the accepted commands or test wiring and must not add a new runtime dependency.

## 3. Exact persisted contracts

Use the existing `UUID`, `Sha256`, and `Timestamp` aliases from
`src/lib/types.ts`. The following are the exact accepted persisted identities.

### Source stamp

```ts
type S7SourceStamp = {
  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  validationReceiptId: UUID;
  validationHash: Sha256;
  s6HandoffSchemaVersion: "s6-to-s7-handoff-v1";
  handoffDigest: Sha256;
};
```

The stamp is captured from one live-current accepted S6 revision and is
revalidated at every source-fenced boundary. Snapshot eligibility booleans are
not part of this source authority.

### Export record

```ts
type S7CadExport = {
  schemaVersion: "s7-cad-export-v1";

  artifactId: UUID;
  projectId: UUID;
  jobId: UUID;

  source: S7SourceStamp;
  inputHash: Sha256;

  dxfVersion: "s7-dxf-r2000-ascii-v1";
  worldToPlanVersion: "s7-world-to-plan-v1";

  format: "dxf";
  mimeType: "application/dxf";
  downloadFileName: "swooshz-s7-plan.dxf";

  status:
    | "queued"
    | "running"
    | "staged"
    | "promoted"
    | "committed"
    | "stale"
    | "superseded"
    | "failed_retryable"
    | "failed_terminal"
    | "aborted";

  publicationPhase:
    | "none"
    | "staged"
    | "promoted"
    | "committed"
    | "aborted";

  attempt: 1 | 2;
  retryOfArtifactId: UUID | null;

  manifestId: UUID;
  manifestHash: Sha256 | null;

  readbackReceiptId: UUID | null;
  readbackHash: Sha256 | null;

  sha256: Sha256 | null;
  byteSize: number | null;

  privateFinalStorageKey: string;
  privateStagingStorageKey: string;

  failureCode: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  committedAt: Timestamp | null;
  staleAt: Timestamp | null;
  supersededAt: Timestamp | null;
};
```

`manifestId` is durable identity even before the manifest hash is available.
The fixed public download name is part of this record and is not derived from
project identity or profile version.

### Job record

```ts
type S7CadJob = {
  schemaVersion: "s7-cad-job-v1";

  jobId: UUID;
  projectId: UUID;
  artifactId: UUID;

  source: S7SourceStamp;
  inputHash: Sha256;

  idempotencyKey: string;

  status: S7CadExport["status"];
  attempt: 1 | 2;
  retryOfJobId: UUID | null;

  claimToken: UUID | null;
  ownerProcessId: string | null;

  claimedAt: Timestamp | null;
  heartbeatAt: Timestamp | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  terminalAt: Timestamp | null;
};
```

`ownerProcessId` is a string identity. Reclamation requires a definitely dead
owner and a claim-token/heartbeat check; live or uncertain ownership is never
reclaimed.

### Idempotency record

```ts
type S7CadIdempotency = {
  schemaVersion: "s7-cad-idempotency-v1";

  projectId: UUID;
  operation: "export";

  idempotencyKey: string;
  inputHash: Sha256;
  source: S7SourceStamp;

  jobId: UUID;
  artifactId: UUID;

  createdAt: Timestamp;
};
```

The HTTP `Idempotency-Key` is a bounded opaque string, not a UUID field. The
same key plus the exact accepted request, source, and input replays the linked
job and artifact. Any difference returns `S7_IDEMPOTENCY_CONFLICT`. The
implementation never parses this key as a UUID. A separate
`requestReferenceId`, when required by existing API/error conventions, remains
a UUID and is never substituted for the idempotency key.

### Manifest record and private bytes

The product store keeps a durable manifest linkage with this exact identity
set:

```
schemaVersion = s7-cad-manifest-v1
manifestId
projectId
artifactId
S7SourceStamp
worldToPlanVersion = s7-world-to-plan-v1
dxfVersion = s7-dxf-r2000-ascii-v1
manifestHash
manifestByteSize
private manifest object identity
```

The immutable private JSON bytes are the complete correspondence authority.
They contain deterministic source-object, parent-object, identity-key, role,
part-index, geometry-state, intended-layer, and emitted-entity correspondence
for the artifact. `sourceObjectId` and `parentObjectId` remain opaque stable S6
identifiers and are not restricted to UUID syntax. The durable record never
publishes the private object identity.

### Readback receipt

The durable record is distinct from the raw parser result:

```ts
type S7CadReadbackReceipt = {
  schemaVersion: "s7-cad-validation-receipt-v1";

  receiptId: UUID;
  projectId: UUID;
  artifactId: UUID;

  source: S7SourceStamp;
  manifestId: UUID;
  manifestHash: Sha256;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfVersion: "s7-dxf-r2000-ascii-v1";

  sha256: Sha256;
  byteSize: number;
  entityCount: number;
  correspondenceResult: "pass" | "fail";
  outcome: "pass" | "fail";
  issues: string[];
  checkedAt: Timestamp;

  receiptHash: Sha256;
  readbackVersion: "s7-cad-readback-v1";
};
```

`receiptHash` is SHA-256 over canonical receipt content with `receiptHash`
blank. A durable PASS binds the exact DXF hash/size, entity count, complete
manifest correspondence, source stamp, and final object integrity.

### Product StoreState

The exact S7 collections in Product StoreState are:

```
s7CadExports
s7CadJobs
s7CadIdempotency
s7CadManifests
s7CadReadbackReceipts
```

Telemetry is derived from these records and lifecycle events. It is not an
additional persisted product collection.

## 4. Exact API surface and disclosure rules

The exact routes are:

```
GET  /projects/{projectId}/s7
POST /projects/{projectId}/s7/exports
GET  /projects/{projectId}/s7/exports/{artifactId}
GET  /projects/{projectId}/s7/exports/{artifactId}/download
GET  /projects/{projectId}/s7/telemetry
GET  /projects/{projectId}/s7/handoff
```

The POST body is exact empty JSON `{}` and requires an opaque
`Idempotency-Key` header. The handoff route has no artifact ID; it selects the
current eligible committed artifact under live source, readback, and integrity
rules. The handoff route is exactly `GET /projects/{projectId}/s7/handoff`.

Authorization runs before existence, project, artifact, or storage disclosure
on every route. Metadata, download, telemetry, and handoff must not disclose
private storage identities. Download and handoff require a live-current
accepted S6 source, committed immutable artifact, passing internal readback,
exact hashes and sizes, and exact final objects.

## 5. Exact storage formulas

```
Final DXF:
projects/<projectId>/s7/exports/<artifactId>/swooshz-s7-plan.dxf

Staging DXF:
projects/<projectId>/s7/staging/<jobId>/<claimToken>/swooshz-s7-plan.dxf

Final manifest:
projects/<projectId>/s7/manifests/<manifestId>.json

Staging manifest:
projects/<projectId>/s7/staging/<jobId>/<claimToken>/manifest.json
```

The final manifest path is separate from the final DXF path. Final objects are
private, immutable, and never overwritten. The private storage-key fields in
the export record are derived from these formulas and are never returned to an
unauthorized caller.

The fixed public download filename is:

```
swooshz-s7-plan.dxf
```

It contains no project ID and no profile-version suffix.

## 6. Exact state machine

Primary path:

```
queued -> running -> staged -> promoted -> committed
```

One retry maximum:

```
running/staged/promoted
  -> failed_retryable
  -> queued
```

The retry creates attempt 2 only. Before finality:

```
queued/running/staged/promoted -> stale
```

This occurs when the captured source becomes invalid. After finality:

```
committed -> superseded
```

This occurs when a newer accepted S6 revision becomes current. `stale` and
`superseded` are not collapsed. Terminal/no-return states are:

```
stale
superseded
failed_terminal
aborted
```

Committed may only leave through the explicit committed-to-superseded
historical transition. Maximum attempts are 2, and retryable recovery never
creates attempt 3.

## 7. Geometry and writer implementation phases

Each phase must preserve the specification's geometry and security rules:

1. Extend the accepted types and store with the exact records and five S7
   collections above. Add source admission, live fencing, idempotency replay,
   opaque claim ownership, heartbeat, and bounded recovery.
2. Implement `s7-geometry.ts` with the S6 X -> Y -> Z Euler order, full
   hierarchy composition, independent matrix oracle, exact rect hulls,
   profile union boundaries, round-prism analytic silhouettes, deterministic
   degeneracies, and fail-closed ambiguity handling.
3. Implement `s7-dxf-writer.ts` for the AC1015 ASCII profile, exact numeric
   bytes, complete model-space scaffold, deterministic handle allocation,
   extents, locked layers, entity order, dimensions, labels, XDATA, and private
   manifest bytes. Do not add a runtime dependency.
4. Implement `s7-dxf-readback.ts` as an independent strict parser for
   `s7-cad-readback-v1`. Validate sections, headers, tables, owners, handles,
   layers, entity geometry, ASCII/text limits, XDATA limits, resource bounds,
   canonical numeric forms, and manifest correspondence. Generate the durable
   `s7-cad-validation-receipt-v1` only after the independent checks pass.
5. Implement `s7-persistence.ts`, `s7-cad.ts`, `src/lib/api.ts`, and the S7
   client/page for private staging, promotion, commit, retry, stale fencing,
   supersession, auth-before-disclosure, download, telemetry, and handoff.
   Keep release CAD evidence outside Product StoreState and runtime DTOs.
6. Add the six focused tests and two accepted fixtures. Include adversarial
   tests for source movement, authorization ordering, idempotency conflicts,
   ownership recovery, stale versus superseded, private-path disclosure,
   malformed DXF, resource limits, exact projection, and flat S7-to-S8
   identity.

The S7 client exposes only authorized project state and fixed public download
metadata. It does not expose private storage identities or turn governance
tooling status into product state.

## 8. Exact S7-to-S8 runtime DTO

The runtime handoff is the accepted flat identity contract:

```ts
type S7ToS8Handoff = {
  schemaVersion: "s7-to-s8-handoff-v1";

  projectId: UUID;

  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;

  s7ArtifactId: UUID;
  s7ArtifactHash: Sha256;
  s7ArtifactByteSize: number;

  manifestId: UUID;
  manifestHash: Sha256;

  readbackReceiptId: UUID;
  readbackHash: Sha256;

  dxfVersion: "s7-dxf-r2000-ascii-v1";
  worldToPlanVersion: "s7-world-to-plan-v1";

  coordinateConvention: "booth-local-right-handed-v1";

  dxfIsNot3DAuthority: true;
  s8MustReadAcceptedS6Model: true;
};
```

The handoff is disclosed only for the current eligible committed artifact with
live source/readback/integrity checks. It is a typed correspondence boundary;
S8 must use the accepted S6 model as 3D authority.

## 9. Exact resource limits

All writer, parser, persistence, and API paths enforce these bounds:

```
DXF bytes:                  8,000,000
DXF lines:                  200,000
group/value line:           512 bytes
entities:                   4,096
vertices:                   16,384
layers:                     32
table records:              64
label length:               120 code points
XDATA/entity:               2,048 bytes
XDATA strings/entity:       16
manifest bytes:             4,000,000
readback receipt bytes:     256,000
CAD release evidence:       32,768 bytes
plan coordinate magnitude:  1,000,000,000 mm
recovery items/pass:        256
attempts:                   2
```

The coordinate magnitude is a defensive parser/output ceiling only; source
authority remains the accepted S6 schema and live source. Limit breaches fail
closed without truncation or fabricated geometry.

## 10. Focused and later G3 validation commands

The exact focused G3 command is:

```
pnpm exec tsx --test tests/s7-geometry.test.ts tests/s7-dxf.test.ts tests/s7-persistence.test.ts tests/s7-api.test.ts tests/s7-security.test.ts tests/s7-handoff.test.ts
```

Then run:

```
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --prod
git diff --check
```

The full suite is:

```
pnpm test
```

The current publication is docs-only, so it does not run product tests. Its
minimum validation is the exact changed-path proof, contradiction/literal
sweep, secret-value audit, and `git diff --check` described in the publication
packet. G3 is not authorised until this pair is accepted and merged.

## 11. G3/G4 boundary

G3 may implement the map after exact docs acceptance and canonical merge. G3
must return any materially necessary helper outside this map to Web rather
than silently expanding it. G4/finality additionally requires representative,
version-pinned local CAD open/import/edit/save/reopen evidence for this exact
writer/profile and fixtures. No cloud CAD, S8/S9 implementation, Ready
transition, merge, or tooling-HOLD clearance is included in this plan.
