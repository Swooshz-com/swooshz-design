import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyS6Corrections } from "../src/lib/s6-correction";
import { buildS6Cameras } from "../src/lib/s6-camera";
import { compileS6Draft } from "../src/lib/s6-compiler";
import { normalizeS6Geometry, normalizeS6Profile } from "../src/lib/s6-canonical";
import { renderS6View } from "../src/lib/s6-renderer";
import { buildS6Telemetry } from "../src/lib/s6-telemetry";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import { privateStorageKey } from "../src/lib/utils";
import { s6ModelStorageKeys, s6ViewStorageKeys } from "../src/lib/s6-publication";
import { makeS6Source, representativeSources } from "./s6-fixture";
import { AppError, type S6SpatialModelRecord, type UUID } from "../src/lib/types";

const PROJECT_ID = "20000000-0000-4000-8000-000000000001" as UUID;
const OTHER_PROJECT_ID = "20000000-0000-4000-8000-000000000099" as UUID;
const REVISION_ID = "30000000-0000-4000-8000-000000000001" as UUID;
const KEY = "30000000-0000-4000-8000-000000000002" as UUID;
const REFERENCE_ID = "30000000-0000-4000-8000-000000000003" as UUID;
const HASH = "a".repeat(64);

function apiRequest(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost", {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function apiPath(projectId = PROJECT_ID, ...segments: string[]): string[] {
  return ["projects", projectId, "s6", ...segments];
}

function apiDependencies(authorized: boolean, service: unknown = { s6: {} }): ApiRequestDependencies {
  return {
    workflowService: service as ApiRequestDependencies["workflowService"],
    s3Authorization: {
      resolveContext: async () => ({ subjectId: "s6-security-subject" }),
      authorizeProject: async (_context, projectId) => authorized && projectId === PROJECT_ID,
    },
  };
}

function draft(source = makeS6Source()): S6SpatialModelRecord {
  return compileS6Draft({ source, revisionId: REVISION_ID, parentRevisionId: null, clock: () => "2026-09-02T00:00:00.000Z" });
}

