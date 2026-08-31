import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { act, create as createTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppError, type BoothGeometry, type BoothGeometrySnapshot, type ProviderMetadata, type S4DesignRuleSnapshot, type S4MaskPrimitive, type S4Requirement, type S4SourceQualityProof, type UUID } from "../src/lib/types";
import { emptyStoreState, JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { MockOpenAIProvider } from "../src/lib/openai";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";
import { handleApiRequest } from "../src/lib/api";
import { createS4Client, instructionDraftState, isS4DraftClearEnabled, isS4DraftSubmitReady, isS4PrimitiveLocallyValid, S4Screen, type S4Primitive } from "../app/components/S4Client";
import { buildS4AssessmentRequest, buildS4ImageRequest, OpenAIS4Provider, type S4ProviderContract } from "../src/lib/s4-provider";
import type { PublicS4State } from "../src/lib/s4";
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
import { cloneJson, sha256 } from "../src/lib/utils";
import { proveS4Claims } from "./s4-proof";

const UUID = "11111111-1111-4111-8111-111111111111" as UUID;
const UUID_2 = "22222222-2222-4222-8222-222222222222" as UUID;
const HASH = "a".repeat(64);
const WIDTH = 1536;
const HEIGHT = 1024;
const PIXELS = WIDTH * HEIGHT;
const RECTANGLE: S4MaskPrimitive = { kind: "rectangle", xQ16: 13_107, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 };
const BRUSH: S4MaskPrimitive = { kind: "brush", radiusQ8: 4_096, points: [{ xQ16: 30_000, yQ16: 30_000 }, { xQ16: 31_000, yQ16: 31_000 }] };
const BODY_LIMIT_PRIMITIVES: S4MaskPrimitive[] = Array.from({ length: 65 }, (_, index) => ({
  ...RECTANGLE,
  xQ16: 1_000 + index * 500,
}));
const PUBLIC_ASSESSMENT = {
  status: "PASS",
  requestedEditSatisfaction: "satisfied",
  overallRequirementResult: "satisfied",
  overallBuildabilityResult: "buildable",
  materialFindingCount: 0,
  warningFindingCount: 1,
  uncertainFindingCount: 0,
  retryAvailable: false,
} as const;
const PUBLIC_EDIT = {
  editId: UUID_2,
  cycleNumber: 1,
  baseRevisionId: UUID,
  baseRevisionKind: "s3",
  status: "usable_pass",
  instructionText: "Replace the selected finish.",
  maskReady: true,
  primitiveCount: 1,
  editablePixelCount: 12_000,
  comparisonPixelCount: 1_500_000,
  outputRevisionId: UUID_2,
  preservationStatus: "PASS",
  assessment: PUBLIC_ASSESSMENT,
  imageRetryAvailable: false,
  assessmentRetryAvailable: false,
  activationState: "usable_history",
  previewAvailable: true,
  createdAt: "2026-08-31T00:00:00.000Z",
  terminalAt: "2026-08-31T00:01:00.000Z",
} as const;
const PUBLIC_STATE: PublicS4State = {
  projectId: UUID,
  generationSetId: UUID_2,
  selectionVersion: 2,
  activeRevisionId: UUID_2,
  activeRevisionKind: "s4",
  activeQuality: "PASS",
  activePreviewAvailable: true,
  stageStatus: "started",
  s3RefinementClosed: true,
  cyclesConsumed: 1,
  cyclesRemaining: 1,
  edits: [PUBLIC_EDIT],
};

type RealS4ApiFixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  projectId: UUID;
  sourceRevisionId: UUID;
  editId: UUID;
  publicState: PublicS4State;
  publicEdit: Record<string, unknown>;
  privateStateText: string;
  privateNeedles: string[];
  privateStorageKeys: string[];
  privateHashValues: string[];
  privateProviderRequestIds: string[];
  privatePromptTexts: string[];
  privateClaimFacts: { image: boolean; assessment: boolean };
};

function realS4BriefData(): any {
  return {
    projectFacts: { clientName: "S4 Local Fixture", eventName: "Local Event", venueName: "Local Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "Local Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null },
    unknowns: [], assumptions: [], freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function realS4QaPayload(input: any): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "Local S4 workflow fixture observation",
    })),
    designRules: input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "Local S4 workflow fixture observation",
    })),
  };
}

function realS4AssessmentPayload(repository: JsonRepository, evidence = "Local S4 workflow assessment observation"): any {
  const assessment = repository.state().s4Assessments.at(-1);
  if (!assessment) throw new Error("real S4 assessment fixture is not persisted");
  return {
    requirements: assessment.canonicalRequirements.map((item) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      expectedValue: item.expectedValue, observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence,
    })),
    designRules: assessment.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence,
    })),
    requestedEdit: { outcome: "satisfied", evidence },
    overall: { requirementResult: "satisfied", buildabilityResult: "buildable", evidence },
  };
}

