import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError, type BoothGeometry, type ProviderMetadata } from "../src/lib/types";
import { MockOpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import { compileS3Assessment, compileS3Refinement, renderS3AssessmentPrompt, renderS3RefinementPrompt, S3_ASSESSMENT_JSON_SCHEMA } from "../src/lib/s3-compiler";
import { buildS3AssessmentRequest, buildS3ImageRequest } from "../src/lib/s3-provider";
import { inspectExactS3Png, createExactS3FixturePng } from "../src/lib/s3-media";
import { compareClaimProofs, deriveClaimManifest } from "./s3-evidence-manifest";
import { recordS3ClaimProof, S3_SOURCE_ELIGIBILITY_TEST_NAME } from "./s3-proof";
import { cloneJson, sha256, jcs } from "../src/lib/utils";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function briefData(): any {
  return {
    projectFacts: { clientName: "S3 Fixture", eventName: "S3 Event", venueName: "Synthetic Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "S3 Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null },
    unknowns: [], assumptions: [], freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function qaPayload(input: any, mode: "pass" | "warning" | "material_fail" = "pass"): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId,
      expected: item.expected,
      expectedCount: item.expectedCount,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99,
      evidence: "S3 local fixture observation",
    })),
    designRules: input.designRules.map((item: any) => ({
      ruleId: item.ruleId,
      observed: mode === "material_fail" && item.ruleId === "structure.overhead-support" || mode === "warning" && item.ruleId === "branding.style" ? "non_compliant" : "compliant",
      confidence: 0.99,
      evidence: "S3 local fixture observation",
    })),
  };
}

type Fixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  provider: MockOpenAIProvider;
  projectId: string;
  generationSetId: string;
};

function fixture(options: { provider?: MockOpenAIProvider } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s3-g3-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const briefVersionId = randomUUID();
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  const sourceHash = sha256(ONE_PIXEL_PNG);
  const provider = options.provider ?? new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input) });
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID();
    const assetId = randomUUID();
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    objects.put(storageKey, ONE_PIXEL_PNG);
    conceptAssets.push({ assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: ONE_PIXEL_PNG.byteLength, sha256: sourceHash, status: "stored", createdAt: new Date(0).toISOString() });
    candidates.push({
      candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index,
      directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: new Date(0).toISOString() },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
    });
  }
  const metadata: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() };
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S3 fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data: briefData(), contentHash: sourceHash, confirmationMode: "explicit_user_action", confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), failureCode: null });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });
  const service = createWorkflowService({ repository, objects, provider });
  return { root, repository, objects, service, provider, projectId, generationSetId };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("S3 fixture timed out");
}

