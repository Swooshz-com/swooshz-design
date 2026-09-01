# S6 - Canonical Spatial Model + Coherent Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a bounded S6 workflow that projects the current fully-ready S5 approval into an immutable, validated, millimetre-based booth spatial model; carries representative approved design form beyond boxes; supports audited child-revision corrections; and publishes deterministic coherent review views from the exact accepted model.

**Architecture:** Keep S1-S5 immutable. A typed, read-only S5 projection is source-fenced by a canonical fingerprint. A deterministic compiler produces a bounded union of rectangular, round, and simple profile-extrusion geometry as a reviewable draft; a bounded manual design-form review is required before acceptance; an independent validator gates lifecycle transitions; correction requests create immutable child revisions; and an enhanced deterministic geometry-backed SVG renderer produces all views from one accepted revision. Private object storage, exact promotion, optimistic concurrency, recovery, authorization, and privacy patterns are reused from S1-S5.

**Tech Stack:** TypeScript 5.8.3, Next.js 16.3.2, React 19.2.8, Node node:test through tsx, the existing JsonRepository, PrivateObjectStore, AppError, sha256, and jcs utilities only where their existing contracts apply. No new runtime dependency; the renderer remains server-owned deterministic SVG with no provider or browser/GPU requirement.

---

## G2 boundary and acceptance

This document is the G2 implementation-contract candidate for DL-SD-S6-G2-001. It is documentation/plan material only. G2 does not implement any S6 product or runtime file. Web retains acceptance, G3 authority, implementation and repair authority, Ready/merge/finality, and programme progression. The lock is:

PROPOSED - NOT ACCEPTED

G3 is blocked until Web accepts this contract and plan. This plan does not self-accept DL-SD-S6-G2-001.

Proposed updated lock remains DL-SD-S6-G2-001. Accepted G1 DL-SD-S6-G1-001 remains accepted and is not reopened. This repair adds only the bounded spatial-fidelity/rendering contract described below; it grants no G3 implementation authority, no provider trust grant, and no S7/S8 implementation authority.

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
| src/lib/s6-canonical.ts | Fixed-point number and bounded-shape checks, profile normalization, canonical S6 serialization, model hash, stable object IDs, and derived footprints | S6 types and existing sha256 | Canonical constants and pure functions | Existing jcs intentionally accepts general JSON numbers; changing it could alter S1-S5 hashes. S6 needs a stricter integer-only contract for shapes and profiles. |
| src/lib/s6-persistence.ts | Strict S6 collection validators and cross-collection lineage/artifact/idempotency graph checks | S6 types, uuidV4Pattern, S6 canonical checks | validateS6Collections, validateS6Graph | s5-persistence.ts must remain S5-specific and cannot validate S6 revision lineage or view artifacts. |
| src/lib/s6-source.ts | Read-only source adapter, source-fingerprint construction, and stale checks | S5ToS6Projection, repository/object store, S6 canonical serializer | S6SourceReader, readReady, currentFingerprint, assertCurrent | S5 read APIs do not expose an S6 typed projection or S6-specific fingerprint rules. |
| src/lib/s6-compiler.ts | Deterministic conversion from one source projection into one initial spatial model and bounded design-form review items | S5ToS6Projection, primitive rules, stable ID functions | compileS6Draft | s5-layout.ts intentionally creates conceptual normalized markers and cannot be reused as metric geometry; generic placements must remain reviewable drafts, not silently accepted design form. |
| src/lib/s6-validation.ts | Independent ordered validation of model, source fence, bounded shapes/profiles, design-form review, requirements, hierarchy, containment, cameras, and hashes | Model, source projection, camera builder | validateS6Model, issue codes and validation result | Existing S5 validation validates conceptual plan semantics, not a metric object hierarchy, bounded profiles, or coherent views. |
| src/lib/s6-correction.ts | Typed shape/profile/material/design-form correction validation and immutable child-model construction | Existing model, exact correction DTO, canonical IDs | applyS6Corrections, allowlists | Keeping correction rules pure and separate makes the UX unable to bypass geometry, design-review, or hierarchy guards. |
| src/lib/s6-camera.ts | Three stable camera formulas and camera hashes | Accepted model booth/object bounds | S6_VIEW_IDS, buildS6Cameras, camera validation data | Camera formulas are a durable view contract, not renderer-private constants. |
| src/lib/s6-renderer.ts | Enhanced geometry-backed deterministic perspective and top-view SVG generation for rectangles, round primitives, and simple profile extrusions | Model, camera, material refs, fixed projection math | renderS6View, S6RenderedView scene evidence | s5-svg.ts labels output conceptual and not-to-scale; using it for S6 would misrepresent metric geometry. The S6 renderer must visibly carry accepted non-rectangular form. |
| src/lib/s6-preservation.ts | Structured model-to-view preservation evidence and artifact acceptance | Model, camera, rendered scene evidence | checkS6ViewPreservation, preservation receipt | Pixels alone cannot prove exact counts, IDs, or dimensions; this module makes the scene evidence explicit. |
| src/lib/s6-publication.ts | Exact staging, promote, commit, no-overwrite, and restart recovery helpers | PrivateObjectStore, JsonRepository, S6 artifact/job records | Publication/recovery state transitions | Existing S5 publication code has S5-specific fences and fields; copying it into the service would obscure S6 recovery invariants. |
| src/lib/s6-telemetry.ts | Privacy-minimized S6 counters and availability semantics | S6 state and source-readiness result | buildS6Telemetry | S5 telemetry has S5 field families and cannot silently acquire S6-specific cost or payload fields. |
| src/lib/s6-handoff.ts | Typed S6-to-S7 handoff projection from one current accepted model | Accepted model, validation receipt, source projection | buildS6ToS7Handoff | S7 must consume the accepted model directly and must not reconstruct it from hero imagery or a renderer. |
| src/lib/s6.ts | S6 workflow orchestration and public service methods | All S6 pure modules, shared repository/object store, S5 source reader | S6WorkflowService | A stage-level service is required for idempotency, authorization subject audit, lifecycle CAS, and recovery coordination. |

### New test files

| File | Responsibility | Consumes | Exposes | Why an existing file is insufficient |
|---|---|---|---|---|
| tests/s6-fixture.ts | Build a fresh S1-S5-ready fixture, deterministic clocks/UUIDs, S6 source projection, and isolated object/repository roots. | Existing S1-S5 fixture builders plus S6 source/model types and test stores | readyS6Fixture, deterministic clock/UUID helpers, isolated repositories | No existing fixture combines a fully-ready S5 source with S6 model state and private objects. |
| tests/s6-canonical.test.ts | Canonical integer representation, rounding, overflow, equality, hashes, stable IDs, and serialization limits. | s6-canonical.ts and S6 types | node:test assertions for canonical bytes, hashes, and IDs | Existing utils.jcs tests intentionally permit general JSON numbers and cannot assert S6 fixed-point rules. |
| tests/s6-persistence.test.ts | Legacy defaults, strict records, lineage, no ID reuse, artifact graph, and malformed-state rejection. | JsonRepository, StoreState, s6-persistence.ts, and S6 fixtures | load/transact graph assertions | Existing S5 persistence tests do not cover S6 revision, view, job, or idempotency graphs. |
| tests/s6-source.test.ts | Typed S5 projection, source fingerprint inclusion/exclusion, readiness, and every stale fence. | S5WorkflowService, S6SourceReader, S5 fixtures, and object store | projection/fingerprint/stale-boundary assertions | Existing S5 handoff tests do not define the S6 source projection or fingerprint boundary. |
| tests/s6-compiler.test.ts | All open-side variants, known/unknown height, exact counts, deterministic placement, bounded geometry families, design-form review items, and compiler IDs. | S5ToS6Projection, compileS6Draft, and fixture matrices | compiled model and fidelity-fixture assertions | s5-layout.ts is conceptual Q16 and cannot test metric S6 geometry or design-form coverage. |
| tests/s6-validation.test.ts | Every validation order category, bounded shape/profile rules, design-form coverage, hierarchy, containment, collision, unknowns, and hash receipt. | compileS6Draft, validateS6Model, canonical model fixtures | ordered issue and outcome assertions | Existing S5 validation does not validate S6 hierarchy, transformed non-rectangular containment, design-form coverage, or canonical model hashes. |
| tests/s6-correction.test.ts | Move/rotate/resize/shape/profile/radius/material/map/confirm/resolve/add/remove restrictions, child identity continuity, and conflict tokens. | applyS6Corrections, S6CorrectionOperation, and model fixtures | immutable child/event assertions | Existing S1-S5 stages have no S6 correction allowlist or object-lineage contract. |
| tests/s6-renderer.test.ts | Camera formulas, byte-deterministic views, rectangle/round/profile rendering, scene evidence, material/finish shading, and view-preservation checks. | buildS6Cameras, renderS6View, checkS6ViewPreservation, and fidelity fixtures | SVG bytes, scene DTO, camera, and preservation assertions | s5-svg.ts is explicitly conceptual and cannot prove coherent metric views. |
| tests/s6-lifecycle.test.ts | Generation, revision lineage, acceptance, idempotency, concurrent CAS, jobs, publication, and restart recovery. | S6WorkflowService, JsonRepository, PrivateObjectStore, and recovery fixtures | service result, event, job, and final-object assertions | No existing stage owns this S6 source fence, accepted-pointer CAS, or view publication lifecycle. |
| tests/s6-api.test.ts | Exact HTTP routes, auth-first construction, DTO errors, safe errors, headers, stale downloads, and handoff. | api.ts, S6 DTOs, authorization boundary, and service doubles | route/status/body/header assertions | Existing S3-S5 API tests do not cover S6 routes or redacted spatial DTOs. |
| tests/s6-security.test.ts | Cross-project access, path traversal, SVG injection, remote-resource rejection, payload bounds, and private storage. | API/service/storage/render fixtures and hostile inputs | denial, sanitization, bound, and privacy assertions | No existing regression suite covers S6 scene-content and storage-key attack surfaces. |
| tests/s6-handoff.test.ts | Exact S7 handoff fields, accepted/current eligibility, unknown height, derived rectangle/circle/polygon footprints, profile/radius preservation, and no hero reinterpretation. | buildS6ToS7Handoff, accepted model, receipt, and typed source | handoff field and eligibility assertions | S7 is not implemented; this contract needs an isolated consumer-facing test before handoff. |

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
export const S6_RENDERER_VERSION = "s6-svg-geometry-v2" as const;
export const S6_ID_VERSION = "s6-object-id-v1" as const;
export const S6_TELEMETRY_SCHEMA_VERSION = "s6-telemetry-v1" as const;

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
export const S6_MAX_PROFILE_VERTICES = 24;
export const S6_MAX_PROFILE_ABS_COORD_MM = 100_000;
export const S6_MIN_PROFILE_EDGE_MM = 100;
export const S6_MIN_PROFILE_AREA_MM2 = 10_000;
export const S6_MAX_ROUND_RADIUS_MM = 50_000;
export const S6_ROUND_RENDER_FACETS = 24;
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

