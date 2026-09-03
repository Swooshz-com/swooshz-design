import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleApiRequest, isS7Path, type ApiRequestDependencies } from "../src/lib/api";
import type { Project, S6ToS7Handoff, S7CadPublicExport, S7Telemetry, S7ToS8Handoff, S7PublicState, UUID } from "../src/lib/types";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S7CadService } from "../src/lib/s7-cad";
import { s7StagingDxfStorageKey } from "../src/lib/s7-persistence";
import type { WorkflowService } from "../src/lib/workflow";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "40000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const MOVED_REVISION_ID = "30000000-0000-4000-8000-000000000099" as UUID;
const MOVED_HASH = "b".repeat(64);

const exportRecord = { schemaVersion: "s7-cad-export-v1", artifactId: ARTIFACT_ID, projectId: PROJECT_ID, jobId: "40000000-0000-4000-8000-000000000003", source: { sourceRevisionId: "30000000-0000-4000-8000-000000000001", sourceRevisionHash: HASH, sourceS5Fingerprint: HASH, validationReceiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, s6HandoffSchemaVersion: "s6-to-s7-handoff-v1", handoffDigest: HASH }, inputHash: HASH, dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", format: "dxf", mimeType: "application/dxf", downloadFileName: "swooshz-s7-plan.dxf", status: "committed", publicationPhase: "committed", attempt: 1, retryOfArtifactId: null, manifestId: "40000000-0000-4000-8000-000000000004", manifestHash: HASH, readbackReceiptId: "40000000-0000-4000-8000-000000000005", readbackHash: HASH, sha256: HASH, byteSize: 42, failureCode: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z", committedAt: "2026-09-03T00:00:00.000Z", staleAt: null, supersededAt: null } as unknown as S7CadPublicExport;
const state: S7PublicState = { projectId: PROJECT_ID, source: { readiness: "ready", sourceRevisionId: exportRecord.source.sourceRevisionId, sourceRevisionHash: HASH, sourceS5Fingerprint: HASH }, exports: [exportRecord] };
const telemetry: S7Telemetry = { schemaVersion: "s7-telemetry-v1", projectId: PROJECT_ID, sourceReadiness: { availability: "available", value: "ready", reason: null }, exportCount: { availability: "available", value: 1, reason: null }, committedExportCount: { availability: "available", value: 1, reason: null }, retryCount: { availability: "available", value: 0, reason: null }, staleCount: { availability: "available", value: 0, reason: null }, supersededCount: { availability: "available", value: 0, reason: null }, failedCount: { availability: "available", value: 0, reason: null }, readbackPassCount: { availability: "available", value: 1, reason: null }, committedDxfByteSize: { availability: "available", value: 42, reason: null }, generatedAt: "2026-09-03T00:00:00.000Z" };
const handoff: S7ToS8Handoff = { schemaVersion: "s7-to-s8-handoff-v1", projectId: PROJECT_ID as UUID, sourceRevisionId: exportRecord.source.sourceRevisionId as UUID, sourceRevisionHash: HASH, sourceS5Fingerprint: HASH, s7ArtifactId: ARTIFACT_ID as UUID, s7ArtifactHash: HASH, s7ArtifactByteSize: 42, manifestId: exportRecord.manifestId as UUID, manifestHash: HASH, readbackReceiptId: exportRecord.readbackReceiptId as UUID, readbackHash: HASH, dxfVersion: "s7-dxf-r2000-ascii-v1", worldToPlanVersion: "s7-world-to-plan-v1", coordinateConvention: "booth-local-right-handed-v1", dxfIsNot3DAuthority: true, s8MustReadAcceptedS6Model: true };

function service(): WorkflowService {
  return { s7: { getState: () => state, getExport: () => exportRecord, getTelemetry: () => telemetry, getHandoff: () => handoff, createExport: (_projectId: UUID, key: string) => ({ replayed: false, export: { ...exportRecord, status: key === "human-key" ? "committed" : "queued" }, job: { jobId: exportRecord.jobId as UUID, status: "committed", attempt: 1 } }), download: () => ({ bytes: Buffer.from("DXF"), contentType: "application/dxf", fileName: "swooshz-s7-plan.dxf" }) } } as unknown as WorkflowService;
}

function dependencies(overrides: Partial<ApiRequestDependencies> = {}): ApiRequestDependencies {
  return { workflowService: service(), s3Authorization: { resolveContext: async () => ({ subjectId: "subject-1" }), authorizeProject: async () => true }, ...overrides };
}

