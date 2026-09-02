import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { AppError, type UUID } from "../src/lib/types";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import type { WorkflowService } from "../src/lib/workflow";
import { createS6Client, S6Screen, type S6ClientData } from "../app/components/S6Client";

const PROJECT_ID = "40000000-0000-4000-8000-000000000001" as UUID;
const REVISION_ID = "40000000-0000-4000-8000-000000000002" as UUID;
const IDENTITY_KEY = "40000000-0000-4000-8000-000000000003" as UUID;
const REFERENCE_ID = "40000000-0000-4000-8000-000000000004" as UUID;
const SHA = "a".repeat(64);

const TOKEN = {
  expectedRevisionId: REVISION_ID,
  expectedRevisionHash: SHA,
  expectedParentRevisionId: null,
  expectedParentHash: null,
  expectedCurrentAcceptedRevisionId: null,
  expectedCurrentAcceptedHash: null,
  expectedSourceFingerprint: SHA,
};

type StubOptions = {
  generate?: (...args: unknown[]) => unknown;
  getViewDownload?: (...args: unknown[]) => unknown;
  getS7Handoff?: (...args: unknown[]) => unknown;
};

function stubService(options: StubOptions = {}): { service: WorkflowService; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const result = {
    replayed: false,
    revisionId: REVISION_ID,
    revisionHash: SHA,
    status: "generated_draft",
    sourceS5Fingerprint: SHA,
    currentAcceptedRevisionId: null,
    currentAcceptedRevisionHash: null,
    concurrency: TOKEN,
  };
  const s6 = {
    getState: (...args: unknown[]) => { calls.push(["getState", ...args]); return { projectId: PROJECT_ID, source: { readiness: "ready" } }; },
    getRevision: (...args: unknown[]) => { calls.push(["getRevision", ...args]); return { revision: { modelRevisionId: REVISION_ID }, validation: null, views: [] }; },
    generate: async (...args: unknown[]) => { calls.push(["generate", ...args]); return options.generate ? options.generate(...args) : result; },
    reopen: async (...args: unknown[]) => { calls.push(["reopen", ...args]); return result; },
    correct: async (...args: unknown[]) => { calls.push(["correct", ...args]); return result; },
    validate: async (...args: unknown[]) => { calls.push(["validate", ...args]); return { receiptId: REVISION_ID, revisionId: REVISION_ID, revisionHash: SHA, outcome: "pass", errors: [], warnings: [] }; },
    accept: async (...args: unknown[]) => { calls.push(["accept", ...args]); return { ...result, status: "accepted_current", acceptanceEventId: REVISION_ID }; },
    render: async (...args: unknown[]) => { calls.push(["render", ...args]); return { replayed: false, revisionId: REVISION_ID, revisionHash: SHA, sourceS5Fingerprint: SHA, artifactGroupId: REVISION_ID, views: [] }; },
    publish: async (...args: unknown[]) => { calls.push(["publish", ...args]); return { replayed: false, artifactId: REVISION_ID, revisionId: REVISION_ID, revisionHash: SHA, sourceS5Fingerprint: SHA, view: { viewId: "perspective-northwest", status: "committed" } }; },
    getView: (...args: unknown[]) => { calls.push(["getView", ...args]); return { viewId: "perspective-northwest", status: "committed" }; },
    getViewDownload: (...args: unknown[]) => {
      calls.push(["getViewDownload", ...args]);
      return options.getViewDownload ? options.getViewDownload(...args) : { bytes: Buffer.from("<svg/>"), contentType: "image/svg+xml", fileName: "swooshz-spatial-perspective-northwest.svg" };
    },
    getTelemetry: (...args: unknown[]) => { calls.push(["getTelemetry", ...args]); return { schemaVersion: "s6-telemetry-v1", projectId: PROJECT_ID }; },
    getS7Handoff: (...args: unknown[]) => {
      calls.push(["getS7Handoff", ...args]);
      return options.getS7Handoff ? options.getS7Handoff(...args) : { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID };
    },
  };
  return { service: { s6 } as unknown as WorkflowService, calls };
}

