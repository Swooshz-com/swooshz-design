import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildS6Cameras, hashS6Camera } from "../src/lib/s6-camera";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { canonicalS6Json, containsS6WorldGeometry, deriveS6WorldGeometry, hashS6Model, type S6WorldGeometry } from "../src/lib/s6-canonical";
import { evaluateS6Requirements, validateS6Model } from "../src/lib/s6-validation";
import { s6SourceFingerprint } from "../src/lib/s6-source";
import { sha256 } from "../src/lib/utils";
import {
  deterministicClock,
  deterministicRevisionId,
  makeS6Source,
  representativeSources,
} from "./s6-fixture";
import type { S2Requirement, S5ToS6Projection, S6SpatialModelRecord } from "../src/lib/types";

type CeilingFixtureOptions = {
  objectType?: S6SpatialModelRecord["objects"][number]["objectType"];
  role?: S6SpatialModelRecord["objects"][number]["role"];
  label?: string;
  requirementIds?: S6SpatialModelRecord["objects"][number]["requirementIds"];
  parentObjectId?: S6SpatialModelRecord["objects"][number]["parentObjectId"];
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  xMm?: number;
  yMm?: number;
  zMm?: number;
};

function ceilingSource(): S5ToS6Projection {
  return makeS6Source({
    widthMm: 6000,
    depthMm: 3000,
    openSides: ["north", "east", "south", "west"],
    maxHeightMm: 3000,
    requirements: [
      { name: "Table", category: "functional", expected: "present" },
      { name: "Display plinth", category: "functional", expected: "present" },
      { name: "Keep the entry clear.", category: "mandatory", expected: "present" },
      { name: "No enclosed ceiling.", category: "prohibited", expected: "absent" },
    ],
  });
}

function addCeilingSolid(model: S6SpatialModelRecord, id: number, options: CeilingFixtureOptions = {}): S6SpatialModelRecord["objects"][number] {
  const template = model.objects.find((object) => object.objectType === "table" && object.primitive.kind === "rect_prism");
  assert.ok(template, "the ceiling fixture needs an existing rectangular table as a typed object template");
  const object = structuredClone(template);
  object.objectId = deterministicRevisionId(id);
  object.identityKey = "attempt-2-fixture-object-" + String(id);
  object.objectType = options.objectType ?? "table";
  object.role = options.role ?? "furniture";
  object.label = options.label ?? "Added rectangular object";
  object.parentObjectId = options.parentObjectId ?? null;
  object.primitive = {
    kind: "rect_prism",
    dimensionsMm: {
      widthMm: options.widthMm ?? 6000,
      depthMm: options.depthMm ?? 3000,
      heightMm: options.heightMm ?? 50,
    },
    geometryState: "exact",
    localAnchor: "floor",
  };
  object.transform = {
    positionMm: { xMm: options.xMm ?? 0, yMm: options.yMm ?? 2800, zMm: options.zMm ?? 0 },
    rotationMd: { xMd: 0, yMd: 0, zMd: 0 },
  };
  object.requirementIds = [...(options.requirementIds ?? [])];
  object.zoneIds = [];
  object.unknownIds = [];
  model.objects.push(object);
  return object;
}

function ceilingRequirement(source: S5ToS6Projection): S2Requirement {
  const requirement = source.canonicalRequirements.find((item) => item.category === "prohibited");
  assert.ok(requirement, "the ceiling test source must retain its canonical prohibition");
  return requirement;
}

function requirementEvaluation(model: S6SpatialModelRecord, source: S5ToS6Projection, requirement: S2Requirement) {
  const result = evaluateS6Requirements(model, source).find((item) => item.requirementId === requirement.requirementId);
  assert.ok(result, "the shared evaluator must return the requested canonical requirement");
  return result;
}

function draft(source: S5ToS6Projection = makeS6Source(), revision = 1): S6SpatialModelRecord {
  return compileS6Draft({ source, revisionId: deterministicRevisionId(revision), parentRevisionId: null, clock: deterministicClock() });
}

function checked(model: S6SpatialModelRecord, source: S5ToS6Projection): ReturnType<typeof validateS6Model> {
  return validateS6Model(model, { source, priorModels: [], expectedSourceFingerprint: source.sourceFingerprint });
}

function clone(model: S6SpatialModelRecord): S6SpatialModelRecord {
  return structuredClone(model);
}

function refreshModelHash(model: S6SpatialModelRecord): void {
  const hashed = hashS6Model(model);
  model.modelHash = hashed.modelHash;
  model.canonicalByteSize = hashed.canonicalByteSize;
}

function withRequirements(source: S5ToS6Projection, requirements: S2Requirement[]): S5ToS6Projection {
  source.canonicalRequirements = requirements;
  source.requirementHash = sha256(new TextEncoder().encode(canonicalS6Json({ schemaVersion: "s2-requirements-v1", requirements })));
  source.sourceFingerprint = s6SourceFingerprint(source);
  return source;
}

