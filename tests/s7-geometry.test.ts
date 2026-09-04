import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AppError, type S6ToS7Handoff } from "../src/lib/types";
import { buildS7GeometryPlan, buildS7MatrixOracle, deterministicConvexHull } from "../src/lib/s7-geometry";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as const;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as const;
const HASH = "a".repeat(64);

function object(options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectId: "object-1",
    identityKey: "object-1",
    parentObjectId: null,
    objectType: "box",
    role: "furniture",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" },
    footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 },
    transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 },
    zoneIds: [], requirementIds: [], materialIds: [], provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null }, unknownIds: [],
    ...options,
  };
}

export function minimalHandoff(options: { objects?: Record<string, unknown>[]; openSides?: string[]; widthMm?: number; depthMm?: number; unknowns?: Record<string, unknown>[] } = {}): S6ToS7Handoff {
  const objects = options.objects ?? [object()];
  return {
    schemaVersion: "s6-to-s7-handoff-v1",
    projectId: PROJECT_ID,
    acceptedRevisionId: REVISION_ID,
    acceptedRevisionHash: HASH,
    sourceS5Fingerprint: HASH,
    spatialSchemaVersion: "s6-spatial-model-v1",
    units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: options.widthMm ?? 6000, depthMm: options.depthMm ?? 3000, openSides: options.openSides ?? ["north", "east"], maxHeightMm: 3000, heightState: "known" },
    objects,
    hierarchy: objects.map((item) => ({ objectId: String(item.objectId), parentObjectId: item.parentObjectId as string | null })),
    zones: [], requirements: [], materials: [], assumptions: [], unknowns: (options.unknowns ?? []) as never,
    validationReceipt: { receiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : String(error);
}

type Matrix3 = number[][];

function multiplyExpected(left: Matrix3, right: Matrix3): Matrix3 {
  return left.map((row, rowIndex) => row.map((_, columnIndex) =>
    row.reduce((sum, value, innerIndex) => sum + value * right[innerIndex]![columnIndex]!, 0),
  ));
}

function expectedEuler(rotation: { xMd: number; yMd: number; zMd: number }): Matrix3 {
  const x = rotation.xMd * Math.PI / 180_000;
  const y = rotation.yMd * Math.PI / 180_000;
  const z = rotation.zMd * Math.PI / 180_000;
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function assertMatrixClose(actual: readonly (readonly number[])[], expected: Matrix3, label = "matrix"): void {
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    assert.ok(Math.abs(actual[row]![column]! - expected[row]![column]!) < 1e-9, `${label}[${row}][${column}]`);
  }
}

test("independent matrix oracle covers X-only, Y-only, Z-only, and true mixed Euler rotations", () => {
  const cases: Array<[string, { xMd: number; yMd: number; zMd: number }, Matrix3]> = [
    ["X-only", { xMd: 90_000, yMd: 0, zMd: 0 }, [[1, 0, 0], [0, 0, -1], [0, 1, 0]]],
    ["Y-only", { xMd: 0, yMd: 90_000, zMd: 0 }, [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]],
    ["Z-only", { xMd: 0, yMd: 0, zMd: 90_000 }, [[0, -1, 0], [1, 0, 0], [0, 0, 1]]],
    ["mixed X/Y/Z", { xMd: 30_000, yMd: 45_000, zMd: 60_000 }, [
      [0.3535533905932738, -0.5732233047033631, 0.7391989197401166],
      [0.6123724356957946, 0.7391989197401166, 0.2803300858899106],
      [-0.7071067811865475, 0.35355339059327373, 0.6123724356957946],
    ]],
  ];
  for (const [label, rotation, expected] of cases) {
    const actual = buildS7MatrixOracle(minimalHandoff({ objects: [object({ transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: rotation } })] })).get("object-1")!;
    assertMatrixClose(actual.rotation, expected, label);
  }
});

test("independent matrix oracle preserves nested parent/child hierarchy composition", () => {
  const parent = object({ objectId: "parent", identityKey: "parent", transform: { positionMm: { xMm: 100, yMm: 20, zMm: 50 }, rotationMd: { xMd: 0, yMd: 0, zMd: 90000 } } });
  const child = object({ objectId: "child", identityKey: "child", parentObjectId: "parent", transform: { positionMm: { xMm: 10, yMm: 0, zMm: 0 }, rotationMd: { xMd: 90000, yMd: 0, zMd: 0 } } });
  const matrices = buildS7MatrixOracle(minimalHandoff({ objects: [parent, child] }));
  const childMatrix = matrices.get("child")!;
  const parentRotation = expectedEuler({ xMd: 0, yMd: 0, zMd: 90_000 });
  const childRotation = expectedEuler({ xMd: 90_000, yMd: 0, zMd: 0 });
  const rotatedChildTranslation = [10 * parentRotation[0]![0]!, 10 * parentRotation[1]![0]!, 10 * parentRotation[2]![0]!];
  assert.deepEqual(childMatrix.translation, { xMm: 100, yMm: 30, zMm: 50 });
  assert.ok(Math.abs(childMatrix.translation.xMm - (100 + rotatedChildTranslation[0]!)) < 1e-9);
  assert.ok(Math.abs(childMatrix.translation.yMm - (20 + rotatedChildTranslation[1]!)) < 1e-9);
  assert.ok(Math.abs(childMatrix.translation.zMm - (50 + rotatedChildTranslation[2]!)) < 1e-9);
  assertMatrixClose(childMatrix.rotation, multiplyExpected(parentRotation, childRotation));
});

