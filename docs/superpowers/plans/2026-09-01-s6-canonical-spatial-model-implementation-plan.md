# S6 - Canonical Spatial Model + Coherent Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a bounded S6 workflow that projects the current fully-ready S5 approval into an immutable, validated, millimetre-based booth spatial model; supports audited child-revision corrections; and publishes deterministic coherent review views from the exact accepted model.

**Architecture:** Keep S1-S5 immutable. A typed, read-only S5 projection is source-fenced by a canonical fingerprint. A deterministic compiler produces renderable booth/object primitives, an independent validator gates lifecycle transitions, correction requests create immutable child revisions, and a deterministic geometry-backed SVG renderer produces all views from one accepted revision. Private object storage, exact promotion, optimistic concurrency, recovery, authorization, and privacy patterns are reused from S1-S5.

**Tech Stack:** TypeScript 5.8.3, Next.js 16.3.2, React 19.2.8, Node node:test through tsx, the existing JsonRepository, PrivateObjectStore, AppError, sha256, and jcs utilities only where their existing contracts apply. No new runtime dependency.

---

## G2 boundary and acceptance

This document is the G2 implementation-contract candidate for DL-SD-S6-G2-001. It is documentation/plan material only. G2 does not implement any S6 product or runtime file. Web retains acceptance, G3 authority, implementation and repair authority, Ready/merge/finality, and programme progression. The lock is:

PROPOSED - NOT ACCEPTED

G3 is blocked until Web accepts this contract and plan. This plan does not self-accept DL-SD-S6-G2-001.

The implementation branch must not change S1-S5 records, approvals, artifacts, assets, telemetry, or history. The S6 source adapter may read the current S5 approval and validated artifacts, but it has no S5 mutation capability. S6 ends at an accepted, validated spatial-model handoff; it does not implement DXF, DWG, FBX, .max, S7 CAD, or S8 production 3D.

## Repository file map

The implementation must begin from the canonical main commit recorded by G2. The current repository uses a JSON snapshot repository and a private file object store, not SQL migrations. Existing StoreState collections are extended with empty defaults and strict validators so old state files remain readable without inventing data.

### Existing files to modify

| File | Responsibility after S6 | Consumes | Exposes | Why this file is the minimum location |
|---|---|---|---|---|
| src/lib/types.ts | Persisted S6 TypeScript unions, records, DTOs, constants, and StoreState collection fields | Existing UUID, Timestamp, Sha256, OpenSide, BoothGeometry, S2/S5 types | All S6 public and persisted types named in this plan | It is the repository's single persisted-type module; duplicating durable types would make StoreState and validators drift. |
| src/lib/store.ts | S6 default collection loading and transaction-time S6 graph validation hooks | StoreState, validateS6Collections, validateS6Graph | Backward-compatible JsonRepository load/transact behavior | The existing repository owns snapshot defaults and all stage graph validation. A second repository path would bypass locking. |
| src/lib/s5.ts | Typed, read-only getS6ReadOnlyProjection(projectId) | Existing frozen S5 context, current approval, validated plan/artifacts, confirmed brief | S5ToS6Projection without any mutation capability | S5 already owns approval freshness and artifact integrity; reimplementing that logic in S6 would create a second source of truth. |
| src/lib/workflow.ts | Construct and expose one S6WorkflowService using the shared repository/object store and lifecycle hooks | Existing service options, S5 service, S6 service options | WorkflowService.s6 and S6 hook wiring | This is the existing composition root. No stage should create an independent store or provider. |
| src/lib/api.ts | S6 path recognition, auth-first service construction, DTO parsing, safe errors, download headers, and route dispatch | Existing S3AuthorizationBoundary, ApiRequestDependencies, NextResponse | The exact /projects/:projectId/s6/... HTTP surface below | Existing S3-S5 routes establish the authentication-before-disclosure boundary and generic error envelope. |
| package.json | Add the named S6 tests to the existing test script without removing S1-S5 tests | Existing tsx --test command | One regression command covering S1-S6 | The package script is the documented test entry point; no separate test runner is justified. |

### New files to add

Each new file has one responsibility. The implementation must not introduce a catch-all S6 utility module or move unrelated S1-S5 code.

| File | Responsibility | Consumes | Exposes | Why an existing file is insufficient |
|---|---|---|---|---|
| app/components/S6Client.tsx | Client editor/review screen using persisted S6 state and retained idempotency keys | S6 DTOs, createIdempotencyKeyRetainer, UnknownNetworkOutcome | createS6Client, S6Screen | S5 already has the stage-client pattern; a separate client prevents S5 UI from acquiring S6 mutation logic. |
| app/projects/[projectId]/s6/page.tsx | Thin route page that renders S6Screen for the project | Route params, S6Client | The S6 route page | It mirrors the existing stage page and keeps server page code free of client state. |
| src/lib/s6-canonical.ts | Fixed-point number checks, normalization, canonical S6 serialization, model hash, stable object IDs | S6 types and existing sha256 | Canonical constants and pure functions | Existing jcs intentionally accepts general JSON numbers; changing it could alter S1-S5 hashes. S6 needs a stricter integer-only contract. |
| src/lib/s6-persistence.ts | Strict S6 collection validators and cross-collection lineage/artifact/idempotency graph checks | S6 types, uuidV4Pattern, S6 canonical checks | validateS6Collections, validateS6Graph | s5-persistence.ts must remain S5-specific and cannot validate S6 revision lineage or view artifacts. |
| src/lib/s6-source.ts | Read-only source adapter, source-fingerprint construction, and stale checks | S5ToS6Projection, repository/object store, S6 canonical serializer | S6SourceReader, readReady, currentFingerprint, assertCurrent | S5 read APIs do not expose an S6 typed projection or S6-specific fingerprint rules. |
| src/lib/s6-compiler.ts | Deterministic conversion from one source projection into one initial spatial model | S5ToS6Projection, primitive rules, stable ID functions | compileS6Draft | s5-layout.ts intentionally creates conceptual normalized markers and cannot be reused as metric geometry. |
| src/lib/s6-validation.ts | Independent ordered validation of model, source fence, requirements, hierarchy, containment, cameras, and hashes | Model, source projection, camera builder | validateS6Model, issue codes and validation result | Existing S5 validation validates conceptual plan semantics, not a metric object hierarchy or coherent views. |
| src/lib/s6-correction.ts | Typed correction operation validation and immutable child-model construction | Existing model, exact correction DTO, canonical IDs | applyS6Corrections, allowlists | Keeping correction rules pure and separate makes the UX unable to bypass geometry or hierarchy guards. |
| src/lib/s6-camera.ts | Three stable camera formulas and camera hashes | Accepted model booth/object bounds | S6_VIEW_IDS, buildS6Cameras, camera validation data | Camera formulas are a durable view contract, not renderer-private constants. |
| src/lib/s6-renderer.ts | Geometry-backed deterministic axonometric and top-view SVG generation | Model, camera, material refs, fixed projection math | renderS6View, S6RenderedView scene evidence | s5-svg.ts labels output conceptual and not-to-scale; using it for S6 would misrepresent metric geometry. |
| src/lib/s6-preservation.ts | Structured model-to-view preservation evidence and artifact acceptance | Model, camera, rendered scene evidence | checkS6ViewPreservation, preservation receipt | Pixels alone cannot prove exact counts, IDs, or dimensions; this module makes the scene evidence explicit. |
| src/lib/s6-publication.ts | Exact staging, promote, commit, no-overwrite, and restart recovery helpers | PrivateObjectStore, JsonRepository, S6 artifact/job records | Publication/recovery state transitions | Existing S5 publication code has S5-specific fences and fields; copying it into the service would obscure S6 recovery invariants. |
| src/lib/s6-telemetry.ts | Privacy-minimized S6 counters and availability semantics | S6 state and source-readiness result | buildS6Telemetry | S5 telemetry has S5 field families and cannot silently acquire S6-specific cost or payload fields. |
| src/lib/s6-handoff.ts | Typed S6-to-S7 handoff projection from one current accepted model | Accepted model, validation receipt, source projection | buildS6ToS7Handoff | S7 must consume the accepted model directly and must not reconstruct it from hero imagery or a renderer. |
| src/lib/s6.ts | S6 workflow orchestration and public service methods | All S6 pure modules, shared repository/object store, S5 source reader | S6WorkflowService | A stage-level service is required for idempotency, authorization subject audit, lifecycle CAS, and recovery coordination. |

### New test files

| File | Responsibility |
|---|---|
| tests/s6-fixture.ts | Build a fresh S1-S5-ready fixture, deterministic clocks/UUIDs, S6 source projection, and isolated object/repository roots. |
| tests/s6-canonical.test.ts | Canonical integer representation, rounding, overflow, equality, hashes, stable IDs, and serialization limits. |
| tests/s6-persistence.test.ts | Legacy defaults, strict records, lineage, no ID reuse, artifact graph, and malformed-state rejection. |
| tests/s6-source.test.ts | Typed S5 projection, source fingerprint inclusion/exclusion, readiness, and every stale fence. |
| tests/s6-compiler.test.ts | All open-side variants, known/unknown height, exact counts, deterministic placement, primitive families, and compiler IDs. |
| tests/s6-validation.test.ts | Every validation order category, blocking matrix, hierarchy, containment, collision, unknowns, and hash receipt. |
| tests/s6-correction.test.ts | Move/rotate/resize/material/map/resolve/add/remove restrictions, child identity continuity, and conflict tokens. |
| tests/s6-renderer.test.ts | Camera formulas, byte-deterministic views, scene evidence, material shading, and view-preservation checks. |
| tests/s6-lifecycle.test.ts | Generation, revision lineage, acceptance, idempotency, concurrent CAS, jobs, publication, and restart recovery. |
| tests/s6-api.test.ts | Exact HTTP routes, auth-first construction, DTO errors, safe errors, headers, stale downloads, and handoff. |
| tests/s6-security.test.ts | Cross-project access, path traversal, SVG injection, remote-resource rejection, payload bounds, and private storage. |
| tests/s6-handoff.test.ts | Exact S7 handoff fields, accepted/current eligibility, unknown height, footprints, and no hero reinterpretation. |

## Locked persisted contract

### Schema versions, limits, and storage model

The following strings and limits are locked for the MVP:

~~~ts
export const S6_SPATIAL_SCHEMA_VERSION = "s6-spatial-model-v1" as const;
export const S6_SOURCE_PROJECTION_SCHEMA_VERSION = "s5-to-s6-projection-v1" as const;
export const S6_SOURCE_FINGERPRINT_VERSION = "s6-s5-source-fingerprint-v1" as const;
export const S6_MODEL_ARTIFACT_SCHEMA_VERSION = "s6-spatial-model-artifact-v1" as const;
export const S6_VALIDATION_SCHEMA_VERSION = "s6-validation-receipt-v1" as const;
export const S6_CORRECTION_SCHEMA_VERSION = "s6-correction-event-v1" as const;
export const S6_ACCEPTANCE_SCHEMA_VERSION = "s6-acceptance-event-v1" as const;
export const S6_SUPERSESSION_SCHEMA_VERSION = "s6-supersession-event-v1" as const;
export const S6_VIEW_ARTIFACT_SCHEMA_VERSION = "s6-view-artifact-v1" as const;
export const S6_VIEW_PRESERVATION_SCHEMA_VERSION = "s6-view-preservation-v1" as const;
export const S6_JOB_SCHEMA_VERSION = "s6-job-state-v1" as const;
export const S6_IDEMPOTENCY_SCHEMA_VERSION = "s6-idempotency-v1" as const;
export const S6_HANDOFF_SCHEMA_VERSION = "s6-to-s7-handoff-v1" as const;
export const S6_CANONICALIZER_VERSION = "s6-canonical-json-v1" as const;
export const S6_VALIDATOR_VERSION = "s6-validator-v1" as const;
export const S6_VALIDATION_ORDER_VERSION = "s6-validation-order-v1" as const;
export const S6_RENDERER_VERSION = "s6-svg-axonometric-v1" as const;
export const S6_ID_VERSION = "s6-object-id-v1" as const;

