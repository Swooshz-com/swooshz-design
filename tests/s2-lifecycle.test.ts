import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockOpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { deriveSourceQaLifecycle } from "../src/lib/s2-lifecycle";
import { cloneJson, sha256 } from "../src/lib/utils";
import type { BoothGeometry, ProviderMetadata, S2QaRun } from "../src/lib/types";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function briefData(): any {
  return {
    projectFacts: { clientName: "Lifecycle Fixture", eventName: "Lifecycle Event", venueName: "Synthetic Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "Lifecycle Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null },
    unknowns: [],
    assumptions: [],
    freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function qaPayload(input: any): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId,
      expected: item.expected,
      expectedCount: item.expectedCount,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99,
      evidence: "execution-bound local provider fixture",
    })),
    designRules: input.designRules.map((item: any) => ({
      ruleId: item.ruleId,
      observed: "compliant",
      confidence: 0.99,
      evidence: "execution-bound local provider fixture",
    })),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

type LifecycleFixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  provider: MockOpenAIProvider;
  projectId: string;
  generationSetId: string;
};

type FixtureOptions = Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onProviderDispatchPhase"> & {
  provider?: MockOpenAIProvider;
};

function qaRunOf(value: unknown): S2QaRun {
  if (!value || typeof value !== "object" || !("qaRun" in value)) throw new Error("missing QA run view");
  return (value as { qaRun: unknown }).qaRun as S2QaRun;
}

function lifecycleFixture(options: FixtureOptions = {}): LifecycleFixture {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s2-lifecycle-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const briefVersionId = randomUUID();
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  const data = briefData();
  const source = ONE_PIXEL_PNG;
  const sourceHash = sha256(source);
  const provider = options.provider ?? new MockOpenAIProvider({
    briefData: data,
    s2QaResponseFactory: (input) => qaPayload(input),
  });
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID();
    const assetId = randomUUID();
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    objects.put(storageKey, source);
    conceptAssets.push({
      assetId, projectId, generationSetId, storageKey, mimeType: "image/png",
      byteSize: source.byteLength, sha256: sourceHash, status: "stored", createdAt: new Date(0).toISOString(),
    });
    candidates.push({
      candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index,
      directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: new Date(0).toISOString() },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
    });
  }
  const metadata: ProviderMetadata = {
    provider: "openai", api: "responses", model: "gpt-5.4-mini",
    modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null,
    inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString(),
  };
  repository.transact((state) => {
    state.projects.push({
      projectId, name: "Lifecycle fixture", status: "concepts_ready", boothGeometry: geometry,
      briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId,
      activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
    state.briefVersions.push({
      briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(),
      versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry,
      data, contentHash: sourceHash, confirmationMode: "explicit_user_action",
      confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata,
    });
    state.generationSets.push({
      generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(),
      attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4,
      promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai",
      imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(), failureCode: null,
    });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });
  const service = createWorkflowService({
    repository,
    objects,
    provider,
    ...options,
  });
  return { root, repository, objects, service, provider, projectId, generationSetId };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("lifecycle fixture timed out");
}

async function bindAndComplete(fixture: LifecycleFixture): Promise<{ runId: string; inputVersionId: string; completedAt: string }> {
  fixture.service.s2.getReferenceDraft(fixture.projectId);
  const bound = await fixture.service.s2.bindQa(
    fixture.projectId,
    fixture.generationSetId,
    1,
    randomUUID(),
    randomUUID(),
  );
  const completed = await waitFor(
    () => qaRunOf(fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id)),
    (value) => value.status === "completed",
  );
  assert.ok(completed.completedAt);
  return { runId: bound.qaRun.id, inputVersionId: bound.inputVersionId, completedAt: completed.completedAt };
}