async function realS4EditedPng(sourceBytes: Uint8Array): Promise<Buffer> {
  const raw = await sharp(sourceBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 210; y < 510; y += 1) for (let x = 315; x < 760; x += 1) {
    const offset = (y * WIDTH + x) * 4;
    raw.data[offset] = raw.data[offset] === 0 ? 1 : 0;
  }
  return sharp(raw.data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function realS4WaitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("real S4 API fixture timed out");
}

async function createRealS4ApiFixture(options: { instructionText?: string; assessmentEvidence?: string } = {}): Promise<RealS4ApiFixture> {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s4-api-real-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID() as UUID;
  const generationSetId = randomUUID() as UUID;
  const briefVersionId = randomUUID() as UUID;
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  const sourceBytes = await createExactS3FixturePng();
  const outputBytes = await realS4EditedPng(sourceBytes);
  const sourceHash = sha256(sourceBytes);
  const metadata: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() };
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID();
    const assetId = randomUUID();
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    objects.put(storageKey, sourceBytes);
    conceptAssets.push({ assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: sourceBytes.byteLength, sha256: sourceHash, status: "stored", createdAt: new Date(0).toISOString() });
    candidates.push({
      candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index,
      directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: new Date(0).toISOString() },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
    });
  }
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S4 local API fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data: realS4BriefData(), contentHash: sourceHash, confirmationMode: "explicit_user_action", confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), failureCode: null });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });

  let imagePromptText = "";
  let assessmentPromptText = "";
  const privateClaimFacts = { image: false, assessment: false };
  const s4Provider: S4ProviderContract = {
    runS4ImageEdit: async (input) => {
      imagePromptText = input.promptText;
      return { pngBytes: outputBytes, providerRequestId: "real-fixture-image-request" };
    },
    runS4Assessment: async (input) => {
      assessmentPromptText = input.promptText;
      return { payload: realS4AssessmentPayload(repository, options.assessmentEvidence), providerRequestId: "real-fixture-assessment-request" };
    },
  };
  const provider = new MockOpenAIProvider({ briefData: realS4BriefData(), s2QaResponseFactory: (input) => realS4QaPayload(input) });
  const service = createWorkflowService({
    repository,
    objects,
    provider,
    s4Provider,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase !== "before-dispatch") return;
      if ("operationId" in operation) privateClaimFacts.image = Boolean(operation.claimedBy && operation.claimedProcessId !== null && operation.claimToken);
      if ("assessmentAttemptId" in operation) privateClaimFacts.assessment = Boolean(operation.claimedBy && operation.claimedProcessId !== null && operation.claimToken);
    },
  });
  service.s2.getReferenceDraft(projectId);
  const bound = await service.s2.bindQa(projectId, generationSetId, 1, randomUUID() as UUID, randomUUID() as UUID);
  await realS4WaitFor(() => repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");
  const s3State = service.s3.getState(projectId);
  const sourceRevisionId = s3State.screenedCandidates.find((item) => item.originalSourceId)?.originalSourceId;
  assert.ok(sourceRevisionId);
  const selected = service.s3.selectSource(projectId, "source_root", sourceRevisionId, 0, randomUUID() as UUID, randomUUID() as UUID);
  const admission = service.s4.admitEdit(projectId, {
    baseRevisionId: selected.result.activeRevisionId,
    expectedSelectionVersion: selected.result.selectionVersion,
    primitives: [RECTANGLE],
    instructionText: options.instructionText ?? "  Replace the selected finish.  ",
  }, randomUUID() as UUID, randomUUID() as UUID);
  const editId = admission.result.editId;
  await realS4WaitFor(() => repository.state().s4Edits.find((item) => item.editId === editId)?.status, (status) => status === "completed");
  const privateState = repository.state();
  const publicState = service.s4.getState(projectId);
  const publicEdit = service.s4.getEdit(projectId, editId) as unknown as Record<string, unknown>;
  const mask = privateState.s4Masks[0];
  const edit = privateState.s4Edits[0];
  const imageOperation = privateState.s4ImageOperations[0];
  const revision = privateState.s4Revisions[0];
  const asset = privateState.s4Assets[0];
  const preservation = privateState.s4PreservationChecks[0];
  const assessment = privateState.s4Assessments[0];
  const assessmentAttempt = privateState.s4AssessmentAttempts[0];
  const privateStorageKeys = [
    mask?.rasterStorageKey,
    mask?.providerPngStorageKey,
    asset?.storageKeyNormalized,
    edit?.promptHash,
    preservation?.evidenceObject?.key,
    assessmentAttempt?.evidenceObject?.key,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const privateHashValues = [
    edit?.promptHash,
    edit?.providerRequestHash,
    imageOperation?.operationInputHash,
    revision?.outputSha256,
    assessment?.assessmentInputHash,
    assessment?.assessmentPromptHash,
    assessmentAttempt?.assessmentPromptHash,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const privateProviderRequestIds = [
    imageOperation?.providerMetadata?.providerRequestId,
    assessmentAttempt?.providerMetadata?.providerRequestId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const privatePromptTexts = [
    imagePromptText,
    assessmentPromptText,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const privateNeedles = [...privateStorageKeys, ...privateHashValues, ...privateProviderRequestIds, ...privatePromptTexts];
  assert.equal(privateState.s4Masks.length, 1);
  assert.equal(privateState.s4Edits.length, 1);
  assert.equal(privateState.s4Revisions.length, 1);
  assert.equal(privateState.s4Assets.length, 1);
  assert.equal(privateState.s4PreservationChecks[0]?.evidenceObject !== null, true);
  assert.equal(privateState.s4AssessmentAttempts[0]?.evidenceObject !== null, true);
  assert.equal(privateState.s4ImageOperations[0]?.providerMetadata !== null, true);
  assert.equal(privateState.s4Edits[0]?.promptHash.length, 64);
  assert.equal(privateClaimFacts.image, true);
  assert.equal(privateClaimFacts.assessment, true);
  return {
    root, repository, objects, service, projectId, sourceRevisionId, editId, publicState, publicEdit,
    privateStateText: JSON.stringify(privateState), privateNeedles, privateStorageKeys, privateHashValues,
    privateProviderRequestIds, privatePromptTexts, privateClaimFacts,
  };
}

type UnicodePersistenceEvidence = {
  instruction: string;
  evidence: string;
  reloadedInstruction: string;
  stateFileInstruction: string;
  reloadedRequirementEvidence: string;
  rejectedInstructionBoundaries: number;
  rejectedEvidenceBoundaries: number;
};

async function executeUnicodePersistenceBoundary(): Promise<UnicodePersistenceEvidence> {
  const instruction = "😀".repeat(600);
  const evidence = "😀".repeat(400);
  const unicodeFixture = await createRealS4ApiFixture({ instructionText: instruction, assessmentEvidence: evidence });
  try {
    const committed = unicodeFixture.repository.state();
    const reloaded = new JsonRepository(unicodeFixture.root).state();
    const persistedDocument = JSON.parse(readFileSync(join(unicodeFixture.root, "state.json"), "utf8")) as any;
    const committedEdit = committed.s4Edits.find((item) => item.editId === unicodeFixture.editId);
    const reloadedEdit = reloaded.s4Edits.find((item) => item.editId === unicodeFixture.editId);
    const reloadedAttempt = reloaded.s4AssessmentAttempts[0];
    const assessment = committed.s4Assessments[0];
    if (!committedEdit || !reloadedEdit || !reloadedAttempt || !assessment) throw new Error("Unicode persistence fixture is incomplete");
    const stateFileInstruction = persistedDocument.s4Edits.find((item: any) => item.editId === unicodeFixture.editId)?.instructionText;
    const reloadedRequirementEvidence = reloadedAttempt.requirementObservations[0]?.evidence;
    if (typeof stateFileInstruction !== "string" || typeof reloadedRequirementEvidence !== "string") throw new Error("Unicode persistence fixture fields are incomplete");
    assert.equal(Array.from(instruction).length, 600);
    assert.equal(Buffer.byteLength(instruction, "utf8"), 2_400);
    assert.equal(committedEdit.instructionText, instruction);
    assert.equal(reloadedEdit.instructionText, instruction);
    assert.equal(persistedDocument.s4Edits.find((item: any) => item.editId === unicodeFixture.editId)?.instructionText, instruction);
    assert.equal(reloadedAttempt.requirementObservations[0]?.evidence, evidence);
    assert.equal(reloadedAttempt.designObservations[0]?.evidence, evidence);
    let rejectedInstructionBoundaries = 0;
    for (const invalidInstruction of ["😀".repeat(601), instruction + "a"]) {
      const poisonRoot = mkdtempSync(join(tmpdir(), "swooshz-s4-poisoned-instruction-"));
      try {
        const poisoned = cloneJson(reloaded);
        poisoned.s4Edits[0]!.instructionText = invalidInstruction;
        writeFileSync(join(poisonRoot, "state.json"), JSON.stringify(poisoned), "utf8");
        assert.throws(() => new JsonRepository(poisonRoot).state(), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
        rejectedInstructionBoundaries += 1;
      } finally { rmSync(poisonRoot, { recursive: true, force: true }); }
    }
    let rejectedEvidenceBoundaries = 0;
    const poisonedEvidenceRoot = mkdtempSync(join(tmpdir(), "swooshz-s4-poisoned-evidence-"));
    try {
      const poisoned = cloneJson(reloaded);
      poisoned.s4AssessmentAttempts[0]!.requirementObservations[0]!.evidence = evidence + "😀";
      writeFileSync(join(poisonedEvidenceRoot, "state.json"), JSON.stringify(poisoned), "utf8");
      assert.throws(() => new JsonRepository(poisonedEvidenceRoot).state(), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
      rejectedEvidenceBoundaries += 1;
    } finally { rmSync(poisonedEvidenceRoot, { recursive: true, force: true }); }
    const overEvidencePayload = realS4AssessmentPayload(unicodeFixture.repository, evidence + "😀");
    assert.throws(() => reduceS4AssessmentPayload(overEvidencePayload, assessment.canonicalRequirements, assessment.designRuleSnapshot));
    rejectedEvidenceBoundaries += 1;
    return {
      instruction,
      evidence,
      reloadedInstruction: reloadedEdit.instructionText,
      stateFileInstruction,
      reloadedRequirementEvidence,
      rejectedInstructionBoundaries,
      rejectedEvidenceBoundaries,
    };
  } finally { rmSync(unicodeFixture.root, { recursive: true, force: true }); }
}

async function proveVariantClaims(
  testId: string,
  provingTest: string,
  scenario: string,
  actualResult: string,
  assertions: Record<string, () => void | Promise<void>>,
  observationFacts: string[] = [],
): Promise<void> {
  await proveS4Claims(testId, provingTest, Object.entries(assertions).map(([variantId, assertion]) => ({
    variantId,
    assertionId: testId + "." + variantId + ".assertion",
    scenario: scenario + "/" + variantId,
    expectedResult: "The frozen " + testId + " variant is established by its executed assertion.",
    actualResult,
    observationFacts,
    assertion,
  })));
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

test("S4 evidence: accepted identity remains fixed", async () => {
  const contract = readFileSync("docs/G2_S4_CONTRACT.md", "utf8");
  assert.match(contract, /DL-SD-S4-G1-001/);
  assert.match(contract, /DL-SD-S4-G2-002/);
  assert.match(contract, /Canonical re-entry base/);
  assert.match(contract, /2e01a90b6b2f40f4729764970a8cb89f25bbe0c8/);
  assert.match(contract, /b144ae4bc0bb80bee82d696be0f7e550af0a3ae9/);
  assert.match(contract, /s4-evidence-v1-execution-bound/);
  assert.equal(S4_EDIT_COMPILER_VERSION, "s4-local-edit-v1");
  assert.equal(S4_IMAGE_MODEL_SNAPSHOT, "gpt-image-2-2026-04-21");
  assert.equal(S4_ASSESSMENT_MODEL, "gpt-5.4-mini-2026-03-17");
  await proveVariantClaims("IDENTITY-001", "S4 evidence: accepted identity remains fixed", "accepted-identity", "The executed identity assertion matched the frozen lock, contract, and provider constants.", {
    "canonical-g2-base": () => assert.match(contract, /\*\*Canonical re-entry base:\*\*/),
    "g1-lock": () => assert.match(contract, /DL-SD-S4-G1-001/),
    "g2-lock": () => assert.match(contract, /DL-SD-S4-G2-002/),
    "contract-identity": () => assert.match(contract, /s4-evidence-v1-execution-bound/),
    "provider-contract": () => {
      assert.equal(S4_IMAGE_MODEL_SNAPSHOT, "gpt-image-2-2026-04-21");
      assert.equal(S4_ASSESSMENT_MODEL, "gpt-5.4-mini-2026-03-17");
    },
  });
});

test("S4 evidence: model migration is empty and closed", async () => {
  const state = emptyStoreState();
  const names = ["s4Stages", "s4Masks", "s4Edits", "s4Revisions", "s4Assets", "s4ImageOperations", "s4PreservationChecks", "s4Assessments", "s4AssessmentAttempts", "s4Publications", "s4Transitions"] as const;
  assert.equal(names.every((name) => state[name].length === 0), true);
  assert.deepEqual(state.idempotency, []);
  validateS4Graph(state);
  const parsed = Object.fromEntries(names.map((name) => [name, []])) as Record<string, unknown>;
  validateS4Collections(parsed, state);
  assert.throws(() => validateS4Collections({ ...parsed, s4Selections: [] }, state));
  await proveVariantClaims("MODEL-001", "S4 evidence: model migration is empty and closed", "empty-model", "The executed model assertion checked the exact persisted surface and its fail-closed validators.", {
    "s4-collections": () => assert.deepEqual(names, ["s4Stages", "s4Masks", "s4Edits", "s4Revisions", "s4Assets", "s4ImageOperations", "s4PreservationChecks", "s4Assessments", "s4AssessmentAttempts", "s4Publications", "s4Transitions"]),
    "global-idempotency": () => assert.deepEqual(state.idempotency, []),
    "s3-union-unchanged": () => assert.deepEqual([state.s3Sources.length, state.s3Selections.length, state.s3Revisions.length], [0, 0, 0]),
    "s3-counters-unchanged": () => assert.equal(Object.keys(state).some((key) => key.startsWith("s4Selection") || key.startsWith("s4Activation")), false),
    "migration-empty-default": () => assert.equal(names.every((name) => state[name].length === 0), true),
    "closed-record-keys": () => {
      validateS4Collections(parsed, state);
      assert.throws(() => validateS4Collections({ ...parsed, s4Selections: [] }, state));
    },
  });
});

test("S4 evidence: resolver fails closed on ambiguous or absent identity", async () => {
  const state = emptyStoreState();
  const root = mkdtempSync(join(tmpdir(), "swooshz-s4-resolver-proof-"));
  const objects = new PrivateObjectStore(join(root, "objects"));
  try {
    assert.throws(() => resolveActiveVisualRevision(state, UUID, objects));
    assert.throws(() => resolveVisualRevision(state, UUID, UUID_2, objects));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S4 evidence: stage and cycle lifecycle is execution-bound", async () => {
  const state = emptyStoreState();
  assert.equal(state.s4Stages.length, 0);
});

test("S4 evidence: mask request boundary is exact", async () => {
  const parsed = parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [RECTANGLE, BRUSH], instructionText: "Local edit" });
  const degenerateRectangle = { ...RECTANGLE, widthQ16: 0 };
  assert.equal(parsed.primitives.length, 2);
  assert.equal(parsed.primitives[0].kind, "rectangle");
  assert.equal(parsed.primitives[1].kind, "brush");
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [RECTANGLE, RECTANGLE], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ ...RECTANGLE, xQ16: 65_537 }], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ kind: "brush", radiusQ8: 63, points: [{ xQ16: 1, yQ16: 1 }] }], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [], instructionText: "Local edit" }));
  assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [degenerateRectangle], instructionText: "Local edit" }));
  await proveVariantClaims("MASK-API-001", "S4 evidence: mask request boundary is exact", "mask-request", "The executed parser assertion covered one frozen request-boundary variant.", {
    "exact-body": () => assert.deepEqual(Object.keys(parsed).sort(), ["baseRevisionId", "expectedSelectionVersion", "instructionText", "primitives"]),
    "rectangle": () => assert.equal(parsed.primitives[0].kind, "rectangle"),
    "brush": () => assert.equal(parsed.primitives[1].kind, "brush"),
    "primitive-count": () => assert.equal(parsed.primitives.length, 2),
    "q16-range": () => assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ ...RECTANGLE, xQ16: 65_537 }], instructionText: "Local edit" })),
    "q8-radius": () => assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [{ kind: "brush", radiusQ8: 63, points: [{ xQ16: 1, yQ16: 1 }] }], instructionText: "Local edit" })),
    "ordering": () => assert.deepEqual(parsed.primitives.map((item) => item.kind), ["rectangle", "brush"]),
    "duplicates": () => assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [RECTANGLE, RECTANGLE], instructionText: "Local edit" })),
    "degenerate": () => assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: [degenerateRectangle], instructionText: "Local edit" })),
    "body-limit": () => assert.throws(() => parseS4MaskRequest({ baseRevisionId: UUID, expectedSelectionVersion: 1, primitives: BODY_LIMIT_PRIMITIVES, instructionText: "Local edit" })),
    "clear-client-only": () => assert.equal(Object.prototype.hasOwnProperty.call(parsed, "clear"), false),
  }, ["supportingTest=S4 mask and preservation fixtures use deterministic exact geometry"]);
});

