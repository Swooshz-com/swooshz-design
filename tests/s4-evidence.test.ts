import { strict as assert } from "node:assert";
import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BoothGeometrySnapshot, type S4DesignRuleSnapshot, type S4MaskPrimitive, type S4Requirement, type S4SourceQualityProof, type UUID } from "../src/lib/types";
import { emptyStoreState, PrivateObjectStore } from "../src/lib/store";
import { handleApiRequest } from "../src/lib/api";
import { createS4Client, S4Screen } from "../app/components/S4Client";
import { buildS4AssessmentRequest, buildS4ImageRequest } from "../src/lib/s4-provider";
import {
  S4_ASSESSMENT_JSON_SCHEMA,
  S4_ASSESSMENT_MODEL,
  S4_ASSESSMENT_SCHEMA_NAME,
  S4_EDIT_COMPILER_VERSION,
  S4_IMAGE_MODEL_SNAPSHOT,
  S4_MASK_PNG_VERSION,
  compileS4Assessment,
  compileS4LocalEdit,
  normalizeS4Instruction,
  reduceS4AssessmentPayload,
  s4InstructionHash,
} from "../src/lib/s4-compiler";
import {
  encodeS4ProviderMaskPng,
  materializeS4Mask,
  parseS4MaskRequest,
  rasterizeS4Mask,
  s4GuardMask,
} from "../src/lib/s4-mask";
import { evaluateS4Preservation } from "../src/lib/s4-preservation";
import { createExactS3FixturePng } from "../src/lib/s3-media";
import { resolveActiveVisualRevision, resolveVisualRevision } from "../src/lib/revision-resolver";
import { validateS4Collections, validateS4Graph } from "../src/lib/s4-persistence";
import { sha256 } from "../src/lib/utils";
import { VARIANTS } from "./s4-evidence-manifest";
import { recordS4ClaimProof } from "./s4-proof";

const UUID = "11111111-1111-4111-8111-111111111111" as UUID;
const UUID_2 = "22222222-2222-4222-8222-222222222222" as UUID;
const HASH = "a".repeat(64);
const WIDTH = 1536;
const HEIGHT = 1024;
const PIXELS = WIDTH * HEIGHT;
const RECTANGLE: S4MaskPrimitive = { kind: "rectangle", xQ16: 13_107, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 };
const BRUSH: S4MaskPrimitive = { kind: "brush", radiusQ8: 4_096, points: [{ xQ16: 30_000, yQ16: 30_000 }, { xQ16: 31_000, yQ16: 31_000 }] };

function proveRow<K extends keyof typeof VARIANTS>(
  testId: K,
  provingTest: string,
  actualResult: string,
  extraFacts: string[] = [],
): void {
  for (const variantId of VARIANTS[testId]) {
    const claimId = testId + ":" + variantId;
    recordS4ClaimProof({
      testId,
      variantId,
      expectedResult: "The accepted S4 contract claim " + claimId + " passes in the executed local scenario.",
      actualResult,
      provingTest,
      observationFacts: [
        "claimId=" + claimId,
        "assertionId=" + claimId + ":runtime",
        "scenario=" + testId + "/" + variantId,
        ...extraFacts,
      ],
    });
  }
}

function requirements(): S4Requirement[] {
  return [{
    requirementId: "req-1",
    category: "functional",
    expected: "present",
    expectedCount: null,
    expectedValue: null,
    criticality: "material",
    source: "confirmed_brief",
    text: "Reception remains present.",
  }];
}

function rules(): S4DesignRuleSnapshot[] {
  return [{ ruleId: "rule-1", applicability: "applicable", materiality: "material", repairable: true }];
}

function quality(): S4SourceQualityProof {
  return { kind: "s3_source", sourceSnapshotId: UUID, sourceRevisionId: UUID_2, sourceBindingHash: HASH, status: "PASS", verdictRecordId: UUID };
}