async function json(response: Response): Promise<Record<string, unknown>> { return await response.json() as Record<string, unknown>; }

function actualHandoff(revisionId: UUID = "30000000-0000-4000-8000-000000000001", revisionHash = HASH): S6ToS7Handoff {
  const object = {
    objectId: "object-1", identityKey: "object-1", parentObjectId: null, objectType: "box", role: "furniture",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, geometryState: "exact", localAnchor: "floor" },
    footprint: { kind: "rectangle", widthMm: 1000, depthMm: 500 }, transform: { positionMm: { xMm: 100, yMm: 200, zMm: 300 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
    boundsMm: { widthMm: 1000, depthMm: 500, heightMm: 900 }, zoneIds: [], requirementIds: [], materialIds: [], unknownIds: [],
    provenance: { kind: "confirmed_project_input", sourceRef: "fixture", sourceFingerprint: HASH, acceptedByUser: true, note: null },
  };
  return { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID, acceptedRevisionId: revisionId, acceptedRevisionHash: revisionHash, sourceS5Fingerprint: HASH, spatialSchemaVersion: "s6-spatial-model-v1", units: "millimetres", coordinateConvention: { version: "booth-local-right-handed-v1", units: "millimetres", handedness: "right-handed", origin: "north-west-floor-corner", xAxis: "east", yAxis: "up", zAxis: "south" }, booth: { widthMm: 6000, depthMm: 3000, openSides: ["north", "east"], maxHeightMm: 3000, heightState: "known" }, objects: [object], hierarchy: [{ objectId: "object-1", parentObjectId: null }], zones: [], requirements: [], materials: [], assumptions: [], unknowns: [], validationReceipt: { receiptId: "30000000-0000-4000-8000-000000000002", validationHash: HASH, outcome: "pass" }, eligibility: { currentAccepted: true, sourceCurrent: true, stale: false } } as unknown as S6ToS7Handoff;
}

function actualProject(): Project {
  return { projectId: PROJECT_ID as UUID, name: "S7 API fixture", status: "geometry_ready", boothGeometry: null, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: null, activeGenerationSetId: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" };
}

function apiDependencies(s7: S7CadService): ApiRequestDependencies {
  return {
    workflowService: { s7 } as unknown as WorkflowService,
    s3Authorization: { resolveContext: async () => ({ subjectId: "subject-1" }), authorizeProject: async () => true },
  };
}

function actualContext(failAttempts: ReadonlySet<number> = new Set()) {
  const root = mkdtempSync(join(tmpdir(), "s7-api-"));
  const repository = new JsonRepository(root);
  repository.transact((state) => { state.projects.push(actualProject()); });
  const objects = new PrivateObjectStore(join(root, "objects"));
  let current = actualHandoff();
  const s6 = { getS7Handoff: () => structuredClone(current) };
  const service = new S7CadService({
    repository,
    objects,
    s6: s6 as never,
    ownerProcessId: "api-owner",
    onPublicationPhase: (phase, details) => {
      if (phase === "generation" && failAttempts.has(details.attempt)) throw new Error("controlled failure");
    },
  });
  return { repository, objects, s6, service, move(next: S6ToS7Handoff) { current = next; } };
}

async function postExport(service: S7CadService, key: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await handleApiRequest(new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: "{}" }), ["projects", PROJECT_ID, "s7", "exports"], apiDependencies(service));
  return { response, body: await json(response) };
}

