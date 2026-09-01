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
import { compileConceptLayoutPlan, canonicalPlanBytes, canonicalPlanJson, layoutS5Label, validatePlanGeometry, verifyPlanHash, S5_MAX_INSTANCES_PER_REQUIREMENT, S5_MAX_PLACED_INSTANCES, S5_MAX_REQUIREMENT_ITEMS, S5_MAX_ZONE_CANDIDATES, S5_Q16_CIRCULATION_BAND_END, S5_Q16_CIRCULATION_BAND_START, S5_Q16_MAX, S5_Q16_MIN_GUTTER, S5_Q16_OUTER_MARGIN, type S5LayoutCompilerInput } from "../src/lib/s5-layout";
import { loadApprovedNotoSansFont, pdfPageCount, renderConceptPresentationPdf, S5_NOTO_SANS_SHA256, S5_PDF_HEIGHT, S5_PDF_MAX_BYTES, S5_PDF_MAX_PAGES, S5_PDF_MIN_PAGES, S5_PDF_WIDTH } from "../src/lib/s5-pdf";
import { renderConceptLayoutSvg } from "../src/lib/s5-svg";
import { S5PublicationInterruption, generationContextHash, validateCurrentS5Approval } from "../src/lib/s5";
import { validateS5Graph } from "../src/lib/s5-persistence";
import { buildS5Telemetry } from "../src/lib/s5-telemetry";
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

