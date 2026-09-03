import { Buffer } from "node:buffer";
import { AppError, type S7CadManifestDocument, type S7CadManifestEntry, type S7SourceStamp } from "./types";
import { sha256, uuidV4Pattern } from "./utils";

export const S7_READBACK_VERSION = "s7-cad-readback-v1" as const;
const DXF_VERSION = "s7-dxf-r2000-ascii-v1";
const WORLD_TO_PLAN_VERSION = "s7-world-to-plan-v1";
const APPID = "SWOOSHZ_S7";
const LAYER_ORDER = [
  "S7-BOOTH-BOUNDARY",
  "S7-BOOTH-OPENINGS",
  "S7-WALLS-PARTITIONS",
  "S7-ZONES",
  "S7-FURNITURE",
  "S7-EQUIPMENT",
  "S7-DISPLAYS",
  "S7-OVERHEAD",
  "S7-DIMENSIONS",
  "S7-LABELS",
  "S7-UNKNOWN",
] as const;
const MAX_BYTES = 8_000_000;
const MAX_LINES = 200_000;
const MAX_LINE_BYTES = 512;
const MAX_ENTITIES = 4_096;
const MAX_VERTICES = 16_384;
const MAX_LAYERS = 32;
const MAX_TABLE_RECORDS = 64;
const MAX_XDATA_BYTES = 2_048;
const MAX_XDATA_STRINGS = 16;
const MAX_COORDINATE = 1_000_000_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const MANIFEST_KEYS = ["schemaVersion", "manifestId", "projectId", "artifactId", "source", "worldToPlanVersion", "dxfVersion", "entities"] as const;
const MANIFEST_SOURCE_KEYS = ["sourceRevisionId", "sourceRevisionHash", "sourceS5Fingerprint", "validationReceiptId", "validationHash", "s6HandoffSchemaVersion", "handoffDigest"] as const;
const MANIFEST_ENTRY_KEYS = ["handle", "sourceObjectId", "parentObjectId", "identityKey", "role", "partIndex", "geometryState", "intendedLayer", "emittedLayer", "entityType"] as const;

type Pair = { code: number; value: string; line: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type S7ReadbackEntity = {
  handle: string;
  ownerHandle: string;
  entityType: "LWPOLYLINE" | "LINE" | "POINT" | "CIRCLE" | "ELLIPSE" | "TEXT";
  layer: string;
  vertexCount: number;
  sourceObjectIdToken: string;
  identityKeyToken: string;
  parentObjectIdToken: string;
  roleToken: string;
  partIndex: number;
  geometryStateToken: string;
  sourceRevisionIdToken: string;
  sourceRevisionHashToken: string;
};

export type S7ReadbackResult = {
  readbackVersion: typeof S7_READBACK_VERSION;
  sha256: string;
  byteSize: number;
  entityCount: number;
  vertexCount: number;
  entities: S7ReadbackEntity[];
  layers: readonly string[];
  handseed: string;
  extents: Bounds;
  outcome: "pass";
  correspondenceResult: "pass" | "not_checked";
  issues: string[];
};

export type S7ReadbackOptions = {
  expectedManifest?: S7CadManifestDocument;
  expectedSource?: S7SourceStamp;
};

function fail(code: string, field = "dxf"): never {
  throw new AppError(422, code, [{ field, code }]);
}

function expect(condition: boolean, code = "S7_DXF_READBACK_INVALID", field = "dxf"): asserts condition {
  if (!condition) fail(code, field);
}

function exactOne(pairs: readonly Pair[], code: number, field: string): string {
  const found = pairs.filter((pair) => pair.code === code);
  if (found.length !== 1) fail("S7_DXF_READBACK_INVALID", field);
  return found[0]!.value;
}

function all(pairs: readonly Pair[], code: number): string[] {
  return pairs.filter((pair) => pair.code === code).map((pair) => pair.value);
}

function parseAsciiPairs(bytes: Uint8Array): Pair[] {
  const raw = Buffer.from(bytes);
  if (raw.length === 0 || raw.length > MAX_BYTES || raw[raw.length - 1] !== 0x0a || raw[raw.length - 2] === 0x0a) fail("S7_DXF_READBACK_INVALID", "bytes");
  for (const byte of raw) {
    if (byte === 0x0d || byte === 0x00 || byte < 0x20 && byte !== 0x0a || byte > 0x7e) fail("S7_DXF_TEXT_INVALID", "bytes");
  }
  const text = raw.toString("ascii");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_LINES) fail("S7_RESOURCE_LIMIT", "lines");
  for (const line of lines) if (Buffer.byteLength(line, "ascii") > MAX_LINE_BYTES) fail("S7_RESOURCE_LIMIT", "line");
  if (lines.length % 2 !== 0) fail("S7_DXF_READBACK_INVALID", "pairs");
  const pairs: Pair[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const codeLine = lines[index]!;
    if (!/^\d{1,4}$/.test(codeLine)) fail("S7_DXF_READBACK_INVALID", `line:${index + 1}`);
    const code = Number(codeLine);
    if (!Number.isInteger(code) || code < 0 || code > 1071) fail("S7_DXF_READBACK_INVALID", `line:${index + 1}`);
    pairs.push({ code, value: lines[index + 1]!, line: index + 1 });
  }
  return pairs;
}