function sourceResult(index: number, status: any = "queued", attempt: 1 | 2 = 1): any {
  return {
    id: randomUUID(), qaRunId: randomUUID(), inputVersionId: randomUUID(), candidateId: randomUUID(),
    candidateIndex: index, attempt, sourceAssetId: randomUUID(), sourceByteSize: 1,
    sourceSha256: "a".repeat(64), status, verdict: status === "pass" ? "PASS" : "QA_UNAVAILABLE",
    requirementObservations: [], designObservations: [], materialFindingIds: [],
    warningFindingIds: [], uncertainFindingIds: [], providerRequestId: null,
    repairAttemptId: null, startedAt: status === "queued" ? null : "2026-08-27T00:00:00.000Z",
    completedAt: ["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(status)
      ? "2026-08-27T00:01:00.000Z" : null,
  };
}

test("source-QA lifecycle pure matrix is monotonic and counts latest attempts only", () => {
  const pristine = [1, 2, 3, 4].map((index) => sourceResult(index));
  const queued = deriveSourceQaLifecycle(pristine, { startedAt: null, completedAt: null }, "2026-08-27T00:00:00.000Z");
  assert.equal(queued.status, "queued");
  assert.equal(queued.startedAt, null);
  assert.equal(queued.completedAt, null);
  assert.equal(queued.completedCandidateCount, 0);

  const partial = pristine.map((item, index) => index === 0 ? { ...item, status: "pass", verdict: "PASS", startedAt: "2026-08-27T00:00:00.000Z", completedAt: "2026-08-27T00:01:00.000Z" } : item);
  const running = deriveSourceQaLifecycle(partial, { startedAt: "2026-08-27T00:00:00.000Z", completedAt: null }, "2026-08-27T00:02:00.000Z");
  assert.equal(running.status, "running");
  assert.equal(running.startedAt, "2026-08-27T00:00:00.000Z");
  assert.equal(running.completedAt, null);
  assert.equal(running.completedCandidateCount, 1);

  const retryQueued = [...partial, { ...sourceResult(1, "queued", 2), candidateId: partial[0].candidateId, qaRunId: partial[0].qaRunId, inputVersionId: partial[0].inputVersionId, sourceAssetId: partial[0].sourceAssetId, sourceSha256: partial[0].sourceSha256 }];
  const retryProjection = deriveSourceQaLifecycle(retryQueued, { startedAt: running.startedAt, completedAt: "2026-08-27T00:01:00.000Z" }, "2026-08-27T00:03:00.000Z");
  assert.equal(retryProjection.status, "running");
  assert.equal(retryProjection.startedAt, running.startedAt);
  assert.equal(retryProjection.completedAt, null);
  assert.equal(retryProjection.latest.find((item) => item.candidateIndex === 1)?.attempt, 2);

  const allTerminal = [1, 2, 3, 4].map((index) => sourceResult(index, index === 1 ? "pass" : "warning"));
  const completed = deriveSourceQaLifecycle(allTerminal, { startedAt: "2026-08-27T00:00:00.000Z", completedAt: null }, "2026-08-27T00:05:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAt, "2026-08-27T00:05:00.000Z");
  const preserved = deriveSourceQaLifecycle(allTerminal, { startedAt: completed.startedAt, completedAt: completed.completedAt }, "2026-08-27T00:06:00.000Z");
  assert.equal(preserved.completedAt, completed.completedAt);
});

test("real explicit retry remains running, never queued, then completes and reloads identically", async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  let candidateTwoAttempts = 0;
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => qaPayload(input),
  });
  const originalRunQa = provider.runS2Qa.bind(provider);
  (provider as any).runS2Qa = async (input: any) => {
    if (input.candidateIndex === 2) {
      candidateTwoAttempts += 1;
      if (candidateTwoAttempts === 1) throw new ProviderFailure("PROVIDER_TIMEOUT");
      entered.resolve();
      await gate.promise;
      return { payload: qaPayload(input), providerRequestId: "retry-in-flight" };
    }
    return originalRunQa(input);
  };
  const fixture = lifecycleFixture({ provider });
  try {
    const initial = await bindAndComplete(fixture);
    const originalStartedAt = fixture.repository.state().s2QaRuns[0].startedAt;
    const originalCompletedAt = initial.completedAt;
    const candidateId = fixture.repository.state().s2QaRuns[0].candidateResults.find((item) => item.candidateIndex === 2)!.candidateId;
    const retried = await fixture.service.s2.retryQa(fixture.projectId, initial.runId, candidateId, randomUUID(), randomUUID());
    assert.equal(retried.replayed, false);
    await entered.promise;
    const observed: string[] = [qaRunOf(retried).status];
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      observed.push(qaRunOf(fixture.service.s2.getQaRun(fixture.projectId, initial.runId)).status);
    }
    assert.equal(observed.every((status) => status !== "queued"), true);
    const inFlight = qaRunOf(fixture.service.s2.getQaRun(fixture.projectId, initial.runId));
    assert.equal(inFlight.status, "running");
    assert.equal(inFlight.startedAt, originalStartedAt);
    assert.equal(inFlight.completedAt, null);
    gate.resolve();
    const completed = await waitFor(
      () => qaRunOf(fixture.service.s2.getQaRun(fixture.projectId, initial.runId)),
      (run) => run.status === "completed",
    );
    assert.equal(completed.completedAt !== null, true);
    assert.notEqual(completed.completedAt, originalCompletedAt);
    const reloadedRepository = new JsonRepository(fixture.root);
    const reloaded = createWorkflowService({
      repository: reloadedRepository,
      objects: new PrivateObjectStore(join(fixture.root, "objects")),
      provider: new MockOpenAIProvider({ briefData: briefData() }),
      processId: 8122,
      isProcessAlive: () => true,
    });
    assert.deepEqual(reloaded.s2.getQaRun(fixture.projectId, initial.runId), fixture.service.s2.getQaRun(fixture.projectId, initial.runId));
  } finally {
    gate.resolve();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real dead-owner source-QA recovery requeues safely without queued run regression", async () => {
  const recoveryGate = deferred<void>();
  const recoveryEntered = deferred<void>();
  let candidateTwoProviderCalls = 0;
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => qaPayload(input),
  });
  const originalRunQa = provider.runS2Qa.bind(provider);
  (provider as any).runS2Qa = async (input: any) => {
    if (input.candidateIndex === 2) {
      candidateTwoProviderCalls += 1;
      recoveryEntered.resolve();
      await recoveryGate.promise;
      return { payload: qaPayload(input), providerRequestId: "recovered-source-call" };
    }
    return originalRunQa(input);
  };
  const base = lifecycleFixture({
    provider,
    processId: 7101,
    isProcessAlive: () => true,
  });
  const candidateTwoId = base.repository.state().candidates.find((item) => item.candidateIndex === 2)!.candidateId;
  const candidateThreeId = base.repository.state().candidates.find((item) => item.candidateIndex === 3)!.candidateId;
  const candidateFourId = base.repository.state().candidates.find((item) => item.candidateIndex === 4)!.candidateId;
  let interrupted = 0;
  (base.service.s2 as any).onProviderDispatchPhase = (phase: string, operation: any) => {
    if (phase === "before-dispatch" && [candidateTwoId, candidateThreeId, candidateFourId].includes(operation.candidateId)) {
      interrupted += 1;
      return "interrupt";
    }
    return undefined;
  };
  try {
    base.service.s2.getReferenceDraft(base.projectId);
    const bound = await base.service.s2.bindQa(base.projectId, base.generationSetId, 1, randomUUID(), randomUUID());
    const blocked = await waitFor(
      () => base.repository.state(),
      (state) => {
        const run = state.s2QaRuns[0];
        const op = state.s2Operations.find((item) => item.phase === "qa" && item.candidateId === candidateTwoId);
        const candidateOne = run?.candidateResults.find((item) => item.candidateIndex === 1);
        return Boolean(run && op && op.status === "running" && op.providerDispatchState === "not_started" &&
          candidateOne && ["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidateOne.status));
      },
    );
    const beforeRecovery = blocked.s2QaRuns[0];
    const originalStartedAt = beforeRecovery.startedAt;
    assert.equal(beforeRecovery.status, "running");
    assert.equal(beforeRecovery.completedAt, null);
    assert.equal(beforeRecovery.completedCandidateCount, 1);
    assert.equal(interrupted >= 3, true);

    // Leave one dead-owner running operation and two genuinely queued source operations.
    base.repository.transact((state) => {
      for (const candidateId of [candidateThreeId, candidateFourId]) {
        const operation = state.s2Operations.find((item) => item.phase === "qa" && item.candidateId === candidateId)!;
        (base.service.s2 as any).requeueUnstartedOperation(state, operation);
      }
    });
    const persistedGap = new JsonRepository(base.root).state();
    const gapRun = persistedGap.s2QaRuns[0];
    assert.equal(gapRun.status, "running");
    assert.equal(gapRun.startedAt, originalStartedAt);
    assert.equal(gapRun.completedAt, null);
    assert.equal(gapRun.completedCandidateCount, 1);
    assert.equal(gapRun.candidateResults.filter((item) => item.status === "queued").length, 2);

    const recovered = createWorkflowService({
      repository: new JsonRepository(base.root),
      objects: new PrivateObjectStore(join(base.root, "objects")),
      provider,
      processId: 7202,
      isProcessAlive: (processId) => processId !== 7101,
    });
    await recoveryEntered.promise;
    const duringRecovery = qaRunOf(recovered.s2.getQaRun(base.projectId, bound.qaRun.id));
    assert.equal(duringRecovery.status !== "queued", true);
    assert.equal(duringRecovery.status, "running");
    assert.equal(duringRecovery.startedAt, originalStartedAt);
    assert.equal(duringRecovery.completedAt, null);
    assert.equal(duringRecovery.completedCandidateCount >= 1, true);
    recoveryGate.resolve();
    const done = await waitFor(
      () => qaRunOf(recovered.s2.getQaRun(base.projectId, bound.qaRun.id)),
      (run) => run.status === "completed",
    );
    assert.equal(done.completedAt !== null, true);
    assert.equal(candidateTwoProviderCalls, 1);
    const calls = provider.options.s2QaResponseFactory ? candidateTwoProviderCalls : 0;
    assert.equal(calls, 1);
    const reloaded = new JsonRepository(base.root);
    assert.equal(reloaded.state().s2QaRuns[0].status, "completed");
  } finally {
    recoveryGate.resolve();
    rmSync(base.root, { recursive: true, force: true });
  }
});

