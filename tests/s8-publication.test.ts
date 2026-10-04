import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AppError, type S6CorrectionOperation, type S8Artifact, type UUID } from "../src/lib/types";
import { readS6ToS7Handoff, S6WorkflowService } from "../src/lib/s6";
import { readS7ToS8Handoff, S7CadService } from "../src/lib/s7-cad";
import { S8ExportService } from "../src/lib/s8";
import { canonicalS8RunnerReceiptBytes, type S8RunnerEvidence } from "../src/lib/s8-fbx-worker";
import { s8Sha256 } from "../src/lib/s8-fbx-profile";
import { jcs, sha256 } from "../src/lib/utils";
import { cleanupS5Fixture } from "./s5-fixture";
import type { S8UfbxReadback } from "../src/lib/s8-fbx-semantic";
import {
  acceptProductionDraft,
  acceptedS5Fixture,
  assertProductionRequirementNegative,
  assertPreservedProductionRequirements,
  cleanupSharedS8ProofFixture,
  code,
  correctProductionDraft,
  createProductionS6Draft,
  projectId,
  rejects,
  requirementEvaluation,
  runnerEvidence,
  serviceFixture,
  sourceSnapshot,
  testDigest,
  validateProductionDraft,
} from "./s8-native-proof.test";
import type { FixtureOptions, ProductionS6Draft } from "./s8-native-proof.test";

async function assertProductionRequirementAmbiguousBlocked(
  route: ProductionS6Draft,
  requirementId: string,
  operation: S6CorrectionOperation,
): Promise<void> {
  const passingValidation = await validateProductionDraft(route, route.corrected);
  assert.equal(passingValidation.outcome === "pass" || passingValidation.outcome === "pass_with_warnings", true,
    JSON.stringify(passingValidation.errors));
  const passingModel = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === route.corrected.revisionId);
  assert.ok(passingModel);
  assert.equal(requirementEvaluation(passingModel, route.source, requirementId).outcome, "satisfied");

  const negativeRevision = await correctProductionDraft(route, route.corrected, [operation]);
  const negativeModel = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === negativeRevision.revisionId);
  assert.ok(negativeModel);
  const evaluation = requirementEvaluation(negativeModel, route.source, requirementId);
  assert.equal(evaluation.outcome, "unresolved");
  assert.ok(evaluation.issueCodes.includes("REQUIREMENT_MAPPING_INVALID"));
  assert.ok(evaluation.objectIds.length > 0);

  const validation = await validateProductionDraft(route, negativeRevision);
  assert.equal(validation.validatorVersion, "s6-validator-v2");
  assert.equal(validation.outcome, "acceptance_blocked");
  assert.ok(validation.errors.some((item) => item.requirementId === requirementId && item.code === "REQUIREMENT_MAPPING_INVALID"));
  await assert.rejects(
    () => acceptProductionDraft(route, negativeRevision),
    (error: unknown) => code(error) === "S6_GEOMETRY_INVALID",
  );

  const state = route.fixture.repository.state();
  assert.equal(state.s6AcceptanceEvents.some((item) => item.projectId === route.projectId), false);
  assert.throws(() => route.s6.getS7Handoff(route.projectId),
    (error: unknown) => code(error) === "S6_ACCEPTANCE_CONFLICT");
  assert.throws(() => readS7ToS8Handoff(state, route.fixture.objects, route.projectId),
    (error: unknown) => code(error) === "S6_ACCEPTANCE_CONFLICT");
  const s7 = new S7CadService({ repository: route.fixture.repository, objects: route.fixture.objects, s6: route.s6, ownerProcessId: "offline-s8-ambiguous-negative" });
  assert.throws(() => s7.createExport(route.projectId, "offline-ambiguous-negative", randomUUID() as UUID),
    (error: unknown) => code(error) === "S7_SOURCE_NOT_READY");
  const afterDownstreamAttempts = route.fixture.repository.state();
  assert.equal(afterDownstreamAttempts.s7CadExports?.filter((item) => item.projectId === route.projectId).length ?? 0, 0);
  assert.equal(afterDownstreamAttempts.s8Artifacts?.filter((item) => item.projectId === route.projectId).length ?? 0, 0);
}