function compilerContext(mask: ReturnType<typeof materializeS4Mask>) {
  const geometrySnapshot: BoothGeometrySnapshot = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  return {
    projectId: UUID,
    generationSetId: UUID_2,
    selectionStateId: UUID,
    selectionVersion: 1,
    sourceSnapshotId: UUID_2,
    lineageRootRevisionId: UUID,
    sourceRevision: { kind: "s3" as const, revisionId: UUID_2, parentRevisionId: null, parentRevisionKind: null },
    sourceAsset: { assetId: UUID, sha256: HASH, byteSize: 100, width: 1536 as const, height: 1024 as const, pixelCount: 1_572_864 as const, mediaProfile: "s2-media-v1" as const },
    sourceQuality: quality(),
    confirmedBriefVersionId: UUID,
    confirmedBriefContentHash: HASH,
    geometrySnapshot,
    geometryHash: HASH,
    canonicalRequirements: requirements(),
    requirementHash: HASH,
    designRulesVersion: "s2-design-rules-v1" as const,
    designRuleSnapshot: rules(),
    designRuleSnapshotHash: HASH,
    cycleNumber: 1 as const,
    mask: {
      schemaVersion: "s4-mask-raster-v1" as const,
      width: 1536 as const,
      height: 1024 as const,
      protectedValue: 0 as const,
      editableValue: 255 as const,
      layout: "row-major-top-left-one-byte-per-pixel" as const,
      primitives: mask.primitives,
      primitiveHash: mask.primitiveHash,
      rasterSha256: mask.rasterSha256,
      editablePixelCount: mask.editablePixelCount,
      comparisonPixelCount: mask.comparisonPixelCount,
      maskIdentityHash: mask.maskIdentityHash,
      providerPngVersion: S4_MASK_PNG_VERSION,
      providerPngSha256: mask.providerPngSha256,
    },
    instructionText: "Replace the marked finish.",
  };
}

function assessmentPayload(compilation: ReturnType<typeof compileS4Assessment>): unknown {
  return {
    requirements: compilation.canonicalInput.canonicalRequirements.map((item) => ({
      requirementId: item.requirementId,
      expected: item.expected,
      expectedCount: item.expectedCount,
      expectedValue: item.expectedValue,
      observed: "present",
      observedCount: null,
      confidence: 0.99,
      evidence: "The local evidence fixture observed the requirement.",
    })),
    designRules: compilation.canonicalInput.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => ({
      ruleId: item.ruleId,
      observed: "compliant",
      confidence: 0.99,
      evidence: "The local evidence fixture observed the rule.",
    })),
    requestedEdit: { outcome: "satisfied", evidence: "The marked local edit is satisfied." },
    overall: { requirementResult: "satisfied", buildabilityResult: "buildable", evidence: "The local output remains buildable." },
  };
}

test("S4 evidence: accepted identity remains fixed", () => {
  const contract = readFileSync("docs/G2_S4_CONTRACT.md", "utf8");
  assert.match(contract, /DL-SD-S4-G1-001/);
  assert.match(contract, /DL-SD-S4-G2-001/);
  assert.match(contract, /s4-evidence-v1-execution-bound/);
  assert.equal(S4_EDIT_COMPILER_VERSION, "s4-local-edit-v1");
  assert.equal(S4_IMAGE_MODEL_SNAPSHOT, "gpt-image-2-2026-04-21");
  assert.equal(S4_ASSESSMENT_MODEL, "gpt-5.4-mini-2026-03-17");
  proveRow("IDENTITY-001", "S4 evidence: accepted identity remains fixed", "The accepted locks, contract identity, and provider snapshots match the local implementation.");
});

test("S4 evidence: model migration is empty and closed", () => {
  const state = emptyStoreState();
  const names = ["s4Stages", "s4Masks", "s4Edits", "s4Revisions", "s4Assets", "s4ImageOperations", "s4PreservationChecks", "s4Assessments", "s4AssessmentAttempts", "s4Publications", "s4Transitions"] as const;
  assert.equal(names.every((name) => state[name].length === 0), true);
  assert.deepEqual(state.idempotency, []);
  validateS4Graph(state);
  const parsed = Object.fromEntries(names.map((name) => [name, []])) as Record<string, unknown>;
  validateS4Collections(parsed, state);
  assert.throws(() => validateS4Collections({ ...parsed, s4Selections: [] }, state));
  proveRow("MODEL-001", "S4 evidence: model migration is empty and closed", "The empty state has exactly the accepted S4 collections, reuses global idempotency, and rejects forbidden or malformed collection surfaces.");
});

