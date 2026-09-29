import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { S8ExportService, type S8ExportAdapters, type S8NativeValidationResult } from "../src/lib/s8";
import { canonicalS8SourceJson } from "../src/lib/s8-fbx-payload";
import { s7FinalDxfStorageKey, s7FinalManifestStorageKey, s7StagingDxfStorageKey } from "../src/lib/s7-persistence";
import type { S8SemanticResult, S8UfbxReadback } from "../src/lib/s8-fbx-semantic";
import { canonicalS8RunnerReceiptBytes, type S8RunnerEvidence, type S8WriterResult } from "../src/lib/s8-fbx-worker";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S8_LIMITS, S8_PROCESS_RUNNER_PIN, s8Sha256, s8StableName } from "../src/lib/s8-fbx-profile";
import { jcs, sha256 } from "../src/lib/utils";
import type { S6ToS7Handoff, S7ToS8Handoff, S8Artifact, UUID } from "../src/lib/types";

const projectId = "11111111-1111-4111-8111-111111111111" as UUID;
const revisionId = "22222222-2222-4222-8222-222222222222" as UUID;
const hash = "a".repeat(64);

function s7SourceFrom(s6: S6ToS7Handoff) {
  return {
    sourceRevisionId: s6.acceptedRevisionId,
    sourceRevisionHash: s6.acceptedRevisionHash,
    sourceS5Fingerprint: s6.sourceS5Fingerprint,
    validationReceiptId: s6.validationReceipt.receiptId,
    validationHash: s6.validationReceipt.validationHash,
    s6HandoffSchemaVersion: s6.schemaVersion,
    handoffDigest: sha256(canonicalS8SourceJson(s6)),
  };
}

function sources() {
  const object = {
    objectId: "object-1", identityKey: "object-1", parentObjectId: null,
    objectType: "box" as const, role: "furniture" as const, label: "Box",
    geometry: { kind: "rect_prism" as const, dimensionsMm: { widthMm: 100, depthMm: 100, heightMm: 100 }, geometryState: "exact" as const, localAnchor: "floor" as const },
    footprint: { kind: "rectangle" as const, widthMm: 100, depthMm: 100 },
    transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 100, depthMm: 100, heightMm: 100 },
    zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "user_confirmed_design_decision" as const, sourceRef: "test", sourceFingerprint: hash, acceptedByUser: true, note: null },
  };
  const s6 = {
    schemaVersion: "s6-to-s7-handoff-v1", projectId, acceptedRevisionId: revisionId, acceptedRevisionHash: hash,
    sourceS5Fingerprint: hash, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres",
    coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" },
    booth: { widthMm: 1000, depthMm: 1000, openSides: ["north"], maxHeightMm: 1000, heightState: "known" },
    objects: [object], hierarchy: [{ objectId: object.objectId, parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [],
    validationReceipt: { receiptId: "33333333-3333-4333-8333-333333333333", validationHash: hash, outcome: "pass" },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  } as unknown as S6ToS7Handoff;
  const s7Source = s7SourceFrom(s6);
  const s7ReadbackBase = {
    schemaVersion: "s7-cad-validation-receipt-v1" as const,
    receiptId: "66666666-6666-4666-8666-666666666666" as UUID,
    projectId,
    artifactId: "44444444-4444-4444-8444-444444444444" as UUID,
    source: s7Source,
    manifestId: "55555555-5555-4555-8555-555555555555" as UUID,
    manifestHash: hash,
    worldToPlanVersion: "s7-world-to-plan-v1" as const,
    dxfVersion: "s7-dxf-r2000-ascii-v1" as const,
    sha256: hash,
    byteSize: 1,
    entityCount: 0,
    correspondenceResult: "pass" as const,
    outcome: "pass" as const,
    issues: [] as string[],
    checkedAt: "2026-01-01T00:00:00.000Z",
    readbackVersion: "s7-cad-readback-v1" as const,
  };
  const s7ReadbackHash = sha256(jcs({ ...s7ReadbackBase, receiptHash: "" }));
  const s7Readback = { ...s7ReadbackBase, receiptHash: s7ReadbackHash };
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash, readbackReceiptId: s7Readback.receiptId, readbackHash: s7ReadbackHash,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7, s7Source, s7Readback };
}

