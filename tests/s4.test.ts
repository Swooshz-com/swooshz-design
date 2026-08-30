import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { AppError, type BoothGeometry, type ProviderMetadata, type S4MaskPrimitive } from "../src/lib/types";
import { MockOpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import { createExactS3FixturePng } from "../src/lib/s3-media";
import { materializeS4Mask } from "../src/lib/s4-mask";
import { evaluateS4Preservation } from "../src/lib/s4-preservation";
import type { S4ProviderContract } from "../src/lib/s4-provider";
import { resolveActiveVisualRevision } from "../src/lib/revision-resolver";
import { validateS4Collections, validateS4Graph } from "../src/lib/s4-persistence";
import { sha256 } from "../src/lib/utils";
import { createS4Client, S4Screen } from "../app/components/S4Client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WIDTH = 1536;
const HEIGHT = 1024;
const PIXELS = WIDTH * HEIGHT;

function briefData(): any {
  return {
    projectFacts: { clientName: "S4 Fixture", eventName: "S4 Event", venueName: "Synthetic Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "S4 Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null },
    unknowns: [], assumptions: [], freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function s2QaPayload(input: any): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "S4 source fixture observation",
    })),
    designRules: input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "S4 source fixture observation",
    })),
  };
}

function s4AssessmentPayload(repository: JsonRepository): any {
  const assessment = repository.state().s4Assessments.at(-1);
  if (!assessment) throw new Error("assessment fixture is not persisted");
  return {
    requirements: assessment.canonicalRequirements.map((item) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      expectedValue: item.expectedValue, observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "S4 assessment fixture observation",
    })),
    designRules: assessment.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "S4 assessment fixture observation",
    })),
    requestedEdit: { outcome: "satisfied", evidence: "The marked local region was updated." },
    overall: { requirementResult: "satisfied", buildabilityResult: "buildable", evidence: "The fixture remains buildable." },
  };
}

async function editedFixturePng(): Promise<Buffer> {
  const rgba = Buffer.alloc(PIXELS * 4);
  for (let index = 0; index < PIXELS; index += 1) {
    const offset = index * 4;
    rgba[offset] = 43; rgba[offset + 1] = 91; rgba[offset + 2] = 134; rgba[offset + 3] = 255;
  }
  for (let y = 210; y < 510; y += 1) for (let x = 315; x < 760; x += 1) {
    const offset = (y * WIDTH + x) * 4;
    rgba[offset] = 188; rgba[offset + 1] = 132; rgba[offset + 2] = 74;
  }
  return sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

type S4Fixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  projectId: string;
  generationSetId: string;
  sourceBytes: Buffer;
  outputBytes: Buffer;
  imageCalls: number;
  assessmentCalls: number;
};

type S4FixtureOptions = Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onS4ProviderDispatchPhase" | "onS4PublicationPhase"> & {
  imageResults?: Array<Buffer | ProviderFailure>;
  assessmentResults?: Array<any | ProviderFailure>;
};

async function fixture(options: S4FixtureOptions = {}): Promise<S4Fixture> {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s4-g3-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const briefVersionId = randomUUID();
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  const sourceBytes = await createExactS3FixturePng();
  const outputBytes = await editedFixturePng();
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
    state.projects.push({ projectId, name: "S4 fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data: briefData(), contentHash: sourceHash, confirmationMode: "explicit_user_action", confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), failureCode: null });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });
  let imageCalls = 0;
  let assessmentCalls = 0;
  const imageResults = [...(options.imageResults ?? [outputBytes])];
  const assessmentResults = [...(options.assessmentResults ?? [null])];
  const s4Provider: S4ProviderContract = {
    runS4ImageEdit: async () => {
      imageCalls += 1;
      const next = imageResults.shift() ?? outputBytes;
      if (next instanceof ProviderFailure) throw next;
      return { pngBytes: next, providerRequestId: "s4-image-fixture-" + String(imageCalls) };
    },
    runS4Assessment: async () => {
      assessmentCalls += 1;
      const next = assessmentResults.shift() ?? null;
      if (next instanceof ProviderFailure) throw next;
      return { payload: next ?? s4AssessmentPayload(repository), providerRequestId: "s4-assessment-fixture-" + String(assessmentCalls) };
    },
  };
  const provider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => s2QaPayload(input) });
  const { imageResults: _images, assessmentResults: _assessments, ...workflowOptions } = options;
  const service = createWorkflowService({ repository, objects, provider, s4Provider, ...workflowOptions });
  return { root, repository, objects, service, projectId, generationSetId, sourceBytes, outputBytes, imageCalls, assessmentCalls };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("S4 fixture timed out: " + JSON.stringify(read()));
}

