import assert from "node:assert/strict";
import test from "node:test";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../src/lib/types";
import { buildS8WriterPayload, canonicalS8Json } from "../src/lib/s8-fbx-payload";

const hash = "a".repeat(64);
const hashB = "b".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";

function sources(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const objectBase = {
    parentObjectId: null,
    objectType: "box" as const,
    role: "furniture" as const,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 }, geometryState: "exact" as const, localAnchor: "center" as const },
    footprint: { kind: "rectangle" as const, widthMm: 1200, depthMm: 600 },
    transform: { positionMm: { xMm: 1.125, yMm: 2.25, zMm: -3.5 }, rotationMd: { xMd: 89999, yMd: -45001, zMd: 179999 } },
    boundsMm: { widthMm: 1200, depthMm: 600, heightMm: 901 },
    zoneIds: [], requirementIds: [], provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null }, unknownIds: [],
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId: id, acceptedRevisionId: "22222222-2222-4222-8222-222222222222", acceptedRevisionHash: hash,
    sourceS5Fingerprint: hashB, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 6000, depthMm: 6000, openSides: ["north"], maxHeightMm: 4000, heightState: "known" },
    objects: [
      { ...objectBase, objectId: "obj-\u96ea", identityKey: "duplicate label", materialIds: ["mat-b", "mat-a"] },
      { ...objectBase, objectId: "obj-a", identityKey: "duplicate label", materialIds: [] },
    ],
    hierarchy: [{ objectId: "obj-\u96ea", parentObjectId: null }, { objectId: "obj-a", parentObjectId: null }],
    zones: [], requirements: [], assumptions: [], unknowns: [],
    materials: [
      { materialId: "mat-a", label: "Neutral", finishKind: "solid_color", colorHex: "#336699", source: "user_confirmed_design_decision", sourceAssetId: null, sourceAssetSha256: null, notes: null, provenance: { kind: "user_confirmed_design_decision", sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null } },
      { materialId: "mat-b", label: "Wood", finishKind: "wood_like", colorHex: null, source: "s5_visual_intent", sourceAssetId: null, sourceAssetSha256: null, notes: null, provenance: { kind: "bounded_design_inference", sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null } },
    ],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId: id, sourceRevisionId: s6.acceptedRevisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hashB,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

test("payload is canonical integer-only JSON with stable hashed names", () => {
  const { s6, s7 } = sources();
  const first = buildS8WriterPayload(s6, s7);
  const second = buildS8WriterPayload(s6, s7);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.bytes.toString("utf8"), canonicalS8Json(first.payload));
  assert.ok(first.payload.objects.every((object) => /^SWZ_\d{4}_[0-9a-f]{16}$/.test(object.name)));
  assert.ok(first.payload.objects.every((object) => object.matrixTicks.every(Number.isSafeInteger)));
  assert.ok(first.payload.objects.find((object) => object.objectId === "obj-\u96ea")!.degradationCodes.includes("PREVIEW_MULTIPLE_MATERIALS_FIRST_STABLE"));
  assert.ok(first.payload.objects.find((object) => object.objectId === "obj-a")!.degradationCodes.includes("PREVIEW_MATERIAL_MISSING"));
});

test("S7 cannot replace or drift from the accepted S6 source", () => {
  const { s6, s7 } = sources();
  assert.throws(() => buildS8WriterPayload(s6, { ...s7, sourceRevisionHash: hashB }), /S8_SOURCE_BINDING_MISMATCH/);
  assert.throws(() => canonicalS8Json({ bad: 1.5 }), /S8_PAYLOAD_NON_INTEGER/);
});
