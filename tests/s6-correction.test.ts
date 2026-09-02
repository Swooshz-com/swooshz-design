import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyS6Corrections } from "../src/lib/s6-correction";
import { hashS6Model } from "../src/lib/s6-canonical";
import {
  deterministicClock,
  deterministicRevisionId,
  makeS6Source,
  representativeSources,
} from "./s6-fixture";
import { compileS6Draft } from "../src/lib/s6-compiler";
import type { S6CorrectionOperation, S6MaterialFinishRef, S6SpatialModelRecord } from "../src/lib/types";

function model(source = makeS6Source(), revision = 1): S6SpatialModelRecord {
  return compileS6Draft({ source, revisionId: deterministicRevisionId(revision), parentRevisionId: null, clock: deterministicClock() });
}

function apply(parent: S6SpatialModelRecord, operations: S6CorrectionOperation[], revision = 2) {
  return applyS6Corrections(parent, operations, { childRevisionId: deterministicRevisionId(revision), clock: deterministicClock(), actorSubjectId: "user-test" });
}

function physical(parent: S6SpatialModelRecord): NonNullable<S6SpatialModelRecord["objects"][number]> {
  const item = parent.objects.find((object) => object.role !== "booth_floor" && object.role !== "booth_wall" && object.role !== "zone");
  assert.ok(item);
  return item;
}

function material(parent: S6SpatialModelRecord): S6MaterialFinishRef {
  const item = parent.materials[0];
  assert.ok(item);
  return item;
}

test("move rotate resize and material operations create an immutable child", () => {
  const parent = model();
  const object = physical(parent);
  const child = apply(parent, [
    { kind: "move", objectId: object.objectId, deltaMm: { xMm: 10, yMm: 0, zMm: -20 } },
    { kind: "rotate", objectId: object.objectId, rotationMd: { xMd: 0, yMd: 30_000, zMd: 0 } },
    { kind: "resize", objectId: object.objectId, dimensionsMm: { widthMm: 800, depthMm: 500, heightMm: 900 } },
    { kind: "material", objectId: object.objectId, material: material(parent) },
  ]);
  assert.equal(child.model.parentRevisionId, parent.modelRevisionId);
  assert.equal(child.model.parentRevisionHash, parent.modelHash);
  assert.equal(child.model.status, "corrected_draft");
  assert.notEqual(child.model.modelHash, parent.modelHash);
  assert.equal(child.event.parentRevisionId, parent.modelRevisionId);
  assert.equal(child.event.parentRevisionHash, parent.modelHash);
  assert.equal(child.model.objects.find((item) => item.objectId === object.objectId)?.identityKey, object.identityKey);
});

test("replace_geometry switches only an allowlisted semantic-family shape", () => {
  const parent = model();
  const object = parent.objects.find((item) => item.objectType === "counter");
  assert.ok(object);
  const result = apply(parent, [{ kind: "replace_geometry", objectId: object.objectId, geometry: { kind: "round_prism", radiusMm: 400, heightMm: 1000, localAnchor: "floor" } }]);
  assert.equal(result.model.objects.find((item) => item.objectId === object.objectId)?.primitive.kind, "round_prism");
  const table = parent.objects.find((item) => item.objectType === "table");
  assert.ok(table);
  assert.throws(() => apply(parent, [{ kind: "replace_geometry", objectId: table.objectId, geometry: { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 300 }, { xMm: 0, zMm: 300 }] }, heightMm: 1000, localAnchor: "floor" } }]), /S6_CORRECTION/);
});

test("round radius and profile vertex corrections are bounded and canonicalized", () => {
  const roundParent = model(representativeSources()["round-counter"]!);
  const counter = roundParent.objects.find((item) => item.objectType === "counter");
  assert.ok(counter);
  const roundChild = apply(roundParent, [{ kind: "replace_geometry", objectId: counter.objectId, geometry: { kind: "round_prism", radiusMm: 450, heightMm: 1000, localAnchor: "floor" } }]);
  assert.equal(roundChild.model.objects.find((item) => item.objectId === counter.objectId)?.primitive.kind, "round_prism");
  const profileParent = model(representativeSources()["extruded-non-rectangular-feature"]!);
  const feature = profileParent.objects.find((item) => item.objectType === "display_plinth");
  assert.ok(feature);
  const profileChild = apply(profileParent, [{ kind: "replace_geometry", objectId: feature.objectId, geometry: { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1800, zMm: 0 }, { xMm: 1800, zMm: 600 }, { xMm: 900, zMm: 600 }, { xMm: 900, zMm: 1200 }, { xMm: 0, zMm: 1200 }, { xMm: 0, zMm: 0 }] }, heightMm: 900, localAnchor: "floor" } }]);
  const corrected = profileChild.model.objects.find((item) => item.objectId === feature.objectId);
  assert.equal(corrected?.primitive.kind, "profile_extrusion");
  assert.equal(corrected?.primitive.kind === "profile_extrusion" ? corrected.primitive.profile.vertices.length : 0, 6);
});

