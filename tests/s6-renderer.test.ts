import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildS6Cameras } from "../src/lib/s6-camera";
import { checkS6ViewPreservation } from "../src/lib/s6-preservation";
import { renderS6View } from "../src/lib/s6-renderer";
import { hashS6Model } from "../src/lib/s6-canonical";
import {
  deterministicClock,
  makeS6Source,
  representativeSources,
} from "./s6-fixture";
import { compileS6Draft } from "../src/lib/s6-compiler";
import type { S6SpatialModelRecord } from "../src/lib/types";

function draft(source = makeS6Source(), revision = 1): S6SpatialModelRecord {
  return compileS6Draft({ source, revisionId: "20000000-0000-4000-8000-" + String(100 + revision).padStart(12, "0"), parentRevisionId: null, clock: deterministicClock() });
}

function polygonPoints(rendered: ReturnType<typeof renderS6View>, objectId: string): string[] {
  const svg = new TextDecoder().decode(rendered.svgBytes);
  return Array.from(svg.matchAll(new RegExp("<polygon\\b[^>]*data-s6-object-id=\"" + objectId + "\"[^>]*points=\"([^\"]+)\"", "gu")), (match) => match[1]!);
}

function geometryFingerprint(rendered: ReturnType<typeof renderS6View>, objectId: string): string {
  return polygonPoints(rendered, objectId).join("|");
}