export type S6GeometryKind = "rect_prism" | "round_prism" | "profile_extrusion";

export type S6ProfileVertex = {
  xMm: S6Mm;
  zMm: S6Mm;
};

export type S6Profile = {
  winding: "ccw-from-positive-y-v1";
  vertices: S6ProfileVertex[];
};

export type S6GeometryState = "exact" | "bounded_inference";

export type S6RectPrismGeometry = {
  kind: "rect_prism";
  dimensionsMm: S6Dimensions;
  geometryState: S6GeometryState;
  localAnchor: "floor" | "center";
};

export type S6RoundPrismGeometry = {
  kind: "round_prism";
  radiusMm: S6Mm;
  heightMm: S6Mm;
  geometryState: S6GeometryState;
  localAnchor: "floor" | "center";
};

export type S6ProfileExtrusionGeometry = {
  kind: "profile_extrusion";
  profile: S6Profile;
  heightMm: S6Mm;
  geometryState: S6GeometryState;
  localAnchor: "floor" | "center";
};

export type S6GeometryPrimitive =
  | S6RectPrismGeometry
  | S6RoundPrismGeometry
  | S6ProfileExtrusionGeometry;

export type S6Footprint2D =
  | { kind: "rectangle"; widthMm: S6Mm; depthMm: S6Mm }
  | { kind: "circle"; radiusMm: S6Mm }
  | { kind: "polygon"; vertices: S6ProfileVertex[] };

