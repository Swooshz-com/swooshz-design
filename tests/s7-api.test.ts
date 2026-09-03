import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleApiRequest, isS7Path, type ApiRequestDependencies } from "../src/lib/api";
import type { S7CadPublicExport, S7Telemetry, S7ToS8Handoff, S7PublicState, UUID } from "../src/lib/types";
import type { WorkflowService } from "../src/lib/workflow";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "40000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

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
