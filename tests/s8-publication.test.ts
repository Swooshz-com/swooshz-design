import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { S8ExportService, type S8ExportAdapters, type S8NativeValidationResult } from "../src/lib/s8";
import type { S8SemanticResult, S8UfbxReadback } from "../src/lib/s8-fbx-semantic";
import { type S8RunnerEvidence, type S8WriterResult } from "../src/lib/s8-fbx-worker";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S8_LIMITS, S8_PROCESS_RUNNER_PIN, s8Sha256 } from "../src/lib/s8-fbx-profile";
import type { S6ToS7Handoff, S7ToS8Handoff, S8Artifact, UUID } from "../src/lib/types";

const projectId = "11111111-1111-4111-8111-111111111111" as UUID;
const revisionId = "22222222-2222-4222-8222-222222222222" as UUID;
const hash = "a".repeat(64);

function sources(): { s6: S6ToS7Handoff; s7: S7ToS8Handoff } {
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
  const s7 = {
    schemaVersion: "s7-to-s8-handoff-v1", projectId, sourceRevisionId: revisionId, sourceRevisionHash: hash, sourceS5Fingerprint: hash,
    s7ArtifactId: "44444444-4444-4444-8444-444444444444", s7ArtifactHash: hash, s7ArtifactByteSize: 1,
    manifestId: "55555555-5555-4555-8555-555555555555", manifestHash: hash, readbackReceiptId: "66666666-6666-4666-8666-666666666666", readbackHash: hash,
    dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1",
    dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true,
  } satisfies S7ToS8Handoff;
  return { s6, s7 };
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
  return {
    schemaVersion: S8_PROCESS_RUNNER_PIN.protocol,
    protocol: S8_PROCESS_RUNNER_PIN.protocol,
    policyId: S8_PROCESS_RUNNER_PIN.policy,
    requested: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, wallTimeoutMs: timeoutMs, stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 },
    appliedByChild: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    observedByRunnerParent: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    runnerParentVerification: { status: "PASS", mismatchCode: null },
    runnerBinary: { selfSha256: runnerSha256 },
    result: { code: 0, name: "S8_RUNNER_SUCCESS", terminationClass: "target-exit-zero", targetExit: 0, targetSignal: null, elapsedMs: 1, stdoutBytes: 0, stderrBytes: 0, setupStage: null, evidenceCode: null },
    verifiedByCaller: { schemaVersion: "s8-runner-caller-verification-v1", status: "VERIFIED_BY_CALLER", preLaunchSha256: runnerSha256, postLaunchSha256: runnerSha256, runnerReportedSelfSha256: runnerSha256, receiptSha256: "c".repeat(64) },
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
};

function serviceFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "s8-publication-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S8", status: "concepts_ready", boothGeometry: null, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  });
  const objects = new PrivateObjectStore(join(root, "objects"));
  const { s6, s7 } = sources();
  const nativeReadback: S8UfbxReadback = { schemaVersion: "s8-ufbx-readback-v1", fbxVersion: 7400, unitMeters: 0.001, warningCount: 0, source: { revisionId, revisionHash: hash, s6ValidationHash: hash, s6HandoffDigest: hash }, materials: [], nodes: [] };
  const adapters: S8ExportAdapters = {
    writer: (payloadBytes) => {
      const artifact = Buffer.alloc(32, 7);
      const value: Record<string, unknown> = { artifact, stdout: "", stderr: "", receipt: { schemaVersion: "swooshz-fbx-writer-receipt-v1", profile: "swooshz-fbx-static-mesh-v1", payloadSha256: s8Sha256(payloadBytes), writerScriptSha256: hash, artifactSha256: s8Sha256(artifact), artifactByteSize: artifact.length, fbxHeaderVersion: 7400, objectCount: 1, controlPointCount: 8, triangleCount: 12, runtime: {} } };
      if (!options.omitWriterEvidence) value.runnerEvidence = options.writerEvidence ?? runnerEvidence("writer");
      return value as unknown as S8WriterResult;
    },
    nativeValidator: () => {
      const value: Record<string, unknown> = { readback: nativeReadback, readbackBytes: Buffer.from(JSON.stringify(nativeReadback)) };
      if (!options.omitValidatorIdentity) value.validatorIdentity = "test-validator";
      if (!options.omitValidatorEvidence) value.runnerEvidence = options.validatorEvidence ?? runnerEvidence("validator");
      return value as unknown as S8NativeValidationResult;
    },
    semanticValidator: () => semanticResult(),
  };
  const service = new S8ExportService({ repository, objects, s6: { getS7Handoff: () => s6 } as never, s7: { getHandoff: () => s7 } as never, adapters, ownerId: "test-owner", processId: process.pid, isProcessAlive: () => false });
  return { root, repository, objects, service };
}