async function ready(fixtureValue: Fixture): Promise<{ sourceRevisionId: string; selectionVersion: number }> {
  fixtureValue.service.s2.getReferenceDraft(fixtureValue.projectId);
  const bound = await fixtureValue.service.s2.bindQa(fixtureValue.projectId, fixtureValue.generationSetId, 1, randomUUID(), randomUUID());
  await waitFor(() => fixtureValue.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");
  const before = fixtureValue.service.s3.getState(fixtureValue.projectId);
  const source = before.screenedCandidates.find((item) => item.originalSourceId)?.originalSourceId;
  assert.ok(source);
  const selected = fixtureValue.service.s3.selectSource(fixtureValue.projectId, "source_root", source, 0, randomUUID(), randomUUID());
  assert.equal(selected.replayed, false);
  return { sourceRevisionId: selected.result.activeRevisionId, selectionVersion: selected.result.selectionVersion };
}

function cleanup(value: Fixture): void { rmSync(value.root, { recursive: true, force: true }); }

test(S3_SOURCE_ELIGIBILITY_TEST_NAME, async () => {
  const qaCalls = new Map<number, number>();
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG, ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => {
      const call = qaCalls.get(input.candidateIndex) ?? 0;
      qaCalls.set(input.candidateIndex, call + 1);
      if (input.candidateIndex === 1 && call === 0) return qaPayload(input, "material_fail");
      if (input.candidateIndex === 2 && call === 0) return qaPayload(input, "material_fail");
      if (input.candidateIndex === 2 && call === 1) return qaPayload(input, "warning");
      if (input.candidateIndex === 4 && call === 0) return qaPayload(input, "warning");
      return qaPayload(input, "pass");
    },
  });
  const value = fixture({ provider });
  try {
    value.service.s2.getReferenceDraft(value.projectId);
    const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
    await waitFor(() => value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");

    const input = value.repository.state().s2Inputs.find((item) => item.id === bound.qaRun.inputVersionId);
    assert.ok(input);
    const sourceOne = input.sourceCandidates.find((item) => item.candidateIndex === 1);
    const sourceTwo = input.sourceCandidates.find((item) => item.candidateIndex === 2);
    assert.ok(sourceOne);
    assert.ok(sourceTwo);
    const initialRun = value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id);
    assert.ok(initialRun);
    assert.equal(initialRun.candidateResults.find((item) => item.candidateIndex === 1)?.status, "material_fail");
    assert.equal(initialRun.candidateResults.find((item) => item.candidateIndex === 2)?.status, "material_fail");
    assert.equal(initialRun.candidateResults.find((item) => item.candidateIndex === 3)?.status, "pass");
    assert.equal(initialRun.candidateResults.find((item) => item.candidateIndex === 4)?.status, "warning");

    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, sourceOne.candidateId, bound.qaRun.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.repository.state().s2Repairs.find((item) => item.candidateId === sourceOne.candidateId)?.status, (status) => status === "re_qa_pass");
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, sourceTwo.candidateId, bound.qaRun.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.repository.state().s2Repairs.find((item) => item.candidateId === sourceTwo.candidateId)?.status, (status) => status === "re_qa_warning");

    const afterRepair = value.service.s3.getState(value.projectId);
    const screenedOne = afterRepair.screenedCandidates.find((item) => item.candidateIndex === 1)!;
    const screenedTwo = afterRepair.screenedCandidates.find((item) => item.candidateIndex === 2)!;
    const screenedThree = afterRepair.screenedCandidates.find((item) => item.candidateIndex === 3)!;
    const screenedFour = afterRepair.screenedCandidates.find((item) => item.candidateIndex === 4)!;
    assert.equal(screenedOne.sourceQaStatus, "MATERIAL_FAIL");
    assert.equal(screenedTwo.sourceQaStatus, "MATERIAL_FAIL");
    assert.equal(screenedOne.originalSourceId, null);
    assert.equal(screenedTwo.originalSourceId, null);
    assert.ok(screenedOne.repairedSourceIds.length === 1);
    assert.ok(screenedTwo.repairedSourceIds.length === 1);
    assert.ok(screenedThree.originalSourceId);
    assert.ok(screenedFour.originalSourceId);
    assert.equal(screenedFour.sourceQaStatus, "WARNING");

    const repairOne = value.repository.state().s2Repairs.find((item) => item.candidateId === sourceOne.candidateId)!;
    const repairTwo = value.repository.state().s2Repairs.find((item) => item.candidateId === sourceTwo.candidateId)!;
    const derivedOne = value.repository.state().s2DerivedCandidates.find((item) => item.id === repairOne.derivedCandidateId)!;
    const derivedTwo = value.repository.state().s2DerivedCandidates.find((item) => item.id === repairTwo.derivedCandidateId)!;
    const reQaOne = value.repository.state().s2ReQaResults.find((item) => item.id === repairOne.reQaCandidateResultId)!;
    const reQaTwo = value.repository.state().s2ReQaResults.find((item) => item.id === repairTwo.reQaCandidateResultId)!;
    assert.equal(reQaOne.status, "pass");
    assert.equal(reQaTwo.status, "warning");

    const selected = value.service.s3.selectSource(value.projectId, "source_root", derivedOne.id, 0, randomUUID(), randomUUID());
    assert.equal(selected.replayed, false);
    const selectedSource = value.repository.state().s3Sources[0];
    assert.equal(selectedSource.sourceKind, "s2_repaired");
    assert.equal(selectedSource.selectedAssetId, derivedOne.id);
    assert.equal(selectedSource.canonicalSourceBinding.sourceKind, "s2_repaired");
    assert.equal(selectedSource.canonicalSourceBinding.s2SourceQaResultId, value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)!.candidateResults.find((item) => item.candidateIndex === 1)!.id);
    assert.equal(selectedSource.canonicalSourceBinding.s2ReQaResultId, reQaOne.id);
    assert.equal(selectedSource.canonicalSourceBinding.eligibilityResultId, reQaOne.id);
    assert.equal(selectedSource.canonicalSourceBinding.eligibilityStatus, "pass");
    assert.equal(selectedSource.canonicalSourceBinding.eligibilityVerdict, "PASS");

    const invalidGeneration = cloneJson(value.repository.state());
    invalidGeneration.s2DerivedCandidates.find((item) => item.id === derivedTwo.id)!.sourceGenerationSetId = randomUUID();
    const invalidOptions = (value.service.s3 as any).sourceOptions(invalidGeneration, value.projectId);
    assert.equal(invalidOptions.screened.find((item: any) => item.candidateIndex === 2).repairedSourceIds.includes(derivedTwo.id), false);

    value.objects.remove(derivedOne.storageKeyNormalized);
    const afterObjectLoss = value.service.s3.getState(value.projectId);
    assert.equal(afterObjectLoss.screenedCandidates.find((item) => item.candidateIndex === 1)!.repairedSourceIds.includes(derivedOne.id), false);

    const proofTest = "tests/s3.test.ts::" + S3_SOURCE_ELIGIBILITY_TEST_NAME;
    const facts = (claim: string, ...items: string[]) => ["claimId=" + claim, "provingTest=" + proofTest, ...items];
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "s1-pass", expectedResult: "A PASS original S1/S2 source is enumerated as an s1_original source.", actualResult: "Candidate 3 retained originalSourceId=" + screenedThree.originalSourceId + " with sourceQaStatus=PASS.", provingTest: proofTest, observationFacts: facts("SOURCE-001:s1-pass", "candidateIndex=3", "sourceKind=s1_original") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "s1-warning", expectedResult: "A WARNING original S1/S2 source is eligible as an s1_original source.", actualResult: "Candidate 4 retained originalSourceId=" + screenedFour.originalSourceId + " with sourceQaStatus=WARNING.", provingTest: proofTest, observationFacts: facts("SOURCE-001:s1-warning", "candidateIndex=4", "sourceKind=s1_original") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "s2-repaired-pass", expectedResult: "A valid repaired PASS is eligible even when the original QA was MATERIAL_FAIL.", actualResult: "Candidate 1 had original=MATERIAL_FAIL, reQa=pass, and repairedSourceId=" + derivedOne.id + ".", provingTest: proofTest, observationFacts: facts("SOURCE-001:s2-repaired-pass", "candidateIndex=1", "originalQa=MATERIAL_FAIL", "reQa=pass", "sourceKind=s2_repaired") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "s2-repaired-warning", expectedResult: "A valid repaired WARNING is eligible even when the original QA was MATERIAL_FAIL.", actualResult: "Candidate 2 had original=MATERIAL_FAIL, reQa=warning, and repairedSourceId=" + derivedTwo.id + ".", provingTest: proofTest, observationFacts: facts("SOURCE-001:s2-repaired-warning", "candidateIndex=2", "originalQa=MATERIAL_FAIL", "reQa=warning", "sourceKind=s2_repaired") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "original-retained", expectedResult: "Original eligible candidates remain available when other candidates are repaired.", actualResult: "Candidates 3 and 4 retained their original source IDs after repairs for candidates 1 and 2.", provingTest: proofTest, observationFacts: facts("SOURCE-001:original-retained", "candidateIndex=3,4", "repairedCandidates=1,2") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "object-integrity", expectedResult: "A repaired source whose committed private object is missing is not enumerated as eligible.", actualResult: "Removing the derived object removed derivedOne.id from the screened repaired-source options.", provingTest: proofTest, observationFacts: facts("SOURCE-001:object-integrity", "removedKey=" + derivedOne.storageKeyNormalized, "repairedSourcePresent=false") });
    recordS3ClaimProof({ testId: "SOURCE-001", variantId: "generation-binding", expectedResult: "A repaired candidate copied to another generation cannot satisfy source eligibility.", actualResult: "A cloned state with derivedTwo.sourceGenerationSetId changed to another UUID yielded no repaired option for candidate 2.", provingTest: proofTest, observationFacts: facts("SOURCE-001:generation-binding", "candidateIndex=2", "generationBinding=reject") });

    const failedCalls = new Map<number, number>();
    const failedProvider = new MockOpenAIProvider({
      briefData: briefData(),
      s2RepairResponses: [new ProviderFailure("PROVIDER_TIMEOUT")],
      s2QaResponseFactory: (input) => {
        const call = failedCalls.get(input.candidateIndex) ?? 0;
        failedCalls.set(input.candidateIndex, call + 1);
        return input.candidateIndex === 1 && call === 0 ? qaPayload(input, "material_fail") : qaPayload(input, "pass");
      },
    });
    const failedValue = fixture({ provider: failedProvider });
    try {
      failedValue.service.s2.getReferenceDraft(failedValue.projectId);
      const failedBound = await failedValue.service.s2.bindQa(failedValue.projectId, failedValue.generationSetId, 1, randomUUID(), randomUUID());
      await waitFor(() => failedValue.repository.state().s2QaRuns.find((item) => item.id === failedBound.qaRun.id)?.status, (status) => status === "completed");
      const failedInput = failedValue.repository.state().s2Inputs.find((item) => item.id === failedBound.qaRun.inputVersionId)!;
      const failedSource = failedInput.sourceCandidates.find((item) => item.candidateIndex === 1)!;
      await failedValue.service.s2.repairCandidate(failedValue.projectId, failedBound.qaRun.id, failedSource.candidateId, failedBound.qaRun.inputVersionId, randomUUID(), randomUUID());
      await waitFor(() => failedValue.repository.state().s2Repairs.find((item) => item.candidateId === failedSource.candidateId)?.status, (status) => status === "failed");
      const failedState = failedValue.service.s3.getState(failedValue.projectId);
      assert.deepEqual(failedState.screenedCandidates.find((item) => item.candidateIndex === 1)!.repairedSourceIds, []);
      recordS3ClaimProof({ testId: "SOURCE-001", variantId: "failed-reject", expectedResult: "A failed S2 repair cannot create an eligible repaired source.", actualResult: "The repair status was failed and candidate 1 exposed no repairedSourceIds.", provingTest: proofTest, observationFacts: facts("SOURCE-001:failed-reject", "repairStatus=failed", "repairedSourcePresent=false") });
    } finally {
      cleanup(failedValue);
    }
  } finally {
    cleanup(value);
  }
});

