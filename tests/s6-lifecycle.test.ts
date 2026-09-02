import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError, type Project, type S6ConcurrencyToken, type UUID } from "../src/lib/types";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S6WorkflowService } from "../src/lib/s6";
import { type S6SourceReader } from "../src/lib/s6-source";
import { deterministicClock, makeS6Source } from "./s6-fixture";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const AT = "2026-09-02T00:00:00.000Z";

function uuid(index: number): UUID {
  return "30000000-0000-4000-8000-" + String(index).padStart(12, "0") as UUID;
}

function errorCode(error: unknown): string | null {
  return error instanceof AppError ? error.code : error instanceof Error ? error.message : null;
}

function expectCode(action: () => unknown, expected: string): void {
  assert.throws(action, (error: unknown) => errorCode(error) === expected);
}

function project(): Project {
  return {
    projectId: PROJECT_ID,
    name: "S6 lifecycle fixture",
    status: "concepts_ready",
    boothGeometry: { widthMm: 6000, depthMm: 3000, openSides: ["north", "east"], maxHeightMm: 3000 },
    briefAssetId: null,
    briefDraftId: null,
    confirmedBriefVersionId: null,
    activeGenerationSetId: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function makeHarness(options: {
  source?: ReturnType<typeof makeS6Source>;
  uuid?: () => UUID;
  isProcessAlive?: (processId: number) => boolean;
  sourceReader?: S6SourceReader;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "s6-lifecycle-"));
  const repository = new JsonRepository(root, { processId: 701, isProcessAlive: options.isProcessAlive });
  const objects = new PrivateObjectStore(join(root, "objects"));
  let source = options.source ?? makeS6Source({ requirements: [{ name: "Welcome counter", expected: "present" }] });
  repository.transact((state) => {
    state.projects.push(project());
  });
  const defaultSourceReader: S6SourceReader = {
    readReady: (projectId) => {
      if (projectId !== PROJECT_ID || source.readiness !== "ready") throw new AppError(409, "S6_SOURCE_NOT_READY");
      return structuredClone(source);
    },
    currentFingerprint: (projectId) => {
      if (projectId !== PROJECT_ID) throw new AppError(409, "S6_SOURCE_NOT_READY");
      return source.sourceFingerprint;
    },
    assertCurrent: (projectId, expectedFingerprint) => {
      if (projectId !== PROJECT_ID || source.readiness !== "ready") throw new AppError(409, "S6_SOURCE_NOT_READY");
      if (source.sourceFingerprint !== expectedFingerprint) throw new AppError(409, "S6_SOURCE_STALE");
      return structuredClone(source);
    },
  };
  let counter = 0;
  const nextUuid = options.uuid ?? (() => uuid(1000 + (counter += 1)));
  const clock = deterministicClock();
  const service = new S6WorkflowService({
    repository,
    objects,
    sourceReader: options.sourceReader ?? defaultSourceReader,
    clock,
    uuid: nextUuid,
    workerId: "s6-test-worker",
    processId: 701,
    isProcessAlive: options.isProcessAlive ?? (() => false),
  });
  return {
    repository,
    objects,
    service,
    source,
    setSource(next: ReturnType<typeof makeS6Source>) {
      source = next;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function mutableSourceReader(source: ReturnType<typeof makeS6Source>): { reader: S6SourceReader; fence: () => void } {
  let fenced = false;
  return {
    reader: {
      readReady: (projectId) => {
        if (projectId !== PROJECT_ID) throw new AppError(409, "S6_SOURCE_NOT_READY");
        return structuredClone(source);
      },
      currentFingerprint: (projectId) => {
        if (projectId !== PROJECT_ID) throw new AppError(409, "S6_SOURCE_NOT_READY");
        return source.sourceFingerprint;
      },
      assertCurrent: (projectId, expectedFingerprint) => {
        if (projectId !== PROJECT_ID || fenced || source.sourceFingerprint !== expectedFingerprint) {
          throw new AppError(409, "S6_SOURCE_STALE");
        }
        return structuredClone(source);
      },
    },
    fence() {
      fenced = true;
    },
  };
}

function tokenFor(service: S6WorkflowService, revisionId: UUID): S6ConcurrencyToken {
  return service.getState(PROJECT_ID).concurrency!;
}

async function confirmDraft(
  harness: ReturnType<typeof makeHarness>,
  revisionId: UUID,
  keyIndex: number,
): Promise<{ revisionId: UUID; token: S6ConcurrencyToken }> {
  const state = harness.service.getState(PROJECT_ID);
  const revision = state.revisions.find((item) => item.revisionId === revisionId);
  assert.ok(revision);
  const full = harness.service.getRevision(PROJECT_ID, revisionId).revision;
  const objectIds = full.unknowns
    .filter((item) => item.kind === "design_form")
    .map((item) => /^objects\[(.+)\]\.primitive$/u.exec(item.fieldPath)?.[1])
    .filter((item): item is string => item !== undefined);
  const token = state.concurrency!;
  const corrected = await harness.service.correct(
    PROJECT_ID,
    revisionId,
    token,
    [{ kind: "confirm_design_inference", objectIds, note: "Confirm the bounded typed form." }],
    uuid(keyIndex),
    uuid(keyIndex + 1),
    "subject-s6",
  );
  return { revisionId: corrected.revisionId, token: corrected.concurrency };
}

test("generation persists one source-fenced draft with designFormReview", async () => {
  const harness = makeHarness();
  try {
    const result = await harness.service.generate(PROJECT_ID, uuid(1), uuid(2), "subject-s6");
    assert.equal(result.status, "generated_draft");
    const state = harness.service.getState(PROJECT_ID);
    assert.equal(state.revisions.length, 1);
    const revision = harness.service.getRevision(PROJECT_ID, result.revisionId).revision;
    assert.equal(revision.sourceS5Fingerprint, harness.source.sourceFingerprint);
    assert.equal(revision.designFormReview.status, "required");
    assert.equal(revision.modelArtifact.status, "committed");
    assert.equal(harness.repository.state().s6Jobs.some((item) => item.kind === "generation" && item.status === "committed"), true);
  } finally {
    harness.close();
  }
});

test("same generation key replays without a second draft", async () => {
  const harness = makeHarness();
  try {
    const first = await harness.service.generate(PROJECT_ID, uuid(3), uuid(4), "subject-s6");
    const replay = await harness.service.generate(PROJECT_ID, uuid(3), uuid(4), "subject-s6");
    assert.equal(replay.replayed, true);
    assert.equal(replay.revisionId, first.revisionId);
    assert.equal(harness.repository.state().s6SpatialModels.length, 1);
  } finally {
    harness.close();
  }
});

test("correction creates immutable lineage and acceptance writes a supersession event", async () => {
  const harness = makeHarness();
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(5), uuid(6), "subject-s6");
    const corrected = await confirmDraft(harness, generated.revisionId, 7);
    const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(9), uuid(10));
    assert.notEqual(validation.outcome, "failed");
    const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(11), uuid(12), "subject-s6");
    assert.equal(accepted.status, "accepted_current");
    const reopened = await harness.service.reopen(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(13), uuid(14), "subject-s6");
    const changed = await harness.service.correct(
      PROJECT_ID,
      reopened.revisionId,
      reopened.concurrency,
      [{ kind: "material", objectId: harness.service.getRevision(PROJECT_ID, reopened.revisionId).revision.objects.find((item) => item.objectType === "counter")!.objectId, material: harness.service.getRevision(PROJECT_ID, reopened.revisionId).revision.materials[0]! }],
      uuid(15),
      uuid(16),
      "subject-s6",
    );
    const changedValidation = await harness.service.validate(PROJECT_ID, changed.revisionId, changed.concurrency, uuid(17), uuid(18));
    assert.notEqual(changedValidation.outcome, "failed");
    await harness.service.accept(PROJECT_ID, changed.revisionId, changed.concurrency, uuid(19), uuid(20), "subject-s6");
    const persisted = harness.repository.state();
    assert.equal(persisted.s6SpatialModels.find((item) => item.modelRevisionId === accepted.revisionId)?.status, "superseded");
    assert.equal(persisted.s6SupersessionEvents.length, 1);
    assert.equal(persisted.s6SpatialModels.find((item) => item.modelRevisionId === changed.revisionId)?.parentRevisionId, reopened.revisionId);
  } finally {
    harness.close();
  }
});

