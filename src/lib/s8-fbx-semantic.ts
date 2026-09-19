import { AppError, type S6MaterialFinishRef, type S6ToS7Handoff, type S7ToS8Handoff } from "./types";
import { buildS8Mesh, s8RoundSagitta, type S8Vec3 } from "./s8-fbx-geometry";
import { buildS8TransformOracle, canonicalS8SourceJson, s8Multiply4, s8TransformPoint, type S8Mat4 } from "./s8-fbx-oracle";
import { S8_PRECISION, s8Sha256, s8StableName, s8LocalPositionTolerance, s8WorldPositionTolerance } from "./s8-fbx-profile";

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
  sourceObjectId?: string;
  identityKey?: string;
  effectiveScale: [number, number, number];
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
  worldBoundMm: S8ErrorDistribution;
  matrixElement: S8ErrorDistribution;
  normalAngularDegrees: S8ErrorDistribution;
  roundSagittaMm: S8ErrorDistribution;
};

function fail(code: string, field = "readback"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function stats(values: number[]): S8ErrorDistribution {
  if (values.length === 0) return { count: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))]!;
  return { count: values.length, max: sorted[sorted.length - 1]!, mean: values.reduce((sum, item) => sum + item, 0) / values.length, p50: percentile(0.5), p95: percentile(0.95) };
}

function ufbxMatrixToRowMajor(value: number[]): S8Mat4 {
  if (!Array.isArray(value) || value.length !== 12 || value.some((item) => !Number.isFinite(item))) fail("S8_MATRIX_INVALID");
  return [value[0]!, value[3]!, value[6]!, value[9]!, value[1]!, value[4]!, value[7]!, value[10]!, value[2]!, value[5]!, value[8]!, value[11]!, 0, 0, 0, 1];
}

function transformError(expected: number, actual: number, tolerance: number, code: string, field: string): number {
  const error = Math.abs(actual - expected);
  if (error > tolerance) fail(code, field);
  return error;
}

function angleDegrees(left: S8Vec3, right: S8Vec3): number {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  if (leftLength === 0 || rightLength === 0) fail("S8_NORMAL_INVALID");
  const dot = (left[0] * right[0] + left[1] * right[1] + left[2] * right[2]) / (leftLength * rightLength);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  if (dot < 0 || angle >= 90) fail("S8_NORMAL_FLIPPED");
  return angle;
}

function materialName(materialId: string): string {
  return `SWZ_MAT_${s8Sha256(materialId).slice(0, 16)}`;
}

function expectedColor(material: S6MaterialFinishRef): [number, number, number] {
  if (material.colorHex && /^#[0-9a-fA-F]{6}$/u.test(material.colorHex)) {
    return [Number.parseInt(material.colorHex.slice(1, 3), 16) / 255, Number.parseInt(material.colorHex.slice(3, 5), 16) / 255, Number.parseInt(material.colorHex.slice(5, 7), 16) / 255];
  }
  return [0.62, 0.62, 0.62];
}

function identityMatrix(value: S8Mat4, field: string): void {
  const expected: S8Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let index = 0; index < 16; index += 1) if (value[index] !== expected[index]) fail("S8_ROOT_IDENTITY_INVALID", `${field}.${index}`);
}

function bounds(points: readonly S8Vec3[]): { min: S8Vec3; max: S8Vec3 } {
  if (points.length === 0) fail("S8_MESH_INVALID");
  return {
    min: [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.min(...points.map((point) => point[2]))],
    max: [Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1])), Math.max(...points.map((point) => point[2]))],
  };
}

