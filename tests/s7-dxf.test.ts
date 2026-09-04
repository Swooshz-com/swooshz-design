import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { AppError, type S6ToS7Handoff, type S7SourceStamp } from "../src/lib/types";
import { parseS7Dxf } from "../src/lib/s7-dxf-readback";
import { formatS7Fixed12, formatS7Mm, writeS7Dxf } from "../src/lib/s7-dxf-writer";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as const;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as const;
const ARTIFACT_ID = "40000000-0000-4000-8000-000000000001" as const;
const MANIFEST_ID = "40000000-0000-4000-8000-000000000002" as const;
const HASH = "a".repeat(64);

const source: S7SourceStamp = { sourceRevisionId: REVISION_ID, sourceRevisionHash: HASH, sourceS5Fingerprint: HASH, validationReceiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, s6HandoffSchemaVersion: "s6-to-s7-handoff-v1", handoffDigest: HASH };

type DxfPair = { code: number; value: string };

function handoff(identityKey = "object-1"): S6ToS7Handoff {
  const object = {
    objectId: "object-1", identityKey, parentObjectId: null, objectType: "box", role: "furniture",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" },
    footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 }, transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null },
  };
  return { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID, acceptedRevisionId: REVISION_ID, acceptedRevisionHash: HASH, sourceS5Fingerprint: HASH, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" }, booth: { widthMm: 6000, depthMm: 3000, openSides: ["north", "east"], maxHeightMm: 3000, heightState: "known" }, objects: [object], hierarchy: [{ objectId: "object-1", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [], validationReceipt: { receiptId: source.validationReceiptId, validationHash: HASH, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false } } as unknown as S6ToS7Handoff;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : String(error);
}

function assertTableHeader(text: string, tableName: string, count: number): void {
  const pattern = new RegExp(`\\n0\\nTABLE\\n2\\n${tableName}\\n5\\n[1-9A-F][0-9A-F]*\\n330\\n0\\n100\\nAcDbSymbolTable\\n70\\n${count}\\n`, "u");
  assert.match(text, pattern);
}

function assertTableSubclass(text: string, tableName: string, typeSpecific: string): void {
  const pattern = new RegExp(`\\n0\\n${tableName}\\n5\\n[0-9A-F]+\\n330\\n[0-9A-F]+\\n100\\nAcDbSymbolTableRecord\\n100\\n${typeSpecific}\\n`, "u");
  assert.match(text, pattern);
}

function setPair(pairs: DxfPair[], code: number, value: string): void {
  const pair = pairs.find((item) => item.code === code);
  assert.ok(pair, `missing group code ${code}`);
  pair!.value = value;
}

function setPolylineVertices(pairs: DxfPair[], vertices: readonly (readonly [number, number])[]): void {
  const xdataIndex = pairs.findIndex((pair) => pair.code === 1001);
  assert.ok(xdataIndex > 0);
  const geometry = pairs.slice(0, xdataIndex).filter((pair) => pair.code !== 10 && pair.code !== 20);
  const closedIndex = geometry.findIndex((pair) => pair.code === 70);
  assert.ok(closedIndex >= 0);
  const coordinates = vertices.flatMap(([x, y]) => [{ code: 10, value: String(x) }, { code: 20, value: String(y) }]);
  geometry.splice(closedIndex + 1, 0, ...coordinates);
  pairs.splice(0, pairs.length, ...geometry, ...pairs.slice(xdataIndex));
  setPair(pairs, 90, String(vertices.length));
}

function mutateFirstEntity(bytes: Uint8Array, entityType: string, mutate: (pairs: DxfPair[]) => void): Buffer {
  const text = Buffer.from(bytes).toString("ascii");
  const entitiesMarker = "0\nSECTION\n2\nENTITIES\n";
  const entitiesStart = text.indexOf(entitiesMarker);
  assert.ok(entitiesStart >= 0);
  const start = text.indexOf("0\n" + entityType + "\n", entitiesStart + entitiesMarker.length);
  assert.ok(start >= 0);
  const lines = text.split("\n");
  const startLine = text.slice(0, start).split("\n").length - 1;
  let endLine = startLine + 2;
  while (endLine < lines.length && lines[endLine] !== "0") endLine += 2;
  assert.ok(endLine < lines.length);
  const recordLines = lines.slice(startLine, endLine);
  assert.equal(recordLines.length % 2, 0);
  const pairs: DxfPair[] = [];
  for (let index = 0; index < recordLines.length; index += 2) pairs.push({ code: Number(recordLines[index]), value: recordLines[index + 1]! });
  mutate(pairs);
  const record = pairs.flatMap((pair) => [String(pair.code), pair.value]).join("\n");
  return Buffer.from(lines.slice(0, startLine).concat(record.split("\n"), lines.slice(endLine)).join("\n"), "ascii");
}

