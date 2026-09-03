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
  const parsed = parseS7Dxf(first.bytes, { expectedManifest: first.manifest, expectedSource: source });
  assert.equal(parsed.outcome, "pass");
  assert.equal(parsed.correspondenceResult, "pass");
  assert.equal(parsed.entityCount, first.entityCount);
  assert.match(parsed.handseed, /^[0-9A-F]+$/u);
});

test("readback rejects malformed, non-canonical, oversized, and injected DXF content", () => {
  const generated = writeS7Dxf(handoff(), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source });
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("AC1015", "AC1014"), "ascii")), (error) => errorCode(error) === "S7_DXF_HEADER_INVALID");
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("\n0\nEOF\n", "\n0\nEOF\n\n"), "ascii")), /S7_/u);
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii").replace("\n10\n0\n", "\n10\n1e2\n"), "ascii")), /S7_/u);
  assert.throws(() => parseS7Dxf(Buffer.from(generated.bytes.toString("ascii") + "x", "ascii")), /S7_/u);
  assert.throws(() => writeS7Dxf(handoff("bad\\injection"), { artifactId: ARTIFACT_ID, manifestId: MANIFEST_ID, source }), (error) => errorCode(error) === "S7_DXF_TEXT_INVALID");
});

test("golden and independent hand-authored AC1015 fixtures are accepted", () => {
  const golden = parseS7Dxf(readFileSync("tests/fixtures/s7/golden-plan-minimal.dxf"));
  assert.equal(golden.readbackVersion, "s7-cad-readback-v1");
  assert.equal(golden.entityCount, 1);
  assert.equal(golden.entities[0]?.entityType, "LWPOLYLINE");

  const handAuthored = parseS7Dxf(readFileSync("tests/fixtures/s7/hand-authored-valid-ac1015.dxf"));
  assert.equal(handAuthored.readbackVersion, "s7-cad-readback-v1");
  assert.equal(handAuthored.entityCount, 1);
  assert.equal(handAuthored.entities[0]?.entityType, "LINE");
});
