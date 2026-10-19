import { createHash } from "node:crypto";
import { AppError, type S6RotationMd, type S6ToS7Handoff } from "./types";
import { jcs } from "./utils";

export type S8Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type S8TransformOracle = {
  objectId: string;
  parentObjectId: string | null;
  localTranslationMm: [number, number, number];
  rotationMatrix: number[][];
  localMatrix: S8Mat4;
  worldMatrix: S8Mat4;
  unitScale: [1, 1, 1];
  sourceEulerMicrodegrees: [number, number, number];
  matrixTicks: number[];
  transformDigest: string;
};

const POSITION_SCALE = 1_000_000;
const UNIT_SCALE = 10_000_000_000;
const SINGULAR_COSINE = 2 ** -48;
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code: string, field = "transform"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) fail("S8_TRANSFORM_ORACLE_MISMATCH", field);
  return value;
}

function quantize(value: number, scale: number, field: string): number {
  const result = Math.floor(finite(value, field) * scale + 0.5);
  if (!Number.isSafeInteger(result)) fail("S8_TRANSFORM_ORACLE_MISMATCH", field);
  return Object.is(result, -0) ? 0 : result;
}

export function s8Quantize(value: number, scale: number): number {
  return quantize(value, scale, "value");
}

export function s8Multiply3(left: number[][], right: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) =>
    left[row]![0]! * right[0]![column]! +
    left[row]![1]! * right[1]![column]! +
    left[row]![2]! * right[2]![column]!,
  ));
}

function transpose3(value: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => value[column]![row]!));
}

export const S8_BASIS: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]] = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];

export function s8BasisTransform(value: readonly [number, number, number]): [number, number, number] {
  return [finite(value[0]!, "position.x"), -finite(value[2]!, "position.z"), finite(value[1]!, "position.y")];
}

export function s8RotationMatrix(rotation: S6RotationMd): number[][] {
  const rx = finite(rotation.xMd, "rotation.xMd") * Math.PI / 180_000;
  const ry = finite(rotation.yMd, "rotation.yMd") * Math.PI / 180_000;
  const rz = finite(rotation.zMd, "rotation.zMd") * Math.PI / 180_000;
  const x = [[1, 0, 0], [0, Math.cos(rx), -Math.sin(rx)], [0, Math.sin(rx), Math.cos(rx)]];
  const y = [[Math.cos(ry), 0, Math.sin(ry)], [0, 1, 0], [-Math.sin(ry), 0, Math.cos(ry)]];
  const z = [[Math.cos(rz), -Math.sin(rz), 0], [Math.sin(rz), Math.cos(rz), 0], [0, 0, 1]];
  return s8Multiply3(s8Multiply3(z, y), x);
}

export function s8SourceRigidRotation(rotation: S6RotationMd): number[][] {
  return s8Multiply3(s8Multiply3(S8_BASIS.map((row) => [...row]), s8RotationMatrix(rotation)), transpose3(S8_BASIS.map((row) => [...row])));
}

function canonicalMicrodegrees(radians: number): number {
  finite(radians, "rotation");
  const fullTurn = 360 * 1_000_000;
  const halfTurn = 180 * 1_000_000;
  let value = Math.floor(radians * 180 * 1_000_000 / Math.PI + 0.5);
  while (value > halfTurn) value -= fullTurn;
  while (value <= -halfTurn) value += fullTurn;
  if (!Number.isSafeInteger(value)) fail("S8_TRANSFORM_ORACLE_MISMATCH", "rotation");
  return Object.is(value, -0) ? 0 : value;
}

export function s8ExtractFrozenEuler(rotation: number[][]): [number, number, number] {
  const cy = Math.hypot(rotation[0]![0]!, rotation[1]![0]!);
  let x: number;
  let y: number;
  let z: number;
  if (cy > SINGULAR_COSINE) {
    x = Math.atan2(rotation[2]![1]!, rotation[2]![2]!);
    y = Math.atan2(-rotation[2]![0]!, cy);
    z = Math.atan2(rotation[1]![0]!, rotation[0]![0]!);
  } else {
    x = Math.atan2(-rotation[1]![2]!, rotation[1]![1]!);
    y = Math.atan2(-rotation[2]![0]!, cy);
    z = 0;
  }
  return [canonicalMicrodegrees(x), canonicalMicrodegrees(y), canonicalMicrodegrees(z)];
}

export function s8LocalMatrix(position: readonly [number, number, number], rotation: S6RotationMd): S8Mat4 {
  const r = s8SourceRigidRotation(rotation);
  const t = s8BasisTransform(position);
  return [
    r[0]![0]!, r[0]![1]!, r[0]![2]!, t[0],
    r[1]![0]!, r[1]![1]!, r[1]![2]!, t[1],
    r[2]![0]!, r[2]![1]!, r[2]![2]!, t[2],
    0, 0, 0, 1,
  ];
}

export function s8Multiply4(left: S8Mat4, right: S8Mat4): S8Mat4 {
  return Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    return left[row * 4]! * right[column]! +
      left[row * 4 + 1]! * right[4 + column]! +
      left[row * 4 + 2]! * right[8 + column]! +
      left[row * 4 + 3]! * right[12 + column]!;
  }) as S8Mat4;
}