test("confirm_design_inference records user acceptance without relabelling provenance", () => {
  const parent = model();
  const object = physical(parent);
  const originalKind = object.provenance.kind;
  const originalSourceRef = object.provenance.sourceRef;
  const originalSourceFingerprint = object.provenance.sourceFingerprint;
  const child = apply(parent, [{ kind: "confirm_design_inference", objectIds: [object.objectId], note: "Use the reviewed bounded form." }]);
  const corrected = child.model.objects.find((item) => item.objectId === object.objectId);
  assert.equal(corrected?.provenance.kind, originalKind);
  assert.equal(corrected?.provenance.sourceRef, originalSourceRef);
  assert.equal(corrected?.provenance.sourceFingerprint, originalSourceFingerprint);
  assert.equal(corrected?.provenance.acceptedByUser, true);
  assert.match(corrected?.provenance.note ?? "", /Use the reviewed bounded form\./u);
  assert.equal(child.model.designFormReview.reviewedObjectIds.includes(object.objectId), true);

  const bounded = apply(parent, [{ kind: "confirm_design_inference", objectIds: [object.objectId], note: "x".repeat(400) }]);
  assert.ok(Array.from(bounded.model.objects.find((item) => item.objectId === object.objectId)?.provenance.note ?? "").length <= 400);
});

test("design-form unknown resolution requires typed replacement or explicit simplification", () => {
  const parent = model();
  const object = physical(parent);
  const unknown = parent.unknowns.find((item) => item.kind === "design_form" && object.unknownIds.includes(item.unknownId));
  assert.ok(unknown);
  assert.throws(() => apply(parent, [{ kind: "resolve_unknown", unknownId: unknown.unknownId, resolutionKind: "represented", resolutionNote: "text only", replacement: null }]), /S6_CORRECTION/);
  const child = apply(parent, [{ kind: "resolve_unknown", unknownId: unknown.unknownId, resolutionKind: "explicit_simplification", resolutionNote: "Typed bounded simplification for review.", replacement: { objectType: object.objectType, role: object.role, label: object.label, geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 800, depthMm: 400, heightMm: 900 }, localAnchor: "floor" }, positionMm: object.transform.positionMm, rotationMd: object.transform.rotationMd, material: material(parent) } }]);
  const resolved = child.model.unknowns.find((item) => item.unknownId === unknown.unknownId);
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolutionKind, "explicit_simplification");
  assert.equal(child.model.designFormReview.explicitSimplificationUnknownIds.includes(unknown.unknownId), true);
});

test("add generates a server ID and remove obeys allowlists", () => {
  const parent = model();
  const added = apply(parent, [{ kind: "add", objectType: "counter", role: "furniture", label: "Added counter", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 800, depthMm: 400, heightMm: 900 }, localAnchor: "floor" }, positionMm: { xMm: 500, yMm: 0, zMm: 500 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 }, material: material(parent), parentObjectId: null, zoneIds: [], requirementIds: [] }]);
  const newObject = added.model.objects.find((item) => item.label === "Added counter");
  assert.ok(newObject);
  assert.equal(newObject.objectId.startsWith("s6u_"), true);
  assert.throws(() => apply(parent, [{ kind: "remove", objectId: parent.objects.find((item) => item.role === "booth_floor")!.objectId }]), /S6_(?:CORRECTION|HARD_FACT)/);
});

test("booth facts and hard objects cannot be edited", () => {
  const parent = model();
  const wall = parent.objects.find((item) => item.role === "booth_wall");
  const floor = parent.objects.find((item) => item.role === "booth_floor");
  assert.ok(wall && floor);
  assert.throws(() => apply(parent, [{ kind: "move", objectId: wall.objectId, deltaMm: { xMm: 1, yMm: 0, zMm: 0 } }]), /S6_(?:CORRECTION|HARD_FACT)/);
  assert.throws(() => apply(parent, [{ kind: "remove", objectId: floor.objectId }]), /S6_(?:CORRECTION|HARD_FACT)/);
});

test("child revisions preserve unchanged object identity and deleted IDs are not reused", () => {
  const parent = model();
  const object = physical(parent);
  const child = apply(parent, [{ kind: "move", objectId: object.objectId, deltaMm: { xMm: 25, yMm: 0, zMm: 0 } }]);
  for (const original of parent.objects) {
    const copy = child.model.objects.find((item) => item.objectId === original.objectId);
    if (copy) assert.equal(copy.identityKey, original.identityKey);
  }
  const removed = apply(parent, [{ kind: "remove", objectId: object.objectId }], 3);
  assert.equal(removed.model.objects.some((item) => item.objectId === object.objectId), false);
  assert.equal(hashS6Model(parent).modelHash, parent.modelHash);
});

test("stale parent lineage is carried explicitly and never auto-merged", () => {
  const parent = model();
  const child = apply(parent, [], 2);
  assert.equal(child.model.parentRevisionId, parent.modelRevisionId);
  assert.equal(child.model.parentRevisionHash, parent.modelHash);
  assert.notEqual(child.model.modelRevisionId, parent.modelRevisionId);
  assert.throws(() => apply(parent, new Array(33).fill({ kind: "move", objectId: physical(parent).objectId, deltaMm: { xMm: 1, yMm: 0, zMm: 0 } }) as S6CorrectionOperation[]), /S6_CORRECTION/);
});
