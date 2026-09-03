import { Buffer } from "node:buffer";
import {
  AppError,
  type S6ToS7Handoff,
  type S7CadManifestDocument,
  type S7CadManifestEntry,
  type S7SourceStamp,
  type UUID,
} from "./types";
import { buildS7GeometryPlan, S7_LAYER_ORDER, type S7PlanEntity, type S7PlanPoint } from "./s7-geometry";
import { jcs, sha256, uuidV4Pattern } from "./utils";

export const S7_DXF_VERSION = "s7-dxf-r2000-ascii-v1" as const;
export const S7_WORLD_TO_PLAN_VERSION = "s7-world-to-plan-v1" as const;
export const S7_XDATA_APPID = "SWOOSHZ_S7" as const;
export const S7_DXF_MAX_BYTES = 8_000_000;
export const S7_DXF_MAX_LINES = 200_000;
export const S7_DXF_MAX_LINE_BYTES = 512;
export const S7_DXF_MAX_ENTITIES = 4_096;
export const S7_DXF_MAX_VERTICES = 16_384;
export const S7_DXF_MAX_TABLE_RECORDS = 64;
export const S7_LABEL_MAX_CODE_POINTS = 120;
export const S7_XDATA_MAX_BYTES = 2_048;
export const S7_XDATA_MAX_STRINGS = 16;

const DXF_HANDLE_START = 1;
const MAX_COORDINATE_MM = 1_000_000_000;
const SHA256 = /^[0-9a-f]{64}$/u;

type MatrixPoint = { xMm: number; yMm: number };

export type S7DxfWriteOptions = {
  artifactId: UUID;
  manifestId: UUID;
  source: S7SourceStamp;
};

export type S7DxfWriteResult = {
  bytes: Buffer;
  sha256: string;
  byteSize: number;
  entityCount: number;
  vertexCount: number;
  plan: ReturnType<typeof buildS7GeometryPlan>;
  manifest: S7CadManifestDocument;
  manifestBytes: Buffer;
  manifestHash: string;
};

function fail(code: string, field = "dxf"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function assertUuid(value: string, field: string): void {
  if (!uuidV4Pattern.test(value)) fail("S7_DXF_INPUT_INVALID", field);
}

function assertSourceMatchesHandoff(source: S7SourceStamp, handoff: S6ToS7Handoff): void {
  assertUuid(handoff.projectId, "projectId");
  assertUuid(source.sourceRevisionId, "sourceRevisionId");
  assertUuid(source.validationReceiptId, "validationReceiptId");
  for (const [field, value] of [["sourceRevisionHash", source.sourceRevisionHash], ["sourceS5Fingerprint", source.sourceS5Fingerprint], ["validationHash", source.validationHash], ["handoffDigest", source.handoffDigest]] as const) {
    if (!SHA256.test(value)) fail("S7_SOURCE_INVALID", field);
  }
  if (source.sourceRevisionId !== handoff.acceptedRevisionId || source.sourceRevisionHash !== handoff.acceptedRevisionHash || source.sourceS5Fingerprint !== handoff.sourceS5Fingerprint || source.validationReceiptId !== handoff.validationReceipt.receiptId || source.validationHash !== handoff.validationReceipt.validationHash || source.s6HandoffSchemaVersion !== handoff.schemaVersion) fail("S7_SOURCE_INVALID", "source");
}

function quantizeMm(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_MM) fail("S7_RESOURCE_LIMIT", "coordinate");
  const magnitude = Math.abs(value) * 100;
  const cents = Math.floor(magnitude + 0.5 + 1e-9);
  const result = (value < 0 ? -cents : cents) / 100;
  return Object.is(result, -0) ? 0 : result;
}