export type S6DesignFormReview = {
  status: "required" | "in_progress" | "complete" | "unsupported";
  evidenceAssetId: UUID;
  evidenceAssetSha256: Sha256;
  sourceS5Fingerprint: Sha256;
  reviewedObjectIds: string[];
  unresolvedUnknownIds: string[];
  explicitSimplificationUnknownIds: string[];
  acceptedByUser: boolean;
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
  kind: "geometry" | "material" | "requirement_mapping" | "design_form" | "camera";
  fieldPath: string;
  requirementId: string | null;
  question: string;
  blocking: boolean;
  status: "unresolved" | "resolved";
  resolutionKind: "represented" | "explicit_simplification" | null;
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
  designFormReview: S6DesignFormReview;
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

export type S6CorrectionGeometry =
  | { kind: "rect_prism"; dimensionsMm: S6Dimensions; localAnchor: "floor" | "center" }
  | { kind: "round_prism"; radiusMm: S6Mm; heightMm: S6Mm; localAnchor: "floor" | "center" }
  | { kind: "profile_extrusion"; profile: S6Profile; heightMm: S6Mm; localAnchor: "floor" | "center" };

export type S6CorrectionOperation =
  | { kind: "move"; objectId: string; deltaMm: S6Vector3Mm }
  | { kind: "rotate"; objectId: string; rotationMd: S6RotationMd }
  | { kind: "resize"; objectId: string; dimensionsMm: S6Dimensions }
  | { kind: "replace_geometry"; objectId: string; geometry: S6CorrectionGeometry }
  | { kind: "material"; objectId: string; material: S6MaterialFinishRef }
  | { kind: "zone_requirement_map"; objectId: string; zoneIds: string[]; requirementIds: string[] }
  | { kind: "confirm_design_inference"; objectIds: string[]; note: string }
  | { kind: "resolve_unknown"; unknownId: string; resolutionKind: "represented" | "explicit_simplification"; resolutionNote: string; replacement: { objectType: S6PrimitiveKind; role: S6ObjectRole; label: string; geometry: S6CorrectionGeometry; positionMm: S6Vector3Mm; rotationMd: S6RotationMd; material: S6MaterialFinishRef } | null }
  | { kind: "add"; objectType: "counter" | "display_plinth" | "screen" | "storage_volume" | "table" | "seating_marker" | "equipment_placeholder" | "box" | "overhead_volume" | "partition"; role: "furniture" | "display" | "screen" | "storage" | "seating" | "equipment" | "overhead" | "booth_partition"; label: string; geometry: S6CorrectionGeometry; positionMm: S6Vector3Mm; rotationMd: S6RotationMd; material: S6MaterialFinishRef; parentObjectId: string | null; zoneIds: string[]; requirementIds: string[] }
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
  rendererVersion: "s6-svg-geometry-v2";
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
  rendererVersion: "s6-svg-geometry-v2";
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
  rendererVersion: "s6-svg-geometry-v2";
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
- Round radius: 100 <= radiusMm <= S6_MAX_ROUND_RADIUS_MM; round height uses the ordinary physical-height bounds.
- Profile vertices: integer xMm/zMm values in [-S6_MAX_PROFILE_ABS_COORD_MM, S6_MAX_PROFILE_ABS_COORD_MM], with the exact vertex/count/edge/area/winding/self-intersection rules in the primitive contract.
- Absolute object/camera coordinates: -1,000,000 <= coordinateMm <= 1,000,000.
- Known booth maximum height: 100 <= maxHeightMm <= 100,000; unknown is exactly null, never zero or a sentinel.
- Rotation: each axis is normalized to -180000 <= value < 180000 millidegrees. One full turn is 360000.
- Perspective FOV: 5,000 <= fovMd <= 120,000; orthographic cameras have fovMd: null.
- Orthographic scale: 100 <= orthoScaleMm <= 200,000; perspective cameras have orthoScaleMm: null.
- Camera clipping: 1 <= nearMm < farMm <= 2,000,000.
- Renderer projection coordinates use signed Q16 integer units (S6_RENDER_Q16 = 65536) and are never persisted as geometry.

The conversion used by the UX for a decimal degree display is roundHalfAwayFromZero(degrees * 1000). The API accepts only integer millidegrees and integer millimetres. A decimal request is rejected rather than rounded server-side. The same half-away-from-zero helper is used for compiler/render quantization. Rotation normalization is modulo 360000, followed by the half-open range above. Equality is exact after normalization; there is no epsilon equality for durable model identity.

s6-canonical.ts must not call the general jcs function for the S6 model hash. It must:

1. validate exact keys and integer bounds, including a shape-specific allowlist for each semantic object family;
2. normalize open sides in OPEN_SIDE_ORDER, rotations, material hex casing, profiles, and array order;
3. sort objects by objectId, zones by zoneId, materials by materialId, cameras by viewId, provenance/unknown/assumption arrays by their IDs, and design-form review object/unknown IDs;
4. serialize object keys in UTF-16 code-unit lexical order;
5. serialize integer numbers as their base-10 decimal form with no exponent, no leading zero, and no negative zero;
6. use UTF-8 bytes of that string as hash input;
7. return sha256(bytes) and the exact byte length.

The model hash covers the canonical model content: schema version, revision ID, project ID, parent identity, source fingerprint, booth envelope, objects including the exact geometry union, zones, materials, cameras, provenance, assumptions, unknowns, and designFormReview. It excludes lifecycle timestamps, status, validation receipt ID, acceptance event ID, and artifact storage pointers. This keeps geometry identity stable across acceptance/publication. The model artifact bytes are a separate canonical document containing the model content and modelHash; its SHA-256 is the artifact hash. Hash input is never a JS-generated string containing uncontrolled floating-point output.

Overflow is checked before multiplication in volume/area and projection calculations. Use bigint for intermediate products where an integer product can exceed the safe integer range, then reject if the final bounded result cannot be represented safely. Reject model JSON over S6_MAX_MODEL_BYTES, correction bodies over S6_MAX_CORRECTION_BODY_BYTES, and view SVG over S6_MAX_VIEW_BYTES.

## Typed S5 source projection and fingerprint

s5.ts adds this read-only method:

~~~ts
getS6ReadOnlyProjection(projectId: UUID): S5ToS6Projection
~~~

S5ToS6Projection is the one typed S5-to-S6 projection. Define it in src/lib/types.ts beside the persisted S6 types; s6-source.ts implements only the reader and fence. It is a returned value with no callbacks, write methods, or mutable S5 object references:

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
- booth-wall:<closed-side> for each closed side in north/east/south/west order;
- zone:<zoneId> for zone regions;
- requirement:<requirementId>:<objectRole>:<one-based-instance-index> for countable requirement objects.

Requirement and zone ordering is by canonical ID, not source array order. Recompiling the same S5 source produces the same IDs and model hash. A child revision copies an unchanged object's objectId and identityKey. identityKey is an immutable logical identity string and is included in S7 handoff.

User-added objects receive a server-generated s6u_ plus a UUID with hyphens removed. The client never supplies a durable object ID. A removed ID remains present in ancestor history and may not be reused for another identity. validateS6Graph allows the same object ID in ancestor/child revisions only when identityKey is identical; a different identity is OBJECT_ID_REUSED. A child that removes an object does not silently recreate it later. No compiler-generated ID is derived from a display label or pixel position.

## Primitive and object families

S6PrimitiveKind remains the semantic object family and is deliberately separate from S6GeometryKind. The smallest sufficient renderable geometry set for representative exhibition form is:

- rect_prism: a bounded rectangular prism with width/depth/height.
- round_prism: a vertical circular prism with integer radius and height. The canonical shape is a circle; S6_ROUND_RENDER_FACETS = 24 is renderer tessellation only and is never handed off as the source geometry.
- profile_extrusion: a simple integer polygon in the local X/Z plane extruded along local +Y. It covers angled/non-axis-aligned partitions, finite wall/path-like footprints, fascia, and bounded overhead profiles without introducing a separate path or mesh format.

This is not arbitrary mesh ingestion. There are no holes, curves, booleans, textures, executable scene content, vertex colors, normals, or user-supplied SVG/path commands in the persisted model. A profile is a bounded footprint polygon; it is not fabrication/BIM detail. floor_footprint is always rect_prism. The 13 semantic families remain: floor_footprint, wall, partition, box, counter, display_plinth, screen, storage_volume, table, seating_marker, equipment_placeholder, overhead_volume, and zone_region.

Shape allowlists are:

| Semantic family | Allowed geometry kinds | Contract |
|---|---|---|
| floor_footprint | rect_prism | Exact booth width/depth, height 1, origin/zero rotation, non-editable hard envelope. |
| wall | rect_prism, profile_extrusion | Generated only on closed sides; a corrected profile remains inside the same closed-side envelope. |
| partition | rect_prism, profile_extrusion | Translation/rotation or a bounded profile; all transformed footprint points remain inside the floor. |
| box | rect_prism, round_prism, profile_extrusion | General bounded design volume, only when the form is explicitly reviewed. |
| counter | rect_prism, round_prism, profile_extrusion | Front-of-house volume; round/profile forms are user-selected or bounded inference, never guessed from pixels. |
| display_plinth | rect_prism, round_prism, profile_extrusion | Product/display volume with the same review and containment rules. |
| screen | rect_prism, profile_extrusion | No image URL or texture field; profile form is only a bounded screen/feature outline. |
| storage_volume | rect_prism, profile_extrusion | Bounded cabinet/volume, floor- or parent-supported. |
| table | rect_prism, round_prism | Meeting/demo surface, floor-supported and contained. |
| seating_marker | rect_prism, round_prism | Symbolic marker may use dimensions of at least 1; physical seating uses the ordinary 100 mm minimum. |
| equipment_placeholder | rect_prism, round_prism, profile_extrusion | Bounded placeholder; unresolved form remains an unknown. |
| overhead_volume | rect_prism, round_prism, profile_extrusion | Visual design/support intent only, fully inside known or derived render height, never fabrication detail. |
| zone_region | rect_prism, profile_extrusion | Non-fabrication semantic region used for containment/evidence and never counted as physical equipment. |

Profile contract:

- vertices are integer millimetres in object-local X/Z; the profile is extruded from its local base along +Y by heightMm.
- The persisted winding is ccw-from-positive-y-v1: when viewed from +Y toward the floor with +X right and +Z down, the exterior is counter-clockwise, equivalent to a negative X/Z shoelace area.
- Holes are explicitly prohibited. An input containing a holes key or any inner ring is rejected as S6_PROFILE_INVALID; it is never flattened into the outer ring.
- Before hashing, remove a repeated closing vertex, consecutive duplicates, and immediate collinear vertices that lie between their neighbours; repeat until stable. Do not translate or scale the profile during normalization.
- After normalization, require 3-24 vertices, distinct non-adjacent vertices, every edge length squared at least S6_MIN_PROFILE_EDGE_MM^2, absolute local coordinates at most S6_MAX_PROFILE_ABS_COORD_MM, doubled area at least 2 * S6_MIN_PROFILE_AREA_MM2, and no self-intersection or collinear overlap. Reverse only to enforce the locked winding, then rotate to the lexicographically smallest (xMm,zMm) start; ties use the lexicographically smallest next vertex.
- The profile's transformed footprint, not its renderer tessellation, is used for containment, collision, canonical hashing, and S7/S8 handoff.

Round contract:

- radiusMm and heightMm are integer millimetres, with radius at least 100 and at most S6_MAX_ROUND_RADIUS_MM; the same ordinary height bounds apply.
- The local circle is centred at the object's local origin in X/Z. localAnchor: floor places its base at transform.positionMm.y; center places its vertical midpoint there.
- The circle is exact for validation and handoff. Twenty-four deterministic facets are used only to make the accepted round form visibly round in SVG; the renderer must never persist or hand off those facets as a replacement polygon.

geometryState: exact means the shape and its metric values are confirmed or user-confirmed for that object. geometryState: bounded_inference means the shape/placement/metric values carry bounded_design_inference provenance and remain auditable even after user acceptance. Unknown or unsupported form never uses a zero, null, fake box, or fake default inside a renderable object. The compiler may use a bounded inferred wall/render height when booth height is unknown, but the booth envelope remains maxHeightMm: null and the model carries an assumption.

Allowed transforms are translation in booth-local millimetres and Euler rotation in millidegrees. Scale is not supported in MVP; dimensions, radius, or profile vertices change through bounded correction operations. Parent transforms are applied to every profile vertex and round centre for validation and rendering. A child cannot be parented to itself or to a descendant.

Containment and collision semantics are deterministic and shape-aware:

- floor and zone containment use the transformed exact rectangle/circle/polygon footprint; boundary contact is allowed, but any footprint area outside the booth or parent is CONTAINMENT_INVALID;
- vertical intervals use integer base/top values after anchor resolution; touching at one Y boundary is not a collision;
- physical collision means overlapping vertical intervals and overlapping footprint interiors. Floor, zone, and the shared boundary of a wall/partition are excluded from physical-collision errors; two countable/physical objects with positive-area overlap fail MATERIAL_COLLISION;
- rectangle/profile intersections use exact segment-intersection plus point-in-polygon predicates; round/round uses squared centre distance; round/polygon uses exact point-to-segment distance and containment. BigInt intermediates are required before bounded-number conversion;
- collision checks are applied after hierarchy transforms and before render quantization. Renderer facets cannot create or hide a canonical collision.

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
2. Create the floor first, then closed-side walls in OPEN_SIDE_ORDER complement order, then zone regions, then requirement objects in canonical requirement ID and category priority order, then bounded inferred architecture/overhead volumes. Select only the per-family allowlisted geometry kind. All arrays and every profile are canonicalized before hashing.
3. Use S5 layoutPlan.zones, coverage, and requirement mappings only for semantic relationships, category, labels, and ordering. Never use S5 xQ16, yQ16, widthQ16, or heightQ16 as metric coordinates. Preserve the S5 conceptual disclaimer in the provenance of any relationship derived from it.
4. Use confirmed structured requirement counts as the only count authority. expected: exact_count produces exactly the requested number of countable instances when the family is known. expected: present produces one bounded object when the family is known. expected: absent produces none. A prohibited or unknown semantic requirement produces an explicit unresolved mapping instead of a guessed object.
5. Map known categories deterministically: reception/welcome to counter, presentation/display to display_plinth or screen, demo/product to display_plinth, consultation/meeting to table plus seating markers, storage to storage_volume, interactive/activity to equipment_placeholder, and other categories to equipment_placeholder only when the S5 requirement is sufficiently specific. An unknown semantic creates S6Unknown(kind: requirement_mapping).
6. Place objects with deterministic bounded heuristics based on the confirmed booth envelope and category order: perimeter-facing counters on the first available closed-side run, display/demo objects in a central grid, meeting tables behind the front band, storage near a closed side, and overhead volumes above the central design band. These are design inferences, not survey measurements. Every inferred shape, position, dimension, radius, profile, and material choice has bounded_design_inference provenance.
7. The compiler may use structured visualIntent labels/materials and the approved asset ID/hash as review evidence, but it never samples hero pixels or turns image ratios into metric values. No hero-derived value can set width, depth, open sides, confirmed count, maximum height, or hard coordinates.
8. Every material architectural or major-object result that is not a confirmed S5 fact is marked bounded_inference and adds a blocking design_form unknown until the bounded editor records confirm_design_inference, a typed correction, or an explicit simplification decision. The draft remains a correction surface; it cannot become accepted_current merely because the generic layout is dimensionally valid.
9. If a required object or form cannot be safely bounded, omit the renderable object and create a blocking S6Unknown with the requirement/design-form reference. If the approved design contains a form outside the allowlist, create the same unknown and S6_UNSUPPORTED_FORM; never replace it with a box.
10. Use an allowlisted neutral/brand palette from source.visualIntent.preferredColors and materials; an unparseable or absent material becomes an explicit unknown or bounded neutral material with auditable inference. No remote asset or URL enters the model.
11. Set modelRevisionId, source identity, model hash, designFormReview, and canonical byte size deterministically from the input and injected IDs/clock. Do not mutate the S5 projection or any prior model.

The compiler is not a photogrammetric reconstruction. It produces an auditable initial design geometry whose relationships and material cues are reviewable and correctable.

## Design-form acquisition and trust boundary

The approved S5 hero/reference remains read-only visual/style/design-intent evidence. It may inform a user's review of apparent architectural form, adjacency, approximate relative placement, material/style intent, and bounded shape selection. It never supplies metric booth width/depth, open sides, exact confirmed counts, maximum height, or hard coordinates.

The alternatives were compared as follows:

| Option | Acquisition path | Strengths | Costs/risks | G2 decision |
|---|---|---|---|---|
| A. Deterministic compiler plus bounded manual correction | Compiler creates a typed draft from hard facts/requirements; the existing bounded editor displays the approved reference and the user selects/corrects shape, placement, adjacency, and finish | Deterministic, private, explainable, no new trust grant, and uses the already-required correction/acceptance boundary | Requires a human review pass; a generic requirement layout cannot be accepted without design-form coverage | Chosen minimum |
| B. Deterministic compiler plus bounded AI-assisted design-form interpretation | A provider-independent structured interpreter proposes only allowlisted forms and relative relationships from the approved reference; the user validates and accepts | Reduces manual placement effort and can capture apparent form/adjacency earlier | Adds provider privacy, cost, failure, retry, schema, prompt/reference handling, dependency, and trust work; a current provider is not authorised by G2 | Not selected |
| C. User-authored bounded design-form manifest before compilation | User supplies an allowlisted shape/adjacency manifest and the compiler materializes it | Strong determinism and no image interpretation | Adds a second authoring surface and duplicates the editor without improving the existing workflow | Rejected as more surface than A |

Option A is the selected S6 architecture. The compiler may produce a generic requirement layout as a correction surface, but it must set designFormReview.status to required or in_progress and create blocking design_form unknowns for material architectural form not confirmed by S5 hard facts. A generated rectangular substitute is never an accepted representation of an unresolved form. The user reviews the private approved reference alongside the top view, then uses bounded operations to select rect_prism, round_prism, or profile_extrusion, set metric values/relative placement, assign a structured finish, map adjacency, or explicitly resolve an unknown. Those metric values are user-confirmed design decisions, not measurements extracted from pixels.

Design-form completion is an acceptance precondition:

1. designFormReview.evidenceAssetId and evidenceAssetSha256 must match the current S5 active asset and source fingerprint.
2. Every material architectural, overhead, partition, counter, display, and major-object form is either in reviewedObjectIds or represented by a resolved unknown with an explicit decision.
3. designFormReview.status is complete and acceptedByUser is true; unresolvedUnknownIds is empty.
4. An unsupported form cannot be completed by changing it to a box. The user must correct it to an allowlisted shape, or resolve it as an explicit simplification. That resolution remains auditable as resolutionKind: explicit_simplification, keeps the original unknown/question and provenance, and emits a S6_DESIGN_FORM_SIMPLIFIED warning.
5. Low-confidence or ambiguous visual intent stays an unknown until the user chooses a bounded representation. Precision is never fabricated to make a view or handoff possible.

The compiler's deterministic placements and any machine-derived material/shape choice remain S6Provenance.kind: bounded_design_inference. A confirm_design_inference correction records acceptedByUser without relabelling the provenance as confirmed_project_input. The accepted spatial revision therefore carries the approved design form and its audit trail, while confirmed project facts remain immutable.

Option B is deliberately not recommended for this G2 plan, so there is no selected provider, model, SDK, credential, network call, dependency, cost boundary, or licence claim. If a later G3 proposal revisits B, it must first define a provider-independent adapter with separate typed hardFacts and referenceEvidence inputs, a response schema limited to allowlisted geometry kinds/relative Q16 placement/adjacency/material intent/confidence/unknowns, output-key rejection for hard metric facts, output validation and canonicalization, per-fact provenance, stale source fencing, privacy-minimized logs, bounded retry/failure states, and a fresh current authoritative provider/licence/privacy/security/cost trust review. A provider response can never write an accepted model directly.

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
6. semantic/geometry kind allowlists, rect/round/profile shape fields, profile winding/vertex/area/self-intersection rules, transforms, dimensions, radius, height, rotation, and material references;
7. exact/present/absent requirement counts and requirement mappings;
8. object containment, floor contact, closed-wall placement, open-side integrity, and known maximum height;
9. meaningful physical-volume collisions and material/finish references;
10. designFormReview source binding/completion, unresolved unknowns, explicit simplification decisions, and assumptions;
11. camera count, camera formulas, target/up vectors, clip planes, and camera hashes;
12. canonical serialization byte size and model hash.

Stable issue codes are:

SOURCE_STALE, SOURCE_NOT_READY, SPATIAL_SCHEMA_INVALID, PAYLOAD_TOO_LARGE, NUMERIC_OUT_OF_BOUNDS, CANONICAL_NUMBER_INVALID, BOOTH_ENVELOPE_INVALID, OPEN_SIDE_INTEGRITY, MAX_HEIGHT_EXCEEDED, OBJECT_ID_DUPLICATE, OBJECT_ID_REUSED, HIERARCHY_DANGLING_PARENT, HIERARCHY_CYCLE, TRANSFORM_INVALID, DIMENSIONS_INVALID, ROUND_GEOMETRY_INVALID, S6_PROFILE_INVALID, S6_PROFILE_SELF_INTERSECTION, S6_PROFILE_TOO_COMPLEX, REQUIRED_COUNT_MISMATCH, REQUIREMENT_MAPPING_INVALID, CONTAINMENT_INVALID, MATERIAL_COLLISION, S6_DESIGN_FORM_UNREVIEWED, S6_UNSUPPORTED_FORM, S6_DESIGN_FORM_SIMPLIFIED, GEOMETRY_UNRESOLVED, CAMERA_INVALID, CANONICAL_HASH_MISMATCH, and VIEW_PRESERVATION_FAILED.

Blocking matrix:

- Source stale/not-ready, schema, payload, numeric, booth envelope, open-side, duplicate/reused ID, hierarchy, transform, dimensions, invalid round/profile shape, canonical hash, and cross-project errors block persistence of a new model or artifact.
- Required-count, mapping, containment, maximum-height, material-collision, unsupported-form, design-form-unreviewed, or unresolved-geometry errors may persist a generated/corrected draft with a receipt whose outcome is acceptance_blocked; they block acceptance and final coherent-view publication. This preserves a correction surface without accepting bad geometry.
- An explicitly user-accepted simplification is a warning only after a typed replacement/decision, retains the original unknown and provenance, and may produce pass_with_warnings. It is never an implicit fallback.
- Any error in the receipt blocks acceptance. Any error affecting object visibility, geometry, material reference, camera, or source freshness blocks rendering/publication.
- A view-preservation failure always rejects the artifact and leaves the accepted model unchanged. Preservation compares the exact geometry kind and canonical profile/radius, not only a derived rectangular bounds box.

Validation is independent of the compiler. The validator must not silently repair, reorder into validity after reporting a client error, or reinterpret unknown geometry.

## Revision, concurrency, and idempotency

Lifecycle transitions are:

generated_draft -> corrected_draft -> accepted_current -> superseded

Any revision whose S5 fingerprint no longer equals the current ready source is effectively stale; a transaction at generation, correction, acceptance, rendering, publication, or an explicit stale reconciliation may persist only a stale marker for an existing record, never a new model or artifact. A validation-failed draft can become rejected; an interrupted terminal job can mark a generated draft aborted. No accepted record is edited in place. Only one revision per project may be accepted_current for the current source fingerprint.

generate creates a root generated_draft when there is no current accepted revision for the current source. A repeated same-input generation replays its idempotent result. A separate generation against the same current source conflicts rather than branching. When S5 has a new source fingerprint, a new root draft is allowed and the old current revision is marked stale in the same transaction.

reopen never edits an accepted revision. It creates a corrected_draft child from the current accepted revision, copying the exact model content and object IDs. correct creates a corrected_draft child from a draft or reopened child. accept changes the child to accepted_current and the prior current revision to superseded atomically, writes one S6AcceptanceEvent and, when a prior accepted revision exists, one S6SupersessionEvent in the same transaction. Acceptance also requires a passing validation receipt with designFormReview.status === complete, acceptedByUser === true, current evidence asset/fingerprint, no unresolved design-form unknowns, and no S6_UNSUPPORTED_FORM. An explicit simplification may remain as a warning only when its typed replacement and user decision are recorded. There is no automatic merge or rebase.

render may create a private draft_preview for a generated/corrected draft or an accepted_view for the current accepted revision. A draft preview can show a clearly marked unreviewed form for correction, but it is never a final coherent view and cannot be published. An accepted_view is rendered only from the current accepted revision after the design-form gate passes. publish accepts only a committed accepted_view for the current accepted revision.

Every correction, reopen, acceptance, render, and publication request carries the exact S6ConcurrencyToken. Generation has no parent revision and therefore accepts an empty JSON object; under the repository lock it snapshots the current accepted revision identity (or null) as its internal CAS expectation before source-fenced compilation, and the caller cannot supply or override that expectation. The service compares expected revision ID and model hash, expected parent revision ID and parent hash, expected current accepted revision ID and hash, and expected S5 source fingerprint. Any mismatch raises S6_REVISION_CONFLICT, S6_ACCEPTANCE_CONFLICT, or S6_SOURCE_STALE as appropriate. Concurrent corrections from the same parent cannot both commit under the same expected parent token. Concurrent acceptance has one winner; the loser receives a conflict. Idempotent replay is the only repeated request path.

Idempotency-Key is required for generation, correction, reopen, validation, acceptance, render, and publication. It must be a UUID. The service stores S6IdempotencyState with an input hash over operation, project, normalized DTO, concurrency token, source fingerprint, and actor-independent operation data. Same key and same hash returns the stored result without another mutation. Same key and different hash returns S6_IDEMPOTENCY_KEY_REUSE. Client createIdempotencyKeyRetainer keeps the key through UnknownNetworkOutcome; a new user operation gets a new key.

## Correction UX and service API

The existing bounded editor remains a review/correction surface, not CAD. Its minimum geometry controls are:

- a shape selector restricted by the semantic-family allowlist;
- move and rotate fields using integer millimetres/millidegrees;
- rect_prism width/depth/height fields;
- round_prism radius/height fields;
- profile_extrusion vertex-list editing capped at 24 vertices, with add/remove vertex only within the same profile validation rules;
- structured material/finish selection, object labels, zone/requirement mapping, and bounded add/remove;
- confirm inferred design form, resolve an unknown with a typed replacement, or record an explicit simplification note;
- a read-only private approved-reference panel identified by asset ID/hash beside the top view, so the user can compare form without treating image pixels as measurements.

The editor never exposes booth width/depth, confirmed open sides, confirmed maximum height, exact S5 counts, S5 approval controls, raw storage keys, arbitrary SVG/path/mesh/script input, or unconstrained CAD operations. Every mutation creates a child revision and the UI reloads persisted state after the request; local optimistic state is never treated as accepted truth.

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
- resize replaces dimensions within primitive bounds for rect_prism only; it cannot change primitive kind.
- replace_geometry changes only the shape kind/parameters within the object's semantic-family allowlist. The server rejects client-supplied geometryState, provenance, IDs, bounds, holes, arbitrary profile/path data, and any shape that is not independently canonicalized and validated.
- A round correction exposes radiusMm and heightMm. A profile correction exposes integer X/Z vertices and heightMm, then runs duplicate/collinear normalization, winding, edge, area, vertex-count, and self-intersection checks before creating the child.
- material replaces the complete validated material reference; no URL, SVG, HTML, or arbitrary shader field exists.
- zone_requirement_map references only existing S6 zone and confirmed S2 requirement IDs.
- confirm_design_inference accepts only existing bounded_inference objects named by a design-form unknown. It records a bounded note and acceptedByUser while retaining bounded_design_inference provenance; it does not promote an inference to confirmed_project_input.
- resolve_unknown requires a bounded note and, for geometry/design_form unknowns, a typed replacement object plus resolutionKind. It cannot resolve an unknown by text alone. A null replacement is permitted only for a non-geometry unknown; explicit simplification still needs a typed allowlisted replacement and a user decision.
- add permits only the allowlisted object types and geometry kinds in S6CorrectionOperation; the server generates the object ID and assigns provenance. It cannot add floor, closed-side wall, or arbitrary scene content.
- remove is permitted only for editable and removable objects. It cannot remove the floor, closed-side booth walls, zone regions, or any hard envelope object. Removing a required countable object is allowed only as a visible draft change and causes the exact-count validation failure until corrected.
- No operation changes booth width, booth depth, confirmed open sides, confirmed maximum height, exact source requirements, S5 identity, or the coordinate convention.

Authorization uses the existing S3AuthorizationBoundary shape. API auth resolves a subject and authorizes the project before constructing/using the workflow service or reading model/artifact data. The actor subject ID is persisted only in correction/acceptance history and is not returned in public DTOs. Denied, missing, or cross-project resources use the same generic 404 S6_UNAUTHORIZED_OR_NOT_FOUND behavior; no model existence, source hash, or artifact key is disclosed.

## Rendering technology decision

The choice is evidence-based against the repaired geometry contract and the actual repository:

| Option | Geometric fidelity and non-rectangular support | Material/design fidelity | Camera/browser interaction | Download/private artifact and server/headless needs | Future S7/S8 continuity | Dependency/licence/supply-chain/maintenance/privacy | Decision |
|---|---|---|---|---|---|---|---|
| A. Enhanced deterministic SVG/vector projection over the repaired geometry | Exact analytic rect_prism, round_prism, and profile_extrusion footprints; preserves transforms, open sides, profile vertices, radius, identity, and overhead form. Round facets are display-only. | Structured color plus deterministic finish treatment for wood/metal/fabric/glass/brand/unknown, material labels, and visible form; enough to distinguish the accepted bounded design without claiming hero-pixel photorealism. | Fixed integer cameras; native SVG elements expose data-object-id for top-view selection/correction and read-only perspective review. | Server emits exact SVG bytes directly; no browser, GPU, WebGL, or headless process is needed. Existing private store, staging, and no-overwrite path apply. | Handoff carries the same geometry union, exact profile vertices, radius, transforms, and derived footprint; no second reconstruction is introduced. | Zero new packages, existing repository licence posture, no new transitive/supply-chain surface, bounded custom code, no provider/data egress, and small deployment burden. | Chosen |
| B. Small geometry-backed browser renderer such as direct Three.js/WebGL | Strong interactive 3D and can tessellate the three families, but adds a second scene/runtime representation and browser lifecycle/SSR concerns. | Lighting could improve appearance, but structured materials still remain the authority and do not solve image interpretation. | Strong browser manipulation, but deterministic camera and byte-identical server output require a separate artifact path or controlled headless browser. | Download/private artifacts require browser rendering, server-side canvas, or headless execution; new failure/recovery and resource limits are needed. | Could carry the union if serialization stays exact, but creates a new parity surface between WebGL and S7/S8. | At least one new direct dependency plus transitive review, current licence/advisory/security review, larger maintenance/deployment surface, and no privacy benefit over SVG. | Rejected for MVP |
| C. Geometry renderer plus separately bounded appearance enhancement | Base geometry can stay exact only when the SVG remains authoritative and enhancement is forbidden from changing topology/geometry. | Potentially closer to hero finish, but output may drift materials or geometry and needs structured comparison. | Adds visual QA and an additional binding of model revision, camera, and enhancement artifact. | Adds provider or image-pipeline calls, staging/retry/failure states, and separate private artifact handling. | Continuity is safe only if enhancement is never handed to S7/S8 and the base geometry remains the source. | New provider/dependency trust, cost, privacy, prompt/reference handling, credential, licence, and supply-chain surface not needed for bounded S6. | Rejected; future separately gated |
| D. APS, server GPU, or general headless renderer | Potentially broad, but exceeds the bounded union and introduces operational variability. | No evidence it improves the accepted structured material bar enough to justify the boundary. | More operational dependencies and less simple deterministic browser review. | Requires service/GPU/headless availability, capacity, recovery, and deployment controls. | Could add translation rather than continuity and would risk pulling S7/S8 implementation into S6. | APS remains optional; external availability, privacy, cost, licence, security, and maintenance burden are unjustified. | Rejected |

The chosen path is S6_RENDERER_VERSION = s6-svg-geometry-v2: a deterministic geometry-backed SVG renderer with explicit rect_prism, round_prism, and profile_extrusion projection. Rectangles emit deterministic top/front/side faces; profiles emit an exact polygon side/top/bottom face set after transform; round primitives emit 24 ordered vertical facets plus top/bottom caps for visual roundness. Face order, signed Q16 coordinates, finish shading, labels, metadata, and XML attributes are stable. The renderer is not the conceptual S5 SVG renderer and never converts a profile or circle into a canonical box.

The renderer alone meets the accepted S6 quality bar for the bounded MVP because each required fidelity fixture is visibly distinguishable in the perspective views: angled partitions show their rotation/profile, round counters show a curved silhouette, non-rectangular architectural and overhead profiles show their outline, mixed open sides remain open, and material/finish changes are visible without changing geometry. Structured scene evidence remains authoritative over pixels. If an approved form is outside the allowlist, the renderer can emit only a marked diagnostic draft surface; it cannot produce an accepted_view or publication artifact.

No bounded appearance enhancement is selected or required. If a later slice proposes one, the canonical geometry and base SVG remain authoritative and available; the enhancement must bind the exact model revision/hash and camera hash, may not feed geometry back into the canonical model, must be rejected on material/topology/geometry drift, and must pass structured preservation even if screenshots look better. Provider credentials/calls, prompts, image bytes, cost, licence, privacy, retry, and publication decisions remain separately gated. No provider, image bytes, prompts, secret, or external service is introduced by this plan.

No new package is proposed. The implementation must leave pnpm-lock.yaml unchanged and use only current dependencies and browser SVG. The dependency/licence/advisory decision is therefore: no new direct or transitive role, no new licence, no new lockfile entry, and no new advisory surface. The implementation still runs the repository's existing lockfile policy and security validation before merge.

## Exact cameras and view set

S6_VIEW_IDS is exactly:

1. perspective-northwest - perspective design-review view from outside the north-west corner;
2. perspective-southeast - perspective design-review view from the opposite corner;
3. top-orthographic - user-facing top review and editor/QA surface.

Top view is both user-facing and the editor/QA surface. It includes zone and object labels when the selected model supports them; it is not merely a debug diagram.

The camera builder uses integer inputs and derives H as follows:

- if booth.maxHeightMm is known, H = booth.maxHeightMm and heightBasis = confirmed_max_height;
- otherwise H = max(3000, maximum shape-aware transformed object top) and heightBasis = derived_render_height, with booth.heightState = unknown and an explicit assumption. Profile extrusions use their transformed Y extent and round/rect primitives use their resolved top; no renderer tessellation determines H.

Let P = clamp(roundHalfAwayFromZero(max(widthMm, depthMm, H) / 10), 500, 5000), C = { xMm: roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H / 3), zMm: roundHalfAwayFromZero(depthMm / 2) }.