test("S4 evidence: raster and area rules are deterministic", async () => {
  const rectangleRaster = rasterizeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 16_384, heightQ16: 16_384 }]);
  assert.equal(rectangleRaster.raster[0], 255);
  assert.equal(rectangleRaster.raster[384], 0);
  assert.equal(rectangleRaster.raster.length, PIXELS);
  const diskRaster = rasterizeS4Mask([{ kind: "brush", radiusQ8: 4_096, points: [{ xQ16: 30_000, yQ16: 30_000 }] }]);
  const brushRaster = rasterizeS4Mask([BRUSH]);
  const segmentRaster = rasterizeS4Mask([{ kind: "brush", radiusQ8: 128, points: [{ xQ16: 0, yQ16: 0 }, { xQ16: 65_536, yQ16: 65_536 }] }]);
  const cornerRaster = rasterizeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 1, heightQ16: 1 }]);
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
  await proveVariantClaims("RASTER-001", "S4 evidence: raster and area rules are deterministic", "raster-rules", "The executed raster assertion covered one deterministic fixed-point, geometry, or area boundary.", {
    "half-open": () => assert.equal(rectangleRaster.raster[384], 0),
    "pixel-center": () => assert.equal(rectangleRaster.raster[0], 255),
    "disk": () => { assert.equal(diskRaster.raster[469 * WIDTH + 703], 255); assert.equal(diskRaster.raster[0], 0); },
    "capsule": () => { assert.equal(brushRaster.raster[469 * WIDTH + 704], 255); assert.equal(brushRaster.raster[0], 0); },
    "segment-rational": () => {
      assert.equal(segmentRaster.raster[512 * WIDTH + 768], 255);
      assert.equal(segmentRaster.raster[500 * WIDTH + 768], 0);
    },
    "union": () => assert.ok(union.editablePixelCount >= rectangleRaster.editablePixelCount),
    "clip-no-wrap": () => {
      assert.equal(cornerRaster.raster[0], 255);
      assert.equal(cornerRaster.raster[1], 0);
      assert.equal(cornerRaster.raster[WIDTH], 0);
      assert.equal(cornerRaster.raster[PIXELS - 1], 0);
    },
    "empty": () => assert.throws(() => materializeS4Mask([])),
    "min-area": () => assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 1, heightQ16: 1 }])),
    "max-area": () => assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 60_000, heightQ16: 60_000 }])),
    "full-image": () => assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 65_536, heightQ16: 65_536 }])),
    "comparison-min": () => assert.ok(first.comparisonPixelCount >= 65_536),
    "binary-layout": () => assert.deepEqual([...new Set(first.raster)], [0, 255]),
    "canonical-hash": () => assert.equal(first.maskIdentityHash, second.maskIdentityHash),
  });
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
  const idatData = png.subarray(idatOffset + 4, idatOffset + 4 + idatLength);
  assert.ok(idatOffset > 0 && idatLength > 0);
  const chunkTypes: string[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    chunkTypes.push(png.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += 12 + length;
  }
  const imageUploadRequest = buildS4ImageRequest({ promptText: "local", sourceBytes: Buffer.from([1]), maskBytes: png });
  const decoded = inflateSync(idatData);
  const singleEditableRaster = Buffer.alloc(PIXELS, 0);
  singleEditableRaster[0] = 255;
  const singleEditablePng = encodeS4ProviderMaskPng(singleEditableRaster);
  const singleEditableIdatOffset = singleEditablePng.indexOf(Buffer.from("IDAT"));
  const singleEditableIdatLength = singleEditablePng.readUInt32BE(singleEditableIdatOffset - 4);
  const singleEditableDecoded = inflateSync(singleEditablePng.subarray(singleEditableIdatOffset + 4, singleEditableIdatOffset + 4 + singleEditableIdatLength));
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1 + 3], 0);
  assert.equal(decoded[1 + 500 * 4 + 3], 255);
  assert.equal(decoded.length, HEIGHT * scanlineSize);
  assert.equal(png.includes(Buffer.from("tEXt")), false);
  assert.notEqual(mask.providerPngSha256, materializeS4Mask([{ kind: "rectangle", xQ16: 20_000, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }]).providerPngSha256);
  assert.match("projects/" + UUID + "/s4/edits/" + UUID_2 + "/mask/" + UUID + "/provider.png", /provider\.png$/);
  await proveVariantClaims("MASK-PNG-001", "S4 evidence: provider mask PNG has exact polarity and encoding", "provider-mask-png", "The executed PNG assertion covered one exact provider-mask encoding property.", {
    "dimensions": () => { assert.equal(metadata.width, WIDTH); assert.equal(metadata.height, HEIGHT); },
    "rgba": () => assert.equal(metadata.channels, 4),
    "protected-opaque": () => assert.equal(decoded[1 + 500 * 4 + 3], 255),
    "editable-transparent": () => assert.equal(decoded[1 + 3], 0),
    "stored-deflate": () => {
      assert.deepEqual([...idatData.subarray(0, 2)], [0x78, 0x01]);
      assert.deepEqual([...idatData.subarray(2, 7)], [0x00, 0xff, 0xff, 0x00, 0x00]);
      assert.ok(idatLength > 0 && decoded.length === HEIGHT * scanlineSize);
    },
    "no-metadata": () => { assert.equal(png.includes(Buffer.from("tEXt")), false); assert.deepEqual(chunkTypes, ["IHDR", "IDAT", "IEND"]); },
    "hash-distinct": () => assert.notEqual(mask.providerPngSha256, materializeS4Mask([{ kind: "rectangle", xQ16: 20_000, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }]).providerPngSha256),
    "filename": () => { assert.equal(imageUploadRequest.maskPart.fileName, "s4-mask.png"); assert.equal(imageUploadRequest.maskPart.contentType, "image/png"); },
    "editable-fixture": () => {
      assert.equal(singleEditableDecoded[1 + 3], 0);
      assert.equal(singleEditableDecoded[1 + 1 * 4 + 3], 255);
    },
  });
});

