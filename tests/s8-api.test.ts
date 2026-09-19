import assert from "node:assert/strict";
import test from "node:test";
import { handleApiRequest, isS8Path, type ApiRequestDependencies } from "../src/lib/api";
import type { WorkflowService } from "../src/lib/workflow";

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