- perspective-northwest: position {xMm: -P - roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H * 3 / 4), zMm: -P - roundHalfAwayFromZero(depthMm / 2)}, target C, up world-y, FOV 45000, near 100, far max(500000, 4 * (widthMm + depthMm + H + P)).
- perspective-southeast: position {xMm: widthMm + P + roundHalfAwayFromZero(widthMm / 2), yMm: roundHalfAwayFromZero(H * 3 / 4), zMm: depthMm + P + roundHalfAwayFromZero(depthMm / 2)}, target C, up world-y, FOV 45000, near 100, same far formula.
- top-orthographic: position {xMm: roundHalfAwayFromZero(widthMm / 2), yMm: H + 2 * P, zMm: roundHalfAwayFromZero(depthMm / 2)}, target {xMm: roundHalfAwayFromZero(widthMm / 2), yMm: 0, zMm: roundHalfAwayFromZero(depthMm / 2)}, up negative-world-z, FOV null, orthographic scale max(widthMm, depthMm) + 2 * P, near 1, far H + 4 * P.

Camera hash is the canonical hash of the camera with cameraHash removed. Camera arrays are exactly these three IDs in that order. Camera formulas are re-run during validation; a client cannot submit arbitrary camera parameters.

## View-preservation contract

renderS6View(model, camera) returns a S6RenderedView with SVG bytes, the camera hash, a scene hash, projected bounds, visible object IDs, material IDs, and scene evidence. The exact ephemeral interfaces are:

~~~ts
export type S6SceneEvidence = {
  schemaVersion: "s6-view-preservation-v1";
  booth: {
    widthMm: S6Mm;
    depthMm: S6Mm;
    openSides: OpenSide[];
    coordinateConvention: S6CoordinateConvention;
  };
  objects: Array<{
    objectId: string;
    objectType: S6PrimitiveKind;
    geometryKind: S6GeometryKind;
    geometry: S6GeometryPrimitive;
    footprint: S6Footprint2D;
    boundsMm: S6Dimensions;
    transformedBoundsMm: { min: S6Vector3Mm; max: S6Vector3Mm };
    materialIds: string[];
    visible: boolean;
  }>;
  overheadObjectIds: string[];
  materialIds: string[];
  cameraHash: Sha256;
  sourceS5Fingerprint: Sha256;
  modelHash: Sha256;
  rendererVersion: "s6-svg-geometry-v2";
  externalResourceCount: 0;
  unsafeElementCount: 0;
};

export type S6RenderedView = {
  viewId: S6ViewId;
  cameraHash: Sha256;
  sceneHash: Sha256;
  svgBytes: Uint8Array;
  outputSha256: Sha256;
  outputByteSize: number;
  projectedBoundsQ16: { minX: number; minY: number; maxX: number; maxY: number };
  visibleObjectIds: string[];
  materialIds: string[];
  sceneEvidence: S6SceneEvidence;
};
~~~

The SVG contains only escaped text, inline geometry generated from canonical integers, validated hex colors, deterministic finish marks, and data-s6-* metadata. It contains no image, external href, url(...), script, foreignObject, arbitrary CSS, or user-provided markup. Polygon paths are generated by the renderer from validated profile vertices; client SVG/path commands are not accepted.

The renderer applies the locked local transform convention Rz * Ry * Rx to rect_prism corners, round_prism centres/facets, and every profile vertex, then projects with the camera, quantizes each SVG coordinate to signed Q16 integers, sorts faces by quantized depth and object ID, and emits stable XML attributes/child order. Face shading is a deterministic function of material color and face normal. Finish kinds change only deterministic shade/opacity/marking; they never change dimensions, profile vertices, radius, topology, or object identity. Perspective views are final design-review views; top-orthographic is also the persisted editor/QA surface.

For each view, preservation checks compare structured scene evidence rather than trusting pixels:

- hard booth width/depth and coordinate convention;
- exact open-side set and absence of a wall on every open side;
- known maximum height and all object tops;
- full visible object ID set, including every overhead object;
- semantic primitive kind, geometry kind, exact rect dimensions or round radius/height or canonical profile vertices/height, count, and transformed bounds within exact scene tolerance 0 before projection and 2 mm after quantization;
- camera hash, source fingerprint, model hash, and renderer version;
- every referenced material ID and allowlisted finish/color;
- no external SVG resource or unsafe element;
- design-form review status and exact reviewed/explicit-simplification coverage for a final accepted_view;
- scene hash equality between the pre-publication render result and persisted artifact evidence.

S6ViewPreservationReceipt.outcome is pass only if every hard check passes. The receipt is persisted before final publication and its receiptHash is canonical. Pixel/screenshot review is an optional visual QA signal for finish recognizability; it cannot waive a structured failure. A diagnostic draft preview may expose unresolved form with an explicit draft marker, but only a complete, accepted design-form review can produce an accepted_view or be published. Because the current renderer is the authoritative geometry view, no enhancement-specific preservation path is needed.

## Storage, publication, and recovery

All keys are built with privateStorageKey from validated UUIDs and allowlisted view tokens. The implementation must not concatenate user labels, filenames, material values, or URL text into a storage path.