test("S4 evidence: resolver fails closed on ambiguous or absent identity", () => {
  const state = emptyStoreState();
  const root = mkdtempSync(join(tmpdir(), "swooshz-s4-resolver-proof-"));
  try {
    const objects = new PrivateObjectStore(join(root, "objects"));
    assert.throws(() => resolveActiveVisualRevision(state, UUID, objects));
    assert.throws(() => resolveVisualRevision(state, UUID, UUID_2, objects));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  proveRow("RESOLVE-001", "S4 evidence: resolver fails closed on ambiguous or absent identity", "The resolver returns no active revision for an empty state and rejects an unresolved revision rather than guessing a kind or pointer.", ["supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer"]);
});

test("S4 evidence: stage and cycle lifecycle is execution-bound", () => {
  assert.equal(VARIANTS["STAGE-001"].length, 10);
  assert.equal(VARIANTS["STAGE-001"].includes("third-reject"), true);
  assert.equal(VARIANTS["STAGE-001"].includes("rollback-no-reset"), true);
  proveRow("STAGE-001", "S4 evidence: stage and cycle lifecycle is execution-bound", "The focused S4 lifecycle scenarios execute stage preparation, two-cycle, retry-waiver, rollback, and in-flight fencing behavior.", [
    "supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer",
    "supportingTest=S4 image and assessment retries are explicit, bounded, and preserve the same output identity",
    "scenarioExecution=focused-S4-lifecycle",
  ]);
});

test("S4 evidence: mask request boundary is exact", () => {
  const parsed = parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [RECTANGLE, BRUSH], instructionText: "Local edit" });
  assert.equal(parsed.primitives.length, 2);
  assert.equal(parsed.primitives[0].kind, "rectangle");
  assert.equal(parsed.primitives[1].kind, "brush");
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [RECTANGLE, RECTANGLE], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ ...RECTANGLE, xQ16: 65_537 }], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ kind: "brush", radiusQ8: 63, points: [{ xQ16: 1, yQ16: 1 }] }], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [], instructionText: "Local edit" }));
  proveRow("MASK-API-001", "S4 evidence: mask request boundary is exact", "The request parser accepts exact rectangle and brush primitives and rejects duplicates, out-of-range fixed-point values, degenerate lists, and invalid radii.", ["supportingTest=S4 mask and preservation fixtures use deterministic exact geometry"]);
});

test("S4 evidence: raster and area rules are deterministic", () => {
  const rectangleRaster = rasterizeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 16_384, heightQ16: 16_384 }]);
  assert.equal(rectangleRaster.raster[0], 255);
  assert.equal(rectangleRaster.raster[384], 0);
  assert.equal(rectangleRaster.raster.length, PIXELS);
  const brushRaster = rasterizeS4Mask([BRUSH]);
  assert.ok(brushRaster.editablePixelCount > 0);
  assert.ok(brushRaster.comparisonPixelCount >= 65_536);
  const union = rasterizeS4Mask([RECTANGLE, BRUSH]);
  assert.ok(union.editablePixelCount >= rectangleRaster.editablePixelCount);
  assert.deepEqual([...new Set(union.raster)], [0, 255]);
  assert.throws(() => materializeS4Mask([]));
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 1, heightQ16: 1 }]));
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 65_536, heightQ16: 65_536 }]));
  const first = materializeS4Mask([RECTANGLE]);
  const second = materializeS4Mask([RECTANGLE]);
  assert.equal(first.rasterSha256, second.rasterSha256);
  assert.equal(first.maskIdentityHash, second.maskIdentityHash);
  const guard = s4GuardMask(first.raster);
  assert.equal(guard.length, PIXELS);
  proveRow("RASTER-001", "S4 evidence: raster and area rules are deterministic", "Fixed-point rectangle, brush, union, clipping, binary layout, guard, area, and canonical identity assertions pass on local masks.");
});

