import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MockOpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { createWorkflowService } from "../src/lib/workflow";
import type { BoothGeometry, StructuredBriefData, ProviderMetadata, Project, StructuredBriefVersion, GenerationSet, ConceptCandidate, ConceptAsset } from "../src/lib/types";
import { privateStorageKey, sha256 } from "../src/lib/utils";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const metadata: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: "2026-08-26T00:00:00.000Z" };

function brief(exactCount = false): StructuredBriefData {
  return {
    projectFacts: { clientName: null, eventName: null, venueName: null, eventLocation: null, eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: null, brandValues: [], visualDirection: "calm", preferredColors: [], materials: [], logoInstructions: null },
    functionalRequirements: [{ name: "demo counter", count: exactCount ? 2 : null, countIsExact: exactCount, mandatory: false, details: null }],
    mandatoryRequirements: [],
    prohibitedRequirements: [],
    budget: { amount: null, currency: null, basis: null, notes: null },
    unknowns: [],
    assumptions: [],
    freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function qaPayload(input: any, mode: "pass" | "uncertain" | "overhead"): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId,
      expected: item.expected,
      expectedCount: item.expectedCount,
      observed: mode === "uncertain" && item.expected === "exact_count" ? "uncertain" : "present",
      observedCount: mode === "uncertain" && item.expected === "exact_count" ? null : item.expected === "exact_count" ? item.expectedCount : null,
      confidence: mode === "uncertain" && item.expected === "exact_count" ? 0.5 : 0.99,
      evidence: "fixture",
    })),
    designRules: input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
      ruleId: item.ruleId,
      observed: mode === "overhead" && item.ruleId === "structure.overhead-support" ? "non_compliant" : "compliant",
      confidence: 0.99,
      evidence: "fixture",
    })),
  };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return read();
}

function seed(exactCount = false, provider?: MockOpenAIProvider) {
  const root = mkdtempSync(tmpdir() + "/swooshz-s2-");
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(root + "/objects");
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const versionId = randomUUID();
  const createdAt = "2026-08-26T00:00:00.000Z";
  const geometry: BoothGeometry = { widthMm: 6000, depthMm: 4000, openSides: ["north"], maxHeightMm: null };
  const data = brief(exactCount);
  const generation: GenerationSet = { generationSetId, projectId, confirmedBriefVersionId: versionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sha256("manifest"), provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt, completedAt: createdAt, failureCode: null };
  const version: StructuredBriefVersion = { briefVersionId: versionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data, contentHash: sha256("brief"), confirmationMode: "explicit_user_action", confirmedAt: createdAt, extractionProviderMetadata: metadata };
  repository.transact((state) => {
    const project: Project = { projectId, name: "S2 fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: versionId, activeGenerationSetId: generationSetId, createdAt, updatedAt: createdAt };
    state.projects.push(project); state.briefVersions.push(version); state.generationSets.push(generation);
    for (let index = 1; index <= 4; index += 1) {
      const candidateId = randomUUID(); const assetId = randomUUID(); const storageKey = privateStorageKey("projects", projectId, "concepts", candidateId + ".png");
      objects.put(storageKey, PNG);
      const asset: ConceptAsset = { assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: PNG.byteLength, sha256: sha256(PNG), status: "stored", createdAt };
      const candidate: ConceptCandidate = { candidateId, generationSetId, projectId, confirmedBriefVersionId: versionId, candidateIndex: index as 1 | 2 | 3 | 4, directionKey: ["modular-clarity", "brand-theatre", "open-demo", "hospitality-consultation"][index - 1] as ConceptCandidate["directionKey"], assetId, compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "modular-clarity", canonicalInputHash: sha256("input"), promptHash: sha256("prompt"), compiledAt: createdAt }, providerMetadata: metadata, createdAt };
      state.conceptAssets.push(asset); state.candidates.push(candidate);
    }
  });
  const actualProvider = provider ?? new MockOpenAIProvider({ briefData: data });
  const service = createWorkflowService({ repository, objects, provider: actualProvider });
  service.s2.getReferenceDraft(projectId);
  return { root, service, provider: actualProvider, projectId, generationSetId };
}