export const S6_MAX_OBJECTS = 256;
export const S6_MAX_ZONES = 64;
export const S6_MAX_CAMERAS = 3;
export const S6_MAX_MATERIALS = 128;
export const S6_MAX_UNKNOWNS = 256;
export const S6_MAX_ASSUMPTIONS = 256;
export const S6_MAX_PROVENANCE_ENTRIES = 512;
export const S6_MAX_REVISIONS_PER_PROJECT = 512;
export const S6_MAX_OPERATIONS = 32;
export const S6_MAX_LABEL_CODE_POINTS = 120;
export const S6_MAX_NOTE_CODE_POINTS = 400;
export const S6_MAX_MODEL_BYTES = 1_000_000;
export const S6_MAX_CORRECTION_BODY_BYTES = 64_000;
export const S6_MAX_VIEW_BYTES = 2_000_000;
export const S6_MAX_VIEW_SET_BYTES = 6_000_000;
export const S6_MAX_JOB_ATTEMPTS = 2;
~~~

JsonRepository remains the durable database. Add these collections to StoreState, with emptyStoreState() returning empty arrays:

~~~ts
s6SpatialModels: S6SpatialModelRecord[];
s6ValidationReceipts: S6ValidationReceipt[];
s6CorrectionEvents: S6CorrectionEvent[];
s6AcceptanceEvents: S6AcceptanceEvent[];
s6SupersessionEvents: S6SupersessionEvent[];
s6ViewArtifacts: S6ViewArtifact[];
s6ViewPreservationReceipts: S6ViewPreservationReceipt[];
s6Jobs: S6JobState[];
s6Idempotency: S6IdempotencyState[];
~~~

When an old state snapshot lacks any S6 field, loading supplies an empty array and does not rewrite the file merely because it was read. If a present S6 field is not an array, contains an unknown key, has an invalid literal, or breaks a graph invariant, load and transaction fail as PERSISTENCE_FAILED. The repository calls validateS6Collections(parsedRecord, merged) after S5 collection validation and validateS6Graph(merged) after S5 graph validation on both load and transaction. No SQL migration, automatic data repair, or synthetic S6 record is permitted.

### Exact TypeScript persisted types

The implementation must add these exact shapes to src/lib/types.ts. UUID, Timestamp, Sha256, and OpenSide retain their existing definitions.

~~~ts
export type S6RevisionStatus =
  | "generated_draft"
  | "corrected_draft"
  | "accepted_current"
  | "superseded"
  | "stale"
  | "rejected"
  | "aborted";

export type S6ProvenanceKind =
  | "confirmed_project_input"
  | "user_confirmed_design_decision"
  | "bounded_design_inference"
  | "unknown_unresolved";

export type S6Provenance = {
  kind: S6ProvenanceKind;
  sourceRef: string;
  sourceFingerprint: Sha256 | null;
  acceptedByUser: boolean;
  note: string | null;
};

export type S6CoordinateConvention = {
  version: "booth-local-right-handed-v1";
  units: "millimetres";
  handedness: "right-handed";
  origin: "north-west-floor-corner";
  xAxis: "east";
  yAxis: "up";
  zAxis: "south";
};

export type S6Mm = number;
export type S6Millidegree = number;

export type S6Vector3Mm = {
  xMm: S6Mm;
  yMm: S6Mm;
  zMm: S6Mm;
};

export type S6Dimensions = {
  widthMm: S6Mm;
  depthMm: S6Mm;
  heightMm: S6Mm;
};

export type S6RotationMd = {
  xMd: S6Millidegree;
  yMd: S6Millidegree;
  zMd: S6Millidegree;
};

export type S6Transform = {
  positionMm: S6Vector3Mm;
  rotationMd: S6RotationMd;
};

export type S6PrimitiveKind =
  | "floor_footprint"
  | "wall"
  | "partition"
  | "box"
  | "counter"
  | "display_plinth"
  | "screen"
  | "storage_volume"
  | "table"
  | "seating_marker"
  | "equipment_placeholder"
  | "overhead_volume"
  | "zone_region";

export type S6ObjectRole =
  | "booth_floor"
  | "booth_wall"
  | "booth_partition"
  | "furniture"
  | "display"
  | "screen"
  | "storage"
  | "seating"
  | "equipment"
  | "overhead"
  | "zone";

export type S6GeometryPrimitive = {
  kind: S6PrimitiveKind;
  dimensionsMm: S6Dimensions;
  geometryState: "exact" | "bounded_inference";
  localAnchor: "floor" | "center";
};

export type S6MaterialFinishKind =
  | "solid_color"
  | "wood_like"
  | "metal_like"
  | "fabric_like"
  | "glass_like"
  | "brand_reference"
  | "unknown";

export type S6MaterialFinishRef = {
  materialId: string;
  label: string;
  finishKind: S6MaterialFinishKind;
  colorHex: string | null;
  source: "confirmed_project_input" | "user_confirmed_design_decision" | "s5_visual_intent" | "bounded_design_inference" | "unknown";
  sourceAssetId: UUID | null;
  sourceAssetSha256: Sha256 | null;
  notes: string | null;
  provenance: S6Provenance;
};

export type S6SpatialObject = {
  objectId: string;
  identityKey: string;
  parentObjectId: string | null;
  objectType: S6PrimitiveKind;
  role: S6ObjectRole;
  label: string;
  primitive: S6GeometryPrimitive;
  transform: S6Transform;
  zoneIds: string[];
  requirementIds: string[];
  materialIds: string[];
  unknownIds: string[];
  provenance: S6Provenance;
  hardConstraint: "booth_envelope" | "requirement" | "design_inference" | "user_editable";
  editable: boolean;
  removable: boolean;
};

export type S6Zone = {
  zoneId: string;
  label: string;
  category: S5ZoneCategory;
  regionObjectId: string;
  requirementIds: string[];
  unknownIds: string[];
  provenance: S6Provenance;
};

export type S6Unknown = {
  unknownId: string;
  kind: "geometry" | "material" | "requirement_mapping" | "camera";
  fieldPath: string;
  requirementId: string | null;
  question: string;
  blocking: boolean;
  status: "unresolved" | "resolved";
  resolutionNote: string | null;
  resolvedBy: "user" | "system" | null;
  resolvedAt: Timestamp | null;
  provenance: S6Provenance;
};

export type S6Assumption = {
  assumptionId: string;
  fieldPath: string;
  value: string;
  provenance: S6Provenance;
  acceptedByUser: boolean;
  requiresConfirmation: boolean;
  createdAt: Timestamp;
};

export type S6BoothEnvelope = {
  widthMm: S6Mm;
  depthMm: S6Mm;
  openSides: OpenSide[];
  maxHeightMm: S6Mm | null;
  coordinateConvention: S6CoordinateConvention;
  heightState: "known" | "unknown";
};

export type S6ViewId = "perspective-northwest" | "perspective-southeast" | "top-orthographic";

export type S6Camera = {
  viewId: S6ViewId;
  projection: "perspective" | "orthographic";
  positionMm: S6Vector3Mm;
  targetMm: S6Vector3Mm;
  up: "world-y" | "negative-world-z";
  fovMd: S6Millidegree | null;
  orthoScaleMm: S6Mm | null;
  paddingMm: S6Mm;
  nearMm: S6Mm;
  farMm: S6Mm;
  heightBasis: "confirmed_max_height" | "derived_render_height";
  derivedRenderHeightMm: S6Mm;
  cameraHash: Sha256;
};

export type S6ArtifactPointer = {
  artifactKey: string;
  stagingKey: string;
  sha256: Sha256 | null;
  byteSize: number | null;
  status: "not_written" | "staged" | "promoted" | "committed" | "failed_terminal";
};

export type S6SpatialModelRecord = {
  schemaVersion: "s6-spatial-model-v1";
  modelRevisionId: UUID;
  projectId: UUID;
  parentRevisionId: UUID | null;
  parentRevisionHash: Sha256 | null;
  revisionNumber: number;
  sourceS5Fingerprint: Sha256;
  sourceS5ApprovalEventId: UUID;
  sourceS5ApprovalGeneration: number;
  status: S6RevisionStatus;
  booth: S6BoothEnvelope;
  objects: S6SpatialObject[];
  zones: S6Zone[];
  materials: S6MaterialFinishRef[];
  cameras: S6Camera[];
  provenance: S6Provenance[];
  assumptions: S6Assumption[];
  unknowns: S6Unknown[];
  modelHash: Sha256;
  canonicalByteSize: number;
  modelArtifact: S6ArtifactPointer;
  validationReceiptId: UUID | null;
  acceptanceEventId: UUID | null;
  createdBy: "compiler" | "user_correction";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  acceptedAt: Timestamp | null;
  supersededAt: Timestamp | null;
  staleAt: Timestamp | null;
};

export type S6ValidationSeverity = "error" | "warning";
export type S6ValidationIssue = {
  code: string;
  severity: S6ValidationSeverity;
  fieldPath: string;
  objectId: string | null;
  requirementId: string | null;
  detail: string;
};

export type S6ValidationReceipt = {
  schemaVersion: "s6-validation-receipt-v1";
  receiptId: UUID;
  projectId: UUID;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  validatorVersion: "s6-validator-v1";
  orderVersion: "s6-validation-order-v1";
  outcome: "pass" | "pass_with_warnings" | "acceptance_blocked" | "render_blocked" | "failed";
  errors: S6ValidationIssue[];
  warnings: S6ValidationIssue[];
  checkedAt: Timestamp;
  validationHash: Sha256;
};

export type S6CorrectionOperation =
  | { kind: "move"; objectId: string; deltaMm: S6Vector3Mm }
  | { kind: "rotate"; objectId: string; rotationMd: S6RotationMd }
  | { kind: "resize"; objectId: string; dimensionsMm: S6Dimensions }
  | { kind: "material"; objectId: string; material: S6MaterialFinishRef }
  | { kind: "zone_requirement_map"; objectId: string; zoneIds: string[]; requirementIds: string[] }
  | { kind: "resolve_unknown"; unknownId: string; resolutionNote: string; replacement: { objectType: S6PrimitiveKind; role: S6ObjectRole; label: string; dimensionsMm: S6Dimensions; positionMm: S6Vector3Mm; rotationMd: S6RotationMd; material: S6MaterialFinishRef } | null }
  | { kind: "add"; objectType: "counter" | "display_plinth" | "screen" | "storage_volume" | "table" | "seating_marker" | "equipment_placeholder"; role: "furniture" | "display" | "screen" | "storage" | "seating" | "equipment"; label: string; dimensionsMm: S6Dimensions; positionMm: S6Vector3Mm; rotationMd: S6RotationMd; material: S6MaterialFinishRef; parentObjectId: string | null; zoneIds: string[]; requirementIds: string[] }
  | { kind: "remove"; objectId: string };

export type S6ConcurrencyToken = {
  expectedRevisionId: UUID;
  expectedRevisionHash: Sha256;
  expectedParentRevisionId: UUID | null;
  expectedParentHash: Sha256 | null;
  expectedCurrentAcceptedRevisionId: UUID | null;
  expectedCurrentAcceptedHash: Sha256 | null;
  expectedSourceFingerprint: Sha256;
};

export type S6CorrectionEvent = {
  schemaVersion: "s6-correction-event-v1";
  correctionEventId: UUID;
  projectId: UUID;
  parentRevisionId: UUID;
  parentRevisionHash: Sha256;
  childRevisionId: UUID;
  childRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  actorSubjectId: string;
  operations: S6CorrectionOperation[];
  requestHash: Sha256;
  idempotencyKey: UUID;
  requestReferenceId: UUID;
  occurredAt: Timestamp;
};

export type S6AcceptanceEvent = {
  schemaVersion: "s6-acceptance-event-v1";
  acceptanceEventId: UUID;
  projectId: UUID;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  priorAcceptedRevisionId: UUID | null;
  priorAcceptedRevisionHash: Sha256 | null;
  actorSubjectId: string;
  expectedCurrentAcceptedRevisionId: UUID | null;
  expectedCurrentAcceptedHash: Sha256 | null;
  idempotencyKey: UUID;
  requestReferenceId: UUID;
  occurredAt: Timestamp;
};