function responseCode(body: Record<string, unknown>): string | null {
  const error = body.error;
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

function forceOwnedAttemptOne(value: ReturnType<typeof actualContext>, ownerProcessId: string): void {
  value.repository.transact((state) => {
    const artifact = state.s7CadExports?.[0];
    const job = artifact ? state.s7CadJobs?.find((item) => item.jobId === artifact.jobId) : undefined;
    assert.ok(artifact && job);
    const claimToken = "40000000-0000-4000-8000-000000000009" as UUID;
    state.s7CadManifests = state.s7CadManifests?.filter((item) => item.manifestId !== artifact!.manifestId);
    state.s7CadReadbackReceipts = state.s7CadReadbackReceipts?.filter((item) => item.artifactId !== artifact!.artifactId);
    artifact!.manifestHash = null; artifact!.readbackReceiptId = null; artifact!.readbackHash = null; artifact!.sha256 = null; artifact!.byteSize = null; artifact!.committedAt = null; artifact!.staleAt = null; artifact!.supersededAt = null; artifact!.failureCode = null;
    artifact!.status = "running"; artifact!.privateStagingStorageKey = s7StagingDxfStorageKey(PROJECT_ID, job!.jobId, claimToken); artifact!.publicationPhase = "none";
    job!.status = "running"; job!.claimToken = claimToken; job!.ownerProcessId = ownerProcessId; job!.claimedAt = job!.updatedAt; job!.heartbeatAt = job!.updatedAt; job!.terminalAt = null;
  });
}

test("S7 path recognition and exact route surface", async () => {
  assert.equal(isS7Path(["projects", PROJECT_ID, "s7"]), true);
  assert.equal(isS7Path(["projects", PROJECT_ID, "s6"]), false);
  const get = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7"], dependencies());
  assert.equal(get.status, 200);
  assert.deepEqual(await json(get), state);
  const telemetryResponse = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7", "telemetry"], dependencies());
  assert.equal(telemetryResponse.status, 200);
  const handoffResponse = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7", "handoff"], dependencies());
  assert.equal(handoffResponse.status, 200);
  assert.deepEqual(await json(handoffResponse), handoff);
});

test("POST accepts opaque non-UUID Idempotency-Key with exact empty JSON and returns fixed metadata", async () => {
  const response = await handleApiRequest(new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "human-key" }, body: "{}" }), ["projects", PROJECT_ID, "s7", "exports"], dependencies());
  assert.equal(response.status, 201);
  const body = await json(response);
  assert.equal(JSON.stringify(body).includes("privateFinalStorageKey"), false);
  assert.equal(JSON.stringify(body).includes("privateStagingStorageKey"), false);
  const badBody = await handleApiRequest(new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "human-key" }, body: JSON.stringify({ extra: true }) }), ["projects", PROJECT_ID, "s7", "exports"], dependencies());
  assert.equal(badBody.status, 400);
});

test("auth happens before service construction or existence/artifact disclosure", async () => {
  let touched = false;
  const denied: ApiRequestDependencies = { get workflowService() { touched = true; throw new Error("must not construct"); }, s3Authorization: { resolveContext: async () => null, authorizeProject: async () => false } } as unknown as ApiRequestDependencies;
  const response = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7", "exports", ARTIFACT_ID], denied);
  assert.equal(response.status, 404);
  assert.equal(touched, false);
  const body = await json(response);
  assert.equal(JSON.stringify(body).includes(ARTIFACT_ID), false);
});

test("download uses fixed filename/content type and handoff route does not accept an artifact path", async () => {
  const response = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7", "exports", ARTIFACT_ID, "download"], dependencies());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/dxf");
  assert.match(response.headers.get("content-disposition") ?? "", /swooshz-s7-plan\.dxf/u);
  const invalid = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", PROJECT_ID, "s7", "handoff", ARTIFACT_ID], dependencies());
  assert.equal(invalid.status, 400);
});

test("exact-key POST reaches attempt 2 after retryable attempt-1 failure and replays attempt 2", async () => {
  const value = actualContext(new Set([1]));
  const first = await postExport(value.service, "api-retry-success");
  assert.equal(first.response.status, 500);
  assert.equal(value.repository.state().s7CadExports?.[0]?.status, "failed_retryable");

  const retry = await postExport(value.service, "api-retry-success");
  assert.equal(retry.response.status, 201);
  const stateAfterRetry = value.repository.state();
  const attemptTwo = stateAfterRetry.s7CadExports?.find((item) => item.attempt === 2)!;
  assert.equal(attemptTwo.status, "committed");
  assert.equal((retry.body.export as Record<string, unknown>).artifactId, attemptTwo.artifactId);
  assert.equal((retry.body.job as Record<string, unknown>).attempt, 2);
  assert.equal(stateAfterRetry.s7CadIdempotency?.[0]?.artifactId, attemptTwo.artifactId);
  assert.equal(stateAfterRetry.s7CadIdempotency?.[0]?.jobId, attemptTwo.jobId);
  assert.equal(stateAfterRetry.s7CadExports?.length, 2);
  assert.equal(stateAfterRetry.s7CadJobs?.length, 2);
  assert.equal(stateAfterRetry.s7CadExports?.some((item) => Number(item.attempt) === 3), false);

  const replay = await postExport(value.service, "api-retry-success");
  assert.equal(replay.response.status, 200);
  assert.equal((replay.body as Record<string, unknown>).replayed, true);
  assert.equal((replay.body.export as Record<string, unknown>).artifactId, attemptTwo.artifactId);
  assert.equal(value.repository.state().s7CadExports?.length, 2);
  assert.equal(value.repository.state().s7CadJobs?.length, 2);
});

