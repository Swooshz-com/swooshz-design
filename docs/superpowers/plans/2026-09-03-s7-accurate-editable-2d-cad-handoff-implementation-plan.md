# S7 - Accurate plan + editable 2D CAD handoff Implementation Plan

> For later G3 workers: this is the accepted S7 implementation contract. Execute it task-by-task only after Web has canonically merged this documentation step and explicitly activates G3. The current G2 worker is authorized to publish documentation only; no task below authorizes implementation in the current branch.

Goal: Add a bounded S7 workflow that reads one current accepted S6 handoff, independently composes its world transforms, emits exact editable plan geometry in deterministic ASCII AutoCAD 2000 DXF, proves raw bytes and private-manifest correspondence, and publishes an immutable private artifact with stale fencing, idempotency, recovery, and a typed S7-to-S8 boundary.

Architecture: S7 is a read-only S6 consumer. A source reader obtains s6-to-s7-handoff-v1, computes a source binding and handoff digest, and re-reads it at every lifecycle and disclosure boundary. An independent geometry module matches the existing S6 full-Euler order and parent hierarchy composition without treating S6 local footprints as world geometry. A custom bounded writer emits s7-dxf-r2000-ascii-v1 with the required AC1015 model-space BLOCK_RECORD/BLOCKS scaffold. An independent raw-DXF parser reads only that profile and compares parsed entities with a private immutable manifest. The S7 service uses the existing JsonRepository, PrivateObjectStore, authorization, hash, and idempotency primitives; no standalone S7 publication module is introduced.

Tech stack: the existing TypeScript/Next.js application, JsonRepository, PrivateObjectStore, AppError, privateStorageKey, sha256, and existing canonical JSON helpers where their contracts apply. No new runtime dependency, CAD SDK, cloud CAD service, DWG converter, or provider call.

---

## Accepted G1/G2 authority and boundary

The accepted decision locks are:

DL-SD-S7-G1-001: ACCEPTED
DL-SD-S7-G2-001: ACCEPTED

Authority receipts:

| Authority | Exact value |
|---|---|
| Programme parent | #1 |
| S7 child | #28 - S7 Accurate plan + editable 2D CAD handoff |
| Terminal S6 | #11 CLOSED / COMPLETED |
| Terminal S6 merged PR | #37 |
| Terminal S6 accepted G4 head | 5c2927a19ce57952fa999443f7792a67cd40e73e |
| Canonical base commit | 877a6ee81741be041f71bbcf36d385c64fda050d |
| Canonical base tree | 4e73fd4675c63db80309daa5553ad194d35e441d |
| Accepted G1 | DL-SD-S7-G1-001: ACCEPTED |
| Web G1 child receipt | 5511994922 |
| Web G1 parent transition | 5511998419 |
| Accepted G2 | DL-SD-S7-G2-001: ACCEPTED |
| Web G2 controlling adjudication/corrections | 5513004637 |
| Web G2 parent transition | 5513007401 |

This plan is an accepted architecture/implementation contract, not a task-log proposal. It does not self-accept an implementation, clear a tooling HOLD, mark a PR Ready, merge a branch, activate G3, or begin G4.

The controlling correction from Web receipt 5513004637 is included here:

- AC1015 output uses HEADER, TABLES, BLOCKS, ENTITIES, EOF in that order.
- TABLES includes LTYPE, LAYER, APPID, and BLOCK_RECORD, with LTYPE before LAYER.
- BLOCK_RECORD contains deterministic *MODEL_SPACE and *PAPER_SPACE entries.
- BLOCKS contains matching minimal block definitions.
- Every graphical entity has deterministic handle 5, model-space BLOCK_RECORD owner 330, AcDbEntity, Model, locked layer, ByLayer lineweight, and its required entity-specific subclass/data.
- The earlier fixed entity-handle proposal is superseded by the allocation map below covering table controls, table entries, block records, block definitions, and entities.
- External CAD evidence is gate/release evidence for the writer/profile, not a manual per-export runtime dependency.
- S7CadExport has no cadEvidenceId or cadEvidenceStatus, and StoreState has no s7CadEvidence collection.
- TOOLING_HOLD: YES is nonblocking for G3 implementation/internal validation and blocks only G4 acceptance/finality; it consumes no repair budget.

No S7 product/runtime/test file is changed by this G2 documentation publication. G3 starts only after Web's verified docs-only merge and activation.

## Repository file map

The implementation branch must start from canonical base commit 877a6ee81741be041f71bbcf36d385c64fda050d. The verified base contains the S6 implementation, typed S6-to-S7 handoff, shared JSON repository/private object store, and existing stage API/workflow conventions. This is the minimum production/test surface; it is not permission to widen scope.

### Existing files to modify

| File | Responsibility after S7 | Exact bounded change |
|---|---|---|
| src/lib/types.ts | S7 constants, layers, source binding, manifest, export/job/readback/idempotency records, public DTOs, telemetry, and StoreState fields | Add only the types below. No per-export external-CAD evidence fields or product evidence collection. |
| src/lib/store.ts | Backward-compatible S7 array defaults and load/transact graph validation hooks | Add empty S7 arrays and call validateS7Collections/validateS7Graph after existing stage validation. No automatic repair. |
| src/lib/workflow.ts | Shared S7 service construction | Add one S7CadService using the existing repository/object store, S6 handoff reader, clock, UUID, worker/liveness hooks, and no second store. |
| src/lib/api.ts | Auth-first S7 path recognition, exact DTO parsing, safe errors, download headers, and dispatch | Add isS7Path, authorizedS7Service, handleS7, and the exact routes below. Reuse the existing authorization boundary. |
| package.json | Focused S7 tests in the existing test script | Append named S7 tests without removing S1-S6 tests or adding a runner/dependency. |

These existing files are read-only S7 inputs unless Web later authorizes a named compatibility correction:

~~~text
src/lib/s6-handoff.ts
src/lib/s6-source.ts
src/lib/s6-canonical.ts
src/lib/s5.ts
app/api/[[...path]]/route.ts
pnpm-lock.yaml
~~~

S7 calls the existing S6 handoff boundary and never adds an S6 mutation or duplicate S6 source adapter.

### New production files

| File | Single responsibility | Required exported surface |
|---|---|---|
| src/lib/s7-geometry.ts | Independent source normalization, affine composition, exact projected-solid boundaries, quantization, and diagnostics | S7SourceGeometry, S7ProjectedEntityGeometry, readS7WorldGeometry, projectS7Solid, quantizeS7Length, classifyS7RoundProjection |
| src/lib/s7-dxf-writer.ts | Deterministic AC1015 ASCII serialization and private manifest construction | S7DxfBuild, buildS7Dxf, S7_DXF_PROFILE_VERSION, handle allocation helpers |
| src/lib/s7-dxf-readback.ts | Strict independent raw-DXF tokenizer/parser/profile validator and manifest correspondence checker | readS7Dxf, S7ReadbackResult, S7ReadbackIssue |
| src/lib/s7-persistence.ts | Exact S7 record validation and cross-record graph invariants | validateS7Collections, validateS7Graph |
| src/lib/s7-cad.ts | Source-fenced generation, idempotency, two-attempt jobs, staging/promotion/commit, recovery, metadata, download, and S7-to-S8 handoff | S7CadService and the service methods below |
| src/lib/s7-telemetry.ts | Privacy-minimized durable S7 counters and unavailable-cost semantics | buildS7Telemetry |
| app/components/S7Client.tsx | Persisted export status/download UI | createS7Client, S7Screen |
| app/projects/[projectId]/s7/page.tsx | Thin route page | S7Screen route |

Do not add src/lib/s7-publication.ts. Publication is a bounded phase in S7CadService using existing PrivateObjectStore.putExact and promoteExact. A separate module requires a later Web-authorized proof that existing primitives are insufficient.

### New test files and fixtures

| Path | Required coverage |
|---|---|
| tests/s7-geometry.test.ts | Transform parity, rect/profile/round exact projections, rank cases, quantization, open sides, unknowns, and out-of-envelope preservation |
| tests/s7-dxf.test.ts | Byte determinism, exact sections/tables/blocks/entities, handles, HANDSEED, layers, XDATA, independent raw readback, hand-authored profile, and golden fixture |
| tests/s7-persistence.test.ts | Legacy defaults, exact keys/literals, cross-record lineage, no overwrite, no evidence collection, malformed-state rejection |
| tests/s7-api.test.ts | Auth-first construction, exact routes/DTOs, statuses, safe errors, headers, metadata, download, telemetry, and handoff |
| tests/s7-security.test.ts | Cross-project isolation, path traversal, XDATA/text injection, resource bounds, no secrets, and no external-CAD runtime coupling |
| tests/s7-handoff.test.ts | Source/artifact/manifest/readback identity, flat S7-to-S8 DTO, currentness, correspondence, and authority booleans |

The only later implementation fixtures are:

~~~text
tests/fixtures/s7/golden-plan-minimal.dxf
tests/fixtures/s7/hand-authored-valid-ac1015.dxf
~~~

These are later implementation fixtures, not generated artifacts in this G2 branch.

## Version strings, limits, and storage model

Add these exact constants without duplicate definitions:

~~~ts
export const S7_SOURCE_FENCE_SCHEMA_VERSION = "s7-source-fence-v1" as const;
export const S7_CAD_EXPORT_SCHEMA_VERSION = "s7-cad-export-v1" as const;
export const S7_CAD_JOB_SCHEMA_VERSION = "s7-cad-job-v1" as const;
export const S7_CAD_MANIFEST_SCHEMA_VERSION = "s7-cad-manifest-v1" as const;
export const S7_CAD_READBACK_SCHEMA_VERSION = "s7-cad-readback-v1" as const;
export const S7_CAD_VALIDATION_RECEIPT_SCHEMA_VERSION = "s7-cad-validation-receipt-v1" as const;
export const S7_CAD_IDEMPOTENCY_SCHEMA_VERSION = "s7-cad-idempotency-v1" as const;
export const S7_DXF_PROFILE_VERSION = "s7-dxf-r2000-ascii-v1" as const;
export const S7_WORLD_TO_PLAN_VERSION = "s7-world-to-plan-v1" as const;
export const S7_TO_S8_HANDOFF_SCHEMA_VERSION = "s7-to-s8-handoff-v1" as const;
export const S7_TELEMETRY_SCHEMA_VERSION = "s7-telemetry-v1" as const;
export const S7_XDATA_APPID = "SWOOSHZ_S7" as const;

export const S7_QUANTIZATION_MM = 0.01;
export const S7_PLAN_COORDINATE_CEILING_MM = 1_000_000_000;
export const S7_MAX_DXF_BYTES = 8_000_000;
export const S7_MAX_DXF_LINES = 200_000;
export const S7_MAX_GROUP_VALUE_LINE_BYTES = 512;
export const S7_MAX_ENTITIES = 4096;
export const S7_MAX_VERTICES = 16_384;
export const S7_MAX_LAYERS = 32;
export const S7_MAX_TABLE_RECORDS = 64;
export const S7_MAX_XDATA_BYTES_PER_ENTITY = 2_048;
export const S7_MAX_XDATA_STRINGS_PER_ENTITY = 16;
export const S7_MAX_LABEL_CODE_POINTS = 120;
export const S7_MAX_MANIFEST_BYTES = 4_000_000;
export const S7_MAX_READBACK_RECEIPT_BYTES = 256_000;
// Release/G3/G4 evidence only; never loaded into product StoreState.
export const S7_MAX_CAD_RELEASE_EVIDENCE_BYTES = 32_768;
export const S7_MAX_DIAGNOSTICS = 1024;
export const S7_MAX_RECOVERY_ITEMS_PER_PASS = 256;
export const S7_MAX_JOB_ATTEMPTS = 2;
export const S7_GEOMETRY_EPSILON_MM = 0.0000001;
export const S7_ANALYTIC_CLASSIFICATION_EPSILON = 0.000000001;
export const S7_ANALYTIC_AMBIGUITY_BAND = 0.0000001;
export const S7_TEXT_HEIGHT_MM = 100;
export const S7_DIMENSION_TEXT_HEIGHT_MM = 80;
export const S7_UNKNOWN_TEXT_HEIGHT_MM = 90;
~~~

The limits bound writer and parser work. The 1_000_000_000 mm plan-coordinate ceiling is only a defensive parser/output cap. It does not broaden accepted S6 authority.

StoreState gains exactly:

~~~ts
s7CadExports: S7CadExport[];
s7CadJobs: S7CadJob[];
s7CadIdempotency: S7CadIdempotency[];
s7CadManifests: S7CadManifestRecord[];
s7CadReadbackReceipts: S7CadReadbackReceipt[];
~~~

`s7CadManifests` stores durable private manifest identity/linkage metadata, not manifest bytes. The complete manifest bytes are immutable private objects. There is deliberately no product s7CadEvidence collection. A release evidence receipt, if retained, belongs outside product StoreState and is never loaded into a customer project. Old snapshots missing S7 fields load all five S7 arrays empty without rewrite; malformed present fields fail as S7_PERSISTENCE_FAILED. No migration fabricates records.

## Exact persisted records

UUID, Timestamp, Sha256, OpenSide, and S6ToS7Handoff are existing repository/S6 types. These shapes are the later implementation source of truth.

### Layers and source binding

~~~ts
export const S7_LAYER_NAMES = [
  "S7-BOOTH-BOUNDARY",
  "S7-BOOTH-OPENINGS",
  "S7-WALLS-PARTITIONS",
  "S7-ZONES",
  "S7-FURNITURE",
  "S7-EQUIPMENT",
  "S7-DISPLAYS",
  "S7-OVERHEAD",
  "S7-DIMENSIONS",
  "S7-LABELS",
  "S7-UNKNOWN",
] as const;

export type S7Layer = typeof S7_LAYER_NAMES[number];

export type S7SourceStamp = {
  schemaVersion: "s7-source-fence-v1";
  projectId: UUID;
  handoffSchemaVersion: "s6-to-s7-handoff-v1";
  handoffDigest: Sha256;
  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  validationReceiptId: UUID;
  validationHash: Sha256;
  validationOutcome: "pass" | "pass_with_warnings";
};
~~~

The source stamp is built only from one fresh S6ToS7Handoff. Its source revision ID/hash, S5 fingerprint, validation receipt ID/hash, validation outcome, handoff digest, and handoff version are persisted exactly. Eligibility booleans are snapshot evidence only.

### Private manifest

~~~ts
export type S7ManifestRole =
  | "booth-envelope"
  | "opening-marker"
  | "wall"
  | "partition"
  | "zone"
  | "furniture"
  | "equipment"
  | "display"
  | "overhead"
  | "dimension"
  | "label"
  | "unknown";

export type S7EntityType =
  | "LWPOLYLINE"
  | "CIRCLE"
  | "ELLIPSE"
  | "LINE"
  | "TEXT"
  | "POINT";

export type S7ManifestEntity = {
  entityKey: string;
  entityHandle: string;
  entityType: S7EntityType;
  layer: S7Layer;
  intendedSemanticLayer: S7Layer | null;
  sourceObjectId: string | null;
  identityKey: string;
  parentObjectId: string | null;
  role: S7ManifestRole;
  partIndex: number;
  geometryState: "exact" | "bounded_inference" | "derived";
  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  geometryDigest: Sha256;
  quantizedBounds: { minX: string; minY: string; maxX: string; maxY: string };
  xdataEntityKey: string;
  derived: boolean;
  outOfEnvelope: boolean;
};

export type S7CadDiagnostic = {
  severity: "warning" | "error";
  code: string;
  fieldPath: string;
  entityHandle: string | null;
  detail: string;
};

export type S7CadManifest = {
  schemaVersion: "s7-cad-manifest-v1";
  manifestId: UUID;
  projectId: UUID;
  artifactId: UUID;
  source: S7SourceStamp;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  units: "millimetres";
  coordinateMapping: "DXF X = S6 world X; DXF Y = S6 world Z; DXF Z = 0";
  extents: { minX: string; minY: string; maxX: string; maxY: string };
  layers: S7Layer[];
  booth: { widthMm: string; depthMm: string; openSides: OpenSide[] };
  entities: S7ManifestEntity[];
  entityCount: number;
  diagnostics: S7CadDiagnostic[];
  manifestHash: Sha256;
};
~~~

manifestHash is SHA-256 over the canonical manifest with manifestHash empty. The manifest excludes timestamps, private storage keys, XDATA bytes, prompts, image bytes, secrets, and arbitrary raw user text. The full correspondence authority is private and immutable.

The durable `s7CadManifests` record is:

~~~ts
export type S7CadManifestRecord = {
  schemaVersion: "s7-cad-manifest-v1";
  manifestId: UUID;
  projectId: UUID;
  artifactId: UUID;
  source: S7SourceStamp;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  manifestHash: Sha256;
  manifestByteSize: number;
  privateManifestKey: string;
  createdAt: Timestamp;
};
~~~

One manifest record links exactly one artifact to exactly one immutable private manifest object by `manifestId`, `manifestHash`, byte size, project, artifactId, source stamp, and world-to-plan version. The record and private bytes are created once and never overwritten; no manifest bytes or private key are returned by public DTOs.

### Export, readback, job, and idempotency records

~~~ts
export type S7CadExportStatus =
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

export type S7PublicationPhase =
  | "none"
  | "staged"
  | "promoted"
  | "committed"
  | "aborted";