export type S6SupersessionEvent = {
  schemaVersion: "s6-supersession-event-v1";
  supersessionEventId: UUID;
  projectId: UUID;
  supersededRevisionId: UUID;
  supersededRevisionHash: Sha256;
  replacementRevisionId: UUID;
  replacementRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  acceptanceEventId: UUID;
  actorSubjectId: string;
  requestReferenceId: UUID;
  occurredAt: Timestamp;
};

export type S6ViewArtifactStatus = "queued" | "running" | "staged" | "promoted" | "committed" | "failed_retryable" | "failed_terminal" | "aborted";
export type S6PublicationPhase = "none" | "staged" | "promoted" | "committed" | "aborted";

export type S6ViewArtifact = {
  schemaVersion: "s6-view-artifact-v1";
  artifactId: UUID;
  artifactGroupId: UUID;
  projectId: UUID;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  viewId: S6ViewId;
  purpose: "draft_preview" | "accepted_view";
  rendererVersion: "s6-svg-axonometric-v1";
  format: "svg";
  mimeType: "image/svg+xml";
  fileExtension: ".svg";
  fileName: "swooshz-spatial-perspective-northwest.svg" | "swooshz-spatial-perspective-southeast.svg" | "swooshz-spatial-top-orthographic.svg";
  artifactKey: string;
  stagingKey: string;
  outputSha256: Sha256 | null;
  outputByteSize: number | null;
  cameraHash: Sha256;
  sceneHash: Sha256 | null;
  preservationReceiptId: UUID | null;
  attempt: 1 | 2;
  retryOfArtifactId: UUID | null;
  status: S6ViewArtifactStatus;
  publicationPhase: S6PublicationPhase;
  workerId: string | null;
  processId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  stagedAt: Timestamp | null;
  promotedAt: Timestamp | null;
  completedAt: Timestamp | null;
  terminalAt: Timestamp | null;
  failureCode: string | null;
  idempotencyKey: UUID;
  requestReferenceId: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S6ViewPreservationReceipt = {
  schemaVersion: "s6-view-preservation-v1";
  receiptId: UUID;
  projectId: UUID;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  viewId: S6ViewId;
  rendererVersion: "s6-svg-axonometric-v1";
  cameraHash: Sha256;
  sceneHash: Sha256;
  outcome: "pass" | "fail";
  hardInvariantHash: Sha256;
  objectIds: string[];
  overheadObjectIds: string[];
  materialIds: string[];
  checks: S6ValidationIssue[];
  checkedAt: Timestamp;
  receiptHash: Sha256;
};

export type S6JobKind = "generation" | "validation" | "render" | "publication";
export type S6JobStatus = "queued" | "running" | "staged" | "promoted" | "committed" | "failed_retryable" | "failed_terminal" | "aborted";

export type S6JobState = {
  schemaVersion: "s6-job-state-v1";
  jobId: UUID;
  projectId: UUID;
  kind: S6JobKind;
  revisionId: UUID | null;
  viewId: S6ViewId | null;
  sourceS5Fingerprint: Sha256;
  inputHash: Sha256;
  attempt: 1 | 2;
  retryOfJobId: UUID | null;
  status: S6JobStatus;
  publicationPhase: S6PublicationPhase;
  artifactId: UUID | null;
  workerId: string | null;
  processId: number | null;
  claimToken: UUID | null;
  claimedAt: Timestamp | null;
  startedAt: Timestamp | null;
  stagedAt: Timestamp | null;
  promotedAt: Timestamp | null;
  completedAt: Timestamp | null;
  terminalAt: Timestamp | null;
  failureCode: string | null;
  idempotencyKey: UUID;
  requestReferenceId: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S6IdempotencyOperation = "generation" | "correction" | "reopen" | "validation" | "acceptance" | "render" | "publication";
export type S6IdempotencyState = {
  schemaVersion: "s6-idempotency-v1";
  key: UUID;
  operation: S6IdempotencyOperation;
  projectId: UUID;
  inputHash: Sha256;
  sourceS5Fingerprint: Sha256;
  result: S6MutationResult | S6ValidationReceipt | S6AcceptanceResult | S6RenderResult | S6PublicationResult;
  createdAt: Timestamp;
};
~~~

The public DTOs are also locked so route handlers, clients, and tests cannot invent incompatible shapes:

~~~ts
export type S6RevisionSummary = {
  revisionId: UUID;
  revisionHash: Sha256;
  parentRevisionId: UUID | null;
  status: S6RevisionStatus;
  sourceS5Fingerprint: Sha256;
  objectCount: number;
  zoneCount: number;
  unknownCount: number;
  validationOutcome: S6ValidationReceipt["outcome"] | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type S6ViewSummary = {
  viewId: S6ViewId;
  revisionId: UUID;
  revisionHash: Sha256;
  purpose: "draft_preview" | "accepted_view";
  status: S6ViewArtifactStatus;
  rendererVersion: "s6-svg-axonometric-v1";
  preservationOutcome: "pass" | "fail" | null;
  outputSha256: Sha256 | null;
  outputByteSize: number | null;
};

export type S6PublicState = {
  projectId: UUID;
  source: {
    readiness: "ready" | "not_ready";
    sourceS5Fingerprint: Sha256 | null;
    approvalEventId: UUID | null;
    approvalGeneration: number | null;
  };
  currentAcceptedRevisionId: UUID | null;
  currentAcceptedRevisionHash: Sha256 | null;
  editableRevision: S6RevisionSummary | null;
  revisions: S6RevisionSummary[];
  views: S6ViewSummary[];
  concurrency: S6ConcurrencyToken | null;
};

export type S6PublicSpatialModel = Omit<S6SpatialModelRecord, "modelArtifact"> & {
  modelArtifact: {
    sha256: Sha256 | null;
    byteSize: number | null;
    status: S6ArtifactPointer["status"];
  };
};

export type S6PublicRevision = {
  revision: S6PublicSpatialModel;
  validation: S6ValidationReceipt | null;
  views: S6ViewSummary[];
};

export type S6MutationResult = {
  replayed: boolean;
  revisionId: UUID;
  revisionHash: Sha256;
  status: S6RevisionStatus;
  sourceS5Fingerprint: Sha256;
  currentAcceptedRevisionId: UUID | null;
  currentAcceptedRevisionHash: Sha256 | null;
  concurrency: S6ConcurrencyToken;
};

export type S6AcceptanceResult = S6MutationResult & {
  acceptanceEventId: UUID;
};

export type S6RenderResult = {
  replayed: boolean;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  artifactGroupId: UUID;
  views: S6ViewSummary[];
};

export type S6PublicationResult = {
  replayed: boolean;
  artifactId: UUID;
  revisionId: UUID;
  revisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  view: S6ViewSummary;
};

export type S6PublicViewArtifact = S6ViewSummary & {
  artifactId: UUID;
  artifactGroupId: UUID;
  cameraHash: Sha256;
  sceneHash: Sha256;
  preservationReceiptId: UUID;
  downloadPath: string;
};
~~~

The implementation may use private helper types, but persisted JSON must have exactly these field names and the strict literal values above. result is a server-created, bounded result DTO; it is never arbitrary client JSON.

## Numeric and canonicalization contract

Durable geometry has no floating-point values. S6Mm is a safe integer number of millimetres; S6Millidegree is a safe integer of one-thousandth of a degree. All persisted numeric fields must satisfy Number.isSafeInteger, must not be -0, and must be within the field-specific bounds below.

- Booth and physical object dimensions: 100 <= widthMm/depthMm/heightMm <= 100,000. The only dimensions below 100 are the floor_footprint height of 1 and a seating_marker symbolic dimension of at least 1.
- Booth confirmed width/depth retain the existing S1 minimum and maximum. Object dimensions use the same maximum and a minimum of 1 only for a seating_marker; all other physical primitives use 100.
- Absolute object/camera coordinates: -1,000,000 <= coordinateMm <= 1,000,000.
- Known booth maximum height: 100 <= maxHeightMm <= 100,000; unknown is exactly null, never zero or a sentinel.
- Rotation: each axis is normalized to -180000 <= value < 180000 millidegrees. One full turn is 360000.
- Perspective FOV: 5,000 <= fovMd <= 120,000; orthographic cameras have fovMd: null.
- Orthographic scale: 100 <= orthoScaleMm <= 200,000; perspective cameras have orthoScaleMm: null.
- Camera clipping: 1 <= nearMm < farMm <= 2,000,000.
- Renderer projection coordinates use signed Q16 integer units (S6_RENDER_Q16 = 65536) and are never persisted as geometry.

The conversion used by the UX for a decimal degree display is roundHalfAwayFromZero(degrees * 1000). The API accepts only integer millidegrees and integer millimetres. A decimal request is rejected rather than rounded server-side. The same half-away-from-zero helper is used for compiler/render quantization. Rotation normalization is modulo 360000, followed by the half-open range above. Equality is exact after normalization; there is no epsilon equality for durable model identity.

s6-canonical.ts must not call the general jcs function for the S6 model hash. It must:

1. validate exact keys and integer bounds;
2. normalize open sides in OPEN_SIDE_ORDER, rotations, material hex casing, and array order;
3. sort objects by objectId, zones by zoneId, materials by materialId, cameras by viewId, and provenance/unknown/assumption arrays by their IDs;
4. serialize object keys in UTF-16 code-unit lexical order;
5. serialize integer numbers as their base-10 decimal form with no exponent, no leading zero, and no negative zero;
6. use UTF-8 bytes of that string as hash input;
7. return sha256(bytes) and the exact byte length.

The model hash covers the canonical model content: schema version, revision ID, project ID, parent identity, source fingerprint, booth envelope, objects, zones, materials, cameras, provenance, assumptions, and unknowns. It excludes lifecycle timestamps, status, validation receipt ID, acceptance event ID, and artifact storage pointers. This keeps geometry identity stable across acceptance/publication. The model artifact bytes are a separate canonical document containing the model content and modelHash; its SHA-256 is the artifact hash. Hash input is never a JS-generated string containing uncontrolled floating-point output.

Overflow is checked before multiplication in volume/area and projection calculations. Use bigint for intermediate products where an integer product can exceed the safe integer range, then reject if the final bounded result cannot be represented safely. Reject model JSON over S6_MAX_MODEL_BYTES, correction bodies over S6_MAX_CORRECTION_BODY_BYTES, and view SVG over S6_MAX_VIEW_BYTES.

## Typed S5 source projection and fingerprint

s5.ts adds this read-only method:

~~~ts
getS6ReadOnlyProjection(projectId: UUID): S5ToS6Projection
~~~

S5ToS6Projection is the one typed S5-to-S6 projection. It is a returned value with no callbacks, write methods, or mutable S5 object references:

~~~ts
export type S5ToS6Projection = {
  schemaVersion: "s5-to-s6-projection-v1";
  readOnly: true;
  readiness: "ready";
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  selectionVersion: number;
  approvalEventId: UUID;
  approvalGeneration: number;
  eventSequence: number;
  generationContextHash: Sha256;
  activeRevisionId: UUID;
  activeRevisionKind: S5ActiveRevisionKind;
  sourceSnapshotId: UUID;
  lineageRootRevisionId: UUID;
  sourceBindingHash: Sha256;
  quality: "PASS" | "WARNING";
  activeAsset: {
    assetId: UUID;
    storageKey: string;
    sha256: Sha256;
    byteSize: number;
    width: 1536;
    height: 1024;
    pixelCount: 1572864;
  };
  confirmedBriefVersionId: UUID;
  briefContentHash: Sha256;
  geometrySnapshot: BoothGeometry;
  geometryHash: Sha256;
  canonicalRequirements: S2Requirement[];
  requirementHash: Sha256;
  layoutRequirements: S5LayoutRequirement[];
  layoutRequirementsHash: Sha256;
  designRulesVersion: "s2-design-rules-v1";
  designRuleSnapshot: S2DesignRuleSnapshot[];
  designRuleSnapshotHash: Sha256;
  presentationFacts: S5FrozenGenerationContext["presentationFacts"];
  visualIntent: {
    brandName: string | null;
    visualDirection: string | null;
    preferredColors: string[];
    materials: string[];
    logoInstructions: string | null;
    source: "confirmed_brief";
    sourceHash: Sha256;
  };
  layoutPlan: S5LayoutPlan;
  layoutArtifacts: {
    planJson: { artifactId: UUID; sha256: Sha256; byteSize: number; rendererVersion: string; status: "committed" };
    planSvg: { artifactId: UUID; sha256: Sha256; byteSize: number; rendererVersion: string; status: "committed" };
  };
  presentationArtifact: {
    artifactId: UUID;
    sha256: Sha256;
    byteSize: number;
    pageCount: number;
    rendererVersion: string;
    status: "committed";
  };
  sourceFingerprint: Sha256;
};
~~~

S5 constructs the projection only after it performs the existing current-approval/frozen-context checks, exact private object checks for the JSON plan, SVG, hero, and PDF, and confirmed brief hash validation. The projection is readOnly: true; S6 cannot call approve, reopen, generateLayout, or generatePresentation through it.

The source fingerprint is sha256(UTF8(canonicalS6Json({ ... }))) using s6-s5-source-fingerprint-v1 and includes exactly:

- projectId;
- generationSetId, selectionStateId, selectionVersion;
- approvalEventId, approvalGeneration, eventSequence, generationContextHash;
- activeRevisionId, activeRevisionKind, sourceSnapshotId, lineageRootRevisionId, sourceBindingHash, and quality;
- activeAsset.assetId, activeAsset.sha256, activeAsset.byteSize, activeAsset.width, activeAsset.height, and activeAsset.pixelCount;
- confirmedBriefVersionId, briefContentHash, visualIntent.sourceHash;
- geometrySnapshot, geometryHash;
- canonicalRequirements, requirementHash;
- layoutRequirements, layoutRequirementsHash;
- designRulesVersion, designRuleSnapshot, designRuleSnapshotHash;
- layoutPlan.planHash and layoutPlan.schemaVersion;
- the S5 layout renderer version.

The fingerprint excludes activeAsset.storageKey, S5 plan/PDF/SVG artifact IDs, artifact storage keys, PDF byte hash/size/page count, S5 telemetry, worker claims, timestamps, and presentation renderer bytes. Those values are checked for readiness and integrity but do not cause unrelated source-fingerprint churn. layoutPlan.planHash cryptographically binds the verified plan content; the projection still returns the full validated plan for compilation. Storage path changes therefore do not stale a valid model, while a changed approved geometry, exact count, source image, S5 approval generation, plan, or confirmed visual-intent hash does.

src/lib/s6-source.ts exposes:

~~~ts
export type S6SourceReader = {
  readReady(projectId: UUID): S5ToS6Projection;
  currentFingerprint(projectId: UUID): Sha256;
  assertCurrent(projectId: UUID, expectedFingerprint: Sha256): S5ToS6Projection;
};
~~~

Generation admission, draft persistence, correction, acceptance, rendering, publication, and read/download each perform assertCurrent at the named boundary. A mismatch raises S6_SOURCE_STALE before any new S6 record, staged object, final object, acceptance pointer, or download is returned. A source that is approved but missing any committed JSON plan, SVG plan, or presentation PDF raises S6_SOURCE_NOT_READY; it is not treated as a usable partial source. S6 never falls back to a non-ready S5 source or to hero pixels.

## Stable IDs and object lineage

Compiler IDs are deterministic:

s6o_ plus the first 32 lowercase hex characters of sha256("s6-object-id-v1|" + projectId + "|" + source.activeRevisionId + "|" + stableKey), where source.activeRevisionId is the immutable S5 active revision ID and never the S6 modelRevisionId.

Stable keys are:

- booth-floor;
- booth-wall:<openSide-opposite-side> for each closed side in north/east/south/west order;
- zone:<zoneId> for zone regions;
- requirement:<requirementId>:<objectRole>:<one-based-instance-index> for countable requirement objects.

Requirement and zone ordering is by canonical ID, not source array order. Recompiling the same S5 source produces the same IDs and model hash. A child revision copies an unchanged object's objectId and identityKey. identityKey is an immutable logical identity string and is included in S7 handoff.

User-added objects receive a server-generated s6u_ plus a UUID with hyphens removed. The client never supplies a durable object ID. A removed ID remains present in ancestor history and may not be reused for another identity. validateS6Graph allows the same object ID in ancestor/child revisions only when identityKey is identical; a different identity is OBJECT_ID_REUSED. A child that removes an object does not silently recreate it later. No compiler-generated ID is derived from a display label or pixel position.

## Primitive and object families

The MVP supports only the 13 primitive kinds in S6PrimitiveKind. All persisted objects have positive, bounded dimensions; unresolved geometry is represented by an S6Unknown and no renderable object. There is no arbitrary mesh, polygon, texture, extrusion, or scene-script field.

- floor_footprint: exact booth width/depth, height 1, non-editable, hard envelope.
- wall: axis-aligned or bounded rotated wall volume; required width/depth/height; generated only on closed sides.
- partition: bounded rectangular internal partition; required dimensions.
- box: general bounded rectangular design volume.
- counter: front-of-house counter volume.
- display_plinth: product/display plinth volume.
- screen: screen/equipment volume; no image URL.
- storage_volume: storage cabinet/volume.
- table: meeting/demo table.
- seating_marker: bounded seating marker volume; minimum dimensions may be 1 only for a symbolic marker, otherwise 100.
- equipment_placeholder: bounded equipment volume when exact equipment geometry is unavailable.
- overhead_volume: beam/truss-like design volume; it is a visual design volume, not a fabrication member.
- zone_region: non-fabrication region volume used for zone evidence and containment; it is not countable toward a physical requirement.

Per-family lock:

| Primitive | Required dimensions | Transform and containment | Exactness and unknown handling |
|---|---|---|---|
| floor_footprint | Booth width, booth depth, height 1 | Position at origin, zero rotation; must cover the booth envelope | Exact hard envelope; no unknown representation |
| wall | Side-span width/depth, thickness 100, wall height | Zero rotation and flush to one closed booth side; contained by the booth envelope | Exact hard envelope when height is confirmed; inferred height carries an assumption |
| partition | Positive width/depth/height | Translation and rotation allowed; all transformed corners must remain inside the floor | Exact only when confirmed; otherwise bounded inference or a blocking unknown |
| box | Positive width/depth/height | Translation and rotation allowed; contained inside the floor and below known height | Exact or bounded inference; missing dimensions produce an unknown and no object |
| counter | Positive width/depth/height | Translation/rotation allowed; floor-supported and inside booth | Bounded inference by compiler, user-confirmable; unresolved dimensions are an unknown |
| display_plinth | Positive width/depth/height | Translation/rotation allowed; floor-supported and inside booth | Bounded inference or exact user correction; unresolved dimensions are an unknown |
| screen | Positive width/depth/height | Translation/rotation allowed; supported by floor/parent and inside booth | Bounded inference or exact; no image/URL field, unresolved geometry is an unknown |
| storage_volume | Positive width/depth/height | Translation/rotation allowed; contained and floor-supported | Bounded inference or exact; unresolved dimensions are an unknown |
| table | Positive width/depth/height | Translation/rotation allowed; contained and floor-supported | Bounded inference or exact; unresolved dimensions are an unknown |
| seating_marker | Positive dimensions of at least 1 | Translation/rotation allowed; contained in its associated zone | Symbolic bounded inference is allowed; unresolved geometry is an unknown |
| equipment_placeholder | Positive width/depth/height | Translation/rotation allowed; contained and floor-supported or parent-supported | Bounded inference only until user confirmation; unresolved geometry is an unknown |
| overhead_volume | Positive width/depth/height | Translation/rotation allowed; fully inside known height or derived render envelope, never fabrication detail | Bounded design inference or user-confirmed; unresolved dimensions are an unknown |
| zone_region | Positive width/depth/height, height 1 minimum | Translation/rotation allowed; contained by floor, may contain mapped objects | Bounded semantic region; missing region geometry creates an unknown and blocks view publication |

geometryState: exact means the dimensions are confirmed or user-confirmed for that object. geometryState: bounded_inference means the dimensions are explicitly inferred, carry S6Provenance.kind: bounded_design_inference, and are auditable. Unknown dimensions never use a zero, NaN, null, or fake default inside a renderable object. The compiler may use a bounded inferred wall/render height when booth height is unknown, but the booth envelope remains maxHeightMm: null and the model carries an assumption.

Allowed transforms are translation in booth-local millimetres and Euler rotation in millidegrees. Scale is not supported in MVP; dimensions are changed by the resize operation. Parent transforms are applied through the hierarchy for validation and rendering. A child cannot be parented to itself or to a descendant.

## Deterministic compiler contract

src/lib/s6-compiler.ts exposes:

~~~ts
export type S6CompilerInput = {
  source: S5ToS6Projection;
  revisionId: UUID;
  parentRevisionId: UUID | null;
  clock: () => Timestamp;
};

export function compileS6Draft(input: S6CompilerInput): S6SpatialModelRecord;
~~~

Compiler rules:

1. Copy the confirmed booth width, depth, open sides, and known/unknown height from source.geometrySnapshot into S6BoothEnvelope. The coordinate convention is always the locked booth-local convention.
2. Create the floor first, then closed-side walls in OPEN_SIDE_ORDER complement order, then zone regions, then requirement objects in canonical requirement ID and category priority order, then bounded inferred architecture/overhead volumes. All arrays are canonicalized before hashing.
3. Use S5 layoutPlan.zones, coverage, and requirement mappings only for semantic relationships, category, labels, and ordering. Never use S5 xQ16, yQ16, widthQ16, or heightQ16 as metric coordinates. Preserve the S5 conceptual disclaimer in the provenance of any relationship derived from it.
4. Use confirmed structured requirement counts as the only count authority. expected: exact_count produces exactly the requested number of countable instances when the family is known. expected: present produces one bounded object when the family is known. expected: absent produces none. A prohibited or unknown semantic requirement produces an explicit unresolved mapping instead of a guessed object.
5. Map known categories deterministically: reception/welcome to counter, presentation/display to display_plinth or screen, demo/product to display_plinth, consultation/meeting to table plus seating markers, storage to storage_volume, interactive/activity to equipment_placeholder, and other categories to equipment_placeholder only when the S5 requirement is sufficiently specific. An unknown semantic creates S6Unknown(kind: requirement_mapping).
6. Place objects with deterministic bounded heuristics based on the confirmed booth envelope and category order: perimeter-facing counters on the first available closed-side run, display/demo objects in a central grid, meeting tables behind the front band, storage near a closed side, and overhead volumes above the central design band. These are design inferences, not survey measurements. Every inferred position/dimension has bounded_design_inference provenance.
7. Do not infer metric geometry from hero pixels. The approved hero asset is retained only as visual-intent lineage and may inform structured material labels/colors copied from the confirmed brief. Pixel inspection is not part of compilation.
8. If a required object cannot be safely bounded, omit it and create a blocking S6Unknown with the requirement ID. The draft can be persisted for user correction but cannot be accepted or rendered.
9. Use an allowlisted neutral/brand palette from source.visualIntent.preferredColors and materials; an unparseable or absent material becomes an explicit unknown or bounded neutral material with auditable inference. No remote asset or URL enters the model.
10. Set modelRevisionId, source identity, model hash, and canonical byte size deterministically from the input and injected IDs/clock. Do not mutate the S5 projection or any prior model.

The compiler is not a photogrammetric reconstruction. It produces an auditable initial design geometry whose relationships and material cues are reviewable and correctable.

## Validation contract

src/lib/s6-validation.ts exposes:

~~~ts
export type S6ValidationContext = {
  source: S5ToS6Projection;
  priorModels: readonly S6SpatialModelRecord[];
  expectedSourceFingerprint: Sha256;
};

export function validateS6Model(
  model: S6SpatialModelRecord,
  context: S6ValidationContext,
): S6ValidationReceipt;
~~~

The exact validation order is:

1. source readiness, project identity, and source-fingerprint equality;
2. schema/version, exact keys, payload bytes, and collection counts;
3. numeric bounds, fixed-point normalization, and canonical field representation;
4. booth envelope, coordinate convention, open-side set, and known-height semantics;
5. unique IDs, identity history, hierarchy cycles, and dangling parents;
6. primitive kinds, transforms, dimensions, rotation, and material references;
7. exact/present/absent requirement counts and requirement mappings;
8. object containment, floor contact, closed-wall placement, open-side integrity, and known maximum height;
9. meaningful physical-volume collisions and material/finish references;
10. unresolved unknowns and assumptions;
11. camera count, camera formulas, target/up vectors, clip planes, and camera hashes;
12. canonical serialization byte size and model hash.

Stable issue codes are:

SOURCE_STALE, SOURCE_NOT_READY, SPATIAL_SCHEMA_INVALID, PAYLOAD_TOO_LARGE, NUMERIC_OUT_OF_BOUNDS, CANONICAL_NUMBER_INVALID, BOOTH_ENVELOPE_INVALID, OPEN_SIDE_INTEGRITY, MAX_HEIGHT_EXCEEDED, OBJECT_ID_DUPLICATE, OBJECT_ID_REUSED, HIERARCHY_DANGLING_PARENT, HIERARCHY_CYCLE, TRANSFORM_INVALID, DIMENSIONS_INVALID, REQUIRED_COUNT_MISMATCH, REQUIREMENT_MAPPING_INVALID, CONTAINMENT_INVALID, MATERIAL_COLLISION, GEOMETRY_UNRESOLVED, CAMERA_INVALID, CANONICAL_HASH_MISMATCH, and VIEW_PRESERVATION_FAILED.

Blocking matrix:

- Source stale/not-ready, schema, payload, numeric, booth envelope, open-side, duplicate/reused ID, hierarchy, transform, dimensions, canonical hash, and cross-project errors block persistence of a new model or artifact.
- Required-count, mapping, containment, maximum-height, material-collision, or unresolved-geometry errors may persist a generated/corrected draft with a receipt whose outcome is acceptance_blocked; they block acceptance and rendering. This preserves a correction surface without accepting bad geometry.
- A non-blocking inferred material or non-critical assumption is a warning and may produce pass_with_warnings.
- Any error in the receipt blocks acceptance. Any error affecting object visibility, geometry, material reference, camera, or source freshness blocks rendering/publication.
- A view-preservation failure always rejects the artifact and leaves the accepted model unchanged.

Validation is independent of the compiler. The validator must not silently repair, reorder into validity after reporting a client error, or reinterpret unknown geometry.

## Revision, concurrency, and idempotency

Lifecycle transitions are:

generated_draft -> corrected_draft -> accepted_current -> superseded

Any revision whose S5 fingerprint no longer equals the current ready source is effectively stale; a transaction at generation, correction, acceptance, rendering, publication, or an explicit stale reconciliation may persist stale. A validation-failed draft can become rejected; an interrupted terminal job can mark a generated draft aborted. No accepted record is edited in place. Only one revision per project may be accepted_current for the current source fingerprint.

generate creates a root generated_draft when there is no current accepted revision for the current source. A repeated same-input generation replays its idempotent result. A separate generation against the same current source conflicts rather than branching. When S5 has a new source fingerprint, a new root draft is allowed and the old current revision is marked stale in the same transaction.

reopen never edits an accepted revision. It creates a corrected_draft child from the current accepted revision, copying the exact model content and object IDs. correct creates a corrected_draft child from a draft or reopened child. accept changes the child to accepted_current and the prior current revision to superseded atomically, writes one S6AcceptanceEvent and, when a prior accepted revision exists, one S6SupersessionEvent in the same transaction. There is no automatic merge or rebase.

render may create a private draft_preview for a generated/corrected draft or an accepted_view for the current accepted revision. publish accepts only a committed accepted_view for the current accepted revision. A draft preview is never treated as final coherent truth; the final accepted view is rendered from the accepted revision after acceptance.

Every correction, reopen, acceptance, render, and publication request carries the exact S6ConcurrencyToken. Generation has no parent revision and therefore accepts an empty JSON object; under the repository lock it snapshots the current accepted revision identity (or null) as its internal CAS expectation before source-fenced compilation, and the caller cannot supply or override that expectation. The service compares expected revision ID and model hash, expected parent revision ID and parent hash, expected current accepted revision ID and hash, and expected S5 source fingerprint. Any mismatch raises S6_REVISION_CONFLICT, S6_ACCEPTANCE_CONFLICT, or S6_SOURCE_STALE as appropriate. Concurrent corrections from the same parent cannot both commit under the same expected parent token. Concurrent acceptance has one winner; the loser receives a conflict. Idempotent replay is the only repeated request path.

Idempotency-Key is required for generation, correction, reopen, validation, acceptance, render, and publication. It must be a UUID. The service stores S6IdempotencyState with an input hash over operation, project, normalized DTO, concurrency token, source fingerprint, and actor-independent operation data. Same key and same hash returns the stored result without another mutation. Same key and different hash returns S6_IDEMPOTENCY_KEY_REUSE. Client createIdempotencyKeyRetainer keeps the key through UnknownNetworkOutcome; a new user operation gets a new key.

## Correction UX and service API

S6WorkflowService exposes these exact methods:

~~~ts
getState(projectId: UUID): S6PublicState;
getRevision(projectId: UUID, revisionId: UUID): S6PublicRevision;
generate(projectId: UUID, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult>;
reopen(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult>;
correct(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, operations: S6CorrectionOperation[], key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6MutationResult>;
validate(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<S6ValidationReceipt>;
accept(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID, actorSubjectId: string): Promise<S6AcceptanceResult>;
render(projectId: UUID, revisionId: UUID, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<S6RenderResult>;
publish(projectId: UUID, revisionId: UUID, viewId: S6ViewId, token: S6ConcurrencyToken, key: UUID, referenceId: UUID): Promise<S6PublicationResult>;
getView(projectId: UUID, revisionId: UUID, viewId: S6ViewId): S6PublicViewArtifact;
getViewDownload(projectId: UUID, revisionId: UUID, viewId: S6ViewId): { bytes: Buffer; contentType: "image/svg+xml"; fileName: string };
getTelemetry(projectId: UUID): S6Telemetry;
getS7Handoff(projectId: UUID): S6ToS7Handoff;
~~~

Exact routes:

- GET /projects/:projectId/s6 - current source/revision/view state and concurrency token.
- POST /projects/:projectId/s6/generation - empty JSON object; creates a draft.
- GET /projects/:projectId/s6/revisions/:revisionId - authorized full model and latest validation receipt.
- POST /projects/:projectId/s6/revisions/:revisionId/reopen - token; creates a child from current accepted.
- POST /projects/:projectId/s6/revisions/:revisionId/corrections - token plus operations; creates a correction child.
- POST /projects/:projectId/s6/revisions/:revisionId/validate - token; stores/replays a validation receipt.
- POST /projects/:projectId/s6/revisions/:revisionId/accept - token; accepts only a validated draft with no errors.
- POST /projects/:projectId/s6/revisions/:revisionId/render - token; renders exactly all three locked views into staging.
- GET /projects/:projectId/s6/revisions/:revisionId/views/:viewId - authorized view metadata.
- POST /projects/:projectId/s6/revisions/:revisionId/views/:viewId/publish - token; promotes one staged view with no overwrite.
- GET /projects/:projectId/s6/revisions/:revisionId/views/:viewId/download - private SVG download after stale checks.
- GET /projects/:projectId/s6/telemetry - safe telemetry.
- GET /projects/:projectId/s6/handoff - current accepted S7 handoff only; no CAD export.

The JSON body parser rejects non-object bodies, unknown keys, wrong types, invalid UUIDs, non-integer numeric fields, and bodies over the locked limit. Correction operations are limited to 32. acceptanceNote is intentionally not part of the acceptance DTO; an actor and immutable acceptance event are sufficient and avoid storing unbounded client text.

Exact request DTOs:

~~~ts
export type S6EmptyRequest = Record<string, never>;
export type S6GenerationRequest = S6EmptyRequest;
export type S6RevisionMutationRequest = S6ConcurrencyToken;
export type S6CorrectionRequest = S6ConcurrencyToken & { operations: S6CorrectionOperation[] };
export type S6ValidationRequest = S6ConcurrencyToken;
export type S6RenderRequest = S6ConcurrencyToken;
export type S6PublicationRequest = S6ConcurrencyToken;
~~~

The MVP has one project authorization boundary rather than a role table. Every read, correction, validation, generation, reopen, acceptance, render, publication, handoff, telemetry, and download requires the existing authorizeProject check for the project. A subject that passes project authorization may perform the authorized operation; the subject ID is retained in correction/acceptance/supersession history. No role, project ID, or S5 authority is inferred from client input.

Correction rules:

- move changes only the selected editable object's position by integer delta and is bounded to the booth/height rules.
- rotate replaces rotation with normalized integer millidegrees.
- resize replaces dimensions within primitive bounds; it cannot change primitive kind.
- material replaces the complete validated material reference; no URL, SVG, HTML, or arbitrary shader field exists.
- zone_requirement_map references only existing S6 zone and confirmed S2 requirement IDs.
- resolve_unknown requires a bounded note and, for geometry unknowns, a typed replacement object; it cannot resolve an unknown by text alone.
- add permits only the seven allowlisted object types in S6CorrectionOperation; the server generates the object ID.
- remove is permitted only for editable and removable objects. It cannot remove the floor, closed-side booth walls, zone regions, or any hard envelope object. Removing a required countable object is allowed only as a visible draft change and causes the exact-count validation failure until corrected.
- No operation changes booth width, booth depth, confirmed open sides, confirmed maximum height, exact source requirements, S5 identity, or the coordinate convention.

Authorization uses the existing S3AuthorizationBoundary shape. API auth resolves a subject and authorizes the project before constructing/using the workflow service or reading model/artifact data. The actor subject ID is persisted only in correction/acceptance history and is not returned in public DTOs. Denied, missing, or cross-project resources use the same generic 404 S6_UNAUTHORIZED_OR_NOT_FOUND behavior; no model existence, source hash, or artifact key is disclosed.

## Rendering technology decision

The choice is evidence-based against the actual repository:

| Option | Geometry fidelity | Design/material fidelity | Browser review | Deterministic/download/headless | Privacy/dependencies/licence/security | Decision |
|---|---|---|---|---|---|---|
| A. Server/browser deterministic SVG/isometric projection | Exact for the locked rectangular primitive set; preserves dimensions, walls, open sides, object IDs, and overhead volumes | Meets the bounded MVP bar when material refs are represented as deterministic color/finish shading; no claim to reproduce arbitrary hero pixels | Native browser SVG is inspectable and can be edited/selected by data-object-id | Server emits bytes without GPU, browser, or headless process; existing private store and S5 SVG patterns apply | No new dependency, no provider, no credentials, no remote textures, small attack surface | Chosen |
| B. Direct three browser renderer | Strong interactive 3D, but adds client/server serialization and SSR/browser lifecycle complexity | Better lighting potential, but material fidelity still depends on structured refs | Requires browser/WebGL review and another rendering path for download | Headless/server artifact generation would need an additional renderer or browser process | New direct/transitive packages, licence/advisory review, larger deployment surface, no evidence current primitives need it | Rejected for MVP |
| C. Geometry renderer plus bounded image/appearance enhancement | Geometry can remain exact only if SVG is authoritative and enhancement is separately verified | Potentially closer to hero finish, but provider output can drift geometry and requires a new trust/cost/privacy path | Requires visual and structured preservation review | Adds provider or image pipeline and failure/recovery states | Credentials, cost, privacy, prompt/image payload handling, and provider authority are not needed for S6 MVP | Rejected for MVP; future separately gated |
| D. APS, server GPU, or headless renderer | Potentially high | Not necessary for the locked primitive set | More operational dependencies | More deployment and recovery complexity | APS explicitly not required; external service/security/licence/availability burden | Rejected |

The chosen path is a deterministic, geometry-backed SVG axonometric renderer with shaded top/front/side faces, finish-specific deterministic color adjustments, material labels, object labels, stable camera metadata, and a user-facing top view. It is not the existing conceptual S5 SVG renderer. The renderer emits no image or remote URL and cannot alter the model. It meets the MVP coherent-view quality bar for the represented primitive families because the review artifact visibly preserves booth dimensions, open-side form, wall/partition form, major object count/identity/placement, overhead volumes, relative scale, and structured material/finish intent. When the brief contains material intent that cannot be represented by the allowlist, the model records that limitation as an unknown/inference; the renderer does not fake fidelity.

Deterministic geometry rendering alone meets the S6 bar. No bounded appearance enhancement is in this plan. If a later slice proposes enhancement, the geometry SVG remains the authoritative view source and remains available; the enhanced artifact must have its own provider/cost/privacy decision and geometry-preservation acceptance test. A failed preservation check rejects the enhanced artifact. No provider, image bytes, prompts, secret, or external service is introduced by this plan.

No new package is proposed. The implementation must leave pnpm-lock.yaml unchanged and use only current dependencies and browser SVG. The dependency/licence/advisory decision is therefore: no new direct or transitive role, no new licence, no new lockfile entry, and no new advisory surface. The implementation still runs the repository's existing lockfile policy and security validation before merge.

## Exact cameras and view set

S6_VIEW_IDS is exactly:

1. perspective-northwest - perspective design-review view from outside the north-west corner;
2. perspective-southeast - perspective design-review view from the opposite corner;
3. top-orthographic - user-facing top review and editor/QA surface.

Top view is both user-facing and the editor/QA surface. It includes zone and object labels when the selected model supports them; it is not merely a debug diagram.

The camera builder uses integer inputs and derives H as follows:

- if booth.maxHeightMm is known, H = booth.maxHeightMm and heightBasis = confirmed_max_height;
- otherwise H = max(3000, maximum object top) and heightBasis = derived_render_height, with booth.heightState = unknown and an explicit assumption.

Let P = clamp(roundHalfAwayFromZero(max(widthMm, depthMm, H) / 10), 500, 5000), C = { xMm: roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H / 3), zMm: roundHalfAwayFromZero(depthMm / 2) }.

- perspective-northwest: position {xMm: -P - roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H * 3 / 4), zMm: -P - roundHalfAwayFromZero(depthMm / 2)}, target C, up world-y, FOV 45000, near 100, far max(500000, 4 * (widthMm + depthMm + H + P)).
- perspective-southeast: position {xMm: widthMm + P + roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H * 3 / 4), zMm: depthMm + P + roundHalfAwayFromZero(depthMm / 2)}, target C, up world-y, FOV 45000, near 100, same far formula.
- top-orthographic: position {xMm: roundHalfAwayFromZero(widthMm / 2), yMm: H + 2 * P, zMm: roundHalfAwayFromZero(depthMm / 2)}, target {xMm: roundHalfAwayFromZero(widthMm / 2), yMm: 0, zMm: roundHalfAwayFromZero(depthMm / 2)}, up negative-world-z, FOV null, orthographic scale max(widthMm, depthMm) + 2 * P, near 1, far H + 4 * P.

Camera hash is the canonical hash of the camera with cameraHash removed. Camera arrays are exactly these three IDs in that order. Camera formulas are re-run during validation; a client cannot submit arbitrary camera parameters.

## View-preservation contract

renderS6View(model, camera) returns a S6RenderedView with SVG bytes, the camera hash, a scene hash, projected bounds, visible object IDs, material IDs, and scene evidence. The SVG contains only escaped text, inline geometry, validated hex colors, and data-s6-* metadata. It contains no image, external href, url(...), script, foreignObject, arbitrary CSS, or user-provided markup.

The renderer applies the locked local transform convention Rz * Ry * Rx to rectangular primitive corners, then projects with the camera, quantizes each SVG coordinate to signed Q16 integers, sorts faces by quantized depth and object ID, and emits stable XML attributes/child order. Face shading is a deterministic function of material color and face normal. Finish kinds change only the deterministic shade/opacity; they never change dimensions or topology.

For each view, preservation checks compare structured scene evidence rather than trusting pixels:

- hard booth width/depth and coordinate convention;
- exact open-side set and absence of a wall on every open side;
- known maximum height and all object tops;
- full visible object ID set, including every overhead object;
- primitive kind, count, projected bounding box, and dimensions within exact scene tolerance 0 before projection and 2 mm after quantization;
- camera hash, source fingerprint, model hash, and renderer version;
- every referenced material ID and allowlisted finish/color;
- no external SVG resource or unsafe element;
- scene hash equality between the pre-publication render result and persisted artifact evidence.

S6ViewPreservationReceipt.outcome is pass only if every hard check passes. The receipt is persisted before final publication and its receiptHash is canonical. Pixel/screenshot review is an optional visual QA signal for finish recognizability; it cannot waive a structured failure. Because the current renderer is the authoritative geometry view, no enhancement-specific preservation path is needed.

## Storage, publication, and recovery

All keys are built with privateStorageKey from validated UUIDs and allowlisted view tokens. The implementation must not concatenate user labels, filenames, material values, or URL text into a storage path.

- Model artifact final key: projects/<projectId>/s6/revisions/<revisionId>/model.json.
- Model staging key: projects/<projectId>/s6/staging/<jobId>/<claimToken>/model.json.
- View final key: projects/<projectId>/s6/revisions/<revisionId>/views/<viewId>/s6-svg-axonometric-v1.svg.
- View staging key: projects/<projectId>/s6/staging/<jobId>/<claimToken>/<viewId>.svg.

The model artifact MIME is application/json; view MIME is image/svg+xml. The fixed download names are the three names in S6ViewArtifact.fileName. Model bytes are at most 1,000,000; each view is at most 2,000,000; all three views are at most 6,000,000. Hashes are SHA-256 of exact UTF-8 artifact bytes. No final key may be overwritten. Existing putExact and promoteExact are reused.

Publication sequence:

1. authenticate and source-fence;
2. persist a queued job/artifact/idempotency record under the repository lock;
3. claim the job with a unique claim token; live and unknown owners are not stolen;
4. compute model/render bytes and run independent validation/preservation;
5. write exact staging bytes with putExact;
6. persist staged and exact byte/hash/scene/receipt identity;
7. re-check source fingerprint, revision hash, accepted/current eligibility, and claim token;
8. promote with promoteExact; a pre-existing different final object is a publication failure;
9. verify final bytes and persist promoted;
10. re-check the fence and persist committed;
11. remove staging best-effort only after commit; retain history and final stale artifacts.

No download returns a staged/promoted-but-uncommitted artifact. Read/download re-authenticates, re-reads current S5, checks source fingerprint, revision hash, current accepted status, preservation receipt, final object hash/size, and status === committed. A mismatch returns S6_STALE_ARTIFACT; the read path does not silently serve it.

Restart recovery is deterministic:

- queued work remains queued;
- a dead-owner running job becomes retryable once, with a new attempt and no duplicate final identity;
- an unknown/live owner remains busy and is not reclaimed;
- staged/promoted exact bytes are verified and resumed through promote/commit;
- missing or mismatched bytes become terminal S6_PUBLICATION_FAILED/S6_PUBLICATION_UNCERTAIN;
- a second failed attempt becomes terminal with no third dispatch;
- a stale source aborts the job and never publishes;
- history records and committed final artifacts are retained; abandoned staging objects may be cleaned after terminal recovery.

## Error catalogue and safe diagnostics

Stable S6 public error codes and HTTP statuses:

| Code | HTTP | Meaning |
|---|---:|---|
| S6_SOURCE_NOT_READY | 409 | S5 is not a fully-ready immutable source. |
| S6_SOURCE_STALE | 409 | S5 changed or the captured source fence is stale. |
| S6_SPATIAL_SCHEMA_INVALID | 422 | Model schema/version or exact-key validation failed. |
| S6_GEOMETRY_INVALID | 422 | Numeric, envelope, hierarchy, transform, containment, or collision validation failed. |
| S6_GEOMETRY_UNRESOLVED | 422 | Blocking unknown geometry or mapping remains. |
| S6_REVISION_CONFLICT | 409 | Expected parent/revision hash or lineage token is stale. |
| S6_ACCEPTANCE_CONFLICT | 409 | Current accepted revision changed or acceptance preconditions failed. |
| S6_VIEW_RENDER_FAILURE | 500 | Deterministic view generation failed. |
| S6_VIEW_PRESERVATION_FAILED | 422 | Structured scene evidence does not match the model. |
| S6_PUBLICATION_FAILED | 500 | Exact staging/promotion/commit failed. |
| S6_STALE_ARTIFACT | 409 | Artifact is not current, committed, or source-fenced. |
| S6_UNAUTHORIZED_OR_NOT_FOUND | 404 | Auth denied or resource does not exist. |
| S6_DEPENDENCY_UNAVAILABLE | 503 | A required local runtime dependency is unavailable; no fake fallback. |
| S6_IDEMPOTENCY_KEY_REUSE | 409 | One key was used with a different normalized request. |
| S6_PERSISTENCE_FAILED | 500 | Durable state could not be validated or committed. |
| S6_CLAIM_FENCED | 409 | A stale worker claim attempted a mutation. |
| S6_PUBLICATION_BUSY | 409 | A live/unknown publication owner still holds the claim. |
| S6_RETRY_EXHAUSTED | 409 | The bounded local recovery budget is consumed. |
| S6_INVALID_REQUEST | 400 | The request shape or field value is invalid. |
| S6_INTERNAL_ERROR | 500 | Unexpected internal failure. |

Public wording is always: The request could not be completed. Try again or contact support with the reference ID. The JSON envelope contains only code, that wording, the server-generated referenceId, and allowlisted field errors (body, revisionId, viewId, operations, expectedSourceFingerprint, expectedRevisionHash, and safe validation field names). Internal log context contains only reference ID, operation, project ID, revision ID, view ID, code, and attempt; it never contains briefs, prompts, image bytes, model payloads, storage keys, secrets, actor PII, or raw user text.

## Security and trust contract

- Authorization and project isolation run before service construction and before any model, source, artifact, or storage-key disclosure.
- Project/revision/artifact/view IDs are parsed against UUID/allowlist rules; user-controlled values never form raw storage paths.
- S1-S5 assets, the S5 hero, model JSON, and S6 SVG remain private; downloads use private, no-store, nosniff, fixed content types, fixed filenames, and exact content lengths.
- No secret, token, provider credential, prompt, image byte, model payload, or external URL is persisted or returned.
- SVG text is XML-escaped. Materials accept only validated hex colors and allowlisted finish values. No remote textures, href, url, scripts, HTML, foreign objects, or arbitrary scene code are accepted.
- Payload, count, label, operation, object, zone, material, camera, revision, artifact, and retry bounds above prevent obvious resource exhaustion.
- User-controlled correction values cannot change confirmed booth dimensions, open sides, confirmed height, exact source requirements, S5 identity, or coordinate convention.
- A user may accept a bounded inference, but its S6Provenance.kind remains bounded_design_inference and acceptedByUser records the audit fact; it is never relabelled as client-supplied fact.
- The renderer has no provider or network side effect. S7 receives the accepted structured model and never needs to reinterpret hero imagery.

## Telemetry contract

src/lib/s6-telemetry.ts uses the existing availability shape:

~~~ts
export type S6Metric<T> = {
  availability: "available" | "unavailable";
  value: T | null;
  reason: string | null;
};
~~~

S6Telemetry has exactly these field families:

~~~ts
export type S6Telemetry = {
  schemaVersion: "s6-telemetry-v1";
  projectId: UUID;
  sourceReadiness: S6Metric<"ready" | "not_ready">;
  generationCount: S6Metric<number>;
  correctionCount: S6Metric<number>;
  correctionFailureCount: S6Metric<number>;
  reopenCount: S6Metric<number>;
  acceptanceCount: S6Metric<number>;
  revisionConflictCount: S6Metric<number>;
  staleFenceCount: S6Metric<number>;
  renderRequestCount: S6Metric<number>;
  renderSuccessCount: S6Metric<number>;
  renderFailureCount: S6Metric<number>;
  viewPreservationFailureCount: S6Metric<number>;
  publicationFailureCount: S6Metric<number>;
  acceptedViewCount: S6Metric<number>;
  fullModelByteSize: S6Metric<number>;
  providerCost: S6Metric<number>;
  toolCost: S6Metric<number>;
  generatedAt: Timestamp;
};
~~~

Counts are available as exact durable event/job counts when the S6 state graph is valid, including exact zero. providerCost is always unavailable with reason no_provider_used; toolCost is always unavailable with reason no_billed_tool_amount. Unavailable is not encoded as zero. No telemetry field contains brief contents, full prompts, image bytes, model payloads, secrets, unnecessary PII, or raw error detail.

## S7 handoff

src/lib/s6-handoff.ts exposes:

~~~ts
export type S6ToS7Handoff = {
  schemaVersion: "s6-to-s7-handoff-v1";
  projectId: UUID;
  acceptedRevisionId: UUID;
  acceptedRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  spatialSchemaVersion: "s6-spatial-model-v1";
  units: "millimetres";
  coordinateConvention: S6CoordinateConvention;
  booth: {
    widthMm: S6Mm;
    depthMm: S6Mm;
    openSides: OpenSide[];
    maxHeightMm: S6Mm | null;
    heightState: "known" | "unknown";
  };
  objects: Array<{
    objectId: string;
    identityKey: string;
    parentObjectId: string | null;
    objectType: S6PrimitiveKind;
    role: S6ObjectRole;
    footprint: { xMm: S6Mm; zMm: S6Mm; widthMm: S6Mm; depthMm: S6Mm };
    transform: S6Transform;
    dimensionsMm: S6Dimensions;
    zoneIds: string[];
    requirementIds: string[];
    materialIds: string[];
    provenance: S6Provenance;
    unknownIds: string[];
  }>;
  hierarchy: Array<{ objectId: string; parentObjectId: string | null }>;
  zones: S6Zone[];
  requirements: S2Requirement[];
  materials: S6MaterialFinishRef[];
  assumptions: S6Assumption[];
  unknowns: S6Unknown[];
  validationReceipt: { receiptId: UUID; validationHash: Sha256; outcome: "pass" | "pass_with_warnings" };
  eligibility: { currentAccepted: true; sourceCurrent: true; stale: false };
};
~~~

The handoff is produced only from a current accepted revision with a passing receipt and current S5 source. It contains no hero image, prompt, renderer pixels, CAD, fabrication detail, or reinterpretation instruction. S7 can use the object IDs, hierarchy, footprints, transforms, dimensions, requirements, zones, materials, provenance, unknowns, and receipt directly.

## TDD implementation plan

Implementation follows the Superpowers writing-plans and test-driven-development workflow. Every task below is independently testable and meaningful to a reviewer. For each task, write the named failing test first, run the exact focused command and observe the named failure, implement the smallest production change, rerun for green, then refactor only while the same command remains green. Commit after each task with the exact commit message shown. A task is not complete if it only changes types without an executable assertion.

### Task 1 - Add persisted S6 types and fixed-point canonicalization

**Files:** modify src/lib/types.ts; add src/lib/s6-canonical.ts; add tests/s6-canonical.test.ts.

**Interface:** src/lib/types.ts provides the exact types/constants above. s6-canonical.ts provides assertS6Integer, normalizeS6Rotation, roundHalfAwayFromZero, canonicalS6Json, hashS6Model, compilerObjectId, and userObjectId.

- [ ] RED: Add tests named S6 canonical spatial JSON is byte and hash deterministic, S6 rejects fractional negative-zero non-safe and overflow values, S6 rotation normalizes to the half-open millidegree range, S6 uses half-away-from-zero rounding, and S6 compiler IDs are stable while user IDs are fresh.
- [ ] Run pnpm exec tsx --test tests/s6-canonical.test.ts; expect module/type failures before the new exports exist.
- [ ] GREEN: Add the exact integer validators and canonical serializer. Assert that a model with xMm: 1000, rotationMd: -180000, and the same canonical arrays hashes identically regardless of insertion order. Reject 1.5, Object(-0), Number.MAX_SAFE_INTEGER + 1, and coordinates outside the bound.
- [ ] Run the focused command; expect all five named cases to pass with zero failures.
- [ ] REFACTOR: Keep S6 number handling isolated from utils.jcs; rerun the focused command and pnpm typecheck.
- [ ] Commit: test(s6): lock spatial numeric canonicalization.

Example assertion:

~~~ts
assert.equal(
  hashS6Model(modelWithReorderedArrays).modelHash,
  hashS6Model(modelWithCanonicalArrays).modelHash,
);
assert.throws(() => canonicalS6Json({ value: 1.5 }), /CANONICAL_NUMBER_INVALID/);
assert.equal(normalizeS6Rotation({ xMd: 180000, yMd: -180001, zMd: 0 }).xMd, -180000);
~~~

### Task 2 - Add backward-compatible S6 persistence and graph validation

**Files:** add src/lib/s6-persistence.ts; modify src/lib/store.ts; add tests/s6-persistence.test.ts.

**Interface:** validateS6Collections(parsedRecord: unknown, state: StoreState): void and validateS6Graph(state: StoreState): void.

- [ ] RED: Add tests named legacy state without S6 collections loads empty, present malformed S6 collection is rejected, duplicate revision and broken parent graphs are rejected, child object IDs preserve identity and reject reuse, only one current accepted revision exists and supersession is recorded, and artifact attempts/retries/idempotency keys form a valid graph.
- [ ] Run pnpm exec tsx --test tests/s6-persistence.test.ts; expect the absent fields to be undefined or the malformed fixture to load because S6 hooks do not exist.
- [ ] GREEN: Add empty S6 arrays to emptyStoreState, load defaults for absent fields, invoke strict collection validators from JsonRepository.load, and invoke the graph validator from both load and transact. Reject unknown keys, wrong versions, duplicate IDs, invalid lineage, object identity reuse, non-contiguous attempts, and idempotency key/hash reuse.
- [ ] Run the focused command; expect all six cases to pass. Run pnpm exec tsx --test tests/s6-persistence.test.ts tests/s5.test.ts to prove S5 remains green.
- [ ] REFACTOR: Keep S6 validators independent of S5 validators and preserve all S1-S5 error mapping; rerun both commands.
- [ ] Commit: feat(s6): add strict persisted collections and graph validation.

### Task 3 - Expose the typed, read-only S5 projection and source fence

**Files:** modify src/lib/s5.ts; add src/lib/s6-source.ts; add tests/s6-source.test.ts.

**Interface:** S5WorkflowService.getS6ReadOnlyProjection(projectId) returns S5ToS6Projection; createS6SourceReader(repository, objects, projectionReader) returns S6SourceReader.

- [ ] RED: Add tests named ready S5 projection contains the exact typed fields, S5 plan coordinates remain conceptual and are not metric compiler inputs, PDF and storage-key churn does not change source fingerprint, geometry/requirements/hero/approval changes change source fingerprint, non-ready S5 is refused, and source fence rejects at generation draft correction acceptance render publication and download boundaries.
- [ ] Run pnpm exec tsx --test tests/s6-source.test.ts; expect the typed method and source reader imports to fail.
- [ ] GREEN: Refactor the existing S5 handoff checks into a typed projection method without changing S5 state. Read/validate the committed JSON plan and confirmed brand-style fields, calculate the exact fingerprint subset above, and implement assertCurrent with S6_SOURCE_STALE/S6_SOURCE_NOT_READY.
- [ ] Run the focused command; expect all six cases to pass and the existing S5 read-only handoff test to remain green.
- [ ] REFACTOR: Ensure the projection has no mutation capability and that the fingerprint excludes artifact IDs/storage keys but includes the approved asset hash and plan hash; rerun pnpm exec tsx --test tests/s6-source.test.ts tests/s5.test.ts.
- [ ] Commit: feat(s6): add typed S5 source projection and stale fence.

### Task 4 - Implement the deterministic metric compiler

**Files:** add src/lib/s6-compiler.ts; add tests/s6-fixture.ts; add tests/s6-compiler.test.ts.

**Interface:** compileS6Draft({ source, revisionId, parentRevisionId, clock }): S6SpatialModelRecord.

- [ ] RED: Add tests named compiler covers every one-to-four open-side variant, compiler creates no wall on any open side, known height remains confirmed and unknown height creates an audited assumption, compiler creates exact countable instances, compiler preserves stable IDs and deterministic placement, all MVP primitive families have bounded dimensions, unresolved semantic requirements create blocking unknowns, and S5 conceptual Q16 coordinates never become metric coordinates.
- [ ] Run pnpm exec tsx --test tests/s6-compiler.test.ts; expect the compiler module to be absent.
- [ ] GREEN: Compile floor, closed walls, zone regions, categorized requirement instances, and bounded overhead/design volumes with the exact ordering and provenance rules. Use a fixture matrix for all 15 non-empty open-side subsets and requirements with exact counts 0, 1, 2, and 4. Never copy S5 normalized coordinates.
- [ ] Run the focused command; expect all eight named cases to pass with exact model hashes for repeat inputs.
- [ ] REFACTOR: Move category mapping and placement constants into pure local functions, keep IDs in s6-canonical.ts, rerun the focused command and pnpm typecheck.
- [ ] Commit: feat(s6): compile deterministic spatial drafts.

Example compiler check:

~~~ts
for (const openSides of allNonEmptyOpenSideSubsets()) {
  const model = compileS6Draft(fixture.source(openSides));
  assert.deepEqual(
    model.objects.filter((item) => item.role === "booth_wall").map((item) => item.identityKey),
    closedSides(openSides).map((side) => "booth-wall:" + side),
  );
}
~~~

### Task 5 - Add the independent ordered validator

**Files:** add src/lib/s6-validation.ts; add tests/s6-validation.test.ts.

**Interface:** validateS6Model(model, context): S6ValidationReceipt.

- [ ] RED: Add tests named validation order reports source before geometry, numeric bounds and invalid transforms are rejected, hierarchy cycles and dangling parents are rejected, open-side/envelope/maximum-height failures are exact, exact requirement counts and mappings are enforced, unresolved geometry persists as a draft but blocks acceptance and render, meaningful physical collisions fail while floor/zone contact is allowed, camera and canonical hash failures are reported, and warnings do not become fabricated zero values.
- [ ] Run pnpm exec tsx --test tests/s6-validation.test.ts; expect the validator module to be absent.
- [ ] GREEN: Implement the 12-step validation order and blocking matrix. Ensure a receipt is itself canonically hashed and does not contain raw client text.
- [ ] Run the focused command; expect all nine named cases to pass. Run the compiler plus validator command to prove normal compiled drafts get the expected warning/pass result.
- [ ] REFACTOR: Keep validation pure and make status decisions in the service; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): validate spatial models independently.

### Task 6 - Implement immutable correction operations and child revisions

**Files:** add src/lib/s6-correction.ts; add tests/s6-correction.test.ts.

**Interface:** applyS6Corrections(parent, operations, { childRevisionId, clock, actorSubjectId }): { model, event }.

- [ ] RED: Add tests named move rotate resize and material operations create a child, zone and requirement mappings are typed and bounded, geometry unknown resolution requires a typed replacement, add generates a server ID and remove obeys allowlists, booth facts and hard objects cannot be edited, child revisions preserve unchanged object identity, deleted IDs cannot be reused, and stale parent tokens do not auto-merge.
- [ ] Run pnpm exec tsx --test tests/s6-correction.test.ts; expect the correction module to be absent.
- [ ] GREEN: Validate max 32 operations, apply them to a cloned model, preserve ancestor IDs/identity keys, generate server IDs for additions, maintain provenance, and leave booth/source fields immutable. Do not call the validator as a repair mechanism; return the changed model for independent validation.
- [ ] Run the focused command; expect all seven cases to pass.
- [ ] REFACTOR: Make each operation a discriminated pure handler and keep storage/event writes out of this file; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): add typed immutable spatial corrections.

### Task 7 - Add stable cameras, renderer, and structured preservation evidence

**Files:** add src/lib/s6-camera.ts, src/lib/s6-renderer.ts, and src/lib/s6-preservation.ts; add tests/s6-renderer.test.ts.

**Interfaces:** buildS6Cameras(model): S6Camera[]; renderS6View(model, camera): S6RenderedView; checkS6ViewPreservation(model, camera, rendered): S6ViewPreservationReceipt.

- [ ] RED: Add tests named camera formulas are stable for known and unknown height, the three view IDs are exact and deterministic, same model/camera produce byte-identical SVG, SVG preserves major forms/material IDs/overhead objects, SVG contains no remote resources or executable content, top view is a user-facing editor surface, and preservation fails on changed object IDs/open sides/materials.
- [ ] Run pnpm exec tsx --test tests/s6-renderer.test.ts; expect the camera/renderer modules to be absent.
- [ ] GREEN: Implement fixed camera formulas, quantized projection, deterministic face ordering/shading, escaped SVG, data attributes, scene evidence, and hard preservation checks. Use the visual fixture with floor, two closed walls, counter, display, screen, table, and overhead volume; assert its SVG contains visible face/material/overhead metadata rather than only wireframe lines.
- [ ] Run the focused command; expect all seven cases to pass and exact SVG hashes to remain stable.
- [ ] REFACTOR: Keep projection math separate from camera formulas and preservation separate from SVG string construction; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): render deterministic coherent spatial views.

### Task 8 - Implement S6 lifecycle, idempotency, acceptance, and recovery service

**Files:** add src/lib/s6.ts; add src/lib/s6-publication.ts; modify src/lib/workflow.ts; add tests/s6-lifecycle.test.ts.

**Interface:** WorkflowService.s6 is constructed with the shared repository/object store, injected S6SourceReader, deterministic clock/UUID, process liveness, and publication hook.

- [ ] RED: Add tests named generation persists one source-fenced draft, same generation key replays without a second draft, correction creates immutable lineage and acceptance writes a supersession event, concurrent corrections and acceptance conflict, idempotency keys cover generation correction reopen validation acceptance render and publication, stale source blocks every mutation boundary, draft previews cannot be published, render/publish use exact no-overwrite promotion, and restart recovery handles queued running staged promoted and terminal states.
- [ ] Run pnpm exec tsx --test tests/s6-lifecycle.test.ts; expect WorkflowService.s6 and the service module to be absent.
- [ ] GREEN: Implement service methods, source checks at every boundary, repository CAS tokens, S6 idempotency records, validation receipts, job claims, exact model/view publication, and bounded recovery. Use no provider and no fallback success.
- [ ] Run the focused command; expect all nine cases to pass. Run pnpm exec tsx --test tests/s6-lifecycle.test.ts tests/s5.test.ts to prove S5 state remains unchanged by projection/generation.
- [ ] REFACTOR: Keep pure compiler/validator/correction/render functions outside the service, centralize safe result cloning, and retain claim tokens through final commit; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): add fenced revision and publication lifecycle.

### Task 9 - Add auth-first S6 API routes and private downloads

**Files:** modify src/lib/api.ts; add tests/s6-api.test.ts.

**Interface:** Extend ApiRequestDependencies reuse without adding a second authorization system. Add isS6Path, authorizedS6Service, handleS6, and S6 public error allowlists.

- [ ] RED: Add tests named S6 authorization runs before service construction, exact routes reject wrong methods and unknown fields, generation/correction/acceptance/render/publish DTOs are exact, safe errors expose only reference IDs and allowlisted fields, view download is private and no-store, stale view download is rejected, and handoff requires current accepted revision.
- [ ] Run pnpm exec tsx --test tests/s6-api.test.ts; expect S6 paths to fall through to the existing not-found route and the new imports to be absent.
- [ ] GREEN: Add auth-first routing and exact JSON parsing. Reuse the existing private download response headers: content-type, fixed content-disposition, cache-control private/no-store, x-content-type-options nosniff, and exact content-length.
- [ ] Run the focused command; expect all seven cases to pass. Run the existing S4/S5 API tests to confirm their routes/errors did not change.
- [ ] REFACTOR: Keep public error code mapping separate from internal diagnostics and use the same generic unauthorized/not-found behavior; rerun focused API and regression tests.
- [ ] Commit: feat(s6): expose authorized spatial model routes.

### Task 10 - Add the persisted S6 editor/review screen

**Files:** add app/components/S6Client.tsx; add app/projects/[projectId]/s6/page.tsx.

**Interface:** createS6Client({ projectId, operationKeys, fetcher }) and S6Screen({ projectId }).

- [ ] RED: Add UI assertions to tests/s6-api.test.ts or a focused component section named S6 client retains keys through uncertain mutation, top-view selection sends stable object IDs, and S6 UI does not expose forbidden booth-fact controls.
- [ ] Run pnpm exec tsx --test tests/s6-api.test.ts; expect the new component imports/selectors to be absent.
- [ ] GREEN: Build a small persisted-state screen that loads GET /s6, shows source/revision/readiness, renders the top SVG, selects by data-object-id, and provides bounded move/rotate/resize/material/map/resolve/add/remove controls. Use withRetainedIdempotencyKey and show UnknownNetworkOutcome without minting a new key.
- [ ] Ensure controls for booth width/depth/open sides/max height, exact source counts, S5 approval, and arbitrary scene markup do not exist. The screen must reload state rather than treating a local optimistic model as accepted.
- [ ] Run pnpm typecheck and the focused API/component command; expect green.
- [ ] REFACTOR: Keep network client functions separate from render components and do not place server auth/material values in the client bundle; rerun typecheck and the full test command.
- [ ] Commit: feat(s6): add persisted spatial review editor.

### Task 11 - Add telemetry and the exact S7 handoff

**Files:** add src/lib/s6-telemetry.ts, src/lib/s6-handoff.ts; add tests/s6-handoff.test.ts; extend tests/s6-api.test.ts.

**Interfaces:** buildS6Telemetry(state, projectId, sourceStatus): S6Telemetry; buildS6ToS7Handoff(model, receipt, source): S6ToS7Handoff.

- [ ] RED: Add tests named telemetry reports exact zero and unavailable cost semantics, handoff includes accepted identity/hash/source fence/units/open sides, handoff preserves stable objects/hierarchy/footprints/materials/provenance/unknowns, unknown booth height remains unknown, and stale or draft revisions cannot produce a handoff.
- [ ] Run pnpm exec tsx --test tests/s6-handoff.test.ts; expect the two modules to be absent.
- [ ] GREEN: Implement exact fields, no payload/brief/prompt/image data, explicit unavailable reasons, and current-accepted/source-current eligibility.
- [ ] Run the focused handoff command and S6 API command; expect green.
- [ ] REFACTOR: Keep handoff projection read-only and avoid exposing private artifact keys; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): add telemetry and S7 handoff contract.

