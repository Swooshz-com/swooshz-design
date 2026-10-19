import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hashS6Model, hashS6ValidationReceipt } from "../src/lib/s6-canonical";
import { buildS6Cameras } from "../src/lib/s6-camera";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { buildS6ToS7Handoff } from "../src/lib/s6-handoff";
import { assertS10DimensionScheduleCurrent, buildS10DimensionSchedule } from "../src/lib/s10-dimensions";
import { makeS6Source } from "./s6-fixture";
import type { S6ValidationReceipt, UUID } from "../src/lib/types";

const AT = "2026-09-02T00:00:00.000Z";

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
  model.validationReceiptId = "30000000-0000-4000-8000-000000000002" as UUID;
  const hash = hashS6Model(model);
  model.modelHash = hash.modelHash;
  model.canonicalByteSize = hash.canonicalByteSize;
  const receipt: S6ValidationReceipt = {
    schemaVersion: "s6-validation-receipt-v1",
    receiptId: model.validationReceiptId,
    projectId: model.projectId,
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    validatorVersion: "s6-validator-v1",
    orderVersion: "s6-validation-order-v1",
    outcome: "pass",
    errors: [], warnings: [], checkedAt: AT, validationHash: "",
  };
  receipt.validationHash = hashS6ValidationReceipt(receipt);
  return { model, handoff: buildS6ToS7Handoff(model, receipt, source) };
}

test("S10 dimension schedule uses the accepted 9 m by 6 m source and exact modeled primitives", () => {
  const { model, handoff } = accepted();
  const schedule = buildS10DimensionSchedule(model, handoff);
  assert.deepEqual(schedule.booth, {
    widthMm: 9000, depthMm: 6000, maxHeightMm: 3500,
    heightState: "known", openSides: handoff.booth.openSides,
  });
  assert.equal(schedule.sourceRevisionHash, model.modelHash);
  assert.equal(schedule.s7ValidationHash, handoff.validationReceipt.validationHash);
  assert.equal(schedule.units, "millimetres");
  assert.equal(schedule.objects.length, handoff.objects.length);
  for (const item of schedule.objects) {
    const sourceObject = handoff.objects.find((object) => object.objectId === item.objectId)!;
    assert.equal(item.identityKey, sourceObject.identityKey);
    assert.equal(item.geometryState, sourceObject.geometry.geometryState);
    assert.equal(item.localGeometry.kind, sourceObject.geometry.kind);
    if (item.localGeometry.kind === "rect_prism" && sourceObject.geometry.kind === "rect_prism") {
      assert.equal(item.localGeometry.widthMm, sourceObject.geometry.dimensionsMm.widthMm);
      assert.equal(item.localGeometry.depthMm, sourceObject.geometry.dimensionsMm.depthMm);
      assert.equal(item.localGeometry.heightMm, sourceObject.geometry.dimensionsMm.heightMm);
    }
  }
  assert.deepEqual(buildS10DimensionSchedule(model, handoff), schedule);
  assert.doesNotThrow(() => assertS10DimensionScheduleCurrent(schedule, model, handoff));
});

test("S10 schedule rejects stale revisions and altered dimensions", () => {
  const { model, handoff } = accepted();
  const schedule = buildS10DimensionSchedule(model, handoff);
  const changed = structuredClone(model);
  changed.booth.widthMm += 100;
  const hash = hashS6Model(changed);
  changed.modelHash = hash.modelHash;
  changed.canonicalByteSize = hash.canonicalByteSize;
  assert.throws(() => assertS10DimensionScheduleCurrent(schedule, changed, handoff));
  const changedSchedule = structuredClone(schedule);
  changedSchedule.objects[0]!.worldOriginMm.xMm += 1;
  assert.throws(() => assertS10DimensionScheduleCurrent(changedSchedule, model, handoff), /S10_SOURCE_STALE_OR_INVALID/u);
  const changedHandoff = structuredClone(handoff);
  changedHandoff.booth.depthMm += 100;
  assert.throws(() => buildS10DimensionSchedule(model, changedHandoff));
});