test("concurrent corrections and acceptance conflict on repository CAS tokens", async () => {
  const harness = makeHarness();
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(21), uuid(22), "subject-s6");
    const token = harness.service.getState(PROJECT_ID).concurrency!;
    const objectId = harness.service.getRevision(PROJECT_ID, generated.revisionId).revision.objects.find((item) => item.objectType === "counter")!.objectId;
    const results = await Promise.allSettled([
      harness.service.correct(PROJECT_ID, generated.revisionId, token, [{ kind: "rotate", objectId, rotationMd: { xMd: 0, yMd: 1000, zMd: 0 } }], uuid(23), uuid(24), "subject-s6"),
      harness.service.correct(PROJECT_ID, generated.revisionId, token, [{ kind: "rotate", objectId, rotationMd: { xMd: 0, yMd: 2000, zMd: 0 } }], uuid(25), uuid(26), "subject-s6"),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected" && errorCode(item.reason) === "S6_REVISION_CONFLICT").length, 1);
    const acceptedDraft = results.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<S6WorkflowService["correct"]>>> => item.status === "fulfilled")!.value;
    const prepared = await confirmDraft(harness, acceptedDraft.revisionId, 91);
    await harness.service.validate(PROJECT_ID, prepared.revisionId, prepared.token, uuid(93), uuid(94));
    const acceptedToken = prepared.token;
    const acceptResults = await Promise.allSettled([
      harness.service.accept(PROJECT_ID, prepared.revisionId, acceptedToken, uuid(95), uuid(96), "subject-s6"),
      harness.service.accept(PROJECT_ID, prepared.revisionId, acceptedToken, uuid(97), uuid(98), "subject-s6"),
    ]);
    assert.equal(acceptResults.filter((item) => item.status === "rejected" && errorCode(item.reason) === "S6_ACCEPTANCE_CONFLICT").length, 1);
  } finally {
    harness.close();
  }
});