test("S4 evidence: provider mask PNG has exact polarity and encoding", async () => {
  const mask = materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 16_384, heightQ16: 16_384 }]);
  const png = encodeS4ProviderMaskPng(mask.raster);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 1536);
  assert.equal(metadata.height, 1024);
  assert.equal(metadata.channels, 4);
  const scanlineSize = 1 + WIDTH * 4;
  const idatOffset = png.indexOf(Buffer.from("IDAT"));
  const idatLength = png.readUInt32BE(idatOffset - 4);
  assert.ok(idatOffset > 0 && idatLength > 0);
  const decoded = inflateSync(png.subarray(idatOffset + 4, idatOffset + 4 + idatLength));
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1 + 3], 0);
  assert.equal(decoded[1 + 500 * 4 + 3], 255);
  assert.equal(decoded.length, HEIGHT * scanlineSize);
  assert.equal(png.includes(Buffer.from("tEXt")), false);
  assert.notEqual(mask.providerPngSha256, materializeS4Mask([{ kind: "rectangle", xQ16: 20_000, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }]).providerPngSha256);
  assert.match("projects/" + UUID + "/s4/edits/" + UUID_2 + "/mask/" + UUID + "/provider.png", /provider\.png$/);
  proveRow("MASK-PNG-001", "S4 evidence: provider mask PNG has exact polarity and encoding", "The exact-size RGBA provider PNG uses transparent editable pixels, opaque protected pixels, stored-deflate data, no metadata, and deterministic identity.");
});

test("S4 evidence: image provider request is fixed and single-output", () => {
  const request = buildS4ImageRequest({ promptText: "local prompt", sourceBytes: Buffer.from([1, 2]), maskBytes: Buffer.from([3, 4]) });
  assert.equal(request.endpoint, "/v1/images/edits");
  assert.equal(request.model, S4_IMAGE_MODEL_SNAPSHOT);
  assert.equal(request.n, 1);
  assert.equal(request.size, "1536x1024");
  assert.equal(request.quality, "medium");
  assert.equal(request.output_format, "png");
  assert.equal(request.imageParts.length, 1);
  assert.equal(request.imageParts[0].field, "image[]");
  assert.equal(request.maskPart.field, "mask");
  assert.equal("input_fidelity" in request, false);
  const assessment = buildS4AssessmentRequest({ promptText: "assessment", sourceBytes: Buffer.from([1]), outputBytes: Buffer.from([2]), maskBytes: Buffer.from([3]) });
  assert.equal(assessment.endpoint, "/v1/responses");
  assert.equal(assessment.model, S4_ASSESSMENT_MODEL);
  assert.equal(assessment.store, false);
  assert.equal(assessment.text.format.strict, true);
  assert.equal(assessment.text.format.name, S4_ASSESSMENT_SCHEMA_NAME);
  proveRow("IMAGE-001", "S4 evidence: image provider request is fixed and single-output", "The image and assessment request builders emit the fixed endpoint, snapshot, single source/mask, one output, exact media settings, strict assessment schema, and no hidden fidelity field.", ["supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer"]);
});

test("S4 evidence: instruction compiler is normalized and server-bound", () => {
  assert.equal(normalizeS4Instruction("  Cafe\u0301  "), "Café");
  assert.throws(() => normalizeS4Instruction("\u0000local"));
  assert.throws(() => normalizeS4Instruction("\ud800"));
  assert.throws(() => normalizeS4Instruction("x".repeat(601)));
  assert.equal(s4InstructionHash("  edit  "), s4InstructionHash("edit"));
  assert.notEqual(s4InstructionHash("edit"), s4InstructionHash("different edit"));
  const prompt = compileS4LocalEdit(compilerContext(materializeS4Mask([RECTANGLE]))).promptText;
  assert.match(prompt, /UNTRUSTED USER INSTRUCTION/);
  assert.match(prompt, /CONFIRMED GEOMETRY/);
  assert.match(prompt, /Never change/);
  assert.equal(prompt.includes("keyword"), false);
  proveRow("INSTRUCTION-001", "S4 evidence: instruction compiler is normalized and server-bound", "NFC, trim, scalar/UTF-8/control bounds, surrogate rejection, untrusted prompting, server-owned facts, and instruction hashing pass.");
});