function rejects(options: FixtureOptions, key: string): void {
  const fixture = serviceFixture(options);
  try {
    assert.throws(() => fixture.service.createExport(projectId, key, "77777777-7777-4777-8777-777777777777"), /S8_PROCESS_RUNNER_EVIDENCE_INVALID/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("S8 publication binds caller-verified v2 evidence and reuses the immutable graph", () => {
  const fixture = serviceFixture();
  try {
    const first = fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(first.export.status, "committed");
    assert.equal(first.export.publicationPhase, "commit");
    assert.equal("privateFinalPrefix" in first.export, false);
    const downloaded = fixture.service.download(projectId, first.export.artifactId);
    assert.equal(downloaded.bytes.length, 32);
    const replay = fixture.service.createExport(projectId, "idempotency-key", "77777777-7777-4777-8777-777777777777");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.export.objectHashes, first.export.objectHashes);
    assert.deepEqual(replay.export, first.export);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S8 publication rejects every missing or malformed caller evidence layer", () => {
  rejects({ omitWriterEvidence: true }, "missing-writer-evidence");
  rejects({ omitValidatorEvidence: true }, "missing-validator-evidence");
  rejects({ omitValidatorIdentity: true }, "missing-validator-identity");

  const missingEnvelope = runnerEvidence("writer");
  delete (missingEnvelope as unknown as Record<string, unknown>).verifiedByCaller;
  rejects({ writerEvidence: missingEnvelope }, "missing-caller-envelope");

  const wrongSchema = runnerEvidence("writer");
  (wrongSchema as unknown as Record<string, unknown>).schemaVersion = "s8-process-runner-receipt-v1";
  rejects({ writerEvidence: wrongSchema }, "wrong-schema");

  const wrongPolicy = runnerEvidence("writer");
  (wrongPolicy as unknown as Record<string, unknown>).policyId = "wrong-policy";
  rejects({ writerEvidence: wrongPolicy }, "wrong-policy");

  const requestedMismatch = runnerEvidence("writer");
  requestedMismatch.requested.rlimitAsBytes -= 1;
  rejects({ writerEvidence: requestedMismatch }, "requested-mismatch");

  const childMismatch = runnerEvidence("writer");
  childMismatch.appliedByChild.rlimitFsizeBytes -= 1;
  rejects({ writerEvidence: childMismatch }, "child-applied-mismatch");

  const parentMismatch = runnerEvidence("validator");
  parentMismatch.observedByRunnerParent.rlimitCpuSeconds -= 1;
  rejects({ validatorEvidence: parentMismatch }, "parent-observed-mismatch");

  const hashMismatch = runnerEvidence("writer");
  hashMismatch.runnerBinary.selfSha256 = "d".repeat(64);
  rejects({ writerEvidence: hashMismatch }, "runner-reported-hash-mismatch");

  const callerHashDrift = runnerEvidence("writer");
  callerHashDrift.verifiedByCaller.postLaunchSha256 = "e".repeat(64);
  rejects({ writerEvidence: callerHashDrift }, "pre-post-hash-drift");

  const seccompMissing = runnerEvidence("validator");
  (seccompMissing.appliedByChild as unknown as Record<string, unknown>).seccompMode = 0;
  rejects({ validatorEvidence: seccompMissing }, "seccomp-missing");
});

test("S8 download re-hashes immutable bytes before serving", () => {
  const fixture = serviceFixture();
  try {
    const created = fixture.service.createExport(projectId, "tamper-key", "88888888-8888-4888-8888-888888888888");
    const persisted = fixture.repository.state().s8Artifacts!.find((item: S8Artifact) => item.artifactId === created.export.artifactId)!;
    const finalKey = `${persisted.privateFinalPrefix}/artifact.fbx`;
    fixture.objects.remove(finalKey);
    fixture.objects.put(finalKey, Buffer.alloc(32, 8));
    assert.throws(() => fixture.service.download(projectId, created.export.artifactId), /S8_PUBLICATION_OBJECT_MISMATCH/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("S8 recovery commits only a complete promoted object", () => {
  const fixture = serviceFixture();
  try {
    const created = fixture.service.createExport(projectId, "recovery-key", "99999999-9999-4999-8999-999999999999");
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