export function compareS8UfbxReadback(s6: S6ToS7Handoff, s7: S7ToS8Handoff, readback: S8UfbxReadback): S8SemanticResult {
  if (s7.projectId !== s6.projectId || s7.sourceRevisionId !== s6.acceptedRevisionId || s7.sourceRevisionHash !== s6.acceptedRevisionHash || s7.sourceS5Fingerprint !== s6.sourceS5Fingerprint) fail("S8_SOURCE_BINDING_MISMATCH");
  if (readback.schemaVersion !== "s8-ufbx-readback-v1" || readback.fbxVersion !== 7400 || readback.warningCount !== 0 || Math.abs(readback.unitMeters - 0.001) > 1e-9) fail("S8_FBX_PROFILE_INVALID");
  const expectedHandoffDigest = s8Sha256(canonicalS8SourceJson(s6));
  if (readback.source.revisionId !== s6.acceptedRevisionId || readback.source.revisionHash !== s6.acceptedRevisionHash || readback.source.s6ValidationHash !== s6.validationReceipt.validationHash || readback.source.s6HandoffDigest !== expectedHandoffDigest) fail("S8_SOURCE_BINDING_MISMATCH");

  const sorted = s6.objects.slice().sort((left, right) => Buffer.compare(Buffer.from(left.objectId, "utf8"), Buffer.from(right.objectId, "utf8")));
  const oracle = buildS8TransformOracle(s6);
  const names = new Map(sorted.map((object, index) => [object.objectId, s8StableName(index, object.objectId)]));
  if (readback.nodes.length !== sorted.length + 1) fail("S8_OBJECT_SET_MISMATCH");
  const observed = new Map<string, S8UfbxNode>();
  for (const node of readback.nodes) {
    if (observed.has(node.name)) fail("S8_OBJECT_SET_MISMATCH");
    observed.set(node.name, node);
  }
  const expectedNames = new Set(["SWZ_ROOT", ...names.values()]);
  if (observed.size !== expectedNames.size || [...expectedNames].some((name) => !observed.has(name))) fail("S8_OBJECT_SET_MISMATCH");
  const observedRoot = observed.get("SWZ_ROOT")!;
  if (observedRoot.parent !== null || observedRoot.mesh !== null || observedRoot.effectiveScale.some((value) => value !== 1)) fail("S8_ROOT_IDENTITY_INVALID");
  identityMatrix(ufbxMatrixToRowMajor(observedRoot.nodeToParent), "root.nodeToParent");
  identityMatrix(ufbxMatrixToRowMajor(observedRoot.nodeToWorld), "root.nodeToWorld");
  if (readback.nodes.filter((node) => node.parent === null).length !== 1) fail("S8_HIERARCHY_IDENTITY_MISMATCH");

  const localErrors: number[] = [];
  const worldErrors: number[] = [];
  const dimensionErrors: number[] = [];
  const boundErrors: number[] = [];
  const matrixErrors: number[] = [];
  const normalErrors: number[] = [];
  const sagittaValues: number[] = [];

  for (const sourceObject of sorted) {
    const name = names.get(sourceObject.objectId)!;
    const node = observed.get(name)!;
    const expectedParentName = sourceObject.parentObjectId === null ? "SWZ_ROOT" : names.get(sourceObject.parentObjectId);
    if (!expectedParentName || node.parent !== expectedParentName || node.mesh === null) fail("S8_HIERARCHY_IDENTITY_MISMATCH", `nodes.${name}.parent`);
    if (node.sourceObjectId !== undefined && node.sourceObjectId !== sourceObject.objectId) fail("S8_SOURCE_IDENTITY_MISMATCH", `nodes.${name}.sourceObjectId`);
    if (node.effectiveScale.length !== 3 || node.effectiveScale.some((value) => value !== 1)) fail("S8_EXACT_SCALE_INVALID", `nodes.${name}.effectiveScale`);
    const transformOracle = oracle.get(sourceObject.objectId)!;
    const observedLocal = ufbxMatrixToRowMajor(node.nodeToParent);
    const observedWorld = ufbxMatrixToRowMajor(node.nodeToWorld);
    const expectedWorld = transformOracle.worldMatrix;
    for (let index = 0; index < 16; index += 1) {
      const isBottom = index >= 12;
      const isLocalTranslation = index === 3 || index === 7 || index === 11;
      const localTolerance = isBottom ? 0 : isLocalTranslation ? s8LocalPositionTolerance(transformOracle.localMatrix[index]!) : S8_PRECISION.matrixElement;
      const worldTolerance = isBottom ? 0 : (index === 3 || index === 7 || index === 11) ? s8WorldPositionTolerance(expectedWorld[index]!) : S8_PRECISION.matrixElement;
      if (isBottom) {
        if (observedLocal[index] !== transformOracle.localMatrix[index] || observedWorld[index] !== expectedWorld[index]) fail("S8_HOMOGENEOUS_ROW_INVALID", `nodes.${name}.matrix.${index}`);
      } else {
        matrixErrors.push(transformError(transformOracle.localMatrix[index]!, observedLocal[index]!, localTolerance, isLocalTranslation ? "S8_LOCAL_POSITION_TOLERANCE_EXCEEDED" : "S8_MATRIX_TOLERANCE_EXCEEDED", `nodes.${name}.nodeToParent.${index}`));
        matrixErrors.push(transformError(expectedWorld[index]!, observedWorld[index]!, worldTolerance, index === 3 || index === 7 || index === 11 ? "S8_WORLD_POSITION_TOLERANCE_EXCEEDED" : "S8_MATRIX_TOLERANCE_EXCEEDED", `nodes.${name}.nodeToWorld.${index}`));
      }
    }
    const expectedMesh = buildS8Mesh(sourceObject.geometry);
    const actualMesh = node.mesh;
    if (actualMesh.vertices.length !== expectedMesh.verticesMm.length || actualMesh.triangles.length !== expectedMesh.triangles.length || actualMesh.cornerNormals.length !== expectedMesh.cornerNormals.length) fail("S8_TOPOLOGY_MISMATCH", `nodes.${name}.mesh`);
    const expectedWorldVertices: S8Vec3[] = [];
    const actualWorldVertices: S8Vec3[] = [];
    for (let index = 0; index < expectedMesh.verticesMm.length; index += 1) {
      const expected = expectedMesh.verticesMm[index]!;
      const actual = actualMesh.vertices[index]!;
      for (let component = 0; component < 3; component += 1) localErrors.push(transformError(expected[component]!, actual[component]!, s8LocalPositionTolerance(expected[component]!), "S8_LOCAL_POSITION_TOLERANCE_EXCEEDED", `nodes.${name}.vertices.${index}.${component}`));
      expectedWorldVertices.push(s8TransformPoint(expectedWorld, expected));
      actualWorldVertices.push(s8TransformPoint(observedWorld, actual));
      for (let component = 0; component < 3; component += 1) worldErrors.push(transformError(expectedWorldVertices[index]![component]!, actualWorldVertices[index]![component]!, s8WorldPositionTolerance(expectedWorldVertices[index]![component]!), "S8_WORLD_POSITION_TOLERANCE_EXCEEDED", `nodes.${name}.worldVertices.${index}.${component}`));
    }
    for (let index = 0; index < expectedMesh.triangles.length; index += 1) if (actualMesh.triangles[index]!.some((value, component) => value !== expectedMesh.triangles[index]![component])) fail("S8_ORIENTED_TRIANGLE_MISMATCH", `nodes.${name}.triangles.${index}`);
    for (let index = 0; index < expectedMesh.cornerNormals.length; index += 1) {
      const angular = angleDegrees(actualMesh.cornerNormals[index]!, expectedMesh.cornerNormals[index]!);
      normalErrors.push(angular);
      if (angular > S8_PRECISION.normalDegrees) fail("S8_NORMAL_TOLERANCE_EXCEEDED", `nodes.${name}.normals.${index}`);
    }
    const expectedLocalBounds = bounds(expectedMesh.verticesMm);
    const actualLocalBounds = bounds(actualMesh.vertices);
    const expectedWorldBounds = bounds(expectedWorldVertices);
    const actualWorldBounds = bounds(actualWorldVertices);
    for (let component = 0; component < 3; component += 1) {
      dimensionErrors.push(transformError(expectedWorldBounds.max[component] - expectedWorldBounds.min[component], actualWorldBounds.max[component] - actualWorldBounds.min[component], S8_PRECISION.dimensionMm, "S8_DIMENSION_TOLERANCE_EXCEEDED", `nodes.${name}.dimensions.${component}`));
      boundErrors.push(transformError(expectedWorldBounds.min[component], actualWorldBounds.min[component], S8_PRECISION.worldPositionAbsoluteMm, "S8_ABSOLUTE_WORLD_BOUND_TOLERANCE_EXCEEDED", `nodes.${name}.bounds.min.${component}`));
      boundErrors.push(transformError(expectedWorldBounds.max[component], actualWorldBounds.max[component], S8_PRECISION.worldPositionAbsoluteMm, "S8_ABSOLUTE_WORLD_BOUND_TOLERANCE_EXCEEDED", `nodes.${name}.bounds.max.${component}`));
      if (Math.abs((actualLocalBounds.max[component] - actualLocalBounds.min[component]) - (expectedLocalBounds.max[component] - expectedLocalBounds.min[component])) > S8_PRECISION.dimensionMm) fail("S8_DIMENSION_TOLERANCE_EXCEEDED", `nodes.${name}.localDimensions.${component}`);
    }
    if (expectedMesh.roundSegments !== null && sourceObject.geometry.kind === "round_prism") {
      const sagitta = s8RoundSagitta(sourceObject.geometry.radiusMm, expectedMesh.roundSegments);
      sagittaValues.push(sagitta);
      if (sagitta > S8_PRECISION.roundSagittaMm) fail("S8_ROUND_SAGITTA_EXCEEDED");
    }
    const materialIds = sourceObject.materialIds.slice().sort();
    const expectedMaterialNames = materialIds[0] && s6.materials.some((material) => material.materialId === materialIds[0]) ? [materialName(materialIds[0])] : [];
    if (JSON.stringify(actualMesh.materialNames) !== JSON.stringify(expectedMaterialNames)) fail("S8_PREVIEW_MATERIAL_ASSIGNMENT_MISMATCH", `nodes.${name}.materials`);
  }

  const expectedMaterialIds = [...new Set(sorted.flatMap((object) => object.materialIds.slice().sort().slice(0, 1)).filter((id) => s6.materials.some((material) => material.materialId === id)))].sort();
  if (readback.materials.length !== expectedMaterialIds.length) fail("S8_PREVIEW_MATERIAL_SET_MISMATCH");
  for (const id of expectedMaterialIds) {
    const source = s6.materials.find((item) => item.materialId === id)!;
    const actual = readback.materials.find((item) => item.name === materialName(id));
    if (!actual || actual.shadingModel.toLowerCase() !== "phong" || actual.textureCount !== 0) fail("S8_PREVIEW_MATERIAL_INVALID");
    const color = expectedColor(source);
    for (let component = 0; component < 3; component += 1) if (Math.abs(actual.diffuse[component]! - color[component]!) > S8_PRECISION.matrixElement) fail("S8_PREVIEW_MATERIAL_INVALID");
    for (const value of [actual.transparencyFactor, actual.specularFactor, actual.reflectionFactor, actual.emissionFactor, actual.ambientFactor]) if (Math.abs(value) > S8_PRECISION.matrixElement) fail("S8_PREVIEW_MATERIAL_INVALID");
    if (Math.abs(actual.diffuseFactor - 1) > S8_PRECISION.matrixElement) fail("S8_PREVIEW_MATERIAL_INVALID");
  }
  return { outcome: "pass", localPositionMm: stats(localErrors), worldPositionMm: stats(worldErrors), dimensionMm: stats(dimensionErrors), worldBoundMm: stats(boundErrors), matrixElement: stats(matrixErrors), normalAngularDegrees: stats(normalErrors), roundSagittaMm: stats(sagittaValues) };
}

export function composeS8WorldMatrix(parent: S8Mat4, local: S8Mat4): S8Mat4 {
  return s8Multiply4(parent, local);
}
