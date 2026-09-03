import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError, type S6ToS7Handoff, type Project, type S7Telemetry, type UUID } from "../src/lib/types";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S7CadService, type S7PublicationPhaseHook, type S7CadServiceOptions } from "../src/lib/s7-cad";
import { s7FinalManifestStorageKey, s7StagingDxfStorageKey } from "../src/lib/s7-persistence";
import { parseS7Dxf } from "../src/lib/s7-dxf-readback";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as UUID;
const RECEIPT_ID = "30000000-0000-4000-8000-000000000002" as UUID;
const HASH = "a".repeat(64);
const MOVED_REVISION_ID = "30000000-0000-4000-8000-000000000099" as UUID;
const MOVED_HASH = "b".repeat(64);

function handoff(revisionId = REVISION_ID, revisionHash = HASH): S6ToS7Handoff {
  const object = {
    objectId: "object-1", identityKey: "object-1", parentObjectId: null, objectType: "box", role: "furniture",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" },
    footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 }, transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [], provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null },
  };
  return { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID, acceptedRevisionId: revisionId, acceptedRevisionHash: revisionHash, sourceS5Fingerprint: HASH, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" }, booth: { widthMm: 6000, depthMm: 3000, openSides: ["north", "east"], maxHeightMm: 3000, heightState: "known" }, objects: [object], hierarchy: [{ objectId: "object-1", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [], validationReceipt: { receiptId: RECEIPT_ID, validationHash: HASH, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false } } as unknown as S6ToS7Handoff;
}

function movedHandoff(): S6ToS7Handoff {
  return handoff(MOVED_REVISION_ID, MOVED_HASH);
}

function project(): Project {
  return { projectId: PROJECT_ID, name: "S7 fixture", status: "geometry_ready", boothGeometry: null, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };
}

