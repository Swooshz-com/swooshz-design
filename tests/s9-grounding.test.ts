import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { buildS6Cameras } from "../src/lib/s6-camera";
import { hashS6Model, hashS6ValidationReceipt } from "../src/lib/s6-canonical";
import { buildS6ToS7Handoff } from "../src/lib/s6-handoff";
import { assertS9GroundingCurrent, prepareS9Grounding } from "../src/lib/s9-grounding";
import { makeS6Source } from "./s6-fixture";
import type { S6SpatialModelRecord, S6ValidationReceipt, UUID } from "../src/lib/types";

const AT = "2026-09-02T00:00:00.000Z";
const RECEIPT_ID = "30000000-0000-4000-8000-000000000002" as UUID;

function accepted() {
  const source = makeS6Source({ widthMm: 9000, depthMm: 6000, maxHeightMm: 3500 });
  const model = compileS6Draft({
    source,
    revisionId: "30000000-0000-4000-8000-000000000001",
    parentRevisionId: null,
    clock: () => AT,
  });
  for (const unknown of model.unknowns) {
    unknown.status = "resolved";
    unknown.resolutionKind = "represented";
    unknown.resolutionNote = "Accepted test revision.";
    unknown.resolvedBy = "user";
    unknown.resolvedAt = AT;
  }
  model.status = "accepted_current";
  model.designFormReview.status = "complete";
  model.designFormReview.reviewedObjectIds = model.objects.filter((item) => item.unknownIds.length > 0).map((item) => item.objectId).sort();
  model.designFormReview.unresolvedUnknownIds = [];
  model.designFormReview.explicitSimplificationUnknownIds = [];
  model.designFormReview.acceptedByUser = true;
  model.cameras = buildS6Cameras(model);
  model.validationReceiptId = RECEIPT_ID;
  const hash = hashS6Model(model);
  model.modelHash = hash.modelHash;
  model.canonicalByteSize = hash.canonicalByteSize;
  const receipt: S6ValidationReceipt = {
    schemaVersion: "s6-validation-receipt-v1",
    receiptId: RECEIPT_ID,
    projectId: model.projectId,
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    validatorVersion: "s6-validator-v1",
    orderVersion: "s6-validation-order-v1",
    outcome: "pass",
    errors: [],
    warnings: [],
    checkedAt: AT,
    validationHash: "",
  };
  receipt.validationHash = hashS6ValidationReceipt(receipt);
  return { model, handoff: buildS6ToS7Handoff(model, receipt, source) };
}

function rehash(model: S6SpatialModelRecord): void {
  const hash = hashS6Model(model);
  model.modelHash = hash.modelHash;
  model.canonicalByteSize = hash.canonicalByteSize;
}

test("S9 controls bind the accepted booth revision and deterministic S6 cameras", () => {
  const { model, handoff } = accepted();
  assert.equal(model.cameras.length, 3);
  for (const camera of model.cameras) {
    const control = prepareS9Grounding(model, handoff, camera.viewId);
    assert.equal(control.sourceRevisionHash, handoff.acceptedRevisionHash);
    assert.equal(control.cameraHash, camera.cameraHash);
    assert.equal(control.objectIds.length, model.objects.length);
    assert.ok(control.controlSvgBytes.byteLength > 0);
    assert.equal(control.groundingHash, prepareS9Grounding(model, handoff, camera.viewId).groundingHash);
    assert.doesNotThrow(() => assertS9GroundingCurrent(control, model, handoff));
  }
});

test("S9 source, camera, control bytes and handoff drift fail closed", () => {
  const { model, handoff } = accepted();
  const control = prepareS9Grounding(model, handoff, "perspective-northwest");
  const changed = structuredClone(model);
  changed.booth.widthMm += 100;
  rehash(changed);
  assert.throws(() => assertS9GroundingCurrent(control, changed, handoff), /S9_SOURCE_STALE/u);
  const wrongHandoff = structuredClone(handoff);
  wrongHandoff.acceptedRevisionHash = "0".repeat(64);
  assert.throws(() => prepareS9Grounding(model, wrongHandoff, "perspective-northwest"), /S9_SOURCE_STALE/u);
  const forgedGeometry = structuredClone(handoff);
  Reflect.set(forgedGeometry.objects[0]!.geometry, "kind", "unsupported_geometry");
  assert.throws(() => prepareS9Grounding(model, forgedGeometry, "perspective-northwest"), /S9_SOURCE_STALE/u);
  const wrongCamera = structuredClone(model);
  wrongCamera.cameras[0]!.positionMm.xMm += 100;
  rehash(wrongCamera);
  const handoffForCamera = structuredClone(handoff);
  handoffForCamera.acceptedRevisionHash = wrongCamera.modelHash;
  assert.throws(() => prepareS9Grounding(wrongCamera, handoffForCamera, "perspective-northwest"), /S9_CAMERA_STALE/u);
  const corrupted = { ...control, controlSvgBytes: new Uint8Array(control.controlSvgBytes) };
  corrupted.controlSvgBytes[0] ^= 1;
  assert.throws(() => assertS9GroundingCurrent(corrupted, model, handoff), /S9_SOURCE_STALE/u);
  const corruptedStamp = { ...control, sourceRevisionId: "different-revision" };
  assert.throws(() => assertS9GroundingCurrent(corruptedStamp, model, handoff), /S9_SOURCE_STALE/u);
});

test("S9 controls reject draft or stale handoffs before image production", () => {
  const { model, handoff } = accepted();
  model.status = "generated_draft";
  assert.throws(() => prepareS9Grounding(model, handoff, "perspective-northwest"), /S9_SOURCE_STALE/u);
  model.status = "accepted_current";
  Reflect.set(handoff.eligibility, "stale", true);
  assert.throws(() => prepareS9Grounding(model, handoff, "perspective-northwest"), /S9_SOURCE_STALE/u);
});
