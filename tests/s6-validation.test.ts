import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { hashS6Model } from "../src/lib/s6-canonical";
import { validateS6Model } from "../src/lib/s6-validation";
import {
  deterministicClock,
  deterministicRevisionId,
  makeS6Source,
  representativeSources,
} from "./s6-fixture";
import type { S5ToS6Projection, S6SpatialModelRecord } from "../src/lib/types";

function draft(source: S5ToS6Projection = makeS6Source(), revision = 1): S6SpatialModelRecord {
  return compileS6Draft({ source, revisionId: deterministicRevisionId(revision), parentRevisionId: null, clock: deterministicClock() });
}

function checked(model: S6SpatialModelRecord, source: S5ToS6Projection): ReturnType<typeof validateS6Model> {
  return validateS6Model(model, { source, priorModels: [], expectedSourceFingerprint: source.sourceFingerprint });
}

function clone(model: S6SpatialModelRecord): S6SpatialModelRecord {
  return structuredClone(model);
}

function codes(receipt: ReturnType<typeof validateS6Model>): string[] {
  return [...receipt.errors, ...receipt.warnings].map((item) => item.code);
}

function firstPhysicalObject(model: S6SpatialModelRecord): NonNullable<S6SpatialModelRecord["objects"][number]> {
  const object = model.objects.find((item) => item.role !== "booth_floor" && item.role !== "zone");
  assert.ok(object);
  return object;
}

test("validation order reports source before geometry", () => {
  const source = makeS6Source();
  const model = draft(source);
  model.booth.widthMm = 1.5;
  const receipt = validateS6Model(model, { source, priorModels: [], expectedSourceFingerprint: "b".repeat(64) });
  assert.equal(receipt.errors[0]?.code, "SOURCE_STALE");
});

test("numeric bounds and invalid transforms are rejected", () => {
  const source = makeS6Source();
  const model = clone(draft(source));
  const object = firstPhysicalObject(model);
  object.transform.positionMm.xMm = 1.5;
  const receipt = checked(model, source);
  assert.ok(codes(receipt).includes("CANONICAL_NUMBER_INVALID") || codes(receipt).includes("TRANSFORM_INVALID"));
});

test("hierarchy cycles and dangling parents are rejected", () => {
  const source = makeS6Source();
  const dangling = clone(draft(source));
  const first = firstPhysicalObject(dangling);
  first.parentObjectId = "missing-parent";
  assert.ok(codes(checked(dangling, source)).includes("HIERARCHY_DANGLING_PARENT"));
  const cycle = clone(draft(source));
  const physical = cycle.objects.filter((item) => item.role !== "booth_floor" && item.role !== "zone");
  assert.ok(physical[0] && physical[1]);
  physical[0]!.parentObjectId = physical[1]!.objectId;
  physical[1]!.parentObjectId = physical[0]!.objectId;
  assert.ok(codes(checked(cycle, source)).includes("HIERARCHY_CYCLE"));
});

test("open-side, envelope, and maximum-height failures are exact", () => {
  const source = makeS6Source({ openSides: ["north", "east"], maxHeightMm: 2000 });
  const model = clone(draft(source));
  model.booth.openSides = ["north"];
  const openSideReceipt = checked(model, source);
  assert.ok(codes(openSideReceipt).includes("OPEN_SIDE_INTEGRITY"));
  const outside = clone(draft(source));
  const object = firstPhysicalObject(outside);
  object.transform.positionMm.xMm = source.geometrySnapshot.widthMm + 1;
  assert.ok(codes(checked(outside, source)).includes("CONTAINMENT_INVALID"));
  const tall = clone(draft(source));
  const tallObject = firstPhysicalObject(tall);
  if (tallObject.primitive.kind === "rect_prism") tallObject.primitive.dimensionsMm.heightMm = 2001;
  else if (tallObject.primitive.kind === "round_prism") tallObject.primitive.heightMm = 2001;
  else tallObject.primitive.heightMm = 2001;
  assert.ok(codes(checked(tall, source)).includes("MAX_HEIGHT_EXCEEDED"));
});

test("semantic geometry allowlists and bounded profile rules are enforced", () => {
  const source = makeS6Source();
  const wrong = clone(draft(source));
  const floor = wrong.objects.find((item) => item.role === "booth_floor");
  assert.ok(floor);
  floor.primitive = { kind: "round_prism", radiusMm: 200, heightMm: 1, geometryState: "exact", localAnchor: "floor" };
  assert.ok(codes(checked(wrong, source)).includes("SPATIAL_SCHEMA_INVALID"));
  const invalidProfile = clone(draft(representativeSources()["extruded-non-rectangular-feature"]!));
  const feature = invalidProfile.objects.find((item) => item.objectType === "display_plinth");
  assert.ok(feature);
  feature.primitive = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 2000, zMm: 10 }, { xMm: 0, zMm: 10 }] }, heightMm: 900, geometryState: "bounded_inference", localAnchor: "floor" };
  const profileReceipt = checked(invalidProfile, representativeSources()["extruded-non-rectangular-feature"]!);
  assert.ok(codes(profileReceipt).includes("S6_PROFILE_INVALID") || codes(profileReceipt).includes("S6_PROFILE_SELF_INTERSECTION"));
});