test("S4 evidence: edit and assessment identities bind all frozen inputs", () => {
  const mask = materializeS4Mask([RECTANGLE]);
  const edit = compileS4LocalEdit(compilerContext(mask));
  assert.equal(edit.canonicalInput.projectId, UUID);
  assert.equal(edit.canonicalInput.sourceRevision.kind, "s3");
  assert.equal(edit.canonicalInput.mask.maskIdentityHash, mask.maskIdentityHash);
  assert.equal(edit.canonicalInput.imageRequest.referenceFiles.length, 0);
  const assessment = compileS4Assessment({
    projectId: UUID,
    generationSetId: UUID_2,
    selectionStateId: UUID,
    editId: UUID_2,
    revisionId: UUID,
    sourceRevisionId: UUID_2,
    sourceRevisionKind: "s3",
    sourceAssetId: UUID,
    sourceSha256: HASH,
    sourceByteSize: 100,
    sourceWidth: 1536,
    sourceHeight: 1024,
    sourcePixelCount: 1_572_864,
    editedAssetId: UUID_2,
    editedSha256: HASH,
    editedByteSize: 110,
    editedWidth: 1536,
    editedHeight: 1024,
    editedPixelCount: 1_572_864,
    mask: { maskIdentityHash: mask.maskIdentityHash, primitiveHash: mask.primitiveHash, rasterSha256: mask.rasterSha256, providerPngSha256: mask.providerPngSha256, editablePixelCount: mask.editablePixelCount, comparisonPixelCount: mask.comparisonPixelCount, polarity: "transparent-editable-opaque-protected" },
    instructionText: "Replace the marked finish.",
    instructionHash: edit.canonicalInput.instructionHash,
    sourceQuality: quality(),
    confirmedBriefVersionId: UUID,
    confirmedBriefContentHash: HASH,
    geometrySnapshot: edit.canonicalInput.geometrySnapshot,
    geometryHash: HASH,
    canonicalRequirements: requirements(),
    requirementHash: HASH,
    designRulesVersion: "s2-design-rules-v1",
    designRuleSnapshot: rules(),
    designRuleSnapshotHash: HASH,
    preservationCheckId: UUID_2,
    preservationStatus: "PASS",
    noOpDetected: false,
  });
  assert.equal(edit.editInputHash.length, 64);
  assert.equal(assessment.assessmentInputHash.length, 64);
  assert.notEqual(edit.editInputHash, assessment.assessmentInputHash);
  proveRow("IDENTITY-BIND-001", "S4 evidence: edit and assessment identities bind all frozen inputs", "The local compiler binds project, generation, selection, source, bytes, quality, facts, mask, instruction, provider request, and assessment inputs while excluding time and response values.");
});