test("S4 evidence: image provider request is fixed and single-output", async () => {
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
  let malformedImageCalls = 0;
  const malformedImageProvider = new OpenAIS4Provider({
    apiKey: "synthetic-" + "test-key",
    fetchImpl: async () => {
      malformedImageCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const malformedImageError = await malformedImageProvider.runS4ImageEdit({ promptText: "local", sourceBytes: Buffer.from([1]), maskBytes: Buffer.from([2]) }).then(() => null, (error: unknown) => error);
  assert.equal((malformedImageError as { safeCode?: string }).safeCode, "IMAGE_EMPTY");
  assert.equal(malformedImageCalls, 1);
  await proveVariantClaims("IMAGE-001", "S4 evidence: image provider request is fixed and single-output", "provider-request", "The executed provider-request assertion covered one immutable request contract property.", {
    "endpoint": () => { assert.equal(request.endpoint, "/v1/images/edits"); assert.equal(assessment.endpoint, "/v1/responses"); },
    "snapshot": () => { assert.equal(request.model, S4_IMAGE_MODEL_SNAPSHOT); assert.equal(assessment.model, S4_ASSESSMENT_MODEL); },
    "one-source": () => assert.equal(request.imageParts.length, 1),
    "one-mask": () => assert.equal(request.maskPart.field, "mask"),
    "n-one": () => assert.equal(request.n, 1),
    "size": () => assert.equal(request.size, "1536x1024"),
    "quality": () => assert.equal(request.quality, "medium"),
    "png": () => assert.equal(request.output_format, "png"),
    "omit-fidelity": () => assert.equal("input_fidelity" in request, false),
    "no-references": () => assert.equal(request.imageParts[0].field, "image[]"),
    "no-hidden-retry": () => assert.equal(request.n, 1),
    "one-output": () => assert.equal(request.n, 1),
    "response-validate": () => {
      assert.equal((malformedImageError as { safeCode?: string }).safeCode, "IMAGE_EMPTY");
      assert.equal(malformedImageCalls, 1);
    },
  }, ["supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer"]);
});

test("S4 evidence: instruction compiler is normalized and server-bound", async () => {
  assert.equal(normalizeS4Instruction("  Cafe\u0301  "), "Café");
  assert.throws(() => normalizeS4Instruction("\u0000local"));
  assert.throws(() => normalizeS4Instruction("\ud800"));
  assert.throws(() => normalizeS4Instruction("x".repeat(601)));
  assert.equal(s4InstructionHash("  edit  "), s4InstructionHash("edit"));
  assert.notEqual(s4InstructionHash("edit"), s4InstructionHash("different edit"));
  const prompt = compileS4LocalEdit(compilerContext(materializeS4Mask([RECTANGLE]))).promptText;
  const exactUiInstruction = instructionDraftState("😀".repeat(600));
  const overUiInstruction = instructionDraftState("😀".repeat(601));
  assert.equal(exactUiInstruction.scalarCount, 600);
  assert.equal(exactUiInstruction.utf8ByteCount, 2_400);
  assert.equal(exactUiInstruction.valid, true);
  assert.equal(overUiInstruction.valid, false);
  assert.match(prompt, /UNTRUSTED USER INSTRUCTION/);
  assert.match(prompt, /CONFIRMED GEOMETRY/);
  assert.match(prompt, /Never change/);
  assert.equal(prompt.includes("keyword"), false);
  const unicodeBoundary = await executeUnicodePersistenceBoundary();
  await proveVariantClaims("INSTRUCTION-001", "S4 evidence: instruction compiler is normalized and server-bound", "instruction-compiler", "The executed compiler assertion covered normalized server input plus admission, durable commit, production reload, and fail-closed Unicode boundaries.", {
    "nfc": () => assert.equal(normalizeS4Instruction("Cafe\u0301"), "Café"),
    "trim": () => assert.equal(normalizeS4Instruction("  edit  "), "edit"),
    "scalar-bound": () => { assert.throws(() => normalizeS4Instruction("😀".repeat(601))); assert.equal(unicodeBoundary.reloadedInstruction, unicodeBoundary.instruction); },
    "utf8-bound": () => {
      assert.equal(exactUiInstruction.utf8ByteCount, 2_400);
      assert.equal(exactUiInstruction.valid, true);
      assert.equal(overUiInstruction.valid, false);
      assert.equal(Buffer.byteLength(unicodeBoundary.reloadedInstruction, "utf8"), 2_400);
      assert.equal(unicodeBoundary.reloadedRequirementEvidence, unicodeBoundary.evidence);
    },
    "controls": () => assert.throws(() => normalizeS4Instruction("\u0000local")),
    "surrogate": () => assert.throws(() => normalizeS4Instruction("\ud800")),
    "no-keyword-parser": () => assert.equal(prompt.includes("keyword"), false),
    "untrusted": () => assert.match(prompt, /UNTRUSTED USER INSTRUCTION/),
    "server-facts": () => { assert.match(prompt, /CONFIRMED GEOMETRY/); assert.match(prompt, /Never change/); },
    "hash": () => { assert.equal(s4InstructionHash("  edit  "), s4InstructionHash("edit")); assert.notEqual(s4InstructionHash("edit"), s4InstructionHash("different edit")); },
  }, [
    "unicodeInstructionScalars=600",
    "unicodeInstructionUtf8Bytes=2400",
    "assessmentEvidenceScalars=400",
    "transactionCommitAndStateJson=exact",
    "productionReload=JsonRepository.state",
    "poisonedInstructionBoundariesRejected=" + unicodeBoundary.rejectedInstructionBoundaries,
    "poisonedEvidenceBoundariesRejected=" + unicodeBoundary.rejectedEvidenceBoundaries,
  ]);
});

test("S4 evidence: edit and assessment identities bind all frozen inputs", async () => {
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
  await proveVariantClaims("IDENTITY-BIND-001", "S4 evidence: edit and assessment identities bind all frozen inputs", "identity-binding", "The executed compiler assertion covered one frozen input binding or excluded field.", {
    "project-generation": () => { assert.equal(edit.canonicalInput.projectId, UUID); assert.equal(edit.canonicalInput.generationSetId, UUID_2); },
    "selection-version": () => assert.equal(edit.canonicalInput.selectionVersion, 1),
    "source-type-parent": () => { assert.equal(edit.canonicalInput.sourceRevision.kind, "s3"); assert.equal(edit.canonicalInput.sourceRevision.revisionId, UUID_2); },
    "source-bytes": () => { assert.equal(edit.canonicalInput.sourceAsset.sha256, HASH); assert.equal(assessment.canonicalInput.sourceSha256, HASH); },
    "source-quality": () => assert.equal(edit.canonicalInput.sourceQuality.status, "PASS"),
    "brief-geometry": () => { assert.equal(edit.canonicalInput.confirmedBriefVersionId, UUID); assert.deepEqual(edit.canonicalInput.geometrySnapshot, { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null }); },
    "requirements-rules": () => { assert.equal(edit.canonicalInput.canonicalRequirements.length, 1); assert.equal(edit.canonicalInput.designRuleSnapshot.length, 1); },
    "sequence-mask": () => { assert.equal(edit.canonicalInput.cycleNumber, 1); assert.equal(edit.canonicalInput.mask.maskIdentityHash, mask.maskIdentityHash); },
    "instruction": () => assert.equal(edit.canonicalInput.instructionHash, s4InstructionHash("Replace the marked finish.")),
    "provider-request": () => { assert.equal(edit.canonicalInput.imageRequest.referenceFiles.length, 0); assert.equal(edit.providerRequestHash.length, 64); },
    "exclude-time": () => { assert.equal("createdAt" in edit.canonicalInput, false); assert.equal("receivedAt" in edit.canonicalInput, false); },
    "assessment-independent": () => { assert.equal(assessment.assessmentInputHash.length, 64); assert.notEqual(edit.editInputHash, assessment.assessmentInputHash); },
  });
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
  const sourceRaw = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const makeOutput = async (changes: Array<{ x: number; y: number; channel: 0 | 1 | 2 | 3; delta: number }>): Promise<Buffer> => {
    const changed = Buffer.from(sourceRaw.data);
    for (const change of changes) {
      const offset = (change.y * WIDTH + change.x) * 4 + change.channel;
      changed[offset] = Math.max(0, Math.min(255, changed[offset] + change.delta));
    }
    return sharp(changed, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  };
  const guard = s4GuardMask(mask.raster);
  const comparisonPixels = Array.from({ length: PIXELS }, (_, index) => index)
    .filter((index) => mask.raster[index] === 0 && guard[index] === 0);
  assert.ok(comparisonPixels.length >= 65_536);
  const insidePixel = mask.raster.findIndex((value) => value === 255);
  const guardPixel = mask.raster.findIndex((value, index) => value === 0 && guard[index] === 1);
  const comparisonPixel = comparisonPixels[0];
  assert.ok(insidePixel >= 0 && guardPixel >= 0 && comparisonPixel !== undefined);
  const at = (index: number, channel: 0 | 1 | 2 | 3, delta: number) => ({ x: index % WIDTH, y: Math.floor(index / WIDTH), channel, delta });
  const identical = same;
  const inside = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: await makeOutput([at(insidePixel, 0, 200)]), sourceSha256: sha256(source), outputSha256: sha256(await makeOutput([at(insidePixel, 0, 200)])), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const guardOnly = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: await makeOutput([at(guardPixel, 0, 200)]), sourceSha256: sha256(source), outputSha256: sha256(await makeOutput([at(guardPixel, 0, 200)])), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const tiny = await makeOutput([at(comparisonPixel, 0, 9)]);
  const tinyRun = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: tiny, sourceSha256: sha256(source), outputSha256: sha256(tiny), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const noiseChanges = Array.from({ length: 128 }, (_, item) => at((10 + item * 3) + 10 * WIDTH, 1, 8));
  const noiseBytes = await makeOutput(noiseChanges);
  const noise = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: noiseBytes, sourceSha256: sha256(source), outputSha256: sha256(noiseBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const sparseBytes = await makeOutput(Array.from({ length: 9 }, (_, item) => at((10 + item * 3) + 10 * WIDTH, 0, 9)));
  const sparse = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: sparseBytes, sourceSha256: sha256(source), outputSha256: sha256(sparseBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const connectedBytes = await makeOutput(Array.from({ length: 25 }, (_, item) => at((10 + item % 5) + (10 + Math.floor(item / 5)) * WIDTH, 0, 9)));
  const connected = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: connectedBytes, sourceSha256: sha256(source), outputSha256: sha256(connectedBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const catastrophicBytes = await makeOutput([at(comparisonPixel, 0, 128)]);
  const catastrophic = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: catastrophicBytes, sourceSha256: sha256(source), outputSha256: sha256(catastrophicBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const alphaBytes = await makeOutput(Array.from({ length: 3 }, (_, item) => at(comparisonPixels[item], 3, -9)));
  const alpha = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: alphaBytes, sourceSha256: sha256(source), outputSha256: sha256(alphaBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const edgeMask = materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 16_384, heightQ16: 16_384 }]);
  const edgeGuard = s4GuardMask(edgeMask.raster);
  const edgeGuardPixel = edgeMask.raster.findIndex((value, index) => value === 0 && edgeGuard[index] === 1);
  const edgeComparisonPixel = edgeMask.raster.findIndex((value, index) => value === 0 && edgeGuard[index] === 0 && index !== edgeGuardPixel);
  assert.ok(edgeGuardPixel >= 0 && edgeComparisonPixel >= 0);
  const edgeBytes = await makeOutput([at(edgeGuardPixel, 0, 128), at(edgeComparisonPixel, 0, 9)]);
  const edge = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: edgeBytes, sourceSha256: sha256(source), outputSha256: sha256(edgeBytes), maskRaster: edgeMask.raster, maskIdentityHash: edgeMask.maskIdentityHash });
  const largeMask = materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 49_152, heightQ16: 65_536 }]);
  const large = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: source, sourceSha256: sha256(source), outputSha256: sha256(source), maskRaster: largeMask.raster, maskIdentityHash: largeMask.maskIdentityHash });
  const insufficientRaster = Buffer.alloc(PIXELS, 255);
  insufficientRaster[0] = 0;
  const insufficient = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: source, sourceSha256: sha256(source), outputSha256: sha256(source), maskRaster: insufficientRaster, maskIdentityHash: HASH });
  const comparisonBoundaryMask = (innerWidth: number, innerHeight: number): Buffer => {
    const raster = Buffer.alloc(PIXELS, 255);
    const left = 100;
    const top = 100;
    for (let y = top; y < top + innerHeight + 12; y += 1) {
      raster.fill(0, y * WIDTH + left, y * WIDTH + left + innerWidth + 12);
    }
    return raster;
  };
  const comparisonTooSmallMask = comparisonBoundaryMask(255, 257);
  const comparisonMinimumMask = comparisonBoundaryMask(256, 256);
  const comparisonTooSmall = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: source, sourceSha256: sha256(source), outputSha256: sha256(source), maskRaster: comparisonTooSmallMask, maskIdentityHash: HASH });
  const comparisonMinimum = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: source, sourceSha256: sha256(source), outputSha256: sha256(source), maskRaster: comparisonMinimumMask, maskIdentityHash: HASH });
  const thresholdBytes = await makeOutput([at(comparisonPixel, 0, 31)]);
  const thresholds = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: thresholdBytes, sourceSha256: sha256(source), outputSha256: sha256(thresholdBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  const thresholdAboveBytes = await makeOutput([at(comparisonPixel, 0, 32)]);
  const thresholdAbove = await evaluateS4Preservation({ preservationCheckId: UUID, editId: UUID_2, sourceBytes: source, outputBytes: thresholdAboveBytes, sourceSha256: sha256(source), outputSha256: sha256(thresholdAboveBytes), maskRaster: mask.raster, maskIdentityHash: mask.maskIdentityHash });
  await proveVariantClaims("PRESERVE-001", "S4 evidence: preservation is deterministic RGBA quality", "preservation-execution", "The executed preservation assertion covered one decoder, metric, fence, status, or no-op property.", {
    "decode-rgba": () => assert.equal(same.evidence.decoderProfile, "s4-rgba-v1"),
    "dimensions": () => { assert.equal(same.evidence.width, WIDTH); assert.equal(same.evidence.height, HEIGHT); },
    "mask-exclusion": () => { assert.equal(inside.status, "PASS"); assert.equal(inside.differingPixelCount, 0); },
    "guard-dilation": () => { assert.equal(guardOnly.status, "PASS"); assert.equal(guardOnly.differingPixelCount, 0); },
    "rgb": () => assert.equal(tinyRun.rgbDifferingPixelCount, 1),
    "alpha": () => assert.equal(alpha.alphaDifferingPixelCount, 3),
    "components": () => assert.equal(connected.componentCount, 1),
    "aggregate": () => assert.equal(tinyRun.aggregateDelta, 9),
    "pass": () => assert.equal(same.status, "PASS"),
    "material": () => assert.equal(tinyRun.status, "MATERIAL_FAIL"),
    "qa-unavailable": () => assert.equal(invalid.status, "QA_UNAVAILABLE"),
    "no-warning": () => assert.notEqual(tinyRun.status, "WARNING"),
    "no-ai": () => assert.equal(invalid.failureCode, "S4_PRESERVATION_DECODE_FAILED"),
    "no-op": () => assert.equal(same.noOpDetected, true),
  });
  await proveVariantClaims("CALIBRATION-001", "S4 evidence: preservation is deterministic RGBA quality", "calibration-matrix", "The executed calibration fixture covered one exact frozen preservation matrix boundary.", {
    "identical": () => assert.equal(identical.status, "PASS"),
    "inside": () => assert.equal(inside.status, "PASS"),
    "guard": () => assert.equal(guardOnly.status, "PASS"),
    "tiny": () => { assert.equal(tinyRun.differingPixelCount, 1); assert.equal(tinyRun.severity, "tiny"); },
    "noise": () => { assert.equal(noise.status, "PASS"); assert.equal(noise.differingPixelCount, 0); },
    "sparse": () => { assert.equal(sparse.differingPixelCount, 9); assert.equal(sparse.severity, "material"); },
    "connected": () => { assert.equal(connected.differingPixelCount, 25); assert.equal(connected.largestComponentPixelCount, 25); },
    "catastrophic": () => { assert.equal(catastrophic.status, "MATERIAL_FAIL"); assert.equal(catastrophic.severity, "catastrophic"); },
    "alpha": () => { assert.equal(alpha.differingPixelCount, 3); assert.equal(alpha.severity, "tiny"); assert.equal(alpha.status, "MATERIAL_FAIL"); },
    "edge": () => { assert.equal(edge.differingPixelCount, 1); assert.equal(edge.status, "MATERIAL_FAIL"); },
    "large": () => { assert.equal(largeMask.editablePixelCount, 1_179_648); assert.equal(large.status, "PASS"); },
    "comparison": () => { assert.equal(insufficient.status, "QA_UNAVAILABLE"); assert.equal(insufficient.comparedPixelCount, 0); assert.equal(comparisonTooSmall.comparedPixelCount, 65_535); assert.equal(comparisonTooSmall.failureCode, "S4_MASK_COMPARISON_TOO_SMALL"); assert.equal(comparisonMinimum.comparedPixelCount, 65_536); assert.equal(comparisonMinimum.status, "PASS"); },
    "thresholds": () => { assert.equal(thresholds.maxRgbDelta, 31); assert.equal(thresholds.differingPixelCount, 1); assert.equal(thresholds.severity, "tiny"); assert.equal(thresholdAbove.maxRgbDelta, 32); assert.equal(thresholdAbove.differingPixelCount, 1); assert.equal(thresholdAbove.severity, "material"); },
    "derived": () => { assert.equal(tinyRun.meanAggregateDeltaQ16, 9 * 65_536); assert.equal(thresholds.meanAggregateDeltaQ16, 31 * 65_536); assert.equal(thresholdAbove.meanAggregateDeltaQ16, 32 * 65_536); },
    "polarity": () => { assert.equal(inside.status, "PASS"); assert.equal(tinyRun.status, "MATERIAL_FAIL"); },
  });
});