export type S7CadExport = {
  schemaVersion: "s7-cad-export-v1";
  artifactId: UUID;
  projectId: UUID;
  jobId: UUID;
  source: S7SourceStamp;
  inputHash: Sha256;
  format: "dxf";
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  mimeType: "application/dxf";
  fileExtension: ".dxf";
  fileName: "swooshz-s7-plan.dxf";
  artifactKey: string;
  stagingKey: string;
  manifestKey: string;
  manifestStagingKey: string;
  dxfSha256: Sha256 | null;
  dxfByteSize: number | null;
  manifestId: UUID | null;
  manifestHash: Sha256 | null;
  manifestByteSize: number | null;
  readbackReceiptId: UUID | null;
  readbackReceiptHash: Sha256 | null;
  status: S7CadExportStatus;
  publicationPhase: S7PublicationPhase;
  attempt: 1 | 2;
  retryOfArtifactId: UUID | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  stagedAt: Timestamp | null;
  promotedAt: Timestamp | null;
  completedAt: Timestamp | null;
  terminalAt: Timestamp | null;
  staleAt: Timestamp | null;
  supersededAt: Timestamp | null;
  failureCode: string | null;
  idempotencyKey: string;
  requestReferenceId: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S7CadIssue = {
  code: string;
  fieldPath: string;
  entityHandle: string | null;
  detail: string;
};

export type S7CadRawReadbackResult = {
  schemaVersion: "s7-cad-readback-v1";
  artifactId: UUID;
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  writerVersion: "s7-dxf-r2000-ascii-v1";
  parserVersion: "s7-cad-readback-v1";
  dxfSha256: Sha256;
  dxfByteSize: number;
  manifestId: UUID;
  manifestHash: Sha256;
  entityCount: number;
  correspondenceHash: Sha256;
  outcome: "pass" | "fail";
  errors: S7CadIssue[];
  warnings: S7CadIssue[];
};

// This is the durable record stored in s7CadReadbackReceipts after raw parsing.
export type S7CadReadbackReceipt = {
  schemaVersion: "s7-cad-validation-receipt-v1";
  readbackVersion: "s7-cad-readback-v1";
  receiptId: UUID;
  projectId: UUID;
  artifactId: UUID;
  source: S7SourceStamp;
  manifestId: UUID;
  manifestHash: Sha256;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  writerVersion: "s7-dxf-r2000-ascii-v1";
  parserVersion: "s7-cad-readback-v1";
  dxfSha256: Sha256;
  dxfByteSize: number;
  entityCount: number;
  correspondenceHash: Sha256;
  outcome: "pass" | "fail";
  errors: S7CadIssue[];
  warnings: S7CadIssue[];
  checkedAt: Timestamp;
  receiptHash: Sha256;
};

export type S7CadJob = {
  schemaVersion: "s7-cad-job-v1";
  jobId: UUID;
  artifactId: UUID;
  projectId: UUID;
  source: S7SourceStamp;
  inputHash: Sha256;
  attempt: 1 | 2;
  retryOfJobId: UUID | null;
  status: S7CadExportStatus;
  publicationPhase: S7PublicationPhase;
  ownerProcessId: number | null;
  heartbeatAt: Timestamp | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  stagedAt: Timestamp | null;
  promotedAt: Timestamp | null;
  completedAt: Timestamp | null;
  terminalAt: Timestamp | null;
  failureCode: string | null;
  supersededAt: Timestamp | null;
  idempotencyKey: string;
  requestReferenceId: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S7CadIdempotency = {
  schemaVersion: "s7-cad-idempotency-v1";
  key: string;
  operation: "export";
  projectId: UUID;
  requestHash: Sha256;
  inputHash: Sha256;
  source: S7SourceStamp;
  artifactId: UUID;
  jobId: UUID;
  createdAt: Timestamp;
};
~~~

S7CadExport intentionally contains no external-CAD evidence ID/status. The internal readback receipt is a product integrity record, not external-CAD evidence.

### Public DTOs and S7-to-S8 handoff

~~~ts
export type S7CadExportSummary = {
  artifactId: UUID;
  projectId: UUID;
  jobId: UUID;
  source: S7SourceStamp;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  status: S7CadExportStatus;
  dxfSha256: Sha256 | null;
  dxfByteSize: number | null;
  manifestId: UUID | null;
  manifestHash: Sha256 | null;
  readbackOutcome: "pass" | "fail" | null;
  readbackReceiptId: UUID | null;
  readbackReceiptHash: Sha256 | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S7PublicState = {
  projectId: UUID;
  source: {
    readiness: "ready" | "not_ready";
    sourceS5Fingerprint: Sha256 | null;
    sourceRevisionId: UUID | null;
    sourceRevisionHash: Sha256 | null;
    handoffDigest: Sha256 | null;
    validationReceiptId: UUID | null;
    validationHash: Sha256 | null;
  };
  currentExport: S7CadExportSummary | null;
  exports: S7CadExportSummary[];
};

export type S7CadExportResult = {
  replayed: boolean;
  artifactId: UUID;
  projectId: UUID;
  jobId: UUID;
  source: S7SourceStamp;
  status: S7CadExportStatus;
  worldToPlanVersion: "s7-world-to-plan-v1";
  dxfProfileVersion: "s7-dxf-r2000-ascii-v1";
  dxfSha256: Sha256 | null;
  dxfByteSize: number | null;
  manifestId: UUID | null;
  manifestHash: Sha256 | null;
  readbackReceiptId: UUID | null;
  readbackReceiptHash: Sha256 | null;
};

export type S7ToS8Handoff = {
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
  readbackParserVersion: "s7-cad-readback-v1";
  readbackReceiptVersion: "s7-cad-validation-receipt-v1";
  dxfIsNot3DAuthority: true;
  s8MustReadAcceptedS6Model: true;
  openSides: OpenSide[];
  correspondence: Array<{
    sourceObjectId: string | null;
    identityKey: string;
    parentObjectId: string | null;
    role: S7ManifestRole;
    partIndex: number;
    geometryState: "exact" | "bounded_inference" | "derived";
    sourceRevisionId: UUID;
    sourceRevisionHash: Sha256;
    entityType: S7EntityType;
    entityHandle: string;
    layer: S7Layer;
    intendedSemanticLayer: S7Layer | null;
  }>;
};
~~~

Private keys, raw DXF, and the private manifest are never returned by public DTOs. Derived manifest records with null sourceObjectId are not presented as S8 source objects. The S7-to-S8 handoff carries exact accepted S6 revision/source binding, artifact identity/hash/size, manifest identity/hash, readback identity/hash and versions, s7-dxf-r2000-ascii-v1, s7-world-to-plan-v1, the coordinate convention, and stable correspondence; it carries no external-CAD evidence ID or status.

## Source fence and exact live-current function

Implement the source reader in src/lib/s7-cad.ts or a private section of src/lib/s7-geometry.ts. It must call existing S6 getS7Handoff(projectId) and never call an S6 mutation.

~~~ts
export type S7CurrentSource = {
  handoff: S6ToS7Handoff;
  binding: S7SourceStamp;
  canonicalHandoffBytes: Uint8Array;
};

export type S7SourceReader = {
  readCurrent(projectId: UUID): S7CurrentSource;
  assertCurrent(projectId: UUID, expected: S7SourceStamp): S7CurrentSource;
};

function readCurrentS7Source(projectId: UUID): S7CurrentSource;
function assertCurrentS7Source(projectId: UUID, expected: S7SourceStamp): S7CurrentSource;
~~~

readCurrentS7Source:

1. Read one fresh S6ToS7Handoff.
2. Require exact handoff schema s6-to-s7-handoff-v1, project ID, spatial schema s6-spatial-model-v1, millimetre units, and the exact S6 coordinate convention.
3. Validate source revision ID/hash, S5 fingerprint, validation receipt ID/hash/outcome, and all required handoff fields.
4. Require validation outcome pass or pass_with_warnings and a structurally valid handoff.
5. Canonicalize a clone with deterministic object key order and set-like arrays ordered by open side north/east/south/west, objectId, hierarchy objectId, zoneId, requirementId, materialId, assumptionId, and unknownId. Preserve profile vertex order and source geometry values. Exclude eligibility, timestamps, private paths, and S7 artifact data.
6. UTF-8 encode the canonical handoff and compute handoffDigest = SHA-256(bytes).
7. Build S7SourceStamp from the exact fields. Eligibility.currentAccepted/sourceCurrent/stale are snapshot evidence only.
8. Return cloned handoff, source stamp, and canonical bytes.

assertCurrentS7Source reads a fresh source and compares every source-stamp field and the canonical handoff shape. Any mismatch is S7_SOURCE_STALE; it never chooses the newer source or rebases an artifact.

Required fence points:

| Fence point | Required action |
|---|---|
| Admission | readCurrentS7Source before accepting an export request |
| Idempotency/job creation | assert the captured binding immediately before the repository transaction that records key/job |
| Projection | assert before and after handoff normalization/world projection |
| DXF generation | assert before buildS7Dxf and after bytes/manifest are complete |
| Staging | assert immediately before putExact and immediately after staging hash/size verification |
| Promotion | assert immediately before promoteExact and immediately after final-object verification |
| Durable commit | assert immediately before the transaction that changes promoted to committed |
| Metadata | authorized getState/getExport re-reads source; mismatch is stale, never current |
| Download | authenticate first, then assert source/status/final bytes/readback/hash/size before disclosure |
| S7-to-S8 disclosure | authenticate first, then assert source and committed export/readback before returning DTO |

If a fence changes after writing, objects remain private immutable history but cannot be committed or disclosed as current. In-flight queued/running/staged/promoted work becomes stale when its captured source is invalid before finality; already committed history becomes superseded when a newer accepted S6 revision becomes current. Recovery may abort or mark the applicable record stale/superseded and clean staging best-effort.

## Independent S6 transform parity

The S7 transform oracle may import S6 types but must not call deriveS6WorldGeometry or compare a function to itself.

The proof/test oracle multiplies explicit homogeneous matrices for the X -> Y -> Z rotation order and full parent hierarchy, then compares independently hand-calculated world points and projected boundaries. It covers root and nested transforms, every rotation axis, mixed Euler rotations, both anchors, all eight rect-prism corners, cycle rejection, and dangling-parent rejection; it never validates the same implementation against itself.

Exact full-Euler formula:

~~~text
rx = xMd * pi / 180000
ry = yMd * pi / 180000
rz = zMd * pi / 180000

after X:
  x1 = x
  y1 = y*cos(rx) - z*sin(rx)
  z1 = y*sin(rx) + z*cos(rx)

after Y:
  x2 = x1*cos(ry) + z1*sin(ry)
  y2 = y1
  z2 = -x1*sin(ry) + z1*cos(ry)

after Z:
  x3 = x2*cos(rz) - y2*sin(rz)
  y3 = x2*sin(rz) + y2*cos(rz)
  z3 = z2
~~~

Local affine:

~~~text
origin = transform.positionMm
xAxis = rotate((1,0,0), rotationMd)
yAxis = rotate((0,1,0), rotationMd)
zAxis = rotate((0,0,1), rotationMd)
apply(origin, p) = origin + xAxis*p.x + yAxis*p.y + zAxis*p.z
~~~

Parent composition:

~~~text
worldOrigin = apply(parent, local.origin)
worldXAxis = parentLinear(local.xAxis)
worldYAxis = parentLinear(local.yAxis)
worldZAxis = parentLinear(local.zAxis)
~~~

Use DFS with cache and cycle/dangling-parent rejection. Use local baseY = 0 for floor anchors and -heightMm/2 for center anchors. Test root/single/mixed X/Y/Z rotations, nested transforms, both anchors, all primitive families, and hand-authored world-point oracles.

## Exact projected-solid algorithms

Project before 0.01 mm quantization. Epsilon is used only for equality, collinearity, intersections, and analytic classification; it is not an approximation tolerance. If an exact deterministic boundary cannot be proven, fail closed.

### Rect prism

For each rect_prism:

~~~text
baseY = 0 when localAnchor = floor
baseY = -heightMm / 2 when localAnchor = center
local corners = every (x,y,z) where
  x in {0,widthMm}
  y in {baseY,baseY+heightMm}
  z in {0,depthMm}
worldCorners = full parent-composed affine(local corners)
planPoints = (world.xMm, world.zMm)
boundary = exact convex hull(planPoints)
~~~

Use lexicographic X/Z monotonic-chain hull, duplicate removal, and collinear interior-point removal. Emit a closed LWPOLYLINE for an area hull, a LINE for an exact two-point degeneracy, or a POINT for an exact one-point degeneracy. Never project only a local footprint or use a world axis-aligned bounding box.

### Profile extrusion

For each validated profile_extrusion:

1. Preserve the exact canonical profile vertex order and height/anchor.
2. Triangulate the simple profile deterministically by ear clipping with canonical lowest-vertex tie breaks.
3. Transform/project each triangle's three base and three top vertices and take the exact convex hull of the six points.
4. Build a planar arrangement from every convex-piece boundary segment, splitting at every proper and endpoint intersection.
5. For each split segment, test a midpoint on both sides against the union; keep only a segment with union on exactly one side. Coincident internal seams cancel.
6. Stitch retained segments into closed cycles using canonical turn/order and minimum vertex.
7. Remove duplicates and collinear points after union. Reject non-closed cycles, self-intersections, ambiguous ownership, or invalid arrangements; do not apply a blanket single-loop or hole rejection.
8. Emit each exact exterior cycle as a closed LWPOLYLINE, sorted by minimum vertex and canonical vertex sequence; multiple exact exterior loops are allowed where required by the solid.

The result is the exact deterministic projected-solid union, not triangulation boundaries. No coarse polygon, bounding box, renderer facet, or silent booth clipping.

### Round prism

Local Y is the cylinder axis. Let:

~~~text
c0 = projected transformed center at baseY
c1 = projected transformed center at baseY + heightMm
d = c1 - c0
u = radiusMm * projected transformed local X axis
v = radiusMm * projected transformed local Z axis
E(t) = u*cos(t) + v*sin(t)
~~~

For a proven plan-normal axis, d is zero and the radial plane is world X/Z. Emit one exact CIRCLE centered at c0 with radius radiusMm.

For a full-rank radial basis, the exact silhouette is E + [c0,c1]. Emit two ELLIPSE arcs and two tangent LINE caps:

1. Form M = [u v] and compute deterministic principal major/minor axes from M*M-transpose with eigenvector sign tie breaks.
2. Solve cross(E'(t), d) = 0 for tangent parameters.
3. If roots are repeated, non-finite, or ambiguous, fail closed.
4. Select two antipodal support parameters in canonical order.
5. Convert retained arcs to DXF ELLIPSE parameters relative to the principal major axis, with exact start/end parameters and minor/major ratio.
6. Emit LINE caps joining corresponding base/top support points, quantizing shared endpoints once.
7. Order arcs/lines by positive boundary winding and entity key.

Rank-degenerate representation:

- rank two: two analytic ELLIPSE arcs and two tangent LINEs;
- rank one with nonzero projected axis: exact parallelogram/hull as closed straight-edge LWPOLYLINE;
- rank one with zero projected axis: exact segment as LINE and no fabricated area;
- mathematically proven rank zero: exact axis segment or point as LINE/POINT;
- values in the analytic ambiguity band or unproved classification: S7_ROUND_CLASSIFICATION_AMBIGUOUS.

There is no polygon/facet fallback, no 96-point approximation, no box replacement, and no clipping. Valid out-of-envelope geometry remains represented and is diagnosed.

## Quantized numeric representation

Canonical lengths use signed integer centi-millimetres:

~~~text
q(v) = floor(v*100 + 0.5) for v >= 0
q(v) = ceil(v*100 - 0.5) for v < 0
~~~

This is half-away-from-zero. Normalize q = 0 before formatting. Whole-centimetre values may serialize as integers; every other fractional-millimetre value uses exactly two fractional digits, with a period separator, no grouping, no exponent, and no negative zero:

~~~text
formatLength(q) =
  sign + canonical integer/fractional representation of abs(q / 100)
whole centimetre = integer millimetres with no decimal point
fractional millimetre = exactly two fractional digits
zero = 0
~~~

Angles/radians use writer-version fixed decimal formatting with no exponent and normalized zero. Unitless ellipse ratio, start parameter, and end parameter values use exactly twelve fractional places. They are not millimetre precision. Quantize after analytic/union construction; shared endpoints come from one pre-quantization point.

Transport precision is not fabrication accuracy. UI/API/metadata must say so, and no engineering/fabrication tolerance claim is inferred.

The world-to-plan transform and coordinate mapping are versioned as s7-world-to-plan-v1. Persist this exact version on every generated manifest, export record, durable validation/readback receipt, and S7-to-S8 handoff that carries plan coordinates. The mapping is DXF X = S6 world X, DXF Y = S6 world Z, DXF Z = 0, in millimetres.

## AC1015 DXF contract

Exact writer profile:

~~~text
ASCII AutoCAD 2000 DXF
$ACADVER = AC1015
$INSUNITS = 4
$MEASUREMENT = 1
version = s7-dxf-r2000-ascii-v1
~~~

Bytes are ASCII, LF-only, no BOM, deterministic group-code/value ordering, locale-independent, and end with one LF after EOF. Exact section order:

~~~text
HEADER
TABLES
BLOCKS
ENTITIES
EOF
~~~

CLASSES and OBJECTS are omitted because S7 adds no custom classes or required nongraphical objects. No XREF, proxy, executable/script, 3D solid, mesh, raster/PDF, DWG, or arbitrary input DXF.

### HEADER

Emit these variables in this exact order:

~~~text
$ACADVER  AC1015
$INSUNITS  4
$MEASUREMENT  1
$EXTMIN   <minimum emitted plan X/Y; Z = 0>
$EXTMAX   <maximum emitted plan X/Y; Z = 0>
$HANDSEED  <first unused handle>
~~~

$EXTMIN and $EXTMAX are deterministic bounds over all emitted plan geometry and every annotation insertion point after the locked world-to-plan mapping and quantization. They are not only the booth envelope bounds; valid out-of-envelope source geometry remains included. HANDSEED is uppercase hexadecimal and is checked after all entity records are planned.

### TABLES and records

Emit exactly these tables in order:

~~~text
LTYPE
LAYER
APPID
BLOCK_RECORD
~~~

LTYPE precedes LAYER. LTYPE has one CONTINUOUS entry with flags 0, description Solid line, alignment 65, element count 0, pattern length 0. LAYER has exactly the eleven S7_LAYER_NAMES in order; each has flags 0, color 7, linetype CONTINUOUS, lineweight -1. APPID has exactly SWOOSHZ_S7 with flags 0.

BLOCK_RECORD has exactly:

~~~text
*MODEL_SPACE
*PAPER_SPACE
~~~

Each table/entry carries required AC1015 symbol-table/table-record subclass markers. Each block record has the block-table-record subclass marker and flags 0.

### BLOCKS

Emit one minimal matching block definition for *MODEL_SPACE and one for *PAPER_SPACE. Each has a deterministic BLOCK begin handle, block-record owner, AcDbEntity/AcDbBlockBegin markers, name, flags 0, origin 0/0/0, and deterministic ENDBLK handle with owner and AcDbEntity/AcDbBlockEnd markers. No graphical entity is placed inside a block; all graphics are in ENTITIES and owned by *MODEL_SPACE.

### Handle allocation

The earlier fixed-number proposal is superseded. Reserve this non-overlapping map:

| Record | Exact handle |
|---|---|
| LTYPE TABLE control | 100 |
| CONTINUOUS LTYPE entry | 101 |
| LAYER TABLE control | 110 |
| LAYER entry index 0..10 | 111 + index, producing 111 through 11B |
| APPID TABLE control | 120 |
| SWOOSHZ_S7 APPID entry | 121 |
| BLOCK_RECORD TABLE control | 130 |
| *MODEL_SPACE BLOCK_RECORD | 131 |
| *PAPER_SPACE BLOCK_RECORD | 132 |
| *MODEL_SPACE BLOCK begin | 140 |
| *MODEL_SPACE ENDBLK | 141 |
| *PAPER_SPACE BLOCK begin | 142 |
| *PAPER_SPACE ENDBLK | 143 |
| graphical entity index i in canonical emission order | 200 + i |

Handles are uppercase hexadecimal strings without 0x. The first unused handle is:

~~~text
HANDSEED = uppercaseHex(0x200 + graphicalEntityCount)
~~~

No handle is random, reused, duplicated, or allocated from user input. XDATA has no handle.

### Common entity fields

Every LWPOLYLINE, CIRCLE, ELLIPSE, LINE, TEXT, and POINT begins:

~~~text
5    deterministic handle
330  *MODEL_SPACE BLOCK_RECORD owner handle
100  AcDbEntity
410  Model
8    one locked S7 layer
370  -1
100  required entity-specific subclass
~~~

370 = -1 means ByLayer. The owner is never *PAPER_SPACE and every layer is allowlisted.

### Entity-specific writers

LWPOLYLINE:

~~~text
100 AcDbPolyline
90 vertex count
70 flags (1 for closed)
38 0 elevation
repeat vertices:
  10 X
  20 Y
~~~

All boundary polylines are straight-edge and closed with no group 42 bulges. Open marker polylines use flags 0.

CIRCLE:

~~~text
100 AcDbCircle
10 center X
20 center Y
30 0
40 radius
~~~

ELLIPSE:

~~~text
100 AcDbEllipse
10 center X
20 center Y
30 0
11 relative major-axis endpoint X
21 relative major-axis endpoint Y
31 0
40 minor/major ratio
41 start parameter
42 end parameter
~~~

LINE:

~~~text
100 AcDbLine
10 start X
20 start Y
30 0
11 end X
21 end Y
31 0
~~~

TEXT:

~~~text
100 AcDbText
10 insertion X
20 insertion Y
30 0
40 bounded height
1 bounded printable ASCII text
7 Standard
50 deterministic rotation
~~~

POINT:

~~~text
100 AcDbPoint
10 X
20 Y
30 0
~~~

All planar coordinates use DXF X = S6 world X, DXF Y = S6 world Z, DXF Z = 0. TEXT accepts only printable ASCII; reject C0/C1 controls, CR, LF, NUL, Unicode DXF escapes, backslash injection, and unsanitized user/customer text. Derived labels use deterministic `_uXXXX_` ASCII conversion or a stable identity hash. Every emitted entity uses the s7-world-to-plan-v1 mapping.

Every entity appends this exact bounded identity grammar:

~~~text
1001 SWOOSHZ_S7
1000 S7V1
1000 O=<sourceObjectId>
1000 K=<identityKeyToken-or-hash>
1000 P=<parentObjectId-or->
1000 R=<role>
1000 I=<partIndex>
1000 G=<geometryState>
1000 V=<sourceRevisionId>
1000 H=<sourceRevisionHash>
~~~

These bounded printable-ASCII fields preserve sourceObjectId, identityKey token/hash, parentObjectId, role, partIndex, geometryState, sourceRevisionId, and sourceRevisionHash in-file. Source and parent IDs are stable opaque S6 IDs, not UUID-only values. For derived records, the accepted `-` representation is used where no source/parent exists. At most 16 XDATA strings and 2,048 XDATA bytes are permitted per entity. A compact manifest locator may coexist within those bounds but may not replace this block; the private manifest remains complete authority.

### Canonical entity order

Plan every entity before assigning handles:

1. closed booth boundary;
2. open-side marker entities in north, east, south, west order;
3. source geometry by locked layer order, identityKey UTF-8 byte order, partIndex, and entity type rank;
4. dimensions;
5. source labels;
6. unknown diagnostics.

Within each group use canonical string comparison and entity type as final tie-break. Source array order never determines identity or handle.

The locked role-to-layer mapping is:

~~~text
booth_floor -> S7-BOOTH-BOUNDARY
booth_wall -> S7-WALLS-PARTITIONS
booth_partition -> S7-WALLS-PARTITIONS
zone -> S7-ZONES
furniture | storage | seating -> S7-FURNITURE
equipment -> S7-EQUIPMENT
display | screen -> S7-DISPLAYS
overhead -> S7-OVERHEAD
~~~

## Layers and plan semantics

The booth envelope is always one closed LWPOLYLINE on S7-BOOTH-BOUNDARY. Open sides are not holes in that envelope.

Open-side rules:

- S7-BOOTH-OPENINGS has one deterministic marker set per S6 open side.
- S7-LABELS has a bounded OPEN-NORTH/EAST/SOUTH/WEST token only for an open side.
- S7-WALLS-PARTITIONS contains only modeled S6 wall/partition projections.
- No wall is synthesized on an open side; absence of a wall is meaningful.

Zones use deterministic boundary/marker geometry and labels. Furniture, equipment, displays, overhead, dimensions, and labels use the locked layers above. Source geometry with geometryState = bounded_inference, or any source object with relevant unknownIds, is emitted on S7-UNKNOWN as its primary exported geometry layer. The private manifest preserves its intended semantic layer in intendedSemanticLayer. S7-UNKNOWN is therefore not a POINT/TEXT diagnostics-only layer: it may contain the bounded source geometry that is actually available, plus POINT/TEXT markers when no geometry can be emitted. S7 never invents geometry.

### Dimensions and labels

Width/depth dimensions are exploded editable LINE/TEXT groups on `S7-DIMENSIONS`; the writer does not emit native DIMENSION entities. Maximum height is an informational TEXT value, not plan geometry. Every dimension, label, and other derived value is explicitly marked `derived` in the private manifest and is placed by a fixed deterministic rule from the entity key, quantized bounds, and locked offsets.

There is no collision solver, reflow, or layout-dependent repositioning. Overlap is retained and reported as an informational diagnostic. Text is limited to 120 code points, printable deterministic ASCII, and allowlisted derived/source labels; C0/C1 controls, CR, LF, NUL, Unicode DXF escapes, unsanitized user/customer text, and fabrication, engineering, venue-certification, or approval wording are rejected.

Valid source geometry outside the booth envelope is emitted unchanged, with outOfEnvelope warning/diagnostic in the private manifest and telemetry. S7 never clips, moves, shrinks, or hides it.

## XDATA and manifest split

The private immutable manifest is complete authority for source binding, exact quantized parameters, geometry digests, diagnostics, and correspondence:

~~~text
sourceObjectId
identityKey
parentObjectId
role
partIndex
geometryState
sourceRevisionId
sourceRevisionHash
~~~

It also includes entity handle/type/layer, XDATA entity key, quantized bounds, derived marker, and out-of-envelope marker. Source fields are copied from S6. Derived booth/opening/dimension/label/unknown records use sourceObjectId = null and a fixed identityKey such as booth-envelope or opening-north, while retaining the accepted source revision fields.

The XDATA grammar above is the required in-file source/part/revision identity, not a reduction to `manifestHash` plus `entityKey`. A compact manifest locator may coexist only within the 16-string and 2,048-byte per-entity bounds. The manifest excludes XDATA bytes so manifest hash and any locator do not form a cycle. XDATA contains no full geometry, labels, prompts, image values, storage paths, secrets, or customer payload.

## Strict independent raw-DXF readback

src/lib/s7-dxf-readback.ts must be independent of src/lib/s7-dxf-writer.ts. It may share literal types and hash/JSON primitives but must parse bytes rather than accept writer memory.

### Bounds and tokenizer

Before tokenization:

- require byte length <= S7_MAX_DXF_BYTES;
- require total line count <= S7_MAX_DXF_LINES;
- reject BOM, NUL, bytes above ASCII 0x7F, CR, and non-printable bytes;
- require LF-only line endings and one final LF;
- require an even group-code/value sequence;
- require every group/value line to be at most 512 bytes;
- require decimal integer group codes in the DXF range;
- reject illegal blank values.

During parsing:

- at most S7_MAX_LAYERS layers and S7_MAX_TABLE_RECORDS table records;
- exactly two block records and two block definitions;
- at most 4,096 entities and 16,384 total polyline vertices;
- at most 2,048 XDATA bytes per entity;
- at most 16 XDATA strings per entity;
- at most S7_MAX_DIAGNOSTICS issues;
- all lengths finite and within S7_PLAN_COORDINATE_CEILING_MM;
- fixed decimal numeric strings only, no exponent or negative zero;
- labels and emitted text are at most 120 code points and all strings are field-safe.

### Parser state machine and allowlist

~~~text
START
  -> SECTION_HEADER
  -> SECTION_TABLES
  -> SECTION_BLOCKS
  -> SECTION_ENTITIES
  -> EOF
  -> DONE
~~~

Only SECTION plus an exact section name advances. Sections do not repeat. HEADER accepts only AC1015, INSUNITS 4, MEASUREMENT 1, EXTMIN, EXTMAX, and HANDSEED in exact order. TABLES accepts only LTYPE, LAYER, APPID, BLOCK_RECORD in order with exact entries. BLOCKS accepts exactly matching model/paper definitions. ENTITIES accepts only LWPOLYLINE, CIRCLE, ELLIPSE, LINE, TEXT, POINT with exact common/entity data and the complete bounded SWOOSHZ_S7 identity XDATA. EOF is final.

Reject missing/reordered sections, CLASSES/OBJECTS, XREF/proxy/3D/mesh/SPLINE/HATCH/DIMENSION/IMAGE/PDF/unknown records, wrong header/units/extents, missing table/block entries, duplicate or unmapped handles, wrong owner/layer/Model/lineweight/subclass/Z, unsupported group codes, malformed vertices, invalid ellipse params, missing/multiple/wrong identity XDATA, control characters, URLs, script fragments, and unbounded strings.

After raw parsing, read the private manifest and require schema/profile/source binding equality, DXF/manifest hash/size equality, manifest identity, world-to-plan version, exact extents, exact entity count, one-to-one handles/entity keys, exact type/layer/intended semantic layer/source revision, complete XDATA identity, quantized geometry digest/parameters, closed booth boundary, exact opening set, stable source object/part mapping, and required out-of-envelope diagnostics. A raw readback PASS never needs external CAD evidence.

The raw parser result uses s7-cad-readback-v1 and is not a StoreState record. Persist the durable validation receipt before commit in s7CadReadbackReceipts with schemaVersion s7-cad-validation-receipt-v1 and readbackVersion s7-cad-readback-v1. Its receiptHash is canonical over the receipt with receiptHash empty, and it links the exact manifestId/manifestHash and readback identity.

## Persistence and graph invariants

validateS7Collections and validateS7Graph enforce:

- exact keys, schema literals, UUID/SHA/timestamp rules, attempts 1/2, status/phase combinations, bounded sizes, and allowlisted names/layers/types;
- source stamp equality across artifact/job/readback;
- artifact/job/readback project and ID relationships;
- one s7CadManifests record per artifact with exact manifestId/manifestHash/private-byte-size/worldToPlanVersion linkage;
- committed/promoted objects have exact final metadata;
- staged objects have exact staging metadata and no disclosure path;
- readbackReceiptId/readbackReceiptHash point to a passing durable validation receipt for the exact artifact/source/manifest/hash/size;
- stale and superseded exports cannot be current/downloadable; only a committed export whose source still matches may be current/downloadable;
- retryOf chains have maximum length one and no attempt three;
- idempotency keys are unique by project/operation and replay only for the same input hash;
- final artifact keys are not shared by different exports;
- private manifest/DXF are paired by artifactId, manifestId, manifestHash, and hashes;
- no record contains cadEvidenceId, cadEvidenceStatus, or another external-CAD runtime field;
- no StoreState.s7CadEvidence exists.

## State machines and idempotency

Export and job status transition together:

~~~text
queued -> running -> staged -> promoted -> committed
running -> failed_retryable -> queued (attempt 2 only)
staged -> failed_retryable only after exact staging verification failure
promoted -> committed after final verification and final fence
queued/running/staged/promoted -> stale when the captured source becomes invalid before finality
any nonterminal -> aborted on claim fence or terminal cancellation
committed -> superseded when a newer accepted S6 revision becomes current
attempt 2 failure -> failed_terminal
~~~

stale, superseded, failed, and aborted are terminal statuses. No staged/promoted artifact is returned as committed. A committed export remains immutable history; when a newer accepted S6 revision becomes current, the old export is marked superseded, not stale, and is not current/downloadable.

Claims are under the repository lock with ownerProcessId, heartbeatAt, claimToken, and claimedAt. Live/unknown owners are never stolen. A dead owner receives one attempt-2 job and artifact with a new identity and retryOfJobId/retryOfArtifactId references. A stale claim token cannot mutate state.

POST /projects/{projectId}/s7/exports accepts a bounded opaque Idempotency-Key string; UUID-only keys are not required. requestHash/inputHash are SHA-256 values over the exact request and captured source/input.

~~~text
{
  operation: "export",
  projectId,
  emptyRequest: {},
  sourceBinding,
  actorIndependent: true
}
~~~

The same idempotency key with the exact same request hash, source stamp, and input hash replays the stored artifact/job result without another job or artifact. Reusing the same key with any different request, source, or input returns S7_IDEMPOTENCY_CONFLICT. The key is an opaque bounded string, not UUID-only, and the client retains it through UnknownNetworkOutcome. At most one nonterminal job per project/source stamp is active; a different key receives S7_PUBLICATION_BUSY.

## Exact private staging/final key formulas

Use existing privateStorageKey after validating UUIDs and fixed literals. No label, filename, material, URL, customer name, or raw user string enters a key.

~~~text
finalDxfKey(projectId, artifactId) =
  privateStorageKey(
    "projects", projectId, "s7", "exports", artifactId,
    "swooshz-s7-plan.dxf"
  )

finalManifestKey(projectId, manifestId) =
  privateStorageKey(
    "projects", projectId, "s7", "manifests", manifestId + ".json"
  )

stagingDxfKey(projectId, jobId, claimToken) =
  privateStorageKey(
    "projects", projectId, "s7", "staging", jobId, claimToken,
    "swooshz-s7-plan.dxf"
  )

stagingManifestKey(projectId, jobId, claimToken) =
  privateStorageKey(
    "projects", projectId, "s7", "staging", jobId, claimToken,
    "manifest.json"
  )
~~~

Fixed public and stored DXF filename:

~~~text
swooshz-s7-plan.dxf
~~~

projectId is validated canonical UUID and is never replaced by a project name.

## Generation, staging, promotion, commit, and recovery

S7CadService.createExport:

1. Authorize before service construction/disclosure.
2. Parse UUID idempotency key and request reference.
3. readCurrentS7Source.
4. Compute inputHash and check replay.
5. Assert source immediately before the repository transaction.
6. Under lock, create one queued export/job with exact binding, keys, attempt 1, and no evidence fields.
7. Claim with unique token.
8. Assert source before projection.
9. Independently compose transforms and project every accepted object.
10. Assert before and after entity-list construction.
11. Build DXF and manifest bytes.
12. Assert before putExact; stage both bytes; verify hash/size.
13. Persist staged state and run independent raw-DXF readback.
14. Require readback PASS, exact correspondence, source binding, hash, and size.
15. Assert before promoteExact; promote both final objects; reject a different pre-existing final object.
16. Verify final bytes/hash/size and assert after promotion.
17. Persist promoted manifest identity/hash and readback identity/hash, and create the one linked s7CadManifests record.
18. Assert immediately before the committed transaction.
19. Persist committed state and idempotent result atomically.
20. Remove staging only after commit, best-effort.
21. Return safe metadata only.

Recovery leaves queued work queued, keeps live/unknown running owners busy, retries one dead owner, verifies/resumes staged/promoted exact bytes, marks in-flight work stale when its captured source is invalid before finality, marks already committed history superseded when a newer accepted S6 revision becomes current, makes a second failure terminal, and cleans abandoned staging only after terminal state. One recovery pass handles at most 256 items. No failure becomes fake success.

## Exact service/API/UI contract

### Service

~~~ts
export type S7CadService = {
  getState(projectId: UUID): S7PublicState;
  getExport(projectId: UUID, artifactId: UUID): S7CadExportSummary;
  createExport(projectId: UUID, key: string, referenceId: UUID, actorSubjectId: string): Promise<S7CadExportResult>;
  getDownload(projectId: UUID, artifactId: UUID): { bytes: Buffer; contentType: "application/dxf"; fileName: "swooshz-s7-plan.dxf" };
  getTelemetry(projectId: UUID): S7Telemetry;
  getS8Handoff(projectId: UUID): S7ToS8Handoff;
  recover(): void;
};
~~~

### Routes

This is the accepted G2 API surface. This repair restores DTO and persistence fields without changing the method/path/body/status shape below.

| Method/path | Exact behavior |
|---|---|
| GET /projects/{projectId}/s7 | Authorized S7PublicState |
| POST /projects/{projectId}/s7/exports | Empty JSON object; opaque Idempotency-Key; 202 new/200 replay |
| GET /projects/{projectId}/s7/exports/{artifactId} | Authorized summary |
| GET /projects/{projectId}/s7/exports/{artifactId}/download | Current eligible committed DXF only |
| GET /projects/{projectId}/s7/telemetry | S7Telemetry |
| GET /projects/{projectId}/s7/handoff | Current eligible committed/readback-gated S7ToS8Handoff |

Only these paths are recognized. Auth and project authorization run before service construction or disclosure. Wrong methods, unknown fields, nonempty export body, malformed UUID, missing key, and oversized body fail closed.

Download headers:

~~~text
content-type: application/dxf
content-disposition: attachment; filename="swooshz-s7-plan.dxf"
cache-control: private, no-store
x-content-type-options: nosniff
content-length: exact byte length
~~~

S7Client displays source revision/hash, S5 fingerprint, validation receipt/hash, handoff digest, currentness, export state, profile, 0.01 mm transport note, internal readback/hash/size, and download only when committed/current. It has no geometry editor, image reinterpretation, DXF upload, cloud-CAD call, evidence-ID input, per-export CAD evidence status, internal release-HOLD field, or S6 fact/approval controls. The programme/release HOLD is not customer/project UI or runtime DTO state. The client reloads persisted state and retains the idempotency key after uncertain outcomes.

## Security, privacy, errors, and logs

Stable public codes:

~~~text
S7_SOURCE_NOT_READY
S7_SOURCE_STALE
S7_GEOMETRY_INVALID
S7_ROUND_CLASSIFICATION_AMBIGUOUS
S7_DXF_GENERATION_FAILED
S7_DXF_PROFILE_INVALID
S7_DXF_PARSE_INVALID
S7_DXF_CORRESPONDENCE_MISMATCH
S7_READBACK_FAILED
S7_PUBLICATION_FAILED
S7_STALE_ARTIFACT
S7_PUBLICATION_BUSY
S7_CLAIM_FENCED
S7_RETRY_EXHAUSTED
S7_IDEMPOTENCY_CONFLICT
S7_PERSISTENCE_FAILED
S7_UNAUTHORIZED_OR_NOT_FOUND
S7_INVALID_REQUEST
S7_INTERNAL_ERROR
~~~

Public wording is always:

~~~text
The request could not be completed. Try again or contact support with the reference ID.
~~~

Expose only code, generic message, referenceId, and safe field errors. Logs contain referenceId, operation, project/export/job IDs where necessary, status, code, attempt, and bounded hashes. Never log or return secrets, token values, auth headers/cookies, prompts, uploads, image bytes, model payloads, raw DXF, manifest contents, storage keys, customer names, or unnecessary PII.

Enforce authorization before service construction and every disclosure; project isolation; UUID/key validation; fixed private paths; private/no-store/nosniff downloads; ASCII-only safe output; strict exact DTOs; all parser/entity/vertex/XDATA/string/manifest/byte/retry limits; and no arbitrary DXF/script/URL/HTML/foreign-object/XREF/proxy/3D data. Never fall back to a box, facet, clipping, alternate source, or fake success.

Secret audit names only:

~~~text
.env*
*.pem
*.key
*token*
*secret*
*credential*
Authorization
Cookie
api_key
access_token
~~~

Values are always reported as [REDACTED].

## Telemetry contract

~~~ts
export type S7Metric<T> = {
  availability: "available" | "unavailable";
  value: T | null;
  reason: string | null;
};

export type S7Telemetry = {
  schemaVersion: "s7-telemetry-v1";
  projectId: UUID;
  sourceReadiness: S7Metric<"ready" | "not_ready">;
  exportRequestCount: S7Metric<number>;
  exportSuccessCount: S7Metric<number>;
  exportFailureCount: S7Metric<number>;
  readbackFailureCount: S7Metric<number>;
  publicationFailureCount: S7Metric<number>;
  staleFenceCount: S7Metric<number>;
  retryCount: S7Metric<number>;
  committedExportCount: S7Metric<number>;
  committedDxfByteSize: S7Metric<number>;
  providerCost: S7Metric<number>;
  toolCost: S7Metric<number>;
  generatedAt: Timestamp;
};
~~~

Durable counts may be exactly zero. providerCost is unavailable with reason no_provider_used. toolCost is unavailable with reason no_billed_tool_amount. External CAD evidence is not a runtime metric.

## S7-to-S8 boundary

getS8Handoff(projectId) requires authorization, a current source stamp, the current eligible committed artifact, passing internal readback, exact final hash/size, and a final source fence. It returns the flat s7-to-s8-handoff-v1 DTO with the exact accepted S6 revision/source binding, sourceS5Fingerprint, S7 artifact identity/hash/size, manifestId/manifestHash, readbackReceiptId/readbackHash, the raw readback and durable validation-receipt versions, s7-dxf-r2000-ascii-v1, s7-world-to-plan-v1, stable correspondence, and the coordinate convention:

~~~text
schemaVersion = s7-to-s8-handoff-v1
sourceRevisionId
sourceRevisionHash
sourceS5Fingerprint
s7ArtifactId
s7ArtifactHash
s7ArtifactByteSize
manifestId
manifestHash
readbackReceiptId
readbackHash
dxfVersion = s7-dxf-r2000-ascii-v1
worldToPlanVersion = s7-world-to-plan-v1
coordinateConvention = booth-local-right-handed-v1
stableCorrespondence
readbackParserVersion = s7-cad-readback-v1
readbackReceiptVersion = s7-cad-validation-receipt-v1
dxfIsNot3DAuthority = true
s8MustReadAcceptedS6Model = true
~~~

S8 must consume the same exact accepted S6 model/revision represented by source; it must not derive 3D from the DXF or choose a newer S6 revision. DXF is plan/correspondence evidence only and is not 3D authority. The runtime handoff has no external-CAD evidence ID or per-export CAD evidence status. No FBX, .max, editable 3D, 3D production, APS, or S8 implementation belongs in S7.

## Later representative CAD interoperability evidence

This is a G3/G4/release procedure, not a per-export runtime step:

1. Select a local AutoCAD-compatible application/reader with exact name, version, build, and installation hash. No cloud service.
2. Bind evidence to implementation head SHA/tree, writer version, parser version, profile, and fixture hashes.
3. Use only synthetic fixtures with no customer/private data.
4. Open/import and record AC1015, units, layers, model-space ownership, booth dimensions, open-side markers, walls, round/profile entities, and labels.
5. Edit a representative object property/vertex, save a scratch copy, close, reopen, and verify the edit survives and remains editable.
6. Compare the scratch copy truthfully; external saved bytes need not be canonical-byte-identical, while product bytes remain governed by internal readback.
7. Record application/version, fixture hashes, operations, result, and limitations in release-only s7-cad-evidence-v1.

The evidence is bound to the exact implementation head/profile and is never stored in StoreState, S7CadExport, or runtime telemetry. Current TOOLING_HOLD: YES remains until Web accepts suitable version-pinned local evidence.

## Positive, negative, and adversarial matrix

| ID | Case | Expected result |
|---|---|---|
| S7-GEO-001 | Root rect zero rotation | All eight corners produce exact four-point hull |
| S7-GEO-002 | Rect mixed X/Y/Z | Independent X-then-Y-then-Z parity |
| S7-GEO-003 | Nested parent/child | Exact affine composition and identity |
| S7-GEO-004 | Floor/center anchor | Exact base/top intervals |
| S7-GEO-005 | Concave profile | Union has no triangulation seams |
| S7-GEO-006 | Profile shared/collinear edges | Deterministic exterior cycle |
| S7-GEO-007 | Plan-normal round | One exact CIRCLE |
| S7-GEO-008 | Full-rank tilted round | ELLIPSE arcs plus tangent LINE caps |
| S7-GEO-009 | Rank-one round | Exact parallelogram/segment |
| S7-GEO-010 | Ambiguous round classification | Error and no fallback |
| S7-GEO-011 | Valid out-of-envelope geometry | Retained with diagnostic |
| S7-GEO-012 | Open-side variants | Closed envelope, markers, no wall |
| S7-GEO-013 | Unknown source object | Bounded source geometry/marker on primary S7-UNKNOWN layer; intended layer retained privately |
| S7-NUM-001 | Positive/negative half ties | Half-away centi-mm exact |
| S7-NUM-002 | Negative zero/exponent/overflow | Normalize/reject as locked |
| S7-DXF-001 | Same source twice | Byte-identical output/manifest/handles |
| S7-DXF-002 | Full AC1015 scaffold | Sections/tables/blocks/owners pass |
| S7-DXF-003 | Six entity writers | Common fields/subclasses/data pass |
| S7-DXF-004 | Layer semantics | Eleven layers and linetype order pass |
| S7-DXF-005 | XDATA identity | Bounded APPID source/part/revision identity plus manifest linkage pass |
| S7-DXF-006 | Hand-authored valid fixture | Parser accepts independently |
| S7-DXF-007 | Wrong section/missing blocks | Parser rejects |
| S7-DXF-008 | LAYER before LTYPE/wrong entry | Parser rejects |
| S7-DXF-009 | Wrong owner/subclass/lineweight | Parser rejects |
| S7-DXF-010 | Duplicate handle/HANDSEED | Parser rejects |
| S7-DXF-011 | Unsupported entity/XREF/proxy/script/3D | Parser rejects |
| S7-DXF-012 | Numeric/string/XDATA bounds | Bounded failure |
| S7-DXF-013 | Manifest missing/extra/changed entity | Correspondence failure |
| S7-SOURCE-001 | Source change at every fence | Abort/stale, no disclosure |
| S7-LIFE-001 | Same key/input | One job/export and replay |
| S7-LIFE-002 | Same key/different input | Key reuse error |
| S7-LIFE-003 | Concurrent different key | One active job, other busy |
| S7-LIFE-004 | Dead owner | One retry, no third |
| S7-LIFE-005 | Live/unknown owner | Never stolen |
| S7-LIFE-006 | Staged/promoted restart | Exact bytes resume |
| S7-LIFE-007 | Different final object | No overwrite |
| S7-LIFE-008 | Source supersession | History retained, download blocked |
| S7-API-001 | Auth-first | Unauthorized indistinguishable 404 |
| S7-API-002 | Exact route/body/key | Valid pass, extras reject |
| S7-API-003 | Download headers | Private/no-store/nosniff/exact size |
| S7-API-004 | Handoff | Current committed/readback only |
| S7-SEC-001 | Cross-project IDs | No disclosure |
| S7-SEC-002 | Traversal/labels | Fixed keys/sanitized text |
| S7-SEC-003 | Resource exhaustion | Bounds fail closed |
| S7-SEC-004 | Secret/privacy scan | No values/raw payloads |
| S7-SEC-005 | Evidence separation | No product evidence coupling |
| S7-TEL-001 | Empty state | Exact zero/unavailable cost |
| S7-TEL-002 | Failures/fences | Durable counts exact |
| S7-S8-001 | Typed handoff | Same S6 authority/plan identity |

## TDD implementation plan for later G3

Every task below starts only after the docs-only merge and Web G3 activation.

### Task 1 - Add exact types, constants, and numeric helpers

Files: src/lib/types.ts; src/lib/s7-geometry.ts; tests/s7-geometry.test.ts.

- RED: test every version/layer/record key, transform parity, half-away rounding, negative zero, exponent/finite/ceiling rejection, and absence of evidence fields/collection; run the focused test and expect new exports absent.
- GREEN: add the exact types/constants, independent affine math, centi-mm quantization, fixed decimal helpers, safe ASCII helpers, and no dependency.
- REFACTOR: keep source types, geometry types, and numeric formatters separate; rerun focused tests and pnpm typecheck.

### Task 2 - Add persistence defaults and graph validation

Files: src/lib/store.ts; src/lib/s7-persistence.ts; tests/s7-persistence.test.ts.

- RED: test missing S7 defaults, wrong keys/literals/UUIDs/hashes/statuses/attempts, mismatched source/job/readback graphs, duplicate keys, retry chains, and forbidden s7CadEvidence.
- GREEN: add five empty arrays, invoke validators after existing validators on load/transact, enforce all record/graph rules, and preserve S1-S6 state.
- REFACTOR: separate record and graph validators; run focused test and typecheck.

### Task 3 - Implement source binding and all fences

Files: src/lib/s7-cad.ts; tests/s7-handoff.test.ts.

- RED: test exact handoff/digest/binding, eligibility snapshot-only behavior, every fence row, no S6 mutation, and no image read.
- GREEN: implement readCurrentS7Source/assertCurrentS7Source using the existing S6 read-only handoff and persist exact bindings.
- REFACTOR: centralize comparison/cloning and keep source logic out of writer/geometry; run focused tests/typecheck.

### Task 4 - Implement exact projected solids

Files: src/lib/s7-geometry.ts; tests/s7-geometry.test.ts.

- RED: test all-eight-corner rect, nested Euler parity, profile union/seams, plan-normal CIRCLE, tilted analytic ELLIPSE/LINE, rank-one exact output, ambiguity failure, open sides, unknowns, and out-of-envelope diagnostics.
- GREEN: implement the algorithms above, quantize after construction, and never facet/box/clip/fallback.
- REFACTOR: separate affine, arrangement, round analytic classification, and quantization; run all geometry fixtures/typecheck.

### Task 5 - Implement deterministic AC1015 writer and manifest

Files: src/lib/s7-dxf-writer.ts; tests/s7-dxf.test.ts; tests/fixtures/s7/golden-plan-minimal.dxf.

- RED: test exact header/section/table/block order, LTYPE-before-LAYER, model/paper records/definitions, handle map/HANDSEED, all six writers/common fields, layers, full bounded source/part/revision XDATA, LF/no BOM/ASCII, determinism/golden hashes.
- GREEN: plan all entities, allocate handles, emit scaffold/entities, build non-circular private manifest, and use no CAD library.
- REFACTOR: separate entity planning, record emission, and manifest hash; rerun writer/geometry/typecheck.

### Task 6 - Implement strict independent raw-DXF readback

Files: src/lib/s7-dxf-readback.ts; tests/s7-dxf.test.ts; tests/fixtures/s7/hand-authored-valid-ac1015.dxf.

- RED: add independently hand-authored valid fixtures and all wrong-order/missing/metadata/entity/XDATA/handle/number/bound/manifest cases; prove no writer import/call and keep raw parser/version separate from the durable validation receipt.
- GREEN: implement tokenizer/state machine/allowlist, raw parsing, manifest comparison, and canonical readback receipt.
- REFACTOR: separate grammar, numeric checks, entity parsing, and correspondence; run focused readback/security tests/typecheck.

### Task 7 - Implement lifecycle, publication phases, idempotency, recovery

Files: src/lib/s7-cad.ts; tests/s7-persistence.test.ts; tests/s7-api.test.ts.

- RED: test every status/phase, replay/reuse/busy, claim/liveness, two attempts, staging/promote/commit, exact hash/size, no overwrite, restart, stale/superseded download and handoff.
- GREEN: implement exact sequence/key formulas with shared repository/object-store primitives, retain fences/claims through commit, and return safe DTOs.
- REFACTOR: keep pure modules outside the service and transitions CAS-protected; run focused lifecycle/typecheck.

### Task 8 - Add auth-first API and persisted client

Files: src/lib/api.ts; app/components/S7Client.tsx; app/projects/[projectId]/s7/page.tsx; tests/s7-api.test.ts.

- RED: test auth-first construction, exact routes/methods/body/key/statuses, safe errors/headers, status/download/handoff UI, and no evidence coupling.
- GREEN: reuse authorization/download patterns and build the small persisted status/download screen with retained keys; do not expose the internal release HOLD in runtime DTOs or customer UI.
- REFACTOR: separate route parsing/auth/errors/service and keep private data out of client DTOs; run focused API/UI tests/typecheck.

### Task 9 - Add telemetry and S7-to-S8 handoff

Files: src/lib/s7-telemetry.ts; src/lib/s7-cad.ts; tests/s7-handoff.test.ts; tests/s7-api.test.ts.

- RED: test zero/unavailable costs, durable failure/fence counts, source/export/readback identity, currentness, hash/size, open sides, stable correspondence, and no private/evidence fields.
- GREEN: implement exact telemetry/handoff and require internal readback/currentness, not external CAD, for download/handoff.
- REFACTOR: keep projections read-only/privacy-minimized; run focused tests/typecheck.

### Task 10 - Close adversarial security and regression

Files: tests/s7-security.test.ts; package.json; S7 implementation files only for targeted defects.

- RED: add cross-project, traversal, injection, parser exhaustion, malformed manifest, stale race, secret, no-provider/no-CAD/evidence-coupling cases.
- GREEN: enforce bounds/generic errors; confirm no CAD SDK/provider/credential/cloud call, lockfile change, DWG, 3D, image reconstruction, or product evidence collection; append tests without removing prior tests.
- REFACTOR: run the accepted six-file focused test command, pnpm typecheck, pnpm lint, pnpm build, pnpm audit --prod, git diff --check, and then the full pnpm test regression.

### Task 11 - G3 self-review and later evidence packet

Files: implementation/test paths in this map only; no status/report file.

- Scan S7 implementation/tests for TODO/TBD/FIXME and inspect this plan separately.
- Verify one consistent use of AC1015, BLOCK_RECORD, BLOCKS, HANDSEED, s7-dxf-r2000-ascii-v1, s7-to-s8-handoff-v1, and absence of forbidden evidence fields/collection.
- Compare rg --files src app tests with the map; run focused S7 tests, pnpm typecheck, pnpm test, git diff --check, and secret-value audit.
- Prepare later local version-pinned CAD evidence bound to exact head/profile/fixtures; Web retains G4/finality and HOLD decisions.

## Focused and full validation commands

### Current G2 docs-only publication

Run only:

~~~powershell
git diff --check
git status --short
git diff --stat
git diff --name-only 877a6ee81741be041f71bbcf36d385c64fda050d...HEAD
~~~

Also run the bounded literal/contract sweep required by the repair receipt, prove the obsolete DXF-prefixed readback literal is absent, prove product runtime has no external-CAD evidence or internal HOLD field contract, and run the pre-publish secret-value audit. These are documentation/repository checks only; do not run product tests for this G2 repair.

Expected changed names are exactly:

~~~text
docs/superpowers/specs/2026-09-03-s7-accurate-editable-2d-cad-handoff.md
docs/superpowers/plans/2026-09-03-s7-accurate-editable-2d-cad-handoff-implementation-plan.md
~~~

Do not run product tests merely to validate this docs-only branch and do not modify runtime/test/dependency files.

### Later G3 focused validation

~~~powershell
pnpm exec tsx --test tests/s7-geometry.test.ts tests/s7-dxf.test.ts tests/s7-persistence.test.ts tests/s7-api.test.ts tests/s7-security.test.ts tests/s7-handoff.test.ts
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --prod
git diff --check
~~~

Later full regression:

~~~powershell
pnpm test
git diff --check
~~~

## Documentation closure and G3/G4 boundaries

This G2 step closes the accepted G1/G2 contract into these two canonical docs only. It does not duplicate it in README, package metadata, runtime code, tests, generated artifacts, or a status/report file. The existing S6 plan and implementation remain S6 authority; this plan consumes them through s6-to-s7-handoff-v1 without rewriting S6.

G3 starts only after Web reviews, marks Ready/merges, re-verifies canonical main/tree, and explicitly activates S7 G3. G4 requires complete G3 implementation/internal validation plus representative local version-pinned AutoCAD-compatible open/import/edit/save/reopen evidence bound to exact head/profile/fixtures. The tooling HOLD remains nonblocking for G3 and blocks G4 acceptance/finality until Web clears it.

No G3 authority is claimed. No G4/S8/S9 work starts here. No gate-specific programme issue is created.

## Plan self-review

1. Authority: PASS - parent/child, terminal S6, base SHA/tree, accepted locks, four Web receipts, and owner boundaries are exact.
2. Source: PASS - one current accepted handoff is bound by revision ID/hash, S5 fingerprint, validation receipt ID/hash/outcome, digest/version, eligibility snapshot rule, and every required fence.
3. Geometry: PASS - independent full-Euler/parent parity, exact rect hull, profile union seam removal, analytic round circle/ellipse/line rank handling, no fallback/clipping, and diagnostics.
4. Numeric: PASS - 0.01 mm, centi-mm, half-away-from-zero, no negative zero/exponent, deterministic formatting, defensive ceiling.
5. DXF: PASS - AC1015 header/units/profile, section order, four tables, LTYPE-before-LAYER, BLOCK_RECORD/BLOCKS, common metadata, six entities, handles, HANDSEED, XDATA, exclusions.
6. Identity: PASS - SWOOSHZ_S7, full bounded source/part/revision XDATA with manifest linkage, private immutable manifest identity/hash, and all required correspondence fields.
7. Validation separation: PASS - runtime readback/integrity/currentness per export; external CAD release evidence only; no product evidence fields/collection.
8. Lifecycle/security: PASS - private staging, no-overwrite, hash/size, idempotency, two attempts, liveness recovery, stale fencing, committed-to-superseded history, auth-first disclosure, filename, bounds, generic errors, privacy logs.
9. API/telemetry/handoff: PASS - exact service/routes/UI, telemetry semantics, and s7-to-s8-handoff-v1 DTO.
10. Tests/release: PASS - golden/hand-authored fixtures, positive/negative/adversarial matrix, commands, later CAD procedure, HOLD, and G3/G4 boundary.
11. Scope: PASS - current step changes only two docs, claims no G3 authority, creates no programme issue, and adds no product/runtime/test/dependency code.

## ELI5

First we write down exactly how S7 turns the trusted S6 booth model into a real editable 2D plan. The plan fixes the shapes, numbers, DXF structure, identity trail, safety checks, retries, private files, and handoff. The app later checks its own raw file. A real local CAD program is still needed for final interoperability proof, but that is a release check, not a requirement for every customer export.