test("holes, duplicate, collinear, short-edge, self-intersecting, and oversized profiles reject", () => {
  const source = makeS6Source({ requirements: [{ name: "Profile feature", details: "profile display", expected: "present" }] });
  const base = draft(source);
  const cases = [
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 2000, zMm: 1000 }, { xMm: 0, zMm: 1000 }, { xMm: 0, zMm: 0 }] },
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 0, zMm: 1000 }] },
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 0, zMm: 1000 }] },
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 0 }, { xMm: 1000, zMm: 10 }, { xMm: 0, zMm: 1000 }] },
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 2000 }, { xMm: 0, zMm: 2000 }, { xMm: 2000, zMm: 0 }] },
    { vertices: [{ xMm: 0, zMm: 0 }, { xMm: 100001, zMm: 0 }, { xMm: 100001, zMm: 1000 }, { xMm: 0, zMm: 1000 }] },
  ];
  for (const item of cases) {
    const model = clone(base);
    const object = firstPhysicalObject(model);
    object.primitive = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: item.vertices }, heightMm: 900, geometryState: "bounded_inference", localAnchor: "floor" };
    const receipt = checked(model, source);
    assert.ok(codes(receipt).some((code) => code.startsWith("S6_PROFILE")), JSON.stringify(receipt.errors));
  }
});

test("exact requirement counts and mappings are enforced", () => {
  const source = makeS6Source({ requirements: [{ name: "Four display plinths", expected: "exact_count", expectedCount: 4 }] });
  const model = clone(draft(source));
  const object = model.objects.find((item) => item.requirementIds.includes("brief.functional.001"));
  assert.ok(object);
  model.objects = model.objects.filter((item) => item.objectId !== object.objectId);
  const receipt = checked(model, source);
  assert.ok(codes(receipt).includes("REQUIRED_COUNT_MISMATCH"));
  const unknownSource = makeS6Source({ requirements: [{ name: "Mystery thing", category: "free_text", expected: "present" }] });
  const unknownReceipt = checked(draft(unknownSource), unknownSource);
  assert.ok(codes(unknownReceipt).includes("REQUIREMENT_MAPPING_INVALID"));
});

test("design-form review is source-fenced and required before acceptance", () => {
  const source = makeS6Source();
  const model = draft(source);
  const receipt = checked(model, source);
  assert.equal(receipt.outcome, "acceptance_blocked");
  assert.ok(codes(receipt).includes("S6_DESIGN_FORM_UNREVIEWED"));
  const staleReview = clone(model);
  staleReview.designFormReview.evidenceAssetId = "30000000-0000-4000-8000-000000000007";
  assert.ok(codes(checked(staleReview, source)).includes("S6_DESIGN_FORM_UNREVIEWED"));
});

test("unsupported form returns S6_UNSUPPORTED_FORM without a box", () => {
  const source = representativeSources()["unsupported-form-fails-closed"]!;
  const model = draft(source);
  assert.equal(model.objects.some((item) => item.objectType === "box"), false);
  assert.ok(codes(checked(model, source)).includes("S6_UNSUPPORTED_FORM"));
});

test("unresolved geometry persists as a draft but blocks acceptance and final render", () => {
  const source = makeS6Source();
  const model = draft(source);
  const receipt = checked(model, source);
  assert.equal(model.status, "generated_draft");
  assert.ok(codes(receipt).includes("GEOMETRY_UNRESOLVED") || codes(receipt).includes("S6_DESIGN_FORM_UNREVIEWED"));
  assert.equal(receipt.outcome, "acceptance_blocked");
});

test("meaningful physical collisions fail while floor and zone contact is allowed", () => {
  const source = makeS6Source();
  const model = clone(draft(source));
  const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "zone" && item.role !== "booth_wall");
  assert.ok(physical[0] && physical[1]);
  physical[1]!.transform.positionMm = structuredClone(physical[0]!.transform.positionMm);
  const collision = checked(model, source);
  assert.ok(codes(collision).includes("MATERIAL_COLLISION"));
  const contact = clone(draft(source));
  const floor = contact.objects.find((item) => item.role === "booth_floor");
  assert.ok(floor);
  const first = firstPhysicalObject(contact);
  first.transform.positionMm.yMm = 1;
  assert.equal(codes(checked(contact, source)).includes("MATERIAL_COLLISION"), false);
});

test("camera and canonical hash failures are reported", () => {
  const source = makeS6Source();
  const model = clone(draft(source));
  assert.ok(codes(checked(model, source)).includes("CAMERA_INVALID"));
  const hashBroken = clone(model);
  hashBroken.modelHash = "f".repeat(64);
  const receipt = checked(hashBroken, source);
  assert.ok(codes(receipt).includes("CANONICAL_HASH_MISMATCH"));
  assert.equal(JSON.stringify(receipt).includes(source.canonicalRequirements[0]!.text), false);
});

test("warnings do not become fabricated zero values", () => {
  const source = makeS6Source({ maxHeightMm: null });
  const model = draft(source);
  assert.equal(model.booth.maxHeightMm, null);
  assert.equal(model.assumptions[0]?.value.includes("derived render height"), true);
  assert.equal(model.assumptions[0]?.acceptedByUser, false);
});