async function ready(value: S4Fixture): Promise<{ sourceRevisionId: string; selectionVersion: number }> {
  value.service.s2.getReferenceDraft(value.projectId);
  const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
  await waitFor(() => value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");
  const before = value.service.s3.getState(value.projectId);
  const source = before.screenedCandidates.find((item) => item.originalSourceId)?.originalSourceId;
  assert.ok(source);
  const selected = value.service.s3.selectSource(value.projectId, "source_root", source, 0, randomUUID(), randomUUID());
  assert.equal(selected.replayed, false);
  return { sourceRevisionId: selected.result.activeRevisionId, selectionVersion: selected.result.selectionVersion };
}

function cleanup(value: S4Fixture): void { rmSync(value.root, { recursive: true, force: true }); }

const EDIT_PRIMITIVES: S4MaskPrimitive[] = [{ kind: "rectangle", xQ16: 13_107, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }];

function admit(value: S4Fixture, selected: { sourceRevisionId: string; selectionVersion: number }, instructionText = "Replace the marked counter finish.") {
  return value.service.s4.admitEdit(value.projectId, {
    baseRevisionId: selected.sourceRevisionId,
    expectedSelectionVersion: selected.selectionVersion,
    primitives: EDIT_PRIMITIVES,
    instructionText,
  }, randomUUID(), randomUUID());
}

test("S4 mask and preservation fixtures use deterministic exact geometry", async () => {
  const first = materializeS4Mask(EDIT_PRIMITIVES);
  const second = materializeS4Mask(EDIT_PRIMITIVES);
  assert.equal(first.maskIdentityHash, second.maskIdentityHash);
  assert.equal(first.rasterSha256, second.rasterSha256);
  assert.equal(first.providerPngSha256, second.providerPngSha256);
  assert.ok(first.editablePixelCount >= 256);
  assert.ok(first.comparisonPixelCount >= 65_536);
  assert.throws(() => materializeS4Mask([]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_INVALID");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 1, heightQ16: 1 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_AREA_TOO_SMALL");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 65_536, heightQ16: 65_536 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_FULL_IMAGE");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 60_000, heightQ16: 60_000 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_AREA_TOO_LARGE");

  const sourceBytes = await createExactS3FixturePng();
  const outputBytes = await editedFixturePng();
  const run = await evaluateS4Preservation({
    preservationCheckId: randomUUID(), editId: randomUUID(), sourceBytes, outputBytes,
    sourceSha256: sha256(sourceBytes), outputSha256: sha256(outputBytes),
    maskRaster: first.raster, maskIdentityHash: first.maskIdentityHash,
  });
  assert.equal(run.status, "PASS");
  assert.equal(run.noOpDetected, false);
  assert.equal(run.differingPixelCount, 0);
  assert.equal(run.evidence.status, "PASS");
});

test("S4 successful edit persists one stage, one cycle, and activates through the shared pointer", async () => {
  const value = await fixture();
  try {
    const selected = await ready(value);
    const admission = admit(value, selected);
    assert.equal(admission.replayed, false);
    const state = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    assert.equal(state.stageStatus, "started");
    assert.equal(state.s3RefinementClosed, true);
    assert.equal(state.cyclesConsumed, 1);
    assert.equal(state.cyclesRemaining, 1);
    assert.equal(state.activeRevisionKind, "s4");
    assert.equal(state.activeQuality, "PASS");
    assert.equal(state.edits.length, 1);
    assert.equal(state.edits[0].maskReady, true);
    assert.equal(state.edits[0].preservationStatus, "PASS");
    assert.equal(state.edits[0].assessment?.status, "PASS");
    assert.equal(value.repository.state().s4ImageOperations.length, 1);
    assert.equal(value.repository.state().s4AssessmentAttempts.length, 1);
    assert.equal(value.repository.state().s3Selections[0].activeRevisionId, state.activeRevisionId);
    validateS4Graph(value.repository.state());
    validateS4Collections({
      s4Stages: value.repository.state().s4Stages,
      s4Masks: value.repository.state().s4Masks,
      s4Edits: value.repository.state().s4Edits,
      s4Revisions: value.repository.state().s4Revisions,
      s4Assets: value.repository.state().s4Assets,
      s4ImageOperations: value.repository.state().s4ImageOperations,
      s4PreservationChecks: value.repository.state().s4PreservationChecks,
      s4Assessments: value.repository.state().s4Assessments,
      s4AssessmentAttempts: value.repository.state().s4AssessmentAttempts,
      s4Publications: value.repository.state().s4Publications,
      s4Transitions: value.repository.state().s4Transitions,
    }, value.repository.state());
    const resolved = resolveActiveVisualRevision(value.repository.state(), value.projectId, value.objects);
    assert.equal(resolved?.kind, "s4");
    assert.equal(resolved?.revisionId, state.activeRevisionId);
    const preview = await value.service.s3.getPreview(value.projectId, state.activeRevisionId!);
    assert.equal(preview.bytes.equals(value.outputBytes), true);
    const handoff = value.service.s4.toS5Handoff(value.projectId);
    assert.equal(handoff.activeRevisionId, state.activeRevisionId);
    assert.equal(handoff.activeRevisionKind, "s4");
    assert.equal(handoff.quality, "PASS");
    assert.equal(handoff.s4CyclesConsumed, 1);
    assert.throws(() => value.service.s3.refine(value.projectId, state.activeRevisionId!, state.selectionVersion, "S3 must be closed", randomUUID(), randomUUID()), (error: unknown) => error instanceof AppError && error.code === "S3_LINEAGE_CONFLICT");
  } finally { cleanup(value); }
});

test("S4 image and assessment retries are explicit, bounded, and preserve the same output identity", async () => {
  const value = await fixture({
    imageResults: [new ProviderFailure("PROVIDER_RATE_LIMIT")],
    assessmentResults: [new ProviderFailure("QA_PROVIDER_EMPTY")],
  });
  try {
    const selected = await ready(value);
    const admission = admit(value, selected, "Retry the marked finish once if the provider fails.");
    const imageRetryState = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "image_retry_available");
    assert.equal(imageRetryState.edits[0].imageRetryAvailable, true);
    value.service.s4.imageRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    const assessmentRetryState = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "assessment_retry_available");
    assert.equal(assessmentRetryState.edits[0].assessmentRetryAvailable, true);
    const before = value.repository.state();
    assert.equal(before.s4ImageOperations.length, 2);
    assert.equal(before.s4AssessmentAttempts.length, 1);
    const firstOutputAsset = before.s4AssessmentAttempts[0].outputAssetId;
    const firstOutputHash = before.s4AssessmentAttempts[0].outputSha256;
    value.service.s4.assessmentRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    const complete = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    const after = value.repository.state();
    assert.equal(complete.edits[0].assessmentRetryAvailable, false);
    assert.equal(after.s4ImageOperations.length, 2);
    assert.equal(after.s4AssessmentAttempts.length, 2);
    assert.equal(after.s4AssessmentAttempts[1].retryOfAttemptId, after.s4AssessmentAttempts[0].assessmentAttemptId);
    assert.equal(after.s4AssessmentAttempts[1].outputAssetId, firstOutputAsset);
    assert.equal(after.s4AssessmentAttempts[1].outputSha256, firstOutputHash);
    assert.equal(after.s4ImageOperations.every((item) => item.providerDispatchState === "consumed"), true);
    assert.equal(after.s4AssessmentAttempts.every((item) => item.providerDispatchState === "consumed"), true);
    validateS4Graph(after);
  } finally { cleanup(value); }
});