- Model artifact final key: projects/<projectId>/s6/revisions/<revisionId>/model.json.
- Model staging key: projects/<projectId>/s6/staging/<jobId>/<claimToken>/model.json.
- View final key: projects/<projectId>/s6/revisions/<revisionId>/views/<viewId>/s6-svg-geometry-v2.svg.
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
| S6_PROFILE_INVALID | 422 | A profile has invalid vertices, winding, area, edge length, bounds, holes, or self-intersection. |
| S6_DESIGN_FORM_UNREVIEWED | 422 | The accepted design form has not been covered and explicitly confirmed by the user. |
| S6_UNSUPPORTED_FORM | 422 | The approved design contains material form outside the bounded S6 geometry allowlist; no silent box replacement occurred. |
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
- Profile vertex/count/coordinate/area/edge bounds, round radius bounds, and exact segment/collision predicates prevent malformed-shape and resource-exhaustion attacks. SVG paths are generated only from canonical integers; client path commands, holes, mesh data, shaders, and arbitrary scene content are rejected.
- Payload, count, label, operation, object, zone, material, camera, revision, artifact, and retry bounds above prevent obvious resource exhaustion.
- User-controlled correction values cannot change confirmed booth dimensions, open sides, confirmed height, exact source requirements, S5 identity, or coordinate convention.
- A user may accept a bounded inference, but its S6Provenance.kind remains bounded_design_inference and acceptedByUser records the audit fact; it is never relabelled as client-supplied fact.
- Design-form review is bound to the current approved asset ID/hash and S5 fingerprint. An unsupported or ambiguous form remains an explicit unknown and blocks acceptance/final publication until corrected or explicitly simplified by the user.
- No provider credentials or calls are present in S6. Any future AI interpretation must use separate hard facts/reference evidence, validate and canonicalize structured output, and pass a fresh trust/privacy/security/cost gate before implementation.
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
    geometry: S6GeometryPrimitive;
    footprint: S6Footprint2D;
    transform: S6Transform;
    boundsMm: S6Dimensions;
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

The handoff is produced only from a current accepted revision with a passing receipt and current S5 source. It contains no hero image, prompt, renderer pixels, CAD, fabrication detail, or reinterpretation instruction. S7 can use the object IDs, hierarchy, exact geometry union, derived local footprints, transforms, bounds, requirements, zones, materials, provenance, unknowns, and receipt directly: rect_prism becomes editable rectangle entities, round_prism becomes an editable circle/arc footprint with radius, and profile_extrusion becomes an editable closed polygon/polyline with the exact canonical vertices and extrusion height. A renderer's 24 round facets are never handed off. S8 can consume the same geometry union without reconstructing a different booth. This defines the boundary only; no S7 exporter, CAD writer, S8 scene generator, APS integration, or 3D implementation is part of this plan.

## Representative fidelity fixtures

The fixture matrix is part of the contract, not a future example list. tests/s6-fixture.ts contains deterministic S5-ready projections and fresh UUID/clock values; it contains no private asset bytes. Each row must be exercised through the same chain:

S5 intent -> S6 model -> user correction -> accepted model -> required views -> S7 handoff

| Fixture | S5 intent and hard facts | S6 draft and user correction | Accepted/view evidence | S7 handoff evidence |
|---|---|---|---|---|
| mixed-open-sides-angled-partition | Booth 6000 x 3000 mm, openSides north/east, confirmed maxHeight 3000 mm; visual intent says angled fabric partition and welcome counter, but gives no metric values | Compiler creates the required draft and design-form unknown. User applies replace_geometry to partition with rect_prism 2400 x 100 x 2400 and rotate yMd = 30000, then confirm_design_inference or a typed material correction | No north/east wall; the partition silhouette is non-axis-aligned in both perspective views and its exact object ID/material is present in all three scene-evidence records | Same rect_prism dimensions, 30-degree transform, object identity, footprint, and open-side set are present; no hero reread |
| round-counter | Booth 6000 x 3000 mm, openSides north/east; structured requirement count says one counter; visual intent says a round metallic reception counter | User replaces the generic counter geometry with round_prism radius 450 mm, height 1100 mm, floor anchor at the user-entered position, and assigns metal_like | Perspective views show a curved silhouette with ordered facets and metallic shading; top view shows a circle; scene evidence carries radius/height and material ID, not a rectangular substitute | round_prism and radius 450 mm survive as an editable circle/arc footprint and height; renderer facets are absent from handoff |
| extruded-non-rectangular-feature | Booth 8000 x 4000 mm, confirmed maxHeight 3500 mm; visual intent says an L-profile display/fascia | User sets profile_extrusion vertices [(0,0),(1800,0),(1800,400),(1100,400),(1100,900),(0,900)] mm, height 2200 mm, with canonical winding and a user-confirmed display material | All views preserve the six-vertex L outline, extrusion height, object ID, and material; profile canonical hash is identical before/after rendering | Handoff contains profile_extrusion with the exact six canonical vertices, height 2200 mm, transform, and polygon footprint |
| overhead-profile | Booth 8000 x 4000 mm, openSides south/west, confirmed maxHeight 3500 mm; visual intent says a stepped overhead fascia, not a box beam | User adds/corrects overhead_volume profile_extrusion vertices [(0,0),(3000,0),(3000,300),(1800,300),(1800,600),(0,600)] mm, height 300 mm, at a user-confirmed Y position | Perspective views visibly retain the stepped overhead outline above the booth; top view and scene evidence include the overhead object ID and exact profile; no fabrication claim | Handoff retains the profile vertices, height, hierarchy, and overhead role without tessellating it into unrelated boxes |
| material-finish-variation | One shared geometry fixture has structured wood_like counter, fabric_like partition, metal_like screen surround, glass_like display, and brand_reference overhead intent | User confirms/edits only allowlisted material refs and, where needed, shape; no material operation can change geometry | Every view contains the same object/geometry set and all material IDs; deterministic finish marks/colors differ by finish kind while dimensions/topology/model hash do not | Handoff carries the same material IDs/refs alongside the exact geometry; unsupported material semantics remain explicit |
| mixed-form-booth-continuity | Booth 9000 x 5000 mm, openSides north/south, unknown maxHeight; visual intent combines a round counter, angled partition, profile overhead, and open circulation | Compiler creates a bounded draft with height assumption and design-form unknowns. User corrects each form, confirms the bounded inference, and accepts the unknown-height assumption without inventing a maxHeight | Three coherent views are generated from one accepted model; open north/south sides, round/profile/angled forms, relative placement, material IDs, and derived render height all match scene evidence | Handoff preserves unknown maxHeight, all three geometry kinds, object IDs/hierarchy, footprints, transforms, materials, and assumptions; S7 need not inspect the hero |
| unsupported-form-fails-closed | Visual intent deliberately describes a curved double-bent wall with a hole, outside the allowlist; no hard metric fact authorizes replacing it | Compiler/editor creates design_form unknown and S6_UNSUPPORTED_FORM. The test proves no automatic box is created. A separate branch of the fixture either supplies a valid typed replacement or records explicit_simplification with a user note | Without correction/simplification: acceptance, accepted_view, and publication are blocked. With explicit simplification: warning remains, original unknown/question/provenance stay auditable, and the user decision is required | No handoff is emitted for the unresolved case; the corrected/simplified case hands off only its typed accepted geometry |

For every supported row, tests assert that the accepted modelHash, per-view sceneHash inputs, and handoff geometry agree. A passing screenshot alone is insufficient: the structured evidence must prove the same material form survives the full chain.

## TDD implementation plan

Implementation follows the Superpowers writing-plans and test-driven-development workflow. Every task below is independently testable and meaningful to a reviewer. For each task, write the named failing test first, run the exact focused command and observe the named failure, implement the smallest production change, rerun for green, then refactor only while the same command remains green. Commit after each task with the exact commit message shown. A task is not complete if it only changes types without an executable assertion.

### Task 1 - Add persisted S6 types and fixed-point canonicalization

**Files:** modify src/lib/types.ts; add src/lib/s6-canonical.ts; add tests/s6-canonical.test.ts.

**Interface:** src/lib/types.ts provides the exact types/constants above. s6-canonical.ts provides assertS6Integer, normalizeS6Rotation, roundHalfAwayFromZero, normalizeS6Profile, deriveS6Footprint, canonicalS6Json, hashS6Model, compilerObjectId, and userObjectId.

- [ ] RED: Add tests named S6 canonical spatial JSON is byte and hash deterministic, S6 rejects fractional negative-zero non-safe and overflow values, S6 rotation normalizes to the half-open millidegree range, S6 uses half-away-from-zero rounding, rect/round/profile shape canonicalization is deterministic, duplicate/collinear profile vertices normalize, holes/self-intersections/short edges/too many vertices reject, round radius bounds reject, designFormReview participates in the model hash, and S6 compiler IDs are stable while user IDs are fresh.
- [ ] Run pnpm exec tsx --test tests/s6-canonical.test.ts; expect module/type failures before the new exports exist.
- [ ] GREEN: Add the exact integer validators, shape allowlists, profile normalization/intersection checks, derived footprint function, and canonical serializer. Assert that a model with xMm: 1000, rotationMd: -180000, and the same canonical arrays hashes identically regardless of insertion order. Reject 1.5, Object(-0), Number.MAX_SAFE_INTEGER + 1, coordinates outside the bound, invalid profile rings, and a round radius outside the locked range.
- [ ] Run the focused command; expect all named numeric, shape, profile, hash, and ID cases to pass with zero failures.
- [ ] REFACTOR: Keep S6 number handling isolated from utils.jcs; rerun the focused command and pnpm typecheck.
- [ ] Commit: test(s6): lock spatial numeric canonicalization.

Example assertion:

~~~ts
assert.equal(
  hashS6Model(modelWithReorderedArrays).modelHash,
  hashS6Model(modelWithCanonicalArrays).modelHash,
);
assert.deepEqual(
  normalizeS6Profile({ winding: "ccw-from-positive-y-v1", vertices: [
    { xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 0 },
    { xMm: 1000, zMm: 1000 }, { xMm: 0, zMm: 1000 },
  ] }),
  normalizeS6Profile({ winding: "ccw-from-positive-y-v1", vertices: [
    { xMm: 1000, zMm: 1000 }, { xMm: 0, zMm: 1000 }, { xMm: 0, zMm: 0 },
    { xMm: 1000, zMm: 0 },
  ] }),
);
assert.throws(() => canonicalS6Json({ value: 1.5 }), /CANONICAL_NUMBER_INVALID/);
assert.equal(normalizeS6Rotation({ xMd: 180000, yMd: -180001, zMd: 0 }).xMd, -180000);
~~~

### Task 2 - Add backward-compatible S6 persistence and graph validation

**Files:** add src/lib/s6-persistence.ts; modify src/lib/store.ts; add tests/s6-persistence.test.ts.

**Interface:** validateS6Collections(parsedRecord: unknown, state: StoreState): void and validateS6Graph(state: StoreState): void.

- [ ] RED: Add tests named legacy state without S6 collections loads empty, present malformed S6 collection is rejected, duplicate revision and broken parent graphs are rejected, child object IDs preserve identity and reject reuse, malformed geometry/designFormReview exact keys are rejected, only one current accepted revision exists and supersession is recorded, and artifact attempts/retries/idempotency keys form a valid graph.
- [ ] Run pnpm exec tsx --test tests/s6-persistence.test.ts; expect the absent fields to be undefined or the malformed fixture to load because S6 hooks do not exist.
- [ ] GREEN: Add empty S6 arrays to emptyStoreState, load defaults for absent fields, invoke strict collection validators from JsonRepository.load, and invoke the graph validator from both load and transact. Reject unknown keys, wrong versions, invalid rect/round/profile shapes, holes/self-intersections, incomplete designFormReview, duplicate IDs, invalid lineage, object identity reuse, non-contiguous attempts, and idempotency key/hash reuse.
- [ ] Run the focused command; expect all six cases to pass. Run pnpm exec tsx --test tests/s6-persistence.test.ts tests/s5.test.ts to prove S5 remains green.
- [ ] REFACTOR: Keep S6 validators independent of S5 validators and preserve all S1-S5 error mapping; rerun both commands.
- [ ] Commit: feat(s6): add strict persisted collections and graph validation.

