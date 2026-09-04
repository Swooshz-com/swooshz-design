import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError, type Project, type S6ToS7Handoff, type UUID } from "../src/lib/types";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S7CadService } from "../src/lib/s7-cad";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as UUID;
const HASH = "a".repeat(64);

function handoff(revisionId = REVISION_ID, revisionHash = HASH): S6ToS7Handoff {
  const item = { objectId: "object-1", identityKey: "object-1", parentObjectId: null, objectType: "box", role: "furniture", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" }, footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 }, transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } }, boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [], provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null } };
  return { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID, acceptedRevisionId: revisionId, acceptedRevisionHash: revisionHash, sourceS5Fingerprint: HASH, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" }, booth: { widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: 3000, heightState: "known" }, objects: [item], hierarchy: [{ objectId: "object-1", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [], validationReceipt: { receiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false } } as unknown as S6ToS7Handoff;
}

function project(): Project { return { projectId: PROJECT_ID, name: "handoff fixture", status: "geometry_ready", boothGeometry: null, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" }; }

function makeService() {
  const root = mkdtempSync(join(tmpdir(), "s7-handoff-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => state.projects.push(project()));
  const objects = new PrivateObjectStore(join(root, "objects"));
  let current = handoff();
  const s6 = { getS7Handoff: () => structuredClone(current) } as never;
  const service = new S7CadService({ repository, objects, s6 });
  return { service, move(next: S6ToS7Handoff) { current = next; } };
}

test("S7 to S8 handoff is the exact flat identity contract and carries no 3D authority", () => {
  const value = makeService();
  const result = value.service.createExport(PROJECT_ID, "handoff-key");
  const handoffValue = value.service.getHandoff(PROJECT_ID);
  assert.deepEqual(Object.keys(handoffValue).sort(), ["schemaVersion", "projectId", "sourceRevisionId", "sourceRevisionHash", "sourceS5Fingerprint", "s7ArtifactId", "s7ArtifactHash", "s7ArtifactByteSize", "manifestId", "manifestHash", "readbackReceiptId", "readbackHash", "dxfVersion", "worldToPlanVersion", "coordinateConvention", "dxfIsNot3DAuthority", "s8MustReadAcceptedS6Model"].sort());
  assert.equal(handoffValue.schemaVersion, "s7-to-s8-handoff-v1");
  assert.equal(handoffValue.s7ArtifactId, result.export.artifactId);
  assert.equal(handoffValue.s7ArtifactHash, result.export.sha256);
  assert.equal(handoffValue.s7ArtifactByteSize, result.export.byteSize);
  assert.equal(handoffValue.dxfIsNot3DAuthority, true);
  assert.equal(handoffValue.s8MustReadAcceptedS6Model, true);
  assert.equal(JSON.stringify(handoffValue).includes("privateStorage"), false);
});

test("handoff selection is live-source fenced and does not disclose stale artifact identity", () => {
  const value = makeService();
  value.service.createExport(PROJECT_ID, "fence-key");
  value.move(handoff("30000000-0000-4000-8000-000000000099" as UUID, "b".repeat(64)));
  assert.throws(() => value.service.getHandoff(PROJECT_ID), (error) => error instanceof AppError && error.code === "S7_HANDOFF_NOT_READY");
});