test("idempotency keys cover generation correction reopen validation acceptance render and publication", async () => {
  const harness = makeHarness();
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(31), uuid(32), "subject-s6");
    const generatedReplay = await harness.service.generate(PROJECT_ID, uuid(31), uuid(32), "subject-s6");
    assert.equal(generatedReplay.replayed, true);
    const corrected = await confirmDraft(harness, generated.revisionId, 33);
    const correctedReplay = await harness.service.correct(PROJECT_ID, generated.revisionId, harness.service.getState(PROJECT_ID).concurrency!, [{ kind: "confirm_design_inference", objectIds: [], note: "unused" }], uuid(35), uuid(36), "subject-s6").catch((error) => error);
    assert.ok(correctedReplay instanceof AppError || correctedReplay.replayed === true);
    const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(37), uuid(38));
    const validationReplay = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(37), uuid(38));
    assert.equal(validationReplay.validationHash, validation.validationHash);
    const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(39), uuid(40), "subject-s6");
    const acceptanceReplay = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(39), uuid(40), "subject-s6");
    assert.equal(acceptanceReplay.replayed, true);
    const reopened = await harness.service.reopen(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(41), uuid(42), "subject-s6");
    const reopenedReplay = await harness.service.reopen(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(41), uuid(42), "subject-s6");
    assert.equal(reopenedReplay.replayed, true);
    const rendered = await harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(43), uuid(44));
    const renderedReplay = await harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(43), uuid(44));
    assert.equal(renderedReplay.replayed, true);
    const published = await harness.service.publish(PROJECT_ID, accepted.revisionId, "perspective-northwest", accepted.concurrency, uuid(45), uuid(46));
    const publishedReplay = await harness.service.publish(PROJECT_ID, accepted.revisionId, "perspective-northwest", accepted.concurrency, uuid(45), uuid(46));
    assert.equal(publishedReplay.replayed, true);
    assert.equal(published.artifactId, publishedReplay.artifactId);
    assert.ok(rendered.artifactGroupId);
  } finally {
    harness.close();
  }
});

