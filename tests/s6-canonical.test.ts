import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  S6DesignFormReview,
  S6SpatialModelRecord,
} from "../src/lib/types";
import {
  assertS6Integer,
  canonicalS6Json,
  compilerObjectId,
  deriveS6Footprint,
  hashS6Model,
  normalizeS6Profile,
  normalizeS6Rotation,
  roundHalfAwayFromZero,
  userObjectId,
} from "../src/lib/s6-canonical";

const HASH = "a".repeat(64);
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const APPROVAL_EVENT_ID = "10000000-0000-4000-8000-000000000002";
const EVIDENCE_ASSET_ID = "10000000-0000-4000-8000-000000000003";

function designFormReview(overrides: Partial<S6DesignFormReview> = {}): S6DesignFormReview {
  return {
    status: "required",
    evidenceAssetId: EVIDENCE_ASSET_ID,
    evidenceAssetSha256: HASH,
    sourceS5Fingerprint: HASH,
    reviewedObjectIds: [],
    unresolvedUnknownIds: [],
    explicitSimplificationUnknownIds: [],
    acceptedByUser: false,
    ...overrides,
  };
}

function model(overrides: Partial<S6SpatialModelRecord> = {}): S6SpatialModelRecord {
  return {
    schemaVersion: "s6-spatial-model-v1",
    modelRevisionId: "10000000-0000-4000-8000-000000000004",
    projectId: PROJECT_ID,
    parentRevisionId: null,
    parentRevisionHash: null,
    revisionNumber: 1,
    sourceS5Fingerprint: HASH,
    sourceS5ApprovalEventId: APPROVAL_EVENT_ID,
    sourceS5ApprovalGeneration: 1,
    status: "generated_draft",
    booth: {
      widthMm: 6000,
      depthMm: 3000,
      openSides: ["east", "north"],
      maxHeightMm: 3000,
      coordinateConvention: {
        version: "booth-local-right-handed-v1",
        units: "millimetres",
        handedness: "right-handed",
        origin: "north-west-floor-corner",
        xAxis: "east",
        yAxis: "up",
        zAxis: "south",
      },
      heightState: "known",
    },
    objects: [
      {
        objectId: "s6o_floor",
        identityKey: "booth-floor",
        parentObjectId: null,
        objectType: "floor_footprint",
        role: "booth_floor",
        label: "Floor",
        primitive: {
          kind: "rect_prism",
          dimensionsMm: { widthMm: 6000, depthMm: 3000, heightMm: 1 },
          geometryState: "exact",
          localAnchor: "floor",
        },
        transform: {
          positionMm: { xMm: 0, yMm: 0, zMm: 0 },
          rotationMd: { xMd: 0, yMd: 0, zMd: 0 },
        },
        zoneIds: [],
        requirementIds: [],
        materialIds: [],
        unknownIds: [],
        provenance: {
          kind: "confirmed_project_input",
          sourceRef: "s5.geometrySnapshot",
          sourceFingerprint: HASH,
          acceptedByUser: true,
          note: null,
        },
        hardConstraint: "booth_envelope",
        editable: false,
        removable: false,
      },
    ],
    zones: [],
    materials: [],
    cameras: [],
    provenance: [],
    assumptions: [],
    unknowns: [],
    designFormReview: designFormReview(),
    modelHash: HASH,
    canonicalByteSize: 0,
    modelArtifact: {
      artifactKey: "projects/10000000-0000-4000-8000-000000000001/s6/revisions/10000000-0000-4000-8000-000000000004/model.json",
      stagingKey: "projects/10000000-0000-4000-8000-000000000001/s6/staging/job/claim/model.json",
      sha256: null,
      byteSize: null,
      status: "not_written",
    },
    validationReceiptId: null,
    acceptanceEventId: null,
    createdBy: "compiler",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    acceptedAt: null,
    supersededAt: null,
    staleAt: null,
    ...overrides,
  };
}

test("S6 canonical spatial JSON is byte and hash deterministic", () => {
  const first = model();
  const reordered = model({
    booth: { ...first.booth, openSides: ["north", "east"] },
    objects: [...first.objects].reverse(),
  });
  const firstHash = hashS6Model(first);
  const reorderedHash = hashS6Model(reordered);
  assert.equal(firstHash.modelHash, reorderedHash.modelHash);
  assert.equal(firstHash.canonicalByteSize, reorderedHash.canonicalByteSize);
  assert.equal(canonicalS6Json(first), canonicalS6Json(reordered));
});

test("S6 rejects fractional negative-zero non-safe and overflow values", () => {
  assert.throws(() => assertS6Integer(1.5, "value"), /CANONICAL_NUMBER_INVALID/);
  assert.throws(() => canonicalS6Json(-0), /CANONICAL_NUMBER_INVALID/);
  assert.throws(() => canonicalS6Json(Object(-0)), /CANONICAL_NUMBER_INVALID/);
  assert.throws(() => assertS6Integer(Number.MAX_SAFE_INTEGER + 1, "value"), /NUMERIC_OUT_OF_BOUNDS/);
  assert.throws(() => canonicalS6Json({ xMm: 1_000_001 }), /NUMERIC_OUT_OF_BOUNDS/);
});

test("S6 rotation normalizes to the half-open millidegree range", () => {
  assert.deepEqual(
    normalizeS6Rotation({ xMd: 180000, yMd: -180001, zMd: 0 }),
    { xMd: -180000, yMd: 179999, zMd: 0 },
  );
});