function physical(model: S6SpatialModelRecord): NonNullable<S6SpatialModelRecord["objects"][number]> {
  const object = model.objects.find((item) => item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
  assert.ok(object);
  return object;
}

test("cross-project IDs never disclose state and private model/view artifacts require authorization", async () => {
  let serviceConstructed = false;
  const unauthorized = {
    get workflowService() {
      serviceConstructed = true;
      return { s6: { getState: () => ({ secret: true }) } };
    },
    s3Authorization: {
      resolveContext: async () => ({ subjectId: "s6-security-subject" }),
      authorizeProject: async () => false,
    },
  } as unknown as ApiRequestDependencies;
  const state = await handleApiRequest(apiRequest("GET"), apiPath(OTHER_PROJECT_ID), unauthorized);
  const download = await handleApiRequest(
    apiRequest("GET"),
    apiPath(OTHER_PROJECT_ID, "revisions", REVISION_ID, "views", "top-orthographic", "download"),
    unauthorized,
  );
  assert.equal(state.status, 404);
  assert.equal(download.status, 404);
  assert.equal(serviceConstructed, false);
});

test("path traversal and user labels cannot escape private keys", () => {
  assert.throws(() => privateStorageKey("projects", "..", "s6"), /Invalid private storage segment/u);
  assert.throws(() => privateStorageKey("projects", "project/escape"), /Invalid private storage segment/u);
  assert.throws(() => s6ModelStorageKeys(PROJECT_ID, "../revision", REVISION_ID, KEY), /Invalid private storage segment/u);
  assert.throws(() => s6ViewStorageKeys(PROJECT_ID, REVISION_ID, "top-orthographic", "job", "..\\claim"), /Invalid private storage segment/u);
  const model = draft();
  const object = physical(model);
  const added = applyS6Corrections(model, [{
    kind: "add",
    objectType: "counter",
    role: "furniture",
    label: "../../not-a-storage-key",
    geometry: { kind: "rect_prism", dimensionsMm: { widthMm: 800, depthMm: 400, heightMm: 900 }, localAnchor: "floor" },
    positionMm: { xMm: 500, yMm: 0, zMm: 500 },
    rotationMd: { xMd: 0, yMd: 0, zMd: 0 },
    material: model.materials[0]!,
    parentObjectId: null,
    zoneIds: object.zoneIds,
    requirementIds: object.requirementIds,
  }], { childRevisionId: REVISION_ID, clock: () => "2026-09-02T00:00:00.000Z", actorSubjectId: "s6-security" });
  assert.equal(added.model.objects.some((item) => item.label.includes("not-a-storage-key")), true);
  assert.equal(s6ModelStorageKeys(PROJECT_ID, REVISION_ID, KEY, REFERENCE_ID).artifactKey.includes("not-a-storage-key"), false);
});

test("profile holes, self-intersections, and oversized vertices fail closed", () => {
  const profile = (vertices: Array<{ xMm: number; zMm: number }>): Parameters<typeof normalizeS6Profile>[0] => ({ winding: "ccw-from-positive-y-v1", vertices });
  assert.throws(() => normalizeS6Profile({ winding: "ccw-from-positive-y-v1", vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 1000 }, { xMm: 0, zMm: 1000 }], holes: [] } as never), /S6_PROFILE_INVALID/u);
  assert.throws(() => normalizeS6Profile(profile([{ xMm: 0, zMm: 0 }, { xMm: 2000, zMm: 2000 }, { xMm: 0, zMm: 2000 }, { xMm: 2000, zMm: 0 }])), /S6_PROFILE_SELF_INTERSECTION/u);
  assert.throws(() => normalizeS6Profile(profile(Array.from({ length: 25 }, (_item, index) => ({ xMm: index * 200, zMm: index % 2 === 0 ? 0 : 2000 })))), /S6_PROFILE_TOO_COMPLEX/u);
  assert.throws(() => normalizeS6Profile(profile([{ xMm: 0, zMm: 0 }, { xMm: 100001, zMm: 0 }, { xMm: 100001, zMm: 1000 }])), /NUMERIC_OUT_OF_BOUNDS/u);
  assert.throws(() => normalizeS6Geometry({ kind: "profile_extrusion", profile: profile([{ xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 1000 }]), heightMm: 900, geometryState: "exact", localAnchor: "floor", path: "M 0 0" } as never), /S6_PROFILE_INVALID|SPATIAL_SCHEMA_INVALID/u);
});