function context(options: { phase?: S7PublicationPhaseHook; alive?: (owner: string) => boolean; revision?: string; revisionHash?: string; moveOnSourceRead?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "s7-persistence-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => { state.projects.push(project()); });
  const objects = new PrivateObjectStore(join(root, "objects"));
  let current = handoff(options.revision as UUID ?? REVISION_ID, options.revisionHash ?? HASH);
  let sourceUnavailable = false;
  let sourceReads = 0;
  const s6 = { getS7Handoff: () => {
    sourceReads += 1;
    if (sourceUnavailable) throw new Error("source unavailable");
    if (options.moveOnSourceRead === sourceReads) current = handoff("30000000-0000-4000-8000-000000000099" as UUID, "b".repeat(64));
    return structuredClone(current);
  } } as never;
  const serviceOptions = { repository, objects, s6, clock: (() => { let n = 0; return () => new Date(Date.parse("2026-09-03T00:00:00.000Z") + ++n).toISOString(); })(), uuid: undefined, ownerProcessId: "s7-test-owner", isOwnerProcessAlive: options.alive, onPublicationPhase: options.phase } as unknown as S7CadServiceOptions;
  const service = new S7CadService(serviceOptions);
  return { repository, objects, service, move(next: S6ToS7Handoff) { current = next; }, unavailable() { sourceUnavailable = true; }, sourceReads: () => sourceReads };
}

function code(error: unknown): string { return error instanceof AppError ? error.code : String(error); }

test("export lifecycle commits immutable DXF, separate manifest, and passing durable readback receipt", () => {
  const value = context();
  const result = value.service.createExport(PROJECT_ID, "opaque-key-1", "30000000-0000-4000-8000-000000000003" as UUID);
  assert.equal(result.export.status, "committed");
  assert.equal(JSON.stringify(result.export).includes("privateFinalStorageKey"), false);
  const state = value.repository.state();
  assert.equal(state.s7CadExports?.length, 1);
  assert.equal(state.s7CadJobs?.length, 1);
  assert.equal(state.s7CadManifests?.length, 1);
  assert.equal(state.s7CadReadbackReceipts?.length, 1);
  assert.equal(state.s7CadManifests?.[0]?.privateManifestStorageKey.includes("/s7/manifests/"), true);
  const bytes = value.service.download(PROJECT_ID, result.export.artifactId).bytes;
  assert.equal(bytes.length, result.export.byteSize);
  assert.equal(parseS7Dxf(bytes).outcome, "pass");
  const replay = value.service.createExport(PROJECT_ID, "opaque-key-1");
  assert.equal(replay.replayed, true);
  assert.equal(replay.export.artifactId, result.export.artifactId);
  const independent = value.service.createExport(PROJECT_ID, "opaque-key-2");
  assert.equal(independent.replayed, false);
  assert.equal(independent.export.status, "committed");
  assert.equal(value.repository.state().s7CadExports?.length, 2);
});

test("opaque idempotency keys replay only for the exact accepted source/input and conflict on source movement", () => {
  const value = context();
  const first = value.service.createExport(PROJECT_ID, "not-a-uuid-key");
  assert.equal(first.replayed, false);
  assert.equal(value.service.createExport(PROJECT_ID, "not-a-uuid-key").replayed, true);
  const moved = handoff("30000000-0000-4000-8000-000000000099" as UUID, "b".repeat(64));
  value.move(moved);
  assert.throws(() => value.service.createExport(PROJECT_ID, "not-a-uuid-key"), (error) => code(error) === "S7_IDEMPOTENCY_CONFLICT");
});

test("source movement at a live fence fails closed and records stale, while committed history becomes superseded", () => {
  let moveAtGeneration = false;
  const value = context({ phase: (phase, details) => {
    if (phase === "generation" && !moveAtGeneration) {
      moveAtGeneration = true;
      value.move(handoff("30000000-0000-4000-8000-000000000099" as UUID, "b".repeat(64)));
    }
    void details;
  } });
  assert.throws(() => value.service.createExport(PROJECT_ID, "stale-key"), (error) => code(error) === "S7_SOURCE_STALE");
  const stale = value.repository.state().s7CadExports?.[0];
  assert.equal(stale?.status, "stale");

  const second = context();
  const committed = second.service.createExport(PROJECT_ID, "supersede-key");
  second.move(handoff("30000000-0000-4000-8000-000000000099" as UUID, "b".repeat(64)));
  const state = second.service.getState(PROJECT_ID);
  assert.equal(state.exports.find((item) => item.artifactId === committed.export.artifactId)?.status, "superseded");
});

test("source movement is fenced independently at admission, job/idempotency creation, projection, generation, staging, promotion, and commit", () => {
  const boundaries: Array<{
    name: string;
    phase?: "admission" | "projection" | "generation" | "staging" | "promotion" | "commit";
    moveOnSourceRead?: number;
    persistsArtifact: boolean;
  }> = [
    { name: "admission", phase: "admission", persistsArtifact: false },
    { name: "job/idempotency creation", moveOnSourceRead: 2, persistsArtifact: false },
    { name: "projection", phase: "projection", persistsArtifact: true },
    { name: "generation", phase: "generation", persistsArtifact: true },
    { name: "staging", phase: "staging", persistsArtifact: true },
    { name: "promotion", phase: "promotion", persistsArtifact: true },
    { name: "commit", phase: "commit", persistsArtifact: true },
  ];

  for (const boundary of boundaries) {
    let value!: ReturnType<typeof context>;
    let movedAtPhase = false;
    value = context({
      moveOnSourceRead: boundary.moveOnSourceRead,
      phase: (phase, details) => {
        if (boundary.phase === phase && !movedAtPhase) {
          movedAtPhase = true;
          value.move(movedHandoff());
        }
        void details;
      },
    });
    assert.throws(() => value.service.createExport(PROJECT_ID, "fence-" + boundary.name), (error) => code(error) === "S7_SOURCE_STALE");
    if (boundary.phase) assert.equal(movedAtPhase, true);
    if (boundary.moveOnSourceRead) assert.equal(value.sourceReads() >= boundary.moveOnSourceRead, true);

    const state = value.repository.state();
    const exports = state.s7CadExports ?? [];
    if (!boundary.persistsArtifact) {
      assert.equal(exports.length, 0);
      assert.equal(state.s7CadJobs?.length, 0);
      assert.equal(state.s7CadIdempotency?.length, 0);
      continue;
    }
    assert.equal(exports.length, 1);
    assert.equal(exports[0]?.status, "stale");
    assert.equal(exports[0]?.staleAt !== null, true);
    assert.equal(exports[0]?.supersededAt, null);
    assert.equal(state.s7CadJobs?.[0]?.status, "stale");
    assert.equal(state.s7CadJobs?.[0]?.terminalAt !== null, true);
    assert.equal(state.s7CadIdempotency?.length, 1);
  }
});

test("committed supersession is durable from metadata, download, telemetry, handoff, and state access", () => {
  const actions: Array<{
    name: string;
    expectedCode?: string;
    invoke: (service: S7CadService, artifactId: UUID) => unknown;
  }> = [
    { name: "metadata", expectedCode: "S7_SOURCE_STALE", invoke: (service, artifactId) => service.getExport(PROJECT_ID, artifactId) },
    { name: "download", expectedCode: "S7_SOURCE_STALE", invoke: (service, artifactId) => service.download(PROJECT_ID, artifactId) },
    { name: "telemetry", invoke: (service) => service.getTelemetry(PROJECT_ID) },
    { name: "handoff", expectedCode: "S7_HANDOFF_NOT_READY", invoke: (service) => service.getHandoff(PROJECT_ID) },
    { name: "state", invoke: (service) => service.getState(PROJECT_ID) },
  ];

  for (const action of actions) {
    const value = context();
    const created = value.service.createExport(PROJECT_ID, "supersession-" + action.name);
    const beforeState = value.repository.state();
    const beforeArtifact = beforeState.s7CadExports?.find((item) => item.artifactId === created.export.artifactId)!;
    const beforeManifest = beforeState.s7CadManifests?.find((item) => item.manifestId === beforeArtifact.manifestId)!;
    const beforeReceipt = beforeState.s7CadReadbackReceipts?.find((item) => item.receiptId === beforeArtifact.readbackReceiptId)!;
    const beforeIdempotency = beforeState.s7CadIdempotency?.find((item) => item.artifactId === beforeArtifact.artifactId)!;
    const beforeDxf = value.objects.read(beforeArtifact.privateFinalStorageKey);
    const beforeManifestBytes = value.objects.read(s7FinalManifestStorageKey(PROJECT_ID, beforeArtifact.manifestId));

    value.move(movedHandoff());
    if (action.expectedCode) {
      assert.throws(() => action.invoke(value.service, created.export.artifactId), (error) => code(error) === action.expectedCode);
    } else {
      const result = action.invoke(value.service, created.export.artifactId);
      if (action.name === "telemetry") {
        const telemetry = result as S7Telemetry;
        assert.equal(telemetry.sourceReadiness.value, "ready");
        assert.equal(telemetry.committedExportCount.value, 0);
        assert.equal(telemetry.supersededCount.value, 1);
        assert.equal(telemetry.staleCount.value, 0);
      }
      if (action.name === "state") {
        const state = result as ReturnType<S7CadService["getState"]>;
        assert.equal(state.source.readiness, "ready");
        assert.equal(state.exports.find((item) => item.artifactId === created.export.artifactId)?.status, "superseded");
      }
    }

    const afterState = value.repository.state();
    const afterArtifact = afterState.s7CadExports?.find((item) => item.artifactId === created.export.artifactId)!;
    const afterJob = afterState.s7CadJobs?.find((item) => item.jobId === afterArtifact.jobId)!;
    assert.equal(afterArtifact.status, "superseded");
    assert.equal(afterArtifact.staleAt, null);
    assert.equal(afterArtifact.supersededAt !== null, true);
    assert.equal(afterArtifact.updatedAt, afterArtifact.supersededAt);
    assert.equal(afterArtifact.committedAt, beforeArtifact.committedAt);
    assert.equal(afterJob.status, "superseded");
    assert.equal(afterJob.terminalAt, afterArtifact.supersededAt);
    assert.equal(afterJob.updatedAt, afterArtifact.updatedAt);
    assert.deepEqual(afterState.s7CadManifests?.find((item) => item.manifestId === beforeManifest.manifestId), beforeManifest);
    assert.deepEqual(afterState.s7CadReadbackReceipts?.find((item) => item.receiptId === beforeReceipt.receiptId), beforeReceipt);
    assert.deepEqual(afterState.s7CadIdempotency?.find((item) => item.artifactId === beforeIdempotency.artifactId), beforeIdempotency);
    assert.deepEqual(value.objects.read(afterArtifact.privateFinalStorageKey), beforeDxf);
    assert.deepEqual(value.objects.read(s7FinalManifestStorageKey(PROJECT_ID, afterArtifact.manifestId)), beforeManifestBytes);
  }
});

test("invalid or unavailable source does not fabricate a superseding accepted revision", () => {
  const invalid = context();
  const invalidCreated = invalid.service.createExport(PROJECT_ID, "invalid-source");
  const invalidSource = movedHandoff();
  const invalidEligibility = invalidSource.eligibility as unknown as { currentAccepted: boolean; sourceCurrent: boolean; stale: boolean };
  invalidEligibility.currentAccepted = false;
  invalidEligibility.sourceCurrent = false;
  invalidEligibility.stale = true;
  invalid.move(invalidSource);
  assert.equal(invalid.service.getState(PROJECT_ID).source.readiness, "not_ready");
  assert.equal(invalid.service.getTelemetry(PROJECT_ID).sourceReadiness.value, "not_ready");
  const invalidArtifact = invalid.repository.state().s7CadExports?.find((item) => item.artifactId === invalidCreated.export.artifactId)!;
  assert.equal(invalidArtifact.status, "committed");
  assert.equal(invalidArtifact.supersededAt, null);
  assert.equal(invalid.repository.state().s7CadJobs?.[0]?.status, "committed");

  const unavailable = context();
  const unavailableCreated = unavailable.service.createExport(PROJECT_ID, "unavailable-source");
  unavailable.unavailable();
  assert.equal(unavailable.service.getState(PROJECT_ID).source.readiness, "not_ready");
  assert.equal(unavailable.service.getTelemetry(PROJECT_ID).sourceReadiness.value, "not_ready");
  const unavailableArtifact = unavailable.repository.state().s7CadExports?.find((item) => item.artifactId === unavailableCreated.export.artifactId)!;
  assert.equal(unavailableArtifact.status, "committed");
  assert.equal(unavailableArtifact.supersededAt, null);
  assert.equal(unavailable.repository.state().s7CadJobs?.[0]?.status, "committed");
});

test("publication failure allows exactly one retry and never creates attempt three", () => {
  const failures = new Set<number>();
  const value = context({ phase: (phase, details) => { if (phase === "generation" && !failures.has(details.attempt)) { failures.add(details.attempt); throw new Error("controlled failure"); } } });
  assert.throws(() => value.service.createExport(PROJECT_ID, "retry-key"), (error) => code(error) === "S7_PUBLICATION_FAILED");
  const first = value.repository.state().s7CadExports?.[0]!;
  assert.equal(first.status, "failed_retryable");
  assert.equal(value.service.retryExport(first.artifactId).export.status, "failed_terminal");
  const state = value.repository.state();
  assert.equal(state.s7CadExports?.length, 2);
  assert.equal(state.s7CadExports?.some((item) => Number(item.attempt) === 3), false);
  assert.throws(() => value.service.retryExport(state.s7CadExports![1]!.artifactId), (error) => code(error) === "S7_RETRY_NOT_AVAILABLE");
});

test("dead ownership is reconciled only when explicitly proven dead; live/uncertain claims are retained", () => {
  const value = context();
  const result = value.service.createExport(PROJECT_ID, "recovery-key");
  value.repository.transact((state) => {
    const artifact = state.s7CadExports?.find((item) => item.artifactId === result.export.artifactId)!;
    const job = state.s7CadJobs?.find((item) => item.jobId === artifact.jobId)!;
    const claimToken = "40000000-0000-4000-8000-000000000001" as UUID;
    state.s7CadManifests = state.s7CadManifests?.filter((item) => item.manifestId !== artifact.manifestId);
    state.s7CadReadbackReceipts = state.s7CadReadbackReceipts?.filter((item) => item.artifactId !== artifact.artifactId);
    artifact.manifestHash = null; artifact.readbackReceiptId = null; artifact.readbackHash = null; artifact.sha256 = null; artifact.byteSize = null; artifact.committedAt = null; artifact.staleAt = null; artifact.supersededAt = null; artifact.failureCode = null;
    artifact.status = "running"; artifact.privateStagingStorageKey = s7StagingDxfStorageKey(PROJECT_ID, job.jobId, claimToken); artifact.publicationPhase = "none";
    job.status = "running"; job.claimToken = claimToken; job.ownerProcessId = "dead-owner"; job.claimedAt = job.updatedAt; job.heartbeatAt = job.updatedAt; job.terminalAt = null;
  });
  const dead = new S7CadService({ repository: value.repository, objects: value.objects, s6: value.service.s6, ownerProcessId: "new-owner", isOwnerProcessAlive: (owner) => owner !== "dead-owner" });
  assert.equal(dead.recoverPending(), 1);
  assert.equal(value.repository.state().s7CadJobs?.[0]?.status, "failed_retryable");

  const live = context();
  const liveResult = live.service.createExport(PROJECT_ID, "live-key");
  live.repository.transact((state) => {
    const artifact = state.s7CadExports?.find((item) => item.artifactId === liveResult.export.artifactId)!;
    const job = state.s7CadJobs?.find((item) => item.jobId === artifact.jobId)!;
    const claimToken = "40000000-0000-4000-8000-000000000002" as UUID;
    state.s7CadManifests = state.s7CadManifests?.filter((item) => item.manifestId !== artifact.manifestId);
    state.s7CadReadbackReceipts = state.s7CadReadbackReceipts?.filter((item) => item.artifactId !== artifact.artifactId);
    artifact.manifestHash = null; artifact.readbackReceiptId = null; artifact.readbackHash = null; artifact.sha256 = null; artifact.byteSize = null; artifact.committedAt = null; artifact.staleAt = null; artifact.supersededAt = null; artifact.failureCode = null;
    artifact.status = "running"; artifact.privateStagingStorageKey = s7StagingDxfStorageKey(PROJECT_ID, job.jobId, claimToken); artifact.publicationPhase = "none"; job.status = "running"; job.claimToken = claimToken; job.ownerProcessId = "live-owner"; job.claimedAt = job.updatedAt; job.heartbeatAt = job.updatedAt; job.terminalAt = null;
  });
  const liveService = new S7CadService({ repository: live.repository, objects: live.objects, s6: live.service.s6, ownerProcessId: "new-owner", isOwnerProcessAlive: () => true });
  assert.equal(liveService.recoverPending(), 0);
  assert.equal(live.repository.state().s7CadJobs?.[0]?.status, "running");
});