test("S3 compiler and provider requests preserve exact deterministic identities", async () => {
  const ids = { projectId: randomUUID(), generationSetId: randomUUID(), selectionStateId: randomUUID(), sourceSnapshotId: randomUUID(), baseRevisionId: randomUUID(), assetId: randomUUID() };
  const context: any = {
    ...ids,
    confirmedBriefVersionId: randomUUID(), confirmedBriefContentHash: "a".repeat(64), s2InputVersionId: randomUUID(), s2InputBindingHash: "b".repeat(64),
    geometrySnapshot: { widthMm: 9000, depthMm: 6000, openSides: ["north"], maxHeightMm: null }, geometryHash: "c".repeat(64),
    canonicalRequirements: [], requirementHash: "d".repeat(64), designRuleSnapshot: [], sourceBindingHash: "e".repeat(64), baseSelectionVersion: 1,
    baseAsset: { assetKind: "s1_concept_asset", assetId: ids.assetId, sha256: "f".repeat(64), byteSize: 10, width: 1, height: 1, pixelCount: 1 }, intentText: "  e\u0301  ",
  };
  const compiled = compileS3Refinement(context);
  assert.equal(compiled.canonicalInput.intentText, "é");
  assert.equal(compiled.promptHash, sha256(Buffer.from(compiled.promptText, "utf8")));
  assert.equal(compiled.promptText.endsWith("\n"), true);
  assert.equal(compiled.promptText.includes("\r"), false);
  assert.equal(renderS3RefinementPrompt(compiled.canonicalInput), compiled.promptText);
  const assessment = compileS3Assessment({
    projectId: ids.projectId, generationSetId: ids.generationSetId, revisionId: randomUUID(), sourceSnapshotId: ids.sourceSnapshotId,
    outputAssetId: randomUUID(), outputSha256: "1".repeat(64), outputByteSize: 123, outputWidth: 1536, outputHeight: 1024, outputPixelCount: 1_572_864,
    s2InputVersionId: randomUUID(), confirmedBriefVersionId: randomUUID(), confirmedBriefContentHash: "2".repeat(64), geometrySnapshot: context.geometrySnapshot,
    geometryHash: "3".repeat(64), canonicalRequirements: [], requirementHash: "4".repeat(64), designRuleSnapshot: [], designRuleSnapshotHash: "5".repeat(64),
    sourceBindingHash: "6".repeat(64), intentHash: "7".repeat(64), refinementInputHash: "8".repeat(64),
  });
  assert.equal(assessment.assessmentPromptHash, sha256(Buffer.from(renderS3AssessmentPrompt(assessment.canonicalInput), "utf8")));
  assert.equal(S3_ASSESSMENT_JSON_SCHEMA.additionalProperties, false);
  const imageRequest = buildS3ImageRequest({ promptText: compiled.promptText, sourceBytes: ONE_PIXEL_PNG });
  assert.deepEqual({ endpoint: imageRequest.endpoint, model: imageRequest.model, n: imageRequest.n, size: imageRequest.size, quality: imageRequest.quality, output_format: imageRequest.output_format, inputCount: imageRequest.inputImages.length }, { endpoint: "/v1/images/edits", model: "gpt-image-2-2026-04-21", n: 1, size: "1536x1024", quality: "medium", output_format: "png", inputCount: 1 });
  const assessmentRequest = buildS3AssessmentRequest({ promptText: assessment.promptText, outputBytes: ONE_PIXEL_PNG });
  assert.deepEqual({ endpoint: assessmentRequest.endpoint, model: assessmentRequest.model, store: assessmentRequest.store, name: assessmentRequest.text.format.name, strict: assessmentRequest.text.format.strict, detail: assessmentRequest.input[0].content[1].detail }, { endpoint: "/v1/responses", model: "gpt-5.4-mini-2026-03-17", store: false, name: "s3_assessment_v1", strict: true, detail: "high" });
  const exact = await createExactS3FixturePng();
  const media = await inspectExactS3Png(exact);
  assert.deepEqual({ width: media.width, height: media.height, pixelCount: media.pixelCount, decodedRgbaBytes: media.decodedRgbaBytes }, { width: 1536, height: 1024, pixelCount: 1_572_864, decodedRgbaBytes: 6_291_456 });
  assert.equal(jcs({ promptHash: compiled.promptHash }), "{\"promptHash\":\"" + compiled.promptHash + "\"}");
});