function semanticResult(): S8SemanticResult {
  const distribution = { count: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  return { outcome: "pass", localPositionMm: distribution, worldPositionMm: distribution, dimensionMm: distribution, worldBoundMm: distribution, matrixElement: distribution, normalAngularDegrees: distribution, roundSagittaMm: distribution };
}

function runnerEvidence(kind: "writer" | "validator"): S8RunnerEvidence {
  const validator = kind === "validator";
  const addressSpaceBytes = validator ? S8_LIMITS.validatorMemoryBytes : S8_LIMITS.writerAddressSpaceBytes;
  const fileBytes = validator ? S8_LIMITS.validatorTempBytes : S8_LIMITS.artifactBytes;
  const timeoutMs = validator ? S8_LIMITS.validatorTimeoutMs : S8_LIMITS.timeoutMs;
  const stdoutBytes = validator ? S8_LIMITS.readbackBytes : S8_LIMITS.stdoutBytes;
  const runnerSha256 = validator ? "b".repeat(64) : "a".repeat(64);
  const cpuSeconds = Math.ceil(timeoutMs / 1000) + 1;
  const evidence: Omit<S8RunnerEvidence, "verifiedByCaller"> = {
    schemaVersion: S8_PROCESS_RUNNER_PIN.protocol,
    protocol: S8_PROCESS_RUNNER_PIN.protocol,
    policyId: S8_PROCESS_RUNNER_PIN.policy,
    requested: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, wallTimeoutMs: timeoutMs, stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 },
    appliedByChild: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    observedByRunnerParent: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    runnerParentVerification: { status: "PASS", mismatchCode: null },
    runnerBinary: { selfSha256: runnerSha256 },
    result: { code: 0, name: "S8_RUNNER_SUCCESS", terminationClass: "target-exit-zero", targetExit: 0, targetSignal: null, elapsedMs: 1, stdoutBytes: 0, stderrBytes: 0, setupStage: null, evidenceCode: null },
  };
  return {
    ...evidence,
    verifiedByCaller: {
      schemaVersion: "s8-runner-caller-verification-v2",
      status: "VERIFIED_BY_CALLER",
      preLaunchSha256: runnerSha256,
      postLaunchSha256: runnerSha256,
      runnerReportedSelfSha256: runnerSha256,
      outerExitStatus: 0,
      outerSignal: null,
      observedStdoutBytes: 0,
      observedStderrBytes: 0,
      receiptSha256: s8Sha256(canonicalS8RunnerReceiptBytes(evidence as unknown as S8RunnerEvidence)),
    },
  };
}

function cloneEvidence(value: S8RunnerEvidence): S8RunnerEvidence {
  return JSON.parse(JSON.stringify(value)) as S8RunnerEvidence;
}

type FixtureOptions = {
  writerEvidence?: S8RunnerEvidence;
  validatorEvidence?: S8RunnerEvidence;
  omitWriterEvidence?: boolean;
  omitValidatorEvidence?: boolean;
  omitValidatorIdentity?: boolean;
  admissionClosed?: boolean;
  nativeReadback?: S8UfbxReadback;
  sourceChangesAfterWriter?: boolean;
  sourceChangesAfterValidator?: boolean;
  sourceChangesBeforeCommit?: boolean;
};

function serviceFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "s8-publication-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S8", status: "concepts_ready", boothGeometry: null, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  });
  const objects = new PrivateObjectStore(join(root, "objects"));
  const { s6, s7, s7Source, s7Readback } = sources();
  const at = "2026-01-01T00:00:00.000Z";
  const s7JobId = "77777777-7777-4777-8777-777777777777" as UUID;
  const s7IdempotencyKey = "s8-test-source";
  repository.transact((state) => {
    state.s7CadExports ??= [];
    state.s7CadJobs ??= [];
    state.s7CadIdempotency ??= [];
    state.s7CadManifests ??= [];
    state.s7CadReadbackReceipts ??= [];
    state.s7CadExports.push({
      schemaVersion: "s7-cad-export-v1", artifactId: s7.s7ArtifactId, projectId, jobId: s7JobId, source: s7Source, inputHash: hash,
      dxfVersion: s7.dxfVersion, worldToPlanVersion: s7.worldToPlanVersion, format: "dxf", mimeType: "application/dxf", downloadFileName: "swooshz-s7-plan.dxf",
      status: "committed", publicationPhase: "committed", attempt: 1, retryOfArtifactId: null, manifestId: s7.manifestId, manifestHash: s7.manifestHash,
      readbackReceiptId: s7.readbackReceiptId, readbackHash: s7.readbackHash, sha256: s7.s7ArtifactHash, byteSize: s7.s7ArtifactByteSize,
      privateFinalStorageKey: s7FinalDxfStorageKey(projectId, s7.s7ArtifactId), privateStagingStorageKey: s7StagingDxfStorageKey(projectId, s7JobId, "unclaimed"),
      failureCode: null, createdAt: at, updatedAt: at, committedAt: at, staleAt: null, supersededAt: null,
    });
    state.s7CadJobs.push({
      schemaVersion: "s7-cad-job-v1", jobId: s7JobId, projectId, artifactId: s7.s7ArtifactId, source: s7Source, inputHash: hash, idempotencyKey: s7IdempotencyKey,
      status: "committed", attempt: 1, retryOfJobId: null, claimToken: null, ownerProcessId: null, claimedAt: null, heartbeatAt: null,
      createdAt: at, updatedAt: at, terminalAt: at,
    });
    state.s7CadIdempotency.push({
      schemaVersion: "s7-cad-idempotency-v1", projectId, operation: "export", idempotencyKey: s7IdempotencyKey, inputHash: hash, source: s7Source,
      jobId: s7JobId, artifactId: s7.s7ArtifactId, createdAt: at,
    });
    state.s7CadManifests.push({
      schemaVersion: "s7-cad-manifest-v1", manifestId: s7.manifestId, projectId, artifactId: s7.s7ArtifactId, source: s7Source,
      worldToPlanVersion: s7.worldToPlanVersion, dxfVersion: s7.dxfVersion, manifestHash: s7.manifestHash, manifestByteSize: 1,
      privateManifestStorageKey: s7FinalManifestStorageKey(projectId, s7.manifestId),
    });
    state.s7CadReadbackReceipts.push(s7Readback);
  });
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const nativeReadback: S8UfbxReadback = options.nativeReadback ?? {
    schemaVersion: "s8-ufbx-readback-v1", fbxVersion: 7400, unitMeters: 0.001, warningCount: 0,
    source: { revisionId, revisionHash: hash, s6ValidationHash: hash, s6HandoffDigest: hash }, materials: [],
    nodes: [
      { name: "SWZ_ROOT", parent: null, effectiveScale: [1, 1, 1], nodeToParent: identityMatrix, nodeToWorld: identityMatrix, mesh: null },
      { name: s8StableName(0, "object-1"), parent: "SWZ_ROOT", sourceObjectId: "object-1", identityKey: "object-1", effectiveScale: [1, 1, 1], nodeToParent: identityMatrix, nodeToWorld: identityMatrix, mesh: null },
    ],
  };
  let writerCalls = 0;
  let currentS6 = s6;
  let objectWriteCalls = 0;
  const originalPutExact = objects.putExact.bind(objects);
  objects.putExact = (key, bytes) => { objectWriteCalls += 1; originalPutExact(key, bytes); };
  const changedSource = () => ({ ...s6, acceptedRevisionId: "88888888-8888-4888-8888-888888888888" as UUID });
  const adapters: S8ExportAdapters = {
    writer: (payloadBytes) => {
      writerCalls += 1;
      const artifact = Buffer.alloc(32, 7);
      const value: Record<string, unknown> = { artifact, stdout: "", stderr: "", receipt: { schemaVersion: "swooshz-fbx-writer-receipt-v1", profile: "swooshz-fbx-static-mesh-v1", payloadSha256: s8Sha256(payloadBytes), writerScriptSha256: hash, artifactSha256: s8Sha256(artifact), artifactByteSize: artifact.length, fbxHeaderVersion: 7400, objectCount: 1, controlPointCount: 8, triangleCount: 12, runtime: {} } };
      if (!options.omitWriterEvidence) value.runnerEvidence = options.writerEvidence ?? runnerEvidence("writer");
      if (options.sourceChangesAfterWriter) currentS6 = changedSource();
      return value as unknown as S8WriterResult;
    },
    nativeValidator: () => {
      const value: Record<string, unknown> = { readback: nativeReadback, readbackBytes: Buffer.from(JSON.stringify(nativeReadback)) };
      if (!options.omitValidatorIdentity) value.validatorIdentity = "test-validator";
      if (!options.omitValidatorEvidence) value.runnerEvidence = options.validatorEvidence ?? runnerEvidence("validator");
      if (options.sourceChangesAfterValidator) currentS6 = changedSource();
      return value as unknown as S8NativeValidationResult;
    },
    semanticValidator: () => semanticResult(),
  };
  let sourceChangedAtCommit = false;
  if (options.sourceChangesBeforeCommit) {
    const transact = repository.transact.bind(repository);
    repository.transact = (mutation) => {
      if (!sourceChangedAtCommit && repository.state().s8ExportJobs?.some((job) => job.publicationPhase === "commit")) {
        currentS6 = changedSource();
        sourceChangedAtCommit = true;
      }
      return transact(mutation);
    };
  }
  const service = new S8ExportService({ repository, objects, s6: { getS7Handoff: () => currentS6 } as never, s7: { getHandoff: () => s7 } as never, adapters, admissionReader: async () => ({ state: options.admissionClosed ? "CLOSED" : "OPEN", reason: options.admissionClosed ? "CAPACITY_NOT_OPEN" : null, proofSha256: options.admissionClosed ? null : hash, observedAt: options.admissionClosed ? null : "2026-09-29T00:00:00.000Z" }), ownerId: "test-owner", processId: process.pid, isProcessAlive: () => false });
  return { root, repository, objects, service, get writerCalls() { return writerCalls; }, get objectWriteCalls() { return objectWriteCalls; }, get sourceChangedAtCommit() { return sourceChangedAtCommit; } };
}