function blockRecordHandle(text: string, blockName: string): string {
  const escapedName = blockName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = text.match(new RegExp(`0\\nBLOCK_RECORD\\n5\\n([0-9A-F]+)\\n330\\n[0-9A-F]+\\n100\\nAcDbSymbolTableRecord\\n100\\nAcDbBlockTableRecord\\n2\\n${escapedName}\\n`, "u"));
  assert.ok(match?.[1]);
  return match![1]!;
}

function mutateBlockOwners(bytes: Uint8Array, blockName: string, blockOwner: string, endBlockOwner: string): Buffer {
  const text = Buffer.from(bytes).toString("ascii");
  const blocksMarker = "0\nSECTION\n2\nBLOCKS\n";
  const blocksStart = text.indexOf(blocksMarker);
  assert.ok(blocksStart >= 0);
  const section = text.slice(blocksStart);
  const nameIndex = section.indexOf(`2\n${blockName}\n`);
  assert.ok(nameIndex >= 0);
  const blockStart = section.lastIndexOf("0\nBLOCK\n", nameIndex);
  assert.ok(blockStart >= 0);
  const endBlockMarker = "\n0\nENDBLK\n";
  const endBlock = section.indexOf(endBlockMarker, nameIndex);
  assert.ok(endBlock >= 0);
  const blockEnd = section.indexOf("\n0\n", endBlock + endBlockMarker.length);
  assert.ok(blockEnd >= 0);
  const block = section.slice(blockStart, blockEnd);
  let ownerIndex = 0;
  const replaced = block.replace(/\n330\n[^\n]+\n/gu, () => {
    ownerIndex += 1;
    return `\n330\n${ownerIndex === 1 ? blockOwner : endBlockOwner}\n`;
  });
  assert.equal(ownerIndex, 2);
  return Buffer.from(text.slice(0, blocksStart + blockStart) + replaced + text.slice(blocksStart + blockEnd), "ascii");
}

function roundPrismHandoff(rotationMd: { xMd: number; yMd: number; zMd: number }): S6ToS7Handoff {
  const value = handoff();
  const object = value.objects[0]!;
  object.geometry = { kind: "round_prism", radiusMm: 450, heightMm: 1100, geometryState: "exact", localAnchor: "floor" };
  object.transform = { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd };
  return value;
}

test("transport numeric format is half-away-from-zero, bounded, locale-independent, and non-exponential", () => {
  assert.equal(formatS7Mm(1.005), "1.01");
  assert.equal(formatS7Mm(-1.005), "-1.01");
  assert.equal(formatS7Mm(-0), "0");
  assert.equal(formatS7Mm(1000), "1000");
  assert.equal(formatS7Fixed12(-0), "0.000000000000");
  assert.equal(formatS7Fixed12(Math.PI), "3.141592653590");
  assert.equal(/[eE]|-0(?:\.0+)?$/u.test(formatS7Mm(-0)), false);
});