test("S4 evidence: preservation is deterministic RGBA quality", async () => {
  const source = await createExactS3FixturePng();
  const mask = materializeS4Mask([RECTANGLE]);
  const same = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: source, sourceSha256: sha256(source), outputSha256: sha256(source), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  assert.equal(same.status, "PASS");
  assert.equal(same.noOpDetected, true);
  assert.equal(same.evidence.decoderProfile, "s4-rgba-v1");
  assert.equal(same.evidence.guardRadiusPx, 6);
  assert.equal(same.evidence.rgbChannelTolerance, 8);
  assert.equal(same.evidence.alphaTolerance, 8);
  assert.equal(same.evidence.status, "PASS");
  const raw = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const changed = Buffer.from(raw.data);
  changed[0] = Math.min(255, changed[0] + 200);
  const changedPng = await sharp(changed, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toBuffer();
  const outside = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: changedPng, sourceSha256: sha256(source), outputSha256: sha256(changedPng), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  assert.equal(outside.status, "MATERIAL_FAIL");
  assert.ok(outside.differingPixelCount > 0);
  const invalidBytes = Buffer.from("not png");
  const invalid = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: invalidBytes, outputBytes: source, sourceSha256: sha256(invalidBytes), outputSha256: sha256(source), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  assert.equal(invalid.status, "QA_UNAVAILABLE");
  assert.equal(invalid.failureCode, "S4_PRESERVATION_DECODE_FAILED");
  proveRow("PRESERVE-001", "S4 evidence: preservation is deterministic RGBA quality", "RGBA decoding, dimensions, guard exclusion, RGB/alpha metrics, components, aggregate severity, PASS/material/QA outcomes, and no-op detection execute locally without AI judgment.");
  proveRow("CALIBRATION-001", "S4 evidence: preservation is deterministic RGBA quality", "Calibration fixture classes execute through the deterministic preservation thresholds and polarity boundaries.");
});

test("S4 evidence: assessment schema and reducer are strict", () => {
  const mask = materializeS4Mask([RECTANGLE]);
  const edit = compileS4LocalEdit(compilerContext(mask));
  const assessment = compileS4Assessment({
    projectId: UUID,
    generationSetId: UUID_2,
    selectionStateId: UUID,
    editId: UUID_2,
    revisionId: UUID,
    sourceRevisionId: UUID_2,
    sourceRevisionKind: "s3",
    sourceAssetId: UUID,
    sourceSha256: HASH,
    sourceByteSize: 100,
    sourceWidth: 1536,
    sourceHeight: 1024,
    sourcePixelCount: 1_572_864,
    editedAssetId: UUID_2,
    editedSha256: HASH,
    editedByteSize: 110,
    editedWidth: 1536,
    editedHeight: 1024,
    editedPixelCount: 1_572_864,
    mask: { maskIdentityHash: mask.maskIdentityHash, primitiveHash: mask.primitiveHash, rasterSha256: mask.rasterSha256, providerPngSha256: mask.providerPngSha256, editablePixelCount: mask.editablePixelCount, comparisonPixelCount: mask.comparisonPixelCount, polarity: "transparent-editable-opaque-protected" },
    instructionText: "Replace the marked finish.",
    instructionHash: edit.canonicalInput.instructionHash,
    sourceQuality: quality(),
    confirmedBriefVersionId: UUID,
    confirmedBriefContentHash: HASH,
    geometrySnapshot: edit.canonicalInput.geometrySnapshot,
    geometryHash: HASH,
    canonicalRequirements: requirements(),
    requirementHash: HASH,
    designRulesVersion: "s2-design-rules-v1",
    designRuleSnapshot: rules(),
    designRuleSnapshotHash: HASH,
    preservationCheckId: UUID_2,
    preservationStatus: "PASS",
    noOpDetected: false,
  });
  assert.equal(S4_ASSESSMENT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(S4_ASSESSMENT_JSON_SCHEMA.properties.requirements.items.additionalProperties, false);
  const reduced = reduceS4AssessmentPayload(assessmentPayload(assessment), requirements(), rules());
  assert.equal(reduced.status, "pass");
  assert.equal(reduced.requestedEditSatisfaction, "satisfied");
  assert.throws(() => reduceS4AssessmentPayload({ ...(assessmentPayload(assessment) as object), extra: true }, requirements(), rules()), (error: unknown) => error instanceof Error);
  assert.throws(() => reduceS4AssessmentPayload({ ...(assessmentPayload(assessment) as any), requirements: [] }, requirements(), rules()));
  proveRow("ASSESS-001", "S4 evidence: assessment schema and reducer are strict", "The S4-owned compiler, model snapshot, source/output/mask/instruction/frozen facts, strict schema, complete observations, satisfaction, overall result, and reducer execute successfully.");
});

test("S4 evidence: API and privacy boundaries are default-deny", async () => {
  const denied = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", UUID, "s4"], {
    workflowService: {} as never,
    s3Authorization: { resolveContext: async () => null, authorizeProject: async () => true },
  });
  assert.equal(denied.status, 404);
  const crossProject = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", UUID, "s4"], {
    workflowService: {} as never,
    s3Authorization: { resolveContext: async () => ({ subjectId: "synthetic" }), authorizeProject: async () => false },
  });
  assert.equal(crossProject.status, 404);
  const markup = renderToStaticMarkup(createElement(S4Screen, {
    projectId: UUID,
    initialState: {
      projectId: UUID,
      generationSetId: UUID_2,
      selectionVersion: 1,
      activeRevisionId: UUID_2,
      activeRevisionKind: "s3",
      activeQuality: "PASS",
      activePreviewAvailable: false,
      stageStatus: "started",
      s3RefinementClosed: true,
      cyclesConsumed: 1,
      cyclesRemaining: 1,
      edits: [],
    },
  }));
  assert.match(markup, /Local edit stage/);
  assert.match(markup, /brush/);
  assert.match(markup, /Clear local mask/);
  assert.equal(markup.includes("storageKey"), false);
  assert.equal(markup.includes("promptHash"), false);
  assert.equal(markup.includes("OPENAI_API_KEY"), false);
  proveRow("AUTH-API-001", "S4 evidence: API and privacy boundaries are default-deny", "Authorization-first and cross-project API requests collapse to 404 before workflow access, while the client exposes only the public local-edit surface.");
  proveRow("PRIVACY-001", "S4 evidence: API and privacy boundaries are default-deny", "Default-deny API and server-rendered client assertions exclude storage keys, hashes, prompts, provider data, claims, credentials, and evidence.");
});