test("S3 selection, publication, assessment, activation, preview and immutable state work end to end", async () => {
  const value = fixture();
  try {
    const selected = await ready(value);
    const admitted = value.service.s3.refine(value.projectId, selected.sourceRevisionId, selected.selectionVersion, "  make it warmer  ", randomUUID(), randomUUID());
    assert.equal(admitted.result.cycleNumber, 1);
    const finalState = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.successfulRefinementCount === 1);
    assert.equal(finalState.cycleSlotsConsumed, 1);
    assert.equal(finalState.cycleSlotsRemaining, 1);
    assert.equal(finalState.cycles[0].status, "usable_pass");
    assert.equal(finalState.revisions.length, 2);
    assert.equal(finalState.revisions[1].active, true);
    const detail = value.service.s3.getRevision(value.projectId, finalState.activeRevisionId!);
    assert.equal(detail.revision.assessmentStatus, "PASS");
    assert.equal(detail.revision.usable, true);
    const preview = await value.service.s3.getPreview(value.projectId, finalState.activeRevisionId!);
    assert.equal(preview.contentLength, preview.bytes.byteLength);
    assert.equal(value.provider.s3ImageCalls, 1);
    assert.equal(value.provider.s3AssessmentCalls, 1);
    const state = value.repository.state();
    assert.equal(state.s3Sources.length, 1);
    assert.equal(state.s3Revisions.length, 2);
    assert.equal(state.s3Cycles.length, 1);
    assert.equal(state.s3ImageOperations.length, 1);
    assert.equal(state.s3Assessments.length, 1);
    assert.equal(state.s3AssessmentAttempts.length, 1);
    assert.equal(state.s3Publications[0].state, "committed");
    assert.ok(state.s3Transitions.some((item) => item.from === "image_running" && item.to === "publication_pending"));
    assert.ok(state.s3Transitions.some((item) => item.from === "publication_pending" && item.to === "assessment_pending"));
    const serialized = JSON.stringify(finalState);
    assert.equal(serialized.includes("storageKey"), false);
    assert.equal(serialized.includes("promptHash"), false);
    assert.equal(serialized.includes("providerMetadata"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, "s3States"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, "s3Activations"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, "s3Idempotency"), false);
  } finally { cleanup(value); }
});