test("hierarchy rejects dangling and cyclic parents", () => {
  const dangling = object({ parentObjectId: "missing" });
  assert.throws(() => buildS7MatrixOracle(minimalHandoff({ objects: [dangling] })), (error) => errorCode(error) === "S7_HIERARCHY_INVALID");
  const first = object({ objectId: "first", identityKey: "first", parentObjectId: "second" });
  const second = object({ objectId: "second", identityKey: "second", parentObjectId: "first" });
  assert.throws(() => buildS7MatrixOracle(minimalHandoff({ objects: [first, second] })), (error) => errorCode(error) === "S7_HIERARCHY_CYCLE");
});

test("rectangular solids use all eight corners and exact degeneracy entities", () => {
  const area = buildS7GeometryPlan(minimalHandoff({ objects: [object({ transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 31000, yMd: 17000, zMd: 23000 } } })] })).entities.filter((item) => item.sourceObjectId === "object-1");
  assert.equal(area.filter((item) => item.entityType === "LWPOLYLINE").length, 1);
  const line = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 0, heightMm: 0 }, geometryState: "exact", localAnchor: "floor" } })] })).entities.find((item) => item.sourceObjectId === "object-1");
  assert.equal(line?.entityType, "LINE");
  const point = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 0, depthMm: 0, heightMm: 0 }, geometryState: "exact", localAnchor: "floor" } })] })).entities.find((item) => item.sourceObjectId === "object-1");
  assert.equal(point?.entityType, "POINT");
});

test("profile extrusion emits a complete union boundary without triangulation seams", () => {
  const profile = { kind: "profile_extrusion", profile: { winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1800, zMm: 0 }, { xMm: 1800, zMm: 400 }, { xMm: 1100, zMm: 400 }, { xMm: 1100, zMm: 900 }, { xMm: 0, zMm: 900 }] }, heightMm: 2200, geometryState: "exact", localAnchor: "floor" };
  const entities = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: profile })] })).entities.filter((item) => item.sourceObjectId === "object-1");
  assert.equal(entities.filter((item) => item.entityType === "LWPOLYLINE").length, 1);
  assert.equal(entities.filter((item) => item.entityType === "LINE").length, 0);
});

test("round projection uses analytic circle, ellipse arcs/tangents, and rank-degenerate hulls", () => {
  const circle = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "round_prism", radiusMm: 450, heightMm: 1100, geometryState: "exact", localAnchor: "floor" } })] })).entities.find((item) => item.sourceObjectId === "object-1");
  assert.equal(circle?.entityType, "CIRCLE");
  const analytic = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "round_prism", radiusMm: 450, heightMm: 1100, geometryState: "exact", localAnchor: "floor" }, transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 30000, yMd: 0, zMd: 0 } } })] })).entities.filter((item) => item.sourceObjectId === "object-1");
  assert.equal(analytic.filter((item) => item.entityType === "ELLIPSE").length, 2);
  assert.equal(analytic.filter((item) => item.entityType === "LINE").length, 2);
  const rankOne = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "round_prism", radiusMm: 450, heightMm: 1100, geometryState: "exact", localAnchor: "floor" }, transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 90000, yMd: 0, zMd: 0 } } })] })).entities.filter((item) => item.sourceObjectId === "object-1");
  assert.equal(rankOne.filter((item) => item.entityType === "LWPOLYLINE").length, 1);
  const zero = buildS7GeometryPlan(minimalHandoff({ objects: [object({ geometry: { kind: "round_prism", radiusMm: 0, heightMm: 0, geometryState: "exact", localAnchor: "floor" } })] })).entities.find((item) => item.sourceObjectId === "object-1");
  assert.equal(zero?.entityType, "POINT");
});

test("booth envelope remains closed and openings are north/east/south/west in locked layer order", () => {
  const entities = buildS7GeometryPlan(minimalHandoff({ openSides: ["west", "north", "east"] })).entities;
  assert.equal(entities[0]?.layer, "S7-BOOTH-BOUNDARY");
  assert.equal(entities[0]?.entityType, "LWPOLYLINE");
  const markers = entities.filter((item) => item.layer === "S7-BOOTH-OPENINGS");
  assert.deepEqual(markers.map((item) => item.identityKey), ["booth-opening:north", "booth-opening:east", "booth-opening:west"]);
  assert.deepEqual([...new Set(entities.map((item) => item.layer))], ["S7-BOOTH-BOUNDARY", "S7-BOOTH-OPENINGS", "S7-FURNITURE", "S7-DIMENSIONS", "S7-LABELS"]);
});

test("convex hull is deterministic and removes collinear interior points", () => {
  assert.deepEqual(deterministicConvexHull([{ xMm: 1, yMm: 1 }, { xMm: 0, yMm: 0 }, { xMm: 2, yMm: 0 }, { xMm: 2, yMm: 2 }, { xMm: 0, yMm: 2 }, { xMm: 1, yMm: 0 }]), [{ xMm: 0, yMm: 0 }, { xMm: 2, yMm: 0 }, { xMm: 2, yMm: 2 }, { xMm: 0, yMm: 2 }]);
});