async function rejects(options: FixtureOptions, key: string): Promise<void> {
  const fixture = serviceFixture(options);
  try {
    await assert.rejects(() => fixture.service.createExport(projectId, key, "77777777-7777-4777-8777-777777777777"), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function replacePublicationReceipt(fixture: ReturnType<typeof serviceFixture>, artifact: S8Artifact, value: Record<string, unknown>): void {
  const bytes = Buffer.from(jcs(value), "utf8");
  const key = `${artifact.privateFinalPrefix}/publication-receipt.json`;
  fixture.objects.remove(key);
  fixture.objects.put(key, bytes);
  fixture.repository.transact((state) => {
    const persisted = state.s8Artifacts!.find((item: S8Artifact) => item.artifactId === artifact.artifactId)!;
    persisted.objectHashes!.publicationReceiptSha256 = s8Sha256(bytes);
  });
}

test("source change after Writer response is fenced before private staging", async () => {
  const fixture = serviceFixture({ sourceChangesAfterWriter: true });
  try {
    await assert.rejects(() => fixture.service.createExport(projectId, "stale-after-writer", "77777777-7777-4777-8777-777777777777"), /S8_SOURCE_STALE/);
    assert.equal(fixture.writerCalls, 1);
    assert.equal(fixture.objectWriteCalls, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source change after Validator response is fenced before readback staging", async () => {
  const fixture = serviceFixture({ sourceChangesAfterValidator: true });
  try {
    await assert.rejects(() => fixture.service.createExport(projectId, "stale-after-validator", "99999999-9999-4999-8999-999999999999"), /S8_SOURCE_STALE/);
    assert.equal(fixture.objectWriteCalls, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source change between commit precheck and transaction is fenced atomically", async () => {
  const fixture = serviceFixture({ sourceChangesBeforeCommit: true });
  try {
    await assert.rejects(() => fixture.service.createExport(projectId, "stale-at-commit", "99999999-9999-4999-8999-999999999999"), /S8_SOURCE_STALE/);
    assert.equal(fixture.sourceChangedAtCommit, true);
    const artifact = fixture.repository.state().s8Artifacts?.find((item) => item.projectId === projectId);
    assert.notEqual(artifact?.status, "committed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native dispatch remains closed and does not create an export without OPEN admission", async () => {
  const fixture = serviceFixture({ admissionClosed: true });
  try {
    assert.equal((await fixture.service.getAdmissionStatus()).state, "CLOSED");
    await assert.rejects(() => fixture.service.createExport(projectId, "closed-admission", "77777777-7777-4777-8777-777777777777"), /S8_WORKER_ADMISSION_CLOSED/);
    assert.equal(fixture.writerCalls, 0);
    assert.equal(fixture.repository.state().s8ExportJobs?.length ?? 0, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S8 publication binds caller-verified v2 evidence and reuses the immutable graph", async () => {
  const fixture = serviceFixture();
  try {
    const first = await fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(first.export.status, "committed");
    assert.equal(first.export.publicationPhase, "commit");
    assert.equal("privateFinalPrefix" in first.export, false);
    const artifact = fixture.repository.state().s8Artifacts!.find((value: S8Artifact) => value.artifactId === first.export.artifactId)!;
    const publication = JSON.parse(fixture.objects.read(`${artifact.privateFinalPrefix}/publication-receipt.json`).toString("utf8")) as { identity: { runner: { writer: S8RunnerEvidence } } };
    const persistedWriterEvidence = publication.identity.runner.writer;
    assert.equal(persistedWriterEvidence.verifiedByCaller.schemaVersion, "s8-runner-caller-verification-v2");
    assert.equal(persistedWriterEvidence.verifiedByCaller.outerExitStatus, persistedWriterEvidence.result.code);
    assert.equal(persistedWriterEvidence.verifiedByCaller.observedStdoutBytes, persistedWriterEvidence.result.stdoutBytes);
    assert.equal(persistedWriterEvidence.verifiedByCaller.observedStderrBytes, persistedWriterEvidence.result.stderrBytes);
    assert.equal(persistedWriterEvidence.verifiedByCaller.receiptSha256, s8Sha256(canonicalS8RunnerReceiptBytes(persistedWriterEvidence)));
    const downloaded = fixture.service.download(projectId, first.export.artifactId);
    assert.equal(downloaded.bytes.length, 32);
    const replay = await fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.export.objectHashes, first.export.objectHashes);
    assert.deepEqual(replay.export, first.export);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S8 publication rejects every missing or malformed caller evidence layer", async () => {
  await rejects({ omitWriterEvidence: true }, "missing-writer-evidence");
  await rejects({ omitValidatorEvidence: true }, "missing-validator-evidence");
  await rejects({ omitValidatorIdentity: true }, "missing-validator-identity");

  const missingEnvelope = runnerEvidence("writer");
  delete (missingEnvelope as unknown as Record<string, unknown>).verifiedByCaller;
  await rejects({ writerEvidence: missingEnvelope }, "missing-caller-envelope");

  const wrongSchema = runnerEvidence("writer");
  (wrongSchema as unknown as Record<string, unknown>).schemaVersion = "s8-process-runner-receipt-v1";
  await rejects({ writerEvidence: wrongSchema }, "wrong-schema");

  const wrongPolicy = runnerEvidence("writer");
  (wrongPolicy as unknown as Record<string, unknown>).policyId = "wrong-policy";
  await rejects({ writerEvidence: wrongPolicy }, "wrong-policy");

  const requestedMismatch = runnerEvidence("writer");
  requestedMismatch.requested.rlimitAsBytes -= 1;
  await rejects({ writerEvidence: requestedMismatch }, "requested-mismatch");

  const childMismatch = runnerEvidence("writer");
  childMismatch.appliedByChild.rlimitFsizeBytes -= 1;
  await rejects({ writerEvidence: childMismatch }, "child-applied-mismatch");

  const parentMismatch = runnerEvidence("validator");
  parentMismatch.observedByRunnerParent.rlimitCpuSeconds -= 1;
  await rejects({ validatorEvidence: parentMismatch }, "parent-observed-mismatch");

  const hashMismatch = runnerEvidence("writer");
  hashMismatch.runnerBinary.selfSha256 = "d".repeat(64);
  await rejects({ writerEvidence: hashMismatch }, "runner-reported-hash-mismatch");

  const callerHashDrift = runnerEvidence("writer");
  callerHashDrift.verifiedByCaller.postLaunchSha256 = "e".repeat(64);
  await rejects({ writerEvidence: callerHashDrift }, "pre-post-hash-drift");

  const seccompMissing = runnerEvidence("validator");
  (seccompMissing.appliedByChild as unknown as Record<string, unknown>).seccompMode = 0;
  await rejects({ validatorEvidence: seccompMissing }, "seccomp-missing");
});

test("initial publication rejects missing or mismatched physical provenance and root provenance", async () => {
  const baseline = serviceFixture();
  let validReadback: S8UfbxReadback;
  try {
    const created = await baseline.service.createExport(projectId, "provenance-positive", "77777777-7777-4777-8777-777777777777");
    assert.equal(created.export.status, "committed");
    const artifact = baseline.repository.state().s8Artifacts!.find((value: S8Artifact) => value.artifactId === created.export.artifactId)!;
    validReadback = JSON.parse(baseline.objects.read(`${artifact.privateFinalPrefix}/native-readback.json`).toString("utf8")) as S8UfbxReadback;
  } finally {
    rmSync(baseline.root, { recursive: true, force: true });
  }

  const invalidReadbacks: S8UfbxReadback[] = [];
  for (const [property, value] of [
    ["sourceObjectId", undefined], ["sourceObjectId", "wrong-source"],
    ["identityKey", undefined], ["identityKey", "wrong-identity"],
  ] as const) {
    const readback = structuredClone(validReadback!);
    const physical = readback.nodes[1]! as unknown as Record<string, unknown>;
    if (value === undefined) delete physical[property];
    else physical[property] = value;
    invalidReadbacks.push(readback);
  }
  for (const property of ["sourceObjectId", "identityKey"]) {
    const readback = structuredClone(validReadback!);
    Object.defineProperty(readback.nodes[0], property, { value: undefined, enumerable: true, configurable: true });
    invalidReadbacks.push(readback);
  }
  for (const [index, nativeReadback] of invalidReadbacks.entries()) {
    const fixture = serviceFixture({ nativeReadback });
    try {
      await assert.rejects(() => fixture.service.createExport(projectId, `bad-provenance-${index}`, "88888888-8888-4888-8888-888888888888"), /S8_SOURCE_IDENTITY_MISMATCH/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("S8 download re-hashes immutable bytes before serving", async () => {
  const fixture = serviceFixture();
  try {
    const created = await fixture.service.createExport(projectId, "tamper-key", "88888888-8888-4888-8888-888888888888");
    const persisted = fixture.repository.state().s8Artifacts!.find((item: S8Artifact) => item.artifactId === created.export.artifactId)!;
    const finalKey = `${persisted.privateFinalPrefix}/artifact.fbx`;
    fixture.objects.remove(finalKey);
    fixture.objects.put(finalKey, Buffer.alloc(32, 8));
    assert.throws(() => fixture.service.download(projectId, created.export.artifactId), /S8_PUBLICATION_OBJECT_MISMATCH/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reuse rejects legacy and copied-only caller verification evidence", async () => {
  for (const mode of ["missing", "copied-status-only"] as const) {
    const fixture = serviceFixture();
    try {
      const created = await fixture.service.createExport(projectId, `legacy-evidence-${mode}`, "88888888-8888-4888-8888-888888888888");
      const artifact = fixture.repository.state().s8Artifacts!.find((item: S8Artifact) => item.artifactId === created.export.artifactId)!;
      const publication = JSON.parse(fixture.objects.read(`${artifact.privateFinalPrefix}/publication-receipt.json`).toString("utf8")) as Record<string, unknown>;
      const identity = publication.identity as { runner: { writer: Record<string, unknown> } };
      if (mode === "missing") delete identity.runner.writer.verifiedByCaller;
      else identity.runner.writer.verifiedByCaller = { schemaVersion: "s8-runner-caller-verification-v2", status: "VERIFIED_BY_CALLER" };
      replacePublicationReceipt(fixture, artifact, publication);
      assert.throws(() => fixture.service.download(projectId, created.export.artifactId), /S8_REUSE_FINGERPRINT_INVALID/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("reuse revalidates persisted native provenance against current accepted S6", async () => {
  const fixture = serviceFixture();
  try {
    const created = await fixture.service.createExport(projectId, "persisted-provenance-key", "88888888-8888-4888-8888-888888888888");
    const artifact = fixture.repository.state().s8Artifacts!.find((item: S8Artifact) => item.artifactId === created.export.artifactId)!;
    const nativeKey = `${artifact.privateFinalPrefix}/native-readback.json`;
    const native = JSON.parse(fixture.objects.read(nativeKey).toString("utf8")) as S8UfbxReadback;
    (native.nodes[1] as unknown as Record<string, unknown>).identityKey = "wrong-accepted-s6-identity";
    const nativeBytes = Buffer.from(jcs(native), "utf8");
    const nativeHash = s8Sha256(nativeBytes);
    const publication = JSON.parse(fixture.objects.read(`${artifact.privateFinalPrefix}/publication-receipt.json`).toString("utf8")) as Record<string, unknown>;
    const identity = publication.identity as { fingerprintVersion: string; receiptHashes: { native: string } };
    const objects = publication.objects as { nativeReadbackSha256: string };
    identity.receiptHashes.native = nativeHash;
    objects.nativeReadbackSha256 = nativeHash;
    const immutableReuseFingerprint = sha256(jcs({ fingerprintVersion: identity.fingerprintVersion, identity }));
    publication.immutableReuseFingerprint = immutableReuseFingerprint;
    const receipt = fixture.repository.state().s8ValidationReceipts!.find((item) => item.receiptId === artifact.validationReceiptId)!;
    fixture.repository.transact((state) => {
      const persisted = state.s8Artifacts!.find((item: S8Artifact) => item.artifactId === artifact.artifactId)!;
      persisted.objectHashes!.nativeReadbackSha256 = nativeHash;
      persisted.immutableReuseFingerprint = immutableReuseFingerprint;
      const persistedReceipt = state.s8ValidationReceipts!.find((item) => item.receiptId === receipt.receiptId)!;
      persistedReceipt.nativeReadbackHash = nativeHash;
      persistedReceipt.immutableReuseFingerprint = immutableReuseFingerprint;
      const { receiptHash: _oldHash, ...body } = persistedReceipt;
      persistedReceipt.receiptHash = sha256(jcs(body));
      persisted.validationReceiptHash = persistedReceipt.receiptHash;
      publication.validationReceiptHash = persistedReceipt.receiptHash;
    });
    fixture.objects.remove(nativeKey);
    fixture.objects.put(nativeKey, nativeBytes);
    replacePublicationReceipt(fixture, artifact, publication);
    assert.throws(() => fixture.service.download(projectId, created.export.artifactId), /S8_REUSE_FINGERPRINT_INVALID/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S8 recovery commits only a complete promoted object", async () => {
  const fixture = serviceFixture();
  try {
    const created = await fixture.service.createExport(projectId, "recovery-key", "99999999-9999-4999-8999-999999999999");
    fixture.repository.transact((state) => {
      const job = state.s8ExportJobs!.find((item) => item.artifactId === created.export.artifactId)!;
      const artifact = state.s8Artifacts!.find((item) => item.artifactId === created.export.artifactId)!;
      job.status = "promoted"; job.publicationPhase = "immutable_promotion"; job.claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; job.ownerId = "dead-owner"; job.ownerProcessId = 999999; job.claimedAt = "2026-01-01T00:00:00.000Z"; job.heartbeatAt = "2026-01-01T00:00:00.000Z"; job.terminalAt = null;
      artifact.status = "promoted"; artifact.publicationPhase = "immutable_promotion"; artifact.committedAt = null;
    });
    assert.equal(fixture.service.recoverPending(), 1);
    assert.equal(fixture.service.getExport(projectId, created.export.artifactId).status, "committed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("private object sync failure cannot be accepted as an exact durable retry", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-object-sync-failure-"));
  try {
    let failSync = false;
    const objects = new PrivateObjectStore(join(root, "objects"), {
      syncDirectory: () => {
        if (failSync) throw new Error("injected-directory-sync-failure");
      },
    });
    const bytes = Buffer.from("exact-object");
    failSync = true;
    assert.throws(() => objects.putExact("artifact.bin", bytes), (error: unknown) => error instanceof Error && error.message === "PERSISTENCE_FAILED");
    assert.equal(objects.exists("artifact.bin"), true);
    assert.throws(() => objects.putExact("artifact.bin", bytes), (error: unknown) => error instanceof Error && error.message === "PERSISTENCE_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state directory sync failure poisons the repository after rename", () => {
  const root = mkdtempSync(join(tmpdir(), "s8-state-sync-failure-"));
  try {
    let failSync = false;
    const repository = new JsonRepository(root, {
      syncDirectory: () => {
        if (failSync) throw new Error("injected-directory-sync-failure");
      },
    });
    failSync = true;
    assert.throws(
      () => repository.transact((state) => {
        state.projects.push({
          projectId, name: "S8", status: "concepts_ready", boothGeometry: null, briefAssetId: null,
          briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null,
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        });
      }),
      (error: unknown) => error instanceof Error && error.message === "PERSISTENCE_FAILED",
    );
    assert.throws(
      () => repository.state(),
      (error: unknown) => error instanceof Error && error.message === "PERSISTENCE_FAILED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
