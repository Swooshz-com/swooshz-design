import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { handleApiRequest } from "../src/lib/api";
import { compilePrompt, DIRECTIONS, HARD_CONSTRAINT_TEXT, BUILDABILITY_BOUNDARY } from "../src/lib/compiler";
import { validateGeometry, metresToMillimetres } from "../src/lib/geometry";
import { validatePdfUpload } from "../src/lib/media";
import { buildExtractionRequest, buildImageRequest, MockOpenAIProvider, OpenAIProvider } from "../src/lib/openai";
import { briefValidationErrors } from "../src/lib/schema";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";
import type { StructuredBriefData, UserConfirmedBrief } from "../src/lib/types";

function validPdf(pageCount = 1, encrypted = false): Uint8Array {
  const pages = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n");
  const encryption = encrypted ? "/Encrypt 9 0 R" : "";
  return Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >> endobj\n${pages}\ntrailer << /Root 1 0 R ${encryption} >>\nstartxref\n0\n%%EOF\n`, "latin1");
}

function completeBrief(overrides: Partial<StructuredBriefData> = {}): StructuredBriefData {
  return {
    projectFacts: {
      clientName: "Example Client",
      eventName: "Example Expo",
      venueName: "Example Hall",
      eventLocation: "Singapore",
      eventStartDate: "2026-09-01",
      eventEndDate: "2026-09-03",
      notes: "Keep the visitor path obvious.",
    },
    brandStyle: {
      brandName: "Example Brand",
      brandValues: ["clear", "welcoming"],
      visualDirection: "Warm, modern, and calm.",
      preferredColors: ["blue", "white"],
      materials: ["painted timber", "fabric"],
      logoInstructions: "Use the supplied brand lockup if present.",
    },
    functionalRequirements: [
      { name: "Reception counter", count: 1, countIsExact: true, mandatory: true, details: "Visible from the main aisle." },
      { name: "Demo zone", count: null, countIsExact: false, mandatory: false, details: null },
    ],
    mandatoryRequirements: ["Maintain accessible visitor entry."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: 25000, currency: "SGD", basis: "total", notes: null },
    unknowns: [],
    assumptions: [],
    freeTextRequirements: ["Make the main brand moment readable at a distance."],
    extractedGeometryMentions: { widthText: "9m", depthText: "6m", openSidesText: "north and west", maxHeightText: null },
    ...overrides,
  };
}

function newService(provider: MockOpenAIProvider): { service: WorkflowService; root: string } {
  const root = mkdtempSync(join(tmpdir(), "swooshz-design-g3-"));
  return { service: createWorkflowService({ dataRoot: root, provider }), root };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function uuid(): string {
  return randomUUID();
}

test("geometry is mandatory, integer-millimetre based, and canonically oriented", () => {
  assert.equal(metresToMillimetres(6.001), 6001);
  assert.deepEqual(validateGeometry({ widthMm: 6000, depthMm: 3000, openSides: ["west", "north"], maxHeightMm: null }), {
    widthMm: 6000,
    depthMm: 3000,
    openSides: ["north", "west"],
    maxHeightMm: null,
  });
  assert.throws(() => validateGeometry({ widthMm: 6000, depthMm: 3000, openSides: [], maxHeightMm: null }));
  assert.throws(() => validateGeometry({ widthMm: 6, depthMm: 3000, openSides: ["north"], maxHeightMm: null }));
  assert.throws(() => validateGeometry({ widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: 0 }));
});

test("PDF validation enforces type, completeness, encryption, size, and page limits", () => {
  const accepted = validatePdfUpload({ fileName: "..\\brief\u0000.pdf", mimeType: "application/pdf", bytes: validPdf(20) });
  assert.equal(accepted.pageCount, 20);
  assert.match(accepted.originalFileName, /brief\.pdf$/);
  assert.throws(() => validatePdfUpload({ fileName: "brief.docx", mimeType: "application/pdf", bytes: validPdf() }));
  assert.throws(() => validatePdfUpload({ fileName: "brief.pdf", mimeType: "text/plain", bytes: validPdf() }));
  assert.throws(() => validatePdfUpload({ fileName: "brief.pdf", mimeType: "application/pdf", bytes: Buffer.from("not-pdf") }));
  assert.throws(() => validatePdfUpload({ fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf(21) }));
  assert.throws(() => validatePdfUpload({ fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf(1, true) }));
  assert.throws(() => validatePdfUpload({ fileName: "brief.pdf", mimeType: "application/pdf", bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20) }));
});

test("brief-v1 is strict and rejects unknown fields and malformed values", () => {
  const data = completeBrief();
  assert.deepEqual(briefValidationErrors(data), []);
  const withUnknown = { ...data, unexpected: true } as unknown;
  assert.ok(briefValidationErrors(withUnknown).some((error) => error.code === "UNKNOWN_FIELD"));
  const invalidDate = completeBrief({ projectFacts: { ...data.projectFacts, eventStartDate: "2026-02-30" } });
  assert.ok(briefValidationErrors(invalidDate).some((error) => error.code === "ISO_DATE_REQUIRED"));
  const invalidCount = completeBrief({ functionalRequirements: [{ name: "bad", count: null, countIsExact: true, mandatory: false, details: null }] });
  assert.ok(briefValidationErrors(invalidCount).some((error) => error.code === "COUNT_EXACT_REQUIRES_COUNT"));
  const invalidModelAssumption = completeBrief({ assumptions: [{ id: "one", field: "finish", value: "wood", source: "model", requiresConfirmation: true, acceptedByUser: true }] });
  assert.ok(briefValidationErrors(invalidModelAssumption, { extraction: true }).some((error) => error.code === "MODEL_ASSUMPTION_NOT_ACCEPTED"));
});

test("OpenAI request builders preserve the locked provider shapes without a credential", () => {
  const extraction = buildExtractionRequest(validPdf());
  assert.equal(extraction.model, "gpt-5.4-mini-2026-03-17");
  assert.equal(extraction.store, false);
  assert.equal("tools" in extraction, false);
  const input = (extraction.input as any[])[0].content[0];
  assert.equal(input.filename, "brief.pdf");
  assert.equal(input.detail, "high");
  assert.match(input.file_data, /^data:application\/pdf;base64,/);
  assert.equal((extraction.text as any).format.strict, true);
  assert.equal((extraction.text as any).format.schema.additionalProperties, false);
  const image = buildImageRequest("prompt");
  assert.deepEqual(image, { model: "gpt-image-2-2026-04-21", prompt: "prompt", n: 1, size: "1536x1024", quality: "medium" });
  assert.equal("image" in image, false);
  assert.equal("mask" in image, false);
});

test("compiler is deterministic and varies only the fixed direction block", () => {
  const brief: UserConfirmedBrief = {
    briefVersionId: uuid(), projectId: uuid(), versionNumber: 1, sourceAssetId: uuid(), schemaVersion: "brief-v1",
    geometrySnapshot: { widthMm: 6000, depthMm: 3000, openSides: ["north", "west"], maxHeightMm: null },
    data: completeBrief(), contentHash: "0".repeat(64), confirmedAt: "2026-08-25T00:00:00.000Z",
  };
  const first = compilePrompt(brief, DIRECTIONS[0], "2026-08-25T00:00:00.000Z");
  const again = compilePrompt(brief, DIRECTIONS[0], "2026-08-25T00:00:00.000Z");
  const second = compilePrompt(brief, DIRECTIONS[1], "2026-08-25T00:00:00.000Z");
  assert.equal(first.promptText, again.promptText);
  assert.equal(first.compilerMetadata.promptHash, again.compilerMetadata.promptHash);
  assert.ok(first.promptText.includes(HARD_CONSTRAINT_TEXT));
  assert.ok(first.promptText.includes(BUILDABILITY_BOUNDARY));
  assert.notEqual(first.promptText, second.promptText);
  const withoutDirection = (value: string) => value.split("\n").filter((line) => !line.startsWith("directionKey=") && !line.startsWith("directionInstruction=")).join("\n");
  assert.equal(withoutDirection(first.promptText), withoutDirection(second.promptText));
});

test("isolated acceptance flow persists exactly four immutable candidates and leaves geometry authoritative", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief() });
  const { service, root } = newService(provider);
  try {
    const project = service.createProject("  Demo project  ");
    const geometry = service.saveGeometry(project.projectId, { widthMm: 6000, depthMm: 3000, openSides: ["west", "north"], maxHeightMm: null });
    assert.throws(() => service.uploadBrief(project.projectId, uuid(), { fileName: "not-a-brief.pdf", mimeType: "application/pdf", bytes: Buffer.from("not-pdf") }, uuid()));
    assert.equal(service.repository.state().briefAssets.length, 0);
    const upload = service.uploadBrief(project.projectId, uuid(), { fileName: "../../brief.pdf", mimeType: "application/pdf", bytes: validPdf() }, uuid());
    const draft = await service.waitForDraft(project.projectId);
    assert.equal(draft.data.extractedGeometryMentions.widthText, "9m");
    assert.deepEqual(geometry.boothGeometry, { widthMm: 6000, depthMm: 3000, openSides: ["north", "west"], maxHeightMm: null });
    const edited = service.editDraft(project.projectId, { ...draft.data, projectFacts: { ...draft.data.projectFacts, notes: "User-confirmed note" } }, draft.revision);
    const confirmed = service.confirmBrief(project.projectId, draft.briefDraftId, edited.revision, uuid(), uuid());
    assert.deepEqual(confirmed.geometrySnapshot, geometry.boothGeometry);
    const generation = service.createGeneration(project.projectId, uuid(), uuid());
    const ready = await service.waitForGeneration(project.projectId, generation.generationSet.generationSetId);
    assert.equal(provider.imageCalls, 4);
    assert.equal(ready.generationSet.status, "succeeded");
    assert.equal(ready.candidates.length, 4);
    assert.deepEqual(ready.candidates.map((candidate) => [candidate.candidateIndex, candidate.directionKey]), [
      [1, "modular-clarity"], [2, "brand-theatre"], [3, "open-demo"], [4, "hospitality-consultation"],
    ]);
    assert.equal(service.repository.state().prompts.length, 4);
    assert.equal(service.repository.state().conceptAssets.length, 4);
    assert.ok(ready.candidates.every((candidate) => !Object.prototype.hasOwnProperty.call(candidate, "qaStatus")));
    const reloaded = createWorkflowService({ dataRoot: root, provider: new MockOpenAIProvider({ briefData: completeBrief() }) });
    assert.equal(reloaded.getGeneration(project.projectId, generation.generationSet.generationSetId).candidates.length, 4);
    assert.ok(reloaded.repository.state().conceptAssets.every((asset) => reloaded.objects.exists(asset.storageKey)));
    assert.equal(upload.asset.storageKey, `projects/${project.projectId}/briefs/${upload.asset.assetId}.pdf`);
  } finally { cleanup(root); }
});

test("draft revisioning and confirmation gates are enforced", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief({ unknowns: [{ id: "open-question", field: "venue", question: "Confirm venue", critical: true, resolution: null, acceptedByUser: false }] }) });
  const { service, root } = newService(provider);
  try {
    const project = service.createProject(null);
    service.saveGeometry(project.projectId, { widthMm: 4000, depthMm: 4000, openSides: ["north"], maxHeightMm: 3000 });
    service.uploadBrief(project.projectId, uuid(), { fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf() }, uuid());
    const draft = await service.waitForDraft(project.projectId);
    assert.throws(() => service.confirmBrief(project.projectId, draft.briefDraftId, draft.revision, uuid(), uuid()));
    const edited = service.editDraft(project.projectId, { ...draft.data, unknowns: [{ ...draft.data.unknowns[0], resolution: "Hall A", acceptedByUser: false }] }, draft.revision);
    assert.throws(() => service.editDraft(project.projectId, edited.data, draft.revision));
    const confirmed = service.confirmBrief(project.projectId, draft.briefDraftId, edited.revision, uuid(), uuid());
    assert.equal(confirmed.versionNumber, 1);
    assert.throws(() => service.editDraft(project.projectId, edited.data, edited.revision));
    assert.throws(() => service.saveGeometry(project.projectId, { widthMm: 5000, depthMm: 4000, openSides: ["north"], maxHeightMm: 3000 }));
  } finally { cleanup(root); }
});

test("duplicate generation submit is idempotent and does not call the provider again", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief() });
  const { service, root } = newService(provider);
  try {
    const project = service.createProject("Idempotency");
    service.saveGeometry(project.projectId, { widthMm: 5000, depthMm: 5000, openSides: ["east"], maxHeightMm: null });
    service.uploadBrief(project.projectId, uuid(), { fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf() }, uuid());
    const draft = await service.waitForDraft(project.projectId);
    service.confirmBrief(project.projectId, draft.briefDraftId, draft.revision, uuid(), uuid());
    const key = uuid();
    const first = service.createGeneration(project.projectId, key, uuid());
    const duplicate = service.createGeneration(project.projectId, key, uuid());
    assert.equal(duplicate.generationSet.generationSetId, first.generationSet.generationSetId);
    await service.waitForGeneration(project.projectId, first.generationSet.generationSetId);
    assert.equal(provider.imageCalls, 4);
  } finally { cleanup(root); }
});

test("partial image failure publishes no candidates and one retry reruns all four", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief(), imageFailures: new Map([[2, "PROVIDER_TIMEOUT"]]) });
  const { service, root } = newService(provider);
  try {
    const project = service.createProject("Retry");
    service.saveGeometry(project.projectId, { widthMm: 5000, depthMm: 5000, openSides: ["south"], maxHeightMm: null });
    service.uploadBrief(project.projectId, uuid(), { fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf() }, uuid());
    const draft = await service.waitForDraft(project.projectId);
    service.confirmBrief(project.projectId, draft.briefDraftId, draft.revision, uuid(), uuid());
    const first = service.createGeneration(project.projectId, uuid(), uuid());
    await assert.rejects(service.waitForGeneration(project.projectId, first.generationSet.generationSetId));
    assert.equal(service.getGeneration(project.projectId, first.generationSet.generationSetId).candidates.length, 0);
    assert.equal(service.repository.state().conceptAssets.length, 0);
    provider.options.imageFailures = new Map();
    const retry = service.retryGeneration(project.projectId, first.generationSet.generationSetId, uuid(), uuid());
    assert.equal(retry.generationSet.retryOfGenerationSetId, first.generationSet.generationSetId);
    const ready = await service.waitForGeneration(project.projectId, retry.generationSet.generationSetId);
    assert.equal(ready.candidates.length, 4);
    assert.equal(provider.imageCalls, 8);
    assert.throws(() => service.retryGeneration(project.projectId, first.generationSet.generationSetId, uuid(), uuid()));
  } finally { cleanup(root); }
});

test("extraction failure keeps the one asset and allows only one retry", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief(), extractionFailure: "EXTRACTION_REFUSED" });
  const { service, root } = newService(provider);
  try {
    const project = service.createProject("Extraction retry");
    service.saveGeometry(project.projectId, { widthMm: 5000, depthMm: 5000, openSides: ["north"], maxHeightMm: null });
    const upload = service.uploadBrief(project.projectId, uuid(), { fileName: "brief.pdf", mimeType: "application/pdf", bytes: validPdf() }, uuid());
    await assert.rejects(service.waitForDraft(project.projectId));
    assert.equal(service.repository.state().briefAssets.length, 1);
    provider.options.extractionFailure = null;
    const retry = service.retryExtraction(project.projectId, upload.asset.assetId, uuid(), uuid());
    assert.equal(retry.asset.assetId, upload.asset.assetId);
    await service.waitForDraft(project.projectId);
    assert.equal(provider.extractionCalls, 2);
    assert.throws(() => service.retryExtraction(project.projectId, upload.asset.assetId, uuid(), uuid()));
  } finally { cleanup(root); }
});

test("API route shapes use the exact six-slice operations", async () => {
  const provider = new MockOpenAIProvider({ briefData: completeBrief() });
  const { service, root } = newService(provider);
  try {
    const create = await handleApiRequest(new Request("http://localhost/api/projects", { method: "POST", body: JSON.stringify({ name: null }), headers: { "content-type": "application/json" } }), ["projects"], service);
    assert.equal(create.status, 201);
    const project = (await create.json()).project;
    const geometry = await handleApiRequest(new Request(`http://localhost/api/projects/${project.projectId}/geometry`, { method: "PUT", body: JSON.stringify({ widthMm: 6000, depthMm: 3000, openSides: ["north"], maxHeightMm: null }), headers: { "content-type": "application/json" } }), ["projects", project.projectId, "geometry"], service);
    assert.equal(geometry.status, 200);
    const form = new FormData(); form.append("file", new Blob([validPdf()], { type: "application/pdf" }), "brief.pdf");
    const upload = await handleApiRequest(new Request(`http://localhost/api/projects/${project.projectId}/brief`, { method: "POST", body: form, headers: { "Idempotency-Key": uuid() } }), ["projects", project.projectId, "brief"], service);
    assert.equal(upload.status, 202);
    await service.waitForDraft(project.projectId);
  } finally { cleanup(root); }
});

test("client bundle contains no provider credential or server authorization material", () => {
  const client = readFileSync(join(process.cwd(), "app/components/FlowClient.tsx"), "utf8");
  assert.equal(client.includes("OPENAI_API_KEY"), false);
  assert.equal(client.includes("api.openai.com"), false);
  assert.equal(client.includes("authorization"), false);
});
test("the live adapter refuses an unconfigured environment without a fake fallback", async () => {
  const provider = new OpenAIProvider({ apiKey: "" });
  await assert.rejects(provider.extractBrief(validPdf()), (error: any) => error?.safeCode === "PROVIDER_NOT_CONFIGURED");
});
// End of focused G3 acceptance tests.