### Task 3 - Expose the typed, read-only S5 projection and source fence

**Files:** modify src/lib/s5.ts; add src/lib/s6-source.ts; add tests/s6-source.test.ts.

**Interface:** S5WorkflowService.getS6ReadOnlyProjection(projectId) returns S5ToS6Projection; createS6SourceReader(repository, objects, projectionReader) returns S6SourceReader.

- [ ] RED: Add tests named ready S5 projection contains the exact typed fields including the approved asset ID/hash used by design-form review, S5 plan coordinates remain conceptual and are not metric compiler inputs, PDF and storage-key churn does not change source fingerprint, geometry/requirements/hero/approval changes change source fingerprint, non-ready S5 is refused, and source fence rejects at generation draft correction acceptance render publication and download boundaries.
- [ ] Run pnpm exec tsx --test tests/s6-source.test.ts; expect the typed method and source reader imports to fail.
- [ ] GREEN: Refactor the existing S5 handoff checks into a typed projection method without changing S5 state. Read/validate the committed JSON plan and confirmed brand-style fields, calculate the exact fingerprint subset above, and implement assertCurrent with S6_SOURCE_STALE/S6_SOURCE_NOT_READY.
- [ ] Run the focused command; expect all six cases to pass and the existing S5 read-only handoff test to remain green.
- [ ] REFACTOR: Ensure the projection has no mutation capability and that the fingerprint excludes artifact IDs/storage keys but includes the approved asset hash and plan hash; design-form review can bind only to the current active asset/fingerprint; rerun pnpm exec tsx --test tests/s6-source.test.ts tests/s5.test.ts.
- [ ] Commit: feat(s6): add typed S5 source projection and stale fence.

### Task 4 - Implement the deterministic metric compiler

**Files:** add src/lib/s6-compiler.ts; add tests/s6-fixture.ts; add tests/s6-compiler.test.ts.

**Interface:** compileS6Draft({ source, revisionId, parentRevisionId, clock }): S6SpatialModelRecord.

- [ ] RED: Add tests named compiler covers every one-to-four open-side variant, compiler creates no wall on any open side, known height remains confirmed and unknown height creates an audited assumption, compiler creates exact countable instances, compiler preserves stable IDs and deterministic placement, emits only the rect/round/profile allowlist, preserves canonical profile vertices and round radius, creates design-form review unknowns instead of silently accepting generic boxes, passes the angled-partition/round-counter/profile/overhead/material/open-side fixtures, unresolved semantic requirements create blocking unknowns, and S5 conceptual Q16 coordinates never become metric coordinates.
- [ ] Run pnpm exec tsx --test tests/s6-compiler.test.ts; expect the compiler module to be absent.
- [ ] GREEN: Compile floor, closed walls, zone regions, categorized requirement instances, and bounded overhead/design volumes with the exact ordering and provenance rules. Use a fixture matrix for all 15 non-empty open-side subsets and requirements with exact counts 0, 1, 2, and 4. Keep inferred shape/placement/material values auditable, initialize designFormReview as required/in_progress with blocking design_form unknowns, and never copy S5 normalized coordinates or infer metric values from hero pixels.
- [ ] Run the focused command; expect the open-side, height, count, shape, design-form, fixture, and determinism cases to pass with exact model hashes for repeat inputs.
- [ ] REFACTOR: Move category mapping, shape allowlists, and placement constants into pure local functions, keep IDs and profile/footprint canonicalization in s6-canonical.ts, rerun the focused command and pnpm typecheck.
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

const draft = compileS6Draft(fidelityFixture.input);
assert.equal(draft.designFormReview.status, "required");
assert.ok(draft.unknowns.some((item) => item.kind === "design_form" && item.blocking));
assert.equal(draft.objects.find((item) => item.objectType === "counter")?.primitive.kind, "rect_prism");
~~~

### Task 5 - Add the independent ordered validator

**Files:** add src/lib/s6-validation.ts; add tests/s6-validation.test.ts.

**Interface:** validateS6Model(model, context): S6ValidationReceipt.

- [ ] RED: Add tests named validation order reports source before geometry, numeric bounds and invalid transforms are rejected, hierarchy cycles and dangling parents are rejected, open-side/envelope/maximum-height failures are exact, rect/round/profile shape allowlists are enforced, holes/duplicate/collinear/short-edge/self-intersecting/oversized profiles reject, exact requirement counts and mappings are enforced, design-form review is source-fenced and required before acceptance, unsupported form returns S6_UNSUPPORTED_FORM without a box, unresolved geometry persists as a draft but blocks acceptance/final render, meaningful physical collisions fail while floor/zone contact is allowed, camera and canonical hash failures are reported, and warnings do not become fabricated zero values.
- [ ] Run pnpm exec tsx --test tests/s6-validation.test.ts; expect the validator module to be absent.
- [ ] GREEN: Implement the 12-step validation order and blocking matrix. Use exact shape-aware containment/collision predicates and verify designFormReview coverage, current asset/fingerprint, explicit simplification warnings, and fail-closed unsupported form. Ensure a receipt is itself canonically hashed and does not contain raw client text.
- [ ] Run the focused command; expect all named numeric, shape, profile, design-form, collision, hash, and blocking cases to pass. Run the compiler plus validator command to prove a generic draft remains acceptance_blocked until review.
- [ ] REFACTOR: Keep validation pure and make status decisions in the service; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): validate spatial models independently.

### Task 6 - Implement immutable correction operations and child revisions

**Files:** add src/lib/s6-correction.ts; add tests/s6-correction.test.ts.

**Interface:** applyS6Corrections(parent, operations, { childRevisionId, clock, actorSubjectId }): { model, event }.

- [ ] RED: Add tests named move rotate resize and material operations create a child, replace_geometry switches only an allowlisted shape, round radius and profile vertex corrections are bounded/canonicalized, confirm_design_inference records user acceptance without relabelling provenance, design-form unknown resolution requires a typed replacement or explicit simplification, add generates a server ID and remove obeys allowlists, booth facts and hard objects cannot be edited, child revisions preserve unchanged object identity, deleted IDs cannot be reused, and stale parent tokens do not auto-merge.
- [ ] Run pnpm exec tsx --test tests/s6-correction.test.ts; expect the correction module to be absent.
- [ ] GREEN: Validate max 32 operations, apply them to a cloned model, preserve ancestor IDs/identity keys, generate server IDs for additions, maintain bounded_design_inference/user_confirmed_design_decision provenance, update designFormReview coverage, and leave booth/source fields immutable. Do not call the validator as a repair mechanism; return the changed model for independent validation.
- [ ] Run the focused command; expect all geometry, design-form, lineage, restriction, and conflict cases to pass.
- [ ] REFACTOR: Make each operation a discriminated pure handler and keep storage/event writes out of this file; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): add typed immutable spatial corrections.

### Task 7 - Add stable cameras, renderer, and structured preservation evidence

**Files:** add src/lib/s6-camera.ts, src/lib/s6-renderer.ts, and src/lib/s6-preservation.ts; add tests/s6-renderer.test.ts.

**Interfaces:** buildS6Cameras(model): S6Camera[]; renderS6View(model, camera): S6RenderedView; checkS6ViewPreservation(model, camera, rendered): S6ViewPreservationReceipt.

- [ ] RED: Add tests named camera formulas are stable for known and unknown height, the three view IDs are exact and deterministic, same model/camera produce byte-identical s6-svg-geometry-v2 output, rect/round/profile geometry renders as visibly distinct faces/silhouettes, material/finish variation is visible without geometry drift, SVG preserves major forms/material IDs/overhead objects, SVG contains no remote resources or executable content, top view is a user-facing editor surface, unsupported/unreviewed form cannot become an accepted_view, and preservation fails on changed object IDs/open sides/geometry/profile/radius/materials.
- [ ] Run pnpm exec tsx --test tests/s6-renderer.test.ts; expect the camera/renderer modules to be absent.
- [ ] GREEN: Implement fixed shape-aware camera formulas, quantized projection, deterministic rect/profile face ordering, 24-facet round display, finish shading/marks, escaped SVG, data attributes, scene evidence, and hard preservation checks. Use every representative fidelity fixture; assert perspective SVG contains filled faces/silhouettes for the angled partition, round counter, profile feature, overhead profile, and material variation rather than only wireframe/block-diagram lines.
- [ ] Run the focused command; expect all camera, geometry, finish, preservation, unsupported-form, and determinism cases to pass with exact SVG hashes stable.
- [ ] REFACTOR: Keep shape projection math separate from camera formulas, keep renderer tessellation separate from canonical geometry, and keep preservation separate from SVG string construction; rerun the focused command and pnpm typecheck.
- [ ] Commit: feat(s6): render deterministic geometry-faithful spatial views.

### Task 8 - Implement S6 lifecycle, idempotency, acceptance, and recovery service

**Files:** add src/lib/s6.ts; add src/lib/s6-publication.ts; modify src/lib/workflow.ts; add tests/s6-lifecycle.test.ts.

**Interface:** WorkflowService.s6 is constructed with the shared repository/object store, injected S6SourceReader, deterministic clock/UUID, process liveness, and publication hook.

- [ ] RED: Add tests named generation persists one source-fenced draft with designFormReview, same generation key replays without a second draft, correction creates immutable lineage and acceptance writes a supersession event, concurrent corrections and acceptance conflict, idempotency keys cover generation correction reopen validation acceptance render and publication, stale source blocks every mutation boundary, unreviewed/unsupported design form blocks accepted_view and publication while diagnostic draft preview remains marked, render/publish use exact no-overwrite promotion, and restart recovery handles queued running staged promoted and terminal states.
- [ ] Run pnpm exec tsx --test tests/s6-lifecycle.test.ts; expect WorkflowService.s6 and the service module to be absent.
- [ ] GREEN: Implement service methods, source checks at every boundary, repository CAS tokens, S6 idempotency records, validation receipts, design-form acceptance gate, job claims, exact model/view publication, and bounded recovery. Use no provider and no fallback success; never convert unsupported form to a box.
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