test("SVG rejects scripts, URLs, foreign objects, and client path commands", async () => {
  const model = draft();
  const object = physical(model);
  object.label = '<script src="https://evil.example/x.js">alert(1)</script>';
  const svg = new TextDecoder().decode(renderS6View(model, buildS6Cameras(model)[2]!).svgBytes);
  assert.equal(/<script|foreignObject|href=|xlink:|url\(|javascript:|data:image|onload=|<image/iu.test(svg), false);
  assert.equal(svg.includes("&lt;script"), true);
  const maliciousMaterial = structuredClone(model.materials[0]!);
  maliciousMaterial.notes = "https://evil.example/texture.png";
  assert.throws(() => applyS6Corrections(model, [{ kind: "material", objectId: object.objectId, material: maliciousMaterial }], {
    childRevisionId: REVISION_ID,
    clock: () => "2026-09-02T00:00:00.000Z",
    actorSubjectId: "s6-security",
  }), /S6_CORRECTION_INVALID/u);
  let correctionCalled = false;
  const service = { s6: { correct: async () => { correctionCalled = true; throw new AppError(500, "should_not_run"); } } };
  const body = {
    expectedRevisionId: REVISION_ID,
    expectedRevisionHash: HASH,
    expectedParentRevisionId: null,
    expectedParentHash: null,
    expectedCurrentAcceptedRevisionId: null,
    expectedCurrentAcceptedHash: null,
    expectedSourceFingerprint: HASH,
    operations: [{
      kind: "replace_geometry",
      objectId: object.objectId,
      geometry: {
        kind: "profile_extrusion",
        profile: {
          winding: "ccw-from-positive-y-v1",
          vertices: [{ xMm: 0, zMm: 0 }, { xMm: 1000, zMm: 0 }, { xMm: 1000, zMm: 1000 }],
          path: "M 0 0",
        },
        heightMm: 900,
        localAnchor: "floor",
      },
    }],
  };
  const response = await handleApiRequest(apiRequest("POST", body, { "Idempotency-Key": KEY }), apiPath(PROJECT_ID, "revisions", REVISION_ID, "corrections"), apiDependencies(true, service));
  assert.equal(response.status, 400);
  assert.equal(correctionCalled, false);
});

test("payload, count, and operation limits are enforced", async () => {
  const largeBody = JSON.stringify({ value: "x".repeat(140_000) });
  const oversized = await handleApiRequest(apiRequest("POST", largeBody, { "Idempotency-Key": KEY, "content-type": "application/json" }), apiPath(PROJECT_ID, "generation"), apiDependencies(true, { s6: { generate: async () => ({}) } }));
  assert.equal(oversized.status, 400);
  const token = {
    expectedRevisionId: REVISION_ID,
    expectedRevisionHash: HASH,
    expectedParentRevisionId: null,
    expectedParentHash: null,
    expectedCurrentAcceptedRevisionId: null,
    expectedCurrentAcceptedHash: null,
    expectedSourceFingerprint: HASH,
  };
  const tooMany = await handleApiRequest(
    apiRequest("POST", { ...token, operations: new Array(33).fill({ kind: "remove", objectId: "object" }) }, { "Idempotency-Key": KEY }),
    apiPath(PROJECT_ID, "revisions", REVISION_ID, "corrections"),
    apiDependencies(true, { s6: { correct: async () => ({}) } }),
  );
  assert.equal(tooMany.status, 400);
  const model = draft();
  assert.throws(() => applyS6Corrections(model, new Array(33).fill({ kind: "remove", objectId: physical(model).objectId }), {
    childRevisionId: REVISION_ID,
    clock: () => "2026-09-02T00:00:00.000Z",
    actorSubjectId: "s6-security",
  }), /S6_CORRECTION_TOO_MANY_OPERATIONS/u);
});

test("unsupported form is never boxed and provider/tool costs remain unavailable", () => {
  const source = representativeSources()["unsupported-form-fails-closed"]!;
  const model = compileS6Draft({ source, revisionId: REVISION_ID, parentRevisionId: null, clock: () => "2026-09-02T00:00:00.000Z" });
  assert.equal(model.objects.some((item) => item.objectType === "box"), false);
  assert.equal(model.designFormReview.status, "unsupported");
  assert.equal(model.unknowns.some((item) => item.question.includes("S6_UNSUPPORTED_FORM")), true);
  const telemetry = buildS6Telemetry({ projects: [], briefAssets: [], drafts: [], briefVersions: [], generationRequests: [], generationSets: [], prompts: [], conceptAssets: [], candidates: [], idempotency: [], extractionAttempts: {}, extractionOperations: [], generationOperations: [], s2Assets: [], s2Drafts: [], s2Inputs: [], s2QaRuns: [], s2Repairs: [], s2DerivedCandidates: [], s2ReQaResults: [], s2Operations: [], s2Publications: [], s2Transitions: [], s3Sources: [], s3Selections: [], s3SelectionEvents: [], s3Revisions: [], s3Assets: [], s3Cycles: [], s3ImageOperations: [], s3Assessments: [], s3AssessmentAttempts: [], s3Publications: [], s3Transitions: [], s4Stages: [], s4Masks: [], s4Edits: [], s4Revisions: [], s4Assets: [], s4ImageOperations: [], s4PreservationChecks: [], s4Assessments: [], s4AssessmentAttempts: [], s4Publications: [], s4Transitions: [], s5ApprovalEvents: [], s5Artifacts: [], s6SpatialModels: [], s6ValidationReceipts: [], s6CorrectionEvents: [], s6AcceptanceEvents: [], s6SupersessionEvents: [], s6ViewArtifacts: [], s6ViewPreservationReceipts: [], s6Jobs: [], s6Idempotency: [] }, PROJECT_ID, { readiness: "ready", sourceS5Fingerprint: HASH, approvalEventId: null, approvalGeneration: null });
  assert.deepEqual(telemetry.providerCost, { availability: "unavailable", value: null, reason: "no_provider_used" });
  assert.deepEqual(telemetry.toolCost, { availability: "unavailable", value: null, reason: "no_billed_tool_amount" });
});
