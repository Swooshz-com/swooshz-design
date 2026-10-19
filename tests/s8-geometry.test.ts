import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertS8Mesh, buildS8Mesh, s8RoundSagitta, s8RoundSegments, triangulateS8Profile } from "../src/lib/s8-fbx-geometry";

test("concave profile uses deterministic ear clipping and remains a closed manifold", () => {
  const profile = [
    { xMm: 0, zMm: 0 }, { xMm: 4000, zMm: 0 }, { xMm: 4000, zMm: 1000 },
    { xMm: 1500, zMm: 1000 }, { xMm: 1500, zMm: 3000 }, { xMm: 0, zMm: 3000 },
  ];
  assert.deepEqual(triangulateS8Profile(profile), triangulateS8Profile(profile));
  assert.equal(triangulateS8Profile(profile).length, profile.length - 2);
  const mesh = buildS8Mesh({ kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: profile }, heightMm: 2501, geometryState: "exact", localAnchor: "center" });
  assert.equal(mesh.triangles.length, 2 * (profile.length - 2) + 2 * profile.length);
  assert.equal(Math.min(...mesh.verticesMm.map((point) => point[2])), -1250.5);
  assert.equal(Math.max(...mesh.verticesMm.map((point) => point[2])), 1250.5);
});

test("adaptive round tessellation meets the one millimetre sagitta contract", () => {
  assert.equal(s8RoundSegments(50_000), 498);
  assert.ok(s8RoundSagitta(50_000, 498) <= 1);
  assert.ok(s8RoundSagitta(50_000, 24) > 1);
  const mesh = buildS8Mesh({ kind: "round_prism", radiusMm: 50_000, heightMm: 3000, geometryState: "exact", localAnchor: "floor" });
  assert.equal(mesh.roundSegments, 498);
  assert.equal(mesh.verticesMm.length, 996);
});

test("rectangular prisms have explicit triangle normals and reject flipped normals", () => {
  const mesh = buildS8Mesh({ kind: "rect_prism", dimensionsMm: { widthMm: 3000, depthMm: 2000, heightMm: 2500 }, geometryState: "exact", localAnchor: "floor" });
  assert.equal(mesh.verticesMm.length, 8);
  assert.equal(mesh.triangles.length, 12);
  assert.equal(mesh.cornerNormals.length, 36);
  const tampered = { ...mesh, cornerNormals: mesh.cornerNormals.map((normal) => [-normal[0], -normal[1], -normal[2]] as const) };
  assert.throws(() => assertS8Mesh(tampered), /S8_NORMAL_FLIPPED/);
});

test("the durable fixture inventory contains every accepted family", () => {
  const matrix = JSON.parse(readFileSync(new URL("fixtures/s8/fixture-matrix.json", import.meta.url), "utf8")) as { fixtures: string[] };
  assert.equal(matrix.fixtures.length, 28);
  for (const name of ["near-gimbal-rotations", "indexed-corner-normals", "ufbx-warning-repair-failure", "stored-artifact-blender-edit-save-reopen"]) assert.ok(matrix.fixtures.includes(name));
});