export function formatS7Mm(value: number): string {
  const quantized = quantizeMm(value);
  const cents = Math.abs(Math.trunc(quantized * 100));
  const sign = quantized < 0 ? "-" : "";
  const whole = Math.floor(cents / 100);
  const fractional = cents % 100;
  if (fractional === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${fractional.toString().padStart(2, "0")}`;
}

export function formatS7Fixed12(value: number): string {
  if (!Number.isFinite(value)) fail("S7_DXF_NUMERIC_INVALID");
  const normalized = Object.is(value, -0) ? 0 : value;
  if (Math.abs(normalized) > 1e12) fail("S7_DXF_NUMERIC_INVALID");
  const sign = normalized < 0 ? "-" : "";
  const magnitude = Math.abs(normalized);
  const integer = Math.floor(magnitude);
  const fraction = Math.round((magnitude - integer) * 1e12);
  if (integer === 0 && fraction === 0) return "0.000000000000";
  if (fraction >= 1e12) return `${sign}${integer + 1}.000000000000`;
  return `${sign}${integer}.${fraction.toString().padStart(12, "0")}`;
}

function formatInteger(value: number, field: string): string {
  if (!Number.isSafeInteger(value)) fail("S7_DXF_NUMERIC_INVALID", field);
  return String(value);
}

function assertAsciiLine(value: string): void {
  if (!/^[\x20-\x7e]*$/.test(value)) fail("S7_DXF_TEXT_INVALID");
  if (Buffer.byteLength(value, "ascii") > S7_DXF_MAX_LINE_BYTES) fail("S7_RESOURCE_LIMIT", "line");
}

function encodeDerivedAscii(value: string, field: string, maxCodePoints = S7_LABEL_MAX_CODE_POINTS): string {
  if (typeof value !== "string") fail("S7_DXF_TEXT_INVALID", field);
  let encoded = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x5c) {
      fail("S7_DXF_TEXT_INVALID", field);
    }
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      encoded += character;
      continue;
    }
    const units = character.length === 1 ? [codePoint] : [character.charCodeAt(0), character.charCodeAt(1)];
    encoded += units.map((unit) => `_u${unit.toString(16).toUpperCase().padStart(4, "0")}_`).join("");
  }
  if (Array.from(value).length <= maxCodePoints && encoded.length <= maxCodePoints) return encoded;
  return `h_${sha256(value).slice(0, 32)}`;
}

function encodeToken(value: string | null, field: string): string {
  if (value === null) return "-";
  return encodeDerivedAscii(value, field, 240);
}

function entityPoints(entity: S7PlanEntity): S7PlanPoint[] {
  switch (entity.entityType) {
    case "LWPOLYLINE": return entity.points;
    case "LINE": return [entity.start, entity.end];
    case "POINT": return [entity.point];
    case "CIRCLE": return [
      { xMm: entity.center.xMm - entity.radiusMm, yMm: entity.center.yMm - entity.radiusMm },
      { xMm: entity.center.xMm + entity.radiusMm, yMm: entity.center.yMm + entity.radiusMm },
    ];
    case "ELLIPSE": {
      const minorAxis = { xMm: -entity.majorAxis.yMm * entity.ratio, yMm: entity.majorAxis.xMm * entity.ratio };
      return [
        entity.center,
        { xMm: entity.center.xMm + Math.abs(entity.majorAxis.xMm) + Math.abs(minorAxis.xMm), yMm: entity.center.yMm + Math.abs(entity.majorAxis.yMm) + Math.abs(minorAxis.yMm) },
        { xMm: entity.center.xMm - Math.abs(entity.majorAxis.xMm) - Math.abs(minorAxis.xMm), yMm: entity.center.yMm - Math.abs(entity.majorAxis.yMm) - Math.abs(minorAxis.yMm) },
      ];
    }
    case "TEXT": return [entity.insertion];
  }
}

function quantizedPoint(point: S7PlanPoint): S7PlanPoint {
  return { xMm: quantizeMm(point.xMm), yMm: quantizeMm(point.yMm) };
}

function quantizeEntity(entity: S7PlanEntity): S7PlanEntity {
  switch (entity.entityType) {
    case "LWPOLYLINE": return { ...entity, points: entity.points.map(quantizedPoint) };
    case "LINE": return { ...entity, start: quantizedPoint(entity.start), end: quantizedPoint(entity.end) };
    case "POINT": return { ...entity, point: quantizedPoint(entity.point) };
    case "CIRCLE": return { ...entity, center: quantizedPoint(entity.center), radiusMm: quantizeMm(entity.radiusMm) };
    case "ELLIPSE": return {
      ...entity,
      center: quantizedPoint(entity.center),
      majorAxis: quantizedPoint(entity.majorAxis),
      ratio: entity.ratio,
      startParameter: entity.startParameter,
      endParameter: entity.endParameter,
    };
    case "TEXT": return { ...entity, insertion: quantizedPoint(entity.insertion), heightMm: quantizeMm(entity.heightMm) };
  }
}

function extents(entities: readonly S7PlanEntity[]): { min: S7PlanPoint; max: S7PlanPoint } {
  const all = entities.flatMap(entityPoints);
  if (all.length === 0) return { min: { xMm: 0, yMm: 0 }, max: { xMm: 0, yMm: 0 } };
  return {
    min: {
      xMm: Math.min(...all.map((point) => point.xMm)),
      yMm: Math.min(...all.map((point) => point.yMm)),
    },
    max: {
      xMm: Math.max(...all.map((point) => point.xMm)),
      yMm: Math.max(...all.map((point) => point.yMm)),
    },
  };
}

type DxfRecord = { lines: string[]; handle?: string };

class HandleAllocator {
  private next = DXF_HANDLE_START;

  allocate(): string {
    const value = this.next.toString(16).toUpperCase();
    this.next += 1;
    return value;
  }

  handseed(): string {
    return this.next.toString(16).toUpperCase();
  }
}

function pair(code: number, value: string): string[] {
  const codeLine = String(code);
  assertAsciiLine(codeLine);
  assertAsciiLine(value);
  return [codeLine, value];
}

function pushPair(target: string[], code: number, value: string): void {
  target.push(...pair(code, value));
}

function pushNumber(target: string[], code: number, value: number): void {
  pushPair(target, code, formatS7Mm(value));
}

function pushHandle(target: string[], code: number, handle: string): void {
  pushPair(target, code, handle);
}

function addSection(target: string[], name: string, body: string[]): void {
  pushPair(target, 0, "SECTION");
  pushPair(target, 2, name);
  target.push(...body);
  pushPair(target, 0, "ENDSEC");
}

function addXdata(target: string[], entity: S7PlanEntity, source: S7SourceStamp): void {
  const values = [
    "S7V1",
    `O=${encodeToken(entity.sourceObjectId, "sourceObjectId")}`,
    `K=${encodeToken(entity.identityKey, "identityKey")}`,
    `P=${encodeToken(entity.parentObjectId, "parentObjectId")}`,
    `R=${encodeToken(entity.role, "role")}`,
    `I=${formatInteger(entity.partIndex, "partIndex")}`,
    `G=${encodeToken(entity.geometryState, "geometryState")}`,
    `V=${encodeToken(source.sourceRevisionId, "sourceRevisionId")}`,
    `H=${encodeToken(source.sourceRevisionHash, "sourceRevisionHash")}`,
  ];
  if (values.length > S7_XDATA_MAX_STRINGS) fail("S7_RESOURCE_LIMIT", "xdata.strings");
  const xdata: string[] = [];
  pushPair(xdata, 1001, S7_XDATA_APPID);
  for (const value of values) pushPair(xdata, 1000, value);
  const bytes = Buffer.byteLength(xdata.join("\n"), "ascii");
  if (bytes > S7_XDATA_MAX_BYTES) fail("S7_RESOURCE_LIMIT", "xdata.bytes");
  target.push(...xdata);
}

function entityBaseLines(target: string[], allocator: HandleAllocator, entity: S7PlanEntity, modelBlockHandle: string): string {
  const handle = allocator.allocate();
  pushPair(target, 0, entity.entityType);
  pushHandle(target, 5, handle);
  pushHandle(target, 330, modelBlockHandle);
  pushPair(target, 100, "AcDbEntity");
  pushPair(target, 410, "Model");
  pushPair(target, 8, entity.layer);
  pushPair(target, 370, "-1");
  return handle;
}

function addGraphicalEntity(target: string[], allocator: HandleAllocator, entity: S7PlanEntity, source: S7SourceStamp, modelBlockHandle: string): string {
  const handle = entityBaseLines(target, allocator, entity, modelBlockHandle);
  switch (entity.entityType) {
    case "LWPOLYLINE":
      pushPair(target, 100, "AcDbPolyline");
      pushPair(target, 90, formatInteger(entity.points.length, "vertices"));
      pushPair(target, 70, entity.closed ? "1" : "0");
      for (const point of entity.points) {
        pushNumber(target, 10, point.xMm);
        pushNumber(target, 20, point.yMm);
      }
      break;
    case "LINE":
      pushPair(target, 100, "AcDbLine");
      pushNumber(target, 10, entity.start.xMm);
      pushNumber(target, 20, entity.start.yMm);
      pushNumber(target, 30, 0);
      pushNumber(target, 11, entity.end.xMm);
      pushNumber(target, 21, entity.end.yMm);
      pushNumber(target, 31, 0);
      break;
    case "POINT":
      pushPair(target, 100, "AcDbPoint");
      pushNumber(target, 10, entity.point.xMm);
      pushNumber(target, 20, entity.point.yMm);
      pushNumber(target, 30, 0);
      break;
    case "CIRCLE":
      pushPair(target, 100, "AcDbCircle");
      pushNumber(target, 10, entity.center.xMm);
      pushNumber(target, 20, entity.center.yMm);
      pushNumber(target, 30, 0);
      pushNumber(target, 40, entity.radiusMm);
      break;
    case "ELLIPSE":
      pushPair(target, 100, "AcDbEllipse");
      pushNumber(target, 10, entity.center.xMm);
      pushNumber(target, 20, entity.center.yMm);
      pushNumber(target, 30, 0);
      pushNumber(target, 11, entity.majorAxis.xMm);
      pushNumber(target, 21, entity.majorAxis.yMm);
      pushNumber(target, 31, 0);
      pushPair(target, 40, formatS7Fixed12(entity.ratio));
      pushPair(target, 41, formatS7Fixed12(entity.startParameter));
      pushPair(target, 42, formatS7Fixed12(entity.endParameter));
      break;
    case "TEXT":
      pushPair(target, 100, "AcDbText");
      pushNumber(target, 10, entity.insertion.xMm);
      pushNumber(target, 20, entity.insertion.yMm);
      pushNumber(target, 30, 0);
      pushNumber(target, 40, entity.heightMm);
      pushPair(target, 1, encodeDerivedAscii(entity.value, "text"));
      pushPair(target, 50, formatS7Fixed12(entity.rotation * 180 / Math.PI));
      break;
  }
  addXdata(target, entity, source);
  return handle;
}

function addTableHeader(target: string[], allocator: HandleAllocator, name: string, count: number): string {
  const handle = allocator.allocate();
  pushPair(target, 0, "TABLE");
  pushHandle(target, 5, handle);
  pushPair(target, 100, "AcDbSymbolTable");
  pushPair(target, 2, name);
  pushPair(target, 70, String(count));
  return handle;
}

function addTableRecord(target: string[], allocator: HandleAllocator, tableName: string, handleOwner: string, record: string[]): string {
  const handle = allocator.allocate();
  pushPair(target, 0, tableName);
  pushHandle(target, 5, handle);
  pushHandle(target, 330, handleOwner);
  target.push(...record);
  return handle;
}

function blockRecordBody(allocator: HandleAllocator, name: string, tableHandle: string): { recordHandle: string; lines: string[] } {
  const lines: string[] = [];
  const recordHandle = allocator.allocate();
  pushPair(lines, 0, "BLOCK_RECORD");
  pushHandle(lines, 5, recordHandle);
  pushHandle(lines, 330, tableHandle);
  pushPair(lines, 100, "AcDbSymbolTableRecord");
  pushPair(lines, 2, name);
  return { recordHandle, lines };
}

function addBlock(target: string[], allocator: HandleAllocator, name: string, recordHandle: string): void {
  const begin = allocator.allocate();
  pushPair(target, 0, "BLOCK");
  pushHandle(target, 5, begin);
  pushHandle(target, 330, recordHandle);
  pushPair(target, 100, "AcDbEntity");
  pushPair(target, 8, "0");
  pushPair(target, 100, "AcDbBlockBegin");
  pushPair(target, 2, name);
  pushPair(target, 70, "0");
  pushNumber(target, 10, 0);
  pushNumber(target, 20, 0);
  pushNumber(target, 30, 0);
  pushPair(target, 3, name);
  pushPair(target, 1, "");
  const end = allocator.allocate();
  pushPair(target, 0, "ENDBLK");
  pushHandle(target, 5, end);
  pushHandle(target, 330, recordHandle);
  pushPair(target, 100, "AcDbEntity");
  pushPair(target, 8, "0");
  pushPair(target, 100, "AcDbBlockEnd");
}

function manifestEntries(entities: readonly S7PlanEntity[], handles: readonly string[]): S7CadManifestEntry[] {
  return entities.map((entity, index) => ({
    handle: handles[index]!,
    sourceObjectId: entity.sourceObjectId,
    parentObjectId: entity.parentObjectId,
    identityKey: entity.identityKey,
    role: entity.role,
    partIndex: entity.partIndex,
    geometryState: entity.geometryState,
    intendedLayer: entity.intendedLayer,
    emittedLayer: entity.layer,
    entityType: entity.entityType,
  }));
}

export function writeS7Dxf(handoff: S6ToS7Handoff, options: S7DxfWriteOptions): S7DxfWriteResult {
  assertUuid(options.artifactId, "artifactId");
  assertUuid(options.manifestId, "manifestId");
  if (options.source.s6HandoffSchemaVersion !== "s6-to-s7-handoff-v1") fail("S7_SOURCE_INVALID", "source");
  assertSourceMatchesHandoff(options.source, handoff);
  const plan = buildS7GeometryPlan(handoff);
  const entities = plan.entities.map(quantizeEntity);
  if (entities.length > S7_DXF_MAX_ENTITIES) fail("S7_RESOURCE_LIMIT", "entities");
  const vertexCount = entities.reduce((total, entity) => total + (entity.entityType === "LWPOLYLINE" ? entity.points.length : entity.entityType === "LINE" ? 2 : 1), 0);
  if (vertexCount > S7_DXF_MAX_VERTICES) fail("S7_RESOURCE_LIMIT", "vertices");
  const allocator = new HandleAllocator();
  const header: string[] = [];
  const tables: string[] = [];
  const blocks: string[] = [];
  const entityLines: string[] = [];
  const bounds = extents(entities);

  const headerVariables: Array<[string, number, string]> = [
    ["$ACADVER", 1, "AC1015"],
    ["$INSUNITS", 70, "4"],
    ["$MEASUREMENT", 70, "1"],
    ["$EXTMIN", 10, formatS7Mm(bounds.min.xMm)],
    ["$EXTMAX", 10, formatS7Mm(bounds.max.xMm)],
  ];
  pushPair(header, 9, "$S7_PROFILE");
  pushPair(header, 1, S7_DXF_VERSION);
  for (const [name, code, value] of headerVariables) {
    pushPair(header, 9, name);
    pushPair(header, code, value);
    if (name === "$EXTMIN") {
      pushNumber(header, 20, bounds.min.yMm);
      pushNumber(header, 30, 0);
    }
    if (name === "$EXTMAX") {
      pushNumber(header, 20, bounds.max.yMm);
      pushNumber(header, 30, 0);
    }
  }

  // The block-record table is emitted after the three required symbol tables,
  // but its handles are allocated before any graphical entity handles.
  const ltypeTable: string[] = [];
  const ltypeOwner = addTableHeader(ltypeTable, allocator, "LTYPE", 1);
  addTableRecord(ltypeTable, allocator, "LTYPE", ltypeOwner, [
    ...pair(100, "AcDbLinetypeTableRecord"),
    ...pair(2, "CONTINUOUS"),
    ...pair(70, "0"),
    ...pair(3, "Solid line"),
    ...pair(72, "65"),
    ...pair(73, "0"),
    ...pair(40, "0"),
  ]);
  pushPair(ltypeTable, 0, "ENDTAB");
  tables.push(...ltypeTable);

  const layerTable: string[] = [];
  const layerOwner = addTableHeader(layerTable, allocator, "LAYER", S7_LAYER_ORDER.length);
  for (const layer of S7_LAYER_ORDER) {
    addTableRecord(layerTable, allocator, "LAYER", layerOwner, [
      ...pair(100, "AcDbLayerTableRecord"),
      ...pair(2, layer),
      ...pair(70, "0"),
      ...pair(62, "7"),
      ...pair(6, "CONTINUOUS"),
      ...pair(370, "-1"),
    ]);
  }
  pushPair(layerTable, 0, "ENDTAB");
  tables.push(...layerTable);

  const appidTable: string[] = [];
  const appidOwner = addTableHeader(appidTable, allocator, "APPID", 1);
  addTableRecord(appidTable, allocator, "APPID", appidOwner, [
    ...pair(100, "AcDbRegAppTableRecord"),
    ...pair(2, S7_XDATA_APPID),
    ...pair(70, "0"),
  ]);
  pushPair(appidTable, 0, "ENDTAB");
  tables.push(...appidTable);

  const blockRecordHeader: string[] = [];
  const blockRecordOwner = addTableHeader(blockRecordHeader, allocator, "BLOCK_RECORD", 2);
  const model = blockRecordBody(allocator, "*MODEL_SPACE", blockRecordOwner);
  const paper = blockRecordBody(allocator, "*PAPER_SPACE", blockRecordOwner);
  blockRecordHeader.push(...model.lines, ...paper.lines);
  pushPair(blockRecordHeader, 0, "ENDTAB");
  tables.push(...blockRecordHeader);

  addBlock(blocks, allocator, "*MODEL_SPACE", model.recordHandle);
  addBlock(blocks, allocator, "*PAPER_SPACE", paper.recordHandle);

  const handles: string[] = [];
  for (const entity of entities) handles.push(addGraphicalEntity(entityLines, allocator, entity, options.source, model.recordHandle));
  pushPair(header, 9, "$HANDSEED");
  pushPair(header, 5, allocator.handseed());

  const allLines: string[] = [];
  addSection(allLines, "HEADER", header);
  addSection(allLines, "TABLES", tables);
  addSection(allLines, "BLOCKS", blocks);
  addSection(allLines, "ENTITIES", entityLines);
  pushPair(allLines, 0, "EOF");
  if (allLines.length > S7_DXF_MAX_LINES) fail("S7_RESOURCE_LIMIT", "lines");
  const dxfText = `${allLines.join("\n")}\n`;
  const bytes = Buffer.from(dxfText, "ascii");
  if (bytes.length > S7_DXF_MAX_BYTES) fail("S7_RESOURCE_LIMIT", "bytes");
  const manifest: S7CadManifestDocument = {
    schemaVersion: "s7-cad-manifest-v1",
    manifestId: options.manifestId,
    projectId: handoff.projectId,
    artifactId: options.artifactId,
    source: options.source,
    worldToPlanVersion: S7_WORLD_TO_PLAN_VERSION,
    dxfVersion: S7_DXF_VERSION,
    entities: manifestEntries(entities, handles),
  };
  const manifestBytes = Buffer.from(jcs(manifest), "utf8");
  if (manifestBytes.length > 4_000_000) fail("S7_RESOURCE_LIMIT", "manifest");
  const manifestHash = sha256(manifestBytes);
  return {
    bytes,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    entityCount: entities.length,
    vertexCount,
    plan,
    manifest,
    manifestBytes,
    manifestHash,
  };
}