function sectionPairs(pairs: readonly Pair[]): Map<string, Pair[]> {
  const sections = new Map<string, Pair[]>();
  let index = 0;
  while (index < pairs.length) {
    expect(pairs[index]!.code === 0 && pairs[index]!.value === "SECTION", "S7_DXF_SECTION_INVALID");
    expect(pairs[index + 1]?.code === 2, "S7_DXF_SECTION_INVALID");
    const name = pairs[index + 1]!.value;
    if (sections.has(name)) fail("S7_DXF_SECTION_INVALID", name);
    index += 2;
    const body: Pair[] = [];
    while (index < pairs.length && !(pairs[index]!.code === 0 && pairs[index]!.value === "ENDSEC")) body.push(pairs[index++]!);
    expect(index < pairs.length, "S7_DXF_SECTION_INVALID", name);
    sections.set(name, body);
    index += 1;
  }
  expect(sections.size === 4, "S7_DXF_SECTION_INVALID", "sections");
  return sections;
}

function splitRecords(pairs: readonly Pair[]): Pair[][] {
  const records: Pair[][] = [];
  let current: Pair[] | null = null;
  for (const pair of pairs) {
    if (pair.code === 0) {
      if (current) records.push(current);
      current = [pair];
    } else if (current) {
      current.push(pair);
    } else {
      fail("S7_DXF_READBACK_INVALID", "record");
    }
  }
  if (current) records.push(current);
  return records;
}

