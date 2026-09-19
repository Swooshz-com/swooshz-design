import assert from "node:assert/strict";
import test from "node:test";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../src/lib/types";
import { buildS8WriterPayload } from "../src/lib/s8-fbx-payload";
import { assertS8TransformOracle, buildS8TransformOracle, s8Quantize } from "../src/lib/s8-fbx-oracle";

const hash = "a".repeat(64);
const sourceFingerprint = "b".repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";

function source(rotationMd: { xMd: number; yMd: number; zMd: number }, positionMm = { xMm: 1, yMm: 2, zMm: 3 }): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const object = {
    objectId: "obj-a",
    identityKey: "stable-object",
    parentObjectId: null,
    objectType: "box" as const,
    role: "furniture" as const,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm, rotationMd },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 900 },
    zoneIds: [],
    requirementIds: [],
    materialIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "test", sourceFingerprint, acceptedByUser: true, note: null },
    unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId,
    acceptedRevisionId: revisionId,
    acceptedRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [object],
    hierarchy: [{ objectId: object.objectId, parentObjectId: null }],
    zones: [],
    requirements: [],
    assumptions: [],
    unknowns: [],
    materials: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1",
    projectId,
    sourceRevisionId: revisionId,
    sourceRevisionHash: hash,
    sourceS5Fingerprint: sourceFingerprint,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444",
    s7ArtifactHash: hash,
    s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555",
    manifestHash: hash,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666",
    readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1",
    worldToPlanVersion: "s7-world-to-plan-v1",
    coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true,
    s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

function payloadFor(rotationMd: { xMd: number; yMd: number; zMd: number }, positionMm?: { xMm: number; yMm: number; zMm: number }) {
  const value = source(rotationMd, positionMm);
  return buildS8WriterPayload(value.s6, value.s7).payload;
}

test("source-rigid bindings preserve exact historical position and unit scale", () => {
  for (const xMd of [90_000, 45_000]) {
    const value = payloadFor({ xMd, yMd: 0, zMd: 0 }).objects[0]!;
    assert.deepEqual(value.unitScaleTicks, [10_000_000_000, 10_000_000_000, 10_000_000_000]);
    assert.deepEqual(value.sourceEulerMicrodegrees, [xMd * 1_000, 0, 0]);
  }
  const matrixFloor = payloadFor({ xMd: 0, yMd: 0, zMd: 0 }, { xMm: 12345, yMm: 0, zMm: -90001 }).objects[0]!;
  assert.deepEqual(matrixFloor.localTranslationTicks, [12_345_000_000, 90_001_000_000, 0]);
  assert.deepEqual(matrixFloor.matrixTicks.slice(3, 12).filter((_, index) => index % 4 === 0), [12_345_000_000, 90_001_000_000, 0]);
});
test("singular, wrapped, half-turn, and non-commuting rotations serialize deterministically", () => {
  const cases = [
    { xMd: 0, yMd: 90_000, zMd: 0 },
    { xMd: 0, yMd: -90_000, zMd: 0 },
    { xMd: 180_000, yMd: 0, zMd: 180_000 },
    { xMd: 360_000, yMd: -360_000, zMd: 180_000 },
    { xMd: 12_345, yMd: -67_890, zMd: 135_791 },
  ];
  for (const rotationMd of cases) {
    const first = payloadFor(rotationMd).objects[0]!;
    const second = payloadFor(rotationMd).objects[0]!;
    assert.deepEqual(first.sourceEulerMicrodegrees, second.sourceEulerMicrodegrees);
    assert.ok(first.sourceEulerMicrodegrees.every((value) => Number.isSafeInteger(value) && value >= -180_000_000 && value <= 180_000_000));
  }
});

test("source-rigid admission rejects hidden transform channels and unbound provenance", () => {
  const base = source({ xMd: 1, yMd: 2, zMd: 3 });
  const hidden = structuredClone(base.s6) as any;
  hidden.objects[0].transform.scale = { x: 1, y: 1, z: 1 };
  assert.throws(() => buildS8WriterPayload(hidden, base.s7), /S8_RIGID_TRANSFORM_UNSUPPORTED/);
  const unbound = structuredClone(base.s6) as any;
  unbound.objects[0].provenance.sourceFingerprint = hash;
  assert.throws(() => buildS8WriterPayload(unbound, base.s7), /S8_RIGID_PROVENANCE_REQUIRED/);
});

test("redundant transform fields are independently oracle-checked", () => {
  const base = source({ xMd: 10, yMd: 20, zMd: 30 });
  const payload = buildS8WriterPayload(base.s6, base.s7).payload.objects[0]!;
  const expected = buildS8TransformOracle(base.s6).get("obj-a")!;
  assert.equal(s8Quantize(-0, 1), 0);
  assert.doesNotThrow(() => assertS8TransformOracle(expected, payload));
  assert.throws(() => assertS8TransformOracle(expected, { ...payload, matrixTicks: payload.matrixTicks.map((value, index) => index === 3 ? value + 1000 : value) }), /S8_TRANSFORM_ORACLE_MISMATCH/);
});