### Task 12 - Add adversarial security tests and S1-S5 regression

**Files:** add tests/s6-security.test.ts; modify package.json.

- [ ] RED: Add tests named cross-project IDs never disclose state, path traversal and user labels cannot escape private keys, SVG rejects scripts/URLs/foreign objects, payload/count/operation limits are enforced, private model/view artifacts require authorization, provider/tool costs remain unavailable, and existing S1-S5 suite remains green.
- [ ] Run pnpm exec tsx --test tests/s6-security.test.ts; expect the new module/test file to be absent.
- [ ] GREEN: Add the security assertions and append every new S6 test file to the existing pnpm test script without removing any prior test path.
- [ ] Run pnpm typecheck, pnpm exec tsx --test tests/s6-security.test.ts, and pnpm test; expect the existing 142-test baseline plus the S6 tests to pass with zero failures.
- [ ] REFACTOR: Run pnpm audit --prod using the repository lockfile policy, confirm no new package was added, and rerun pnpm typecheck plus pnpm test.
- [ ] Commit: test(s6): close security and regression matrix.

### Task 13 - Complete implementation self-review and documentation closure

**Files:** implementation files in the map only; no new status/report file.

- [ ] Run rg -n "\\bT[A-Z]{2}\\b|F.I.X.M.E" src app tests docs/superpowers/plans/2026-09-01-s6-canonical-spatial-model-implementation-plan.md and expect no unfinished-work markers in implementation or plan content.
- [ ] Run rg -n "s6-spatial-model-v1|S6SpatialModelRecord|S6ConcurrencyToken|S6_VIEW_IDS|S6_SOURCE_PROJECTION_SCHEMA_VERSION|S6_SOURCE_FINGERPRINT_VERSION|s6-svg-axonometric-v1" src/lib tests app and verify every symbol has one consistent definition and the same spelling in producers/consumers/tests.
- [ ] Run rg --files src app tests | Sort-Object plus the file-map checklist and verify every proposed path exists, every modified path is intentional, and no S7/S8 export path or dependency was added.
- [ ] Run git diff --check, pnpm typecheck, and pnpm test; record exact counts and failures, without calling absent checks green.
- [ ] Run a secret-value audit over the diff and confirm no credentials, .env values, private asset bytes, prompts, or tokens are present.
- [ ] Inspect pnpm-lock.yaml diff and current package manifests; confirm no new dependency/licence/advisory surface.
- [ ] Commit: docs(s6): finalize implementation contract review.