function dependencies(service: WorkflowService, authorized = true, events: string[] = []): ApiRequestDependencies {
  return {
    workflowService: service,
    s3Authorization: {
      resolveContext: async () => {
        events.push("context");
        return { subjectId: "s6-api-subject" };
      },
      authorizeProject: async (_context, projectId) => {
        events.push("authorize:" + projectId);
        return authorized && projectId === PROJECT_ID;
      },
    },
  };
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost", {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function streamedJsonRequest(method: string, body: string, headers: Record<string, string> = {}): Request {
  const bytes = Buffer.from(body, "utf8");
  return new Request("http://localhost", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 997) controller.enqueue(bytes.subarray(offset, Math.min(offset + 997, bytes.byteLength)));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

function path(...segments: string[]): string[] {
  return ["projects", PROJECT_ID, "s6", ...segments];
}

function withKey(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...TOKEN, ...extra };
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

test("S6 authorization runs before service construction", async () => {
  let constructed = false;
  const dependenciesWithLazyService = {
    get workflowService() {
      constructed = true;
      return stubService().service;
    },
    s3Authorization: {
      resolveContext: async () => ({ subjectId: "s6-api-subject" }),
      authorizeProject: async () => false,
    },
  } as unknown as ApiRequestDependencies;
  const response = await handleApiRequest(request("GET"), path(), dependenciesWithLazyService);
  assert.equal(response.status, 404);
  assert.equal(constructed, false);
});

test("S6 exact routes reject wrong methods and unknown fields", async () => {
  const service = stubService().service;
  const wrongMethod = await handleApiRequest(request("POST", {}), path(), dependencies(service));
  assert.equal(wrongMethod.status, 405);
  const unknownRoute = await handleApiRequest(request("GET"), path("unknown"), dependencies(service));
  assert.equal(unknownRoute.status, 400);
  const unknownField = await handleApiRequest(
    request("POST", { extra: true }, { "Idempotency-Key": IDENTITY_KEY }),
    path("generation"),
    dependencies(service),
  );
  assert.equal(unknownField.status, 400);
  const body = await json(unknownField);
  assert.equal(body.error.code, "S6_INVALID_REQUEST");
  assert.deepEqual(body.error.fieldErrors, [{ field: "body", code: "UNKNOWN_FIELD" }]);
});

test("S6 JSON bodies stream up to exactly 64000 bytes and reject malformed or oversized input before mutation", async () => {
  let generateCalls = 0;
  const fixture = stubService({
    generate: () => {
      generateCalls += 1;
      return {
        replayed: false,
        revisionId: REVISION_ID,
        revisionHash: SHA,
        status: "generated_draft",
        sourceS5Fingerprint: SHA,
        currentAcceptedRevisionId: null,
        currentAcceptedRevisionHash: null,
        concurrency: TOKEN,
      };
    },
  });
  const auth = dependencies(fixture.service);
  const exactBody = "{}" + " ".repeat(64000 - 2);
  const exact = await handleApiRequest(
    streamedJsonRequest("POST", exactBody, { "Idempotency-Key": IDENTITY_KEY }),
    path("generation"),
    auth,
  );
  assert.equal(exact.status, 202);
  assert.equal(generateCalls, 1);

  const tooLarge = await handleApiRequest(
    streamedJsonRequest("POST", "{}" + " ".repeat(64000 - 1), { "Idempotency-Key": "40000000-0000-4000-8000-000000000005" }),
    path("generation"),
    auth,
  );
  assert.equal(tooLarge.status, 400);
  assert.deepEqual((await json(tooLarge)).error.fieldErrors, [{ field: "body", code: "BODY_TOO_LARGE" }]);
  assert.equal(generateCalls, 1);

  const malformedLength = await handleApiRequest(
    request("POST", {}, { "content-length": "not-a-number", "Idempotency-Key": "40000000-0000-4000-8000-000000000006" }),
    path("generation"),
    auth,
  );
  assert.equal(malformedLength.status, 400);
  assert.deepEqual((await json(malformedLength)).error.fieldErrors, [{ field: "body", code: "BODY_LENGTH_INVALID" }]);
  assert.equal(generateCalls, 1);
});

test("S6 generation correction acceptance render and publish DTOs are exact", async () => {
  const fixture = stubService();
  const auth = dependencies(fixture.service);
  const generation = await handleApiRequest(request("POST", {}, { "Idempotency-Key": IDENTITY_KEY }), path("generation"), auth);
  assert.equal(generation.status, 202);
  const reopen = await handleApiRequest(request("POST", TOKEN, { "Idempotency-Key": "40000000-0000-4000-8000-000000000005" }), path("revisions", REVISION_ID, "reopen"), auth);
  assert.equal(reopen.status, 202);
  const correction = await handleApiRequest(request("POST", withKey({ operations: [] }), { "Idempotency-Key": "40000000-0000-4000-8000-000000000006" }), path("revisions", REVISION_ID, "corrections"), auth);
  assert.equal(correction.status, 202);
  const validation = await handleApiRequest(request("POST", TOKEN, { "Idempotency-Key": "40000000-0000-4000-8000-000000000007" }), path("revisions", REVISION_ID, "validate"), auth);
  assert.equal(validation.status, 200);
  const acceptance = await handleApiRequest(request("POST", TOKEN, { "Idempotency-Key": "40000000-0000-4000-8000-000000000008" }), path("revisions", REVISION_ID, "accept"), auth);
  assert.equal(acceptance.status, 200);
  const render = await handleApiRequest(request("POST", TOKEN, { "Idempotency-Key": "40000000-0000-4000-8000-000000000009" }), path("revisions", REVISION_ID, "render"), auth);
  assert.equal(render.status, 202);
  const publish = await handleApiRequest(request("POST", TOKEN, { "Idempotency-Key": "40000000-0000-4000-8000-00000000000a" }), path("revisions", REVISION_ID, "views", "perspective-northwest", "publish"), auth);
  assert.equal(publish.status, 200);
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["generate", "reopen", "correct", "validate", "accept", "render", "publish"]);
  assert.equal(fixture.calls[0]![4], "s6-api-subject");
  assert.deepEqual(fixture.calls[2]![4], []);
});

