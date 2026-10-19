import assert from "node:assert/strict";
import test from "node:test";
import { buildS8WriterPayload } from "../src/lib/s8-fbx-payload";
import { S8_LIMITS, S8_RESOURCE_TABLE, s8Utf8Bytes } from "../src/lib/s8-fbx-profile";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../src/lib/types";

const hash = "a".repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111";

function source(identityKey: string): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const object = {
    objectId: "object-1", identityKey, parentObjectId: null, objectType: "box" as const, role: "furniture" as const, label: "box",
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 10, depthMm: 10, heightMm: 10 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 10, depthMm: 10 }, transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 10, depthMm: 10, heightMm: 10 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null },
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: "22222222-2222-4222-8222-222222222222", acceptedRevisionHash: hash, sourceS5Fingerprint: hash,
    spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 100, depthMm: 100, openSides: ["north"], maxHeightMm: 100, heightState: "known" }, objects: [object], hierarchy: [{ objectId: object.objectId, parentObjectId: null }], zones: [], requirements: [], assumptions: [], unknowns: [], materials: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = { schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: s6.acceptedRevisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash, s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1, manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash, readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash, dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1", dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

test("S8 resource table exposes the production caps", () => {
  assert.equal(S8_RESOURCE_TABLE.metadataBytesPerObject, 4096);
  assert.equal(S8_RESOURCE_TABLE.serializedUfbxDepth, 257);
  assert.equal(S8_RESOURCE_TABLE.writerChildProcesses, 0);
  assert.equal(S8_RESOURCE_TABLE.validatorChildProcesses, 0);
  assert.equal(S8_LIMITS.sourceBytes, 2 * 1024 * 1024);
});

test("identity metadata is bounded by UTF-8 bytes, not JavaScript code units", () => {
  const oversized = "雪".repeat(2048);
  assert.equal(s8Utf8Bytes(oversized), 6144);
  const value = source(oversized);
  assert.throws(() => buildS8WriterPayload(value.s6, value.s7), /S8_RESOURCE_LIMIT/);
});