## Test matrix and acceptance mapping

The following matrix is the minimum evidence Web should use to accept implementation work against this plan:

| Contract area | Exact test file/case family |
|---|---|
| Canonicalization, numeric bounds, rounding, equality, hash input | tests/s6-canonical.test.ts canonical JSON, fractional/negative-zero/overflow, rotation, half-away rounding |
| S5 source projection/fingerprint/stale fencing | tests/s6-source.test.ts ready projection, artifact churn exclusion, source changes, all seven stale boundaries |
| Open-side variants and height state | tests/s6-compiler.test.ts all 15 open-side subsets, known/unknown height |
| Stable IDs and primitive families | tests/s6-compiler.test.ts, tests/s6-correction.test.ts, tests/s6-persistence.test.ts |
| Requirement counts/mappings | tests/s6-compiler.test.ts, tests/s6-validation.test.ts |
| Hierarchy and numeric/transform failures | tests/s6-validation.test.ts |
| Unknown geometry and correction restrictions | tests/s6-validation.test.ts, tests/s6-correction.test.ts |
| Revision lineage, conflicts, supersession, no merge/rebase | tests/s6-correction.test.ts, tests/s6-lifecycle.test.ts, tests/s6-persistence.test.ts |
| Generation/correction/acceptance/render/publication idempotency | tests/s6-lifecycle.test.ts |
| Restart recovery, claims, staged/promoted recovery | tests/s6-lifecycle.test.ts |
| Acceptance and current-pointer CAS | tests/s6-lifecycle.test.ts, tests/s6-api.test.ts |
| Camera formulas and deterministic output | tests/s6-renderer.test.ts |
| View preservation, material drift, overhead, open sides | tests/s6-renderer.test.ts |
| Artifact privacy, no-overwrite, stale downloads | tests/s6-api.test.ts, tests/s6-security.test.ts, tests/s6-lifecycle.test.ts |
| Telemetry unavailable semantics | tests/s6-handoff.test.ts, tests/s6-security.test.ts |
| S7 handoff eligibility and exact fields | tests/s6-handoff.test.ts, tests/s6-api.test.ts |
| S1-S5 regression | pnpm test, including all pre-existing test paths |
| Adversarial resource/injection/cross-tenant cases | tests/s6-security.test.ts |