test("S6 safe errors expose only reference IDs and allowlisted fields", async () => {
  const fixture = stubService({
    generate: () => {
      throw new AppError(500, "PRIVATE_SECRET_LEAK", [{ field: "storageKey", code: "SECRET_VALUE" }]);
    },
  });
  const response = await handleApiRequest(
    request("POST", {}, { "Idempotency-Key": IDENTITY_KEY, "x-request-id": REFERENCE_ID }),
    path("generation"),
    dependencies(fixture.service),
  );
  assert.equal(response.status, 500);
  const body = await json(response);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "fieldErrors", "message", "referenceId"]);
  assert.equal(body.error.code, "S6_INTERNAL_ERROR");
  assert.equal(body.error.referenceId, REFERENCE_ID);
  assert.deepEqual(body.error.fieldErrors, [{ field: "body", code: "INVALID_REQUEST" }]);
  assert.equal(JSON.stringify(body).includes("PRIVATE_SECRET_LEAK"), false);
  assert.equal(JSON.stringify(body).includes("storageKey"), false);
});

test("S6 view download is private and no-store", async () => {
  const fixture = stubService();
  const response = await handleApiRequest(
    request("GET"),
    path("revisions", REVISION_ID, "views", "perspective-northwest", "download"),
    dependencies(fixture.service),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="swooshz-spatial-perspective-northwest.svg"');
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(bytes.toString("utf8"), "<svg/>");
});

test("S6 stale view download is rejected", async () => {
  const fixture = stubService({
    getViewDownload: () => {
      throw new AppError(409, "S6_STALE_ARTIFACT");
    },
  });
  const response = await handleApiRequest(
    request("GET"),
    path("revisions", REVISION_ID, "views", "perspective-northwest", "download"),
    dependencies(fixture.service),
  );
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.error.code, "S6_STALE_ARTIFACT");
  assert.equal(body.error.message.includes("stale"), false);
});