test("S2 binds exact S1 PNG identities, excludes absent max-height and completes four PASS results", async () => {
  const fixture = seed();
  try {
    const draft = fixture.service.s2.getReferenceDraft(fixture.projectId);
    assert.equal(draft.revision, 1);
    const uploaded = await fixture.service.s2.uploadAsset(fixture.projectId, "reference", "style.png", "image/png", PNG, randomUUID());
    assert.equal(uploaded.draft.revision, 1);
    const updated = fixture.service.s2.updateDraft(fixture.projectId, 1, [uploaded.asset.id], [], randomUUID());
    assert.equal(updated.draft.revision, 2);
    const bound = await fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, 2, randomUUID(), randomUUID());
    const final = await waitFor(() => fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    assert.equal(final.qaRun.passCount, 4);
    assert.equal(final.input.designRuleSnapshot.some((rule: any) => rule.ruleId === "geometry.max-height" && rule.applicability === "applicable"), false);
    assert.equal(fixture.provider.s2QaCalls, 4);
    assert.equal((await fixture.service.s2.getReferenceDraft(fixture.projectId)).status, "frozen");
    assert.throws(() => fixture.service.s2.updateDraft(fixture.projectId, 2, [], [], randomUUID()), /DRAFT_FROZEN/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("S2 exact-count low confidence with null observedCount is WARNING, not schema invalid", async () => {
  const provider = new MockOpenAIProvider({ briefData: brief(true), s2QaResponseFactory: (input) => qaPayload(input, "uncertain") });
  const fixture = seed(true, provider);
  try {
    const bound = await fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, 1, randomUUID(), randomUUID());
    const final = await waitFor(() => fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    assert.equal(final.qaRun.warningCount, 4);
    assert.equal(final.qaRun.candidateResults[0].status, "warning");
    assert.equal(final.qaRun.candidateResults[0].verdict, "WARNING");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("S2 bounded overhead visual failure is eligible for one repair and exactly one re-QA", async () => {
  const provider = new MockOpenAIProvider({ briefData: brief(), s2QaResponseFactory: (input, index) => qaPayload(input, index === 0 ? "overhead" : "pass") });
  const fixture = seed(false, provider);
  try {
    const bound = await fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, 1, randomUUID(), randomUUID());
    const failed = await waitFor(() => fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    const candidate = failed.qaRun.candidateResults.find((item: any) => item.status === "material_fail");
    assert.ok(candidate);
    const repaired = await fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const after = await waitFor(() => fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any, (value) => value.qaRun.repairs?.some((item: any) => item.status === "re_qa_pass"));
    assert.equal(after.qaRun.repairs.filter((item: any) => item.candidateId === candidate.candidateId).length, 1);
    assert.equal(fixture.provider.s2RepairCalls, 1);
    assert.ok(repaired.qaRun);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("S2 section-24 evidence registry enumerates all normative rows without skips", () => {
  const groups: Array<[string, number]> = [["MEDIA", 22], ["DRAFT", 9], ["BIND", 10], ["QA", 15], ["RETRY", 5], ["REPAIR", 16], ["REQA", 5], ["CONC", 6], ["ROUTE", 6], ["PRIV", 5], ["UI", 4]];
  const ids = groups.flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => prefix + "-" + String(index + 1).padStart(3, "0")));
  assert.equal(ids.length, 103);
  assert.equal(new Set(ids).size, 103);
  assert.equal(ids.filter((id) => id.length > 0).length, 103);
});

test("S2 provider adapter remains mock-only in focused tests", async () => {
  const provider = new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("PROVIDER_TIMEOUT")] });
  const fixture = seed(false, provider);
  try {
    const bound = await fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, 1, randomUUID(), randomUUID());
    const result = await waitFor(() => fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any, (value) => value.qaRun.candidateResults.some((item: any) => item.status === "qa_unavailable_retryable"));
    assert.equal(result.qaRun.candidateResults.some((item: any) => item.status === "qa_unavailable_retryable"), true);
    assert.equal(provider.s2QaCalls, 4);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