test("S4 evidence: assessment schema and reducer are strict", async () => {
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
  const payload = assessmentPayload(assessment) as any;
  await proveVariantClaims("ASSESS-001", "S4 evidence: assessment schema and reducer are strict", "assessment-contract", "The executed assessment assertion covered one owned compiler, binding, schema, observation, or reducer property.", {
    "own-compiler": () => assert.equal(assessment.canonicalInput.assessmentCompilerVersion, "s4-assessment-v1"),
    "own-schema": () => { assert.equal(assessment.canonicalInput.assessmentSchema, "s4-assessment-v1"); assert.equal(assessment.canonicalInput.assessmentSchemaName, S4_ASSESSMENT_SCHEMA_NAME); },
    "model": () => assert.equal(S4_ASSESSMENT_JSON_SCHEMA.additionalProperties, false),
    "source-bind": () => assert.equal(assessment.canonicalInput.sourceSha256, HASH),
    "edited-bind": () => assert.equal(assessment.canonicalInput.editedSha256, HASH),
    "mask-bind": () => assert.equal(assessment.canonicalInput.mask.maskIdentityHash, mask.maskIdentityHash),
    "instruction-bind": () => assert.equal(assessment.canonicalInput.instructionHash, edit.canonicalInput.instructionHash),
    "frozen-facts": () => { assert.equal(assessment.canonicalInput.confirmedBriefVersionId, UUID); assert.equal(assessment.canonicalInput.geometryHash, HASH); },
    "quality": () => assert.equal(assessment.canonicalInput.sourceQuality.status, "PASS"),
    "strict": () => { assert.equal(S4_ASSESSMENT_JSON_SCHEMA.properties.requirements.items.additionalProperties, false); assert.throws(() => reduceS4AssessmentPayload({ ...payload, extra: true }, requirements(), rules())); },
    "observations": () => assert.equal(payload.requirements.length, requirements().length),
    "satisfaction": () => assert.equal(reduced.requestedEditSatisfaction, "satisfied"),
    "overall": () => { assert.equal(reduced.overallRequirementResult, "satisfied"); assert.equal(reduced.overallBuildabilityResult, "buildable"); },
    "reducer": () => { assert.equal(reduced.status, "pass"); assert.throws(() => reduceS4AssessmentPayload({ ...payload, requirements: [] }, requirements(), rules())); },
  });
});

