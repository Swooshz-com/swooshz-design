import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { handleApiRequest, isS8Path, type ApiRequestDependencies } from "../src/lib/api";
import { S5WorkflowService } from "../src/lib/s5";
import type { StoreState } from "../src/lib/types";
import { jcs } from "../src/lib/utils";
import type { WorkflowService } from "../src/lib/workflow";
import { projectId as productionProjectId, serviceFixture } from "./s8-native-proof.test";

const projectId = "11111111-1111-4111-8111-111111111111";
const preparation = {
  profile: "swooshz-fbx-static-mesh-v1" as const,
  semanticVersion: "swooshz-fbx-semantic-v1" as const,
  sourceRevisionId: "22222222-2222-4222-8222-222222222222",
  sourceRevisionHash: "a".repeat(64),
  objectNames: ["SWZ_0000_a"],
  payloadSha256: "b".repeat(64),
};

function dependencies(allowed = true): ApiRequestDependencies {
  return {
    workflowService: { getS8Preparation: () => preparation } as unknown as WorkflowService,
    s3Authorization: { resolveContext: async () => ({ subjectId: "subject-1" }), authorizeProject: async () => allowed },
  };
}

test("S8 preparation is project-authorized, source-fingerprinted, and read-only", async () => {
  assert.equal(isS8Path(["projects", projectId, "s8"]), true);
  const response = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", projectId, "s8", "handoff"], dependencies());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), preparation);
  const post = await handleApiRequest(new Request("http://local/api", { method: "POST" }), ["projects", projectId, "s8"], dependencies());
  assert.equal(post.status, 405);
});

test("S8 authorization failure does not disclose preparation state", async () => {
  const response = await handleApiRequest(new Request("http://local/api", { method: "GET" }), ["projects", projectId, "s8"], dependencies(false));
  assert.equal(response.status, 404);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "S8_UNAUTHORIZED_OR_NOT_FOUND");
});

type ProductionApiFixture = Awaited<ReturnType<typeof serviceFixture>> & {
  apiDependencies: ApiRequestDependencies;
  artifactId: string;
  idempotencyKey: string;
};

function productionDependencies(
  fixture: Awaited<ReturnType<typeof serviceFixture>>,
  s5?: S5WorkflowService,
): ApiRequestDependencies {
  return {
    workflowService: { ...(s5 ? { s5 } : {}), s8: fixture.service } as unknown as WorkflowService,
    s3Authorization: {
      resolveContext: async () => ({ subjectId: "subject-s8-api-test" }),
      authorizeProject: async (_context, requestedProjectId) => requestedProjectId === productionProjectId,
    },
  };
}

function apiSegments(stage: "s5" | "s8", ...tail: string[]): string[] {
  return ["projects", productionProjectId, stage, ...tail];
}

async function apiCall(
  path: string[],
  apiDependencies: ApiRequestDependencies,
  options: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {},
) {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  return handleApiRequest(new Request("http://local/api", {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), path, apiDependencies);
}

async function createCommittedP06Fixture(): Promise<ProductionApiFixture> {
  const fixture = await serviceFixture();
  try {
    const apiDependencies = productionDependencies(fixture);
    const idempotencyKey = `s8-api-${randomUUID()}`;
    const response = await apiCall(apiSegments("s8", "exports"), apiDependencies, {
      method: "POST", body: {}, idempotencyKey,
    });
    assert.equal(response.status, 201, "the public export API must commit a genuine P06 native lifecycle");
    const created = await response.json() as { export?: { artifactId?: unknown; status?: unknown } };
    assert.equal(created.export?.status, "committed");
    assert.equal(typeof created.export?.artifactId, "string");
    return { ...fixture, apiDependencies, idempotencyKey, artifactId: created.export!.artifactId as string };
  } catch (error) {
    fixture.close();
    throw error;
  }
}

function getExportStatus(fixture: ProductionApiFixture) {
  return apiCall(apiSegments("s8", "exports", fixture.artifactId), fixture.apiDependencies);
}

function postExportReplay(fixture: ProductionApiFixture) {
  return apiCall(apiSegments("s8", "exports"), fixture.apiDependencies, {
    method: "POST", body: {}, idempotencyKey: fixture.idempotencyKey,
  });
}

function getExportDownload(fixture: ProductionApiFixture) {
  return apiCall(apiSegments("s8", "exports", fixture.artifactId, "download"), fixture.apiDependencies);
}

async function assertCommittedStatusControl(fixture: ProductionApiFixture): Promise<void> {
  const response = await getExportStatus(fixture);
  assert.equal(response.status, 200, "P06 must remain visible through the same public status API");
  const artifact = await response.json() as { artifactId?: string; status?: string };
  assert.equal(artifact.artifactId, fixture.artifactId);
  assert.equal(artifact.status, "committed");
}

async function assertGenericIntegrityFailure(response: Response): Promise<void> {
  assert.equal(response.status, 500, "invalid canonical proof must not produce a successful status or replay response");
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, "S8_INTERNAL_ERROR", "the S8 API must hide internal proof-integrity detail");
}