test("writer emits deterministic AC1015 scaffold, locked layers, handles, extents, XDATA, and private manifest correspondence", () => {
  const first = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const second = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  const text = first.bytes.toString("ascii");
  assert.match(text, /\n1\nAC1015\n/u);
  assert.match(text, /\n70\n4\n/u);
  assert.match(text, /\n1\ns7-dxf-r2000-ascii-v1\n/u);
  assert.deepEqual([...text.matchAll(/\n2\n([A-Z_]+)\n/g)].map((match) => match[1]).filter((value) => ["LTYPE", "LAYER", "APPID", "BLOCK_RECORD"].includes(value!)), ["LTYPE", "LAYER", "APPID", "BLOCK_RECORD"]);
  assert.equal(text.includes("SWOOSHZ_S7"), true);
  assert.equal(text.includes("S7V1"), true);
  assert.equal(/[eE][+-]?\d+/u.test(text), false);
  assert.equal(/(?:^|\n)-0(?:\n|$)/u.test(text), false);
  assert.equal(text.includes("$EXTMIN"), true);
  assert.equal(text.includes("$EXTMAX"), true);
  assertTableHeader(text, "LTYPE", 1);
  assertTableHeader(text, "LAYER", 11);
  assertTableHeader(text, "APPID", 1);
  assertTableHeader(text, "BLOCK_RECORD", 2);
  assertTableSubclass(text, "LTYPE", "AcDbLinetypeTableRecord");
  assert.equal((text.match(/\n0\nLAYER\n5\n[0-9A-F]+\n330\n[0-9A-F]+\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n/gu) ?? []).length, 11);
  assertTableSubclass(text, "APPID", "AcDbRegAppTableRecord");
  assertTableSubclass(text, "BLOCK_RECORD", "AcDbBlockTableRecord");
  const parsed = parseS7Dxf(first.bytes, { expectedManifest: first.manifest, expectedSource: source });
  assert.equal(parsed.outcome, "pass");
  assert.equal(parsed.correspondenceResult, "pass");
  assert.equal(parsed.entityCount, first.entityCount);
  assert.match(parsed.handseed, /^[0-9A-F]+$/u);
});

test("strict readback rejects non-canonical symbol-table header owner and order", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const text = generated.bytes.toString("ascii");
  const header = "\n0\nTABLE\n2\nLTYPE\n5\n1\n330\n0\n100\nAcDbSymbolTable\n70\n1\n";
  const wrongOwner = text.replace(header, header.replace("330\n0", "330\n1"));
  assert.notEqual(wrongOwner, text);
  assert.throws(() => parseS7Dxf(Buffer.from(wrongOwner, "ascii")), (error) => errorCode(error) === "S7_DXF_TABLE_INVALID");
  const wrongOrder = text.replace(header, "\n0\nTABLE\n5\n1\n2\nLTYPE\n330\n0\n100\nAcDbSymbolTable\n70\n1\n");
  assert.notEqual(wrongOrder, text);
  assert.throws(() => parseS7Dxf(Buffer.from(wrongOrder, "ascii")), (error) => errorCode(error) === "S7_DXF_TABLE_INVALID");
});

test("strict readback binds each BLOCK and ENDBLK owner to its matching BLOCK_RECORD", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const text = generated.bytes.toString("ascii");
  const modelRecord = blockRecordHandle(text, "*MODEL_SPACE");
  const paperRecord = blockRecordHandle(text, "*PAPER_SPACE");
  const cases = [
    { name: "swapped complete pairs", model: [paperRecord, paperRecord], paper: [modelRecord, modelRecord] },
    { name: "model BLOCK cross-link", model: [paperRecord, modelRecord], paper: [paperRecord, paperRecord] },
    { name: "model ENDBLK cross-link", model: [modelRecord, paperRecord], paper: [paperRecord, paperRecord] },
    { name: "paper BLOCK cross-link", model: [modelRecord, modelRecord], paper: [modelRecord, paperRecord] },
    { name: "paper ENDBLK cross-link", model: [modelRecord, modelRecord], paper: [paperRecord, modelRecord] },
  ] as const;
  for (const testCase of cases) {
    const malformed = mutateBlockOwners(
      mutateBlockOwners(generated.bytes, "*MODEL_SPACE", testCase.model[0], testCase.model[1]),
      "*PAPER_SPACE",
      testCase.paper[0],
      testCase.paper[1],
    );
    assert.throws(() => parseS7Dxf(malformed), (error) => errorCode(error) === "S7_DXF_BLOCK_INVALID", testCase.name);
  }
});

test("readback rejects malformed, non-canonical, oversized, and injected DXF content", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("AC1015", "AC1014"), "ascii")), (error) => errorCode(error) === "S7_DXF_HEADER_INVALID");
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("\n0\nEOF\n", "\n0\nEOF\n\n"), "ascii")), /S7_/u);
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("\n10\n0\n", "\n10\n1e2\n"), "ascii")), /S7_/u);
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii") + "x", "ascii")), /S7_/u);
  assert.throws(() => writeS7Dxf(handoff("bad\\injection"), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source }), (error) => errorCode(error) === "S7_DXF_TEXT_INVALID");
});

