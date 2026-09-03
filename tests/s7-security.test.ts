import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AppError, type S6ToS7Handoff, type S7SourceStamp } from "../src/lib/types";
import { emptyStoreState } from "../src/lib/store";
import { parseS7Dxf } from "../src/lib/s7-dxf-readback";
import { writeS7Dxf } from "../src/lib/s7-dxf-writer";
import { buildS7Telemetry } from "../src/lib/s7-telemetry";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as const;
const HASH = "a".repeat(64);
const source: S7SourceStamp = { sourceRevisionId: "30000000-0000-4000-8000-000000000001", sourceRevisionHash: HASH, sourceS5Fingerprint: HASH, validationReceiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, s6HandoffSchemaVersion: "s6-to-s7-handoff-v1", handoffDigest: HASH };

function handoff(identityKey: string): S6ToS7Handoff {
  return { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID, acceptedRevisionId: source.sourceRevisionId, acceptedRevisionHash: HASH, sourceS5Fingerprint: HASH, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" }, booth: { widthMm: 6000, depthMm: 3000, openSides: [], maxHeightMm: null, heightState: "unknown" }, objects: [{ objectId: "source-object", identityKey, parentObjectId: null, objectType: "box", role: "furniture", geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" }, footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 }, transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } }, boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [], provenance: { kind: "confirmed_project_input", sourceRef: "customer", sourceFingerprint: HASH, acceptedByUser: true, note: "private" }, unknownIds: [] }], hierarchy: [{ objectId: "source-object", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [], validationReceipt: { receiptId: source.validationReceiptId, validationHash: HASH, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false } } as unknown as S6ToS7Handoff;
}

function code(error: unknown): string { return error instanceof AppError ? error.code : String(error); }

test("derived labels and tokens are printable ASCII and resist control/backslash injection", () => {
  const generated = writeS7Dxf(handoff("展示-α"), { artifactId: "40000000-0000-4000-8000-000000000001", manifestId: "40000000-0000-4000-8000-000000000002", source });
  assert.equal(generated.bytes.toString("ascii").split("\n").every((line) => /^[\x20-\x7e]*$/u.test(line)), true);
  assert.match(generated.bytes.toString("ascii"), /_u[0-9A-F]{4}_/u);
  assert.equal(generated.manifest.entities.find((entry) => entry.sourceObjectId === "source-object")?.identityKey, "展示-α");
  assert.throws(() => writeS7Dxf(handoff("bad\\field"), { artifactId: "40000000-0000-4000-8000-000000000001", manifestId: "40000000-0000-4000-8000-000000000002", source }), (error) => code(error) === "S7_DXF_TEXT_INVALID");
  assert.throws(() => writeS7Dxf(handoff("bad\nfield"), { artifactId: "40000000-0000-4000-8000-000000000001", manifestId: "40000000-0000-4000-8000-000000000002", source }), (error) => code(error) === "S7_DXF_TEXT_INVALID");
});

test("reader rejects XDATA injection and malformed grammar instead of normalizing it", () => {
  const generated = writeS7Dxf(handoff("safe"), { artifactId: "40000000-0000-4000-8000-000000000001", manifestId: "40000000-0000-4000-8000-000000000002", source });
  const injected = generated.bytes.toString("ascii").replace("O=source-object", "O=source-object\\n1000\\nO=attacker");
  assert.throws(() => parseS7Dxf(Buffer.from(injected, "ascii")), /S7_/u);
  const wrongOrder = generated.bytes.toString("ascii").replace("1000\nS7V1\n1000\nO=", "1000\nO=\n1000\nS7V1\n1000\nO=");
  assert.throws(() => parseS7Dxf(Buffer.from(wrongOrder, "ascii")), /S7_/u);
});

test("public/telemetry shapes contain no private storage, ownership, claim, customer provenance, or evidence collection", () => {
  const state = emptyStoreState();
  assert.equal("s7CadEvidence" in state, false);
  const telemetry = buildS7Telemetry(state, PROJECT_ID, { readiness: "not_ready" });
  const serialized = JSON.stringify(telemetry);
  for (const forbidden of ["storageKey", "private", "claimToken", "ownerProcessId", "customer", "prompt", "sourceRef"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});