test("S4 API enforces auth-first access, exact JSON routes, safe errors, and S3 rollback to S4 history", async () => {
  const value = await fixture();
  try {
    const selected = await ready(value);
    const calls: string[] = [];
    const dependencies: ApiRequestDependencies = {
      workflowService: value.service,
      s3Authorization: {
        resolveContext: async () => { calls.push("context"); return { subjectId: "s4-test-subject" }; },
        authorizeProject: async (_context, projectId) => { calls.push("authorize:" + projectId); return projectId === value.projectId; },
      },
    };
    const get = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4"], dependencies);
    assert.equal(get.status, 200);
    const initial = await get.json() as S4StateForTest;
    assert.equal(initial.stageStatus, "not_started");
    assert.deepEqual(calls, ["context", "authorize:" + value.projectId]);

    const body = { baseRevisionId: selected.sourceRevisionId, expectedSelectionVersion: selected.selectionVersion, primitives: EDIT_PRIMITIVES, instructionText: "API local edit" };
    const key = randomUUID();
    const admitted = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(admitted.status, 202);
    const replay = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as any).replayed, true);
    const editId = (await admitted.clone().json() as any).result.editId;
    const detail = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4", "edits", editId], dependencies);
    assert.equal(detail.status, 200);
    const publicPayload = JSON.stringify(await detail.json());
    assert.equal(publicPayload.includes("storageKey"), false);
    assert.equal(publicPayload.includes("providerMetadata"), false);
    assert.equal(publicPayload.includes("promptHash"), false);
    assert.equal(publicPayload.includes("OPENAI_API_KEY"), false);

    const tooLarge = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "content-length": "131073", "Idempotency-Key": randomUUID() }, body: "{}" }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json() as any).error.code, "INVALID_REQUEST");
    const wrongMethod = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(wrongMethod.status, 405);
    const denied = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4"], { workflowService: value.service, s3Authorization: { resolveContext: () => null, authorizeProject: () => true } });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as any).error.code, "PROJECT_NOT_FOUND");

    const completed = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    const sourceRollback = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ targetKind: "revision", targetId: selected.sourceRevisionId, expectedSelectionVersion: completed.selectionVersion }) }), ["projects", value.projectId, "s3", "selection"], dependencies);
    assert.equal(sourceRollback.status, 200);
    const rollbackBody = await sourceRollback.json() as any;
    assert.equal(rollbackBody.result.eventKind, "rollback");
    assert.equal(rollbackBody.result.activeRevisionId, selected.sourceRevisionId);
    assert.equal(value.repository.state().s4Transitions.some((item) => item.phase === "rollback" && item.to === "rollback"), true);
  } finally { cleanup(value); }
});

type S4StateForTest = { stageStatus: string; selectionVersion: number };