test("S3 permits exactly two lifetime cycles and keeps rollback from creating a branch", async () => {
  const value = fixture();
  try {
    const selected = await ready(value);
    const first = value.service.s3.refine(value.projectId, selected.sourceRevisionId, selected.selectionVersion, "first bounded preference", randomUUID(), randomUUID());
    const afterFirst = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.successfulRefinementCount === 1);
    const second = value.service.s3.refine(value.projectId, afterFirst.activeRevisionId!, afterFirst.selectionVersion, "second bounded preference", randomUUID(), randomUUID());
    const afterSecond = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.successfulRefinementCount === 2);
    assert.equal(afterSecond.cycles.length, 2);
    assert.equal(afterSecond.cycles[0].baseRevisionId, selected.sourceRevisionId);
    assert.equal(afterSecond.cycles[1].baseRevisionId, afterFirst.activeRevisionId);
    assert.equal(afterSecond.cycleSlotsRemaining, 0);
    assert.equal(afterSecond.revisions.length, 3);
    assert.equal(afterSecond.revisions[2].parentRevisionId, afterFirst.activeRevisionId);
    assert.throws(() => value.service.s3.refine(value.projectId, afterSecond.activeRevisionId!, afterSecond.selectionVersion, "third preference", randomUUID(), randomUUID()), (error: unknown) => error instanceof AppError && error.code === "S3_REFINEMENT_BUDGET_EXHAUSTED");
    const rollback = value.service.s3.selectSource(value.projectId, "revision", afterFirst.revisions[1].revisionId, afterSecond.selectionVersion, randomUUID(), randomUUID());
    assert.equal(rollback.result.eventKind, "rollback");
    assert.equal(rollback.result.activeRevisionId, afterFirst.revisions[1].revisionId);
    assert.throws(() => value.service.s3.refine(value.projectId, afterFirst.revisions[1].revisionId, rollback.result.selectionVersion, "branch must be rejected", randomUUID(), randomUUID()), (error: unknown) => error instanceof AppError && error.code === "S3_LINEAGE_CONFLICT");
    assert.equal(second.result.cycleNumber, 2);
  } finally { cleanup(value); }
});