test("exact-key POST reaches attempt 2 failure and terminal replay never creates attempt 3", async () => {
  const value = actualContext(new Set([1, 2]));
  const first = await postExport(value.service, "api-retry-terminal");
  assert.equal(first.response.status, 500);
  const retry = await postExport(value.service, "api-retry-terminal");
  assert.equal(retry.response.status, 202);
  const stateAfterRetry = value.repository.state();
  const attemptTwo = stateAfterRetry.s7CadExports?.find((item) => item.attempt === 2)!;
  assert.equal(attemptTwo.status, "failed_terminal");
  assert.equal(stateAfterRetry.s7CadJobs?.find((item) => item.jobId === attemptTwo.jobId)?.terminalAt !== null, true);
  assert.equal(stateAfterRetry.s7CadIdempotency?.[0]?.artifactId, attemptTwo.artifactId);
  assert.equal(stateAfterRetry.s7CadExports?.length, 2);
  assert.equal(stateAfterRetry.s7CadJobs?.length, 2);

  const replay = await postExport(value.service, "api-retry-terminal");
  assert.equal(replay.response.status, 200);
  assert.equal((replay.body as Record<string, unknown>).replayed, true);
  assert.equal((replay.body.export as Record<string, unknown>).artifactId, attemptTwo.artifactId);
  assert.equal((replay.body.export as Record<string, unknown>).status, "failed_terminal");
  assert.equal(value.repository.state().s7CadExports?.length, 2);
  assert.equal(value.repository.state().s7CadJobs?.length, 2);
  assert.equal(value.repository.state().s7CadExports?.some((item) => Number(item.attempt) === 3), false);
});

test("dead-owner recovery leaves uncertain ownership alone, then exact-key POST reaches attempt 2", async () => {
  const value = actualContext();
  const first = await postExport(value.service, "api-recovery-retry");
  assert.equal(first.response.status, 201);
  forceOwnedAttemptOne(value, "dead-owner");

  const uncertain = new S7CadService({ repository: value.repository, objects: value.objects, s6: value.s6 as never, ownerProcessId: "uncertain-check", isOwnerProcessAlive: () => { throw new Error("liveness unavailable"); } });
  assert.equal(uncertain.recoverPending(), 0);
  assert.equal(value.repository.state().s7CadJobs?.[0]?.status, "running");

  const recovered = new S7CadService({ repository: value.repository, objects: value.objects, s6: value.s6 as never, ownerProcessId: "recovery-owner", isOwnerProcessAlive: (owner) => owner !== "dead-owner" });
  assert.equal(recovered.recoverPending(), 1);
  assert.equal(value.repository.state().s7CadJobs?.[0]?.status, "failed_retryable");
  const retry = await postExport(recovered, "api-recovery-retry");
  assert.equal(retry.response.status, 201);
  const state = value.repository.state();
  const attemptTwo = state.s7CadExports?.find((item) => item.attempt === 2)!;
  assert.equal(attemptTwo.status, "committed");
  assert.equal(state.s7CadIdempotency?.[0]?.artifactId, attemptTwo.artifactId);
  assert.equal(state.s7CadExports?.length, 2);
  assert.equal(state.s7CadJobs?.length, 2);
});

test("source movement before exact-key retry fails closed without creating attempt 2", async () => {
  const value = actualContext(new Set([1]));
  const first = await postExport(value.service, "api-retry-source-move");
  assert.equal(first.response.status, 500);
  const firstArtifactId = value.repository.state().s7CadExports?.[0]?.artifactId;
  value.move(actualHandoff(MOVED_REVISION_ID, MOVED_HASH));

  const retry = await postExport(value.service, "api-retry-source-move");
  assert.equal(retry.response.status, 409);
  assert.equal(responseCode(retry.body), "S7_IDEMPOTENCY_CONFLICT");
  const state = value.repository.state();
  assert.equal(state.s7CadExports?.length, 1);
  assert.equal(state.s7CadJobs?.length, 1);
  assert.equal(state.s7CadExports?.[0]?.artifactId, firstArtifactId);
  assert.equal(state.s7CadExports?.[0]?.status, "failed_retryable");
  assert.equal(state.s7CadIdempotency?.[0]?.artifactId, firstArtifactId);
});
