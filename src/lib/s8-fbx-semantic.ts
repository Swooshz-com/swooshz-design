import { AppError, type S6MaterialFinishRef, type S6RotationMd, type S6ToS7Handoff, type S7ToS8Handoff } from "./types";
import { buildS8Mesh, s8RoundSagitta, type S8Vec3 } from "./s8-fbx-geometry";
import { canonicalS8SourceJson } from "./s8-fbx-payload";
import { S8_PRECISION, s8Basis, s8LocalPositionTolerance, s8Sha256, s8StableName, s8WorldPositionTolerance } from "./s8-fbx-profile";

export type S8UfbxMaterial = {
  name: string;
  shadingModel: string;
  diffuse: [number, number, number];
  diffuseFactor: number;
  transparencyFactor: number;
  specularFactor: number;
  reflectionFactor: number;
  emissionFactor: number;
  ambientFactor: number;
  textureCount: number;
};

export type S8UfbxNode = {
  name: string;
  parent: string | null;
  nodeToParent: number[];
  nodeToWorld: number[];
  mesh: null | {
    vertices: [number, number, number][];
    triangles: [number, number, number][];
    cornerNormals: [number, number, number][];
    materialNames: string[];
  };
};

export type S8UfbxReadback = {
  schemaVersion: "s8-ufbx-readback-v1";
  fbxVersion: 7400;
  unitMeters: number;
  warningCount: 0;
  source: {
    revisionId: string;
    revisionHash: string;
    s6ValidationHash: string;
    s6HandoffDigest: string;
  };
  materials: S8UfbxMaterial[];
  nodes: S8UfbxNode[];
};

export type S8ErrorDistribution = { count: number; max: number; mean: number; p50: number; p95: number };
export type S8SemanticResult = {
  outcome: "pass";
  localPositionMm: S8ErrorDistribution;
  worldPositionMm: S8ErrorDistribution;
  dimensionMm: S8ErrorDistribution;
  matrixElement: S8ErrorDistribution;
  normalAngularDegrees: S8ErrorDistribution;
  roundSagittaMm: S8ErrorDistribution;
};

type Mat4 = number[];

function fail(code: string, field = "readback"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function stats(values: number[]): S8ErrorDistribution {
  if (values.length === 0) return { count: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))]!;
  return { count: values.length, max: sorted[sorted.length - 1]!, mean: values.reduce((sum, value) => sum + value, 0) / values.length, p50: percentile(0.5), p95: percentile(0.95) };
}

function multiply3(left: number[][], right: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) =>
    left[row]![0]! * right[0]![column]! + left[row]![1]! * right[1]![column]! + left[row]![2]! * right[2]![column]!));
}

function transpose3(value: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => value[column]![row]!));
}

function rotationMatrix(rotation: S6RotationMd): number[][] {
  const rx = rotation.xMd * Math.PI / 180_000;
  const ry = rotation.yMd * Math.PI / 180_000;
  const rz = rotation.zMd * Math.PI / 180_000;
  const x = [[1, 0, 0], [0, Math.cos(rx), -Math.sin(rx)], [0, Math.sin(rx), Math.cos(rx)]];
  const y = [[Math.cos(ry), 0, Math.sin(ry)], [0, 1, 0], [-Math.sin(ry), 0, Math.cos(ry)]];
  const z = [[Math.cos(rz), -Math.sin(rz), 0], [Math.sin(rz), Math.cos(rz), 0], [0, 0, 1]];
  return multiply3(multiply3(z, y), x);
}

function localMatrix(position: { xMm: number; yMm: number; zMm: number }, rotation: S6RotationMd): Mat4 {
  const basis = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  const r = multiply3(multiply3(basis, rotationMatrix(rotation)), transpose3(basis));
  const t = s8Basis([position.xMm, position.yMm, position.zMm]);
  return [r[0]![0]!, r[0]![1]!, r[0]![2]!, t[0], r[1]![0]!, r[1]![1]!, r[1]![2]!, t[1], r[2]![0]!, r[2]![1]!, r[2]![2]!, t[2], 0, 0, 0, 1];
}

function multiply4(left: Mat4, right: Mat4): Mat4 {
  return Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    return left[row * 4]! * right[column]! + left[row * 4 + 1]! * right[4 + column]! + left[row * 4 + 2]! * right[8 + column]! + left[row * 4 + 3]! * right[12 + column]!;
  });
}

function ufbxMatrixToRowMajor(value: number[]): Mat4 {
  if (!Array.isArray(value) || value.length !== 12 || value.some((item) => !Number.isFinite(item))) fail("S8_MATRIX_INVALID");
  return [value[0]!, value[3]!, value[6]!, value[9]!, value[1]!, value[4]!, value[7]!, value[10]!, value[2]!, value[5]!, value[8]!, value[11]!, 0, 0, 0, 1];
}