test("S3 material assessment is durable history and never activates", async () => {
  const provider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input) });
  provider.options.onS3AssessmentRequest = (input, index) => {
    provider.options.s3AssessmentResponses ??= [];
    provider.options.s3AssessmentResponses[index] = {
      requirements: (input.requirements ?? []).map((item) => ({ requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount, observed: item.expected === "absent" ? "present" : "absent", observedCount: null, confidence: 0.99, evidence: "material fixture contradiction" })),
      designRules: (input.designRules ?? []).filter((item) => item.applicability === "applicable").map((item) => ({ ruleId: item.ruleId, observed: "non_compliant", confidence: 0.99, evidence: "material fixture contradiction" })),
    };
  };
  const value = fixture({ provider });
  try {
    const selected = await ready(value);
    const admission = value.service.s3.refine(value.projectId, selected.sourceRevisionId, selected.selectionVersion, "material assessment fixture", randomUUID(), randomUUID());
    const state = await waitFor(() => value.service.s3.getState(value.projectId), (current) => current.cycles[0]?.status === "material_fail");
    assert.equal(state.activeRevisionId, selected.sourceRevisionId);
    assert.equal(state.revisions.find((item) => item.revisionId !== selected.sourceRevisionId)?.usable, false);
    assert.equal(value.repository.state().s3Assessments[0].status, "material_fail");
    assert.equal(admission.result.cycleNumber, 1);
  } finally { cleanup(value); }
});