function canonicalCameraModel(source: S5ToS6Projection): S6SpatialModelRecord {
  const model = clone(draft(source));
  model.cameras = buildS6Cameras(model);
  refreshModelHash(model);
  return model;
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

test("booth envelope and floor dimensions stay bound to the confirmed S5 geometry", () => {
  const source = makeS6Source({ widthMm: 6400, depthMm: 3200 });
  const mismatchedEnvelope = clone(draft(source));
  mismatchedEnvelope.booth.widthMm -= 1;
  mismatchedEnvelope.booth.depthMm += 1;
  const envelopeCodes = codes(checked(mismatchedEnvelope, source));
  assert.ok(envelopeCodes.includes("BOOTH_ENVELOPE_INVALID"));

  const mismatchedFloor = clone(draft(source));
  const floor = mismatchedFloor.objects.find((item) => item.role === "booth_floor");
  assert.ok(floor && floor.primitive.kind === "rect_prism");
  if (floor?.primitive.kind === "rect_prism") floor.primitive.dimensionsMm.widthMm -= 1;
  assert.ok(codes(checked(mismatchedFloor, source)).includes("BOOTH_ENVELOPE_INVALID"));
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

test("product demonstration details remain supported for a confirmed exact table count", () => {
  const source = makeS6Source({ requirements: [{ name: "Demo table", details: "Product demonstration", expected: "exact_count", expectedCount: 2 }] });
  const model = draft(source);
  const result = evaluateS6Requirements(model, source)[0];
  assert.equal(result?.outcome, "satisfied");
  assert.equal(result?.objectIds.length, 2);
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

test("hierarchy-aware containment uses the transformed parent shape", () => {
  const source = makeS6Source({
    widthMm: 8000,
    depthMm: 5000,
    requirements: [
      { name: "Welcome counter", expected: "present" },
      { name: "Demo table", expected: "present" },
    ],
  });
  const model = clone(draft(source));
  const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
  assert.ok(physical[0] && physical[1]);
  const parent = physical[0]!;
  const child = physical[1]!;
  parent.primitive = { kind: "rect_prism", dimensionsMm: { widthMm: 2200, depthMm: 1000, heightMm: 1000 }, geometryState: "exact", localAnchor: "floor" };
  parent.transform = { positionMm: { xMm: 1500, yMm: 0, zMm: 500 }, rotationMd: { xMd: 0, yMd: 45_000, zMd: 0 } };
  child.primitive = { kind: "rect_prism", dimensionsMm: { widthMm: 500, depthMm: 300, heightMm: 500 }, geometryState: "exact", localAnchor: "floor" };
  child.parentObjectId = parent.objectId;
  child.transform = { positionMm: { xMm: 500, yMm: 0, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } };
  const receipt = checked(model, source);
  assert.equal(receipt.errors.some((item) => item.code === "CONTAINMENT_INVALID" && item.objectId === child.objectId), false);
});

test("exact union containment rejects a narrow concave notch and preserves valid union coverage", () => {
  const source = makeS6Source({ widthMm: 6000, depthMm: 5000 });
  const makeNotchModel = (childX: number): { model: S6SpatialModelRecord; parentId: string; childId: string } => {
    const model = clone(draft(source));
    const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
    assert.ok(physical[0] && physical[1]);
    const parent = physical[0]!;
    const child = physical[1]!;
    parent.primitive = {
      kind: "profile_extrusion",
      profile: {
        winding: "ccw-from-positive-y-v1",
        vertices: [
          { xMm: 0, zMm: 0 },
          { xMm: 1950, zMm: 0 },
          { xMm: 1950, zMm: 2000 },
          { xMm: 2050, zMm: 2000 },
          { xMm: 2050, zMm: 0 },
          { xMm: 4000, zMm: 0 },
          { xMm: 4000, zMm: 3000 },
          { xMm: 0, zMm: 3000 },
        ],
      },
      heightMm: 1000,
      geometryState: "exact",
      localAnchor: "floor",
    };
    parent.transform = { positionMm: { xMm: 500, yMm: 0, zMm: 500 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } };
    child.primitive = { kind: "rect_prism", dimensionsMm: { widthMm: 100, depthMm: 500, heightMm: 500 }, geometryState: "exact", localAnchor: "floor" };
    child.parentObjectId = parent.objectId;
    child.transform = { positionMm: { xMm: childX, yMm: 100, zMm: 1900 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } };
    refreshModelHash(model);
    return { model, parentId: parent.objectId, childId: child.objectId };
  };

  const invalid = makeNotchModel(1950);
  const invalidWorld = deriveS6WorldGeometry(invalid.model);
  const invalidParent = invalidWorld.find((item) => item.objectId === invalid.parentId)!;
  const invalidChild = invalidWorld.find((item) => item.objectId === invalid.childId)!;
  assert.equal(containsS6WorldGeometry(invalidParent, invalidChild), false);
  const invalidReceipt = checked(invalid.model, source);
  assert.equal(invalidReceipt.errors.some((item) => item.code === "CONTAINMENT_INVALID" && item.objectId === invalid.childId), true);

  const validNearNotch = makeNotchModel(1800);
  const validNearWorld = deriveS6WorldGeometry(validNearNotch.model);
  const validNearParent = validNearWorld.find((item) => item.objectId === validNearNotch.parentId)!;
  const validNearChild = validNearWorld.find((item) => item.objectId === validNearNotch.childId)!;
  assert.equal(containsS6WorldGeometry(validNearParent, validNearChild), true);
  assert.equal(codes(checked(validNearNotch.model, source)).some((code) => code === "CONTAINMENT_INVALID"), false);

  const rectangle = (left: number, right: number): S6WorldGeometry["parts"][number] => ({
    kind: "polygon",
    points: [{ xMm: left, zMm: 0 }, { xMm: right, zMm: 0 }, { xMm: right, zMm: 1000 }, { xMm: left, zMm: 1000 }],
  });
  const unionParts = [rectangle(0, 1020), rectangle(1030, 2000)];
  const unionOuter: S6WorldGeometry = {
    objectId: "union-parent",
    points: [],
    footprint: unionParts[0]!,
    parts: unionParts,
    boundsMm: { min: { xMm: 0, yMm: 0, zMm: 0 }, max: { xMm: 2000, yMm: 1000, zMm: 1000 } },
    verticalInterval: { base: 0, top: 1000 },
  };
  const spanningChildPart = rectangle(0, 2000);
  const spanningChild: S6WorldGeometry = {
    objectId: "union-child",
    points: [],
    footprint: spanningChildPart,
    parts: [spanningChildPart],
    boundsMm: { min: { xMm: 0, yMm: 0, zMm: 0 }, max: { xMm: 2000, yMm: 500, zMm: 1000 } },
    verticalInterval: { base: 0, top: 500 },
  };
  assert.equal(containsS6WorldGeometry(unionOuter, spanningChild), false);

  const seamOuterParts = [rectangle(0, 1000), rectangle(1000, 2000)];
  const seamOuter = { ...unionOuter, objectId: "seam-parent", footprint: seamOuterParts[0]!, parts: seamOuterParts };
  const seamChildPart = rectangle(900, 1100);
  const seamChild = { ...spanningChild, objectId: "seam-child", footprint: seamChildPart, parts: [seamChildPart] };
  assert.equal(containsS6WorldGeometry(seamOuter, seamChild), true);

  const rectangleOuterPart = rectangle(0, 2000);
  const rectangleOuter: S6WorldGeometry = { ...unionOuter, objectId: "rectangle-parent", footprint: rectangleOuterPart, parts: [rectangleOuterPart] };
  const circleInsidePart: S6WorldGeometry["parts"][number] = { kind: "circle", center: { xMm: 1000, zMm: 500 }, radiusMm: 200 };
  const circleInside: S6WorldGeometry = { ...spanningChild, objectId: "circle-child", footprint: circleInsidePart, parts: [circleInsidePart] };
  assert.equal(containsS6WorldGeometry(rectangleOuter, circleInside), true);

  const circleOuterPart: S6WorldGeometry["parts"][number] = { kind: "circle", center: { xMm: 1000, zMm: 500 }, radiusMm: 1000 };
  const circleOuter: S6WorldGeometry = { ...unionOuter, objectId: "round-parent", footprint: circleOuterPart, parts: [circleOuterPart] };
  const polygonInsidePart = rectangle(900, 1100);
  const polygonInside: S6WorldGeometry = { ...spanningChild, objectId: "polygon-child", footprint: polygonInsidePart, parts: [polygonInsidePart] };
  assert.equal(containsS6WorldGeometry(circleOuter, polygonInside), true);
});

test("shape-aware collision rejects separated 45-degree strips despite overlapping AABBs", () => {
  const source = makeS6Source({
    widthMm: 8000,
    depthMm: 5000,
    requirements: [
      { name: "Welcome counter", expected: "present" },
      { name: "Demo table", expected: "present" },
    ],
  });
  const makeStrips = (secondPosition: { xMm: number; zMm: number }): S6SpatialModelRecord => {
    const model = clone(draft(source));
    const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
    assert.ok(physical[0] && physical[1]);
    const primitive = { kind: "rect_prism" as const, dimensionsMm: { widthMm: 3000, depthMm: 100, heightMm: 500 }, geometryState: "exact" as const, localAnchor: "floor" as const };
    physical[0]!.primitive = primitive;
    physical[0]!.transform = { positionMm: { xMm: 1000, yMm: 0, zMm: 1000 }, rotationMd: { xMd: 0, yMd: 45_000, zMd: 0 } };
    physical[1]!.primitive = structuredClone(primitive);
    physical[1]!.transform = { positionMm: { xMm: secondPosition.xMm, yMm: 0, zMm: secondPosition.zMm }, rotationMd: { xMd: 0, yMd: 45_000, zMd: 0 } };
    return model;
  };
  const separated = checked(makeStrips({ xMm: 1106, zMm: 1106 }), source);
  assert.equal(separated.errors.some((item) => item.code === "MATERIAL_COLLISION"), false);
  const overlapping = checked(makeStrips({ xMm: 1035, zMm: 1035 }), source);
  assert.equal(overlapping.errors.some((item) => item.code === "MATERIAL_COLLISION"), true);
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

test("canonical cameras pass exact validation and recomputed noncanonical cameras are rejected", () => {
  const source = makeS6Source();
  const model = canonicalCameraModel(source);
  assert.deepEqual(model.cameras, buildS6Cameras(model));
  assert.equal(codes(checked(model, source)).includes("CAMERA_INVALID"), false);

  const mutations: Array<{ label: string; viewId: S6SpatialModelRecord["cameras"][number]["viewId"]; mutate: (camera: S6SpatialModelRecord["cameras"][number]) => void }> = [
    { label: "position", viewId: "perspective-northwest", mutate: (camera) => { camera.positionMm.xMm += 1; } },
    { label: "target", viewId: "perspective-northwest", mutate: (camera) => { camera.targetMm.xMm += 1; } },
    { label: "up", viewId: "perspective-northwest", mutate: (camera) => { camera.up = "negative-world-z"; } },
    { label: "perspective FOV", viewId: "perspective-northwest", mutate: (camera) => { camera.fovMd = (camera.fovMd ?? 0) + 1; } },
    { label: "orthographic scale", viewId: "top-orthographic", mutate: (camera) => { camera.orthoScaleMm = (camera.orthoScaleMm ?? 0) + 1; } },
    { label: "near plane", viewId: "perspective-northwest", mutate: (camera) => { camera.nearMm += 1; } },
    { label: "far plane", viewId: "perspective-northwest", mutate: (camera) => { camera.farMm += 1; } },
  ];

  for (const mutation of mutations) {
    const candidate = canonicalCameraModel(source);
    const camera = candidate.cameras.find((item) => item.viewId === mutation.viewId);
    assert.ok(camera, mutation.label);
    mutation.mutate(camera);
    camera.cameraHash = hashS6Camera(camera);
    refreshModelHash(candidate);
    assert.ok(codes(checked(candidate, source)).includes("CAMERA_INVALID"), mutation.label);
  }
});

test("warnings do not become fabricated zero values", () => {
  const source = makeS6Source({ maxHeightMm: null });
  const model = draft(source);
  assert.equal(model.booth.maxHeightMm, null);
  assert.equal(model.assumptions[0]?.value.includes("derived render height"), true);
  assert.equal(model.assumptions[0]?.acceptedByUser, false);
});

test("four canonical geometry requirements use exact booth evidence without object mappings", () => {
  const source = makeS6Source({ requirements: [] });
  const requirements: S2Requirement[] = [
    { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.widthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth width" },
    { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.depthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth depth" },
    { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.openSides.slice().reverse().join(","), criticality: "material", source: "geometry_snapshot", text: "Confirmed open sides" },
    { requirementId: "geometry.max-height", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.maxHeightMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed maximum height" },
  ];
  withRequirements(source, requirements);
  const model = draft(source);
  const results = evaluateS6Requirements(model, source);
  assert.deepEqual(results.map((item) => item.outcome), ["satisfied", "satisfied", "satisfied", "satisfied"]);
  assert.ok(results.every((item) => item.objectIds.length === 0 && item.evidenceKind === "booth_fields" && item.sourceFingerprint === source.sourceFingerprint));
  assert.equal(model.objects.some((object) => object.requirementIds.some((id) => id.startsWith("geometry.") || id === "access.open-sides")), false);
  assert.equal(model.unknowns.some((unknown) => unknown.kind === "requirement_mapping"), false);

  const widthMismatch = clone(model);
  widthMismatch.booth.widthMm -= 1;
  assert.equal(evaluateS6Requirements(widthMismatch, source).find((item) => item.requirementId === "geometry.width")?.outcome, "unsatisfied");
  const depthMismatch = clone(model);
  depthMismatch.booth.depthMm -= 1;
  assert.equal(evaluateS6Requirements(depthMismatch, source).find((item) => item.requirementId === "geometry.depth")?.outcome, "unsatisfied");
  const floorMismatch = clone(model);
  const floor = floorMismatch.objects.find((object) => object.role === "booth_floor");
  assert.ok(floor?.primitive.kind === "rect_prism");
  if (floor?.primitive.kind === "rect_prism") floor.primitive.dimensionsMm.widthMm -= 1;
  assert.equal(evaluateS6Requirements(floorMismatch, source).find((item) => item.requirementId === "geometry.width")?.outcome, "unsatisfied");
  const transformedFloor = clone(model);
  const movedFloor = transformedFloor.objects.find((object) => object.role === "booth_floor");
  assert.ok(movedFloor);
  movedFloor.transform.positionMm.xMm += 1;
  assert.equal(evaluateS6Requirements(transformedFloor, source).find((item) => item.requirementId === "geometry.width")?.outcome, "unsatisfied");
  const rotatedFloor = clone(model);
  const rotatedFloorObject = rotatedFloor.objects.find((object) => object.role === "booth_floor");
  assert.ok(rotatedFloorObject);
  rotatedFloorObject.transform.rotationMd.yMd = 1000;
  assert.equal(evaluateS6Requirements(rotatedFloor, source).find((item) => item.requirementId === "geometry.width")?.outcome, "unsatisfied");
  const sidesMismatch = clone(model);
  sidesMismatch.booth.openSides = ["east", "north"];
  assert.equal(evaluateS6Requirements(sidesMismatch, source).find((item) => item.requirementId === "access.open-sides")?.outcome, "unsatisfied");
  const tooTall = clone(model);
  const wall = tooTall.objects.find((object) => object.role === "booth_wall");
  assert.ok(wall);
  if (wall?.primitive.kind === "rect_prism") wall.primitive.dimensionsMm.heightMm += 1;
  else if (wall?.primitive.kind === "round_prism") wall.primitive.heightMm += 1;
  else if (wall) wall.primitive.heightMm += 1;
  assert.equal(evaluateS6Requirements(tooTall, source).find((item) => item.requirementId === "geometry.max-height")?.issueCodes.includes("MAX_HEIGHT_EXCEEDED"), true);

  const invalidSideSource = makeS6Source({ requirements: [] });
  const invalidSideRequirements = requirements.map((item) => ({ ...item, expectedValue: item.requirementId === "access.open-sides" ? "NORTH,east" : item.expectedValue }));
  withRequirements(invalidSideSource, invalidSideRequirements);
  const invalidSideResult = evaluateS6Requirements(draft(invalidSideSource), invalidSideSource).find((item) => item.requirementId === "access.open-sides");
  assert.equal(invalidSideResult?.outcome, "unsatisfied", "open-side token casing is exact");

  const heightSource = makeS6Source({ requirements: [] });
  const heightRequirements = requirements.map((item) => ({ ...item, expectedValue: item.requirementId === "geometry.max-height" ? Number(item.expectedValue) + 1 : item.expectedValue }));
  withRequirements(heightSource, heightRequirements);
  assert.equal(evaluateS6Requirements(draft(heightSource), heightSource).find((item) => item.requirementId === "geometry.max-height")?.outcome, "unsatisfied");
});

test("unknown height remains unknown and is never promoted from the render assumption", () => {
  const source = makeS6Source({ maxHeightMm: null, requirements: [] });
  const requirements: S2Requirement[] = [
    { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.widthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth width" },
    { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.depthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth depth" },
    { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null, expectedValue: source.geometrySnapshot.openSides.join(","), criticality: "material", source: "geometry_snapshot", text: "Confirmed open sides" },
  ];
  withRequirements(source, requirements);
  const model = draft(source);
  assert.equal(model.booth.maxHeightMm, null);
  assert.equal(model.booth.heightState, "unknown");
  assert.ok(model.assumptions.some((item) => item.fieldPath === "booth.maxHeightMm" && item.value.includes("derived render height")));
  assert.deepEqual(evaluateS6Requirements(model, source).map((item) => item.outcome), ["satisfied", "satisfied", "satisfied"]);
});

test("object requirements count compatible distinct allocations and reject extras or wrong families", () => {
  const presentSource = makeS6Source({ requirements: [{ name: "Welcome counter", expected: "present" }] });
  const presentModel = draft(presentSource);
  const counter = presentModel.objects.find((object) => object.objectType === "counter");
  assert.ok(counter);
  const extraCounter = structuredClone(counter);
  extraCounter.objectId += "-second";
  extraCounter.identityKey += ":second";
  extraCounter.transform.positionMm.xMm += 1800;
  presentModel.objects.push(extraCounter);
  assert.equal(evaluateS6Requirements(presentModel, presentSource)[0]?.outcome, "satisfied");

  const exactSource = makeS6Source({ requirements: [{ name: "Demo table", expected: "exact_count", expectedCount: 2 }] });
  const exactModel = draft(exactSource);
  assert.equal(evaluateS6Requirements(exactModel, exactSource)[0]?.outcome, "satisfied");
  const oneExtraAllocated = structuredClone(exactModel);
  const allocatedTable = oneExtraAllocated.objects.find((object) => object.objectType === "table");
  assert.ok(allocatedTable);
  const extraAllocatedTable = structuredClone(allocatedTable);
  extraAllocatedTable.objectId += "-allocated-extra";
  extraAllocatedTable.identityKey += ":allocated-extra";
  extraAllocatedTable.transform.positionMm.xMm = 4000;
  extraAllocatedTable.transform.positionMm.zMm = 2200;
  oneExtraAllocated.objects.push(extraAllocatedTable);
  assert.equal(evaluateS6Requirements(oneExtraAllocated, exactSource)[0]?.outcome, "unsatisfied", "N+1 allocated objects fail an exact count");

  const duplicateAllocation = structuredClone(exactModel);
  const duplicateTable = duplicateAllocation.objects.find((object) => object.objectType === "table");
  assert.ok(duplicateTable);
  duplicateTable.requirementIds.push(exactSource.canonicalRequirements[0]!.requirementId);
  assert.equal(evaluateS6Requirements(duplicateAllocation, exactSource)[0]?.outcome, "unsatisfied", "duplicate requirement IDs do not create a second allocation");
  const oneMissing = structuredClone(exactModel);
  const table = oneMissing.objects.find((object) => object.objectType === "table");
  assert.ok(table);
  oneMissing.objects = oneMissing.objects.filter((object) => object.objectId !== table.objectId);
  assert.equal(evaluateS6Requirements(oneMissing, exactSource)[0]?.outcome, "unsatisfied");

  const emptyPresentSource = makeS6Source({ requirements: [{ name: "Demo table", expected: "present" }] });
  const emptyPresentModel = draft(emptyPresentSource);
  emptyPresentModel.objects = emptyPresentModel.objects.filter((object) => object.objectType !== "table");
  assert.equal(evaluateS6Requirements(emptyPresentModel, emptyPresentSource)[0]?.outcome, "unsatisfied", "present requires at least one compatible object");

  const unallocatedExtra = structuredClone(exactModel);
  const original = unallocatedExtra.objects.find((object) => object.objectType === "table");
  assert.ok(original);
  const unallocated = structuredClone(original);
  unallocated.objectId += "-unallocated";
  unallocated.identityKey += ":unallocated";
  unallocated.requirementIds = [];
  unallocated.transform.positionMm.xMm = 4000;
  unallocated.transform.positionMm.zMm = 2200;
  unallocatedExtra.objects.push(unallocated);
  assert.equal(evaluateS6Requirements(unallocatedExtra, exactSource)[0]?.outcome, "unsatisfied");

  const wrongFamily = structuredClone(exactModel);
  const mappedTable = wrongFamily.objects.find((object) => object.objectType === "table");
  assert.ok(mappedTable);
  mappedTable.objectType = "box";
  const wrongResult = evaluateS6Requirements(wrongFamily, exactSource)[0];
  assert.equal(wrongResult?.outcome, "unsatisfied");
  assert.ok(wrongResult?.issueCodes.includes("REQUIREMENT_OBJECT_INCOMPATIBLE"));

  const rectangularSource = makeS6Source({ requirements: [{ name: "Rectangular table", expected: "present" }] });
  const rectangularModel = draft(rectangularSource);
  const rectangularTable = rectangularModel.objects.find((object) => object.objectType === "table");
  assert.ok(rectangularTable?.primitive.kind === "rect_prism");
  if (rectangularTable) {
    rectangularTable.primitive = { kind: "round_prism", radiusMm: 500, heightMm: 700, geometryState: "bounded_inference", localAnchor: "floor" };
    assert.equal(evaluateS6Requirements(rectangularModel, rectangularSource)[0]?.outcome, "unsatisfied", "a round object cannot satisfy a rectangular qualifier");
  }

  const zeroWithCounterSource = makeS6Source({ requirements: [
    { name: "No table", expected: "exact_count", expectedCount: 0 },
    { name: "Welcome counter", expected: "present" },
  ] });
  const zeroWithCounterModel = draft(zeroWithCounterSource);
  const zeroTableResult = evaluateS6Requirements(zeroWithCounterModel, zeroWithCounterSource)[0];
  assert.equal(zeroTableResult?.outcome, "satisfied", "a counter sharing the furniture role is not a table");

  const zeroWithTableSource = makeS6Source({ requirements: [
    { name: "No table", expected: "exact_count", expectedCount: 0 },
    { name: "Demo table", expected: "present" },
  ] });
  const zeroWithTableModel = draft(zeroWithTableSource);
  assert.equal(evaluateS6Requirements(zeroWithTableModel, zeroWithTableSource)[0]?.outcome, "unsatisfied", "exact_count zero checks the complete scene");

  const sharedSource = makeS6Source({ requirements: [
    { name: "Welcome counter", expected: "present" },
    { name: "Reception counter", expected: "present" },
  ] });
  const sharedModel = draft(sharedSource);
  const sharedObject = sharedModel.objects.find((object) => object.objectType === "counter" && object.requirementIds.includes(sharedSource.canonicalRequirements[0]!.requirementId));
  const otherObject = sharedModel.objects.find((object) => object.objectType === "counter" && object.requirementIds.includes(sharedSource.canonicalRequirements[1]!.requirementId));
  assert.ok(sharedObject && otherObject);
  sharedObject.requirementIds.push(sharedSource.canonicalRequirements[1]!.requirementId);
  sharedModel.objects = sharedModel.objects.filter((object) => object.objectId !== otherObject.objectId);
  assert.ok(evaluateS6Requirements(sharedModel, sharedSource).every((item) => item.outcome === "unsatisfied"), "one object cannot satisfy two distinct functional requirements without explicit sharing");

  const sharedQualifierSource = makeS6Source({ requirements: [
    { name: "Shared welcome counter", expected: "present" },
  ] });
  assert.equal(evaluateS6Requirements(draft(sharedQualifierSource), sharedQualifierSource)[0]?.outcome, "unresolved", "an unbounded shared qualifier cannot be dropped");
});

test("entry clearance uses complete world geometry, including children, and ignores confirmation notes", () => {
  const source = makeS6Source({ requirements: [
    { name: "Keep the entry clear", category: "mandatory", expected: "present" },
    { name: "Welcome counter", expected: "present" },
    { name: "Demo table", expected: "present" },
  ] });
  const model = draft(source);
  const table = model.objects.find((object) => object.objectType === "table");
  assert.ok(table);
  table.transform.positionMm = { xMm: 2500, yMm: 0, zMm: 1200 };
  const entryResult = () => evaluateS6Requirements(model, source).find((item) => item.requirementId === source.canonicalRequirements[0]!.requirementId)!;
  assert.equal(entryResult().outcome, "satisfied");
  assert.equal(entryResult().predicateVersion, "entry-clear-v1");
  assert.deepEqual(entryResult().boothFields.sort(), ["booth.depthMm", "booth.openSides", "booth.widthMm", "objects.transform"]);
  assert.equal(entryResult().objectIds.length, 0);

  const counter = model.objects.find((object) => object.objectType === "counter");
  assert.ok(counter);
  counter.transform.positionMm = { xMm: 2500, yMm: 0, zMm: 0 };
  const blocked = entryResult();
  assert.equal(blocked.outcome, "unsatisfied");
  assert.ok(blocked.issueCodes.includes("ENTRY_CLEARANCE_BLOCKED"));
  assert.ok(blocked.objectIds.includes(counter.objectId));

  counter.transform.positionMm = { xMm: 2500, yMm: 0, zMm: 1000 };
  table.parentObjectId = counter.objectId;
  table.transform.positionMm = { xMm: 0, yMm: 0, zMm: -1000 };
  assert.ok(entryResult().objectIds.includes(table.objectId), "child obstruction is measured in world coordinates");

  const unknown = model.unknowns[0];
  if (unknown) {
    unknown.status = "resolved";
    unknown.resolutionKind = "represented";
    unknown.resolutionNote = "Confirmed clear by note only.";
    unknown.resolvedBy = "user";
    unknown.resolvedAt = "2026-09-02T00:00:00.000Z";
  }
  assert.equal(entryResult().outcome, "unsatisfied");
});

test("prohibited families are checked scene-wide and ceiling absence stays geometry-derived", () => {
  const screenSource = makeS6Source({ requirements: [
    { name: "No screen", category: "prohibited", expected: "absent" },
    { name: "Product screen", category: "functional", expected: "present" },
  ] });
  const screenModel = draft(screenSource);
  const screenResult = evaluateS6Requirements(screenModel, screenSource).find((item) => item.requirementId === screenSource.canonicalRequirements[0]!.requirementId);
  assert.equal(screenResult?.outcome, "unsatisfied");
  assert.ok(screenResult?.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));

  const ceilingSource = makeS6Source({ requirements: [
    { name: "No enclosed ceiling", category: "prohibited", expected: "absent" },
    { name: "Welcome counter", expected: "present" },
  ] });
  const ceilingModel = draft(ceilingSource);
  const ceilingId = ceilingSource.canonicalRequirements[0]!.requirementId;
  assert.equal(evaluateS6Requirements(ceilingModel, ceilingSource).find((item) => item.requirementId === ceilingId)?.outcome, "satisfied");
  const counter = ceilingModel.objects.find((object) => object.objectType === "counter");
  if (counter) {
    counter.objectType = "box";
    counter.label = "Raised generic object";
    counter.transform.positionMm.yMm = 100;
    const geometryResult = evaluateS6Requirements(ceilingModel, ceilingSource).find((item) => item.requirementId === ceilingId);
    assert.equal(geometryResult?.outcome, "satisfied", "type and label cannot override the certified geometry result");
    const note = ceilingModel.unknowns[0];
    if (note) {
      note.status = "resolved";
      note.resolutionKind = "represented";
      note.resolutionNote = "No ceiling is present.";
      note.resolvedBy = "user";
      note.resolvedAt = "2026-09-02T00:00:00.000Z";
    }
    assert.equal(evaluateS6Requirements(ceilingModel, ceilingSource).find((item) => item.requirementId === ceilingId)?.outcome, "satisfied");
  }
});

test("Run-140 rejects the exact neutral-label full-booth ceiling from world geometry", () => {
  const source = ceilingSource();
  const model = canonicalCameraModel(source);
  const table = model.objects.find((object) => object.objectType === "table");
  assert.ok(table, "the confirmed table must remain in the fixture");
  table.transform.positionMm = { xMm: 1000, yMm: 0, zMm: 1200 };
  const ceiling = ceilingRequirement(source);
  const tableRequirement = source.canonicalRequirements.find((item) => item.text === "Table");
  const entryRequirement = source.canonicalRequirements.find((item) => item.text === "Keep the entry clear.");
  assert.ok(tableRequirement && entryRequirement);
  assert.equal(requirementEvaluation(model, source, ceiling).outcome, "satisfied", "a normal floor-anchored table is not a ceiling");
  assert.equal(requirementEvaluation(model, source, tableRequirement).outcome, "satisfied");
  assert.equal(requirementEvaluation(model, source, entryRequirement).outcome, "satisfied");

  const slab = addCeilingSolid(model, 901, {
    objectType: "table",
    role: "furniture",
    label: "Added rectangular object",
    widthMm: 6000,
    depthMm: 3000,
    heightMm: 50,
    xMm: 0,
    yMm: 2800,
    zMm: 0,
    requirementIds: [],
  });
  model.cameras = buildS6Cameras(model);
  refreshModelHash(model);

  const evaluation = requirementEvaluation(model, source, ceiling);
  assert.equal(evaluation.outcome, "unsatisfied");
  assert.ok(evaluation.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
  assert.ok(evaluation.objectIds.includes(slab.objectId));
  assert.equal(requirementEvaluation(model, source, entryRequirement).outcome, "satisfied", "the slab is above entry-clear-v1 height");

  const receipt = checked(model, source);
  assert.equal(receipt.validatorVersion, "s6-validator-v2");
  assert.equal(receipt.outcome, "acceptance_blocked");
  assert.ok(receipt.errors.some((item) => item.requirementId === ceiling.requirementId && item.code === "PROHIBITED_CONTENT_PRESENT"));
  assert.equal(receipt.errors.some((item) => item.requirementId === entryRequirement.requirementId), false);
});

test("Run-140 ceiling geometry cannot be bypassed by allowlisted metadata or requirement tags", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);
  const tableRequirement = source.canonicalRequirements.find((item) => item.text === "Table");
  const displayRequirement = source.canonicalRequirements.find((item) => item.text === "Display plinth");
  assert.ok(tableRequirement && displayRequirement);
  const variants: Array<{ id: number; options: CeilingFixtureOptions }> = [
    { id: 911, options: { objectType: "table", role: "furniture", label: "Neutral fixture", requirementIds: [] } },
    { id: 912, options: { objectType: "table", role: "furniture", label: "Rental item", requirementIds: [tableRequirement.requirementId] } },
    { id: 913, options: { objectType: "display_plinth", role: "display", label: "Exhibit support", requirementIds: [displayRequirement.requirementId] } },
  ];

  for (const variant of variants) {
    const model = clone(draft(source));
    const slab = addCeilingSolid(model, variant.id, {
      ...variant.options,
      widthMm: 6000,
      depthMm: 3000,
      heightMm: 50,
      xMm: 0,
      yMm: 2800,
      zMm: 0,
    });
    const evaluation = requirementEvaluation(model, source, ceiling);
    assert.equal(evaluation.outcome, "unsatisfied", `metadata variant ${variant.id} bypassed the geometric prohibition`);
    assert.ok(evaluation.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
    assert.ok(evaluation.objectIds.includes(slab.objectId));
  }
});

test("Run-140 ceiling geometry detects a split full-booth cover", () => {
  const source = ceilingSource();
  const model = clone(draft(source));
  const ceiling = ceilingRequirement(source);
  const left = addCeilingSolid(model, 921, { widthMm: 3000, depthMm: 3000, xMm: 0, yMm: 2800, zMm: 0 });
  const right = addCeilingSolid(model, 922, { widthMm: 3000, depthMm: 3000, xMm: 3000, yMm: 2800, zMm: 0 });
  const evaluation = requirementEvaluation(model, source, ceiling);
  assert.equal(evaluation.outcome, "unsatisfied");
  assert.ok(evaluation.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
  assert.ok(evaluation.objectIds.includes(left.objectId));
  assert.ok(evaluation.objectIds.includes(right.objectId));
});

test("Run-140 ceiling geometry uses a transformed parent world position", () => {
  const source = ceilingSource();
  const model = clone(draft(source));
  const ceiling = ceilingRequirement(source);
  const parent = addCeilingSolid(model, 931, { widthMm: 200, depthMm: 200, heightMm: 100, xMm: 100, yMm: 100, zMm: 200 });
  const slab = addCeilingSolid(model, 932, {
    parentObjectId: parent.objectId,
    widthMm: 6000,
    depthMm: 3000,
    heightMm: 50,
    xMm: -100,
    yMm: 2700,
    zMm: -200,
  });
  const worldSlab = deriveS6WorldGeometry(model).find((shape) => shape.objectId === slab.objectId);
  assert.ok(worldSlab);
  assert.deepEqual(worldSlab.boundsMm.min, { xMm: 0, yMm: 2800, zMm: 0 });
  assert.deepEqual(worldSlab.boundsMm.max, { xMm: 6000, yMm: 2850, zMm: 3000 });
  const evaluation = requirementEvaluation(model, source, ceiling);
  assert.equal(evaluation.outcome, "unsatisfied");
  assert.ok(evaluation.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
  assert.ok(evaluation.objectIds.includes(slab.objectId));
});

test("Run-140 keeps ambiguous raised geometry unresolved and a narrow raised display clear", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);
  const ambiguousModel = clone(draft(source));
  const raisedBox = ambiguousModel.objects.find((object) => object.objectType === "table");
  assert.ok(raisedBox);
  raisedBox.objectType = "box";
  raisedBox.label = "Raised generic object";
  raisedBox.transform.positionMm.yMm = 100;
  const ambiguous = requirementEvaluation(ambiguousModel, source, ceiling);
  assert.equal(ambiguous.outcome, "satisfied", "type and label do not override certified non-enclosing geometry");
  assert.deepEqual(ambiguous.objectIds, []);

  const projectedCoverModel = clone(draft(source));
  const projectedCover = addCeilingSolid(projectedCoverModel, 940, {
    objectType: "table",
    role: "furniture",
    label: "Added rectangular object",
    widthMm: 6000,
    depthMm: 3002,
    heightMm: 50,
    xMm: 0,
    yMm: 2800,
    zMm: 0,
  });
  projectedCover.transform.rotationMd.xMd = 1000;
  const projectedCoverResult = requirementEvaluation(projectedCoverModel, source, ceiling);
  assert.equal(projectedCoverResult.outcome, "unresolved", "a projected cover with height-varying world footprint stays blocking");
  assert.ok(projectedCoverResult.objectIds.includes(projectedCover.objectId));

  const displayModel = clone(draft(source));
  const display = addCeilingSolid(displayModel, 941, {
    objectType: "display_plinth",
    role: "display",
    label: "Raised narrow sign",
    widthMm: 1200,
    depthMm: 120,
    heightMm: 150,
    xMm: 2400,
    yMm: 2200,
    zMm: 1440,
  });
  const displayResult = requirementEvaluation(displayModel, source, ceiling);
  assert.equal(displayResult.outcome, "satisfied");
  assert.deepEqual(displayResult.objectIds, []);
  assert.notEqual(display.objectId, raisedBox.objectId);
});

test("Run-146 N01-N07 / P01-P04 / B01-B03 certify exact boundaries and safe floor-continuous geometry", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);

  const exactBand = clone(draft(source));
  addCeilingSolid(exactBand, 951, { widthMm: 6000, depthMm: 3000, heightMm: 100, xMm: 0, yMm: 2000, zMm: 0 });
  assert.equal(requirementEvaluation(exactBand, source, ceiling).outcome, "satisfied", "a top exactly at the 2100mm band is not above it");

  const oneMillimetreAbove = clone(draft(source));
  addCeilingSolid(oneMillimetreAbove, 952, { widthMm: 6000, depthMm: 3000, heightMm: 101, xMm: 0, yMm: 2000, zMm: 0 });
  assert.equal(requirementEvaluation(oneMillimetreAbove, source, ceiling).outcome, "unsatisfied", "a common closed section above 2100mm is definite");

  const floorWall = clone(draft(source));
  addCeilingSolid(floorWall, 953, { widthMm: 6000, depthMm: 100, heightMm: 3000, xMm: 0, yMm: 0, zMm: 0 });
  assert.equal(requirementEvaluation(floorWall, source, ceiling).outcome, "satisfied", "floor-connected wall material is not overhead solely because it is tall");

  const ordinaryTable = clone(draft(source));
  const table = ordinaryTable.objects.find((object) => object.objectType === "table");
  assert.ok(table);
  table.transform.positionMm.yMm = 0;
  assert.equal(requirementEvaluation(ordinaryTable, source, ceiling).outcome, "satisfied");

  const raisedDisplay = clone(draft(source));
  addCeilingSolid(raisedDisplay, 954, {
    objectType: "display_plinth", role: "display", label: "Narrow raised sign",
    widthMm: 1200, depthMm: 120, heightMm: 150, xMm: 2400, yMm: 2200, zMm: 1440,
  });
  assert.equal(requirementEvaluation(raisedDisplay, source, ceiling).outcome, "satisfied", "a clearly non-enclosing raised display leaves a certified full-span strip");

  for (const stripMm of [900, 899]) {
    const model = clone(draft(source));
    addCeilingSolid(model, 955 + stripMm, {
      widthMm: 6000, depthMm: 3000 - stripMm, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0,
    });
    const outcome = requirementEvaluation(model, source, ceiling).outcome;
    assert.equal(outcome, stripMm === 900 ? "satisfied" : "unresolved", String(stripMm) + "mm full-span strip boundary");
  }

  const tableRequirement = source.canonicalRequirements.find((item) => item.text === "Table");
  const displayRequirement = source.canonicalRequirements.find((item) => item.text === "Display plinth");
  assert.ok(tableRequirement && displayRequirement);
  const metadataVariants = [
    { objectType: "table" as const, role: "furniture" as const, label: "Neutral", requirementIds: [] },
    { objectType: "display_plinth" as const, role: "display" as const, label: "Exhibit", requirementIds: [displayRequirement.requirementId] },
    { objectType: "box" as const, role: "furniture" as const, label: "Ceiling canopy", requirementIds: [ceiling.requirementId] },
    { objectType: "overhead_volume" as const, role: "overhead" as const, label: "Overhead", requirementIds: [tableRequirement.requirementId] },
  ];
  const positiveMetadataOutcomes = metadataVariants.map((metadata, index) => {
    const model = clone(draft(source));
    addCeilingSolid(model, 958 + index, {
      ...metadata, widthMm: 6000, depthMm: 2100, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0,
    });
    return requirementEvaluation(model, source, ceiling).outcome;
  });
  assert.deepEqual(positiveMetadataOutcomes, ["satisfied", "satisfied", "satisfied", "satisfied"],
    "the exact 900mm strip result is invariant under type, role, label, and requirement metadata");
});

test("Attempt-3 A3-CEIL-N01..N04 and M01 keep the near-full geometry blocker invariant under metadata", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);
  const tableRequirement = source.canonicalRequirements.find((item) => item.text === "Table");
  const displayRequirement = source.canonicalRequirements.find((item) => item.text === "Display plinth");
  assert.ok(tableRequirement && displayRequirement);
  const variants: Array<{
    objectType: S6SpatialModelRecord["objects"][number]["objectType"];
    role: S6SpatialModelRecord["objects"][number]["role"];
    label: string;
    requirementIds: string[];
  }> = [
    { objectType: "table", role: "furniture", label: "Neutral label", requirementIds: [] },
    { objectType: "display_plinth", role: "display", label: "Exhibit support", requirementIds: [displayRequirement.requirementId] },
    { objectType: "box", role: "furniture", label: "Generic box", requirementIds: [tableRequirement.requirementId] },
    { objectType: "overhead_volume", role: "overhead", label: "Ceiling canopy", requirementIds: [ceiling.requirementId] },
  ];
  const outcomes = variants.map((variant, index) => {
    const model = clone(draft(source));
    const slab = addCeilingSolid(model, 960 + index, {
      ...variant,
      widthMm: 5998, depthMm: 2998, heightMm: 50, xMm: 1, yMm: 2800, zMm: 1,
    });
    const result = requirementEvaluation(model, source, ceiling);
    assert.ok(result.objectIds.includes(slab.objectId));
    assert.deepEqual(result.issueCodes, ["REQUIREMENT_MAPPING_INVALID"]);
    return result.outcome;
  });
  assert.deepEqual(outcomes, ["unresolved", "unresolved", "unresolved", "unresolved"]);
});

test("Attempt-3 A3-CEIL-R01/R02 preserve both accepted ceiling regressions", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);
  const full = clone(draft(source));
  const fullSlab = addCeilingSolid(full, 970, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  const definite = requirementEvaluation(full, source, ceiling);
  assert.equal(definite.outcome, "unsatisfied");
  assert.ok(definite.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
  assert.ok(definite.objectIds.includes(fullSlab.objectId));

  const nearFull = clone(draft(source));
  const nearFullSlab = addCeilingSolid(nearFull, 971, { widthMm: 5998, depthMm: 2998, heightMm: 50, xMm: 1, yMm: 2800, zMm: 1 });
  const ambiguous = requirementEvaluation(nearFull, source, ceiling);
  assert.equal(ambiguous.outcome, "unresolved");
  assert.ok(ambiguous.objectIds.includes(nearFullSlab.objectId));
});

test("Run-146 V01-V12 keep vertical intervals separate and fail closed on unsupported or incomplete proof", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);

  const separatedIntervals = clone(draft(source));
  addCeilingSolid(separatedIntervals, 980, { widthMm: 6000, depthMm: 3000, heightMm: 700, xMm: 0, yMm: 0, zMm: 0 });
  addCeilingSolid(separatedIntervals, 981, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  assert.equal(requirementEvaluation(separatedIntervals, source, ceiling).outcome, "unsatisfied",
    "a raised interval must not inherit floor continuity from a separate lower interval");

  const unsupportedRotation = clone(draft(source));
  const rotatedSlab = addCeilingSolid(unsupportedRotation, 982, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  rotatedSlab.transform.rotationMd.zMd = 1000;
  assert.equal(requirementEvaluation(unsupportedRotation, source, ceiling).outcome, "unresolved");

  const unsupportedProfile = clone(draft(source));
  const invalidProfile = addCeilingSolid(unsupportedProfile, 983);
  invalidProfile.primitive = {
    kind: "profile_extrusion",
    profile: { winding: "ccw-from-positive-y-v1", vertices: [
      { xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 1000 }, { xMm: 0, zMm: 1500 },
    ] },
    heightMm: 50, geometryState: "exact", localAnchor: "floor",
  };
  invalidProfile.transform.positionMm.yMm = 2800;
  assert.equal(requirementEvaluation(unsupportedProfile, source, ceiling).outcome, "unresolved");

  const outOfRangeCoordinate = clone(draft(source));
  const overflowing = addCeilingSolid(outOfRangeCoordinate, 984);
  overflowing.transform.positionMm.xMm = Number.MAX_SAFE_INTEGER;
  assert.equal(requirementEvaluation(outOfRangeCoordinate, source, ceiling).outcome, "unresolved");

  const chainOverflow = clone(draft(source));
  let parentObjectId: string | null = null;
  for (let index = 0; index < 66; index += 1) {
    const node = addCeilingSolid(chainOverflow, 1000 + index, { widthMm: 100, depthMm: 100, heightMm: 100, xMm: 0, yMm: index === 65 ? 2800 : 0, zMm: 0, parentObjectId });
    parentObjectId = node.objectId;
  }
  assert.equal(requirementEvaluation(chainOverflow, source, ceiling).outcome, "unresolved", "ancestor traversal is capped at 64 edges");

  const laterCertificateFailure = clone(draft(source));
  addCeilingSolid(laterCertificateFailure, 1080, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  const invalidSibling = addCeilingSolid(laterCertificateFailure, 1081, { widthMm: 500, depthMm: 500, heightMm: 100, xMm: 0, yMm: 100, zMm: 0 });
  invalidSibling.transform.rotationMd.xMd = 1;
  assert.equal(requirementEvaluation(laterCertificateFailure, source, ceiling).outcome, "unresolved",
    "an earlier provisional definite result cannot survive a later certificate failure");

  const resourceOverflow = clone(draft(source));
  const template = resourceOverflow.objects.find((object) => object.objectType === "table");
  assert.ok(template);
  while (resourceOverflow.objects.length <= 256) {
    const duplicate = structuredClone(template);
    duplicate.objectId = deterministicRevisionId(1200 + resourceOverflow.objects.length);
    duplicate.identityKey = "resource-bound-" + String(resourceOverflow.objects.length);
    duplicate.parentObjectId = null;
    resourceOverflow.objects.push(duplicate);
  }
  assert.equal(requirementEvaluation(resourceOverflow, source, ceiling).outcome, "unresolved", "the fixed 256-object ceiling fails closed");
});

test("Run-146 C01-C08 certify primitive bounds, reject false floor bridges, and preserve quarter-turn equivalence", () => {
  const source = ceilingSource();
  const ceiling = ceilingRequirement(source);

  const exactRect = clone(draft(source));
  addCeilingSolid(exactRect, 1090, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  assert.equal(requirementEvaluation(exactRect, source, ceiling).outcome, "unsatisfied", "C01 exact rect_prism");

  const conservativeRound = clone(draft(source));
  const round = addCeilingSolid(conservativeRound, 1091, { widthMm: 800, depthMm: 800, heightMm: 3000, xMm: 1000, yMm: 0, zMm: 1000 });
  round.primitive = { kind: "round_prism", radiusMm: 400, heightMm: 3000, geometryState: "exact", localAnchor: "floor" };
  assert.equal(requirementEvaluation(conservativeRound, source, ceiling).outcome, "satisfied", "C02 conservative inner/outer round certificate");

  const profileGap = clone(draft(source));
  const cProfile = addCeilingSolid(profileGap, 1092, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  cProfile.primitive = {
    kind: "profile_extrusion",
    profile: { winding: "ccw-from-positive-y-v1", vertices: [
      { xMm: 0, zMm: 0 }, { xMm: 6000, zMm: 0 }, { xMm: 6000, zMm: 3000 }, { xMm: 0, zMm: 3000 },
      { xMm: 0, zMm: 2000 }, { xMm: 5000, zMm: 2000 }, { xMm: 5000, zMm: 1000 }, { xMm: 0, zMm: 1000 },
    ] },
    heightMm: 50, geometryState: "exact", localAnchor: "floor",
  };
  assert.equal(requirementEvaluation(profileGap, source, ceiling).outcome, "unresolved", "C03 preserves an orthogonal profile's open concavity");

  const outerFalseBridge = clone(draft(source));
  const horizontalCylinder = addCeilingSolid(outerFalseBridge, 1093, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 1500, zMm: 1500 });
  horizontalCylinder.primitive = { kind: "round_prism", radiusMm: 1500, heightMm: 6000, geometryState: "exact", localAnchor: "floor" };
  horizontalCylinder.transform.rotationMd.zMd = 270000;
  assert.equal(requirementEvaluation(outerFalseBridge, source, ceiling).outcome, "unresolved",
    "C05 an outer bound that touches the floor cannot manufacture floor continuity");

  const sampledCylinder = clone(draft(source));
  const sampleOnly = addCeilingSolid(sampledCylinder, 1094, { widthMm: 2000, depthMm: 2000, heightMm: 50, xMm: 2000, yMm: 2200, zMm: 500 });
  sampleOnly.primitive = { kind: "round_prism", radiusMm: 1000, heightMm: 50, geometryState: "exact", localAnchor: "floor" };
  sampleOnly.transform.rotationMd.zMd = 1000;
  assert.equal(requirementEvaluation(sampledCylinder, source, ceiling).outcome, "unresolved", "C07 sampled-cylinder geometry cannot certify a boundary pass");

  const direct = clone(draft(source));
  addCeilingSolid(direct, 1095, { widthMm: 6000, depthMm: 3000, heightMm: 50, xMm: 0, yMm: 2800, zMm: 0 });
  const directResult = requirementEvaluation(direct, source, ceiling);
  assert.equal(directResult.outcome, "unsatisfied", "C06 common-height definite closure");

  const quarterTurn = clone(draft(source));
  const parent = addCeilingSolid(quarterTurn, 1096, { widthMm: 100, depthMm: 100, heightMm: 100, xMm: 0, yMm: 0, zMm: 0 });
  parent.transform.rotationMd.yMd = 90000;
  addCeilingSolid(quarterTurn, 1097, {
    parentObjectId: parent.objectId, widthMm: 3000, depthMm: 6000, heightMm: 50, xMm: -3000, yMm: 2800, zMm: 0,
  });
  const quarterResult = requirementEvaluation(quarterTurn, source, ceiling);
  assert.equal(quarterResult.outcome, directResult.outcome, "C08 world-equivalent quarter-turn geometry has the same verdict");
  assert.ok(quarterResult.issueCodes.includes("PROHIBITED_CONTENT_PRESENT"));
});

test("explicit zone requirements use their metric region, not seating markers", () => {
  const source = makeS6Source({ requirements: [{ name: "Designated activity area", category: "functional", expected: "present" }] });
  const model = draft(source);
  const result = evaluateS6Requirements(model, source)[0];
  assert.equal(result?.evidenceKind, "zone_region");
  assert.equal(result?.outcome, "satisfied");
  assert.equal(result?.zoneIds.length, 1);
  assert.equal(result?.objectIds.length, 0);
  const region = model.objects.find((object) => object.objectType === "zone_region");
  assert.ok(region);
  assert.deepEqual(model.zones[0]?.requirementIds, [source.canonicalRequirements[0]!.requirementId]);
  model.objects = model.objects.filter((object) => object.objectId !== region.objectId);
  assert.equal(evaluateS6Requirements(model, source)[0]?.outcome, "unsatisfied");

  const invalidMappingModel = draft(source);
  const invalidZone = structuredClone(invalidMappingModel.zones[0]!);
  invalidZone.zoneId += ".unsupported";
  invalidMappingModel.zones.push(invalidZone);
  assert.equal(evaluateS6Requirements(invalidMappingModel, source)[0]?.outcome, "unsatisfied", "an invalid mapped zone cannot disappear beside a valid one");
});

test("resolver rejects unsupported zone qualifiers before category inference", () => {
  const source = makeS6Source({ requirements: [
    { name: "Designated activity area with cyan", category: "functional", expected: "present" },
  ] });
  const model = draft(source);
  const result = evaluateS6Requirements(model, source)[0];
  assert.equal(result?.outcome, "unresolved");
  assert.ok(result?.issueCodes.includes("REQUIREMENT_MAPPING_INVALID"));
  assert.equal(model.objects.some((object) => object.requirementIds.includes(source.canonicalRequirements[0]!.requirementId)), false);
  assert.equal(model.zones.some((zone) => zone.requirementIds.includes(source.canonicalRequirements[0]!.requirementId)), false);

  const inferredFamilySource = makeS6Source({ requirements: [
    { name: "Quiet consultation", category: "functional", expected: "present" },
  ] });
  assert.equal(evaluateS6Requirements(draft(inferredFamilySource), inferredFamilySource)[0]?.outcome, "unresolved", "a zone category cannot invent a family when the full requirement does not name one");

  const negatedZoneSource = makeS6Source({ requirements: [
    { name: "No activity area", category: "functional", expected: "present" },
  ] });
  assert.equal(evaluateS6Requirements(draft(negatedZoneSource), negatedZoneSource)[0]?.outcome, "unresolved", "zone inference cannot ignore negation");
});

test("G140 open-side facts reject missing, extra, duplicate, invalid, and noncanonical tokens", () => {
  const sideSet = ["north", "east"] as const;
  const sourceSides = [...sideSet];
  const expressions = [
    sourceSides.slice(0, -1).join(","),
    [...sourceSides, "south"].join(","),
    [sourceSides[0], sourceSides[0]].join(","),
    [sourceSides[0], "up"].join(","),
    [sourceSides[0]!.toUpperCase(), sourceSides[1]!].join(","),
    [sourceSides[0], "", sourceSides[1]].join(","),
  ];

  for (const expectedValue of expressions) {
    const source = makeS6Source({ openSides: sourceSides, requirements: [] });
    const requirements: S2Requirement[] = [
      { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null,
        expectedValue: source.geometrySnapshot.widthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth width" },
      { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null,
        expectedValue: source.geometrySnapshot.depthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth depth" },
      { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null,
        expectedValue, criticality: "material", source: "geometry_snapshot", text: "Confirmed open sides" },
      { requirementId: "geometry.max-height", category: "geometry", expected: "present", expectedCount: null,
        expectedValue: source.geometrySnapshot.maxHeightMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed maximum height" },
    ];
    withRequirements(source, requirements);
    const result = evaluateS6Requirements(draft(source), source).find((item) => item.requirementId === "access.open-sides");
    assert.notEqual(result?.outcome, "satisfied", `invalid side expression ${JSON.stringify(expectedValue)} must fail`);
  }

  const source = makeS6Source({ openSides: sourceSides, requirements: [] });
  const requirements: S2Requirement[] = [
    { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: source.geometrySnapshot.widthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth width" },
    { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: source.geometrySnapshot.depthMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed booth depth" },
    { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: "east,north", criticality: "material", source: "geometry_snapshot", text: "Confirmed open sides" },
    { requirementId: "geometry.max-height", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: source.geometrySnapshot.maxHeightMm, criticality: "material", source: "geometry_snapshot", text: "Confirmed maximum height" },
  ];
  withRequirements(source, requirements);
  const model = draft(source);
  const invalidModelSides: string[][] = [
    ["north"],
    ["north", "east", "south"],
    ["north", "north", "east"],
    ["north", "invalid"],
  ];
  for (const sides of invalidModelSides) {
    const mutated = clone(model);
    mutated.booth.openSides = sides as S6SpatialModelRecord["booth"]["openSides"];
    const result = evaluateS6Requirements(mutated, source).find((item) => item.requirementId === "access.open-sides");
    assert.notEqual(result?.outcome, "satisfied", `invalid model side set ${JSON.stringify(sides)} must fail`);
  }
});

test("G140 maximum-height evidence uses a child object's transformed world top", () => {
  const source = makeS6Source({ requirements: [
    { name: "Welcome counter", expected: "present" },
    { name: "Demo table", expected: "present" },
  ] });
  const maximum = source.geometrySnapshot.maxHeightMm;
  assert.ok(maximum !== null);
  const requirements = source.canonicalRequirements.slice();
  requirements.push({
    requirementId: "geometry.max-height",
    category: "geometry",
    expected: "present",
    expectedCount: null,
    expectedValue: maximum,
    criticality: "material",
    source: "geometry_snapshot",
    text: "Confirmed maximum height",
  });
  withRequirements(source, requirements);
  const model = draft(source);
  const parent = model.objects.find((item) => item.objectType === "counter");
  const child = model.objects.find((item) => item.objectType === "table");
  assert.ok(parent && child);
  child.parentObjectId = parent.objectId;
  parent.transform.positionMm.yMm = 0;
  const childHeight = child.primitive.kind === "rect_prism"
    ? child.primitive.dimensionsMm.heightMm
    : child.primitive.heightMm;
  child.transform.positionMm.yMm = maximum - childHeight + 1;

  const result = evaluateS6Requirements(model, source).find((item) => item.requirementId === "geometry.max-height");
  assert.equal(result?.outcome, "unsatisfied");
  assert.ok(result?.issueCodes.includes("MAX_HEIGHT_EXCEEDED"));
  assert.ok(result?.objectIds.includes(child.objectId));
});

test("G140 inferred render height promotion is rejected by current validation", () => {
  const source = makeS6Source({ maxHeightMm: null, requirements: [] });
  const model = draft(source);
  const assumption = model.assumptions.find((item) => item.fieldPath === "booth.maxHeightMm");
  assert.ok(assumption);
  const renderHeight = /derived render height (\d+) mm/u.exec(assumption.value)?.[1];
  assert.ok(renderHeight);
  model.booth.maxHeightMm = Number(renderHeight);
  model.booth.heightState = "known";
  refreshModelHash(model);

  const receipt = checked(model, source);
  assert.equal(receipt.outcome, "acceptance_blocked");
  assert.ok(receipt.errors.some((item) => item.code === "BOOTH_ENVELOPE_INVALID"));
});

test("G140 duplicate object identities cannot satisfy an exact object count", () => {
  const source = makeS6Source({ requirements: [{ name: "Demo table", expected: "exact_count", expectedCount: 2 }] });
  const model = draft(source);
  const table = model.objects.find((item) => item.objectType === "table");
  assert.ok(table);
  const duplicateIdentity = structuredClone(table);
  duplicateIdentity.transform.positionMm.xMm = 4500;
  duplicateIdentity.transform.positionMm.zMm = 2200;
  model.objects.push(duplicateIdentity);

  const result = evaluateS6Requirements(model, source)[0];
  assert.equal(result?.outcome, "unsatisfied");
  assert.ok(result?.issueCodes.includes("REQUIREMENT_MAPPING_INVALID"));
});

test("G140 zone regions and seating markers cannot substitute for a required physical table", () => {
  const source = makeS6Source({ requirements: [{ name: "Demo table", expected: "present" }] });
  const requirementId = source.canonicalRequirements[0]!.requirementId;
  const model = draft(source);
  assert.equal(evaluateS6Requirements(model, source)[0]?.outcome, "satisfied", "the physical table is the passing control");

  const seatingSubstitution = clone(model);
  const table = seatingSubstitution.objects.find((item) => item.objectType === "table");
  assert.ok(table);
  table.objectType = "seating_marker";
  table.role = "seating";
  const seatingResult = evaluateS6Requirements(seatingSubstitution, source).find((item) => item.requirementId === requirementId);
  assert.equal(seatingResult?.outcome, "unsatisfied");
  assert.ok(seatingResult?.issueCodes.includes("REQUIREMENT_MAPPING_INVALID"));

  const zoneSubstitution = clone(model);
  const zoneTable = zoneSubstitution.objects.find((item) => item.objectType === "table");
  const region = zoneSubstitution.objects.find((item) => item.objectType === "zone_region");
  assert.ok(zoneTable && region);
  zoneTable.requirementIds = [];
  region.requirementIds = [requirementId];
  const zoneResult = evaluateS6Requirements(zoneSubstitution, source).find((item) => item.requirementId === requirementId);
  assert.equal(zoneResult?.outcome, "unsatisfied");
  assert.ok(zoneResult?.issueCodes.includes("REQUIREMENT_MAPPING_INVALID"));
});

test("G140 unsupported scene qualifiers stay unresolved and cannot be mapped to a box", () => {
  const unsupportedText = "Keep the entry clear 1200mm";
  const source = makeS6Source({ requirements: [
    { name: "Welcome counter", expected: "present" },
    { name: "Keep the entry clear", category: "mandatory", expected: "present" },
    { name: unsupportedText, category: "mandatory", expected: "present" },
  ] });
  const exact = source.canonicalRequirements.find((item) => item.text === "Keep the entry clear");
  const unsupported = source.canonicalRequirements.find((item) => item.text === unsupportedText);
  assert.ok(exact && unsupported);
  const model = draft(source);
  const counter = model.objects.find((item) => item.objectType === "counter");
  assert.ok(counter);
  counter.transform.positionMm = { xMm: 2500, yMm: 0, zMm: 1200 };
  assert.equal(evaluateS6Requirements(model, source).find((item) => item.requirementId === exact.requirementId)?.outcome, "satisfied");
  assert.equal(evaluateS6Requirements(model, source).find((item) => item.requirementId === unsupported.requirementId)?.outcome, "unresolved");

  counter.objectType = "box";
  counter.label = "Generic box";
  counter.requirementIds = [unsupported.requirementId];
  assert.equal(evaluateS6Requirements(model, source).find((item) => item.requirementId === unsupported.requirementId)?.outcome, "unresolved");

  refreshModelHash(model);
  const receipt = checked(model, source);
  assert.equal(receipt.outcome, "acceptance_blocked");
  assert.ok(receipt.errors.some((item) => item.requirementId === unsupported.requirementId && item.code === "REQUIREMENT_MAPPING_INVALID"));
});