test("S8 production publication preserves booth evidence and derives entry-clear/prohibited results from real S6 geometry", async () => {
  const route = await createProductionS6Draft();
  try {
    const model = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision;
    const modelRecord = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === route.corrected.revisionId);
    assert.ok(modelRecord, "the corrected production revision must remain in the authoritative repository");
    const preserved = assertPreservedProductionRequirements(route.source, model);
    const validation = await validateProductionDraft(route, route.corrected);
    assert.equal(validation.validatorVersion, "s6-validator-v2");
    assert.equal(validation.outcome === "pass" || validation.outcome === "pass_with_warnings", true, JSON.stringify(validation.errors));
    const entry = requirementEvaluation(modelRecord, route.source, preserved.entryRequirementId);
    assert.equal(entry.outcome, "satisfied");
    assert.equal(entry.predicateVersion, "entry-clear-v1");
    assert.deepEqual(entry.objectIds, []);
    const ceiling = requirementEvaluation(modelRecord, route.source, preserved.prohibitedRequirementId);
    assert.equal(ceiling.outcome, "satisfied");
    assert.equal(ceiling.predicateVersion, "forbidden-family-absence-v1");
    assert.deepEqual(ceiling.objectIds, []);
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S8 production route blocks a typed entry obstruction before downstream publication", async () => {
  const route = await createProductionS6Draft();
  try {
    const model = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision;
    const preserved = assertPreservedProductionRequirements(route.source, model);
    const obstructing = model.objects.find((item) => item.editable && item.removable && item.objectType !== "overhead_volume" &&
      item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
    assert.ok(obstructing, "the production draft must have a typed movable physical object");
    await assertProductionRequirementNegative(route, preserved.entryRequirementId, "ENTRY_CLEARANCE_BLOCKED", {
      kind: "move",
      objectId: obstructing.objectId,
      deltaMm: {
        xMm: 4500 - obstructing.transform.positionMm.xMm,
        yMm: 0,
        zMm: 450 - obstructing.transform.positionMm.zMm,
      },
    }, obstructing.objectId);
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S8 production route blocks an exact-count omission before downstream publication", async () => {
  const route = await createProductionS6Draft();
  try {
    const countRequirement = route.source.canonicalRequirements.find((item) => item.category === "functional" && item.expected === "exact_count" && item.expectedCount === 2);
    assert.ok(countRequirement, "the S5-confirmed exact two-table requirement must reach S6");
    const model = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision;
    const removable = model.objects.find((item) => item.removable && item.requirementIds.includes(countRequirement.requirementId));
    assert.ok(removable, "the production S6 draft must retain a typed object mapping for the exact-count requirement");
    await assertProductionRequirementNegative(route, countRequirement.requirementId, "REQUIRED_COUNT_MISMATCH", {
      kind: "remove",
      objectId: removable.objectId,
    });
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S8 production route blocks a typed prohibited overhead volume before downstream publication", async () => {
  const route = await createProductionS6Draft();
  try {
    const model = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision;
    const preserved = assertPreservedProductionRequirements(route.source, model);
    const material = model.materials[0];
    assert.ok(material, "the production model must carry a typed material for a valid correction operation");
    await assertProductionRequirementAmbiguousBlocked(route, preserved.prohibitedRequirementId, {
      kind: "add",
      objectType: "overhead_volume",
      role: "overhead",
      label: "Closed overhead ceiling",
      geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 9000, depthMm: 6000, heightMm: 100 }, localAnchor: "floor" },
      positionMm: { xMm: 0, yMm: 2400, zMm: 0 },
      rotationMd: { xMd: 0, yMd: 0, zMd: 0 },
      material,
      parentObjectId: null,
      zoneIds: [],
      requirementIds: [],
    });
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S8 production route blocks a metadata-neutral full-booth ceiling from world geometry before publication", async () => {
  const route = await createProductionS6Draft();
  try {
    const preserved = assertPreservedProductionRequirements(route.source,
      route.s6.getRevision(route.projectId, route.corrected.revisionId).revision);
    const material = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision.materials[0];
    assert.ok(material, "the production model must carry a typed material for a valid correction operation");
    await assertProductionRequirementAmbiguousBlocked(route, preserved.prohibitedRequirementId, {
      kind: "add",
      objectType: "table",
      role: "furniture",
      label: "Added rectangular object",
      geometry: {
        kind: "rect_prism",
        dimensionsMm: {
          widthMm: route.source.geometrySnapshot.widthMm,
          depthMm: route.source.geometrySnapshot.depthMm,
          heightMm: 50,
        },
        localAnchor: "floor",
      },
      positionMm: { xMm: 0, yMm: 2800, zMm: 0 },
      rotationMd: { xMd: 0, yMd: 0, zMd: 0 },
      material,
      parentObjectId: null,
      zoneIds: [],
      requirementIds: [],
    });
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S8 production route rejects an S5-reopened source after accepted S6 and committed S7", async () => {
  const route = await createProductionS6Draft();
  try {
    const model = route.s6.getRevision(route.projectId, route.corrected.revisionId).revision;
    const modelRecord = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === route.corrected.revisionId);
    assert.ok(modelRecord, "the corrected production revision must remain in the authoritative repository");
    const preserved = assertPreservedProductionRequirements(route.source, model);
    const validation = await validateProductionDraft(route, route.corrected);
    assert.equal(validation.validatorVersion, "s6-validator-v2");
    assert.equal(validation.outcome === "pass" || validation.outcome === "pass_with_warnings", true, JSON.stringify(validation.errors));
    assert.equal(requirementEvaluation(modelRecord, route.source, preserved.entryRequirementId).outcome, "satisfied");
    await acceptProductionDraft(route, route.corrected);
    const s7 = new S7CadService({ repository: route.fixture.repository, objects: route.fixture.objects, s6: route.s6, ownerProcessId: "offline-s8-stale-source" });
    const committed = s7.createExport(route.projectId, "offline-stale-source-control", randomUUID() as UUID);
    assert.equal(committed.export.status, "committed");
    const passingHandoff = readS7ToS8Handoff(route.fixture.repository.state(), route.fixture.objects, route.projectId);
    assert.equal(passingHandoff.s7ArtifactId, committed.export.artifactId);

    const exportsBeforeReopen = route.fixture.repository.state().s7CadExports?.filter((item) => item.projectId === route.projectId).length ?? 0;
    route.fixture.service.s5.reopen(route.projectId, route.fixture.service.s5.getFence(route.projectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.throws(() => route.s6.getS7Handoff(route.projectId), (error: unknown) => code(error) === "S6_SOURCE_NOT_READY");
    assert.throws(() => s7.createExport(route.projectId, "offline-stale-source-rejected", randomUUID() as UUID),
      (error: unknown) => code(error) === "S7_SOURCE_NOT_READY");
    assert.throws(() => readS7ToS8Handoff(route.fixture.repository.state(), route.fixture.objects, route.projectId),
      (error: unknown) => code(error) === "S6_SOURCE_NOT_READY");
    const afterStaleAttempts = route.fixture.repository.state();
    assert.equal(afterStaleAttempts.s7CadExports?.filter((item) => item.projectId === route.projectId).length ?? 0, exportsBeforeReopen,
      "a stale source must not produce another committed S7 export");
    assert.equal(afterStaleAttempts.s8Artifacts?.filter((item) => item.projectId === route.projectId).length ?? 0, 0,
      "a stale S5 source must stop before S8 publication authority");
  } finally {
    cleanupS5Fixture(route.fixture);
  }
});

test("S6-to-S7 reader rejects stale, non-current, unaccepted, and invalid-receipt sources", async () => {
  await sourceSnapshot();
  assert.ok(acceptedS5Fixture);
  const fixture = acceptedS5Fixture;
  const state = fixture.repository.state();
  const accepted = state.s6SpatialModels.find((item) => item.projectId === projectId && item.status === "accepted_current");
  assert.ok(accepted);
  const failsWith = (snapshot: typeof state, code: string): void => {
    assert.throws(() => readS6ToS7Handoff(snapshot, fixture.objects, projectId),
      (error: unknown) => error instanceof AppError && error.code === code);
  };

  const staleSource = structuredClone(state);
  const approval = staleSource.s5ApprovalEvents.find((item) => item.eventId === accepted.sourceS5ApprovalEventId);
  assert.ok(approval);
  staleSource.s5ApprovalEvents.push({
    ...approval,
    eventId: randomUUID() as UUID,
    eventSequence: approval.eventSequence + 1,
    priorApprovalEventId: approval.eventId,
    kind: "reopened",
    reopenReason: "user_requested",
    generationContext: null,
  });
  failsWith(staleSource, "S6_SOURCE_NOT_READY");

  const nonCurrentRevision = structuredClone(state);
  const nonCurrent = nonCurrentRevision.s6SpatialModels.find((item) => item.modelRevisionId === accepted.modelRevisionId)!;
  nonCurrent.sourceS5ApprovalEventId = randomUUID() as UUID;
  failsWith(nonCurrentRevision, "S6_SOURCE_STALE");

  const unacceptedRevision = structuredClone(state);
  unacceptedRevision.s6SpatialModels.find((item) => item.modelRevisionId === accepted.modelRevisionId)!.status = "corrected_draft";
  failsWith(unacceptedRevision, "S6_ACCEPTANCE_CONFLICT");

  const invalidReceipt = structuredClone(state);
  invalidReceipt.s6ValidationReceipts.find((item) => item.receiptId === accepted.validationReceiptId)!.validationHash = "f".repeat(64);
  failsWith(invalidReceipt, "S6_ACCEPTANCE_CONFLICT");
});

function replacePublicationReceipt(fixture: Awaited<ReturnType<typeof serviceFixture>>, artifact: S8Artifact, value: Record<string, unknown>): void {
  const bytes = Buffer.from(jcs(value), "utf8");
  const key = `${artifact.privateFinalPrefix}/publication-receipt.json`;
  fixture.objects.remove(key);
  fixture.objects.put(key, bytes);
}

test("accepted S6 source commits through S7 and completes S8 publication with verified evidence", async () => {
  const fixture = await serviceFixture();
  try {
    const first = await fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(first.export.status, "committed");
    assert.equal(first.export.publicationPhase, "commit");
    assert.equal("privateFinalPrefix" in first.export, false);
    const artifact = fixture.repository.state().s8Artifacts!.find((value: S8Artifact) => value.artifactId === first.export.artifactId)!;
    const writerAttempt = (fixture.repository.state().s8NativeOperationAttempts! as unknown as Record<string, unknown>[])
      .find((value) => value.artifactId === artifact.artifactId && value.operation === "WRITER")!;
    const acceptance = writerAttempt.acceptanceReceipt as { body: { runnerEvidenceSha256: string } };
    const signedResponse = writerAttempt.signedResponse as { body: { runnerEvidence: S8RunnerEvidence } };
    const persistedWriterEvidence = signedResponse.body.runnerEvidence;
    assert.equal(acceptance.body.runnerEvidenceSha256, sha256(jcs(persistedWriterEvidence)));
    assert.equal(persistedWriterEvidence.verifiedByCaller.schemaVersion, "s8-runner-caller-verification-v2");
    assert.equal(persistedWriterEvidence.verifiedByCaller.outerExitStatus, persistedWriterEvidence.result.code);
    assert.equal(persistedWriterEvidence.verifiedByCaller.observedStdoutBytes, persistedWriterEvidence.result.stdoutBytes);
    assert.equal(persistedWriterEvidence.verifiedByCaller.observedStderrBytes, persistedWriterEvidence.result.stderrBytes);
    assert.equal(persistedWriterEvidence.verifiedByCaller.receiptSha256, s8Sha256(canonicalS8RunnerReceiptBytes(persistedWriterEvidence)));
    const downloaded = fixture.service.download(projectId, first.export.artifactId);
    assert.equal(downloaded.bytes.length, 40);
    const replay = await fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.export.objectHashes, first.export.objectHashes);
    assert.deepEqual(replay.export, first.export);
  } finally { fixture.close(); }
});

test("S8 publication rejects every missing or malformed native caller evidence layer", async () => {
  await rejects({ omitWriterEvidence: true }, "missing-writer-evidence");
  await rejects({ omitValidatorEvidence: true }, "missing-validator-evidence");
  await rejects({ omitValidatorIdentity: true }, "missing-validator-identity", "S8_NATIVE_PROTOCOL_INVALID");

  const missingEnvelope = runnerEvidence("writer", testDigest);
  delete (missingEnvelope as unknown as Record<string, unknown>).verifiedByCaller;
  await rejects({ writerEvidence: missingEnvelope }, "missing-caller-envelope");

  const wrongSchema = runnerEvidence("writer", testDigest);
  (wrongSchema as unknown as Record<string, unknown>).schemaVersion = "s8-process-runner-receipt-v1";
  await rejects({ writerEvidence: wrongSchema }, "wrong-schema");

  const wrongPolicy = runnerEvidence("writer", testDigest);
  (wrongPolicy as unknown as Record<string, unknown>).policyId = "wrong-policy";
  await rejects({ writerEvidence: wrongPolicy }, "wrong-policy");

  const requestedMismatch = runnerEvidence("writer", testDigest);
  requestedMismatch.requested.rlimitAsBytes -= 1;
  await rejects({ writerEvidence: requestedMismatch }, "requested-mismatch");

  const childMismatch = runnerEvidence("writer", testDigest);
  childMismatch.appliedByChild.rlimitFsizeBytes -= 1;
  await rejects({ writerEvidence: childMismatch }, "child-applied-mismatch");

  const parentMismatch = runnerEvidence("validator", testDigest);
  parentMismatch.observedByRunnerParent.rlimitCpuSeconds -= 1;
  await rejects({ validatorEvidence: parentMismatch }, "parent-observed-mismatch");

  const hashMismatch = runnerEvidence("writer", "d".repeat(64));
  await rejects({ writerEvidence: hashMismatch }, "runner-reported-hash-mismatch", "S8_NATIVE_WORKER_RELEASE_MISMATCH");

  const callerHashDrift = runnerEvidence("writer", testDigest);
  callerHashDrift.verifiedByCaller.postLaunchSha256 = "e".repeat(64);
  await rejects({ writerEvidence: callerHashDrift }, "pre-post-hash-drift");

  const seccompMissing = runnerEvidence("validator", testDigest);
  (seccompMissing.appliedByChild as unknown as Record<string, unknown>).seccompMode = 0;
  await rejects({ validatorEvidence: seccompMissing }, "seccomp-missing");
});

test("initial publication rejects missing or mismatched physical provenance and root provenance", async () => {
  const baseline = await serviceFixture();
  let validReadback: S8UfbxReadback;
  try {
    const created = await baseline.service.createExport(projectId, "provenance-positive", "77777777-7777-4777-8777-777777777777");
    assert.equal(created.export.status, "committed");
    const artifact = baseline.repository.state().s8Artifacts!.find((value: S8Artifact) => value.artifactId === created.export.artifactId)!;
    validReadback = JSON.parse(baseline.objects.read(`${artifact.privateFinalPrefix}/native-readback.json`).toString("utf8")) as S8UfbxReadback;
  } finally { baseline.close(); }

  const invalidReadbacks: S8UfbxReadback[] = [];
  for (const [property, value] of [
    ["sourceObjectId", undefined], ["sourceObjectId", "wrong-source"],
    ["identityKey", undefined], ["identityKey", "wrong-identity"],
  ] as const) {
    const readback = structuredClone(validReadback!);
    const physical = readback.nodes[1]! as unknown as Record<string, unknown>;
    if (value === undefined) delete physical[property]; else physical[property] = value;
    invalidReadbacks.push(readback);
  }
  for (const property of ["sourceObjectId", "identityKey"]) {
    const readback = structuredClone(validReadback!);
    Object.defineProperty(readback.nodes[0], property, { value: null, enumerable: true, configurable: true });
    invalidReadbacks.push(readback);
  }
  for (const [index, nativeReadback] of invalidReadbacks.entries()) {
    await rejects({ nativeReadback }, `bad-provenance-${index}`, "S8_SOURCE_IDENTITY_MISMATCH");
  }
});

test("S8 download re-hashes immutable bytes before serving", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createExport(projectId, "tamper-key", "88888888-8888-4888-8888-888888888888");
    const persisted = fixture.repository.state().s8Artifacts!.find((item: S8Artifact) => item.artifactId === created.export.artifactId)!;
    const finalKey = `${persisted.privateFinalPrefix}/artifact.fbx`;
    fixture.objects.remove(finalKey);
    fixture.objects.put(finalKey, Buffer.alloc(40, 8));
    assert.throws(() => fixture.service.download(projectId, created.export.artifactId), /S8_PUBLICATION_OBJECT_MISMATCH/u);
  } finally { fixture.close(); }
});

test("S8 generic transactions reject direct status, proof, acceptance, and history mutation", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createExport(projectId, "generic-transaction-key", "88888888-8888-4888-8888-888888888888");
    const before = fixture.repository.state();
    assert.throws(() => fixture.repository.transact((state) => {
      state.s8ExportJobs![0]!.status = "failed_terminal";
      state.s8NativeProofCheckpoints![0]!.signature = "forged";
      (state.s8NativeOperationAttempts![0] as unknown as Record<string, unknown>).acceptanceReceipt = null;
      state.s8NativeTerminalOutcomes!.push({} as never);
    }), (error: unknown) => code(error) === "S8_COMMAND_REQUIRED");
    assert.deepEqual(fixture.repository.state().s8ExportJobs, before.s8ExportJobs);
    assert.deepEqual(fixture.repository.state().s8NativeProofCheckpoints, before.s8NativeProofCheckpoints);
    assert.equal(fixture.service.getExport(projectId, created.export.artifactId).status, "committed");
  } finally { fixture.close(); }
});