- [ ] RED: Add UI assertions to tests/s6-api.test.ts or a focused component section named S6 client retains keys through uncertain mutation, top-view selection sends stable object IDs, shape selection exposes only the semantic-family allowlist, round radius/profile vertex controls submit typed geometry, design-form confirmation/explicit simplification is explicit, approved-reference metadata is read-only, and S6 UI does not expose forbidden booth-fact controls.
- [ ] Run pnpm exec tsx --test tests/s6-api.test.ts; expect the new component imports/selectors to be absent.
- [ ] GREEN: Build a small persisted-state screen that loads GET /s6, shows source/revision/readiness/design-form status, renders the top SVG, selects by data-object-id, and provides bounded move/rotate/resize/replace-geometry/profile/radius/material/map/confirm/resolve/add/remove controls. Show the private approved reference by asset ID/hash without turning pixels into inputs. Use withRetainedIdempotencyKey and show UnknownNetworkOutcome without minting a new key.
- [ ] Ensure controls for booth width/depth/open sides/max height, exact source counts, S5 approval, arbitrary scene markup, holes, meshes, and unconstrained CAD operations do not exist. The screen must surface unsupported/unresolved form and block final acceptance; it must reload state rather than treating a local optimistic model as accepted.
- [ ] Run pnpm typecheck and the focused API/component command; expect green.
- [ ] REFACTOR: Keep network client functions separate from render components and do not place server auth/material values in the client bundle; rerun typecheck and the full test command.
- [ ] Commit: feat(s6): add persisted spatial review editor.

### Task 11 - Add telemetry and the exact S7 handoff

**Files:** add src/lib/s6-telemetry.ts, src/lib/s6-handoff.ts; add tests/s6-handoff.test.ts; extend tests/s6-api.test.ts.

**Interfaces:** buildS6Telemetry(state, projectId, sourceStatus): S6Telemetry; buildS6ToS7Handoff(model, receipt, source): S6ToS7Handoff.

- [ ] RED: Add tests named telemetry reports exact zero and unavailable cost semantics, handoff includes accepted identity/hash/source fence/units/open sides, handoff preserves stable objects/hierarchy/rect-circle-polygon footprints/exact profile vertices/radius/materials/provenance/unknowns, unknown booth height remains unknown, unsupported/unresolved form cannot produce a handoff, and stale or draft revisions cannot produce a handoff.
- [ ] Run pnpm exec tsx --test tests/s6-handoff.test.ts; expect the two modules to be absent.
- [ ] GREEN: Implement exact fields, no payload/brief/prompt/image data, explicit unavailable reasons, exact geometry-union/footprint projection, explicit design-form simplification provenance, and current-accepted/source-current eligibility. Do not emit CAD or reinterpret the hero.
- [ ] Run the focused handoff command and S6 API command; expect green.
- [ ] REFACTOR: Keep handoff projection read-only and avoid exposing private artifact keys; rerun focused tests and pnpm typecheck.
- [ ] Commit: feat(s6): add telemetry and S7 handoff contract.

### Task 12 - Add adversarial security tests and S1-S5 regression

**Files:** add tests/s6-security.test.ts; modify package.json.

- [ ] RED: Add tests named cross-project IDs never disclose state, path traversal and user labels cannot escape private keys, profile holes/self-intersections/oversized vertices fail closed, SVG rejects scripts/URLs/foreign objects/client path commands, payload/count/operation limits are enforced, unsupported form is never boxed, private model/view artifacts require authorization, provider/tool costs remain unavailable, and existing S1-S5 suite remains green.
- [ ] Run pnpm exec tsx --test tests/s6-security.test.ts; expect the new module/test file to be absent.
- [ ] GREEN: Add the security assertions and append every new S6 test file to the existing pnpm test script without removing any prior test path. Confirm no provider SDK, credential, remote asset, arbitrary mesh/script, or lockfile dependency is introduced.
- [ ] Run pnpm typecheck, pnpm exec tsx --test tests/s6-security.test.ts, and pnpm test; expect the existing 142-test baseline plus the S6 tests to pass with zero failures.
- [ ] REFACTOR: Run pnpm audit --prod using the repository lockfile policy, confirm no new package was added, and rerun pnpm typecheck plus pnpm test.
- [ ] Commit: test(s6): close security and regression matrix.

### Task 13 - Complete implementation self-review and documentation closure

**Files:** implementation files in the map only; no new status/report file.

- [ ] Run rg -n "\\bTODO\\b|\\bTBD\\b|FIXME" src app tests and expect no unfinished-work markers in implementation. Inspect this plan for unfinished-work markers separately, excluding this scan instruction itself.
- [ ] Run rg -n "s6-spatial-model-v1|S6SpatialModelRecord|S6ConcurrencyToken|S6_VIEW_IDS|S6_SOURCE_PROJECTION_SCHEMA_VERSION|S6_SOURCE_FINGERPRINT_VERSION|S6_TELEMETRY_SCHEMA_VERSION|S6RenderedView|S6GeometryKind|S6Profile|S6DesignFormReview|S6CorrectionGeometry|S6Footprint2D|S6_UNSUPPORTED_FORM|S6_PROFILE_INVALID|s6-svg-geometry-v2|s6-svg-axonometric-v1" src/lib tests app and verify every symbol has one consistent definition, the new version is used everywhere, and the old renderer version is absent.
- [ ] Run rg --files src app tests | Sort-Object plus the file-map and fidelity-fixture checklist and verify every proposed path exists, every modified path is intentional, no S7/S8 export path or dependency was added, and tests/s6-fixture.ts contains each representative design fixture.
- [ ] Run git diff --check, pnpm typecheck, and pnpm test; record exact counts and failures, without calling absent checks green.
- [ ] Run a secret-value audit over the diff and confirm no credentials, .env values, private asset bytes, prompts, or tokens are present.
- [ ] Inspect pnpm-lock.yaml diff and current package manifests; confirm no new dependency/licence/advisory surface and record that no concrete provider/model/version/licence/privacy trust grant was selected.
- [ ] Commit: docs(s6): finalize implementation contract review.

## Test matrix and acceptance mapping

The following matrix is the minimum evidence Web should use to accept implementation work against this plan:

| Contract area | Exact test file/case family |
|---|---|
| Canonicalization, numeric bounds, rounding, equality, hash input | tests/s6-canonical.test.ts canonical JSON, fractional/negative-zero/overflow, rotation, half-away rounding |
| Bounded geometry union and profile/round canonicalization | tests/s6-canonical.test.ts, tests/s6-persistence.test.ts; rect/round/profile allowlists, exact vertices/radius, no holes, winding, normalization, bounds, and hash |
| S5 source projection/fingerprint/stale fencing | tests/s6-source.test.ts ready projection, artifact churn exclusion, source changes, all seven stale boundaries |
| Design-form acquisition, provenance, review completion, and hard-fact immutability | tests/s6-compiler.test.ts, tests/s6-validation.test.ts, tests/s6-correction.test.ts, tests/s6-api.test.ts |
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
| Geometry-faithful views, material/finish intent, round/profile silhouettes, overhead, open sides, and renderer-v2 preservation | tests/s6-renderer.test.ts plus all representative fidelity fixtures |
| Unsupported-form fail-closed and explicit simplification | tests/s6-validation.test.ts, tests/s6-lifecycle.test.ts, tests/s6-security.test.ts, tests/s6-handoff.test.ts |
| Artifact privacy, no-overwrite, stale downloads | tests/s6-api.test.ts, tests/s6-security.test.ts, tests/s6-lifecycle.test.ts |
| Telemetry unavailable semantics | tests/s6-handoff.test.ts, tests/s6-security.test.ts |
| S7/S8 continuity without implementation | tests/s6-handoff.test.ts; exact rect/circle/polygon geometry, transforms, identity, materials, unknowns, assumptions, and no hero reread |
| S1-S5 regression | pnpm test, including all pre-existing test paths |
| Adversarial resource/injection/cross-tenant cases | tests/s6-security.test.ts |
| Full S5 intent -> S6 model -> user correction -> accepted model -> views -> S7 fidelity chain | tests/s6-fixture.ts, tests/s6-compiler.test.ts, tests/s6-correction.test.ts, tests/s6-renderer.test.ts, tests/s6-handoff.test.ts |

## Plan self-review

1. Spec coverage: PASS at contract level. The plan locks source projection, numeric representation, schema, stable IDs, bounded geometry, design-form acquisition, compiler, validation, revision/concurrency/idempotency, correction UX/API, acceptance/supersession audit, renderer alternatives and choice, cameras, preservation, storage/publication/recovery, telemetry, errors, security, dependencies, S7 handoff, and exact tests.
2. Unfinished-work scan: PASS when the Task 13 implementation scan is run and this plan is inspected separately; every task has a concrete file, interface, test name, command, expected result, and commit, and no unfinished-work marker is a required implementation placeholder.
3. Type/signature consistency: PASS by cross-section review. S6SpatialModelRecord, S6GeometryPrimitive, S6GeometryKind, S6Profile, S6DesignFormReview, S6CorrectionGeometry, S6Footprint2D, S6PublicSpatialModel, S6ConcurrencyToken, S6SourceReader, S5ToS6Projection, S6RenderedView, S6ViewId, S6ValidationReceipt, S6SupersessionEvent, and S6ToS7Handoff agree across the file map, types, renderer evidence, tasks, and handoff.
4. File-path validity: PASS for the plan. All proposed implementation/test paths are listed before tasks; existing parent directories and current source/test conventions are valid, while future S6 files are explicitly named additions rather than claimed existing files.
5. S7/S8 scope check: PASS. The plan defines only a typed handoff and continuity assertions; it adds no CAD/3D exporter, APS integration, fabrication/BIM detail, provider implementation, deployment, credential, or production mutation.
6. Secret audit: PASS at plan level. No secret values, prompts, image bytes, tokens, private asset contents, provider credentials, or raw user payloads are specified for persistence, logs, artifacts, or tests.
7. Dependency/version/licence consistency: PASS. The chosen renderer adds no dependency; pnpm-lock.yaml remains unchanged; no concrete provider/model/version/licence/privacy trust grant is selected. Rejected renderer/provider alternatives are explicitly subject to a later evidence/trust gate.
8. Test coverage mapping: PASS. The matrix maps every required geometry, source-fence, design-form, correction, renderer, preservation, unsupported-form, security, lifecycle, and S7 continuity case to a named test file/task while retaining S1-S5 regression.
9. Representative-design fidelity: PASS at contract level. The fixture table covers angled/non-axis-aligned, round, non-rectangular extrusion, overhead profile, material/finish variation, mixed open-side, and full downstream continuity; each requires the same form in model, views, and handoff.
10. Unsupported-form fail-closed: PASS. Unsupported/ambiguous form produces S6_UNSUPPORTED_FORM plus a blocking design-form unknown, never an automatic box, and blocks acceptance/final view/publication/handoff until a typed correction or explicitly accepted simplification is recorded.

G2 plan output is this document only. Implementation, repair, acceptance, merge, and finality remain Web-controlled.