## Plan self-review

- Spec coverage: complete. The plan locks source projection, numeric representation, schema, stable IDs, primitives, compiler, validation, revision/concurrency/idempotency, correction UX/API, acceptance/supersession audit, renderer alternatives and choice, cameras, preservation, storage/publication/recovery, telemetry, errors, security, dependencies, S7 handoff, and exact tests.
- Unfinished-work scan: clear; every task has a concrete file, interface, test name, command, expected result, and commit.
- Type/signature consistency: S6SpatialModelRecord, S6PublicSpatialModel, S6ConcurrencyToken, S6SourceReader, S5ToS6Projection, S6ViewId, S6ValidationReceipt, S6SupersessionEvent, and S6ToS7Handoff are used consistently across the file map, contract, and tasks.
- File-path validity: all proposed implementation and test paths are listed before tasks and correspond to the existing repository layout or explicitly named new files.
- Scope: no S7 CAD, S8 production 3D, APS, provider, deployment, credential, or production mutation is included.
- Secret audit: no secret values, prompts, image bytes, tokens, or private asset contents are part of the plan.
- Dependency/licence/security: no new dependency; lockfile remains unchanged; existing locked runtime and repository security checks remain required.
- Test coverage: every user-required adversarial case is mapped to an exact test file and task, including all open-side variants, height states, stable IDs, exact counts, hierarchy, numeric/transform failures, unknowns, lineage/conflicts/idempotency/recovery, correction restrictions, acceptance, cameras, preservation, privacy/authorization/no-overwrite/stale downloads, telemetry availability, and S1-S5 regression.

G2 plan output is this document only. Implementation, repair, acceptance, merge, and finality remain Web-controlled.