test("S6 uses half-away-from-zero rounding", () => {
  assert.equal(roundHalfAwayFromZero(1.5), 2);
  assert.equal(roundHalfAwayFromZero(-1.5), -2);
  assert.equal(roundHalfAwayFromZero(1.49), 1);
  assert.equal(roundHalfAwayFromZero(-1.49), -1);
});

test("rect/round/profile shape canonicalization is deterministic", () => {
  assert.deepEqual(
    deriveS6Footprint({
      kind: "rect_prism",
      dimensionsMm: { widthMm: 1200, depthMm: 800, heightMm: 2200 },
      geometryState: "exact",
      localAnchor: "floor",
    }),
    { kind: "rectangle", widthMm: 1200, depthMm: 800 },
  );
  assert.deepEqual(
    deriveS6Footprint({
      kind: "round_prism",
      radiusMm: 450,
      heightMm: 1100,
      geometryState: "bounded_inference",
      localAnchor: "floor",
    }),
    { kind: "circle", radiusMm: 450 },
  );
  assert.equal(
    canonicalS6Json({
      kind: "profile_extrusion",
      profile: normalizeS6Profile({
        winding: "ccw-from-positive-y-v1",
        vertices: [
          { xMm: 1000, zMm: 1000 },
          { xMm: 0, zMm: 1000 },
          { xMm: 0, zMm: 0 },
          { xMm: 1000, zMm: 0 },
        ],
      }),
      heightMm: 2200,
      geometryState: "exact",
      localAnchor: "floor",
    }),
    canonicalS6Json({
      kind: "profile_extrusion",
      profile: normalizeS6Profile({
        winding: "ccw-from-positive-y-v1",
        vertices: [
          { xMm: 0, zMm: 0 },
          { xMm: 1000, zMm: 0 },
          { xMm: 1000, zMm: 1000 },
          { xMm: 0, zMm: 1000 },
        ],
      }),
      heightMm: 2200,
      geometryState: "exact",
      localAnchor: "floor",
    }),
  );
});

test("duplicate/collinear profile vertices normalize", () => {
  const normalized = normalizeS6Profile({
    winding: "ccw-from-positive-y-v1",
    vertices: [
      { xMm: 0, zMm: 0 },
      { xMm: 1000, zMm: 0 },
      { xMm: 1000, zMm: 0 },
      { xMm: 1000, zMm: 1000 },
      { xMm: 0, zMm: 1000 },
    ],
  });
  assert.deepEqual(normalized.vertices, [
    { xMm: 0, zMm: 0 },
    { xMm: 0, zMm: 1000 },
    { xMm: 1000, zMm: 1000 },
    { xMm: 1000, zMm: 0 },
  ]);
});

test("holes/self-intersections/short edges/too many vertices reject", () => {
  assert.throws(
    () => normalizeS6Profile({ winding: "ccw-from-positive-y-v1", vertices: [], holes: [] } as never),
    /S6_PROFILE_INVALID/,
  );
  assert.throws(
    () => normalizeS6Profile({
      winding: "ccw-from-positive-y-v1",
      vertices: [
        { xMm: 0, zMm: 0 },
        { xMm: 1000, zMm: 1000 },
        { xMm: 0, zMm: 1000 },
        { xMm: 1000, zMm: 0 },
      ],
    }),
    /S6_PROFILE_/,
  );
  assert.throws(
    () => normalizeS6Profile({
      winding: "ccw-from-positive-y-v1",
      vertices: [
        { xMm: 0, zMm: 0 },
        { xMm: 50, zMm: 0 },
        { xMm: 50, zMm: 500 },
        { xMm: 0, zMm: 500 },
      ],
    }),
    /S6_PROFILE_/,
  );
  assert.throws(
    () => normalizeS6Profile({
      winding: "ccw-from-positive-y-v1",
      vertices: Array.from({ length: 25 }, (_, index) => ({ xMm: index * 500, zMm: 0 })),
    }),
    /S6_PROFILE_TOO_COMPLEX/,
  );
});

test("round radius bounds reject", () => {
  assert.throws(
    () => canonicalS6Json({ kind: "round_prism", radiusMm: 99, heightMm: 100, localAnchor: "floor", geometryState: "exact" }),
    /ROUND_GEOMETRY_INVALID/,
  );
  assert.throws(
    () => canonicalS6Json({ kind: "round_prism", radiusMm: 50_001, heightMm: 100, localAnchor: "floor", geometryState: "exact" }),
    /ROUND_GEOMETRY_INVALID/,
  );
});

test("designFormReview participates in the model hash", () => {
  const original = hashS6Model(model());
  const changed = hashS6Model(model({ designFormReview: designFormReview({ acceptedByUser: true }) }));
  assert.notEqual(original.modelHash, changed.modelHash);
});

test("S6 compiler IDs are stable while user IDs are fresh", () => {
  const compilerId = compilerObjectId(PROJECT_ID, APPROVAL_EVENT_ID, "requirement:counter:1");
  assert.equal(compilerId, compilerObjectId(PROJECT_ID, APPROVAL_EVENT_ID, "requirement:counter:1"));
  assert.notEqual(compilerId, compilerObjectId(PROJECT_ID, APPROVAL_EVENT_ID, "requirement:counter:2"));
  assert.match(userObjectId("10000000-0000-4000-8000-000000000005"), /^s6u_[0-9a-f]{32}$/);
  assert.notEqual(
    userObjectId("10000000-0000-4000-8000-000000000005"),
    userObjectId("10000000-0000-4000-8000-000000000006"),
  );
});