test("persisted lifecycle validation rejects reverse tuples and accepts pristine queued state", async () => {
  const fixture = lifecycleFixture();
  try {
    fixture.service.s2.getReferenceDraft(fixture.projectId);
    const bound = await fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, 1, randomUUID(), randomUUID());
    const complete = await waitFor(
      () => qaRunOf(fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id)),
      (run) => run.status === "completed",
    );
    const valid = cloneJson(fixture.repository.state());
    const run = valid.s2QaRuns[0];
    const sourceOperations = valid.s2Operations.filter((item: any) => item.phase === "qa");
    const writeAndReject = (mutate: (state: any) => void): void => {
      const candidate = cloneJson(valid);
      mutate(candidate);
      writeFileSync(fixture.repository.statePath, JSON.stringify(candidate));
      assert.throws(() => new JsonRepository(fixture.root), (error: any) => error?.code === "PERSISTENCE_FAILED");
    };

    writeAndReject((state) => { state.s2QaRuns[0].status = "queued"; state.s2QaRuns[0].startedAt = run.startedAt; });
    writeAndReject((state) => { state.s2QaRuns[0].status = "running"; state.s2QaRuns[0].startedAt = null; state.s2QaRuns[0].completedAt = null; });
    writeAndReject((state) => { state.s2QaRuns[0].status = "running"; state.s2QaRuns[0].completedAt = run.completedAt; });
    writeAndReject((state) => { state.s2QaRuns[0].status = "completed"; state.s2QaRuns[0].completedAt = null; });
    writeAndReject((state) => { state.s2QaRuns[0].status = "completed"; state.s2QaRuns[0].candidateResults[0].status = "queued"; state.s2QaRuns[0].completedAt = run.completedAt; });
    writeAndReject((state) => { state.s2QaRuns[0].completedCandidateCount = 0; });
    assert.equal(complete.status, "completed");

    const pristine = cloneJson(valid);
    pristine.s2QaRuns[0].status = "queued";
    pristine.s2QaRuns[0].startedAt = null;
    pristine.s2QaRuns[0].completedAt = null;
    pristine.s2QaRuns[0].completedCandidateCount = 0;
    pristine.s2QaRuns[0].passCount = 0;
    pristine.s2QaRuns[0].warningCount = 0;
    pristine.s2QaRuns[0].materialFailCount = 0;
    pristine.s2QaRuns[0].unavailableCount = 0;
    pristine.s2QaRuns[0].candidateResults.forEach((result: any) => {
      result.status = "queued";
      result.verdict = "QA_UNAVAILABLE";
      result.requirementObservations = [];
      result.designObservations = [];
      result.materialFindingIds = [];
      result.warningFindingIds = [];
      result.uncertainFindingIds = [];
      result.providerRequestId = null;
      result.repairAttemptId = null;
      result.startedAt = null;
      result.completedAt = null;
    });
    for (const operation of pristine.s2Operations.filter((item: any) => item.phase === "qa")) {
      operation.status = "queued";
      operation.claimedBy = null;
      operation.claimedProcessId = null;
      operation.claimToken = null;
      operation.claimedAt = null;
      operation.startedAt = null;
      operation.completedAt = null;
      operation.providerDispatchState = "not_started";
      operation.failureCode = null;
    }
    writeFileSync(fixture.repository.statePath, JSON.stringify(pristine));
    const pristineReload = new JsonRepository(fixture.root);
    assert.equal(pristineReload.state().s2QaRuns[0].status, "queued");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