function projectedBounds(rendered: ReturnType<typeof renderS6View>, objectId: string): { width: number; height: number } {
  const coordinates = polygonPoints(rendered, objectId).flatMap((polygon) => polygon.split(" ").map((point) => point.split(",").map(Number)));
  const xs = coordinates.map(([x]) => x!);
  const ys = coordinates.map(([, y]) => y!);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function physicalObject(model: S6SpatialModelRecord): S6SpatialModelRecord["objects"][number] {
  const object = model.objects.find((item) => item.role !== "booth_floor" && item.role !== "zone");
  assert.ok(object);
  return object;
}

test("camera formulas are stable for known and unknown height", () => {
  const known = draft(makeS6Source({ maxHeightMm: 3200 }));
  const knownCameras = buildS6Cameras(known);
  assert.deepEqual(knownCameras.map((camera) => camera.viewId), ["perspective-northwest", "perspective-southeast", "top-orthographic"]);
  assert.equal(knownCameras[0]?.heightBasis, "confirmed_max_height");
  assert.equal(knownCameras[0]?.derivedRenderHeightMm, 3200);
  assert.deepEqual(knownCameras, buildS6Cameras(known));
  const unknown = draft(makeS6Source({ maxHeightMm: null }));
  const unknownCamera = buildS6Cameras(unknown)[0];
  assert.equal(unknownCamera?.heightBasis, "derived_render_height");
  assert.ok((unknownCamera?.derivedRenderHeightMm ?? 0) >= 3000);
});

test("same model and camera produce byte-identical s6-svg-geometry-v2 output", () => {
  const model = draft();
  const camera = buildS6Cameras(model)[0]!;
  const first = renderS6View(model, camera);
  const second = renderS6View(model, camera);
  assert.equal(new TextDecoder().decode(first.svgBytes), new TextDecoder().decode(second.svgBytes));
  assert.equal(first.outputSha256, second.outputSha256);
  assert.equal(first.sceneHash, second.sceneHash);
});

test("perspective geometry is bound to position, target, and FOV rather than metadata", () => {
  const model = draft();
  const camera = buildS6Cameras(model)[0]!;
  const objectId = physicalObject(model).objectId;
  const baseline = geometryFingerprint(renderS6View(model, camera), objectId);

  const positionChanged = structuredClone(camera);
  positionChanged.positionMm.xMm += 500;
  assert.notEqual(geometryFingerprint(renderS6View(model, positionChanged), objectId), baseline);

  const targetChanged = structuredClone(camera);
  targetChanged.targetMm.xMm += 500;
  assert.notEqual(geometryFingerprint(renderS6View(model, targetChanged), objectId), baseline);

  const fovChanged = structuredClone(camera);
  fovChanged.fovMd = (fovChanged.fovMd ?? 0) + 5_000;
  assert.notEqual(geometryFingerprint(renderS6View(model, fovChanged), objectId), baseline);
});

test("northwest and southeast perspective views use camera fields, not view-ID projection aliases", () => {
  const model = draft();
  const cameras = buildS6Cameras(model);
  const northwest = cameras[0]!;
  const southeast = cameras[1]!;
  const objectId = physicalObject(model).objectId;
  const northwestGeometry = geometryFingerprint(renderS6View(model, northwest), objectId);
  const southeastGeometry = geometryFingerprint(renderS6View(model, southeast), objectId);
  assert.notEqual(northwestGeometry, southeastGeometry);

  const southeastFieldsWithNorthwestId = structuredClone(southeast);
  southeastFieldsWithNorthwestId.viewId = "perspective-northwest";
  assert.equal(geometryFingerprint(renderS6View(model, southeastFieldsWithNorthwestId), objectId), southeastGeometry);
});

test("perspective scale changes with camera depth for equal-size geometry", () => {
  const model = draft();
  const tables = model.objects.filter((item) => item.objectType === "table");
  assert.equal(tables.length, 2);
  tables[0]!.transform.positionMm = { xMm: 1_000, yMm: 0, zMm: 1_000 };
  tables[1]!.transform.positionMm = { xMm: 4_500, yMm: 0, zMm: 2_500 };
  const camera = buildS6Cameras(model)[0]!;
  const rendered = renderS6View(model, camera);
  const near = projectedBounds(rendered, tables[0]!.objectId);
  const far = projectedBounds(rendered, tables[1]!.objectId);
  assert.notEqual(near.width, far.width);
  assert.notEqual(near.height, far.height);
});

test("top orthographic geometry uses the canonical basis and orthographic scale", () => {
  const model = draft();
  const camera = buildS6Cameras(model)[2]!;
  const objectId = physicalObject(model).objectId;
  const baseline = geometryFingerprint(renderS6View(model, camera), objectId);

  const targetChanged = structuredClone(camera);
  targetChanged.targetMm.xMm += 500;
  assert.notEqual(geometryFingerprint(renderS6View(model, targetChanged), objectId), baseline);

  const scaleChanged = structuredClone(camera);
  scaleChanged.orthoScaleMm = (scaleChanged.orthoScaleMm ?? 0) + 500;
  assert.notEqual(geometryFingerprint(renderS6View(model, scaleChanged), objectId), baseline);
});

test("required geometry outside near or far clipping fails deterministically", () => {
  const model = draft();
  const camera = buildS6Cameras(model)[0]!;
  const nearClipped = structuredClone(camera);
  nearClipped.nearMm = 100_000;
  assert.throws(() => renderS6View(model, nearClipped), /S6_VIEW_RENDER_FAILURE/);
  const farClipped = structuredClone(camera);
  farClipped.farMm = 200;
  assert.throws(() => renderS6View(model, farClipped), /S6_VIEW_RENDER_FAILURE/);
});

test("rect, round, and profile geometry render as distinct filled silhouettes", () => {
  for (const source of Object.values(representativeSources())) {
    const model = draft(source);
    const perspective = renderS6View(model, buildS6Cameras(model)[0]!);
    assert.ok(perspective.svgBytes.byteLength > 0);
    assert.ok(perspective.sceneEvidence.objects.some((item) => item.geometryKind === "rect_prism"));
    const svg = new TextDecoder().decode(perspective.svgBytes);
    assert.ok(svg.includes("fill="));
    assert.ok(svg.includes("data-object-id="));
  }
  const round = draft(representativeSources()["round-counter"]!);
  assert.equal(renderS6View(round, buildS6Cameras(round)[0]!).sceneEvidence.objects.some((item) => item.geometryKind === "round_prism"), true);
  const profile = draft(representativeSources()["extruded-non-rectangular-feature"]!);
  assert.equal(renderS6View(profile, buildS6Cameras(profile)[0]!).sceneEvidence.objects.some((item) => item.geometryKind === "profile_extrusion"), true);
});

test("material and finish variation is visible without geometry drift", () => {
  const source = representativeSources()["material-finish-variation"]!;
  const model = draft(source);
  const camera = buildS6Cameras(model)[0]!;
  const rendered = renderS6View(model, camera);
  const svg = new TextDecoder().decode(rendered.svgBytes);
  for (const material of model.materials) assert.ok(svg.includes(material.materialId));
  assert.ok(svg.includes("data-finish-kind="));
  assert.equal(rendered.sceneEvidence.objects.length, model.objects.length);
  assert.equal(rendered.sceneEvidence.objects.find((item) => item.objectId === model.objects[0]!.objectId)?.geometry.kind, model.objects[0]!.primitive.kind);
});

test("SVG preserves major forms, material IDs, overhead objects, and the top editor surface", () => {
  const model = draft(representativeSources()["mixed-form-booth-continuity"]!);
  const cameras = buildS6Cameras(model);
  const perspective = renderS6View(model, cameras[0]!);
  const top = renderS6View(model, cameras[2]!);
  const svg = new TextDecoder().decode(perspective.svgBytes);
  const overhead = model.objects.filter((item) => item.objectType === "overhead_volume").map((item) => item.objectId);
  for (const objectId of overhead) assert.ok(perspective.sceneEvidence.overheadObjectIds.includes(objectId));
  assert.ok(svg.includes("profile_extrusion"));
  assert.ok(svg.includes("round_prism"));
  assert.ok(new TextDecoder().decode(top.svgBytes).includes('data-view-id="top-orthographic"'));
  assert.ok(new TextDecoder().decode(top.svgBytes).includes("data-object-id="));
});

test("SVG contains no remote resources or executable content", () => {
  const rendered = renderS6View(draft(), buildS6Cameras(draft())[0]!);
  const svg = new TextDecoder().decode(rendered.svgBytes);
  assert.equal(/(?:<script|foreignObject|href=|xlink:|url\(|javascript:|data:image|onload=|<image)/iu.test(svg), false);
  assert.equal(rendered.sceneEvidence.externalResourceCount, 0);
  assert.equal(rendered.sceneEvidence.unsafeElementCount, 0);
});

test("unsupported or unreviewed form cannot become an accepted_view", () => {
  const source = representativeSources()["unsupported-form-fails-closed"]!;
  const model = draft(source);
  const camera = buildS6Cameras(model)[0]!;
  assert.doesNotThrow(() => renderS6View(model, camera));
  const accepted = structuredClone(model);
  accepted.status = "accepted_current";
  assert.throws(() => renderS6View(accepted, camera), /S6_DESIGN_FORM/);
});

test("preservation fails on changed object IDs, open sides, geometry, radius, and materials", () => {
  const source = representativeSources()["mixed-form-booth-continuity"]!;
  const model = draft(source);
  const camera = buildS6Cameras(model)[0]!;
  const rendered = renderS6View(model, camera);
  assert.equal(checkS6ViewPreservation(model, camera, rendered).outcome, "pass");
  const changedId = structuredClone(model);
  changedId.objects[0]!.objectId = "s6u_changed";
  assert.equal(checkS6ViewPreservation(changedId, camera, rendered).outcome, "fail");
  const changedOpen = structuredClone(model);
  changedOpen.booth.openSides = ["north"];
  assert.equal(checkS6ViewPreservation(changedOpen, camera, rendered).outcome, "fail");
  const changedGeometry = structuredClone(model);
  const geometryObject = changedGeometry.objects.find((item) => item.primitive.kind === "profile_extrusion");
  assert.ok(geometryObject);
  if (geometryObject?.primitive.kind === "profile_extrusion") geometryObject.primitive.heightMm += 1;
  assert.equal(checkS6ViewPreservation(changedGeometry, camera, rendered).outcome, "fail");
  const changedMaterial = structuredClone(model);
  changedMaterial.materials[0]!.label = "changed";
  assert.equal(checkS6ViewPreservation(changedMaterial, camera, rendered).outcome, "fail");
});

test("scene evidence is structured and hash-bound to the model", () => {
  const model = draft();
  const camera = buildS6Cameras(model)[1]!;
  const rendered = renderS6View(model, camera);
  assert.equal(rendered.sceneEvidence.modelHash, hashS6Model(model).modelHash);
  assert.equal(rendered.sceneEvidence.cameraHash, camera.cameraHash);
  assert.equal(rendered.sceneEvidence.sourceS5Fingerprint, model.sourceS5Fingerprint);
  assert.equal(rendered.sceneEvidence.rendererVersion, "s6-svg-geometry-v2");
  assert.deepEqual(rendered.visibleObjectIds.sort(), model.objects.map((item) => item.objectId).sort());
});