test("S3 retries are separately bounded and assessment retry reuses the exact output without image redispatch", async () => {
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => qaPayload(input),
    s3ImageFailures: new Map([[0, "PROVIDER_TIMEOUT"]]),
    s3AssessmentResponses: [new ProviderFailure("PROVIDER_TIMEOUT")],
  });
  const value = fixture({ provider });
  try {
    const selected = await ready(value);
    const first = value.service.s3.refine(value.projectId, selected.sourceRevisionId, selected.selectionVersion, "bounded retry fixture", randomUUID(), randomUUID());
    const failedImage = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.cycles[0]?.status === "image_retry_available");
    const retry = value.service.s3.imageRetry(value.projectId, first.result.cycleId, randomUUID(), randomUUID());
    assert.equal(retry.result.status, "generating");
    const assessmentWaiting = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.cycles[0]?.status === "assessment_retry_available");
    assert.equal(assessmentWaiting.cycles[0].imageRetryAvailable, false);
    assert.equal(provider.s3ImageCalls, 2);
    const persistedBefore = value.repository.state();
    const assessmentBefore = persistedBefore.s3Assessments[0];
    const attemptOneBefore = persistedBefore.s3AssessmentAttempts[0];
    const assessmentRetry = value.service.s3.assessmentRetry(value.projectId, first.result.cycleId, randomUUID(), randomUUID());
    assert.equal(assessmentRetry.result.status, "assessment_pending");
    const completed = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.successfulRefinementCount === 1);
    assert.equal(completed.cycles[0].status, "usable_pass");
    assert.equal(provider.s3ImageCalls, 2);
    assert.equal(provider.s3AssessmentCalls, 2);
    const persistedAfter = value.repository.state();
    assert.equal(persistedAfter.s3ImageOperations.length, 2);
    assert.equal(persistedAfter.s3AssessmentAttempts.length, 2);
    assert.equal(persistedAfter.s3AssessmentAttempts[1].retryOfAttemptId, attemptOneBefore.assessmentAttemptId);
    assert.equal(persistedAfter.s3AssessmentAttempts[1].outputAssetId, attemptOneBefore.outputAssetId);
    assert.equal(persistedAfter.s3AssessmentAttempts[1].outputSha256, attemptOneBefore.outputSha256);
    assert.equal(persistedAfter.s3Assessments[0].assessmentInputHash, assessmentBefore.assessmentInputHash);
    assert.equal(failedImage.cycles[0].cycleNumber, 1);
  } finally { cleanup(value); }
});