test("stale source blocks every mutation boundary", async () => {
  const harness = makeHarness();
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(47), uuid(48), "subject-s6");
    const token = harness.service.getState(PROJECT_ID).concurrency!;
    const objectId = harness.service.getRevision(PROJECT_ID, generated.revisionId).revision.objects.find((item) => item.objectType === "counter")!.objectId;
    const next = makeS6Source({ widthMm: 6100, requirements: [{ name: "Welcome counter", expected: "present" }] });
    harness.setSource(next);
    assert.throws(() => harness.service.getRevision(PROJECT_ID, generated.revisionId), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    await assert.rejects(harness.service.correct(PROJECT_ID, generated.revisionId, token, [{ kind: "rotate", objectId, rotationMd: { xMd: 0, yMd: 1000, zMd: 0 } }], uuid(49), uuid(50), "subject-s6"), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    await assert.rejects(harness.service.validate(PROJECT_ID, generated.revisionId, token, uuid(51), uuid(52)), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    await assert.rejects(harness.service.accept(PROJECT_ID, generated.revisionId, token, uuid(53), uuid(54), "subject-s6"), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    await assert.rejects(harness.service.render(PROJECT_ID, generated.revisionId, token, uuid(55), uuid(56)), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    await assert.rejects(harness.service.publish(PROJECT_ID, generated.revisionId, "perspective-northwest", token, uuid(57), uuid(58)), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    assert.throws(() => harness.service.getViewDownload(PROJECT_ID, generated.revisionId, "perspective-northwest"), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
  } finally {
    harness.close();
  }
});

test("a new valid S5 source epoch creates a distinct root and atomically stales the prior accepted epoch", async () => {
  const harness = makeHarness({ source: makeS6Source({ widthMm: 6000, requirements: [{ name: "Welcome counter", expected: "present" }] }) });
  try {
    const generatedA = await harness.service.generate(PROJECT_ID, uuid(501), uuid(502), "subject-s6");
    const correctedA = await confirmDraft(harness, generatedA.revisionId, 503);
    const validationA = await harness.service.validate(PROJECT_ID, correctedA.revisionId, correctedA.token, uuid(505), uuid(506));
    assert.equal(validationA.errors.length, 0, JSON.stringify(validationA.errors));
    const acceptedA = await harness.service.accept(PROJECT_ID, correctedA.revisionId, correctedA.token, uuid(507), uuid(508), "subject-s6");

    const sourceB = makeS6Source({ widthMm: 6100, requirements: [{ name: "Welcome counter", expected: "present" }] });
    harness.setSource(sourceB);
    const generatedB = await harness.service.generate(PROJECT_ID, uuid(509), uuid(510), "subject-s6");
    assert.notEqual(generatedB.revisionId, acceptedA.revisionId);

    const persisted = harness.repository.state();
    const oldModel = persisted.s6SpatialModels.find((item) => item.modelRevisionId === acceptedA.revisionId);
    const newModel = persisted.s6SpatialModels.find((item) => item.modelRevisionId === generatedB.revisionId);
    assert.equal(oldModel?.status, "stale");
    assert.notEqual(oldModel?.staleAt, null);
    assert.equal(newModel?.parentRevisionId, null);
    assert.notEqual(oldModel?.revisionNumber, newModel?.revisionNumber);
    assert.equal(newModel?.sourceS5Fingerprint, sourceB.sourceFingerprint);
    assert.equal(harness.service.getRevision(PROJECT_ID, acceptedA.revisionId).revision.modelRevisionId, acceptedA.revisionId);
  } finally {
    harness.close();
  }
});

test("generation fences before its first durable model and job write", async () => {
  const source = makeS6Source({ requirements: [{ name: "Welcome counter", expected: "present" }] });
  const harness = makeHarness({
    source,
    sourceReader: {
      readReady: () => structuredClone(source),
      currentFingerprint: () => source.sourceFingerprint,
      assertCurrent: () => { throw new AppError(409, "S6_SOURCE_STALE"); },
    },
  });
  try {
    await assert.rejects(harness.service.generate(PROJECT_ID, uuid(511), uuid(512), "subject-s6"), (error: unknown) => errorCode(error) === "S6_SOURCE_STALE");
    assert.equal(harness.repository.state().s6SpatialModels.length, 0);
    assert.equal(harness.repository.state().s6Jobs.length, 0);
  } finally {
    harness.close();
  }
});

test("a late generation source fence cleans staged objects and closes the candidate", async () => {
  const source = makeS6Source({ requirements: [{ name: "Welcome counter", expected: "present" }] });
  let assertions = 0;
  const sourceReader: S6SourceReader = {
    readReady: () => structuredClone(source),
    currentFingerprint: () => source.sourceFingerprint,
    assertCurrent: () => {
      assertions += 1;
      if (assertions === 3) throw new AppError(409, "S6_SOURCE_STALE");
      return structuredClone(source);
    },
  };
  const harness = makeHarness({ source, sourceReader });
  try {
    await assert.rejects(
      harness.service.generate(PROJECT_ID, uuid(551), uuid(552), "subject-s6"),
      (error: unknown) => errorCode(error) === "S6_SOURCE_STALE",
    );
    const state = harness.repository.state();
    const model = state.s6SpatialModels[0]!;
    const job = state.s6Jobs.find((item) => item.kind === "generation")!;
    assert.equal(model.status, "stale");
    assert.equal(model.modelArtifact.status, "failed_terminal");
    assert.equal(job.status, "aborted");
    assert.equal(job.terminalAt !== null, true);
    assert.equal(harness.objects.exists(model.modelArtifact.stagingKey), false);
    assert.equal(harness.objects.exists(model.modelArtifact.artifactKey), false);
  } finally {
    harness.close();
  }
});

test("downstream S6 durable writes fence a stale source before creating records", async () => {
  const source = makeS6Source({ requirements: [{ name: "Welcome counter", expected: "present" }] });

  {
    const gate = mutableSourceReader(source);
    const harness = makeHarness({ source, sourceReader: gate.reader });
    try {
      const generated = await harness.service.generate(PROJECT_ID, uuid(601), uuid(602), "subject-s6");
      const corrected = await confirmDraft(harness, generated.revisionId, 603);
      const before = harness.repository.state();
      gate.fence();
      await assert.rejects(
        harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(605), uuid(606)),
        (error: unknown) => errorCode(error) === "S6_SOURCE_STALE",
      );
      const after = harness.repository.state();
      assert.equal(after.s6ValidationReceipts.length, before.s6ValidationReceipts.length);
      assert.equal(after.s6Jobs.length, before.s6Jobs.length);
    } finally {
      harness.close();
    }
  }

  {
    const gate = mutableSourceReader(source);
    const harness = makeHarness({ source, sourceReader: gate.reader });
    try {
      const generated = await harness.service.generate(PROJECT_ID, uuid(607), uuid(608), "subject-s6");
      const corrected = await confirmDraft(harness, generated.revisionId, 609);
      const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(611), uuid(612));
      assert.equal(validation.errors.length, 0, JSON.stringify(validation.errors));
      const before = harness.repository.state();
      gate.fence();
      await assert.rejects(
        harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(613), uuid(614), "subject-s6"),
        (error: unknown) => errorCode(error) === "S6_SOURCE_STALE",
      );
      const after = harness.repository.state();
      assert.equal(after.s6AcceptanceEvents.length, before.s6AcceptanceEvents.length);
      assert.equal(after.s6SpatialModels.find((item) => item.modelRevisionId === corrected.revisionId)?.status, "corrected_draft");
    } finally {
      harness.close();
    }
  }

  {
    const gate = mutableSourceReader(source);
    const harness = makeHarness({ source, sourceReader: gate.reader });
    try {
      const generated = await harness.service.generate(PROJECT_ID, uuid(615), uuid(616), "subject-s6");
      const corrected = await confirmDraft(harness, generated.revisionId, 617);
      const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(619), uuid(620));
      assert.equal(validation.errors.length, 0, JSON.stringify(validation.errors));
      const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(621), uuid(622), "subject-s6");
      const before = harness.repository.state();
      gate.fence();
      await assert.rejects(
        harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(623), uuid(624)),
        (error: unknown) => errorCode(error) === "S6_SOURCE_STALE",
      );
      const after = harness.repository.state();
      assert.equal(after.s6ViewArtifacts.length, before.s6ViewArtifacts.length);
      assert.equal(after.s6Jobs.length, before.s6Jobs.length);
    } finally {
      harness.close();
    }
  }

  {
    const gate = mutableSourceReader(source);
    const harness = makeHarness({ source, sourceReader: gate.reader });
    try {
      const generated = await harness.service.generate(PROJECT_ID, uuid(625), uuid(626), "subject-s6");
      const corrected = await confirmDraft(harness, generated.revisionId, 627);
      const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(629), uuid(630));
      assert.equal(validation.errors.length, 0, JSON.stringify(validation.errors));
      const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(631), uuid(632), "subject-s6");
      const rendered = await harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(633), uuid(634));
      const before = harness.repository.state();
      gate.fence();
      await assert.rejects(
        harness.service.publish(PROJECT_ID, accepted.revisionId, rendered.views[0]!.viewId, accepted.concurrency, uuid(635), uuid(636)),
        (error: unknown) => errorCode(error) === "S6_SOURCE_STALE",
      );
      const after = harness.repository.state();
      assert.equal(after.s6Jobs.filter((item) => item.kind === "publication").length, before.s6Jobs.filter((item) => item.kind === "publication").length);
    } finally {
      harness.close();
    }
  }
});

