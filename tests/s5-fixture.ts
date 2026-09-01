import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactS3FixturePng } from "../src/lib/s3-media";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { MockOpenAIProvider } from "../src/lib/openai";
import type { S4ProviderContract } from "../src/lib/s4-provider";
import type { BoothGeometry, ProviderMetadata } from "../src/lib/types";
import { jcs, sha256 } from "../src/lib/utils";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";

const AT = new Date(0).toISOString();

export function s5BriefData(): any {
  return {
    projectFacts: { clientName: "S5 Fixture Client", eventName: "S5 Fixture Event", venueName: "S5 Fixture Venue", eventLocation: "Singapore", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "S5 Fixture Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: "Welcome counter" }, { name: "Demo table", count: 2, countIsExact: true, mandatory: false, details: "Product demonstration" }],
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
      observed: item.expected === "absent" ? "absent" : "present", observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "S5 fixture observation",
    })),
    designRules: input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "S5 fixture observation",
    })),
  };
}

export type S5Fixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  projectId: string;
  generationSetId: string;
  sourceBytes: Buffer;
};

export async function createS5Fixture(options: { processId?: number; isProcessAlive?: (processId: number) => boolean; onS5PublicationPhase?: (phase: string, artifact: any) => void; s4Provider?: S4ProviderContract; s4ProviderFactory?: (repository: JsonRepository, sourceBytes: Buffer) => S4ProviderContract } = {}): Promise<S5Fixture> {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s5-g3-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const briefVersionId = randomUUID();
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 3500 };
  const sourceBytes = await createExactS3FixturePng();
  const sourceHash = sha256(sourceBytes);
  const briefData = s5BriefData();
  const briefContentHash = sha256(jcs({ schemaVersion: "brief-v1", geometrySnapshot: geometry, data: briefData }));
  const metadata: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: AT };
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID();
    const assetId = randomUUID();
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    objects.put(storageKey, sourceBytes);
    conceptAssets.push({ assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: sourceBytes.byteLength, sha256: sourceHash, status: "stored", createdAt: AT });
    candidates.push({
      candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index,
      directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: AT },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: AT },
      createdAt: AT,
    });
  }
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S5 fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: AT, updatedAt: AT });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data: briefData, contentHash: briefContentHash, confirmationMode: "explicit_user_action", confirmedAt: AT, extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: AT, completedAt: AT, failureCode: null });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });
  const provider = new MockOpenAIProvider({ briefData, s2QaResponseFactory: (input) => s2QaPayload(input) });
  const s4Provider = options.s4Provider ?? options.s4ProviderFactory?.(repository, sourceBytes);
  const service = createWorkflowService({ repository, objects, provider, s4Provider, processId: options.processId, isProcessAlive: options.isProcessAlive, onS5PublicationPhase: options.onS5PublicationPhase });
  return { root, repository, objects, service, projectId, generationSetId, sourceBytes };
}

export async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("S5 fixture timed out: " + JSON.stringify(read()));
}

export async function makeS5Ready(value: S5Fixture): Promise<{ sourceRevisionId: string; selectionVersion: number }> {
  value.service.s2.getReferenceDraft(value.projectId);
  const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
  await waitFor(() => value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");
  const before = value.service.s3.getState(value.projectId);
  const source = before.screenedCandidates.find((item) => item.originalSourceId)?.originalSourceId;
  if (!source) throw new Error("S5 fixture has no eligible S3 source");
  const selected = value.service.s3.selectSource(value.projectId, "source_root", source, 0, randomUUID(), randomUUID());
  return { sourceRevisionId: selected.result.activeRevisionId, selectionVersion: selected.result.selectionVersion };
}

export function cleanupS5Fixture(value: S5Fixture): void { rmSync(value.root, { recursive: true, force: true }); }