test("S6 handoff requires the current accepted revision", async () => {
  const fixture = stubService({
    getS7Handoff: () => {
      throw new AppError(409, "S6_ACCEPTANCE_CONFLICT");
    },
  });
  const response = await handleApiRequest(request("GET"), path("handoff"), dependencies(fixture.service));
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.error.code, "S6_ACCEPTANCE_CONFLICT");
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["getS7Handoff"]);
});

test("S6 telemetry and S7 handoff routes return their exact public DTO roots", async () => {
  const fixture = stubService();
  const auth = dependencies(fixture.service);
  const telemetry = await handleApiRequest(request("GET"), path("telemetry"), auth);
  const handoff = await handleApiRequest(request("GET"), path("handoff"), auth);
  assert.equal(telemetry.status, 200);
  assert.equal(handoff.status, 200);
  assert.deepEqual(await json(telemetry), { schemaVersion: "s6-telemetry-v1", projectId: PROJECT_ID });
  assert.deepEqual(await json(handoff), { schemaVersion: "s6-to-s7-handoff-v1", projectId: PROJECT_ID });
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["getTelemetry", "getS7Handoff"]);
});

test("S6 client retains keys through uncertain mutation", async () => {
  const keys: string[] = [];
  let calls = 0;
  const client = createS6Client({
    projectId: PROJECT_ID,
    fetcher: async (_input, init) => {
      calls += 1;
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (calls === 1) throw new Error("network interrupted");
      return new Response(JSON.stringify({ replayed: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await client.generate();
  assert.equal(calls, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(keys[0]);
});

test("S6 editor exposes stable object selection, typed semantic controls, and explicit review", () => {
  const markup = renderToStaticMarkup(createElement(S6Screen, {
    projectId: PROJECT_ID,
    initialData: {
      state: {
        projectId: PROJECT_ID,
        source: { readiness: "ready", sourceS5Fingerprint: SHA, approvalEventId: REVISION_ID, approvalGeneration: 1 },
        currentAcceptedRevisionId: null,
        currentAcceptedRevisionHash: null,
        editableRevision: { revisionId: REVISION_ID, revisionHash: SHA, parentRevisionId: null, status: "corrected_draft", sourceS5Fingerprint: SHA, objectCount: 1, zoneCount: 0, unknownCount: 1, validationOutcome: null, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
        revisions: [],
        views: [{ viewId: "top-orthographic", revisionId: REVISION_ID, status: "staged", purpose: "draft_preview", preservationOutcome: "pass" }],
        concurrency: TOKEN,
      },
      revision: {
        revision: {
          modelRevisionId: REVISION_ID,
          status: "corrected_draft",
          designFormReview: { status: "in_progress", evidenceAssetId: REVISION_ID, evidenceAssetSha256: SHA },
          booth: { widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: 3000 },
          objects: [{
            objectId: "object-counter",
            objectType: "counter",
            role: "furniture",
            label: "Round counter",
            primitive: { kind: "round_prism", radiusMm: 450, heightMm: 1100, localAnchor: "floor" },
            transform: { positionMm: { xMm: 1000, yMm: 0, zMm: 1000 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
            materialIds: ["material-metal"],
            zoneIds: [],
            requirementIds: [],
            unknownIds: ["unknown-form"],
          }],
          materials: [{ materialId: "material-metal", label: "Metal", finishKind: "metal_like", colorHex: "#888888" }],
          unknowns: [{ unknownId: "unknown-form", kind: "design_form", status: "unresolved", fieldPath: "objects[object-counter].primitive" }],
        },
        validation: null,
        views: [],
      },
    },
  }));
  assert.match(markup, /data-object-id="object-counter"/u);
  assert.match(markup, /round_prism/u);
  assert.match(markup, /Radius/u);
  assert.match(markup, /Profile vertices/u);
  assert.match(markup, /Confirm design inference/u);
  assert.match(markup, /Explicit simplification/u);
  assert.match(markup, /Approved reference/u);
  assert.match(markup, /evidenceAssetId/u);
  assert.match(markup, /Generate spatial draft/u);
  assert.match(markup, /Diagnostic draft preview/u);
  assert.ok(markup.includes('src="/api/projects/' + PROJECT_ID + '/s5/hero/download"'));
  assert.match(markup, /Resize selected object/u);
  assert.match(markup, /Map zones and requirements/u);
  assert.match(markup, /Review object IDs/u);
  assert.match(markup, /Review note/u);
  assert.doesNotMatch(markup, /Edit booth width|Edit booth depth|Edit open sides|Edit maximum height|Edit S5 counts|Approve S5/u);
});

test("S6 editor requires a deliberate single-object review decision", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const makeData = (): S6ClientData => ({
    state: {
      projectId: PROJECT_ID,
      source: { readiness: "ready", sourceS5Fingerprint: SHA, approvalEventId: REVISION_ID, approvalGeneration: 1 },
      currentAcceptedRevisionId: null,
      currentAcceptedRevisionHash: null,
      editableRevision: { revisionId: REVISION_ID, revisionHash: SHA, parentRevisionId: null, status: "corrected_draft", sourceS5Fingerprint: SHA, objectCount: 2, zoneCount: 0, unknownCount: 2, validationOutcome: null, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
      revisions: [],
      views: [],
      concurrency: TOKEN,
    },
    revision: {
      revision: {
        modelRevisionId: REVISION_ID,
        status: "corrected_draft",
        designFormReview: { status: "in_progress", evidenceAssetId: REVISION_ID, evidenceAssetSha256: SHA, unresolvedUnknownIds: ["unknown-a", "unknown-b"], reviewedObjectIds: [], explicitSimplificationUnknownIds: [], acceptedByUser: false },
        booth: { widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: 3000 },
        objects: [
          {
            objectId: "object-a",
            objectType: "counter",
            role: "furniture",
            label: "Object A",
            primitive: { kind: "rect_prism", dimensionsMm: { widthMm: 900, depthMm: 600, heightMm: 900 }, localAnchor: "floor" },
            transform: { positionMm: { xMm: 100, yMm: 0, zMm: 100 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
            materialIds: ["material-a"],
            zoneIds: [],
            requirementIds: [],
            unknownIds: ["unknown-a"],
          },
          {
            objectId: "object-b",
            objectType: "counter",
            role: "furniture",
            label: "Object B",
            primitive: { kind: "rect_prism", dimensionsMm: { widthMm: 900, depthMm: 600, heightMm: 900 }, localAnchor: "floor" },
            transform: { positionMm: { xMm: 1200, yMm: 0, zMm: 100 }, rotationMd: { xMd: 0, yMd: 0, zMd: 0 } },
            materialIds: ["material-a"],
            zoneIds: [],
            requirementIds: [],
            unknownIds: ["unknown-b"],
          },
        ],
        materials: [{ materialId: "material-a", label: "Material A", finishKind: "solid_color", colorHex: "#888888" }],
        unknowns: [
          { unknownId: "unknown-a", kind: "design_form", status: "unresolved", fieldPath: "objects[object-a].primitive", question: "Confirm object A." },
          { unknownId: "unknown-b", kind: "design_form", status: "unresolved", fieldPath: "objects[object-b].primitive", question: "Confirm object B." },
        ],
      },
      validation: null,
      views: [],
    },
  } as unknown as S6ClientData);

  let currentData = makeData();
  const corrections: Array<Record<string, any>> = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { operations?: Array<Record<string, any>> };
      const operation = body.operations?.[0];
      if (operation) {
        corrections.push(operation);
        const model = currentData.revision!.revision as any;
        if (operation.kind === "confirm_design_inference") {
          const objectId = operation.objectIds?.[0];
          const object = model.objects.find((item: any) => item.objectId === objectId);
          const unknownId = object?.unknownIds?.[0];
          const unknown = model.unknowns.find((item: any) => item.unknownId === unknownId);
          if (unknown) unknown.status = "resolved";
        }
        if (operation.kind === "resolve_unknown") {
          const unknown = model.unknowns.find((item: any) => item.unknownId === operation.unknownId);
          if (unknown) unknown.status = "resolved";
        }
        const unresolvedIds = model.unknowns.filter((item: any) => item.status === "unresolved").map((item: any) => item.unknownId);
        model.designFormReview.unresolvedUnknownIds = unresolvedIds;
        if (unresolvedIds.length === 0) {
          model.designFormReview.status = "complete";
          model.designFormReview.acceptedByUser = true;
        }
        currentData.state.editableRevision!.unknownCount = unresolvedIds.length;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const payload = input.endsWith("/s6") ? currentData.state : currentData.revision;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(S6Screen, { projectId: PROJECT_ID, initialData: makeData(), fetcher }));
  });
  const failures: string[] = [];
  const require = (condition: boolean, message: string): void => { if (!condition) failures.push(message); };
  const button = (label: string) => renderer!.root.findAllByType("button").find((item) => item.props.children === label)!;
  const objectButton = (objectId: string) => {
    const found = renderer!.root.findAllByType("button").find((item) => item.props["data-object-id"] === objectId);
    assert.ok(found, JSON.stringify(renderer!.root.findAllByType("button").map((item) => item.props)));
    return found;
  };
  const note = () => {
    const found = renderer!.root.findAllByType("textarea").find((item) => item.props["aria-label"] === "Review note");
    assert.ok(found, JSON.stringify({ statuses: (currentData.revision!.revision as any).unknowns, corrections, textareas: renderer!.root.findAllByType("textarea").map((item) => item.props), buttons: renderer!.root.findAllByType("button").map((item) => item.props.children) }));
    return found;
  };
  const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

  require(note().props.value === "", "review note starts blank");
  await act(async () => { note().props.onChange({ target: { value: "" } }); });
  const initialConfirm = button("Confirm design inference");
  require(initialConfirm.props.disabled === true, "blank note cannot confirm");
  if (!initialConfirm.props.disabled) {
    await act(async () => { initialConfirm.props.onClick(); await flush(); });
  }
  require(corrections.length === 0, "blank confirmation does not post");

  await act(async () => { objectButton("object-a").props.onClick(); });
  await act(async () => { note().props.onChange({ target: { value: "Deliberate A decision." } }); });
  await act(async () => { button("Confirm design inference").props.onClick(); await flush(); });
  require(corrections[0]?.kind === "confirm_design_inference", "object A uses design confirmation");
  require(JSON.stringify(corrections[0]?.objectIds) === JSON.stringify(["object-a"]), "object A confirmation sends only A");
  require((currentData.revision!.revision as any).unknowns.find((item: any) => item.unknownId === "unknown-b")?.status === "unresolved", "object B remains unresolved after A");
  require(button("Accept reviewed model").props.disabled === true, "acceptance remains blocked while B is unresolved");

  await act(async () => { objectButton("object-b").props.onClick(); });
  await act(async () => { note().props.onChange({ target: { value: "Deliberate B simplification." } }); });
  await act(async () => { button("Record Explicit simplification").props.onClick(); await flush(); });
  const simplification = corrections[1];
  require(simplification?.kind === "resolve_unknown", "object B uses a separate simplification decision");
  require(simplification?.unknownId === "unknown-b", "simplification binds to selected B unknown");
  require(simplification?.resolutionNote === "Deliberate B simplification.", "simplification uses the deliberate B note");
  require((currentData.revision!.revision as any).unknowns.every((item: any) => item.status === "resolved"), "B is resolved only after its own decision");
  assert.deepEqual(failures, []);
  await act(async () => { renderer!.unmount(); });
});