async function mutateCanonicalState(fixture: ProductionApiFixture, mutate: (state: StoreState) => void): Promise<void> {
  const statePath = join(fixture.root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as StoreState;
  mutate(state);
  writeFileSync(statePath, jcs(state), { encoding: "utf8" });
}

async function s5Fence(apiDependencies: ApiRequestDependencies): Promise<Record<string, unknown>> {
  const response = await apiCall(apiSegments("s5"), apiDependencies);
  assert.equal(response.status, 200);
  const state = await response.json() as { fence?: Record<string, unknown> };
  assert.ok(state.fence, "the authorized S5 API must provide the current mutation fence");
  return state.fence;
}

async function postS5Action(
  apiDependencies: ApiRequestDependencies,
  action: "reopen" | "approval" | "layout" | "presentation",
  body: unknown,
): Promise<Response> {
  return apiCall(apiSegments("s5", action), apiDependencies, {
    method: "POST", body, idempotencyKey: randomUUID(),
  });
}

test("G135-N34 rejects forged canonical native progress at the public export-status boundary", async () => {
  const fixture = await createCommittedP06Fixture();
  try {
    await assertCommittedStatusControl(fixture);
    await mutateCanonicalState(fixture, (state) => {
      const writer = state.s8NativeOperationAttempts?.find((attempt) =>
        attempt.projectId === productionProjectId && attempt.artifactId === fixture.artifactId && attempt.operation === "WRITER");
      assert.ok(writer, "the P06 control must include its accepted canonical Writer attempt");
      writer.state = "DISPATCHING";
    });
    await assertGenericIntegrityFailure(await getExportStatus(fixture));
  } finally {
    fixture.close();
  }
});

test("G135-N35 hides orphan committed status from the public export-status boundary", async () => {
  const fixture = await createCommittedP06Fixture();
  try {
    await assertCommittedStatusControl(fixture);
    await mutateCanonicalState(fixture, (state) => {
      const checkpoints = state.s8NativeProofCheckpoints ?? [];
      const committed = checkpoints.filter((checkpoint) => checkpoint.body.kind === "COMMITTED" && checkpoint.body.artifactId === fixture.artifactId);
      assert.equal(committed.length, 1, "the P06 control must contain exactly one committed checkpoint");
      state.s8NativeProofCheckpoints = checkpoints.filter((checkpoint) =>
        checkpoint.body.kind !== "COMMITTED" || checkpoint.body.artifactId !== fixture.artifactId);
    });
    await assertGenericIntegrityFailure(await getExportStatus(fixture));
  } finally {
    fixture.close();
  }
});

test("G135-N36 refuses replay reuse when the committed native pair is incomplete", async () => {
  const fixture = await createCommittedP06Fixture();
  try {
    await assertCommittedStatusControl(fixture);
    const replay = await postExportReplay(fixture);
    assert.equal(replay.status, 200, "the intact P06 idempotency replay is the public reuse control");
    const replayBody = await replay.json() as { replayed?: boolean; export?: { status?: string } };
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.export?.status, "committed");

    await mutateCanonicalState(fixture, (state) => {
      const attempts = state.s8NativeOperationAttempts ?? [];
      const validators = attempts.filter((attempt) =>
        attempt.projectId === productionProjectId && attempt.artifactId === fixture.artifactId && attempt.operation === "VALIDATOR");
      assert.equal(validators.length, 1, "the P06 control must contain one accepted Validator attempt");
      state.s8NativeOperationAttempts = attempts.filter((attempt) => attempt !== validators[0]);
    });
    await assertGenericIntegrityFailure(await postExportReplay(fixture));
  } finally {
    fixture.close();
  }
});