function rehashPlan(plan: ReturnType<typeof compileConceptLayoutPlan>): ReturnType<typeof compileConceptLayoutPlan> {
  const copy = JSON.parse(JSON.stringify(plan)) as ReturnType<typeof compileConceptLayoutPlan>;
  const unsigned = JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
  delete unsigned.planHash;
  copy.planHash = sha256(jcs(unsigned));
  return copy;
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

async function assertPdfTextBounds(bytes: Uint8Array): Promise<void> {
  const task = getDocument({ data: new Uint8Array(bytes), disableAutoFetch: true, disableStream: true, stopAtErrors: true, useWasm: false, useWorkerFetch: false, verbosity: 0 });
  try {
    const document = await task.promise;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        assert.ok(x >= -0.5 && x + item.width <= viewport.width + 0.5);
        assert.ok(y >= -1 && y + item.height <= viewport.height + 1);
      }
    }
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

test("S5 layout allocates globally in mandatory-first order and enforces every accepted cap", () => {
  const requirements = [
    requirement(1, "Display wall"),
    requirement(3, "Reception", { mandatory: true }),
    requirement(2, "Demo table", { mandatory: true, count: 2, countIsExact: true }),
  ];
  const first = compileConceptLayoutPlan(compilerInput(requirements));
  const reversed = compileConceptLayoutPlan(compilerInput(requirements.slice().reverse()));
  assert.deepEqual(first.zones.map((zone) => zone.requirementIds[0]), ["brief.functional.002", "brief.functional.003", "brief.functional.001"]);
  assert.deepEqual(canonicalPlanBytes(first), canonicalPlanBytes(reversed));
  const placed = first.zones.flatMap((zone) => zone.instances.filter((instance) => instance.status === "placed"));
  assert.equal(placed.length, 4);
  for (let leftIndex = 0; leftIndex < placed.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < placed.length; rightIndex += 1) {
    const left = placed[leftIndex]!; const right = placed[rightIndex]!;
    assert.ok(left.xQ16! + left.widthQ16! <= right.xQ16! || right.xQ16! + right.widthQ16! <= left.xQ16! || left.yQ16! + left.heightQ16! <= right.yQ16! || right.yQ16! + right.heightQ16! <= left.yQ16!);
  }
  assert.ok(first.zones.every((zone) => zone.instances.every((instance) => instance.widthQ16 === null || instance.widthQ16 >= 4_096)));
  assert.equal(first.circulation.length, 4);

  const optionalFirst = compileConceptLayoutPlan(compilerInput([
    requirement(1, "Demo table"),
    requirement(999, "Reception", { mandatory: true }),
  ]));
  assert.equal(optionalFirst.zones[0]?.requirementIds[0], "brief.functional.999");

  const optionalOverflow = compileConceptLayoutPlan(compilerInput([
    requirement(1, "Demo table", { count: 9, countIsExact: true }),
  ]));
  assert.equal(optionalOverflow.zones[0]?.instances.length, S5_MAX_INSTANCES_PER_REQUIREMENT);
  assert.equal(optionalOverflow.zones[0]?.placementReason, "optional_overflow");
  assert.ok(optionalOverflow.unknowns.some((item) => item.reason === "optional-overflow"));

  const capacity = compileConceptLayoutPlan(compilerInput([
    requirement(1, "Reception", { count: 8, countIsExact: true }),
    requirement(2, "Demo table", { count: 8, countIsExact: true }),
    requirement(3, "Display wall"),
  ]));
  assert.equal(capacity.zones.flatMap((zone) => zone.instances.filter((instance) => instance.status === "placed")).length, S5_MAX_PLACED_INSTANCES);
  assert.equal(capacity.zones.find((zone) => zone.requirementIds[0] === "brief.functional.003")?.placementStatus, "unplaced");
  assert.equal(capacity.coverage.find((item) => item.requirementId === "brief.functional.003")?.reason, "optional_overflow");
  expectCode(() => compileConceptLayoutPlan(compilerInput([
    requirement(1, "Reception", { mandatory: true, count: 8, countIsExact: true }),
    requirement(2, "Demo table", { mandatory: true, count: 8, countIsExact: true }),
    requirement(3, "Display wall", { mandatory: true }),
  ])), "S5_LAYOUT_OVERCONSTRAINED");

  const thirtyTwoUnknown = Array.from({ length: S5_MAX_ZONE_CANDIDATES }, (_, index) => requirement(index + 1, "Future activation pod"));
  const exactZoneCap = compileConceptLayoutPlan(compilerInput(thirtyTwoUnknown));
  assert.equal(exactZoneCap.zones.length, S5_MAX_ZONE_CANDIDATES);
  const thirtyThreeOptional = compileConceptLayoutPlan(compilerInput([...thirtyTwoUnknown, requirement(33, "Future activation pod")]));
  assert.equal(thirtyThreeOptional.zones.length, S5_MAX_ZONE_CANDIDATES);
  assert.equal(thirtyThreeOptional.coverage.find((item) => item.requirementId === "brief.functional.033")?.status, "unplaced");
  assert.equal(thirtyThreeOptional.coverage.find((item) => item.requirementId === "brief.functional.033")?.reason, "optional_overflow");
  assert.ok(thirtyThreeOptional.unknowns.some((item) => item.requirementId === "brief.functional.033" && item.reason === "optional-overflow"));
  expectCode(() => compileConceptLayoutPlan(compilerInput(Array.from({ length: S5_MAX_ZONE_CANDIDATES + 1 }, (_, index) => requirement(index + 1, "Future activation pod", { mandatory: true })))), "S5_LAYOUT_OVERCONSTRAINED");

  const exactRequirementCap = compileConceptLayoutPlan(compilerInput(Array.from({ length: S5_MAX_REQUIREMENT_ITEMS }, (_, index) => requirement(index + 1, "Future activation pod"))));
  assert.equal(exactRequirementCap.coverage.length, S5_MAX_REQUIREMENT_ITEMS);
  expectCode(() => compileConceptLayoutPlan(compilerInput(Array.from({ length: S5_MAX_REQUIREMENT_ITEMS + 1 }, (_, index) => requirement(index + 1, "Future activation pod")))), "S5_LAYOUT_INPUT_INVALID");
});

test("S5 full placement grid proves outer margin, gutter, circulation exclusion, and no overlap", () => {
  const plan = compileConceptLayoutPlan(compilerInput(Array.from({ length: S5_MAX_PLACED_INSTANCES }, (_, index) => requirement(index + 1, "Demo table"))));
  const placed = plan.zones.flatMap((zone) => zone.instances.filter((instance) => instance.status === "placed"));
  assert.equal(placed.length, S5_MAX_PLACED_INSTANCES);
  for (const instance of placed) {
    assert.ok(instance.xQ16! >= S5_Q16_OUTER_MARGIN);
    assert.ok(instance.yQ16! >= S5_Q16_OUTER_MARGIN);
    assert.ok(instance.xQ16! + instance.widthQ16! <= 65_536 - S5_Q16_OUTER_MARGIN);
    assert.ok(instance.yQ16! + instance.heightQ16! <= 65_536 - S5_Q16_OUTER_MARGIN);
    assert.ok(instance.xQ16! + instance.widthQ16! <= S5_Q16_CIRCULATION_BAND_START || instance.xQ16! >= S5_Q16_CIRCULATION_BAND_END);
  }
  for (let leftIndex = 0; leftIndex < placed.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < placed.length; rightIndex += 1) {
    const left = placed[leftIndex]!;
    const right = placed[rightIndex]!;
    const xOverlap = left.xQ16! < right.xQ16! + right.widthQ16! && right.xQ16! < left.xQ16! + left.widthQ16!;
    const yOverlap = left.yQ16! < right.yQ16! + right.heightQ16! && right.yQ16! < left.yQ16! + left.heightQ16!;
    const xGap = left.xQ16! >= right.xQ16! + right.widthQ16! ? left.xQ16! - (right.xQ16! + right.widthQ16!) : right.xQ16! - (left.xQ16! + left.widthQ16!);
    const yGap = left.yQ16! >= right.yQ16! + right.heightQ16! ? left.yQ16! - (right.yQ16! + right.heightQ16!) : right.yQ16! - (left.yQ16! + left.heightQ16!);
    assert.equal(xOverlap && yOverlap, false);
    if (xOverlap) assert.ok(yGap >= S5_Q16_MIN_GUTTER);
    if (yOverlap) assert.ok(xGap >= S5_Q16_MIN_GUTTER);
    if (!xOverlap && !yOverlap) assert.ok(xGap >= S5_Q16_MIN_GUTTER && yGap >= S5_Q16_MIN_GUTTER);
  }
});

test("S5 invalid margin, gutter, and collision geometry fails closed", () => {
  const base = compileConceptLayoutPlan(compilerInput([requirement(1, "Demo table"), requirement(2, "Reception")]));
  const margin = JSON.parse(JSON.stringify(base)) as typeof base;
  margin.zones[0]!.instances[0]!.xQ16 = S5_Q16_OUTER_MARGIN - 1;
  expectCode(() => validatePlanGeometry(margin), "S5_LAYOUT_OVERCONSTRAINED");
  expectCode(() => verifyPlanHash(rehashPlan(margin)), "S5_LAYOUT_OVERCONSTRAINED");

  const gutter = JSON.parse(JSON.stringify(base)) as typeof base;
  const first = gutter.zones[0]!.instances[0]!;
  const second = gutter.zones[1]!.instances[0]!;
  second.xQ16 = first.xQ16! + first.widthQ16!;
  expectCode(() => validatePlanGeometry(gutter), "S5_LAYOUT_OVERCONSTRAINED");

  const collision = JSON.parse(JSON.stringify(base)) as typeof base;
  collision.zones[1]!.instances[0]!.xQ16 = collision.zones[0]!.instances[0]!.xQ16;
  collision.zones[1]!.instances[0]!.yQ16 = collision.zones[0]!.instances[0]!.yQ16;
  expectCode(() => verifyPlanHash(rehashPlan(collision)), "S5_LAYOUT_OVERCONSTRAINED");
});

test("S5 maximum-length labels are bounded deterministically without truncation", () => {
  const maximumLabel = "A".repeat(80);
  expectCode(() => layoutS5Label(maximumLabel), "S5_LAYOUT_OVERCONSTRAINED");
  expectCode(() => compileConceptLayoutPlan(compilerInput([requirement(1, maximumLabel)])), "S5_LAYOUT_OVERCONSTRAINED");
  const boundedLabel = "Reception desk";
  const lines = layoutS5Label(boundedLabel);
  assert.equal(lines.join(""), boundedLabel);
  assert.ok(lines.length <= 3);
});

test("S5 SVG bounds maximum unknown coverage and remains byte deterministic", () => {
  const plan = compileConceptLayoutPlan(compilerInput(Array.from({ length: S5_MAX_ZONE_CANDIDATES }, (_, index) => requirement(index + 1, "Future activation pod"))));
  const first = renderConceptLayoutSvg(plan);
  const second = renderConceptLayoutSvg(plan);
  assert.deepEqual(first, second);
  assert.equal(sha256(first), sha256(second));
  const svg = first.toString("utf8");
  assert.match(svg, /id="unplaced-panel"/u);
  assert.equal((svg.match(/data-status="unplaced"/gu) ?? []).length, S5_MAX_ZONE_CANDIDATES);
  assert.doesNotMatch(svg, /y="808"/u);
  for (const match of svg.matchAll(/\b(?:x|x1|x2)="([0-9]+(?:\.[0-9]+)?)"/gu)) assert.ok(Number(match[1]) >= 0 && Number(match[1]) <= 1_200);
  for (const match of svg.matchAll(/\b(?:y|y1|y2)="([0-9]+(?:\.[0-9]+)?)"/gu)) assert.ok(Number(match[1]) >= 0 && Number(match[1]) <= 800);
  const disclaimerY = Number(svg.match(/<text id="disclaimer"[^>]*\by="([0-9.]+)"/u)?.[1]);
  const nonDisclaimerTextY = Array.from(svg.matchAll(/<text\b[^>]*\by="([0-9.]+)"[^>]*>/gu)).filter((match) => !match[0].includes('id="disclaimer"')).map((match) => Number(match[1]));
  assert.ok(nonDisclaimerTextY.every((value) => value < disclaimerY));
  assert.doesNotMatch(svg, /<script|https?:\/\/(?!www\.w3\.org\/2000\/svg)|on[a-z]+="/iu);
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
  assert.match(text, /Demo table 1/iu);
  assert.match(text, /origin north-west/iu);
  await assertPdfTextBounds(first);
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
    assert.equal(approval.approval.approvalEventId, approval.approval.approvalId);
    const approvalEvent = fixture.repository.state().s5ApprovalEvents[0];
    assert.equal(approvalEvent?.priorApprovalEventId, null);
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
    assert.equal(context.layoutRendererVersion, "s5-concept-layout-v1");
    assert.equal(context.svgRendererVersion, "s5-layout-svg-v1");
    assert.equal(context.pdfRendererVersion, "s5-presentation-pdf-v1");
    const source = fixture.repository.state().s3Sources[0]!;
    assert.deepEqual(context.sourceQualityEvidence, { kind: "s3_source", sourceSnapshotId: source.sourceSnapshotId, sourceRevisionId: context.activeRevisionId, sourceBindingHash: source.sourceBindingHash, status: context.quality, verdictRecordId: source.canonicalSourceBinding.eligibilityResultId });
    const originalRequirementName = context.layoutRequirements[0]!.name;
    fixture.repository.transact((state) => {
      const event = state.s5ApprovalEvents[0]!;
      event.generationContext!.layoutRequirements[0]!.name = "Tampered projection";
      event.generationContextHash = generationContextHash(event.generationContext!);
      for (const artifact of state.s5Artifacts) artifact.generationContextHash = event.generationContextHash;
    });
    expectCode(() => fixture.service.s5.generateLayout(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID), "S5_FROZEN_CONTEXT_MISMATCH");
    fixture.repository.transact((state) => {
      const event = state.s5ApprovalEvents[0]!;
      event.generationContext!.layoutRequirements[0]!.name = originalRequirementName;
      event.generationContextHash = generationContextHash(event.generationContext!);
      for (const artifact of state.s5Artifacts) artifact.generationContextHash = event.generationContextHash;
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
    const pdfText = await extractPdfText(pdfDownload.bytes);
    const forbiddenPdfValues = [
      fixture.projectId,
      fixture.generationSetId,
      context.selectionStateId,
      context.activeRevisionId,
      context.lineageRootRevisionId,
      approvalEvent!.eventId,
      approvalEvent!.generationContextHash,
      context.activeAssetId,
      context.activeAssetStorageKey,
      context.activeAssetSha256,
      context.sourceQualityEvidence.verdictRecordId,
      context.sourceQualityEvidence.kind === "s3_source" ? context.sourceQualityEvidence.sourceBindingHash : null,
      layout.planHash,
      ...layout.artifacts.map((artifact) => artifact.artifactId),
      ...fixture.repository.state().s5Artifacts
        .filter((artifact) => artifact.artifactGroupId === layout.artifactGroupId || artifact.artifactId === presentation.artifactId)
        .map((artifact) => artifact.outputSha256),
      presentation.artifactId,

    ].filter((value): value is string => value !== null);
    for (const internalValue of forbiddenPdfValues) assert.equal(pdfText.includes(internalValue), false);
    const heroDownload = fixture.service.s5.getHeroDownload(fixture.projectId);
    assert.equal(heroDownload.contentType, "image/png");
    assert.equal(heroDownload.fileName, "swooshz-approved-hero.png");
    assert.deepEqual(heroDownload.bytes, fixture.sourceBytes);

    const beforeHandoff = fixture.repository.state().s5Artifacts.length;
    const handoff = fixture.service.s5.getS6ReadOnlyHandoff(fixture.projectId);
    assert.equal(handoff.readOnly, true);
    assert.equal(handoff.schemaVersion, "s5-to-s6-handoff-v1");
    assert.deepEqual(handoff.rendererVersions, { layout: "s5-concept-layout-v1", svg: "s5-layout-svg-v1", pdf: "s5-presentation-pdf-v1" });
    assert.equal((handoff.layout as { rendererVersion: string }).rendererVersion, "s5-concept-layout-v1");
    assert.equal((handoff.layout as { svgRendererVersion: string }).svgRendererVersion, "s5-layout-svg-v1");
    assert.equal((handoff.presentation as { rendererVersion: string }).rendererVersion, "s5-presentation-pdf-v1");
    const handoffTelemetry = handoff.telemetry as Record<string, { availability: string; value: unknown; reason: string | null }>;
    assert.equal(handoffTelemetry.generationCount?.availability, "available");
    assert.equal(handoffTelemetry.providerCost?.availability, "unavailable");
    assert.equal(JSON.stringify(handoffTelemetry).includes(context.activeRevisionId), false);
    assert.equal(fixture.repository.state().s5Artifacts.length, beforeHandoff);
    const telemetry = fixture.service.s5.getTelemetry(fixture.projectId);
    const firstAcceptance = telemetry.firstTimeToAcceptedConceptMs;
    assert.equal(telemetry.approvalCount.value, 1);
    assert.equal(telemetry.reopenCount.value, 0);
    assert.equal(telemetry.acceptedRevision.availability, "available");
    assert.equal(telemetry.approvalToPlanMs.availability, "available");
    assert.equal(telemetry.approvalToPdfMs.availability, "available");
    assert.equal(telemetry.providerCost.availability, "unavailable");
    assert.equal(telemetry.providerCost.reason, "actual_billed_amount_unavailable");

    const reopened = fixture.service.s5.reopen(fixture.projectId, approvedFence, randomUUID() as UUID, randomUUID() as UUID, "user_requested");
    assert.equal(reopened.approval.status, "reopened");
    assert.equal(reopened.approval.locked, false);
    assert.equal(reopened.approval.approvalGeneration, 1);
    assert.equal(reopened.approval.eventSequence, 2);
    const reopenedEvents = fixture.repository.state().s5ApprovalEvents;
    assert.equal(reopenedEvents[1]?.priorApprovalEventId, reopenedEvents[0]?.eventId);
    assert.equal(reopenedEvents[1]?.approvalId, reopenedEvents[0]?.eventId);
    const originalApprovedEvent = JSON.stringify(reopenedEvents[0]);
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
    assert.equal(events[2]?.priorApprovalEventId, null);
    assert.equal(events[2]?.approvalId, events[2]?.eventId);
    assert.notEqual(events[2]?.approvalId, events[0]?.approvalId);
    assert.equal(events[2]?.approvalGeneration, events[0]!.approvalGeneration + 1);
    const brokenGraph = structuredClone(fixture.repository.state());
    brokenGraph.s5ApprovalEvents[1]!.priorApprovalEventId = randomUUID() as UUID;
    assert.throws(() => validateS5Graph(brokenGraph));
    assert.equal(JSON.stringify(events[0]), originalApprovedEvent);
    assert.equal(fixture.service.s5.getTelemetry(fixture.projectId).firstTimeToAcceptedConceptMs.value, firstAcceptance.value);
    assert.equal(fixture.repository.state().s3Selections.length, 1);
    const secondLayout = fixture.service.s5.generateLayout(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.throws(() => fixture.repository.transact((state) => { state.s5ApprovalEvents[1]!.priorApprovalEventId = randomUUID() as UUID; }), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
    assert.ok(secondLayout.artifacts.every((artifact) => artifact.status === "committed"));
    assert.ok(fixture.repository.state().s5Artifacts.some((artifact) => artifact.artifactGroupId === layout.artifactGroupId));
  } finally {
    cleanupS5Fixture(fixture);
  }
});

test("S5 telemetry reports every accepted family with truthful zero and unavailable semantics", async () => {
  const fixture = await createS5Fixture();
  try {
    await makeS5Ready(fixture);
    const approval = fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    const telemetry = fixture.service.s5.getTelemetry(fixture.projectId);
    const requiredMetrics = [
      "conceptGenerationLatencyMs", "queueInclusiveGenerationDurationMs", "generationCount", "regenerationCount", "qaFailureCounts", "s2RepairCount",
      "refinementAdmittedCount", "successfulRefinementCount", "localEditCount", "editSuccessCount", "editFailureCount", "editFailureCategories",
      "planFailureCount", "planRetryCount", "pdfFailureCount", "pdfRetryCount", "approvalCount", "reopenCount", "committedArtifactLatencyMs",
      "terminalFailureLatencyMs", "firstTimeToAcceptedConceptMs", "acceptedRevision", "providerCost", "totalProjectGenerationCost",
    ] as const;
    for (const key of requiredMetrics) assert.ok(key in telemetry);
    assert.equal(telemetry.generationCount.value, 1);
    assert.equal(telemetry.regenerationCount.value, 0);
    assert.equal(telemetry.conceptGenerationLatencyMs.availability, "unavailable");
    assert.equal(telemetry.conceptGenerationLatencyMs.reason, "no_completed_generation_operation");
    assert.equal(telemetry.queueInclusiveGenerationDurationMs.value, 0);
    assert.equal(telemetry.qaFailureCounts.value?.total, 0);
    assert.equal(telemetry.s2RepairCount.value, 0);
    assert.equal(telemetry.refinementAdmittedCount.value, 0);
    assert.equal(telemetry.successfulRefinementCount.value, 0);
    assert.equal(telemetry.localEditCount.value, 0);
    assert.equal(telemetry.editSuccessCount.value, 0);
    assert.equal(telemetry.editFailureCount.value, 0);
    assert.deepEqual(telemetry.editFailureCategories.value, {});
    assert.equal(telemetry.planFailureCount.value, 0);
    assert.equal(telemetry.planRetryCount.value, 0);
    assert.equal(telemetry.pdfFailureCount.value, 0);
    assert.equal(telemetry.pdfRetryCount.value, 0);
    assert.equal(telemetry.approvalCount.value, 1);
    assert.equal(telemetry.reopenCount.value, 0);
    assert.equal(telemetry.committedArtifactLatencyMs.availability, "unavailable");
    assert.equal(telemetry.terminalFailureLatencyMs.availability, "unavailable");
    assert.equal(telemetry.firstTimeToAcceptedConceptMs.availability, "available");
    assert.equal(telemetry.acceptedRevision.availability, "available");
    assert.equal(telemetry.providerCost.availability, "unavailable");
    assert.equal(telemetry.totalProjectGenerationCost.reason, "actual_billed_amount_unavailable");

    fixture.repository.transact((state) => {
      state.generationOperations.push({
        generationSetId: state.generationSets[0]!.generationSetId,
        projectId: fixture.projectId as UUID,
        attempt: 1,
        status: "succeeded",
        claimedBy: null,
        claimedProcessId: null,
        claimToken: null,
        claimedAt: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        startedAt: "1970-01-01T00:00:00.001Z",
        completedAt: "1970-01-01T00:00:00.004Z",
        failureCode: null,
      });
    });
    const measured = fixture.service.s5.getTelemetry(fixture.projectId);
    assert.equal(measured.conceptGenerationLatencyMs.value, 3);
    assert.equal(measured.queueInclusiveGenerationDurationMs.value, 0);

    const reQaState = JSON.parse(JSON.stringify(fixture.repository.state())) as ReturnType<typeof fixture.repository.state>;
    const initialQa = reQaState.s2QaRuns[0]!.candidateResults[0]!;
    reQaState.s2ReQaResults.push({ ...initialQa, id: randomUUID() as UUID, qaRunId: reQaState.s2QaRuns[0]!.id, phase: "re_qa", derivedCandidateId: randomUUID() as UUID, repairAttemptId: randomUUID() as UUID, status: "warning" });
    const reQaTelemetry = buildS5Telemetry(reQaState, fixture.projectId as UUID);
    assert.equal(reQaTelemetry.qaFailureCounts.availability, "available");
    assert.equal(reQaTelemetry.qaFailureCounts.value?.categories["s2.warning"], 1);

    const malformed = JSON.parse(JSON.stringify(fixture.repository.state())) as ReturnType<typeof fixture.repository.state>;
    malformed.generationOperations[0]!.completedAt = "1969-12-31T23:59:59.999Z";
    const malformedTelemetry = buildS5Telemetry(malformed, fixture.projectId as UUID);
    assert.equal(malformedTelemetry.conceptGenerationLatencyMs.availability, "unavailable");
    assert.equal(malformedTelemetry.conceptGenerationLatencyMs.reason, "malformed_interval");
    assert.equal(malformedTelemetry.generationCount.value, 1);
    assert.equal(malformedTelemetry.queueInclusiveGenerationDurationMs.value, 0);

    const corruptQa = JSON.parse(JSON.stringify(fixture.repository.state())) as ReturnType<typeof fixture.repository.state>;
    corruptQa.s2QaRuns[0]!.candidateResults[0]!.status = "corrupt" as never;
    const corruptTelemetry = buildS5Telemetry(corruptQa, fixture.projectId as UUID);
    assert.equal(corruptTelemetry.qaFailureCounts.availability, "unavailable");
    assert.equal(corruptTelemetry.qaFailureCounts.reason, "qa_source_invalid");
    assert.equal(corruptTelemetry.generationCount.value, 1);
    assert.equal(approval.approval.status, "approved");
  } finally {
    cleanupS5Fixture(fixture);
  }
});
test("S5 stale approvals fail closed on state, hero, layout, PDF, and S6 reads", async () => {
  const fixture = await createS5Fixture();
  try {
    await makeS5Ready(fixture);
    fixture.service.s5.approve(fixture.projectId, fixture.service.s5.getFence(fixture.projectId), randomUUID() as UUID, randomUUID() as UUID);
    const fence = fixture.service.s5.getFence(fixture.projectId);
    const layout = fixture.service.s5.generateLayout(fixture.projectId, fence, randomUUID() as UUID, randomUUID() as UUID);
    const presentation = await fixture.service.s5.generatePresentation(fixture.projectId, fence, randomUUID() as UUID, randomUUID() as UUID);
    const originalContext = JSON.parse(JSON.stringify(fixture.repository.state().s5ApprovalEvents[0]!.generationContext));
    const failClosed = (): void => {
      assert.equal(fixture.service.s5.getState(fixture.projectId).approval.status, "stale");
      assert.equal(fixture.service.s5.getHeroStatus(fixture.projectId).available, false);
      const allowed = new Set(["S5_APPROVAL_STALE", "S5_FROZEN_CONTEXT_MISMATCH", "S5_APPROVED_ASSET_CORRUPT"]);
      assert.throws(() => fixture.service.s5.getHeroDownload(fixture.projectId), (error: unknown) => error instanceof AppError && allowed.has(error.code));
      assert.throws(() => fixture.service.s5.getLayout(fixture.projectId, layout.artifactGroupId), (error: unknown) => error instanceof AppError && allowed.has(error.code));
      assert.throws(() => fixture.service.s5.getPresentation(fixture.projectId, presentation.artifactId), (error: unknown) => error instanceof AppError && allowed.has(error.code));
      assert.throws(() => fixture.service.s5.getPresentationDownload(fixture.projectId, presentation.artifactId), (error: unknown) => error instanceof AppError && allowed.has(error.code));
      assert.throws(() => fixture.service.s5.getS6ReadOnlyHandoff(fixture.projectId), (error: unknown) => error instanceof AppError && allowed.has(error.code));
    };
    const tamperContext = (mutate: (context: NonNullable<typeof originalContext>) => void): void => {
      fixture.repository.transact((state) => {
        const event = state.s5ApprovalEvents[0]!;
        event.generationContext = JSON.parse(JSON.stringify(originalContext));
        mutate(event.generationContext! as NonNullable<typeof originalContext>);
        event.generationContextHash = generationContextHash(event.generationContext!);
        for (const artifact of state.s5Artifacts) artifact.generationContextHash = event.generationContextHash;
      });
    };
    const restoreContext = (): void => fixture.repository.transact((state) => {
      const event = state.s5ApprovalEvents[0]!;
      event.generationContext = JSON.parse(JSON.stringify(originalContext));
      event.generationContextHash = generationContextHash(event.generationContext!);
      for (const artifact of state.s5Artifacts) artifact.generationContextHash = event.generationContextHash;
    });

    tamperContext((context) => { context.briefContentHash = sha256(Buffer.from("tampered brief")); });
    failClosed(); restoreContext();
    tamperContext((context) => { context.geometrySnapshot.widthMm += 1; });
    failClosed(); restoreContext();
    tamperContext((context) => { context.canonicalRequirements[0]!.text = "tampered canonical requirement"; });
    failClosed(); restoreContext();
    tamperContext((context) => { context.designRuleSnapshot[0]!.repairable = !context.designRuleSnapshot[0]!.repairable; });
    failClosed(); restoreContext();
    const tamperedAssetState = JSON.parse(JSON.stringify(fixture.repository.state())) as ReturnType<typeof fixture.repository.state>;
    const tamperedAssetEvent = tamperedAssetState.s5ApprovalEvents[0]!;
    tamperedAssetEvent.generationContext!.activeAssetSha256 = sha256(Buffer.from("tampered asset hash"));
    tamperedAssetEvent.generationContextHash = generationContextHash(tamperedAssetEvent.generationContext!);
    for (const artifact of tamperedAssetState.s5Artifacts) artifact.generationContextHash = tamperedAssetEvent.generationContextHash;
    assert.throws(() => validateCurrentS5Approval(tamperedAssetState, fixture.projectId as UUID, tamperedAssetEvent, fixture.objects), (error: unknown) => error instanceof AppError && error.code === "S5_APPROVAL_STALE");

    const selection = fixture.repository.state().s3Selections[0]!;
    const originalSelectionVersion = selection.selectionVersion;
    fixture.repository.transact((state) => { state.s3Selections[0]!.selectionVersion = originalSelectionVersion + 1; });
    failClosed();
    fixture.repository.transact((state) => { state.s3Selections[0]!.selectionVersion = originalSelectionVersion; });
    const originalActiveRevisionId = selection.activeRevisionId;
    fixture.repository.transact((state) => { state.s3Selections[0]!.activeRevisionId = null; });
    failClosed();
    fixture.repository.transact((state) => { state.s3Selections[0]!.activeRevisionId = originalActiveRevisionId; });
    const originalLineageRootRevisionId = selection.lineageRootRevisionId;
    fixture.repository.transact((state) => { state.s3Selections[0]!.lineageRootRevisionId = null; });
    failClosed();
    fixture.repository.transact((state) => { state.s3Selections[0]!.lineageRootRevisionId = originalLineageRootRevisionId; });

    const source = fixture.repository.state().s3Sources[0]!;
    const originalSourceHash = source.selectedSha256;
    const tamperedSourceHash = sha256(Buffer.from("tampered source hash"));
    assert.throws(() => fixture.repository.transact((state) => { state.s3Sources[0]!.selectedSha256 = tamperedSourceHash; state.s3Sources[0]!.canonicalSourceBinding.selectedSha256 = tamperedSourceHash; }), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");

    const sourceKey = source.selectedStorageKey;
    const originalBytes = fixture.objects.read(sourceKey);
    fixture.objects.remove(sourceKey);
    fixture.objects.put(sourceKey, Buffer.from("tampered asset bytes"));
    failClosed();
    fixture.objects.remove(sourceKey);
    fixture.objects.put(sourceKey, originalBytes);

    const tamperedQualityState = JSON.parse(JSON.stringify(fixture.repository.state())) as ReturnType<typeof fixture.repository.state>;
    const tamperedQualityEvent = tamperedQualityState.s5ApprovalEvents[0]!;
    tamperedQualityEvent.generationContext!.sourceQualityEvidence.verdictRecordId = randomUUID() as UUID;
    tamperedQualityEvent.generationContextHash = generationContextHash(tamperedQualityEvent.generationContext!);
    assert.throws(() => validateCurrentS5Approval(tamperedQualityState, fixture.projectId as UUID, tamperedQualityEvent, fixture.objects), (error: unknown) => error instanceof AppError && error.code === "S5_FROZEN_CONTEXT_MISMATCH");
    assert.throws(() => fixture.repository.transact((state) => { state.s5ApprovalEvents[0]!.generationContext!.sourceQualityEvidence.verdictRecordId = randomUUID() as UUID; state.s5ApprovalEvents[0]!.generationContextHash = generationContextHash(state.s5ApprovalEvents[0]!.generationContext!); }), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
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
    const refinementContext = refinedEvent!.generationContext!;
    const refinementSource = fixture.repository.state().s3Sources.find((item) => item.sourceSnapshotId === refinementContext.sourceSnapshotId)!;
    const refinementAssessment = fixture.repository.state().s3Assessments.find((item) => item.assessmentId === (fixture.repository.state().s3Revisions.find((revision) => revision.revisionId === refinementContext.activeRevisionId)?.assessmentId ?? ""))!;
    assert.deepEqual(refinementContext.sourceQualityEvidence, { kind: "s3_refinement", sourceSnapshotId: refinementSource.sourceSnapshotId, sourceRevisionId: refinementContext.activeRevisionId, sourceBindingHash: refinementSource.sourceBindingHash, assessmentId: refinementAssessment.assessmentId, status: refinementContext.quality, verdictRecordId: refinementAssessment.assessmentId });
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
      const s4Context = event!.generationContext!;
      const s4Revision = fixture.repository.state().s4Revisions.at(-1)!;
      const s4Preservation = fixture.repository.state().s4PreservationChecks.find((item) => item.preservationCheckId === s4Revision.preservationCheckId)!;
      const s4Assessment = fixture.repository.state().s4Assessments.find((item) => item.assessmentId === s4Revision.assessmentId)!;
      assert.deepEqual(s4Context.sourceQualityEvidence, { kind: "s4_local_edit", sourceSnapshotId: s4Revision.sourceSnapshotId, sourceRevisionId: s4Revision.revisionId, preservationCheckId: s4Preservation.preservationCheckId, assessmentId: s4Assessment.assessmentId, status: variant.quality, verdictRecordId: s4Assessment.assessmentId });
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
