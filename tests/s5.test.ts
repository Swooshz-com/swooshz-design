import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AppError, type BoothGeometry, type S5LayoutRequirement, type S5MutationFence, type UUID } from "../src/lib/types";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import { createExactS3FixturePng } from "../src/lib/s3-media";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { compileConceptLayoutPlan, canonicalPlanBytes, canonicalPlanJson, verifyPlanHash, S5_Q16_MAX, type S5LayoutCompilerInput } from "../src/lib/s5-layout";
import { loadApprovedNotoSansFont, pdfPageCount, renderConceptPresentationPdf, S5_NOTO_SANS_SHA256, S5_PDF_HEIGHT, S5_PDF_MAX_BYTES, S5_PDF_MAX_PAGES, S5_PDF_MIN_PAGES, S5_PDF_WIDTH } from "../src/lib/s5-pdf";
import { S5PublicationInterruption, generationContextHash } from "../src/lib/s5";
import type { S4ProviderContract } from "../src/lib/s4-provider";
import { resolveActiveVisualRevision } from "../src/lib/revision-resolver";
import { jcs, sha256 } from "../src/lib/utils";
import { createS5Fixture, cleanupS5Fixture, makeS5Ready, waitFor } from "./s5-fixture";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";

const IDS = {
  projectId: "10000000-0000-4000-8000-000000000001" as UUID,
  generationSetId: "10000000-0000-4000-8000-000000000002" as UUID,
  selectionStateId: "10000000-0000-4000-8000-000000000003" as UUID,
  activeRevisionId: "10000000-0000-4000-8000-000000000004" as UUID,
  approvalEventId: "10000000-0000-4000-8000-000000000005" as UUID,
};

const GEOMETRY: BoothGeometry = {
  widthMm: 9000,
  depthMm: 6000,
  openSides: ["north", "east", "south", "west"],
  maxHeightMm: 3500,
};

function requirement(
  index: number,
  name: string,
  options: Partial<Pick<S5LayoutRequirement, "details" | "mandatory" | "count" | "countIsExact">> = {},
): S5LayoutRequirement {
  return {
    requirementId: `brief.functional.${String(index).padStart(3, "0")}` as S5LayoutRequirement["requirementId"],
    name,
    details: options.details ?? null,
    mandatory: options.mandatory ?? false,
    count: options.count ?? null,
    countIsExact: options.countIsExact ?? false,
  };
}

function compilerInput(requirements: S5LayoutRequirement[], geometry = GEOMETRY): S5LayoutCompilerInput {
  return {
    projectId: IDS.projectId,
    generationSetId: IDS.generationSetId,
    selectionStateId: IDS.selectionStateId,
    selectionVersion: 1,
    activeRevisionId: IDS.activeRevisionId,
    activeRevisionKind: "s3_source",
    approvalEventId: IDS.approvalEventId,
    approvalGeneration: 1,
    approvalEventSequence: 1,
    geometry,
    requirements,
  };
}

function errorCode(error: unknown): string | null {
  return error instanceof AppError ? error.code : error instanceof Error ? error.message : null;
}

function expectCode(action: () => unknown, expected: string): void {
  assert.throws(action, (error: unknown) => errorCode(error) === expected);
}

function fenceWith(fence: S5MutationFence, changes: Partial<S5MutationFence>): S5MutationFence {
  return { ...fence, ...changes };
}

function jsonRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return pages.join("\n");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function editedS4Image(input: Uint8Array): Promise<Buffer> {
  const raw = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 210; y < 510; y += 1) for (let x = 315; x < 760; x += 1) {
    const offset = (y * 1536 + x) * 4;
    raw.data[offset] = Math.min(255, raw.data[offset] + 80);
  }
  return sharp(raw.data, { raw: { width: 1536, height: 1024, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

function s4AssessmentPayload(repository: JsonRepository, confidence: number): Record<string, unknown> {
  const assessment = repository.state().s4Assessments.at(-1);
  if (!assessment) throw new Error("S4 assessment fixture is not persisted");
  return {
    requirements: assessment.canonicalRequirements.map((item) => ({
      requirementId: item.requirementId,
      expected: item.expected,
      expectedCount: item.expectedCount,
      expectedValue: item.expectedValue,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence,
      evidence: "S5 S4 eligibility fixture observation",
    })),
    designRules: assessment.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => ({
      ruleId: item.ruleId,
      observed: "compliant",
      confidence,
      evidence: "S5 S4 eligibility fixture observation",
    })),
    requestedEdit: { outcome: "satisfied", evidence: "The deterministic marked region was updated." },
    overall: { requirementResult: "satisfied", buildabilityResult: "buildable", evidence: "The fixture remains buildable." },
  };
}

function s4ProviderFactory(confidence: number): (repository: JsonRepository, sourceBytes: Buffer) => S4ProviderContract {
  return (repository, _sourceBytes) => ({
    runS4ImageEdit: async (input) => ({ pngBytes: await editedS4Image(input.sourceBytes), providerRequestId: "s5-s4-image-fixture" }),
    runS4Assessment: async () => ({ payload: s4AssessmentPayload(repository, confidence), providerRequestId: "s5-s4-assessment-fixture" }),
  });
}

function pdfInput(plan: ReturnType<typeof compileConceptLayoutPlan>, heroBytes: Uint8Array) {
  return {
    projectName: "Café Concept",
    projectFacts: {
      clientName: "Café Client",
      eventName: "Unicode Showcase",
      venueName: "Synthetic Venue",
      eventLocation: "Singapore",
      eventStartDate: null,
      eventEndDate: null,
    },
    geometry: plan.booth,
    quality: "PASS" as const,
    activeRevisionKind: plan.activeRevisionKind,
    plan,
    requirements: plan.zones.map((zone) => requirement(Number(zone.zoneId.slice(-3)), zone.label, { details: null, mandatory: zone.mandatory, count: zone.count, countIsExact: zone.countIsExact })),
    designRules: [],
    unknowns: plan.unknowns,
    heroBytes,
  };
}

test("S5 concept layout is deterministic and preserves grounded requirements", () => {
  const requirements = [
    requirement(1, "Reception", { details: "Welcome counter", mandatory: true }),
    requirement(2, "Demo table", { details: "Product demonstration", count: 2, countIsExact: true }),
  ];
  const first = compileConceptLayoutPlan(compilerInput(requirements));
  const second = compileConceptLayoutPlan(compilerInput(requirements));

  assert.equal(canonicalPlanJson(first), canonicalPlanJson(second));
  assert.deepEqual(canonicalPlanBytes(first), canonicalPlanBytes(second));
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.coordinateConvention, {
    units: "mm",
    origin: "north-west",
    x: "east",
    y: "south",
    north: "diagram-top-not-surveyed-bearing",
    displaySpace: "normalized-Q16-conceptual",
  });
  assert.deepEqual(first.booth, GEOMETRY);
  assert.deepEqual(first.circulation.map((path) => path.fromOpenSide), ["north", "east", "south", "west"]);
  assert.ok(first.circulation.every((path) => path.widthQ16 === null && path.semantics.includes("not-a-measured-aisle")));
  assert.ok(first.circulation.every((path) => path.startXQ16 >= 0 && path.startXQ16 <= S5_Q16_MAX && path.startYQ16 >= 0 && path.startYQ16 <= S5_Q16_MAX));

  const reception = first.zones.find((zone) => zone.label === "Reception");
  assert.ok(reception);
  assert.equal(reception.placementStatus, "symbolic");
  assert.equal(reception.instances[0]?.status, "placed");
  assert.equal(reception.instances[0]?.symbols[0]?.kind, "counter");
  assert.equal(reception.instances[0]?.symbols[0]?.physicalDimensionsMm, null);
  assert.equal(reception.instances[0]?.symbols[0]?.semantics, "conceptual-zone-marker-not-to-scale");

  const demo = first.zones.find((zone) => zone.label === "Demo table");
  assert.ok(demo);
  assert.equal(demo.count, 2);
  assert.equal(demo.countIsExact, true);
  assert.equal(demo.instances.length, 2);
  assert.ok(demo.instances.every((instance) => instance.mandatory === false && instance.symbols[0]?.kind === "table"));
  assert.ok(first.disclaimers.some((item) => item.includes("No image-pixel inference")));
  assert.ok(first.disclaimers.some((item) => item.includes("3500 mm")));

  const tampered = JSON.parse(JSON.stringify(first)) as typeof first;
  tampered.zones[0]!.instances[0]!.xQ16 = 123;
  expectCode(() => verifyPlanHash(tampered), "S5_PLAN_HASH_MISMATCH");
});

test("S5 layout fails closed for zero-zone, unknown, zero-count, and mandatory overconstraint cases", () => {
  const zero = compileConceptLayoutPlan(compilerInput([]));
  assert.equal(zero.zones.length, 0);
  assert.equal(zero.coverage.length, 0);
  assert.equal(zero.circulation.length, 4);

  const unknown = compileConceptLayoutPlan(compilerInput([requirement(1, "Future activation pod", { mandatory: false })]));
  assert.equal(unknown.zones[0]?.placementStatus, "unknown");
  assert.equal(unknown.zones[0]?.instances[0]?.status, "unplaced");
  assert.equal(unknown.zones[0]?.instances[0]?.xQ16, null);
  assert.equal(unknown.unknowns[0]?.reason, "unknown-semantic");

  const zeroCount = compileConceptLayoutPlan(compilerInput([requirement(1, "Demo table", { count: 0, countIsExact: true })]));
  assert.equal(zeroCount.zones[0]?.placementStatus, "represented");
  assert.equal(zeroCount.zones[0]?.instances.length, 0);

  expectCode(
    () => compileConceptLayoutPlan(compilerInput([requirement(1, "Reception", { count: 9, countIsExact: true, mandatory: true })])),
    "S5_LAYOUT_OVERCONSTRAINED",
  );
});

test("S5 PDF uses the approved font, five sections, A4 pages, searchable Unicode, no dates, and byte determinism", async () => {
  const heroBytes = await createExactS3FixturePng();
  const plan = compileConceptLayoutPlan(compilerInput([
    requirement(1, "Reception", { details: "Welcome counter", mandatory: true }),
    requirement(2, "Demo table", { count: 2, countIsExact: true }),
  ]));
  const fontBytes = await loadApprovedNotoSansFont();
  assert.equal(sha256(fontBytes), S5_NOTO_SANS_SHA256);
  const input = pdfInput(plan, heroBytes);
  const first = await renderConceptPresentationPdf({ ...input, fontBytes });
  const second = await renderConceptPresentationPdf({ ...input, fontBytes });
  assert.deepEqual(first, second);
  assert.equal(sha256(first), sha256(second));
  assert.ok(first.byteLength <= S5_PDF_MAX_BYTES);
  assert.ok(first.byteLength > 0);

  const pageCount = await pdfPageCount(first);
  assert.ok(pageCount >= S5_PDF_MIN_PAGES && pageCount <= S5_PDF_MAX_PAGES);
  const document = await PDFDocument.load(first, { updateMetadata: false });
  assert.equal(document.getPageCount(), pageCount);
  for (const page of document.getPages()) {
    assert.equal(page.getWidth(), S5_PDF_WIDTH);
    assert.equal(page.getHeight(), S5_PDF_HEIGHT);
  }
  const raw = Buffer.from(first).toString("latin1");
  assert.doesNotMatch(raw, /\/(?:CreationDate|ModDate)\s*\(/u);
  const text = await extractPdfText(first);
  for (const heading of ["1. Cover / hero", "2. Project and booth", "3. Confirmed requirements", "4. Concept Layout Plan", "5. Concept-stage verification notes"]) assert.match(text, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(text, /Café/iu);
  assert.match(text, /origin north-west/iu);
  assert.doesNotMatch(readFileSync("src/lib/s5-pdf.ts", "utf8"), /playwright|puppeteer|chromium|printToPDF|wkhtmltopdf/iu);
});

test("S5 PDF overflow is explicit and never silently truncated", async () => {
  const heroBytes = await createExactS3FixturePng();
  const plan = compileConceptLayoutPlan(compilerInput([requirement(1, "Reception", { mandatory: true })]));
  const fontBytes = await loadApprovedNotoSansFont();
  const overflowInput = { ...pdfInput(plan, heroBytes), projectName: Array.from({ length: 800 }, () => "Overflow line").join("\n") };
  await assert.rejects(
    renderConceptPresentationPdf({ ...overflowInput, fontBytes }),
    (error: unknown) => errorCode(error) === "S5_PDF_OVERFLOW",
  );
});

test("S5 approval, frozen context, artifact lifecycle, global generations, downloads, and read-only S6 handoff are enforced", async () => {
  const fixture = await createS5Fixture();
  try {
    await makeS5Ready(fixture);
    const initialFence = fixture.service.s5.getFence(fixture.projectId);
    assert.equal(initialFence.expectedApprovalEventId, null);
    assert.equal(initialFence.expectedApprovalGeneration, 0);
    assert.equal(initialFence.expectedApprovalEventSequence, 0);

    const approvalKey = randomUUID() as UUID;
    const approval = fixture.service.s5.approve(fixture.projectId, initialFence, approvalKey, randomUUID() as UUID);
    assert.equal(approval.replayed, false);
    assert.equal(approval.approval.status, "approved");
    assert.equal(approval.approval.locked, true);
    const approvalEvent = fixture.repository.state().s5ApprovalEvents[0];
    assert.ok(approvalEvent?.generationContext);
    const context = approvalEvent.generationContext;
    assert.equal(approvalEvent.generationContextHash, generationContextHash(context));
    assert.equal(context.selectionVersion, approval.approval.observedSelectionVersion);
    assert.equal(context.activeRevisionId, approval.approval.observedActiveRevisionId);
    assert.equal(context.lineageRootRevisionId, approval.approval.observedLineageRootRevisionId);
    const brief = fixture.repository.state().briefVersions[0];
    const input = fixture.repository.state().s2Inputs[0];
    assert.equal(context.briefContentHash, brief?.contentHash);
    assert.equal(context.geometryHash, input?.geometryHash);
    assert.equal(context.requirementHash, input?.requirementHash);
    assert.equal(context.layoutRequirements[0]?.name, "Reception");
    assert.equal(context.layoutRequirements[0]?.details, "Welcome counter");
    assert.equal(context.layoutRequirements[0]?.mandatory, true);
    assert.equal(context.layoutRequirements[1]?.count, 2);
    assert.equal(context.presentationFactsHash, sha256(jcs(context.presentationFacts)));
    const originalRequirementName = context.layoutRequirements[0]!.name;
    fixture.repository.transact((state) => {
      const event = state.s5ApprovalEvents[0]!;
      event.generationContext!.layoutRequirements[0]!.name = "Tampered projection";
      event.generationContextHash = generationContextHash(event.generationContext!);
    });
    expectCode(() => fixture.service.s5.generateLayout(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID), "S5_FROZEN_CONTEXT_MISMATCH");
    fixture.repository.transact((state) => {
      const event = state.s5ApprovalEvents[0]!;
      event.generationContext!.layoutRequirements[0]!.name = originalRequirementName;
      event.generationContextHash = generationContextHash(event.generationContext!);
    });
    const replay = fixture.service.s5.approve(fixture.projectId, initialFence, approvalKey, randomUUID() as UUID);
    assert.equal(replay.replayed, true);
    assert.equal(fixture.repository.state().s5ApprovalEvents.length, 1);
    expectCode(() => fixture.service.s5.approve(fixture.projectId, fenceWith(initialFence, { expectedSelectionVersion: 2 }), randomUUID() as UUID, randomUUID() as UUID), "S5_APPROVAL_STALE");
    expectCode(() => fixture.service.s5.approve(fixture.projectId, fenceWith(initialFence, { expectedActiveRevisionId: randomUUID() as UUID }), randomUUID() as UUID, randomUUID() as UUID), "S5_APPROVAL_STALE");
    expectCode(() => fixture.service.saveGeometry(fixture.projectId, GEOMETRY), "S5_APPROVAL_LOCKED");
    expectCode(() => fixture.service.s3.refine(fixture.projectId, approval.approval.observedActiveRevisionId!, approval.approval.observedSelectionVersion!, "A locked refinement.", randomUUID() as UUID, randomUUID() as UUID), "S5_APPROVAL_LOCKED");

    const approvedFence = fixture.service.s5.getFence(fixture.projectId);
    const layout = fixture.service.s5.generateLayout(fixture.projectId, approvedFence, randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(layout.replayed, false);
    assert.equal(layout.artifacts.length, 2);
    assert.ok(layout.artifacts.every((artifact) => artifact.status === "committed"));
    const persistedLayout = fixture.repository.state().s5Artifacts.filter((artifact) => artifact.artifactGroupId === layout.artifactGroupId);
    assert.deepEqual(persistedLayout.map((artifact) => artifact.kind).sort(), ["plan_json", "plan_svg"]);
    for (const artifact of persistedLayout) {
      const bytes = fixture.objects.read(artifact.artifactKey);
      assert.equal(sha256(bytes), artifact.outputSha256);
      assert.equal(bytes.byteLength, artifact.outputByteSize);
      assert.equal(fixture.objects.exists(artifact.stagingKey), false);
    }
    assert.deepEqual(fixture.service.s5.getLayout(fixture.projectId, layout.artifactGroupId).artifacts, layout.artifacts);

    const presentation = await fixture.service.s5.generatePresentation(fixture.projectId, approvedFence, randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(presentation.artifacts[0]?.status, "committed");
    assert.ok((presentation.artifacts[0]?.pageCount ?? 0) >= S5_PDF_MIN_PAGES);
    const pdfDownload = fixture.service.s5.getPresentationDownload(fixture.projectId, presentation.artifactId);
    assert.equal(pdfDownload.contentType, "application/pdf");
    assert.equal(pdfDownload.fileName, "swooshz-concept-presentation.pdf");
    assert.ok(pdfDownload.bytes.byteLength > 0);
    const heroDownload = fixture.service.s5.getHeroDownload(fixture.projectId);
    assert.equal(heroDownload.contentType, "image/png");
    assert.equal(heroDownload.fileName, "swooshz-approved-hero.png");
    assert.deepEqual(heroDownload.bytes, fixture.sourceBytes);

    const beforeHandoff = fixture.repository.state().s5Artifacts.length;
    const handoff = fixture.service.s5.getS6ReadOnlyHandoff(fixture.projectId);
    assert.equal(handoff.readOnly, true);
    assert.equal(fixture.repository.state().s5Artifacts.length, beforeHandoff);
    const telemetry = fixture.service.s5.getTelemetry(fixture.projectId);
    assert.equal(telemetry.approvalToPlanMs.availability, "available");
    assert.equal(telemetry.approvalToPdfMs.availability, "available");
    assert.equal(telemetry.providerCost.availability, "unavailable");
    assert.equal(telemetry.providerCost.reason, "actual_billed_amount_unavailable");

    const reopened = fixture.service.s5.reopen(fixture.projectId, approvedFence, randomUUID() as UUID, randomUUID() as UUID, "user_requested");
    assert.equal(reopened.approval.status, "reopened");
    assert.equal(reopened.approval.locked, false);
    assert.equal(reopened.approval.approvalGeneration, 1);
    assert.equal(reopened.approval.eventSequence, 2);
    const reopenedFence = fixture.service.s5.getFence(fixture.projectId);
    assert.equal(reopenedFence.expectedApprovalGeneration, 1);
    assert.equal(reopenedFence.expectedApprovalEventSequence, 2);
    const reapproval = fixture.service.s5.approve(fixture.projectId, reopenedFence, randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(reapproval.approval.approvalGeneration, 2);
    assert.equal(reapproval.approval.eventSequence, 3);
    const events = fixture.repository.state().s5ApprovalEvents;
    assert.deepEqual(events.map((event) => event.kind), ["approved", "reopened", "approved"]);
    assert.deepEqual(events.map((event) => event.approvalGeneration), [1, 1, 2]);
    assert.deepEqual(events.map((event) => event.eventSequence), [1, 2, 3]);
    assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
    assert.equal(fixture.repository.state().s3Selections.length, 1);
    const secondLayout = fixture.service.s5.generateLayout(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.ok(secondLayout.artifacts.every((artifact) => artifact.status === "committed"));
    assert.ok(fixture.repository.state().s5Artifacts.some((artifact) => artifact.artifactGroupId === layout.artifactGroupId));
  } finally {
    cleanupS5Fixture(fixture);
  }
});

test("S5 concurrent approval is compare-and-swap idempotent", async () => {
  const fixture = await createS5Fixture();
  try {
    await makeS5Ready(fixture);
    const fence = fixture.service.s5.getFence(fixture.projectId);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => fixture.service.s5.approve(fixture.projectId, fence, randomUUID() as UUID, randomUUID() as UUID)),
      Promise.resolve().then(() => fixture.service.s5.approve(fixture.projectId, fence, randomUUID() as UUID, randomUUID() as UUID)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && (errorCode(result.reason) === "S5_APPROVAL_LOCKED" || errorCode(result.reason) === "S5_APPROVAL_STALE")).length, 1);
    assert.equal(fixture.repository.state().s5ApprovalEvents.length, 1);
  } finally {
    cleanupS5Fixture(fixture);
  }
});

test("S5 approves the authoritative S3 source and refinement while S4 remains optional/not-started", async () => {
  const fixture = await createS5Fixture();
  try {
    const ready = await makeS5Ready(fixture);
    const sourceRevision = resolveActiveVisualRevision(fixture.repository.state(), fixture.projectId, fixture.objects);
    assert.equal(sourceRevision?.revisionId, ready.sourceRevisionId);
    assert.equal(sourceRevision?.kind, "s3");
    const sourceApproval = fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(sourceApproval.approval.status, "approved");
    const sourceEvent = fixture.repository.state().s5ApprovalEvents.at(-1);
    assert.equal(sourceEvent?.generationContext?.activeRevisionKind, "s3_source");
    assert.equal(fixture.repository.state().s4Stages.length, 0);

    fixture.service.s5.reopen(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    const refinement = fixture.service.s3.refine(fixture.projectId, ready.sourceRevisionId, ready.selectionVersion, "Add an accent to the reception.", randomUUID() as UUID, randomUUID() as UUID);
    await waitFor(() => fixture.service.s3.getCycle(fixture.projectId, refinement.result.cycleId).revision?.kind, (kind) => kind === "refinement");
    const refinedRevision = resolveActiveVisualRevision(fixture.repository.state(), fixture.projectId, fixture.objects);
    assert.equal(refinedRevision?.kind, "s3");
    assert.notEqual(refinedRevision?.revisionId, ready.sourceRevisionId);
    const refinedApproval = fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(refinedApproval.approval.status, "approved");
    const refinedEvent = fixture.repository.state().s5ApprovalEvents.at(-1);
    assert.equal(refinedEvent?.generationContext?.activeRevisionKind, "s3_refinement");
    assert.equal(fixture.repository.state().s4Stages.length, 0);
  } finally {
    cleanupS5Fixture(fixture);
  }
});

test("S5 approves eligible S4 PASS and WARNING final revisions through the unified resolver", async () => {
  for (const variant of [{ confidence: 0.99, editStatus: "usable_pass", quality: "PASS" }, { confidence: 0.74, editStatus: "usable_warning", quality: "WARNING" }] as const) {
    const fixture = await createS5Fixture({ s4ProviderFactory: s4ProviderFactory(variant.confidence) });
    try {
      const ready = await makeS5Ready(fixture);
      const admission = fixture.service.s4.admitEdit(fixture.projectId, {
        baseRevisionId: ready.sourceRevisionId,
        expectedSelectionVersion: ready.selectionVersion,
        primitives: [{ kind: "rectangle", xQ16: 13_107, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }],
        instructionText: "Replace the marked counter finish.",
      }, randomUUID() as UUID, randomUUID() as UUID);
      assert.equal(admission.replayed, false);
      const s4State = await waitFor(() => fixture.service.s4.getState(fixture.projectId), (state) => state.edits[0]?.status === variant.editStatus);
      assert.equal(s4State.activeRevisionKind, "s4");
      assert.equal(s4State.activeQuality, variant.quality);
      const resolved = resolveActiveVisualRevision(fixture.repository.state(), fixture.projectId, fixture.objects);
      assert.equal(resolved?.kind, "s4");
      assert.equal(resolved?.quality, variant.quality);
      const approval = fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
      assert.equal(approval.approval.status, "approved");
      const event = fixture.repository.state().s5ApprovalEvents.at(-1);
      assert.equal(event?.generationContext?.activeRevisionKind, "s4_local_edit");
      assert.equal(event?.generationContext?.quality, variant.quality);
    } finally {
      cleanupS5Fixture(fixture);
    }
  }
});

test("S5 publication recovery handles claim, staging, and promotion interruptions with exact objects", async () => {
  const scenarios: Array<{ phase: string; expectedInterruptedStatus: "running" | "staged" }> = [
    { phase: "claimed", expectedInterruptedStatus: "running" },
    { phase: "after-staging", expectedInterruptedStatus: "staged" },
    { phase: "before-commit", expectedInterruptedStatus: "staged" },
  ];
  for (const scenario of scenarios) {
    let interrupted = false;
    const fixture = await createS5Fixture({
      processId: 56001,
      isProcessAlive: () => true,
      onS5PublicationPhase: (phase) => {
        if (!interrupted && phase === scenario.phase) {
          interrupted = true;
          throw new S5PublicationInterruption();
        }
      },
    });
    try {
      await makeS5Ready(fixture);
      const fence = fixture.service.s5.getFence(fixture.projectId);
      fixture.service.s5.approve(fixture.projectId, fence, randomUUID() as UUID, randomUUID() as UUID);
      const approvedFence = fixture.service.s5.getFence(fixture.projectId);
      assert.throws(() => fixture.service.s5.generateLayout(fixture.projectId, approvedFence, randomUUID() as UUID, randomUUID() as UUID), (error: unknown) => error instanceof S5PublicationInterruption);
      const interruptedArtifacts = fixture.repository.state().s5Artifacts.filter((artifact) => artifact.kind === "plan_json");
      assert.equal(interruptedArtifacts[0]?.status, scenario.expectedInterruptedStatus);
      const recoveredRepository = new JsonRepository(fixture.root, { processId: 56002, isProcessAlive: () => false });
      const recoveredObjects = new PrivateObjectStore(join(fixture.root, "objects"));
      const recovered = createWorkflowService({ repository: recoveredRepository, objects: recoveredObjects, provider: fixture.service.provider, processId: 56002, isProcessAlive: () => false });
      await recovered.s5.recover();
      const complete = await waitFor(() => recovered.s5.getState(fixture.projectId).artifacts, (artifacts) => {
        const latest = ["plan_json", "plan_svg"].map((kind) => artifacts.filter((artifact) => artifact.kind === kind).sort((left, right) => right.attempt - left.attempt)[0]);
        return latest.every((artifact) => artifact?.status === "committed");
      });
      assert.ok(complete.some((artifact) => artifact.kind === "plan_json" && artifact.attempt === 2) || scenario.phase !== "claimed");
      for (const artifact of recoveredRepository.state().s5Artifacts.filter((item) => item.kind === "plan_json" || item.kind === "plan_svg")) {
        if (artifact.status === "committed") {
          const bytes = recoveredObjects.read(artifact.artifactKey);
          assert.equal(sha256(bytes), artifact.outputSha256);
          assert.equal(recoveredObjects.exists(artifact.stagingKey), false);
        }
      }
    } finally {
      cleanupS5Fixture(fixture);
    }
  }
});

test("S5 API authorizes first, returns generic errors, and makes downloads private", async () => {
  const fixture = await createS5Fixture();
  try {
    const path = ["projects", fixture.projectId, "s5"];
    const denied = await handleApiRequest(jsonRequest("GET", "http://localhost/api/projects/" + fixture.projectId + "/s5"), path, fixture.service);
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error.code, "PROJECT_NOT_FOUND");

    const foreignAuthorization: ApiRequestDependencies = {
      workflowService: fixture.service,
      s3Authorization: { resolveContext: async () => ({ subjectId: "subject" }), authorizeProject: async () => false },
    };
    const foreign = await handleApiRequest(jsonRequest("GET", "http://localhost/api/projects/" + fixture.projectId + "/s5"), path, foreignAuthorization);
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).error.code, "PROJECT_NOT_FOUND");

    await makeS5Ready(fixture);
    const authorization: ApiRequestDependencies = {
      workflowService: fixture.service,
      s3Authorization: { resolveContext: async () => ({ subjectId: "subject" }), authorizeProject: async (_context, projectId) => projectId === fixture.projectId },
    };
    const fence = fixture.service.s5.getFence(fixture.projectId);
    const missingKey = await handleApiRequest(jsonRequest("POST", "http://localhost/api/projects/" + fixture.projectId + "/s5/approval", fence), ["projects", fixture.projectId, "s5", "approval"], authorization);
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json()).error.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal(fixture.repository.state().s5ApprovalEvents.length, 0);

    const approval = await handleApiRequest(jsonRequest("POST", "http://localhost/api/projects/" + fixture.projectId + "/s5/approval", fence, { "Idempotency-Key": randomUUID() }), ["projects", fixture.projectId, "s5", "approval"], authorization);
    assert.equal(approval.status, 200);
    const hero = await handleApiRequest(jsonRequest("GET", "http://localhost/api/projects/" + fixture.projectId + "/s5/hero/download"), ["projects", fixture.projectId, "s5", "hero", "download"], authorization);
    assert.equal(hero.status, 200);
    assert.equal(hero.headers.get("content-type"), "image/png");
    assert.equal(hero.headers.get("cache-control"), "private, no-store");
    assert.equal(hero.headers.get("x-content-type-options"), "nosniff");
    assert.equal(hero.headers.get("content-disposition"), 'attachment; filename="swooshz-approved-hero.png"');
    const heroBytes = Buffer.from(await hero.arrayBuffer());
    assert.equal(hero.headers.get("content-length"), String(heroBytes.byteLength));

    const approvedFence = fixture.service.s5.getFence(fixture.projectId);
    const layout = fixture.service.s5.generateLayout(fixture.projectId, approvedFence, randomUUID(), randomUUID());
    const presentation = await fixture.service.s5.generatePresentation(fixture.projectId, approvedFence, randomUUID(), randomUUID());
    const pdf = await handleApiRequest(jsonRequest("GET", "http://localhost/api/projects/" + fixture.projectId + "/s5/presentation/" + presentation.artifactId + "/download"), ["projects", fixture.projectId, "s5", "presentation", presentation.artifactId, "download"], authorization);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.headers.get("cache-control"), "private, no-store");
    assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
    assert.equal(pdf.headers.get("content-disposition"), 'attachment; filename="swooshz-concept-presentation.pdf"');
    assert.equal(pdf.headers.get("content-length"), String((await pdf.clone().arrayBuffer()).byteLength));
    assert.equal(layout.artifacts.length, 2);

    const throwingService = { s5: { getState: () => { throw new Error("private implementation detail"); } } } as unknown as WorkflowService;
    const internal = await handleApiRequest(jsonRequest("GET", "http://localhost/api/projects/" + fixture.projectId + "/s5"), path, { workflowService: throwingService, s3Authorization: authorization.s3Authorization });
    assert.equal(internal.status, 500);
    const internalBody = await internal.json();
    assert.equal(internalBody.error.code, "S5_INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(internalBody), /private implementation detail/iu);
  } finally {
    cleanupS5Fixture(fixture);
  }
});

test("S5 private object publication is exact and no-overwrite", () => {
  const root = mkdtempSync(join(process.cwd(), "s5-object-test-"));
  try {
    const objects = new PrivateObjectStore(join(root, "objects"));
    const key = "projects/10000000-0000-4000-8000-000000000001/s5/exact.bin";
    const staging = "projects/10000000-0000-4000-8000-000000000001/s5/staging.bin";
    const bytes = Buffer.from("approved bytes");
    objects.putExact(key, bytes);
    objects.putExact(key, bytes);
    expectCode(() => objects.putExact(key, Buffer.from("different bytes")), "PERSISTENCE_FAILED");
    objects.put(staging, bytes);
    const final = "projects/10000000-0000-4000-8000-000000000001/s5/final.bin";
    objects.promoteExact(staging, final, bytes);
    objects.promoteExact(staging, final, bytes);
    expectCode(() => objects.promoteExact(staging, final, Buffer.from("different bytes")), "PUBLICATION_OBJECT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
