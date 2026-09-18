import { AppError, type S6MaterialFinishRef, type S6RotationMd, type S6ToS7Handoff, type S7ToS8Handoff } from "./types";
import { buildS8Mesh, type S8Mesh, type S8Vec3 } from "./s8-fbx-geometry";
import { S8_LIMITS, S8_WRITER_INPUT_VERSION, s8Basis, s8Sha256, s8StableName } from "./s8-fbx-profile";

export type S8PreviewMaterial = {
  materialId: string;
  name: string;
  diffuseRgbTicks: readonly [number, number, number];
  opacityTicks: 10_000_000_000;
  degradationCodes: string[];
};

export type S8WriterObject = {
  name: string;
  objectId: string;
  identityKey: string;
  parentName: string;
  nodeKind: "mesh";
  matrixTicks: number[];
  verticesTicks: number[][];
  triangles: number[][];
  cornerNormalsTicks: number[][];
  materialName: string | null;
  degradationCodes: string[];
  geometryState: "exact" | "bounded_inference";
  roundSegments: number | null;
  analyticSagittaTicks: number | null;
};

export type S8WriterPayload = {
  schemaVersion: typeof S8_WRITER_INPUT_VERSION;
  profile: "swooshz-fbx-static-mesh-v1";
  source: {
    projectId: string;
    revisionId: string;
    revisionHash: string;
    sourceS5Fingerprint: string;
    s6ValidationReceiptId: string;
    s6ValidationHash: string;
    s6HandoffDigest: string;
    s7ArtifactId: string;
    s7ArtifactHash: string;
    s7ReadbackHash: string;
  };
  scene: {
    units: "millimetres";
    upAxis: "+Z";
    frontAxis: "-Y";
    rightAxis: "+X";
    rootName: "SWZ_ROOT";
  };
  materials: S8PreviewMaterial[];
  objects: S8WriterObject[];
};

const POSITION_SCALE = 1_000_000;
const UNIT_SCALE = 10_000_000_000;
const SHA = /^[0-9a-f]{64}$/;

function fail(code: string, field = "payload"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function tick(value: number, scale: number, field: string): number {
  const result = Math.round(value * scale);
  if (!Number.isSafeInteger(result)) fail("S8_PAYLOAD_NUMBER_INVALID", field);
  return result;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function multiply3(left: number[][], right: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) =>
    left[row]![0]! * right[0]![column]! + left[row]![1]! * right[1]![column]! + left[row]![2]! * right[2]![column]!));
}

function transpose3(value: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, column) => value[column]![row]!));
}

function s6Rotation(rotation: S6RotationMd): number[][] {
  const rx = rotation.xMd * Math.PI / 180_000;
  const ry = rotation.yMd * Math.PI / 180_000;
  const rz = rotation.zMd * Math.PI / 180_000;
  const x = [[1, 0, 0], [0, Math.cos(rx), -Math.sin(rx)], [0, Math.sin(rx), Math.cos(rx)]];
  const y = [[Math.cos(ry), 0, Math.sin(ry)], [0, 1, 0], [-Math.sin(ry), 0, Math.cos(ry)]];
  const z = [[Math.cos(rz), -Math.sin(rz), 0], [Math.sin(rz), Math.cos(rz), 0], [0, 0, 1]];
  return multiply3(multiply3(z, y), x);
}

function matrixTicks(position: { xMm: number; yMm: number; zMm: number }, rotation: S6RotationMd): number[] {
  const basis = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  const converted = multiply3(multiply3(basis, s6Rotation(rotation)), transpose3(basis));
  const translated = s8Basis([position.xMm, position.yMm, position.zMm]);
  const matrix = [
    converted[0]![0]!, converted[0]![1]!, converted[0]![2]!, translated[0],
    converted[1]![0]!, converted[1]![1]!, converted[1]![2]!, translated[1],
    converted[2]![0]!, converted[2]![1]!, converted[2]![2]!, translated[2],
    0, 0, 0, 1,
  ];
  return matrix.map((value, index) => tick(value, index % 4 === 3 && index < 12 ? POSITION_SCALE : UNIT_SCALE, `matrix.${index}`));
}

