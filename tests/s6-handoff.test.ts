import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyStoreState } from "../src/lib/store";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { hashS6Model, normalizeS6Geometry } from "../src/lib/s6-canonical";
import { makeS6Source, representativeSources } from "./s6-fixture";
import { buildS6Telemetry } from "../src/lib/s6-telemetry";
import { buildS6ToS7Handoff } from "../src/lib/s6-handoff";
import type {
  S6PublicState,
  S6SpatialModelRecord,
  S6ToS7Handoff,
  S6ValidationReceipt,
  UUID,
} from "../src/lib/types";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as UUID;
const RECEIPT_ID = "30000000-0000-4000-8000-000000000002" as UUID;
const AT = "2026-09-02T00:00:00.000Z";
const HASH = "a".repeat(64);

function rehash(model: S6SpatialModelRecord): S6SpatialModelRecord {
  const value = hashS6Model(model);
  model.modelHash = value.modelHash;
  model.canonicalByteSize = value.canonicalByteSize;
  return model;
}

function acceptedModel(source = makeS6Source({ maxHeightMm: null })): S6SpatialModelRecord {
  const model = compileS6Draft({ source, revisionId: REVISION_ID, parentRevisionId: null, clock: () => AT });
  const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
  assert.ok(physical.length >= 3);
  physical[0]!.primitive = normalizeS6Geometry({
    kind: "rect_prism",
    dimensionsMm: { widthMm: 1200, depthMm: 500, heightMm: 900 },
    geometryState: "exact",
    localAnchor: "floor",
  });
  physical[1]!.primitive = normalizeS6Geometry({
    kind: "round_prism",
    radiusMm: 450,
    heightMm: 1100,
    geometryState: "exact",
    localAnchor: "floor",
  });
  physical[2]!.primitive = normalizeS6Geometry({
    kind: "profile_extrusion",
    profile: {
      winding: "ccw-from-positive-y-v1",
      vertices: [
        { xMm: 0, zMm: 0 },
        { xMm: 1800, zMm: 0 },
        { xMm: 1800, zMm: 400 },
        { xMm: 1100, zMm: 400 },
        { xMm: 1100, zMm: 900 },
        { xMm: 0, zMm: 900 },
      ],
    },
    heightMm: 2200,
    geometryState: "exact",
    localAnchor: "floor",
  });
  for (const unknown of model.unknowns) {
    unknown.status = "resolved";
    unknown.resolutionKind = "represented";
    unknown.resolutionNote = "Typed handoff fixture.";
    unknown.resolvedBy = "user";
    unknown.resolvedAt = AT;
  }
  model.status = "accepted_current";
  model.designFormReview.status = "complete";
  model.designFormReview.reviewedObjectIds = model.objects.filter((item) => item.unknownIds.length > 0).map((item) => item.objectId).sort();
  model.designFormReview.unresolvedUnknownIds = [];
  model.designFormReview.explicitSimplificationUnknownIds = [];
  model.designFormReview.acceptedByUser = true;
  return rehash(model);
}

function receipt(model: S6SpatialModelRecord, outcome: "pass" | "pass_with_warnings" = "pass"): S6ValidationReceipt {
  return {
    schemaVersion: "s6-validation-receipt-v1",
    receiptId: RECEIPT_ID,
    projectId: model.projectId,
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    validatorVersion: "s6-validator-v1",
    orderVersion: "s6-validation-order-v1",
    outcome,
    errors: [],
    warnings: outcome === "pass_with_warnings" ? [{ code: "BOUNDED_INFERENCE", severity: "warning", fieldPath: "objects", objectId: null, requirementId: null, detail: "Bounded fixture warning." }] : [],
    checkedAt: AT,
    validationHash: HASH,
  };
}

function readyStatus(source: ReturnType<typeof makeS6Source>): S6PublicState["source"] {
  return {
    readiness: "ready",
    sourceS5Fingerprint: source.sourceFingerprint,
    approvalEventId: source.approvalEventId,
    approvalGeneration: source.approvalGeneration,
  };
}