test("G135-N37 never returns FBX bytes after the committed final object is tampered", async () => {
  const fixture = await createCommittedP06Fixture();
  try {
    await assertCommittedStatusControl(fixture);
    const control = await getExportDownload(fixture);
    assert.equal(control.status, 200, "the intact P06 download is the public download control");
    assert.equal(control.headers.get("content-type"), "application/octet-stream");
    const expectedBytes = Buffer.from(await control.arrayBuffer());
    assert.ok(expectedBytes.byteLength > 0);

    const artifact = fixture.repository.state().s8Artifacts?.find((item) => item.artifactId === fixture.artifactId);
    assert.ok(artifact?.privateFinalPrefix, "the committed P06 fixture must identify its real final object prefix");
    const artifactKey = `${artifact.privateFinalPrefix}/artifact.fbx`;
    const canonicalBytes = fixture.objects.read(artifactKey);
    assert.ok(canonicalBytes.byteLength > 0);
    const tamperedBytes = Buffer.from(canonicalBytes);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0xff;
    writeFileSync(join(fixture.objects.root, artifactKey), tamperedBytes);

    const rejected = await getExportDownload(fixture);
    assert.notEqual(rejected.status, 200, "a stale byte-integrity proof cannot authorize download");
    assert.notEqual(rejected.headers.get("content-type"), "application/octet-stream");
    const rejectedBytes = Buffer.from(await rejected.arrayBuffer());
    const error = JSON.parse(rejectedBytes.toString("utf8")) as { error?: { code?: string } };
    assert.equal(error.error?.code, "S8_INTERNAL_ERROR");
    assert.notDeepEqual(rejectedBytes, expectedBytes, "a rejected response must not contain the previously authorized FBX");
  } finally {
    fixture.close();
  }
});

test("G135-N46 refreshes the committed source projection after an S5 approval change", async () => {
  const fixture = await createCommittedP06Fixture();
  try {
    const s5 = new S5WorkflowService({ repository: fixture.repository, objects: fixture.objects });
    fixture.apiDependencies = productionDependencies(fixture, s5);
    await assertCommittedStatusControl(fixture);
    const currentDownload = await getExportDownload(fixture);
    assert.equal(currentDownload.status, 200, "the current P06 source remains downloadable through the same API");
    assert.ok(Buffer.from(await currentDownload.arrayBuffer()).byteLength > 0);

    const beforeReopen = await s5Fence(fixture.apiDependencies);
    const reopened = await postS5Action(fixture.apiDependencies, "reopen", { ...beforeReopen, reopenReason: "user_requested" });
    assert.equal(reopened.status, 200, "the source change must be a real authorized S5 transition");
    const reopenedBody = await reopened.json() as { approval?: { status?: string } };
    assert.equal(reopenedBody.approval?.status, "reopened");

    const beforeApproval = await s5Fence(fixture.apiDependencies);
    const approved = await postS5Action(fixture.apiDependencies, "approval", beforeApproval);
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json() as { approval?: { status?: string } };
    assert.equal(approvedBody.approval?.status, "approved");

    const currentFence = await s5Fence(fixture.apiDependencies);
    const layout = await postS5Action(fixture.apiDependencies, "layout", currentFence);
    assert.equal(layout.status, 200, "the new approval must regain committed layout readiness");
    const presentation = await postS5Action(fixture.apiDependencies, "presentation", currentFence);
    assert.equal(presentation.status, 200, "the new approval must regain committed presentation readiness");

    const staleStatus = await getExportStatus(fixture);
    assert.equal(staleStatus.status, 409, "status must re-read and reject the committed projection after S5 changes");
    const staleStatusBody = await staleStatus.json() as { error?: { code?: string } };
    assert.equal(staleStatusBody.error?.code, "S8_SOURCE_NOT_READY",
      "the fresh S5 approval has no current S6 acceptance, so the committed projection is not ready for status");
    const staleDownload = await getExportDownload(fixture);
    assert.equal(staleDownload.status, 409, "download must re-read and reject the committed projection after S5 changes");
    const staleDownloadBody = await staleDownload.json() as { error?: { code?: string } };
    assert.equal(staleDownloadBody.error?.code, "S8_REUSE_FINGERPRINT_INVALID");
  } finally {
    fixture.close();
  }
});