test("S3 exact media rejection is not rescued by transformation and failed image still consumes its cycle", async () => {
  const malformed = Buffer.from("not-a-png");
  const provider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input), s3ImageResponses: [ONE_PIXEL_PNG, malformed] });
  const value = fixture({ provider });
  try {
    const selected = await ready(value);
    const admission = value.service.s3.refine(value.projectId, selected.sourceRevisionId, selected.selectionVersion, "keep the whole concept", randomUUID(), randomUUID());
    const failed = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.cycles[0]?.status === "image_retry_available");
    assert.equal(failed.cycleSlotsConsumed, 1);
    value.service.s3.imageRetry(value.projectId, admission.result.cycleId, randomUUID(), randomUUID());
    const terminal = await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.cycles[0]?.status === "image_failed");
    assert.equal(terminal.cycleSlotsConsumed, 1);
    assert.equal(terminal.activeRevisionId, selected.sourceRevisionId);
    assert.equal(value.provider.s3ImageCalls, 2);
    assert.equal(value.provider.s3AssessmentCalls, 0);
  } finally { cleanup(value); }
});

test("S3 API authorizes before service construction and exposes only the exact route/request surface", async () => {
  const value = fixture();
  try {
    await ready(value);
    const calls: string[] = [];
    const dependencies: ApiRequestDependencies = {
      workflowService: value.service,
      s3Authorization: {
        resolveContext: async () => { calls.push("context"); return { subjectId: "synthetic-test-subject" }; },
        authorizeProject: async (_context, projectId) => { calls.push("authorize:" + projectId); return projectId === value.projectId; },
      },
    };
    const get = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s3"], dependencies);
    assert.equal(get.status, 200);
    assert.deepEqual(calls, ["context", "authorize:" + value.projectId]);
    const body = await get.json() as any;
    assert.ok(body.screenedCandidates);
    const source = body.sources[0];
    const selectionKey = randomUUID();
    const selection = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": selectionKey }, body: JSON.stringify({ targetKind: "source_root", targetId: source.sourceRevisionId, expectedSelectionVersion: body.selectionVersion }) }), ["projects", value.projectId, "s3", "selection"], dependencies);
    assert.equal(selection.status, 200);
    const retryBody = new Request("http://localhost", { method: "POST", headers: { "Idempotency-Key": randomUUID(), "content-type": "application/json" }, body: "{}" });
    const retry = await handleApiRequest(retryBody, ["projects", value.projectId, "s3", "refinements", randomUUID(), "assessment-retry"], dependencies);
    assert.equal(retry.status, 400);
    const malformed = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", "not-a-uuid", "s3"], dependencies);
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json() as any).error.code, "PROJECT_NOT_FOUND");
    const denied = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s3"], { workflowService: value.service, s3Authorization: { resolveContext: () => null, authorizeProject: () => true } });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as any).error.code, "PROJECT_NOT_FOUND");
  } finally { cleanup(value); }
});

test("S3 fixed evidence manifest derives 22 rows and 189 unique claims", () => {
  const manifest = deriveClaimManifest();
  assert.equal(manifest.rowCount, 22);
  assert.equal(manifest.claimCount, 189);
  assert.equal(new Set(manifest.claims.map((claim) => claim.claimId)).size, 189);
  assert.match(manifest.claims[0].normativeRowText, /StoreState/);
  const emptyComparison = compareClaimProofs(manifest, []);
  assert.equal(emptyComparison.missingClaims, 189);
  assert.equal(emptyComparison.unknownClaims, 0);
  assert.equal(emptyComparison.duplicateClaims, 0);
  assert.equal(emptyComparison.skippedClaims, 0);
  assert.equal(manifest.claims[0].claimId, "MODEL-001:defaults");
  assert.equal(manifest.claims.at(-1)?.claimId, "REG-001:stale-head-reject");
});

test("S3 production authorization is closed by default and no provider call is made", async () => {
  const value = fixture();
  try {
    const response = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s3"]);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as any).error.code, "PROJECT_NOT_FOUND");
    assert.equal(value.provider.s3ImageCalls, 0);
    assert.equal(value.provider.s3AssessmentCalls, 0);
  } finally { cleanup(value); }
});