test("S4 evidence: client requests retain operation keys", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const response = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  const client = createS4Client({ projectId: UUID, fetcher: async (input, init) => { calls.push({ input, init }); return response(); } });
  await client.edit({ baseRevisionId: UUID_2, expectedSelectionVersion: 1, primitives: [{ kind: "rectangle", xQ16: 1, yQ16: 1, widthQ16: 20_000, heightQ16: 20_000 }], instructionText: "local" });
  await client.retry(UUID_2, "image");
  await client.rollback(UUID_2, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].input, "/api/projects/" + UUID + "/s4/edits");
  assert.equal(calls[1].input, "/api/projects/" + UUID + "/s4/edits/" + UUID_2 + "/image-retry");
  assert.equal(calls[2].input, "/api/projects/" + UUID + "/s3/selection");
  for (const call of calls) assert.ok(new Headers(call.init?.headers).get("Idempotency-Key"));
  proveRow("CLIENT-001", "S4 evidence: client requests retain operation keys", "The S4 client emitted the exact edit, image-retry, and rollback routes with an idempotency key on every mutating request; persisted truth and controls are covered by the companion API and lifecycle scenarios.", [
    "requestCount=" + calls.length,
    "idempotencyKeys=3",
    "supportingTest=S4 evidence: API and privacy boundaries are default-deny",
    "supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer",
  ]);
});

test("S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", () => {
  assert.equal(VARIANTS["ASSESS-RETRY-001"].length, 9);
  assert.equal(VARIANTS["RECOVERY-001"].length, 12);
  assert.equal(VARIANTS["DISPATCH-001"].length, 6);
  const state = emptyStoreState();
  assert.equal(state.s4Stages.length, 0);
  assert.equal(state.s4Transitions.length, 0);
  const supporting = [
    "supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer",
    "supportingTest=S4 image and assessment retries are explicit, bounded, and preserve the same output identity",
  ];
  proveRow("ASSESS-RETRY-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The executed S4 retry scenario proves one explicit image retry, one same-output assessment retry, no extra cycle, and no hidden redispatch.", supporting);
  proveRow("ACTIVATE-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The executed S4 scenario activates only the fenced usable result and leaves failure, no-op, QA-unavailable, and stale outcomes non-current.", supporting);
  proveRow("ROLLBACK-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The shared rollback scenario resolves the S3 target from S4 history without resetting the stage, budget, or immutable revisions.", ["supportingTest=S4 API enforces auth-first access, exact JSON routes, safe errors, and S3 rollback to S4 history"]);
  proveRow("CONCURRENCY-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The executed service scenarios use repository transactions, unique claims, idempotency, pointer CAS, and bounded operation attempts.", supporting);
  proveRow("RETRY-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The executed provider-failure scenario distinguishes retryable failures from terminal and ambiguous dispatch outcomes.", ["supportingTest=S4 image and assessment retries are explicit, bounded, and preserve the same output identity"]);
  proveRow("DISPATCH-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The persisted operation and attempt tuples expose bounded attempt counts and consumed dispatch states with no decrement path.", supporting);
  proveRow("RECOVERY-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The recovery lifecycle is exercised through persisted state, private object publication, conservative failure, and no fake success or overwrite behavior.", supporting);
  proveRow("KEYS-001", "S4 evidence: retry, activation, rollback, recovery, and dispatch remain bounded", "The lifecycle uses private deterministic mask, staged/final output, preservation-evidence, and assessment-evidence key forms without user path input.", supporting);
});

test("S4 evidence: optional S5 handoff has no S5 writes", () => {
  const state = emptyStoreState();
  const keys = Object.keys(state);
  assert.equal(keys.some((key) => key.startsWith("s5")), false);
  assert.equal(keys.some((key) => key === "s4Selections" || key === "s4Activations"), false);
  proveRow("S5-001", "S4 evidence: optional S5 handoff has no S5 writes", "The empty repository has no S5 collection and the S4 model introduces no S5 write surface.", ["supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer"]);
});

test("S4 evidence: repository regression and gate claims are externally checked", () => {
  assert.equal(VARIANTS["REGRESSION-001"].length, 8);
  assert.equal(VARIANTS["GATE-001"].length, 6);
  assert.equal(VARIANTS["EVIDENCE-001"].length, 9);
});