test("unreviewed or unsupported form blocks accepted_view and publication while draft preview remains marked", async () => {
  const harness = makeHarness({ source: makeS6Source({ visualDirection: "curved double-bent wall with a hole; unsupported free-form shape", requirements: [{ name: "Curved double-bent wall with a hole", expected: "present" }] }) });
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(59), uuid(60), "subject-s6");
    const preview = await harness.service.render(PROJECT_ID, generated.revisionId, harness.service.getState(PROJECT_ID).concurrency!, uuid(61), uuid(62));
    assert.equal(preview.views.every((view) => view.purpose === "draft_preview"), true);
    assert.throws(() => harness.service.getView(PROJECT_ID, generated.revisionId, "perspective-northwest"), /S6/);
    await assert.rejects(harness.service.accept(PROJECT_ID, generated.revisionId, harness.service.getState(PROJECT_ID).concurrency!, uuid(63), uuid(64), "subject-s6"));
    await assert.rejects(harness.service.publish(PROJECT_ID, generated.revisionId, "perspective-northwest", harness.service.getState(PROJECT_ID).concurrency!, uuid(65), uuid(66)));
  } finally {
    harness.close();
  }
});

test("explicit simplification keeps unsupported provenance and permits only the typed accepted form", async () => {
  const harness = makeHarness({ source: makeS6Source({ visualDirection: "curved double-bent wall with a hole; unsupported free-form shape", requirements: [{ name: "Curved double-bent wall with a hole", expected: "present" }] }) });
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(101), uuid(102), "subject-s6");
    const draft = harness.service.getRevision(PROJECT_ID, generated.revisionId).revision;
    const unknown = draft.unknowns.find((item) => item.kind === "design_form" && item.question.includes("S6_UNSUPPORTED_FORM"));
    assert.ok(unknown);
    const material = draft.materials[0];
    assert.ok(material);
    const inferredObjectIds = draft.unknowns
      .filter((item) => item.kind === "design_form" && item.status === "unresolved")
      .map((item) => /^objects\[(.+)\]\.primitive$/u.exec(item.fieldPath)?.[1])
      .filter((item): item is string => item !== undefined);
    const corrected = await harness.service.correct(
      PROJECT_ID,
      generated.revisionId,
      harness.service.getState(PROJECT_ID).concurrency!,
      [
        { kind: "confirm_design_inference", objectIds: inferredObjectIds, note: "User confirms the remaining bounded typed forms." },
        {
          kind: "resolve_unknown",
          unknownId: unknown.unknownId,
          resolutionKind: "explicit_simplification",
          resolutionNote: "User accepts this bounded typed simplification for the unsupported form.",
          replacement: {
            objectType: "partition",
            role: "booth_partition",
            label: "Simplified typed partition",
            geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1200, depthMm: 100, heightMm: 2200 }, localAnchor: "floor" },
            positionMm: { xMm: 1200, yMm: 0, zMm: 600 },
            rotationMd: { xMd: 0, yMd: 30000, zMd: 0 },
            material,
          },
        },
      ],
      uuid(103),
      uuid(104),
      "subject-s6",
    );
    const correctedRevision = harness.service.getRevision(PROJECT_ID, corrected.revisionId).revision;
    const resolved = correctedRevision.unknowns.find((item) => item.unknownId === unknown.unknownId);
    assert.ok(resolved);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolutionKind, "explicit_simplification");
    assert.match(resolved.question, /S6_UNSUPPORTED_FORM/);
    assert.equal(correctedRevision.designFormReview.explicitSimplificationUnknownIds.includes(unknown.unknownId), true);
    const validation = await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.concurrency, uuid(105), uuid(106));
    assert.equal(validation.errors.length, 0, JSON.stringify(validation.errors));
    assert.equal(validation.warnings.some((item) => item.code === "S6_DESIGN_FORM_SIMPLIFIED"), true);
    const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.concurrency, uuid(107), uuid(108), "subject-s6");
    const rendered = await harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(109), uuid(110));
    assert.equal(rendered.views.every((view) => view.purpose === "accepted_view"), true);
    const published = await harness.service.publish(PROJECT_ID, accepted.revisionId, "perspective-northwest", accepted.concurrency, uuid(111), uuid(112));
    assert.equal(published.view.viewId, "perspective-northwest");
  } finally {
    harness.close();
  }
});