test("strict readback rejects both old shortened symbol-table-entry profiles", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const text = generated.bytes.toString("ascii");
  const missingCommon = text.replace("\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n", "\n100\nAcDbLinetypeTableRecord\n");
  assert.notEqual(missingCommon, text);
  assert.throws(() => parseS7Dxf(Buffer.from(missingCommon, "ascii")), /S7_/u);
  const missingTypeSpecific = text.replace("\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n2\n*MODEL_SPACE\n", "\n100\nAcDbSymbolTableRecord\n2\n*MODEL_SPACE\n");
  assert.notEqual(missingTypeSpecific, text);
  assert.throws(() => parseS7Dxf(Buffer.from(missingTypeSpecific, "ascii")), /S7_/u);
});

test("analytic round-prism geometry survives writer to independent readback with ELLIPSE arcs and tangent LINEs", () => {
  const analyticHandoff = roundPrismHandoff({ xMd: 30_000, yMd: 0, zMd: 0 });
  const generated = writeS7Dxf(analyticHandoff, { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  assert.equal(generated.plan.entities.filter((entity) => entity.entityType === "ELLIPSE").length, 2);
  assert.equal(generated.plan.entities.filter((entity) => entity.entityType === "LINE" && entity.sourceObjectId === "object-1").length, 2);
  const parsed = parseS7Dxf(generated.bytes, { expectedManifest: generated.manifest, expectedSource: source });
  assert.equal(parsed.entities.filter((entity) => entity.entityType === "ELLIPSE").length, 2);
  assert.equal(parsed.entities.filter((entity) => entity.entityType === "LINE" && entity.sourceObjectIdToken === "object-1").length, 2);
});

test("strict readback rejects adversarial degenerate LINE, LWPOLYLINE, CIRCLE, and ELLIPSE entities", () => {
  const polygonSource = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  for (const vertices of [[[0, 0]], [[0, 0], [100, 0]], [[0, 0], [100, 0], [200, 0]]] as const) {
    const malformed = mutateFirstEntity(polygonSource.bytes, "LWPOLYLINE", (pairs) => setPolylineVertices(pairs, vertices));
    assert.throws(() => parseS7Dxf(malformed), (error) => errorCode(error) === "S7_DXF_ENTITY_INVALID");
  }

  const analytic = writeS7Dxf(roundPrismHandoff({ xMd: 30_000, yMd: 0, zMd: 0 }), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const coincidentLine = mutateFirstEntity(analytic.bytes, "LINE", (pairs) => {
    setPair(pairs, 11, pairs.find((pair) => pair.code === 10)!.value);
    setPair(pairs, 21, pairs.find((pair) => pair.code === 20)!.value);
  });
  assert.throws(() => parseS7Dxf(coincidentLine), (error) => errorCode(error) === "S7_DXF_ENTITY_INVALID");

  const circle = writeS7Dxf(roundPrismHandoff({ xMd: 0, yMd: 0, zMd: 0 }), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  assert.equal(circle.plan.entities.some((entity) => entity.entityType === "CIRCLE"), true);
  const zeroRadius = mutateFirstEntity(circle.bytes, "CIRCLE", (pairs) => setPair(pairs, 40, "0"));
  assert.throws(() => parseS7Dxf(zeroRadius), (error) => errorCode(error) === "S7_DXF_ENTITY_INVALID");

  const zeroMajorAxis = mutateFirstEntity(analytic.bytes, "ELLIPSE", (pairs) => {
    setPair(pairs, 11, "0");
    setPair(pairs, 21, "0");
  });
  assert.throws(() => parseS7Dxf(zeroMajorAxis), (error) => errorCode(error) === "S7_DXF_ENTITY_INVALID");
});

test("golden and independent hand-authored AC1015 fixtures are accepted", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  const goldenBytes = readFileSync("tests/fixtures/s7/golden-plan-minimal.dxf");
  assert.deepEqual(goldenBytes, generated.bytes);
  const golden = parseS7Dxf(goldenBytes, { expectedManifest: generated.manifest, expectedSource: source });
  assert.equal(golden.readbackVersion, "s7-cad-readback-v1");
  assert.equal(golden.entityCount, generated.entityCount);
  assert.equal(golden.entities.some((entity) => entity.entityType === "LWPOLYLINE"), true);

  const handAuthored = parseS7Dxf(readFileSync("tests/fixtures/s7/hand-authored-valid-ac1015.dxf"));
  assert.equal(handAuthored.readbackVersion, "s7-cad-readback-v1");
  assert.equal(handAuthored.entityCount, 1);
  assert.equal(handAuthored.entities[0]?.entityType, "LINE");
});