test("telemetry reports exact zero and unavailable cost semantics", () => {
  const state = emptyStoreState();
  const source = makeS6Source();
  const telemetry = buildS6Telemetry(state, PROJECT_ID, readyStatus(source));
  assert.equal(telemetry.schemaVersion, "s6-telemetry-v1");
  assert.equal(telemetry.projectId, PROJECT_ID);
  for (const [key, metric] of Object.entries(telemetry)) {
    if (key.endsWith("Count")) {
      assert.deepEqual(metric, { availability: "available", value: 0, reason: null }, key);
    }
  }
  assert.deepEqual(telemetry.sourceReadiness, { availability: "available", value: "ready", reason: null });
  assert.deepEqual(telemetry.fullModelByteSize, { availability: "unavailable", value: null, reason: "no_current_model" });
  assert.deepEqual(telemetry.providerCost, { availability: "unavailable", value: null, reason: "no_provider_used" });
  assert.deepEqual(telemetry.toolCost, { availability: "unavailable", value: null, reason: "no_billed_tool_amount" });
  assert.match(telemetry.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(JSON.stringify(telemetry).includes("prompt"), false);
  assert.equal(JSON.stringify(telemetry).includes("storageKey"), false);
});

test("handoff includes accepted identity/hash/source fence/units/open sides and preserves canonical geometry", () => {
  const source = makeS6Source({ maxHeightMm: null, openSides: ["north", "south"] });
  const model = acceptedModel(source);
  const value: S6ToS7Handoff = buildS6ToS7Handoff(model, receipt(model, "pass_with_warnings"), source);
  assert.deepEqual(value.eligibility, { currentAccepted: true, sourceCurrent: true, stale: false });
  assert.equal(value.acceptedRevisionId, model.modelRevisionId);
  assert.equal(value.acceptedRevisionHash, model.modelHash);
  assert.equal(value.sourceS5Fingerprint, source.sourceFingerprint);
  assert.equal(value.spatialSchemaVersion, "s6-spatial-model-v1");
  assert.equal(value.units, "millimetres");
  assert.deepEqual(value.booth.openSides, ["north", "south"]);
  assert.equal(value.booth.maxHeightMm, null);
  assert.equal(value.booth.heightState, "unknown");
  assert.equal(value.validationReceipt.outcome, "pass_with_warnings");
  assert.deepEqual(value.hierarchy, model.objects.map((item) => ({ objectId: item.objectId, parentObjectId: item.parentObjectId })));
  assert.deepEqual(value.objects.map((item) => item.objectId), model.objects.map((item) => item.objectId));
  const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
  const handoffRect = value.objects.find((item) => item.objectId === physical[0]!.objectId)!;
  const handoffRound = value.objects.find((item) => item.objectId === physical[1]!.objectId)!;
  const handoffProfile = value.objects.find((item) => item.objectId === physical[2]!.objectId)!;
  assert.equal(handoffRect.geometry.kind, "rect_prism");
  assert.deepEqual(handoffRect.footprint, { kind: "rectangle", widthMm: 1200, depthMm: 500 });
  assert.equal(handoffRound.geometry.kind, "round_prism");
  assert.deepEqual(handoffRound.footprint, { kind: "circle", radiusMm: 450 });
  assert.equal(handoffProfile.geometry.kind, "profile_extrusion");
  assert.deepEqual(handoffProfile.footprint, {
    kind: "polygon",
    vertices: [
      { xMm: 0, zMm: 0 },
      { xMm: 0, zMm: 900 },
      { xMm: 1100, zMm: 900 },
      { xMm: 1100, zMm: 400 },
      { xMm: 1800, zMm: 400 },
      { xMm: 1800, zMm: 0 },
    ],
  });
  assert.deepEqual(handoffProfile.geometry, physical[2]!.primitive);
  assert.deepEqual(handoffRound.provenance, physical[1]!.provenance);
  assert.deepEqual(handoffRound.materialIds, physical[1]!.materialIds);
  assert.deepEqual(value.unknowns, model.unknowns);
  assert.equal(JSON.stringify(value).includes("activeAsset"), false);
  assert.equal(JSON.stringify(value).includes("storageKey"), false);
  assert.equal(JSON.stringify(value).includes("svgBytes"), false);
});

test("handoff rejects draft, stale, unsupported, and unresolved form state", () => {
  const source = makeS6Source();
  const model = acceptedModel(source);
  const validReceipt = receipt(model);
  const draft = structuredClone(model);
  draft.status = "corrected_draft";
  assert.throws(() => buildS6ToS7Handoff(draft, validReceipt, source), /S6_(?:ACCEPTANCE_CONFLICT|HANDOFF)/u);
  const staleSource = structuredClone(source);
  staleSource.sourceFingerprint = "b".repeat(64);
  assert.throws(() => buildS6ToS7Handoff(model, validReceipt, staleSource), /S6_(?:SOURCE_STALE|HANDOFF)/u);
  const unresolved = structuredClone(model);
  unresolved.status = "accepted_current";
  unresolved.designFormReview.acceptedByUser = false;
  unresolved.designFormReview.status = "required";
  unresolved.designFormReview.unresolvedUnknownIds = [unresolved.unknowns[0]!.unknownId];
  unresolved.unknowns[0]!.status = "unresolved";
  rehash(unresolved);
  assert.throws(() => buildS6ToS7Handoff(unresolved, receipt(unresolved), source), /S6_(?:DESIGN_FORM_UNREVIEWED|ACCEPTANCE_CONFLICT|HANDOFF)/u);
  const unsupportedSource = representativeSources()["unsupported-form-fails-closed"]!;
  const unsupported = compileS6Draft({ source: unsupportedSource, revisionId: REVISION_ID, parentRevisionId: null, clock: () => AT });
  unsupported.status = "accepted_current";
  rehash(unsupported);
  assert.throws(() => buildS6ToS7Handoff(unsupported, receipt(unsupported), unsupportedSource), /S6_(?:UNSUPPORTED_FORM|ACCEPTANCE_CONFLICT|HANDOFF)/u);
});