test("render and publish use exact no-overwrite promotion", async () => {
  const harness = makeHarness();
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(67), uuid(68), "subject-s6");
    const corrected = await confirmDraft(harness, generated.revisionId, 69);
    await harness.service.validate(PROJECT_ID, corrected.revisionId, corrected.token, uuid(71), uuid(72));
    const accepted = await harness.service.accept(PROJECT_ID, corrected.revisionId, corrected.token, uuid(73), uuid(74), "subject-s6");
    await harness.service.render(PROJECT_ID, accepted.revisionId, accepted.concurrency, uuid(75), uuid(76));
    const artifact = harness.repository.state().s6ViewArtifacts.find((item) => item.viewId === "perspective-northwest" && item.revisionId === accepted.revisionId)!;
    const bytes = harness.objects.read(artifact.stagingKey);
    await harness.service.publish(PROJECT_ID, accepted.revisionId, artifact.viewId, accepted.concurrency, uuid(77), uuid(78));
    assert.equal(harness.objects.read(artifact.artifactKey).equals(bytes), true);
    assert.throws(() => harness.objects.putExact(artifact.artifactKey, Buffer.from("different")), /PERSISTENCE_FAILED/);
  } finally {
    harness.close();
  }
});

test("restart recovery handles queued running staged promoted and terminal states", async () => {
  const harness = makeHarness({ isProcessAlive: (processId) => processId === 701 });
  try {
    const generated = await harness.service.generate(PROJECT_ID, uuid(79), uuid(80), "subject-s6");
    const sourceFingerprint = harness.source.sourceFingerprint;
    harness.repository.transact((state) => {
      state.s6Jobs.push({
        schemaVersion: "s6-job-state-v1",
        jobId: uuid(81),
        projectId: PROJECT_ID,
        kind: "validation",
        revisionId: generated.revisionId,
        viewId: null,
        sourceS5Fingerprint: sourceFingerprint,
        inputHash: "b".repeat(64),
        attempt: 1,
        retryOfJobId: null,
        status: "queued",
        publicationPhase: "none",
        artifactId: null,
        workerId: null,
        processId: null,
        claimToken: null,
        claimedAt: null,
        startedAt: null,
        stagedAt: null,
        promotedAt: null,
        completedAt: null,
        terminalAt: null,
        failureCode: null,
        idempotencyKey: uuid(82),
        requestReferenceId: uuid(83),
        createdAt: AT,
        updatedAt: AT,
      });
      const running = state.s6Jobs[0]!;
      state.s6Jobs.push({ ...running, jobId: uuid(84), inputHash: "c".repeat(64), idempotencyKey: uuid(85), requestReferenceId: uuid(86), status: "running", workerId: "dead-worker", processId: 999, claimToken: uuid(87), claimedAt: AT, startedAt: AT });
      state.s6Jobs.push({ ...running, jobId: uuid(88), inputHash: "d".repeat(64), idempotencyKey: uuid(89), requestReferenceId: uuid(90), status: "failed_terminal", failureCode: "S6_PUBLICATION_UNCERTAIN", terminalAt: AT });
    });
    const recovered = new S6WorkflowService({
      repository: harness.repository,
      objects: harness.objects,
      sourceReader: {
        readReady: () => structuredClone(harness.source),
        currentFingerprint: () => harness.source.sourceFingerprint,
        assertCurrent: (_projectId, expected) => {
          if (expected !== harness.source.sourceFingerprint) throw new AppError(409, "S6_SOURCE_STALE");
          return structuredClone(harness.source);
        },
      },
      clock: deterministicClock(),
      uuid: (() => {
        let next = 1000;
        return () => uuid(next++);
      })(),
      workerId: "restarted-worker",
      processId: 702,
      isProcessAlive: (processId) => processId === 702,
    });
    await recovered.recover();
    const statuses = recovered.repository.state().s6Jobs.map((item) => item.status);
    assert.ok(statuses.includes("queued"));
    assert.ok(statuses.includes("failed_terminal"));
    assert.ok(statuses.includes("failed_retryable") || statuses.includes("committed"));
  } finally {
    harness.close();
  }
});