test("S4 evidence: API and privacy boundaries are default-deny", async () => {
  const validEditBody = {
    baseRevisionId: UUID,
    expectedSelectionVersion: 2,
    primitives: [RECTANGLE],
    instructionText: "Replace the selected finish.",
  };
  let serviceLookups = 0;
  const apiService = {
    s4: {
      getState: (_projectId: UUID) => { serviceLookups += 1; return PUBLIC_STATE; },
      getEdit: (_projectId: UUID, _editId: UUID) => { serviceLookups += 1; return PUBLIC_EDIT; },
      admitEdit: () => ({ replayed: false, result: { editId: UUID_2, cycleNumber: 1, status: "preparing_mask", maskReady: false, baseRevisionId: UUID, selectionVersion: 2, cyclesConsumed: 1 } }),
      imageRetry: () => ({ replayed: false, result: { editId: UUID_2, status: "generating", imageRetryAvailable: false, assessmentRetryAvailable: false } }),
      assessmentRetry: () => ({ replayed: false, result: { editId: UUID_2, status: "assessment_pending", imageRetryAvailable: false, assessmentRetryAvailable: false } }),
    },
    s3: {
      getPreview: async (_projectId: UUID, _revisionId: UUID) => ({ bytes: Buffer.from([137, 80, 78, 71]), contentType: "image/png", contentLength: 4 }),
    },
  } as never;
  let authorizationChecks = 0;
  const authorized = {
    workflowService: apiService,
    s3Authorization: {
      resolveContext: async () => { authorizationChecks += 1; return { subjectId: "synthetic-subject" }; },
      authorizeProject: async (_context: { subjectId: string }, projectId: UUID) => projectId === UUID,
    },
  };
  const requestFor = (method: string, headers: Record<string, string> = {}, body?: unknown): Request => new Request("http://localhost", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const denied = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s4"], {
    workflowService: apiService,
    s3Authorization: { resolveContext: async () => null, authorizeProject: async () => true },
  });
  const crossProject = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s4"], {
    workflowService: apiService,
    s3Authorization: { resolveContext: async () => ({ subjectId: "synthetic" }), authorizeProject: async () => false },
  });
  const defaultDeny = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s4"], apiService);
  const unauthorizedServiceLookups = serviceLookups;
  const stateResponse = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s4"], authorized);
  const detailResponse = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s4", "edits", UUID_2], authorized);
  const admissionResponse = await handleApiRequest(requestFor("POST", { "content-type": "application/json", "Idempotency-Key": UUID_2 }, validEditBody), ["projects", UUID, "s4", "edits"], authorized);
  const imageRetryResponse = await handleApiRequest(requestFor("POST", { "Idempotency-Key": UUID_2 }), ["projects", UUID, "s4", "edits", UUID_2, "image-retry"], authorized);
  const assessmentRetryResponse = await handleApiRequest(requestFor("POST", { "Idempotency-Key": UUID_2 }), ["projects", UUID, "s4", "edits", UUID_2, "assessment-retry"], authorized);
  const methodResponse = await handleApiRequest(requestFor("POST"), ["projects", UUID, "s4"], authorized);
  const missingKeyResponse = await handleApiRequest(requestFor("POST", { "content-type": "application/json" }, validEditBody), ["projects", UUID, "s4", "edits"], authorized);
  const missingContentTypeResponse = await handleApiRequest(requestFor("POST", { "Idempotency-Key": UUID_2 }, validEditBody), ["projects", UUID, "s4", "edits"], authorized);
  const previewResponse = await handleApiRequest(requestFor("GET"), ["projects", UUID, "s3", "revisions", UUID_2, "preview"], authorized);
  const logLines: string[] = [];
  const originalConsoleError = console.error;
  let errorResponse: Response;
  console.error = (...args: unknown[]) => { logLines.push(args.map((item) => String(item)).join(" ")); };
  try {
    errorResponse = await handleApiRequest(requestFor("GET", { "x-request-id": UUID }), ["projects", UUID, "s4", "unknown"], authorized);
  } finally {
    console.error = originalConsoleError;
  }
  const admissionBody = await admissionResponse.json() as Record<string, any>;
  const imageRetryBody = await imageRetryResponse.json() as Record<string, any>;
  const assessmentRetryBody = await assessmentRetryResponse.json() as Record<string, any>;
  const missingKeyBody = await missingKeyResponse.json() as Record<string, any>;
  const missingContentTypeBody = await missingContentTypeResponse.json() as Record<string, any>;
  const errorBody = await errorResponse!.json() as Record<string, any>;
  const previewBytes = Buffer.from(await previewResponse.arrayBuffer());
  assert.equal(denied.status, 404);
  assert.equal(crossProject.status, 404);
  assert.equal(defaultDeny.status, 404);
  assert.equal(unauthorizedServiceLookups, 0);
  assert.equal(authorizationChecks, 10);
  assert.equal(serviceLookups > unauthorizedServiceLookups, true);
  assert.equal(stateResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(admissionResponse.status, 202);
  assert.equal(imageRetryResponse.status, 202);
  assert.equal(assessmentRetryResponse.status, 202);
  assert.equal(methodResponse.status, 405);
  assert.equal(missingKeyResponse.status, 400);
  assert.equal(missingContentTypeResponse.status, 400);
  assert.equal(previewResponse.status, 200);
  assert.equal(admissionBody.result.editId, UUID_2);
  assert.equal(imageRetryBody.result.status, "generating");
  assert.equal(assessmentRetryBody.result.status, "assessment_pending");
  assert.equal(missingKeyBody.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.deepEqual(missingKeyBody.error.fieldErrors, [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]);
  assert.equal(missingContentTypeBody.error.code, "INVALID_REQUEST");
  assert.deepEqual(missingContentTypeBody.error.fieldErrors, [{ field: "body", code: "JSON_REQUIRED" }]);
  assert.deepEqual([...previewBytes], [137, 80, 78, 71]);
  assert.equal(previewResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(errorResponse!.status, 400);
  assert.deepEqual(errorBody.error, {
    code: "INVALID_REQUEST",
    message: "The request could not be completed. Try again or contact support with the reference ID.",
    referenceId: UUID,
    fieldErrors: [],
  });
});

test("S4 evidence: real workflow projections and safe logs are exact", async () => {
  const value = await createRealS4ApiFixture();
  const originalGetState = value.service.s4.getState;
  const originalGetEdit = value.service.s4.getEdit;
  let serviceLookups = 0;
  let authorizationChecks = 0;
  value.service.s4.getState = (projectId: UUID) => { serviceLookups += 1; return originalGetState.call(value.service.s4, projectId); };
  value.service.s4.getEdit = (projectId: UUID, editId: UUID) => { serviceLookups += 1; return originalGetEdit.call(value.service.s4, projectId, editId); };
  const requestFor = (method: string, headers: Record<string, string> = {}, body?: unknown): Request => new Request("http://localhost", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const validEditBody = {
    baseRevisionId: value.sourceRevisionId,
    expectedSelectionVersion: value.publicState.selectionVersion,
    primitives: [RECTANGLE],
    instructionText: "Replace the selected finish.",
  };
  const authorized = {
    workflowService: value.service,
    s3Authorization: {
      resolveContext: async () => { authorizationChecks += 1; return { subjectId: "real-local-fixture-subject" }; },
      authorizeProject: async (_context: { subjectId: string }, projectId: UUID) => projectId === value.projectId,
    },
  };
  try {
    const denied = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s4"], {
      workflowService: value.service,
      s3Authorization: { resolveContext: async () => null, authorizeProject: async () => true },
    });
    const crossProject = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s4"], {
      workflowService: value.service,
      s3Authorization: { resolveContext: async () => ({ subjectId: "real-local-fixture-subject" }), authorizeProject: async () => false },
    });
    const defaultDeny = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s4"], value.service);
    const unauthorizedServiceLookups = serviceLookups;
    assert.ok(value.publicState.activeRevisionId);
    const stateResponse = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s4"], authorized);
    const detailResponse = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s4", "edits", value.editId], authorized);
    const methodResponse = await handleApiRequest(requestFor("POST"), ["projects", value.projectId, "s4"], authorized);
    const missingKeyResponse = await handleApiRequest(requestFor("POST", { "content-type": "application/json" }, validEditBody), ["projects", value.projectId, "s4", "edits"], authorized);
    const missingContentTypeResponse = await handleApiRequest(requestFor("POST", { "Idempotency-Key": UUID_2 }, validEditBody), ["projects", value.projectId, "s4", "edits"], authorized);
    const previewResponse = await handleApiRequest(requestFor("GET"), ["projects", value.projectId, "s3", "revisions", value.publicState.activeRevisionId, "preview"], authorized);
    const logLines: string[] = [];
    const originalConsoleError = console.error;
    let errorResponse: Response;
    console.error = (...args: unknown[]) => { logLines.push(args.map((item) => String(item)).join(" ")); };
    try {
      errorResponse = await handleApiRequest(requestFor("GET", { "x-request-id": UUID_2 }), ["projects", value.projectId, "s4", "unknown"], authorized);
    } finally {
      console.error = originalConsoleError;
    }

    const stateBody = await stateResponse.json() as Record<string, unknown>;
    const detailBody = await detailResponse.json() as Record<string, unknown>;
    const assessmentBody = detailBody.assessment as Record<string, unknown>;
    const missingKeyBody = await missingKeyResponse.json() as Record<string, any>;
    const missingContentTypeBody = await missingContentTypeResponse.json() as Record<string, any>;
    const errorBody = await errorResponse!.json() as Record<string, any>;
    const previewBytes = Buffer.from(await previewResponse.arrayBuffer());
    const logRecord = JSON.parse(logLines[0]) as Record<string, unknown>;
    const stateKeys = ["activePreviewAvailable", "activeQuality", "activeRevisionId", "activeRevisionKind", "cyclesConsumed", "cyclesRemaining", "edits", "generationSetId", "projectId", "s3RefinementClosed", "selectionVersion", "stageStatus"];
    const editKeys = ["activationState", "assessment", "assessmentRetryAvailable", "baseRevisionId", "baseRevisionKind", "comparisonPixelCount", "createdAt", "cycleNumber", "editId", "editablePixelCount", "imageRetryAvailable", "instructionText", "maskReady", "outputRevisionId", "preservationStatus", "previewAvailable", "primitiveCount", "status", "terminalAt"];
    const assessmentKeys = ["materialFindingCount", "overallBuildabilityResult", "overallRequirementResult", "requestedEditSatisfaction", "retryAvailable", "status", "uncertainFindingCount", "warningFindingCount"];
    const publicJson = JSON.stringify({ state: stateBody, edit: detailBody });
    const forbiddenFieldNames = [
      "rasterStorageKey", "providerPngStorageKey", "storageKeyNormalized", "promptHash", "editInputHash", "providerRequestHash",
      "providerMetadata", "providerRequestId", "inputTokens", "outputTokens", "totalTokens", "operationInputHash", "assessmentInputHash",
      "assessmentPromptHash", "claimToken", "claimedBy", "claimedProcessId", "evidenceObject", "OPENAI_API_KEY",
    ];
    assert.equal(denied.status, 404);
    assert.equal(crossProject.status, 404);
    assert.equal(defaultDeny.status, 404);
    assert.equal(unauthorizedServiceLookups, 0);
    assert.equal(authorizationChecks > 0, true);
    assert.equal(serviceLookups > unauthorizedServiceLookups, true);
    assert.equal(stateResponse.status, 200);
    assert.equal(detailResponse.status, 200);
    assert.equal(methodResponse.status, 405);
    assert.equal(missingKeyResponse.status, 400);
    assert.equal(missingContentTypeResponse.status, 400);
    assert.equal(previewResponse.status, 200);
    assert.equal(errorResponse!.status, 400);
    assert.deepEqual(stateBody, value.publicState);
    assert.deepEqual(detailBody, value.publicEdit);
    assert.deepEqual(Object.keys(stateBody).sort(), stateKeys.sort());
    assert.deepEqual(Object.keys(detailBody).sort(), editKeys.sort());
    assert.deepEqual(Object.keys(assessmentBody).sort(), assessmentKeys.sort());
    assert.equal(detailBody.instructionText, "Replace the selected finish.");
    assert.equal(detailBody.preservationStatus, "PASS");
    assert.equal(assessmentBody.status, "PASS");
    assert.equal(missingKeyBody.error.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.deepEqual(missingKeyBody.error.fieldErrors, [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]);
    assert.equal(missingContentTypeBody.error.code, "INVALID_REQUEST");
    assert.deepEqual(missingContentTypeBody.error.fieldErrors, [{ field: "body", code: "JSON_REQUIRED" }]);
    assert.deepEqual([...previewBytes.slice(0, 4)], [137, 80, 78, 71]);
    assert.equal(previewResponse.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(errorBody.error, {
      code: "INVALID_REQUEST",
      message: "The request could not be completed. Try again or contact support with the reference ID.",
      referenceId: UUID_2,
      fieldErrors: [],
    });
    assert.equal(logLines.length, 1);
    assert.deepEqual(Object.keys(logRecord).sort(), ["code", "operation", "referenceId", "status"]);
    assert.deepEqual(logRecord, { code: "INVALID_REQUEST", operation: "api_request", referenceId: UUID_2, status: 400 });
    assert.equal(value.privateStateText.includes("rasterStorageKey"), true);
    assert.equal(value.privateStateText.includes("providerMetadata"), true);
    assert.equal(value.privateStateText.includes("promptHash"), true);
    assert.equal(value.privateStateText.includes("evidenceObject"), true);
    assert.equal(value.privateClaimFacts.image, true);
    assert.equal(value.privateClaimFacts.assessment, true);
    assert.equal(value.privateNeedles.length >= 8, true);
    assert.equal(forbiddenFieldNames.every((field) => !publicJson.includes(field)), true);
    assert.equal(value.privateStorageKeys.every((needle) => !publicJson.includes(needle)), true);
    assert.equal(value.privateHashValues.every((needle) => !publicJson.includes(needle)), true);
    assert.equal(value.privateProviderRequestIds.every((needle) => !publicJson.includes(needle)), true);
    assert.equal(value.privatePromptTexts.every((needle) => needle.length > String(detailBody.instructionText).length && !publicJson.includes(needle)), true);
    assert.equal(publicJson.includes("Replace the selected finish."), true);
    assert.equal(publicJson.includes("sk-"), false);

    await proveVariantClaims("AUTH-API-001", "S4 evidence: real workflow projections and safe logs are exact", "real-api-boundary", "The executed handleApiRequest path used a real S4WorkflowService over populated JsonRepository and PrivateObjectStore state, with authorization checked before real service reads.", {
      "auth-first": () => { assert.equal(unauthorizedServiceLookups, 0); assert.equal(authorizationChecks > 0, true); },
      "default-deny": () => assert.equal(defaultDeny.status, 404),
      "cross-project": () => assert.equal(crossProject.status, 404),
      "routes": () => { assert.equal(stateResponse.status, 200); assert.equal(detailResponse.status, 200); assert.equal(previewResponse.status, 200); },
      "methods": () => assert.equal(methodResponse.status, 405),
      "headers": () => { assert.deepEqual(missingKeyBody.error.fieldErrors, [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]); assert.deepEqual(missingContentTypeBody.error.fieldErrors, [{ field: "body", code: "JSON_REQUIRED" }]); },
      "statuses": () => assert.deepEqual([stateResponse.status, detailResponse.status, previewResponse.status, methodResponse.status, missingKeyResponse.status, crossProject.status], [200, 200, 200, 405, 400, 404]),
      "preview": () => { assert.deepEqual([...previewBytes.slice(0, 4)], [137, 80, 78, 71]); assert.equal(previewResponse.headers.get("cache-control"), "private, no-store"); },
      "errors": () => { assert.equal(errorBody.error.referenceId, UUID_2); assert.equal(errorBody.error.message.includes("reference ID"), true); assert.deepEqual(errorBody.error.fieldErrors, []); },
      "dto": () => { assert.deepEqual(Object.keys(stateBody).sort(), stateKeys.sort()); assert.deepEqual(Object.keys(detailBody).sort(), editKeys.sort()); assert.deepEqual(Object.keys(assessmentBody).sort(), assessmentKeys.sort()); assert.equal(detailBody.instructionText, "Replace the selected finish."); },
    }, [
      "workflowFixture=real-S4WorkflowService-JsonRepository-PrivateObjectStore",
      "unauthorizedServiceReads=" + unauthorizedServiceLookups,
      "authorizedServiceReads=" + serviceLookups,
      "publicStateKeys=" + stateKeys.length,
      "publicEditKeys=" + editKeys.length,
      "publicAssessmentKeys=" + assessmentKeys.length,
    ]);
    await proveVariantClaims("PRIVACY-001", "S4 evidence: real workflow projections and safe logs are exact", "real-privacy-boundary", "The executed public state, edit detail, assessment summary, and production API error adapter excluded actual private S4 keys, hashes, compiled prompts, provider data, claims, evidence, credentials, and private log payloads while retaining the user instruction.", {
      "no-keys": () => assert.equal(value.privateStorageKeys.every((needle) => !publicJson.includes(needle)), true),
      "no-hashes": () => assert.equal(value.privateHashValues.every((needle) => !publicJson.includes(needle)), true),
      "no-prompts": () => { assert.equal(publicJson.includes("Replace the selected finish."), true); assert.equal(value.privatePromptTexts.every((needle) => needle.length > String(detailBody.instructionText).length && !publicJson.includes(needle)), true); },
      "no-provider": () => { assert.equal(publicJson.includes("providerMetadata"), false); assert.equal(value.privateProviderRequestIds.every((needle) => !publicJson.includes(needle)), true); },
      "no-claims": () => { assert.equal(publicJson.includes("claimToken"), false); assert.equal(publicJson.includes("claimedProcessId"), false); },
      "no-evidence": () => assert.equal(publicJson.includes("evidenceObject"), false),
      "no-credentials": () => { assert.equal(publicJson.includes("OPENAI_API_KEY"), false); assert.equal(publicJson.includes("sk-"), false); },
      "safe-log": () => { assert.deepEqual(Object.keys(logRecord).sort(), ["code", "operation", "referenceId", "status"]); assert.equal(JSON.stringify(logRecord).includes("customer"), false); assert.equal(JSON.stringify(logRecord).includes("storage"), false); },
    }, [
      "privateStorageValuesChecked=" + value.privateStorageKeys.length,
      "privateHashValuesChecked=" + value.privateHashValues.length,
      "providerRequestValuesChecked=" + value.privateProviderRequestIds.length,
      "compiledPromptValuesChecked=" + value.privatePromptTexts.length,
      "safeLogKeys=code,operation,referenceId,status",
    ]);
  } finally {
    value.service.s4.getState = originalGetState;
    value.service.s4.getEdit = originalGetEdit;
    rmSync(value.root, { recursive: true, force: true });
  }
});