function parseColor(value: string | null): readonly [number, number, number] | null {
  if (value === null || !/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return [Number.parseInt(value.slice(1, 3), 16) / 255, Number.parseInt(value.slice(3, 5), 16) / 255, Number.parseInt(value.slice(5, 7), 16) / 255];
}

function materialFor(source: S6MaterialFinishRef): S8PreviewMaterial {
  const degradationCodes: string[] = [];
  const parsed = parseColor(source.colorHex);
  if (parsed === null) degradationCodes.push("PREVIEW_COLOR_NEUTRAL_DEFAULT");
  if (source.finishKind !== "solid_color") degradationCodes.push(`PREVIEW_FINISH_${source.finishKind.toUpperCase()}_DEGRADED`);
  const color = parsed ?? [0.62, 0.62, 0.62] as const;
  return {
    materialId: source.materialId,
    name: `SWZ_MAT_${s8Sha256(source.materialId).slice(0, 16)}`,
    diffuseRgbTicks: color.map((component) => tick(component, UNIT_SCALE, "material.color")) as unknown as readonly [number, number, number],
    opacityTicks: UNIT_SCALE,
    degradationCodes: degradationCodes.sort(),
  };
}

function meshArrays(mesh: S8Mesh): Pick<S8WriterObject, "verticesTicks" | "triangles" | "cornerNormalsTicks"> {
  return {
    verticesTicks: mesh.verticesMm.map((vertex) => vertex.map((component) => tick(component, POSITION_SCALE, "vertex"))),
    triangles: mesh.triangles.map((triangle) => [...triangle]),
    cornerNormalsTicks: mesh.cornerNormals.map((normal: S8Vec3) => normal.map((component) => tick(component, UNIT_SCALE, "normal"))),
  };
}

function assertSource(s6: S6ToS7Handoff, s7: S7ToS8Handoff): void {
  if (s6.schemaVersion !== "s6-to-s7-handoff-v1" || s7.schemaVersion !== "s7-to-s8-handoff-v1") fail("S8_SOURCE_INVALID");
  if (!s6.eligibility.currentAccepted || !s6.eligibility.sourceCurrent || s6.eligibility.stale) fail("S8_SOURCE_STALE");
  if (s7.projectId !== s6.projectId || s7.sourceRevisionId !== s6.acceptedRevisionId || s7.sourceRevisionHash !== s6.acceptedRevisionHash || s7.sourceS5Fingerprint !== s6.sourceS5Fingerprint) fail("S8_SOURCE_BINDING_MISMATCH");
  if (!s7.dxfIsNot3DAuthority || !s7.s8MustReadAcceptedS6Model) fail("S8_SOURCE_AUTHORITY_INVALID");
  for (const value of [s6.acceptedRevisionHash, s6.sourceS5Fingerprint, s6.validationReceipt.validationHash, s7.s7ArtifactHash, s7.manifestHash, s7.readbackHash]) {
    if (!SHA.test(value)) fail("S8_SOURCE_INVALID");
  }
}

export function canonicalS8Json(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("S8_PAYLOAD_NON_INTEGER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalS8Json).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalS8Json(record[key])}`).join(",")}}`;
  }
  fail("S8_PAYLOAD_TYPE_INVALID");
}

export function canonicalS8SourceJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("S8_SOURCE_INVALID");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalS8SourceJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalS8SourceJson(record[key])}`).join(",")}}`;
  }
  fail("S8_SOURCE_INVALID");
}

export function buildS8WriterPayload(s6: S6ToS7Handoff, s7: S7ToS8Handoff): { payload: S8WriterPayload; bytes: Buffer; sha256: string } {
  assertSource(s6, s7);
  if (s6.objects.length > S8_LIMITS.objects || s6.materials.length > S8_LIMITS.sourceMaterials) fail("S8_RESOURCE_LIMIT");
  const objects = s6.objects.slice().sort((left, right) => compareUtf8(left.objectId, right.objectId));
  const names = new Map(objects.map((object, index) => [object.objectId, s8StableName(index, object.objectId)]));
  const sourceMaterials = new Map(s6.materials.map((material) => [material.materialId, material]));
  const usedMaterialIds = new Set<string>();
  const writerObjects = objects.map((object) => {
    const mesh = buildS8Mesh(object.geometry);
    const ids = object.materialIds.slice().sort(compareUtf8);
    const degradationCodes: string[] = [];
    let materialName: string | null = null;
    if (ids.length === 0) degradationCodes.push("PREVIEW_MATERIAL_MISSING");
    if (ids.length > 1) degradationCodes.push("PREVIEW_MULTIPLE_MATERIALS_FIRST_STABLE");
    if (ids[0]) {
      const selected = sourceMaterials.get(ids[0]);
      if (selected) {
        usedMaterialIds.add(selected.materialId);
        const material = materialFor(selected);
        materialName = material.name;
        degradationCodes.push(...material.degradationCodes);
      } else degradationCodes.push("PREVIEW_MATERIAL_REFERENCE_MISSING");
    }
    return {
      name: names.get(object.objectId)!,
      objectId: object.objectId,
      identityKey: object.identityKey,
      parentName: object.parentObjectId === null ? "SWZ_ROOT" : names.get(object.parentObjectId) ?? fail("S8_HIERARCHY_INVALID"),
      nodeKind: "mesh" as const,
      matrixTicks: matrixTicks(object.transform.positionMm, object.transform.rotationMd),
      ...meshArrays(mesh),
      materialName,
      degradationCodes: degradationCodes.sort(),
      geometryState: object.geometry.geometryState,
      roundSegments: mesh.roundSegments,
      analyticSagittaTicks: mesh.analyticSagittaMm === null ? null : tick(mesh.analyticSagittaMm, POSITION_SCALE, "sagitta"),
    };
  });
  const materials = [...usedMaterialIds].sort(compareUtf8).map((id) => materialFor(sourceMaterials.get(id)!));
  const s6HandoffDigest = s8Sha256(canonicalS8SourceJson(s6));
  const payload: S8WriterPayload = {
    schemaVersion: S8_WRITER_INPUT_VERSION,
    profile: "swooshz-fbx-static-mesh-v1",
    source: {
      projectId: s6.projectId,
      revisionId: s6.acceptedRevisionId,
      revisionHash: s6.acceptedRevisionHash,
      sourceS5Fingerprint: s6.sourceS5Fingerprint,
      s6ValidationReceiptId: s6.validationReceipt.receiptId,
      s6ValidationHash: s6.validationReceipt.validationHash,
      s6HandoffDigest,
      s7ArtifactId: s7.s7ArtifactId,
      s7ArtifactHash: s7.s7ArtifactHash,
      s7ReadbackHash: s7.readbackHash,
    },
    scene: { units: "millimetres", upAxis: "+Z", frontAxis: "-Y", rightAxis: "+X", rootName: "SWZ_ROOT" },
    materials,
    objects: writerObjects,
  };
  const bytes = Buffer.from(canonicalS8Json(payload), "utf8");
  if (bytes.length > S8_LIMITS.payloadBytes) fail("S8_RESOURCE_LIMIT", "payload");
  return { payload, bytes, sha256: s8Sha256(bytes) };
}