function canonicalMm(value: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{2})?$/.test(value) || value === "-0" || value === "-0.0" || value === "-0.00") fail("S7_DXF_NUMERIC_INVALID");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_COORDINATE) fail("S7_DXF_NUMERIC_INVALID");
  const magnitude = Math.abs(parsed) * 100;
  const cents = Math.floor(magnitude + 0.5 + 1e-9);
  const quantized = (parsed < 0 ? -cents : cents) / 100;
  const sign = quantized < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(quantized));
  const fraction = Math.round((Math.abs(quantized) - whole) * 100);
  const canonical = fraction === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction.toString().padStart(2, "0")}`;
  if (canonical !== value) fail("S7_DXF_NUMERIC_NON_CANONICAL");
  return Object.is(quantized, -0) ? 0 : quantized;
}

function canonicalFixed12(value: string): number {
  if (!/^-?(?:0|[1-9]\d*)\.\d{12}$/.test(value) || /^-0\.0{12}$/.test(value)) fail("S7_DXF_NUMERIC_INVALID");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail("S7_DXF_NUMERIC_INVALID");
  const canonical = `${parsed < 0 ? "-" : ""}${Math.floor(Math.abs(parsed))}.${Math.round((Math.abs(parsed) - Math.floor(Math.abs(parsed))) * 1e12).toString().padStart(12, "0")}`;
  if (canonical !== value) fail("S7_DXF_NUMERIC_NON_CANONICAL");
  return Object.is(parsed, -0) ? 0 : parsed;
}

function integer(value: string): number {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value) || value === "-0") fail("S7_DXF_NUMERIC_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("S7_DXF_NUMERIC_INVALID");
  return parsed;
}

function handle(value: string): number {
  if (!/^[1-9A-F][0-9A-F]*$/.test(value)) fail("S7_DXF_HANDLE_INVALID");
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail("S7_DXF_HANDLE_INVALID");
  return parsed;
}

function requireHandle(pairs: readonly Pair[], code: number, field: string): string {
  const value = exactOne(pairs, code, field);
  handle(value);
  return value;
}

function checkPrintable(value: string, field: string, maxCodePoints = 120): void {
  if (!/^[\x20-\x7e]*$/.test(value) || value.includes("\\") || Array.from(value).length > maxCodePoints) fail("S7_DXF_TEXT_INVALID", field);
}

function derivedToken(value: string | null): string {
  if (value === null) return "-";
  if (Array.from(value).length > 240) return `h_${sha256(value).slice(0, 32)}`;
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x5c) fail("S7_DXF_TEXT_INVALID");
    if (codePoint >= 0x20 && codePoint <= 0x7e) output += character;
    else {
      const units = character.length === 1 ? [codePoint] : [character.charCodeAt(0), character.charCodeAt(1)];
      output += units.map((unit) => `_u${unit.toString(16).toUpperCase().padStart(4, "0")}_`).join("");
    }
  }
  return output.length <= 240 ? output : `h_${sha256(value).slice(0, 32)}`;
}

function exactKeys(value: unknown, keys: readonly string[], code: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, field);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(code, field);
  return record;
}

function manifestText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail("S7_MANIFEST_INVALID", field);
  return value;
}

function validateManifestDocument(value: unknown): asserts value is S7CadManifestDocument {
  const manifest = exactKeys(value, MANIFEST_KEYS, "S7_MANIFEST_INVALID", "manifest");
  expect(manifest.schemaVersion === "s7-cad-manifest-v1", "S7_MANIFEST_INVALID", "manifest.schemaVersion");
  expect(typeof manifest.manifestId === "string" && uuidV4Pattern.test(manifest.manifestId), "S7_MANIFEST_INVALID", "manifest.manifestId");
  expect(typeof manifest.projectId === "string" && uuidV4Pattern.test(manifest.projectId), "S7_MANIFEST_INVALID", "manifest.projectId");
  expect(typeof manifest.artifactId === "string" && uuidV4Pattern.test(manifest.artifactId), "S7_MANIFEST_INVALID", "manifest.artifactId");
  const source = exactKeys(manifest.source, MANIFEST_SOURCE_KEYS, "S7_MANIFEST_INVALID", "manifest.source");
  expect(typeof source.sourceRevisionId === "string" && uuidV4Pattern.test(source.sourceRevisionId), "S7_MANIFEST_INVALID", "manifest.sourceRevisionId");
  expect(typeof source.validationReceiptId === "string" && uuidV4Pattern.test(source.validationReceiptId), "S7_MANIFEST_INVALID", "manifest.validationReceiptId");
  for (const [field, item] of [["sourceRevisionHash", source.sourceRevisionHash], ["sourceS5Fingerprint", source.sourceS5Fingerprint], ["validationHash", source.validationHash], ["handoffDigest", source.handoffDigest]] as const) expect(typeof item === "string" && SHA256.test(item), "S7_MANIFEST_INVALID", field);
  expect(source.s6HandoffSchemaVersion === "s6-to-s7-handoff-v1", "S7_MANIFEST_INVALID", "manifest.s6HandoffSchemaVersion");
  expect(manifest.worldToPlanVersion === WORLD_TO_PLAN_VERSION && manifest.dxfVersion === DXF_VERSION, "S7_MANIFEST_INVALID", "manifest.version");
  expect(Array.isArray(manifest.entities) && manifest.entities.length <= MAX_ENTITIES, "S7_MANIFEST_INVALID", "manifest.entities");
  const handles = new Set<string>();
  const entityTypes = new Set(["LWPOLYLINE", "LINE", "POINT", "CIRCLE", "ELLIPSE", "TEXT"]);
  const geometryStates = new Set(["exact", "bounded_inference"]);
  for (const [index, valueEntry] of (manifest.entities as unknown[]).entries()) {
    const entry = exactKeys(valueEntry, MANIFEST_ENTRY_KEYS, "S7_MANIFEST_INVALID", `manifest.entities[${index}]`);
    expect(typeof entry.handle === "string", "S7_MANIFEST_INVALID", `manifest.entities[${index}].handle`);
    handle(entry.handle);
    expect(!handles.has(entry.handle), "S7_MANIFEST_INVALID", `manifest.entities[${index}].handle`);
    handles.add(entry.handle);
    manifestText(entry.sourceObjectId, `manifest.entities[${index}].sourceObjectId`);
    if (entry.parentObjectId !== null) manifestText(entry.parentObjectId, `manifest.entities[${index}].parentObjectId`);
    manifestText(entry.identityKey, `manifest.entities[${index}].identityKey`);
    manifestText(entry.role, `manifest.entities[${index}].role`);
    expect(typeof entry.partIndex === "number" && Number.isSafeInteger(entry.partIndex) && entry.partIndex >= 0 && entry.partIndex <= MAX_VERTICES, "S7_MANIFEST_INVALID", `manifest.entities[${index}].partIndex`);
    expect(typeof entry.geometryState === "string" && geometryStates.has(entry.geometryState), "S7_MANIFEST_INVALID", `manifest.entities[${index}].geometryState`);
    expect(typeof entry.intendedLayer === "string" && (LAYER_ORDER as readonly string[]).includes(entry.intendedLayer), "S7_MANIFEST_INVALID", `manifest.entities[${index}].intendedLayer`);
    expect(typeof entry.emittedLayer === "string" && (LAYER_ORDER as readonly string[]).includes(entry.emittedLayer), "S7_MANIFEST_INVALID", `manifest.entities[${index}].emittedLayer`);
    expect(typeof entry.entityType === "string" && entityTypes.has(entry.entityType), "S7_MANIFEST_INVALID", `manifest.entities[${index}].entityType`);
  }
}

function assertUniqueHandle(registry: Set<string>, value: string): void {
  handle(value);
  if (registry.has(value)) fail("S7_DXF_HANDLE_DUPLICATE", "handle");
  registry.add(value);
}

function parseHeader(body: readonly Pair[]): { extents: Bounds; handseed: string } {
  const variables: Array<{ name: string; values: Pair[] }> = [];
  let current: { name: string; values: Pair[] } | null = null;
  for (const pair of body) {
    if (pair.code === 9) {
      if (current) variables.push(current);
      current = { name: pair.value, values: [] };
    } else if (current) current.values.push(pair);
    else fail("S7_DXF_HEADER_INVALID", "header");
  }
  if (current) variables.push(current);
  const expected = ["$S7_PROFILE", "$ACADVER", "$INSUNITS", "$MEASUREMENT", "$EXTMIN", "$EXTMAX", "$HANDSEED"];
  expect(variables.map((variable) => variable.name).join("|") === expected.join("|"), "S7_DXF_HEADER_INVALID", "order");
  const profile = variables[0]!.values;
  expect(profile.length === 1 && profile[0]!.code === 1 && profile[0]!.value === DXF_VERSION, "S7_DXF_HEADER_INVALID", "$S7_PROFILE");
  const acadver = variables[1]!.values;
  expect(acadver.length === 1 && acadver[0]!.code === 1 && acadver[0]!.value === "AC1015", "S7_DXF_HEADER_INVALID", "$ACADVER");
  const units = variables[2]!.values;
  expect(units.length === 1 && units[0]!.code === 70 && integer(units[0]!.value) === 4, "S7_DXF_HEADER_INVALID", "$INSUNITS");
  const measurement = variables[3]!.values;
  expect(measurement.length === 1 && measurement[0]!.code === 70 && integer(measurement[0]!.value) === 1, "S7_DXF_HEADER_INVALID", "$MEASUREMENT");
  const parseExtent = (values: readonly Pair[], field: string): { x: number; y: number } => {
    expect(values.length === 3 && values[0]!.code === 10 && values[1]!.code === 20 && values[2]!.code === 30, "S7_DXF_HEADER_INVALID", field);
    const x = canonicalMm(values[0]!.value);
    const y = canonicalMm(values[1]!.value);
    expect(canonicalMm(values[2]!.value) === 0, "S7_DXF_HEADER_INVALID", field);
    return { x, y };
  };
  const min = parseExtent(variables[4]!.values, "$EXTMIN");
  const max = parseExtent(variables[5]!.values, "$EXTMAX");
  const seed = variables[6]!.values;
  expect(seed.length === 1 && seed[0]!.code === 5, "S7_DXF_HEADER_INVALID", "$HANDSEED");
  handle(seed[0]!.value);
  expect(min.x <= max.x && min.y <= max.y, "S7_DXF_HEADER_INVALID", "extents");
  return { extents: { minX: min.x, minY: min.y, maxX: max.x, maxY: max.y }, handseed: seed[0]!.value };
}

function parseTables(body: readonly Pair[], registry: Set<string>): { layers: readonly string[]; modelRecord: string; paperRecord: string } {
  expect(LAYER_ORDER.length <= MAX_LAYERS, "S7_RESOURCE_LIMIT", "layers");
  const records = splitRecords(body);
  const tables: Pair[][] = [];
  let current: Pair[] | null = null;
  for (const record of records) {
    const kind = record[0]!.value;
    if (kind === "TABLE") {
      if (current) fail("S7_DXF_TABLE_INVALID", "nested");
      current = record;
    } else if (kind === "ENDTAB") {
      if (!current) fail("S7_DXF_TABLE_INVALID", "end");
      current.push(...record);
      tables.push(current);
      current = null;
    } else if (current) {
      current.push(...record);
    } else {
      fail("S7_DXF_TABLE_INVALID", "table");
    }
  }
  if (current || tables.length !== 4) fail("S7_DXF_TABLE_INVALID", "count");
  const expected = ["LTYPE", "LAYER", "APPID", "BLOCK_RECORD"];
  const layerNames: string[] = [];
  let modelRecord = "";
  let paperRecord = "";
  tables.forEach((table, tableIndex) => {
    const headerEnd = table.findIndex((pair, index) => index > 0 && pair.code === 0);
    if (headerEnd < 0) fail("S7_DXF_TABLE_INVALID", expected[tableIndex]!);
    const header = table.slice(0, headerEnd);
    expect(header[0]!.value === "TABLE" && exactOne(header, 2, "table.name") === expected[tableIndex], "S7_DXF_TABLE_INVALID", "table.order");
    expect(header.map((pair) => pair.code).join("|") === "0|5|100|2|70", "S7_DXF_TABLE_INVALID", "table.order");
    const tableHandle = requireHandle(header, 5, "table.handle");
    assertUniqueHandle(registry, tableHandle);
    expect(exactOne(header, 100, "table.subclass") === "AcDbSymbolTable", "S7_DXF_TABLE_INVALID", "table.subclass");
    const count = integer(exactOne(header, 70, "table.count"));
    const recordsForTable = splitRecords(table.slice(headerEnd, -1));
    expect(recordsForTable.length <= MAX_TABLE_RECORDS, "S7_RESOURCE_LIMIT", "table.records");
    expect(recordsForTable.length === count, "S7_DXF_TABLE_INVALID", "table.count");
    if (expected[tableIndex] === "BLOCK_RECORD") expect(recordsForTable.map((record) => exactOne(record, 2, "block-record.name")).join("|") === "*MODEL_SPACE|*PAPER_SPACE", "S7_DXF_TABLE_INVALID", "block-record.order");
    for (const record of recordsForTable) {
      const expectedRecord = expected[tableIndex]!;
      expect(record[0]!.value === expectedRecord, "S7_DXF_TABLE_INVALID", "record.type");
      const expectedRecordCodes: Record<string, string> = { LTYPE: "0|5|330|100|2|70|3|72|73|40", LAYER: "0|5|330|100|2|70|62|6|370", APPID: "0|5|330|100|2|70", BLOCK_RECORD: "0|5|330|100|2" };
      expect(record.map((pair) => pair.code).join("|") === expectedRecordCodes[expectedRecord], "S7_DXF_TABLE_INVALID", "record.order");
      const recordHandle = requireHandle(record, 5, "record.handle");
      assertUniqueHandle(registry, recordHandle);
      expect(exactOne(record, 330, "record.owner") === tableHandle, "S7_DXF_TABLE_INVALID", "record.owner");
      if (expectedRecord === "LTYPE") {
        expect(exactOne(record, 2, "linetype.name") === "CONTINUOUS", "S7_DXF_TABLE_INVALID", "linetype");
        expect(exactOne(record, 100, "linetype.subclass") === "AcDbLinetypeTableRecord", "S7_DXF_TABLE_INVALID", "linetype");
        canonicalMm(exactOne(record, 40, "linetype.length"));
      } else if (expectedRecord === "LAYER") {
        const name = exactOne(record, 2, "layer.name");
        expect((LAYER_ORDER as readonly string[]).includes(name), "S7_DXF_TABLE_INVALID", "layer.name");
        layerNames.push(name);
        expect(exactOne(record, 100, "layer.subclass") === "AcDbLayerTableRecord", "S7_DXF_TABLE_INVALID", "layer");
        expect(integer(exactOne(record, 70, "layer.flags")) === 0, "S7_DXF_TABLE_INVALID", "layer.flags");
        expect(integer(exactOne(record, 62, "layer.color")) === 7, "S7_DXF_TABLE_INVALID", "layer.color");
        expect(exactOne(record, 6, "layer.linetype") === "CONTINUOUS", "S7_DXF_TABLE_INVALID", "layer.linetype");
        expect(integer(exactOne(record, 370, "layer.lineweight")) === -1, "S7_DXF_TABLE_INVALID", "layer.lineweight");
      } else if (expectedRecord === "APPID") {
        expect(exactOne(record, 2, "appid.name") === APPID, "S7_DXF_TABLE_INVALID", "appid.name");
        expect(exactOne(record, 100, "appid.subclass") === "AcDbRegAppTableRecord", "S7_DXF_TABLE_INVALID", "appid");
      } else {
        const name = exactOne(record, 2, "block-record.name");
        expect(name === "*MODEL_SPACE" || name === "*PAPER_SPACE", "S7_DXF_TABLE_INVALID", "block-record.name");
        expect(exactOne(record, 100, "block-record.subclass") === "AcDbSymbolTableRecord", "S7_DXF_TABLE_INVALID", "block-record");
        if (name === "*MODEL_SPACE") modelRecord = recordHandle;
        else paperRecord = recordHandle;
      }
    }
  });
  expect(layerNames.join("|") === LAYER_ORDER.join("|"), "S7_DXF_TABLE_INVALID", "layer.order");
  expect(modelRecord !== "" && paperRecord !== "", "S7_DXF_TABLE_INVALID", "block-records");
  return { layers: LAYER_ORDER, modelRecord, paperRecord };
}

function parseBlocks(body: readonly Pair[], registry: Set<string>, modelRecord: string, paperRecord: string): void {
  const records = splitRecords(body);
  expect(records.length === 4, "S7_DXF_BLOCK_INVALID", "blocks");
  for (let index = 0; index < records.length; index += 2) {
    const begin = records[index]!;
    const end = records[index + 1]!;
    expect(begin[0]!.value === "BLOCK" && end[0]!.value === "ENDBLK", "S7_DXF_BLOCK_INVALID", "order");
    const beginHandle = requireHandle(begin, 5, "block.handle");
    const endHandle = requireHandle(end, 5, "endblk.handle");
    expect(begin.map((pair) => pair.code).join("|") === "0|5|330|100|8|100|2|70|10|20|30|3|1", "S7_DXF_BLOCK_INVALID", "block.order");
    expect(end.map((pair) => pair.code).join("|") === "0|5|330|100|8|100", "S7_DXF_BLOCK_INVALID", "endblk.order");
    assertUniqueHandle(registry, beginHandle);
    assertUniqueHandle(registry, endHandle);
    const owner = exactOne(begin, 330, "block.owner");
    expect(owner === modelRecord || owner === paperRecord, "S7_DXF_BLOCK_INVALID", "block.owner");
    expect(exactOne(end, 330, "endblk.owner") === owner, "S7_DXF_BLOCK_INVALID", "endblk.owner");
    expect(all(begin, 100).join("|") === "AcDbEntity|AcDbBlockBegin", "S7_DXF_BLOCK_INVALID", "block.subclass");
    expect(all(end, 100).join("|") === "AcDbEntity|AcDbBlockEnd", "S7_DXF_BLOCK_INVALID", "endblk.subclass");
    expect(exactOne(begin, 8, "block.layer") === "0" && exactOne(end, 8, "endblk.layer") === "0", "S7_DXF_BLOCK_INVALID", "block.layer");
    const name = exactOne(begin, 2, "block.name");
    expect(name === (index === 0 ? "*MODEL_SPACE" : "*PAPER_SPACE"), "S7_DXF_BLOCK_INVALID", "block.name");
    expect(exactOne(begin, 3, "block.name2") === name && exactOne(begin, 1, "block.xref") === "", "S7_DXF_BLOCK_INVALID", "block.name");
    expect(integer(exactOne(begin, 70, "block.flags")) === 0, "S7_DXF_BLOCK_INVALID", "block.flags");
    canonicalMm(exactOne(begin, 10, "block.x"));
    canonicalMm(exactOne(begin, 20, "block.y"));
    expect(canonicalMm(exactOne(begin, 30, "block.z")) === 0, "S7_DXF_BLOCK_INVALID", "block.z");
  }
}

function parseXdata(pairs: readonly Pair[], source?: S7SourceStamp): Omit<S7ReadbackEntity, "handle" | "ownerHandle" | "entityType" | "layer" | "vertexCount"> {
  const index = pairs.findIndex((pair) => pair.code === 1001);
  expect(index >= 0, "S7_DXF_XDATA_INVALID", "xdata");
  const body = pairs.slice(index);
  expect(body[0]!.value === APPID && body[0]!.code === 1001, "S7_DXF_XDATA_INVALID", "appid");
  expect(body.slice(1).every((pair) => pair.code === 1000), "S7_DXF_XDATA_INVALID", "xdata.codes");
  const strings = body.slice(1).map((pair) => pair.value);
  expect(strings.length === 9 && strings[0] === "S7V1", "S7_DXF_XDATA_INVALID", "xdata.grammar");
  if (strings.length > MAX_XDATA_STRINGS) fail("S7_RESOURCE_LIMIT", "xdata.strings");
  for (const value of strings) checkPrintable(value, "xdata", 240);
  const fields = new Map<string, string>();
  for (const value of strings.slice(1)) {
    const separator = value.indexOf("=");
    expect(separator === 1, "S7_DXF_XDATA_INVALID", "xdata.field");
    const key = value[0]!;
    expect(!fields.has(key), "S7_DXF_XDATA_INVALID", "xdata.field");
    fields.set(key, value.slice(2));
  }
  expect(Array.from(fields.keys()).join("|") === "O|K|P|R|I|G|V|H", "S7_DXF_XDATA_INVALID", "xdata.order");
  const partIndex = integer(fields.get("I")!);
  expect(partIndex >= 0, "S7_DXF_XDATA_INVALID", "xdata.partIndex");
  expect(fields.get("P") === "-" || fields.get("P")!.length > 0, "S7_DXF_XDATA_INVALID", "xdata.parent");
  if (source) {
    expect(fields.get("V") === derivedToken(source.sourceRevisionId), "S7_DXF_XDATA_INVALID", "xdata.revision");
    expect(fields.get("H") === derivedToken(source.sourceRevisionHash), "S7_DXF_XDATA_INVALID", "xdata.revisionHash");
  }
  const xdataBytes = Buffer.byteLength(body.map((pair) => `${pair.code}\n${pair.value}`).join("\n"), "ascii");
  if (xdataBytes > MAX_XDATA_BYTES) fail("S7_RESOURCE_LIMIT", "xdata.bytes");
  return {
    sourceObjectIdToken: fields.get("O")!,
    identityKeyToken: fields.get("K")!,
    parentObjectIdToken: fields.get("P")!,
    roleToken: fields.get("R")!,
    partIndex,
    geometryStateToken: fields.get("G")!,
    sourceRevisionIdToken: fields.get("V")!,
    sourceRevisionHashToken: fields.get("H")!,
  };
}

function parseEntity(record: readonly Pair[], registry: Set<string>, modelRecord: string, source?: S7SourceStamp): { entity: S7ReadbackEntity; bounds: Bounds; vertexCount: number } {
  const type = record[0]!.value;
  if (!(type === "LWPOLYLINE" || type === "LINE" || type === "POINT" || type === "CIRCLE" || type === "ELLIPSE" || type === "TEXT")) fail("S7_DXF_ENTITY_INVALID", "type");
  const handleValue = requireHandle(record, 5, "entity.handle");
  assertUniqueHandle(registry, handleValue);
  const ownerHandle = exactOne(record, 330, "entity.owner");
  expect(ownerHandle === modelRecord, "S7_DXF_ENTITY_INVALID", "entity.owner");
  expect(all(record, 100).length === 2 && all(record, 100)[0] === "AcDbEntity", "S7_DXF_ENTITY_INVALID", "entity.subclass");
  const subclass = all(record, 100)[1]!;
  const expectedSubclass: Record<string, string> = { LWPOLYLINE: "AcDbPolyline", LINE: "AcDbLine", POINT: "AcDbPoint", CIRCLE: "AcDbCircle", ELLIPSE: "AcDbEllipse", TEXT: "AcDbText" };
  expect(subclass === expectedSubclass[type]!, "S7_DXF_ENTITY_INVALID", "entity.subclass");
  const layer = exactOne(record, 8, "entity.layer");
  expect((LAYER_ORDER as readonly string[]).includes(layer), "S7_DXF_ENTITY_INVALID", "entity.layer");
  expect(integer(exactOne(record, 370, "entity.lineweight")) === -1, "S7_DXF_ENTITY_INVALID", "entity.lineweight");
  expect(exactOne(record, 410, "entity.layout") === "Model", "S7_DXF_ENTITY_INVALID", "entity.layout");
  const xdataIndex = record.findIndex((pair) => pair.code === 1001);
  expect(xdataIndex > 0 && xdataIndex === record.length - 10, "S7_DXF_ENTITY_INVALID", "entity.xdata");
  const geometry = record.slice(0, xdataIndex);
  const commonCodes = [0, 5, 330, 100, 410, 8, 370, 100];
  const entityCodes: Record<string, number[]> = {
    LWPOLYLINE: [90, 70],
    LINE: [10, 20, 30, 11, 21, 31],
    POINT: [10, 20, 30],
    CIRCLE: [10, 20, 30, 40],
    ELLIPSE: [10, 20, 30, 11, 21, 31, 40, 41, 42],
    TEXT: [10, 20, 30, 40, 1, 50],
  };
  const expectedGeometryCodes = type === "LWPOLYLINE"
    ? commonCodes.concat(entityCodes[type], Array.from({ length: 2 * (integer(exactOne(geometry, 90, "polyline.count"))) }, (_, index) => index % 2 === 0 ? 10 : 20))
    : commonCodes.concat(entityCodes[type]!);
  expect(geometry.map((pair) => pair.code).join("|") === expectedGeometryCodes.join("|"), "S7_DXF_ENTITY_INVALID", "entity.order");
  const values = (code: number): string[] => all(geometry, code);
  const one = (code: number, field: string): number => canonicalMm(exactOne(geometry, code, field));
  let bounds: Bounds;
  let vertexCount = 1;
  if (type === "LWPOLYLINE") {
    const count = integer(exactOne(geometry, 90, "polyline.count"));
    expect(count >= 1, "S7_DXF_ENTITY_INVALID", "polyline.count");
    expect(integer(exactOne(geometry, 70, "polyline.closed")) === 1, "S7_DXF_ENTITY_INVALID", "polyline.closed");
    const xs = values(10).map((value) => canonicalMm(value));
    const ys = values(20).map((value) => canonicalMm(value));
    expect(xs.length === count && ys.length === count, "S7_DXF_ENTITY_INVALID", "polyline.vertices");
    vertexCount = count;
    bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  } else if (type === "LINE") {
    const x1 = one(10, "line.x1");
    const y1 = one(20, "line.y1");
    expect(one(30, "line.z1") === 0, "S7_DXF_ENTITY_INVALID", "line.z1");
    const x2 = one(11, "line.x2");
    const y2 = one(21, "line.y2");
    expect(one(31, "line.z2") === 0, "S7_DXF_ENTITY_INVALID", "line.z2");
    bounds = { minX: Math.min(x1, x2), minY: Math.min(y1, y2), maxX: Math.max(x1, x2), maxY: Math.max(y1, y2) };
    vertexCount = 2;
  } else if (type === "POINT") {
    const x = one(10, "point.x");
    const y = one(20, "point.y");
    expect(one(30, "point.z") === 0, "S7_DXF_ENTITY_INVALID", "point.z");
    bounds = { minX: x, minY: y, maxX: x, maxY: y };
  } else if (type === "CIRCLE") {
    const x = one(10, "circle.x");
    const y = one(20, "circle.y");
    expect(one(30, "circle.z") === 0, "S7_DXF_ENTITY_INVALID", "circle.z");
    const radius = one(40, "circle.radius");
    expect(radius >= 0, "S7_DXF_ENTITY_INVALID", "circle.radius");
    bounds = { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius };
  } else if (type === "ELLIPSE") {
    const x = one(10, "ellipse.x");
    const y = one(20, "ellipse.y");
    expect(one(30, "ellipse.z") === 0, "S7_DXF_ENTITY_INVALID", "ellipse.z");
    const majorX = one(11, "ellipse.majorX");
    const majorY = one(21, "ellipse.majorY");
    expect(one(31, "ellipse.majorZ") === 0, "S7_DXF_ENTITY_INVALID", "ellipse.majorZ");
    const ratio = canonicalFixed12(exactOne(geometry, 40, "ellipse.ratio"));
    const start = canonicalFixed12(exactOne(geometry, 41, "ellipse.start"));
    const end = canonicalFixed12(exactOne(geometry, 42, "ellipse.end"));
    expect(ratio > 0 && ratio <= 1 && start >= 0 && end > start && end <= 13, "S7_DXF_ENTITY_INVALID", "ellipse.parameters");
    const minorX = -majorY * ratio;
    const minorY = majorX * ratio;
    bounds = { minX: x - Math.abs(majorX) - Math.abs(minorX), minY: y - Math.abs(majorY) - Math.abs(minorY), maxX: x + Math.abs(majorX) + Math.abs(minorX), maxY: y + Math.abs(majorY) + Math.abs(minorY) };
  } else {
    const x = one(10, "text.x");
    const y = one(20, "text.y");
    expect(one(30, "text.z") === 0, "S7_DXF_ENTITY_INVALID", "text.z");
    const height = one(40, "text.height");
    expect(height >= 0, "S7_DXF_ENTITY_INVALID", "text.height");
    const value = exactOne(geometry, 1, "text.value");
    checkPrintable(value, "text.value");
    canonicalFixed12(exactOne(geometry, 50, "text.rotation"));
    bounds = { minX: x, minY: y, maxX: x, maxY: y };
  }
  const xdata = parseXdata(record, source);
  return { entity: { handle: handleValue, ownerHandle, entityType: type, layer, vertexCount, ...xdata }, bounds, vertexCount };
}

function mergeBounds(current: Bounds | null, next: Bounds): Bounds {
  if (!current) return next;
  return { minX: Math.min(current.minX, next.minX), minY: Math.min(current.minY, next.minY), maxX: Math.max(current.maxX, next.maxX), maxY: Math.max(current.maxY, next.maxY) };
}

function compareManifest(entities: readonly S7ReadbackEntity[], manifest: S7CadManifestDocument): void {
  validateManifestDocument(manifest);
  expect(manifest.schemaVersion === "s7-cad-manifest-v1" && manifest.dxfVersion === DXF_VERSION && manifest.worldToPlanVersion === WORLD_TO_PLAN_VERSION, "S7_MANIFEST_INVALID", "manifest.version");
  expect(manifest.entities.length === entities.length, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.entities");
  const byHandle = new Map(manifest.entities.map((entry) => [entry.handle, entry]));
  expect(byHandle.size === manifest.entities.length, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.handles");
  for (const entity of entities) {
    const entry = byHandle.get(entity.handle);
    expect(!!entry, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.handle");
    const expected = entry!;
    expect(expected.entityType === entity.entityType && expected.emittedLayer === entity.layer, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.entity");
    expect(derivedToken(expected.sourceObjectId) === entity.sourceObjectIdToken && derivedToken(expected.identityKey) === entity.identityKeyToken && derivedToken(expected.parentObjectId) === entity.parentObjectIdToken, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.identity");
    expect(derivedToken(expected.role) === entity.roleToken && expected.partIndex === entity.partIndex && expected.geometryState === entity.geometryStateToken, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.metadata");
  }
}

export function parseS7Dxf(bytes: Uint8Array, options: S7ReadbackOptions = {}): S7ReadbackResult {
  const pairs = parseAsciiPairs(bytes);
  expect(pairs[pairs.length - 1]!.code === 0 && pairs[pairs.length - 1]!.value === "EOF", "S7_DXF_READBACK_INVALID", "eof");
  const withoutEof = pairs.slice(0, -1);
  const sections = sectionPairs(withoutEof);
  const expectedSections = ["HEADER", "TABLES", "BLOCKS", "ENTITIES"];
  expect(Array.from(sections.keys()).join("|") === expectedSections.join("|"), "S7_DXF_SECTION_INVALID", "order");
  const header = parseHeader(sections.get("HEADER")!);
  const registry = new Set<string>();
  const { layers, modelRecord, paperRecord } = parseTables(sections.get("TABLES")!, registry);
  parseBlocks(sections.get("BLOCKS")!, registry, modelRecord, paperRecord);
  const entityRecords = splitRecords(sections.get("ENTITIES")!);
  expect(entityRecords.length <= MAX_ENTITIES, "S7_RESOURCE_LIMIT", "entities");
  const entities: S7ReadbackEntity[] = [];
  let vertexCount = 0;
  let bounds: Bounds | null = null;
  for (const record of entityRecords) {
    const parsed = parseEntity(record, registry, modelRecord, options.expectedSource);
    entities.push(parsed.entity);
    vertexCount += parsed.vertexCount;
    bounds = mergeBounds(bounds, parsed.bounds);
  }
  expect(vertexCount <= MAX_VERTICES, "S7_RESOURCE_LIMIT", "vertices");
  const resolvedBounds = bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  expect(resolvedBounds.minX === header.extents.minX && resolvedBounds.minY === header.extents.minY && resolvedBounds.maxX === header.extents.maxX && resolvedBounds.maxY === header.extents.maxY, "S7_DXF_EXTENTS_INVALID", "extents");
  const largest = Math.max(...Array.from(registry, (value) => handle(value)));
  expect(handle(header.handseed) === largest + 1, "S7_DXF_HANDLE_INVALID", "handseed");
  if (options.expectedManifest) {
    validateManifestDocument(options.expectedManifest);
    if (options.expectedSource) validateS7ManifestSource(options.expectedManifest, options.expectedSource);
    compareManifest(entities, options.expectedManifest);
  }
  return {
    readbackVersion: S7_READBACK_VERSION,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    entityCount: entities.length,
    vertexCount,
    entities,
    layers,
    handseed: header.handseed,
    extents: resolvedBounds,
    outcome: "pass",
    correspondenceResult: options.expectedManifest ? "pass" : "not_checked",
    issues: [],
  };
}

export function decodeS7Manifest(bytes: Uint8Array): S7CadManifestDocument {
  if (bytes.length > 4_000_000) fail("S7_RESOURCE_LIMIT", "manifest");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("S7_MANIFEST_INVALID");
  }
  validateManifestDocument(value);
  return value as S7CadManifestDocument;
}

export function validateS7ManifestSource(manifest: S7CadManifestDocument, source: S7SourceStamp): void {
  validateManifestDocument(manifest);
  expect(manifest.source.sourceRevisionId === source.sourceRevisionId && manifest.source.sourceRevisionHash === source.sourceRevisionHash && manifest.source.sourceS5Fingerprint === source.sourceS5Fingerprint && manifest.source.validationReceiptId === source.validationReceiptId && manifest.source.validationHash === source.validationHash && manifest.source.s6HandoffSchemaVersion === source.s6HandoffSchemaVersion && manifest.source.handoffDigest === source.handoffDigest, "S7_MANIFEST_CORRESPONDENCE_FAILED", "manifest.source");
  expect(uuidV4Pattern.test(manifest.manifestId) && uuidV4Pattern.test(manifest.artifactId), "S7_MANIFEST_INVALID", "manifest.identity");
}