test("S8 recovery reclaims a proof-complete promoted object and commits through fresh evidence", async () => {
  let fixture: Awaited<ReturnType<typeof serviceFixture>> | null = null;
  let recovered = 0;
  const options: FixtureOptions = {
    onPublicationPhase: (phase) => {
      if (phase !== "verified_readback" || !fixture) return;
      const recovery = new S8ExportService({
        repository: fixture.repository, objects: fixture.objects, s6: fixture.s6, s7: fixture.s7,
        ownerId: "offline-recovery-owner", processId: 481516, isProcessAlive: () => false,
        clock: () => new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      recovered = recovery.recoverPending();
    },
  };
  fixture = await serviceFixture(options);
  try {
    await assert.rejects(fixture.service.createExport(projectId, "recovery-key", "99999999-9999-4999-8999-999999999999"),
      (error: unknown) => code(error) === "S8_CLAIM_FENCED");
    assert.equal(recovered, 1);
    const job = fixture.repository.readS8(projectId, fixture.repository.state().s8Artifacts![0]!.artifactId);
    assert.equal(job.lifecycle(), "committed");
    assert.equal(fixture.service.getExport(projectId, fixture.repository.state().s8Artifacts![0]!.artifactId).status, "committed");
    assert.equal(fixture.service.download(projectId, fixture.repository.state().s8Artifacts![0]!.artifactId).bytes.length, 40);
  } finally { fixture.close(); }
});

test.after(async () => {
  cleanupSharedS8ProofFixture();
});
