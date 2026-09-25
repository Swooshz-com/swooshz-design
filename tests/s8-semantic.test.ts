import assert from "node:assert/strict";
import test from "node:test";
import { buildS8Mesh } from "../src/lib/s8-fbx-geometry";
import { buildS8TransformOracle, canonicalS8SourceJson } from "../src/lib/s8-fbx-oracle";
import { compareS8UfbxReadback, type S8UfbxReadback } from "../src/lib/s8-fbx-semantic";
import { s8Sha256 } from "../src/lib/s8-fbx-profile";
import type { S6ToS7Handoff, S7ToS8Handoff } from "../src/lib/types";

const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);

function sources(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
  const makeObject = (objectId: string, parentObjectId: string | null, positionMm: { xMm: number; yMm: number; zMm: number }) => ({
    objectId, identityKey: objectId, parentObjectId, objectType: "box" as const, role: "furniture" as const, label: objectId,
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 100, depthMm: 80, heightMm: 60 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 100, depthMm: 80 }, transform: { positionMm, rotationMd: { xMd: 1000, yMd: -2000, zMd: 3000 } },
    boundsMm: { widthMm: 100, depthMm: 80, heightMm: 60 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null },
  });
  const objects = [makeObject("object-a", null, { xMm: 10, yMm: 20, zMm: 30 }), makeObject("object-b", "object-a", { xMm: 4, yMm: 5, zMm: 6 })];
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: revisionId, acceptedRevisionHash: hash, sourceS5Fingerprint: hash,
    spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 1000, depthMm: 1000, openSides: ["north"], maxHeightMm: 1000, heightState: "known" }, objects,
    hierarchy: objects.map((object) => ({ objectId: object.objectId, parentObjectId: object.parentObjectId })), zones: [], requirements: [], assumptions: [], unknowns: [], materials: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1, manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash,
    readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash, dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1", dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
}

function ufbxMatrix(matrix: number[]): number[] {
  return [matrix[0]!, matrix[4]!, matrix[8]!, matrix[1]!, matrix[5]!, matrix[9]!, matrix[2]!, matrix[6]!, matrix[10]!, matrix[3]!, matrix[7]!, matrix[11]!];
}

function exactReadback(s6: S6ToS7Handoff, s7: S7ToS8Handoff): S8UfbxReadback {
  const oracle = buildS8TransformOracle(s6);
  const sorted = s6.objects.slice().sort((left, right) => Buffer.compare(Buffer.from(left.objectId), Buffer.from(right.objectId)));
  const names = new Map(sorted.map((object, index) => [object.objectId, `SWZ_${index.toString().padStart(4, "0")}_${s8Sha256(object.objectId).slice(0, 16)}`]));
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const nodes: S8UfbxReadback["nodes"] = [{ name: "SWZ_ROOT", parent: null, effectiveScale: [1, 1, 1], nodeToParent: identity, nodeToWorld: identity, mesh: null }];
  for (const object of sorted) {
    const transform = oracle.get(object.objectId)!;
    const mesh = buildS8Mesh(object.geometry);
    nodes.push({ name: names.get(object.objectId)!, parent: object.parentObjectId === null ? "SWZ_ROOT" : names.get(object.parentObjectId)!, sourceObjectId: object.objectId, identityKey: object.identityKey, effectiveScale: [1, 1, 1], nodeToParent: ufbxMatrix(transform.localMatrix), nodeToWorld: ufbxMatrix(transform.worldMatrix), mesh: { vertices: mesh.verticesMm.map((value) => [...value] as [number, number, number]), triangles: mesh.triangles.map((value) => [...value] as [number, number, number]), cornerNormals: mesh.cornerNormals.map((value) => [...value] as [number, number, number]), materialNames: [] } });
  }
  return { schemaVersion: "s8-ufbx-readback-v1", fbxVersion: 7400, unitMeters: 0.001, warningCount: 0, source: { revisionId: s6.acceptedRevisionId, revisionHash: s6.acceptedRevisionHash, s6ValidationHash: s6.validationReceipt.validationHash, s6HandoffDigest: s8Sha256(canonicalS8SourceJson(s6)) }, materials: [], nodes };
}

test("semantic validation compares local and composed world transforms, bounds, topology, and normals", () => {
  const { s6, s7 } = sources();
  const readback = exactReadback(s6, s7);
  const result = compareS8UfbxReadback(s6, s7, readback);
  assert.equal(result.outcome, "pass");
  const shifted = structuredClone(readback);
  shifted.nodes[2]!.nodeToWorld[9]! += 0.1;
  assert.throws(() => compareS8UfbxReadback(s6, s7, shifted), /S8_WORLD_POSITION_TOLERANCE_EXCEEDED|S8_ABSOLUTE_WORLD_BOUND_TOLERANCE_EXCEEDED/);
});

test("root identity and homogeneous rows are fail-closed", () => {
  const { s6, s7 } = sources();
  const rootShifted = exactReadback(s6, s7);
  rootShifted.nodes[0]!.nodeToWorld[9] = 0.01;
  assert.throws(() => compareS8UfbxReadback(s6, s7, rootShifted), /S8_ROOT_IDENTITY_INVALID/);
});

test("physical provenance is required and the root rejects either provenance property", () => {
  const { s6, s7 } = sources();
  const correct = exactReadback(s6, s7);
  assert.doesNotThrow(() => compareS8UfbxReadback(s6, s7, correct));

  for (const [property, value] of [
    ["sourceObjectId", undefined],
    ["sourceObjectId", "wrong-source"],
    ["identityKey", undefined],
    ["identityKey", "wrong-identity"],
  ] as const) {
    const invalid = structuredClone(correct);
    const physical = invalid.nodes.find((node) => node.name !== "SWZ_ROOT")! as unknown as Record<string, unknown>;
    if (value === undefined) delete physical[property];
    else physical[property] = value;
    assert.throws(() => compareS8UfbxReadback(s6, s7, invalid), /S8_SOURCE_IDENTITY_MISMATCH/);
  }

  for (const property of ["sourceObjectId", "identityKey"]) {
    for (const value of [undefined, null, ""]) {
      const invalid = structuredClone(correct);
      Object.defineProperty(invalid.nodes[0], property, { value, enumerable: true, configurable: true });
      assert.throws(() => compareS8UfbxReadback(s6, s7, invalid), /S8_SOURCE_IDENTITY_MISMATCH/);
    }
  }
});