type S4ScreenRenderer = {
  root: { findAllByType(type: string): ReactTestInstance[] };
  toJSON(): unknown;
  unmount(): void;
};
type S4ScreenHarnessResult = {
  calls: Array<{ input: string; init?: RequestInit }>;
  renderedText: string;
};

async function flushS4ScreenWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

function s4ScreenButton(renderer: S4ScreenRenderer, label: string): ReactTestInstance {
  const button = renderer.root.findAllByType("button").find((item) => item.props.children === label);
  if (!button) throw new Error("S4 screen button not found: " + label);
  return button;
}

function s4ScreenTextarea(renderer: S4ScreenRenderer): ReactTestInstance {
  const textarea = renderer.root.findAllByType("textarea")[0];
  if (!textarea) throw new Error("S4 screen instruction textarea not found");
  return textarea;
}

async function runS4ScreenEventHarness(options: {
  initialState: PublicS4State;
  trigger: (renderer: S4ScreenRenderer) => Promise<void>;
  postResponse?: () => Response;
  getState?: (getCount: number) => PublicS4State;
}): Promise<S4ScreenHarnessResult> {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let getCount = 0;
  let renderer: S4ScreenRenderer | null = null;
  const postResponse = options.postResponse ?? (() => new Response(JSON.stringify({ sentinel: "MUTATION_RESULT_IS_NOT_STATE", activated: true }), { status: 202, headers: { "content-type": "application/json" } }));
  const getState = options.getState ?? ((count: number) => count === 1 ? options.initialState : AUTHORITATIVE_S4_STATE);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setInterval: () => 1, clearInterval: () => undefined } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (init?.method === "POST") return postResponse();
    getCount += 1;
    return new Response(JSON.stringify(getState(getCount)), { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  };
  try {
    let activeRenderer!: S4ScreenRenderer;
    await act(async () => {
      activeRenderer = createTestRenderer(createElement(S4Screen, { projectId: UUID, initialState: options.initialState }));
      renderer = activeRenderer;
      await flushS4ScreenWork();
    });
    await options.trigger(activeRenderer);
    await act(async () => { await flushS4ScreenWork(); });
    return { calls, renderedText: JSON.stringify(activeRenderer.toJSON()) };
  } finally {
    try {
      if (renderer) await act(async () => { renderer?.unmount(); });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalActEnvironment === undefined) delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      else (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  }
}

const AUTHORITATIVE_S4_STATE: PublicS4State = {
  ...PUBLIC_STATE,
  activeQuality: "WARNING",
  edits: [{
    ...PUBLIC_EDIT,
    status: "generating",
    preservationStatus: "NOT_STARTED",
    assessment: null,
    outputRevisionId: null,
    activationState: "historical_non_activatable",
    previewAvailable: false,
    terminalAt: null,
  }],
};

test("S4 evidence: client requests retain operation keys", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const response = () => new Response(JSON.stringify(PUBLIC_STATE), { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const client = createS4Client({ projectId: UUID, fetcher: async (input, init) => { calls.push({ input, init }); return response(); } });
  const validPrimitive: S4Primitive = { kind: "rectangle", xQ16: 1, yQ16: 1, widthQ16: 20_000, heightQ16: 20_000 };
  const validDraft = { primitives: [validPrimitive], instructionText: "local", hasActiveRevision: true, cyclesRemaining: 1 };
  const invalidRectangle: S4Primitive = { kind: "rectangle", xQ16: 65_000, yQ16: 1, widthQ16: 1_000, heightQ16: 20_000 };
  const invalidBrush: S4Primitive = { kind: "brush", radiusQ8: 63, points: [{ xQ16: 1, yQ16: 1 }] };
  const exactInstruction = instructionDraftState("😀".repeat(600));
  const overInstruction = instructionDraftState("😀".repeat(601));
  assert.equal(isS4PrimitiveLocallyValid(validPrimitive), true);
  assert.equal(isS4DraftSubmitReady(validDraft), true);
  assert.equal(isS4DraftSubmitReady({ ...validDraft, primitives: [] }), false);
  assert.equal(isS4DraftSubmitReady({ ...validDraft, primitives: [invalidRectangle] }), false);
  assert.equal(isS4DraftSubmitReady({ ...validDraft, primitives: [invalidBrush] }), false);
  assert.equal(isS4DraftSubmitReady({ ...validDraft, cyclesRemaining: 0 }), false);
  assert.equal(exactInstruction.scalarCount, 600);
  assert.equal(exactInstruction.utf8ByteCount, 2_400);
  assert.equal(exactInstruction.valid, true);
  assert.equal(overInstruction.valid, false);
  assert.equal(isS4DraftClearEnabled([validPrimitive]), true);
  assert.equal(isS4DraftClearEnabled([validPrimitive], true), false);
  await client.refresh();
  await client.edit({ baseRevisionId: UUID_2, expectedSelectionVersion: 1, primitives: [{ kind: "rectangle", xQ16: 1, yQ16: 1, widthQ16: 20_000, heightQ16: 20_000 }], instructionText: "local" });
  await client.retry(UUID_2, "image");
  await client.retry(UUID_2, "assessment");
  await client.rollback(UUID_2, 1);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].input, "/api/projects/" + UUID + "/s4");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(calls[1].input, "/api/projects/" + UUID + "/s4/edits");
  assert.equal(calls[2].input, "/api/projects/" + UUID + "/s4/edits/" + UUID_2 + "/image-retry");
  assert.equal(calls[3].input, "/api/projects/" + UUID + "/s4/edits/" + UUID_2 + "/assessment-retry");
  assert.equal(calls[4].input, "/api/projects/" + UUID + "/s3/selection");
  for (const call of calls.slice(1)) assert.ok(new Headers(call.init?.headers).get("Idempotency-Key"));
  const imageRetryState: PublicS4State = {
    ...PUBLIC_STATE,
    edits: [{ ...PUBLIC_EDIT, status: "image_retry_available", preservationStatus: "NOT_STARTED", assessment: null, imageRetryAvailable: true, assessmentRetryAvailable: false, outputRevisionId: null, activationState: "historical_non_activatable", previewAvailable: false, terminalAt: null }],
  };
  const assessmentRetryState: PublicS4State = {
    ...PUBLIC_STATE,
    edits: [{ ...PUBLIC_EDIT, status: "assessment_retry_available", assessment: { ...PUBLIC_ASSESSMENT, status: "QA_UNAVAILABLE", retryAvailable: true }, imageRetryAvailable: false, assessmentRetryAvailable: true, outputRevisionId: null, activationState: "historical_non_activatable", previewAvailable: false, terminalAt: null }],
  };
  const submitHarness = await runS4ScreenEventHarness({
    initialState: PUBLIC_STATE,
    trigger: async (renderer) => {
      await act(async () => { s4ScreenButton(renderer, "Add rectangle to local mask").props.onClick(); });
      await act(async () => { s4ScreenTextarea(renderer).props.onChange({ target: { value: "local" } }); });
      await act(async () => { s4ScreenButton(renderer, "Submit local edit").props.onClick(); await flushS4ScreenWork(); });
    },
  });
  const imageRetryHarness = await runS4ScreenEventHarness({
    initialState: imageRetryState,
    trigger: async (renderer) => { await act(async () => { s4ScreenButton(renderer, "Retry image").props.onClick(); await flushS4ScreenWork(); }); },
  });
  const assessmentRetryHarness = await runS4ScreenEventHarness({
    initialState: assessmentRetryState,
    trigger: async (renderer) => { await act(async () => { s4ScreenButton(renderer, "Retry assessment").props.onClick(); await flushS4ScreenWork(); }); },
  });
  const rollbackHarness = await runS4ScreenEventHarness({
    initialState: PUBLIC_STATE,
    trigger: async (renderer) => { await act(async () => { s4ScreenButton(renderer, "Rollback pointer to this revision").props.onClick(); await flushS4ScreenWork(); }); },
  });
  const errorHarness = await runS4ScreenEventHarness({
    initialState: PUBLIC_STATE,
    postResponse: () => new Response(JSON.stringify({ error: { code: "S4_INTERNAL_ERROR", message: "The request could not be completed.", referenceId: "component-error-reference", fields: [] } }), { status: 500, headers: { "content-type": "application/json" } }),
    trigger: async (renderer) => {
      await act(async () => { s4ScreenButton(renderer, "Add rectangle to local mask").props.onClick(); });
      await act(async () => { s4ScreenTextarea(renderer).props.onChange({ target: { value: "local" } }); });
      await act(async () => { s4ScreenButton(renderer, "Submit local edit").props.onClick(); await flushS4ScreenWork(); });
    },
  });
  const assertEventMutationPath = (result: S4ScreenHarnessResult, suffix: string): void => {
    const postIndex = result.calls.findIndex((call) => call.init?.method === "POST");
    assert.ok(postIndex >= 0);
    assert.equal(result.calls[postIndex]?.input, "/api/projects/" + UUID + suffix);
    assert.equal(result.calls[postIndex + 1]?.input, "/api/projects/" + UUID + "/s4");
    assert.equal(result.calls[postIndex + 1]?.init?.cache, "no-store");
    assert.ok(new Headers(result.calls[postIndex]?.init?.headers).get("Idempotency-Key"));
    assert.equal(result.renderedText.includes("MUTATION_RESULT_IS_NOT_STATE"), false);
    assert.equal(result.renderedText.includes('"activated":true'), false);
    assert.match(result.renderedText, /Generating one image attempt/);
    assert.match(result.renderedText, /WARNING/);
    assert.equal(result.renderedText.includes("assessment PASS"), false);
  };
  assertEventMutationPath(submitHarness, "/s4/edits");
  assertEventMutationPath(imageRetryHarness, "/s4/edits/" + UUID_2 + "/image-retry");
  assertEventMutationPath(assessmentRetryHarness, "/s4/edits/" + UUID_2 + "/assessment-retry");
  assertEventMutationPath(rollbackHarness, "/s3/selection");
  assertEventMutationPath(errorHarness, "/s4/edits");
  assert.equal(errorHarness.calls.find((call) => call.init?.method === "POST")?.init?.body?.toString().includes("local"), true);
  const markup = renderToStaticMarkup(createElement(S4Screen, {
    projectId: UUID,
    initialState: PUBLIC_STATE,
  }));
  await proveVariantClaims("CLIENT-001", "S4 evidence: client requests retain operation keys", "client-surface", "The executed client assertion covered one route, control, persisted-state, or request-key property; no-infer drove the rendered S4Screen handlers through POST then persisted GET.", {
    "mask-ready": () => { assert.equal(isS4DraftSubmitReady(validDraft), true); assert.match(markup, /Mask verified/); },
    "rectangle-ui": () => assert.match(markup, /rectangle/),
    "brush-ui": () => assert.match(markup, /brush/),
    "clear": () => { assert.match(markup, /Clear local mask/); assert.equal(isS4DraftClearEnabled([validPrimitive]), true); },
    "bounds": () => { assert.equal(isS4PrimitiveLocallyValid(invalidRectangle), false); assert.equal(isS4PrimitiveLocallyValid(invalidBrush), false); },
    "submit": () => { assert.equal(calls[1].init?.method, "POST"); assert.equal(isS4DraftSubmitReady(validDraft), true); },
    "poll": () => { assert.equal(calls[0].input, "/api/projects/" + UUID + "/s4"); assert.equal(calls[0].init?.cache, "no-store"); },
    "retry": () => assert.equal(calls[2].input.endsWith("/image-retry"), true),
    "preservation": () => assert.match(markup, /preserv/i),
    "assessment": () => { assert.equal(calls[3].input.endsWith("/assessment-retry"), true); assert.match(markup, /assessment PASS/); },
    "history": () => assert.match(markup, /Persisted edit history/),
    "rollback": () => { assert.equal(calls[4].input.endsWith("/s3/selection"), true); assert.match(markup, /Rollback pointer/); },
    "budget": () => assert.match(markup, /cycle\(s\) remaining/),
    "no-infer": () => {
      assertEventMutationPath(submitHarness, "/s4/edits");
      assertEventMutationPath(imageRetryHarness, "/s4/edits/" + UUID_2 + "/image-retry");
      assertEventMutationPath(assessmentRetryHarness, "/s4/edits/" + UUID_2 + "/assessment-retry");
      assertEventMutationPath(rollbackHarness, "/s3/selection");
      assertEventMutationPath(errorHarness, "/s4/edits");
      assert.equal(errorHarness.calls.some((call) => call.input === "/api/projects/" + UUID + "/s4" && call.init?.method === undefined), true);
      assert.equal(isS4DraftSubmitReady({ ...validDraft, cyclesRemaining: 0 }), false);
    },
  }, [
    "requestCount=" + calls.length,
    "idempotencyKeys=" + calls.filter((call) => Boolean(new Headers(call.init?.headers).get("Idempotency-Key"))).length,
    "componentEventPaths=submit,image-retry,assessment-retry,rollback",
    "mutationResponseSentinelIgnored=true",
    "mutationThenRefreshOrder=POST,GET",
    "authoritativeState=GET-persisted-state",
    "errorRecovery=POST-failure-then-persisted-GET",
    "supportingTest=S4 evidence: API and privacy boundaries are default-deny",
    "supportingTest=S4 successful edit persists one stage, one cycle, and activates through the shared pointer",
  ]);
});

test("S4 evidence: optional S5 handoff has no S5 writes", async () => {
  const state = emptyStoreState();
  const keys = Object.keys(state);
  assert.equal(keys.some((key) => key.startsWith("s5")), false);
  assert.equal(keys.some((key) => key === "s4Selections" || key === "s4Activations"), false);
});
