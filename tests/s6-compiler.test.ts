import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { hashS6Model } from "../src/lib/s6-canonical";
import {
  allNonEmptyOpenSideSubsets,
  deterministicClock,
  deterministicRevisionId,
  makeS6Source,
  representativeSources,
} from "./s6-fixture";

function compile(source: ReturnType<typeof makeS6Source>, revision = 1) {
  return compileS6Draft({
    source,
    revisionId: deterministicRevisionId(revision),
    parentRevisionId: null,
    clock: deterministicClock(),
  });
}

test("compiler covers every one-to-four open-side variant and creates no wall on any open side", () => {
  for (const openSides of allNonEmptyOpenSideSubsets()) {
    const model = compile(makeS6Source({ openSides, requirements: [] }));
    const walls = model.objects.filter((item) => item.role === "booth_wall").map((item) => item.identityKey);
    const closedSides = ["north", "east", "south", "west"].filter((side) => !openSides.includes(side as never));
    assert.deepEqual(walls, closedSides.map((side) => "booth-wall:" + side));
    for (const openSide of openSides) assert.equal(walls.some((value) => value.endsWith(":" + openSide)), false);
  }
});

test("known height remains confirmed and unknown height creates an audited assumption", () => {
  const known = compile(makeS6Source({ maxHeightMm: 3200, requirements: [] }));
  assert.equal(known.booth.maxHeightMm, 3200);
  assert.equal(known.booth.heightState, "known");
  assert.equal(known.assumptions.length, 0);
  const unknown = compile(makeS6Source({ maxHeightMm: null, requirements: [] }));
  assert.equal(unknown.booth.maxHeightMm, null);
  assert.equal(unknown.booth.heightState, "unknown");
  assert.equal(unknown.assumptions.length, 1);
  assert.equal(unknown.assumptions[0]?.requiresConfirmation, true);
  assert.equal(unknown.assumptions[0]?.provenance.kind, "bounded_design_inference");
});

test("compiler creates exact countable instances from confirmed requirements", () => {
  const model = compile(makeS6Source({
    requirements: [
      { name: "Four display plinths", expected: "exact_count", expectedCount: 4 },
      { name: "No storage", expected: "absent" },
      { name: "One round counter", expected: "exact_count", expectedCount: 1 },
      { name: "Optional table", expected: "present" },
    ],
  }));
  const byRequirement = new Map<string, number>();
  for (const object of model.objects) if (object.requirementIds[0]) byRequirement.set(object.requirementIds[0], (byRequirement.get(object.requirementIds[0]) ?? 0) + 1);
  assert.equal(byRequirement.get("brief.functional.001"), 4);
  assert.equal(byRequirement.get("brief.functional.002") ?? 0, 0);
  assert.equal(byRequirement.get("brief.functional.003"), 1);
  assert.equal(byRequirement.get("brief.functional.004"), 1);
});

test("compiler preserves stable IDs and deterministic placement", () => {
  const source = makeS6Source();
  const first = compile(source, 5);
  const second = compile(source, 5);
  assert.deepEqual(first.objects.map((item) => item.objectId), second.objects.map((item) => item.objectId));
  assert.deepEqual(first.objects.map((item) => item.transform), second.objects.map((item) => item.transform));
  assert.equal(hashS6Model(first).modelHash, hashS6Model(second).modelHash);
  assert.ok(first.objects.every((item) => !item.objectId.includes(first.objects[0]?.label ?? "never")));
});

test("compiler emits only the rect round profile allowlist and preserves representative forms", () => {
  const allowed = new Set(["rect_prism", "round_prism", "profile_extrusion"]);
  for (const source of Object.values(representativeSources())) {
    const model = compile(source);
    assert.ok(model.objects.every((item) => allowed.has(item.primitive.kind)));
  }
  const round = compile(representativeSources()["round-counter"]!);
  assert.equal(round.objects.find((item) => item.objectType === "counter")?.primitive.kind, "round_prism");
  const profile = compile(representativeSources()["extruded-non-rectangular-feature"]!);
  assert.equal(profile.objects.find((item) => item.objectType === "display_plinth")?.primitive.kind, "profile_extrusion");
  const overhead = compile(representativeSources()["overhead-profile"]!);
  assert.equal(overhead.objects.find((item) => item.objectType === "overhead_volume")?.primitive.kind, "profile_extrusion");
});

test("compiler creates design-form review unknowns instead of silently accepting generic boxes", () => {
  const model = compile(representativeSources()["mixed-open-sides-angled-partition"]!);
  assert.equal(model.designFormReview.status, "required");
  assert.equal(model.designFormReview.acceptedByUser, false);
  assert.ok(model.unknowns.some((item) => item.kind === "design_form" && item.blocking));
  assert.deepEqual(model.designFormReview.unresolvedUnknownIds.sort(), model.unknowns.filter((item) => item.kind === "design_form").map((item) => item.unknownId).sort());
  assert.ok(model.objects.filter((item) => item.role !== "booth_floor").every((item) => item.provenance.kind === "bounded_design_inference" || item.provenance.kind === "confirmed_project_input"));
});

test("unsupported form fails closed without a box substitute", () => {
  const model = compile(representativeSources()["unsupported-form-fails-closed"]!);
  assert.equal(model.designFormReview.status, "unsupported");
  assert.ok(model.unknowns.some((item) => item.kind === "design_form" && item.blocking && item.question.includes("S6_UNSUPPORTED_FORM")));
  assert.equal(model.objects.some((item) => item.objectType === "box"), false);
});

test("unresolved semantic requirements create blocking mapping unknowns", () => {
  const source = makeS6Source({ requirements: [{ name: "Mystery thing", category: "free_text", expected: "present" }] });
  const model = compile(source);
  assert.equal(model.objects.some((item) => item.requirementIds.includes("brief.functional.001")), false);
  assert.ok(model.unknowns.some((item) => item.kind === "requirement_mapping" && item.blocking && item.requirementId === "brief.functional.001"));
});

test("S5 conceptual Q16 coordinates never become metric compiler coordinates", () => {
  const source = makeS6Source();
  const conceptual = source.layoutPlan.zones.flatMap((zone) => zone.instances)[0];
  assert.ok(conceptual);
  const model = compile(source);
  const object = model.objects.find((item) => item.requirementIds.includes(conceptual!.requirementId));
  assert.ok(object);
  assert.notEqual(object?.transform.positionMm.xMm, conceptual?.xQ16);
  assert.notEqual(object?.transform.positionMm.zMm, conceptual?.yQ16);
});