function transform(matrix: Mat4, point: S8Vec3): S8Vec3 {
  return [
    matrix[0]! * point[0] + matrix[1]! * point[1] + matrix[2]! * point[2] + matrix[3]!,
    matrix[4]! * point[0] + matrix[5]! * point[1] + matrix[6]! * point[2] + matrix[7]!,
    matrix[8]! * point[0] + matrix[9]! * point[1] + matrix[10]! * point[2] + matrix[11]!,
  ];
}

function angleDegrees(left: S8Vec3, right: S8Vec3): number {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  if (leftLength === 0 || rightLength === 0) fail("S8_NORMAL_INVALID");
  const dot = (left[0] * right[0] + left[1] * right[1] + left[2] * right[2]) / (leftLength * rightLength);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function materialName(materialId: string): string {
  return `SWZ_MAT_${s8Sha256(materialId).slice(0, 16)}`;
}

function expectedColor(material: S6MaterialFinishRef): [number, number, number] {
  if (material.colorHex && /^#[0-9a-fA-F]{6}$/.test(material.colorHex)) {
    return [Number.parseInt(material.colorHex.slice(1, 3), 16) / 255, Number.parseInt(material.colorHex.slice(3, 5), 16) / 255, Number.parseInt(material.colorHex.slice(5, 7), 16) / 255];
  }
  return [0.62, 0.62, 0.62];
}

export function compareS8UfbxReadback(s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback): S8SemanticResult {
  if (s7.projectId !== s6.projectId || s7.sourceRevisionId !== s6.acceptedRevisionId || s7.sourceRevisionHash !== s6.acceptedRevisionHash) fail("S8_SOURCE_BINDING_MISMATCH");
  if (readback.schemaVersion !== "s8-ufbx-readback-v1" || readback.fbxVersion !== 7400 || readback.warningCount !== 0 || Math.abs(readback.unitMeters - 0.001) > 1e-9) fail("S8_FBX_PROFILE_INVALID");
  const expectedHandoffDigest = s8Sha256(canonicalS8SourceJson(s6));
  if (readback.source.revisionId !== s6.acceptedRevisionId || readback.source.revisionHash !== s6.acceptedRevisionHash || readback.source.s6ValidationHash !== s6.validationReceipt.validationHash || readback.source.s6HandoffDigest !== expectedHandoffDigest) fail("S8_SOURCE_BINDING_MISMATCH");
  const sorted = s6.objects.slice().sort((a, b) => Buffer.compare(Buffer.from(a.objectId), Buffer.from(b.objectId)));
  const names = new Map(sorted.map((object, index) => [object.objectId, s8StableName(index, object.objectId)]));
  const observed = new Map(readback.nodes.map((node) => [node.name, node]));
  const expectedNames = new Set(["SWZ_ROOT", ...names.values()]);
  if (observed.size !== expectedNames.size || [...expectedNames].some((name) => !observed.has(name))) fail("S8_OBJECT_SET_MISMATCH");
  const expectedLocals = new Map<string, Mat4>();
  const expectedWorlds = new Map<string, Mat4>();
  expectedLocals.set("SWZ_ROOT", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expectedWorlds.set("SWZ_ROOT", expectedLocals.get("SWZ_ROOT")!);
  const localErrors: number[] = [];
  const worldErrors: number[] = [];
  const dimensionErrors: number[] = [];
  const matrixErrors: number[] = [];
  const normalErrors: number[] = [];
  const sagittaValues: number[] = [];
  const remaining = new Set(sorted.map((item) => item.objectId));
  while (remaining.size) {
    let progressed = false;
    for (const objectId of [...remaining]) {
      const sourceObject = sorted.find((item) => item.objectId === objectId)!;
      const parentName = sourceObject.parentObjectId === null ? "SWZ_ROOT" : names.get(sourceObject.parentObjectId);
      if (!parentName || !expectedWorlds.has(parentName)) continue;
      const name = names.get(objectId)!;
      const node = observed.get(name)!;
      if (node.parent !== parentName || node.mesh === null) fail("S8_HIERARCHY_IDENTITY_MISMATCH");
      const local = localMatrix(sourceObject.transform.positionMm, sourceObject.transform.rotationMd);
      const world = multiply4(expectedWorlds.get(parentName)!, local);
      expectedLocals.set(name, local);
      expectedWorlds.set(name, world);
      const observedLocal = ufbxMatrixToRowMajor(node.nodeToParent);
      const observedWorld = ufbxMatrixToRowMajor(node.nodeToWorld);
      for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
        const error = Math.abs(observedLocal[index]! - local[index]!);
        matrixErrors.push(error);
        if (error > S8_PRECISION.matrixElement) fail("S8_MATRIX_TOLERANCE_EXCEEDED");
      }
      const expectedMesh = buildS8Mesh(sourceObject.geometry);
      if (node.mesh.vertices.length !== expectedMesh.verticesMm.length || node.mesh.triangles.length !== expectedMesh.triangles.length || node.mesh.cornerNormals.length !== expectedMesh.cornerNormals.length) fail("S8_TOPOLOGY_MISMATCH");
      for (let index = 0; index < expectedMesh.verticesMm.length; index += 1) {
        const expected = expectedMesh.verticesMm[index]!;
        const actual = node.mesh.vertices[index]!;
        for (let component = 0; component < 3; component += 1) {
          const error = Math.abs(actual[component]! - expected[component]!);
          localErrors.push(error);
          if (error > s8LocalPositionTolerance(expected[component]!)) fail("S8_LOCAL_POSITION_TOLERANCE_EXCEEDED");
        }
        const expectedWorld = transform(world, expected);
        const actualWorld = transform(observedWorld, actual);
        for (let component = 0; component < 3; component += 1) {
          const error = Math.abs(actualWorld[component]! - expectedWorld[component]!);
          worldErrors.push(error);
          if (error > s8WorldPositionTolerance(expectedWorld[component]!)) fail("S8_WORLD_POSITION_TOLERANCE_EXCEEDED");
        }
      }
      for (let index = 0; index < expectedMesh.triangles.length; index += 1) {
        if (node.mesh.triangles[index]!.some((value, component) => value !== expectedMesh.triangles[index]![component])) fail("S8_ORIENTED_TRIANGLE_MISMATCH");
      }
      for (let index = 0; index < expectedMesh.cornerNormals.length; index += 1) {
        const angular = angleDegrees(node.mesh.cornerNormals[index]!, expectedMesh.cornerNormals[index]!);
        normalErrors.push(angular);
        if (angular > S8_PRECISION.normalDegrees) fail("S8_NORMAL_TOLERANCE_EXCEEDED");
      }
      const expectedMin = [0, 1, 2].map((component) => Math.min(...expectedMesh.verticesMm.map((vertex) => vertex[component]!)));
      const expectedMax = [0, 1, 2].map((component) => Math.max(...expectedMesh.verticesMm.map((vertex) => vertex[component]!)));
      const actualMin = [0, 1, 2].map((component) => Math.min(...node.mesh!.vertices.map((vertex) => vertex[component]!)));
      const actualMax = [0, 1, 2].map((component) => Math.max(...node.mesh!.vertices.map((vertex) => vertex[component]!)));
      for (let component = 0; component < 3; component += 1) {
        const error = Math.abs((actualMax[component]! - actualMin[component]!) - (expectedMax[component]! - expectedMin[component]!));
        dimensionErrors.push(error);
        if (error > S8_PRECISION.dimensionMm) fail("S8_DIMENSION_TOLERANCE_EXCEEDED");
      }
      if (expectedMesh.roundSegments !== null && sourceObject.geometry.kind === "round_prism") {
        const sagitta = s8RoundSagitta(sourceObject.geometry.radiusMm, expectedMesh.roundSegments);
        sagittaValues.push(sagitta);
        if (sagitta > S8_PRECISION.roundSagittaMm) fail("S8_ROUND_SAGITTA_EXCEEDED");
      }
      const materialIds = sourceObject.materialIds.slice().sort();
      const expectedMaterialNames = materialIds[0] && s6.materials.some((material) => material.materialId === materialIds[0]) ? [materialName(materialIds[0])] : [];
      if (JSON.stringify(node.mesh.materialNames) !== JSON.stringify(expectedMaterialNames)) fail("S8_PREVIEW_MATERIAL_ASSIGNMENT_MISMATCH");
      remaining.delete(objectId);
      progressed = true;
    }
    if (!progressed) fail("S8_HIERARCHY_CYCLE");
  }
  const expectedMaterialIds = [...new Set(sorted.flatMap((object) => object.materialIds.slice().sort().slice(0, 1)).filter((id) => s6.materials.some((material) => material.materialId === id)))].sort();
  if (readback.materials.length !== expectedMaterialIds.length) fail("S8_PREVIEW_MATERIAL_SET_MISMATCH");
  for (const id of expectedMaterialIds) {
    const source = s6.materials.find((item) => item.materialId === id)!;
    const actual = readback.materials.find((item) => item.name === materialName(id));
    if (!actual || actual.shadingModel.toLowerCase() !== "phong" || actual.textureCount !== 0) fail("S8_PREVIEW_MATERIAL_INVALID");
    const color = expectedColor(source);
    for (let component = 0; component < 3; component += 1) if (Math.abs(actual.diffuse[component]! - color[component]!) > 5e-6) fail("S8_PREVIEW_MATERIAL_INVALID");
    for (const value of [actual.transparencyFactor, actual.specularFactor, actual.reflectionFactor, actual.emissionFactor, actual.ambientFactor]) if (Math.abs(value) > 5e-6) fail("S8_PREVIEW_MATERIAL_INVALID");
    if (Math.abs(actual.diffuseFactor - 1) > 5e-6) fail("S8_PREVIEW_MATERIAL_INVALID");
  }
  return { outcome: "pass", localPositionMm: stats(localErrors), worldPositionMm: stats(worldErrors), dimensionMm: stats(dimensionErrors), matrixElement: stats(matrixErrors), normalAngularDegrees: stats(normalErrors), roundSagittaMm: stats(sagittaValues) };
}