export function s8TransformPoint(matrix: S8Mat4, point: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * point[0]! + matrix[1]! * point[1]! + matrix[2]! * point[2]! + matrix[3]!,
    matrix[4]! * point[0]! + matrix[5]! * point[1]! + matrix[6]! * point[2]! + matrix[7]!,
    matrix[8]! * point[0]! + matrix[9]! * point[1]! + matrix[10]! * point[2]! + matrix[11]!,
  ];
}

function matrixTicks(matrix: S8Mat4): number[] {
  return matrix.map((value, index) => index % 4 === 3 && index < 12 ? quantize(value, POSITION_SCALE, `matrix.${index}`) : quantize(value, UNIT_SCALE, `matrix.${index}`));
}

function digest(value: unknown): string {
  return createHash("sha256").update(jcs(value)).digest("hex");
}

export function canonicalS8SourceJson(value: unknown): string {
  return jcs(value);
}

export function buildS8TransformOracle(s6: S6ToS7Handoff): Map<string, S8TransformOracle> {
  if (s6.schemaVersion !== "s6-to-s7-handoff-v1") fail("S8_SOURCE_INVALID", "source.schemaVersion");
  const byId = new Map(s6.objects.map((object) => [object.objectId, object]));
  if (byId.size !== s6.objects.length) fail("S8_HIERARCHY_INVALID", "source.objects");
  const result = new Map<string, S8TransformOracle>();
  const identity: S8Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const resolving = new Set<string>();
  const resolve = (objectId: string | null): S8TransformOracle | null => {
    if (objectId === null) return null;
    const existing = result.get(objectId);
    if (existing) return existing;
    if (resolving.has(objectId)) fail("S8_HIERARCHY_CYCLE", `source.objects.${objectId}`);
    const object = byId.get(objectId);
    if (!object) fail("S8_HIERARCHY_INVALID", `source.objects.${objectId}`);
    resolving.add(objectId);
    const position: [number, number, number] = [object.transform.positionMm.xMm, object.transform.positionMm.yMm, object.transform.positionMm.zMm];
    const rotation = s8SourceRigidRotation(object.transform.rotationMd);
    const local = s8LocalMatrix(position, object.transform.rotationMd);
    const parent = resolve(object.parentObjectId);
    const world = parent ? s8Multiply4(parent.worldMatrix, local) : local;
    const sourceEuler = s8ExtractFrozenEuler(rotation);
    const item: S8TransformOracle = {
      objectId,
      parentObjectId: object.parentObjectId,
      localTranslationMm: s8BasisTransform(position),
      rotationMatrix: rotation,
      localMatrix: local,
      worldMatrix: world,
      unitScale: [1, 1, 1],
      sourceEulerMicrodegrees: sourceEuler,
      matrixTicks: matrixTicks(local),
      transformDigest: digest({ objectId, parentObjectId: object.parentObjectId, localMatrix: local, worldMatrix: world, unitScale: [1, 1, 1] }),
    };
    resolving.delete(objectId);
    result.set(objectId, item);
    return item;
  };
  for (const object of s6.objects) resolve(object.objectId);
  const root: S8TransformOracle = {
    objectId: "SWZ_ROOT",
    parentObjectId: null,
    localTranslationMm: [0, 0, 0],
    rotationMatrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    localMatrix: identity,
    worldMatrix: identity,
    unitScale: [1, 1, 1],
    sourceEulerMicrodegrees: [0, 0, 0],
    matrixTicks: identity.map((value, index) => index % 4 === 3 && index < 12 ? 0 : quantize(value, UNIT_SCALE, `root.matrix.${index}`)),
    transformDigest: digest({ objectId: "SWZ_ROOT", parentObjectId: null, localMatrix: identity, worldMatrix: identity, unitScale: [1, 1, 1] }),
  };
  result.set("SWZ_ROOT", root);
  return result;
}

export function assertS8TransformOracle(
  oracle: S8TransformOracle,
  redundant: {
    localTranslationTicks: readonly number[];
    sourceEulerMicrodegrees: readonly number[];
    unitScaleTicks: readonly number[];
    matrixTicks: readonly number[];
    transformDigest?: string;
  },
  field = "transform",
): void {
  const expected = oracle;
  const exact = (left: readonly number[], right: readonly number[], child: string) => {
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) fail("S8_TRANSFORM_ORACLE_MISMATCH", `${field}.${child}`);
  };
  exact(redundant.localTranslationTicks, expected.localTranslationMm.map((value) => quantize(value, POSITION_SCALE, `${field}.translation`)), "localTranslationTicks");
  exact(redundant.sourceEulerMicrodegrees, expected.sourceEulerMicrodegrees, "sourceEulerMicrodegrees");
  exact(redundant.unitScaleTicks, [UNIT_SCALE, UNIT_SCALE, UNIT_SCALE], "unitScaleTicks");
  exact(redundant.matrixTicks, expected.matrixTicks, "matrixTicks");
  if (redundant.transformDigest !== undefined && redundant.transformDigest !== expected.transformDigest) fail("S8_TRANSFORM_ORACLE_MISMATCH", `${field}.transformDigest`);
}

export function assertS8SourceHash(value: string, field: string): void {
  if (!SHA256.test(value)) fail("S8_SOURCE_INVALID", field);
}
