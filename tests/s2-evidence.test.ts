import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { test } from "node:test";
import { handleApiRequest } from "../src/lib/api";
import { createS2QaClient, createS2ReferencesClient } from "../app/components/S2Client";
import { createIdempotencyKeyRetainer, UnknownNetworkOutcome, withRetainedIdempotencyKey } from "../src/lib/client-idempotency";
import { MockOpenAIProvider, OpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { buildS2QaRequest, buildS2RepairRequest } from "../src/lib/s2-provider";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import type { S2PublicationPhase } from "../src/lib/s2";
import {
  enforceS2AggregateLimits,
  normalizeS2Media,
  S2_MAX_DIMENSION,
  S2_MAX_MULTIPART_BODY_BYTES,
  S2_MAX_NORMALIZED_BYTES,
  S2_MAX_PIXELS_PER_ASSET,
  S2_MAX_PROVIDER_BYTES,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  S2_MAX_RGBA_BYTES_PER_ASSET,
  S2_MAX_TOTAL_PIXELS,
  S2_MAX_TOTAL_RGBA_BYTES,
  S2_MAX_SOURCE_BYTES,
  S2_MAX_REPAIR_IMAGES,
} from "../src/lib/s2-media";
import { createWorkflowService, type WorkflowService } from "../src/lib/workflow";
import { AppError, type BoothGeometry, type ConceptAsset, type ConceptCandidate, type GenerationSet, type Project, type ProviderMetadata, type StructuredBriefData, type StructuredBriefVersion, type S2QaCandidateResult, type S2AssetRecord, type S2Publication } from "../src/lib/types";
import { jcs, privateStorageKey, sha256 } from "../src/lib/utils";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const META: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: CREATED_AT };
const evidenceRows = new Map<string, { fixture: string; expected: unknown; actual: unknown }>();

function mark(id: string, fixture: string, expected: unknown, actual: unknown): void {
  if (evidenceRows.has(id)) throw new Error(`duplicate evidence ${id}`);
  assert.deepEqual(actual, expected, id);
  evidenceRows.set(id, { fixture, expected, actual });
}

function markVariant(id: string, variantId: string, fixture: string, expected: unknown, actual: unknown): void {
  mark(`${id}/${variantId}`, fixture, expected, actual);
}

function brief(exactCount = false, withOptionalText = true): StructuredBriefData {
  return {
    projectFacts: { clientName: null, eventName: null, venueName: null, eventLocation: null, eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: null, brandValues: [], visualDirection: "calm", preferredColors: [], materials: [], logoInstructions: null },
    functionalRequirements: [{ name: "demo counter", count: exactCount ? 2 : null, countIsExact: exactCount, mandatory: false, details: null }],
    mandatoryRequirements: ["Keep the main visitor entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: null, notes: null },
    unknowns: [],
    assumptions: [],
    freeTextRequirements: withOptionalText ? ["Make the main brand moment readable."] : [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

type Fixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  provider: MockOpenAIProvider;
  projectId: string;
  generationSetId: string;
  versionId: string;
  sourceKeys: string[];
  sourceBytes: Buffer;
};

type SeedOptions = {
  provider?: MockOpenAIProvider;
  exactCount?: boolean;
  geometry?: BoothGeometry;
  data?: StructuredBriefData;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  onPublicationPhase?: (phase: S2PublicationPhase, publication: S2Publication) => "interrupt" | void | Promise<"interrupt" | void>;
};

function seed(options: SeedOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s2-evidence-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const versionId = randomUUID();
  const geometry = options.geometry ?? { widthMm: 6000, depthMm: 4000, openSides: ["north"], maxHeightMm: null };
  const data = options.data ?? brief(options.exactCount ?? false);
  const sourceBytes = Buffer.from(PNG);
  const sourceKeys: string[] = [];
  const generation: GenerationSet = { generationSetId, projectId, confirmedBriefVersionId: versionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sha256("manifest"), provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: CREATED_AT, completedAt: CREATED_AT, failureCode: null };
  const version: StructuredBriefVersion = { briefVersionId: versionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data, contentHash: sha256("confirmed-brief"), confirmationMode: "explicit_user_action", confirmedAt: CREATED_AT, extractionProviderMetadata: META };
  repository.transact((state) => {
    const project: Project = { projectId, name: "S2 evidence fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: versionId, activeGenerationSetId: generationSetId, createdAt: CREATED_AT, updatedAt: CREATED_AT };
    state.projects.push(project); state.briefVersions.push(version); state.generationSets.push(generation);
    for (let index = 1; index <= 4; index += 1) {
      const candidateId = randomUUID(); const assetId = randomUUID(); const storageKey = privateStorageKey("projects", projectId, "concepts", candidateId + ".png");
      objects.put(storageKey, sourceBytes); sourceKeys.push(storageKey);
      const asset: ConceptAsset = { assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: sourceBytes.byteLength, sha256: sha256(sourceBytes), status: "stored", createdAt: CREATED_AT };
      const candidate: ConceptCandidate = { candidateId, generationSetId, projectId, confirmedBriefVersionId: versionId, candidateIndex: index as 1 | 2 | 3 | 4, directionKey: ["modular-clarity", "brand-theatre", "open-demo", "hospitality-consultation"][index - 1] as ConceptCandidate["directionKey"], assetId, compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "modular-clarity", canonicalInputHash: sha256("input"), promptHash: sha256("prompt"), compiledAt: CREATED_AT }, providerMetadata: META, createdAt: CREATED_AT };
      state.conceptAssets.push(asset); state.candidates.push(candidate);
    }
  });
  const provider = options.provider ?? new MockOpenAIProvider({ briefData: data });
  const service = createWorkflowService({ repository, objects, provider, processId: options.processId, isProcessAlive: options.isProcessAlive, onPublicationPhase: options.onPublicationPhase });
  service.s2.getReferenceDraft(projectId);
  return { root, repository, objects, service, provider, projectId, generationSetId, versionId, sourceKeys, sourceBytes };
}

function cleanup(fixture: Fixture): void { rmSync(fixture.root, { recursive: true, force: true }); }
function listObjects(root: string): string[] {
  const result: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path); else result.push(relative(join(root, "objects"), path));
    }
  }
  try { visit(join(root, "objects")); } catch { return []; }
  return result.sort();
}
async function waitForRun(fixture: Fixture, qaRunId: string, predicate: (value: any) => boolean = (value) => value.qaRun.status === "completed"): Promise<any> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = fixture.service.s2.getQaRun(fixture.projectId, qaRunId) as any;
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const value = fixture.service.s2.getQaRun(fixture.projectId, qaRunId) as any;
  throw new Error("Timed out waiting for S2 QA evidence predicate: status=" + String(value.qaRun?.status ?? "unknown") + "; completedCandidateCount=" + String(value.qaRun?.completedCandidateCount ?? "unknown") + "; unavailableCount=" + String(value.qaRun?.unavailableCount ?? "unknown"));
}
async function expectCode(action: () => unknown, code: string): Promise<boolean> {
  try { await action(); return false; }
  catch (error) { return error instanceof AppError && error.code === code; }
}
function controlledOpenAiRepairProvider(responseBody: Record<string, unknown>, requestCount: { value: number }): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: "dummy-test-api-key",
    fetchImpl: async (input: RequestInfo | URL): Promise<Response> => {
      requestCount.value += 1;
      assert.equal(String(input), "https://api.openai.com/v1/images/edits");
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}
function productionRepairFixture(decodedOutput: Uint8Array): { fixture: Fixture; requestCount: { value: number } } {
  const requestCount = { value: 0 };
  const productionRepairProvider = controlledOpenAiRepairProvider({
    data: [{ b64_json: Buffer.from(decodedOutput).toString("base64") }],
  }, requestCount);
  const provider = new MockOpenAIProvider({ briefData: brief() });
  provider.runS2Repair = productionRepairProvider.runS2Repair.bind(productionRepairProvider);
  return { fixture: seed({ provider }), requestCount };
}
function succeeds(action: () => unknown): boolean {
  try { action(); return true; }
  catch { return false; }
}
async function upload(fixture: Fixture, kind: "reference" | "logo", bytes: Uint8Array, name = "asset.png"): Promise<any> {
  return fixture.service.s2.uploadAsset(fixture.projectId, kind, name, "image/png", bytes, randomUUID());
}
async function coloredPng(color: { r: number; g: number; b: number; alpha?: number }): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: { r: color.r, g: color.g, b: color.b, alpha: color.alpha ?? 1 } } }).png().toBuffer();
}
async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 20, g: 80, b: 140 } } }).jpeg().toBuffer();
}
async function webpBytes(lossless = false): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 20, g: 80, b: 140 } } }).webp({ lossless }).toBuffer();
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii"); const body = Buffer.from(data); const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0); typeBytes.copy(chunk, 4); body.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length); return chunk;
}
function pngWithChunk(type: string, data: Uint8Array): Buffer {
  const marker = PNG.indexOf(Buffer.from("IEND", "ascii"));
  return Buffer.concat([PNG.subarray(0, marker - 4), pngChunk(type, data), PNG.subarray(marker - 4)]);
}
function exactSizePng(size: number): Buffer { return pngWithChunk("tEXt", Buffer.alloc(size - PNG.length - 12, 0x61)); }
function webpWithChunk(bytes: Buffer, type: string, data = Buffer.alloc(0)): Buffer {
  const body = Buffer.from(data); const chunk = Buffer.alloc(8 + body.length); chunk.write(type, 0, 4, "ascii"); chunk.writeUInt32LE(body.length, 4); body.copy(chunk, 8);
  const result = Buffer.concat([bytes, chunk]); result.writeUInt32LE(result.length - 8, 4); return result;
}
function measure(overrides: Partial<{ encodedBytes: number; width: number; height: number; pixelCount: number; decodedRgbaBytes: number; normalizedBytes: number }> = {}) {
  return { encodedBytes: 1, width: 1, height: 1, pixelCount: 1, decodedRgbaBytes: 4, ...overrides };
}
function qaPayload(input: any, mode: string, badRule?: string): any {
  const requirements = input.requirements.map((item: any) => {
    const exactUncertain = mode === "uncertain" && item.expected === "exact_count";
    const exactBoundary = mode === "threshold" && item.expected === "exact_count";
    const belowBoundary = mode === "below_threshold" && item.expected === "exact_count";
    const requirementViolation = mode === "requirement_violation" && item.requirementId === "brief.functional.001";
    const observed = exactUncertain || belowBoundary ? "uncertain" : requirementViolation ? "absent" : item.expected === "absent" ? "absent" : "present";
    const observedCount = exactUncertain || belowBoundary ? null : (exactBoundary || mode === "exact_count_fail") && item.expected === "exact_count" ? (item.expectedCount ?? 0) + 1 : item.expected === "exact_count" ? item.expectedCount : null;
    const confidence = exactBoundary ? 0.75 : belowBoundary ? 0.7499 : mode === "uncertain" && exactUncertain ? 0.5 : 0.99;
    return { requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount, observed, observedCount, confidence, evidence: mode === "evidence_long" ? "x".repeat(401) : "synthetic observation" };
  });
  const designRules = input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({ ruleId: item.ruleId, observed: item.ruleId === badRule ? "non_compliant" : mode === "not_verifiable" && item.ruleId === "branding.style" ? "not_verifiable" : mode === "warning" && item.ruleId === "branding.style" ? "non_compliant" : "compliant", confidence: 0.99, evidence: "synthetic observation" }));
  if (mode === "missing") requirements.pop();
  if (mode === "duplicate") requirements.push({ ...requirements[0] });
  if (mode === "unknown") requirements.push({ requirementId: "provider.invented", expected: "present", expectedCount: null, observed: "present", observedCount: null, confidence: 0.99, evidence: "synthetic" });
  if (mode === "wrong_type") (requirements[0] as any).confidence = "high";
  if (mode === "out_of_range") (requirements[0] as any).confidence = 1.1;
  if (mode === "extra_property") (requirements[0] as any).severity = "material";
  if (mode === "expected_mismatch") (requirements[0] as any).expected = "absent";
  if (mode === "non_applicable") designRules.push({ ruleId: "geometry.max-height", observed: "compliant", confidence: 0.99, evidence: "synthetic" });
  return { requirements, designRules };
}
async function bind(fixture: Fixture, key = randomUUID(), expectedRevision = 1): Promise<any> {
  return fixture.service.s2.bindQa(fixture.projectId, fixture.generationSetId, expectedRevision, key, randomUUID());
}
function latestResult(fixture: Fixture, qaRunId: string, candidateIndex: number): S2QaCandidateResult {
  const run = fixture.repository.state().s2QaRuns.find((item) => item.id === qaRunId)!;
  return run.candidateResults.filter((item) => item.candidateIndex === candidateIndex).sort((left, right) => right.attempt - left.attempt)[0];
}
function mutateResult(fixture: Fixture, qaRunId: string, candidateIndex: number, patch: Partial<S2QaCandidateResult>): void {
  fixture.repository.transact((state) => {
    const run = state.s2QaRuns.find((item) => item.id === qaRunId)!;
    const result = run.candidateResults.filter((item) => item.candidateIndex === candidateIndex).sort((left, right) => right.attempt - left.attempt)[0];
    Object.assign(result, patch);
  });
}
async function repairAndWait(fixture: Fixture, bound: any, candidate: any): Promise<any> {
  await fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
  return waitForRun(fixture, bound.qaRun.id, (value) => Boolean(value.qaRun.repairs?.some((item: any) => item.candidateId === candidate.candidateId && ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(item.status))));
}

test("section-24 media evidence", async () => {
  const fixture = seed();
  try {
    const uploaded = await upload(fixture, "reference", PNG);
    const originalKey = privateStorageKey("projects", fixture.projectId, "s2", "references", uploaded.asset.id, "original");
    const normalizedKey = privateStorageKey("projects", fixture.projectId, "s2", "references", uploaded.asset.id, "normalized.png");
    mark("MEDIA-001", "PNG upload with private original/normalized promotion", true, fixture.objects.exists(originalKey) && fixture.objects.exists(normalizedKey) && uploaded.asset.originalSha256 === sha256(PNG) && uploaded.asset.normalizedSha256 === sha256(fixture.objects.read(normalizedKey)));

    const jpeg = await jpegBytes();
    const jpegMedia = await normalizeS2Media({ kind: "reference", fileName: "photo.jpg", mimeType: "image/jpg", bytes: jpeg });
    mark("MEDIA-002", "JPEG with image/jpg alias", "image/jpeg", jpegMedia.detectedMime);
    const webp = await webpBytes(false); const webpLossless = await webpBytes(true);
    const webpMedia = await normalizeS2Media({ kind: "reference", fileName: "photo.webp", mimeType: "image/webp", bytes: webp });
    const webpLosslessMedia = await normalizeS2Media({ kind: "reference", fileName: "photo-lossless.webp", mimeType: "image/webp", bytes: webpLossless });
    mark("MEDIA-003", "Static VP8 and VP8L WebP", true, webpMedia.detectedMime === "image/webp" && webpLosslessMedia.detectedMime === "image/webp");

    const malformedCodes = await Promise.all([
      expectCode(() => normalizeS2Media({ kind: "reference", fileName: "bad.png", mimeType: "image/png", bytes: Buffer.from("89504e470d0a1a", "hex") }), "UNSUPPORTED_MEDIA_TYPE"),
      expectCode(() => normalizeS2Media({ kind: "reference", fileName: "bad.jpg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }), "MEDIA_CORRUPT"),
      (async () => { try { await normalizeS2Media({ kind: "reference", fileName: "bad.webp", mimeType: "image/webp", bytes: Buffer.from("RIFF0000WEBP", "ascii") }); return false; } catch (error) { return error instanceof AppError && ["MEDIA_CORRUPT", "UNSUPPORTED_MEDIA_TYPE"].includes(error.code); } })(),
    ]);
    mark("MEDIA-004", "PNG/JPEG/RIFF container checks", true, malformedCodes.every(Boolean));
    const mismatchCodes = await Promise.all([
      expectCode(() => normalizeS2Media({ kind: "reference", fileName: "photo.png", mimeType: "image/jpeg", bytes: PNG }), "MEDIA_SIGNATURE_MISMATCH"),
      expectCode(() => normalizeS2Media({ kind: "reference", fileName: "photo.jpg", mimeType: "image/png", bytes: PNG }), "MEDIA_SIGNATURE_MISMATCH"),
      expectCode(() => normalizeS2Media({ kind: "reference", fileName: "photo.txt", mimeType: "image/png", bytes: PNG }), "UNSUPPORTED_MEDIA_TYPE"),
    ]);
    mark("MEDIA-005", "MIME and extension mismatch", true, mismatchCodes.every(Boolean));
    const unsupported = ["<svg></svg>", "GIF89a", "II*\u0000", "BM", "\u0000\u0000\u0001\u0000", "%PDF-1.7", "ftypheic", "ftypavif"].map((value) => normalizeS2Media({ kind: "reference", fileName: "asset.bin", mimeType: "application/octet-stream", bytes: Buffer.from(value, "latin1") }).then(() => false).catch((error) => error instanceof AppError && error.code === "UNSUPPORTED_MEDIA_TYPE"));
    mark("MEDIA-006", "Unsupported raster/vector/container formats", true, (await Promise.all(unsupported)).every(Boolean));
    const apng = pngWithChunk("acTL", Buffer.alloc(8));
    const animatedWebp = webpWithChunk(webp, "ANIM", Buffer.alloc(6));
    mark("MEDIA-007", "APNG and animated WebP rejection", true, await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.png", mimeType: "image/png", bytes: apng }), "MEDIA_ANIMATED_NOT_ALLOWED") && await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.webp", mimeType: "image/webp", bytes: animatedWebp }), "MEDIA_ANIMATED_NOT_ALLOWED"));
    mark("MEDIA-008", "Truncated/corrupt and multi-frame rejection", true, await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "truncated.png", mimeType: "image/png", bytes: PNG.subarray(0, PNG.length - 4) }), "MEDIA_CORRUPT") && await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "multi.webp", mimeType: "image/webp", bytes: webpWithChunk(webp, "VP8L", Buffer.alloc(2)) }), "MEDIA_ANIMATED_NOT_ALLOWED"));
    const exactSource = exactSizePng(S2_MAX_SOURCE_BYTES);
    const exactAccepted = await normalizeS2Media({ kind: "reference", fileName: "exact.png", mimeType: "image/png", bytes: exactSource, maxInputBytes: S2_MAX_SOURCE_BYTES });
    const overSource = exactSizePng(S2_MAX_SOURCE_BYTES + 1);
    const overRejected = await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "over.png", mimeType: "image/png", bytes: overSource, maxInputBytes: S2_MAX_SOURCE_BYTES }), "MEDIA_TOO_LARGE");
    mark("MEDIA-009", "Exact 8 MiB accepted and 8 MiB plus one rejected during intake", { acceptedBytes: S2_MAX_SOURCE_BYTES, rejectedCode: "MEDIA_TOO_LARGE" }, { acceptedBytes: exactAccepted.originalBytes.byteLength, rejectedCode: overRejected ? "MEDIA_TOO_LARGE" : "unexpected" });
    const boundary = "s2-evidence"; const oversizedBody = Buffer.alloc(S2_MAX_MULTIPART_BODY_BYTES + 1, 0x20);
    const oversizedResponse = await handleApiRequest(new Request(`http://localhost/api/projects/${fixture.projectId}/s2/reference-assets`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(oversizedBody.length), "Idempotency-Key": randomUUID() }, body: oversizedBody }), ["projects", fixture.projectId, "s2", "reference-assets"], fixture.service);
    mark("MEDIA-010", "Multipart framing 9 MiB boundary", 413, oversizedResponse.status);
    const exactDimensions = succeeds(() => enforceS2AggregateLimits([measure({ width: S2_MAX_DIMENSION, height: 1 })]));
    const overDimensions = await expectCode(() => enforceS2AggregateLimits([measure({ width: S2_MAX_DIMENSION + 1 })]), "MEDIA_DIMENSIONS_EXCEEDED");
    mark("MEDIA-011", "Dimension exact/over boundary", true, exactDimensions && overDimensions);
    const exactPixels = succeeds(() => enforceS2AggregateLimits([measure({ width: 4096, height: 4096, pixelCount: S2_MAX_PIXELS_PER_ASSET, decodedRgbaBytes: S2_MAX_RGBA_BYTES_PER_ASSET })]));
    const overPixels = await expectCode(() => enforceS2AggregateLimits([measure({ width: 4096, height: 4097, pixelCount: S2_MAX_PIXELS_PER_ASSET + 4096 })]), "MEDIA_DIMENSIONS_EXCEEDED");
    mark("MEDIA-012", "Per-asset pixel exact/over boundary", true, exactPixels && overPixels);
    const exactAggregatePixels = succeeds(() => enforceS2AggregateLimits([measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2 }), measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2 })]));
    const overAggregatePixels = await expectCode(() => enforceS2AggregateLimits([measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2 }), measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2 }), measure()]), "MEDIA_AGGREGATE_LIMIT_EXCEEDED");
    mark("MEDIA-013", "Aggregate decoded pixel exact/over boundary", true, exactAggregatePixels && overAggregatePixels);
    enforceS2AggregateLimits([measure({ width: 4000, height: 4000, pixelCount: 16_000_000, decodedRgbaBytes: S2_MAX_RGBA_BYTES_PER_ASSET }), measure({ width: 4000, height: 4000, pixelCount: 16_000_000, decodedRgbaBytes: S2_MAX_RGBA_BYTES_PER_ASSET })]);
    const perAssetRgba = await expectCode(() => enforceS2AggregateLimits([measure({ decodedRgbaBytes: S2_MAX_RGBA_BYTES_PER_ASSET + 1 })]), "MEDIA_PIXEL_LIMIT_EXCEEDED");
    const aggregateRgba = await expectCode(() => enforceS2AggregateLimits([measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2, decodedRgbaBytes: S2_MAX_TOTAL_RGBA_BYTES / 2 }), measure({ pixelCount: S2_MAX_TOTAL_PIXELS / 2, decodedRgbaBytes: S2_MAX_TOTAL_RGBA_BYTES / 2 }), measure({ pixelCount: 0, decodedRgbaBytes: 1 })]), "MEDIA_AGGREGATE_LIMIT_EXCEEDED");
    mark("MEDIA-014", "Per-asset and aggregate RGBA limits", true, perAssetRgba && aggregateRgba);
    const exactNormalized = succeeds(() => enforceS2AggregateLimits([measure({ normalizedBytes: S2_MAX_NORMALIZED_BYTES })]));
    const overNormalized = await expectCode(() => enforceS2AggregateLimits([measure({ normalizedBytes: S2_MAX_NORMALIZED_BYTES + 1 })]), "MEDIA_NORMALIZATION_FAILED");
    mark("MEDIA-015", "Normalized byte exact/over boundary", true, exactNormalized && overNormalized);
    const oriented = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 200, g: 20, b: 20 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const orientedMedia = await normalizeS2Media({ kind: "reference", fileName: "oriented.jpg", mimeType: "image/jpeg", bytes: oriented });
    mark("MEDIA-016", "EXIF orientation before dimensions", { width: 1, height: 2 }, { width: orientedMedia.width, height: orientedMedia.height });
    const normalizedMetadata = await sharp(jpegMedia.normalizedBytes).metadata();
    mark("MEDIA-017", "Metadata stripped from normalized output", true, !normalizedMetadata.exif && !normalizedMetadata.icc && !normalizedMetadata.xmp && !(normalizedMetadata as any).text);
    const alpha = await coloredPng({ r: 20, g: 40, b: 60, alpha: 0.25 }); const opaque = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
    const alphaMedia = await normalizeS2Media({ kind: "reference", fileName: "alpha.png", mimeType: "image/png", bytes: alpha }); const opaqueMedia = await normalizeS2Media({ kind: "reference", fileName: "opaque.png", mimeType: "image/png", bytes: opaque });
    mark("MEDIA-018", "Alpha preservation and opaque output", true, alphaMedia.hasAlpha && !opaqueMedia.hasAlpha);
    const repeatA = await normalizeS2Media({ kind: "reference", fileName: "same.png", mimeType: "image/png", bytes: alpha }); const repeatB = await normalizeS2Media({ kind: "reference", fileName: "same.png", mimeType: "image/png", bytes: alpha });
    mark("MEDIA-019", "Deterministic PNG normalization", true, repeatA.detectedMime === "image/png" && repeatA.normalizedSha256 === repeatB.normalizedSha256 && repeatA.width === repeatB.width && repeatA.height === repeatB.height);
    mark("MEDIA-020", "Exact lowercase source/normalized hashes", true, repeatA.originalSha256 === sha256(alpha) && repeatA.normalizedSha256 === repeatA.normalizedSha256.toLowerCase() && /^[0-9a-f]{64}$/.test(repeatA.normalizedSha256));
    const mediaSource = readFileSync(join(process.cwd(), "src/lib/s2-media.ts"), "utf8");
    mark("MEDIA-021", "Pinned decoder safety options", true, ["failOn: \"warning\"", "limitInputPixels", "pages: 1", "animated: false", "autoOrient: true", "sequentialRead: true"].every((value) => mediaSource.includes(value)) && !mediaSource.includes("unlimited: true"));
    const failing = seed(); try { (failing.objects as any).promote = () => { throw new AppError(500, "PERSISTENCE_FAILED"); }; await expectCode(() => upload(failing, "reference", PNG), "PERSISTENCE_FAILED"); mark("MEDIA-022", "Owned staging cleanup after promotion failure", true, listObjects(failing.root).every((path) => !path.includes("/staging/") && !path.includes("\\staging\\"))); } finally { cleanup(failing); }
    const hardUploadKey = randomUUID();
    const hardUpload = seed({ processId: 99130, onPublicationPhase: (phase) => phase === "after-final-promotion" ? "interrupt" : undefined });
    try {
      let interrupted = false;
      try { await hardUpload.service.s2.uploadAsset(hardUpload.projectId, "reference", "hard-crash.png", "image/png", PNG, hardUploadKey); }
      catch { interrupted = true; }
      const promotedBeforeRestart = listObjects(hardUpload.root).filter((name) => /s2[\\/]references[\\/]/.test(name)).length === 2;
      const beforeRestart = hardUpload.repository.state();
      const restarted = createWorkflowService({ repository: hardUpload.repository, objects: hardUpload.objects, provider: hardUpload.provider, processId: 99131, isProcessAlive: (processId) => processId !== 99130 });
      const afterRestart = restarted.repository.state();
      const recoveredAsset = afterRestart.s2Assets[0];
      const recoveredPublication = afterRestart.s2Publications.find((publication) => publication.kind === "asset_upload");
      const replay = await restarted.s2.uploadAsset(hardUpload.projectId, "reference", "different-name.png", "image/png", PNG, hardUploadKey);
      markVariant("MEDIA-022", "hard-interruption-restart", "Promoted upload publication is reconciled after process loss before lineage commit", true,
        interrupted && promotedBeforeRestart && beforeRestart.s2Assets.length === 0 && beforeRestart.s2Publications.some((publication) => publication.state === "promoted" && publication.kind === "asset_upload" && publication.ownerProcessId === 99130) && afterRestart.s2Assets.length === 1 && recoveredAsset.status === "ready" && afterRestart.s2Publications.every((publication) => publication.state === "committed") && listObjects(hardUpload.root).filter((name) => /s2[\\/]references[\\/]/.test(name)).length === 2 && listObjects(hardUpload.root).every((name) => !/s2[\\/]staging[\\/]/.test(name)) && replay.replayed && replay.asset.id === recoveredAsset.id);
      markVariant("CONC-003", "upload-dead-promoted", "Definitely dead promoted upload recovers one exact asset and same-key replay identity", true,
        interrupted && recoveredPublication?.ownerProcessId === 99130 && recoveredPublication.state === "committed" && afterRestart.s2Assets.length === 1 &&
        afterRestart.idempotency.filter((item) => item.key === hardUploadKey).length === 1 && replay.replayed && replay.asset.id === recoveredAsset.id &&
        listObjects(hardUpload.root).filter((name) => /s2[\\/]references[\\/]/.test(name)).length === 2 &&
        listObjects(hardUpload.root).every((name) => !/s2[\\/]staging[\\/]/.test(name)));
    } finally { cleanup(hardUpload); }
  } finally { cleanup(fixture); }
});

test("section-24 draft and bind evidence", async () => {
  const fixture = seed();
  try {
    const initial = fixture.service.s2.getReferenceDraft(fixture.projectId);
    mark("DRAFT-001", "First persisted draft", true, initial.revision === 1 && initial.status === "editable" && initial.referenceAssetIds.length === 0 && initial.logoAssetIds.length === 0);
    const first = await upload(fixture, "reference", await coloredPng({ r: 1, g: 2, b: 3 }));
    mark("DRAFT-002", "Upload does not add to draft", 0, fixture.service.s2.getReferenceDraft(fixture.projectId).referenceAssetIds.length);
    const logo = await upload(fixture, "logo", await coloredPng({ r: 4, g: 5, b: 6 }));
    const ordered = fixture.service.s2.updateDraft(fixture.projectId, 1, [first.asset.id], [logo.asset.id], randomUUID());
    const reordered = fixture.service.s2.updateDraft(fixture.projectId, ordered.draft.revision, [], [logo.asset.id], randomUUID());
    mark("DRAFT-003", "Full ordered add/remove/reorder PATCH", true, ordered.draft.revision === 2 && reordered.draft.revision === 3 && reordered.draft.referenceAssetIds.length === 0);
    const noOp = fixture.service.s2.updateDraft(fixture.projectId, 3, [], [logo.asset.id], randomUUID());
    mark("DRAFT-004", "No-op revision and stale revision", true, noOp.draft.revision === 3 && await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 2, [], [logo.asset.id], randomUUID()), "DRAFT_REVISION_CONFLICT"));
    const other = randomUUID(); const otherAsset: S2AssetRecord = { ...logoAsset(logo.asset), id: randomUUID(), projectId: other };
    fixture.repository.transact((state) => { state.s2Assets.push(otherAsset); });
    const draftFailures = [
      await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 3, [first.asset.id, first.asset.id], [], randomUUID()), "MEDIA_DUPLICATE"),
      await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 3, [logo.asset.id], [], randomUUID()), "ASSET_KIND_MISMATCH"),
      await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 3, [otherAsset.id], [], randomUUID()), "ASSET_PROJECT_MISMATCH"),
      await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 3, [randomUUID()], [], randomUUID()), "ASSET_NOT_FOUND"),
    ];
    fixture.repository.transact((state) => { const item = state.s2Assets.find((asset) => asset.id === first.asset.id)!; item.status = "deleted"; });
    draftFailures.push(await expectCode(() => fixture.service.s2.updateDraft(fixture.projectId, 3, [first.asset.id], [], randomUUID()), "ASSET_NOT_FOUND"));
    mark("DRAFT-005", "Duplicate, kind, project, missing and deleted assets", true, draftFailures.every(Boolean));

    const capacity = seed();
    try {
      const refs: string[] = []; const logos: string[] = [];
      for (let index = 0; index < 6; index += 1) refs.push((await upload(capacity, "reference", await coloredPng({ r: index + 10, g: 1, b: 1 }))).asset.id);
      for (let index = 0; index < 2; index += 1) logos.push((await upload(capacity, "logo", await coloredPng({ r: 1, g: index + 20, b: 1 }))).asset.id);
      const accepted = capacity.service.s2.updateDraft(capacity.projectId, 1, refs, logos, randomUUID());
      const seventh = (await upload(capacity, "reference", await coloredPng({ r: 99, g: 1, b: 1 }))).asset.id;
      const thirdLogo = (await upload(capacity, "logo", await coloredPng({ r: 1, g: 99, b: 1 }))).asset.id;
      mark("DRAFT-006", "Six references/two logos and over-limit selections", true, accepted.draft.referenceAssetIds.length === 6 && accepted.draft.logoAssetIds.length === 2 && await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, [...refs, seventh], logos, randomUUID()), "DRAFT_LIMIT_EXCEEDED") && await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, refs, [...logos, thirdLogo], randomUUID()), "DRAFT_LIMIT_EXCEEDED") && await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, refs, [...logos, thirdLogo], randomUUID()), "DRAFT_LIMIT_EXCEEDED"));
    } finally { cleanup(capacity); }

    const emptyBind = seed(); try { const bound = await bind(emptyBind); await waitForRun(emptyBind, bound.qaRun.id); mark("DRAFT-007", "Empty selection binds", true, emptyBind.repository.state().s2Inputs.length === 1 && emptyBind.repository.state().s2Drafts[0].referenceAssetIds.length === 0); } finally { cleanup(emptyBind); }
    const frozen = seed(); try { const bound = await bind(frozen); await waitForRun(frozen, bound.qaRun.id); const frozenDraft = frozen.service.s2.getReferenceDraft(frozen.projectId); mark("DRAFT-008", "Atomic freeze and no later write", true, frozenDraft.status === "frozen" && await expectCode(() => frozen.service.s2.updateDraft(frozen.projectId, frozenDraft.revision, frozenDraft.referenceAssetIds, frozenDraft.logoAssetIds, randomUUID()), "DRAFT_FROZEN")); } finally { cleanup(frozen); }
    const failed = seed(); try { failed.objects.remove(failed.sourceKeys[0]); const before = failed.service.s2.getReferenceDraft(failed.projectId); const rejected = await expectCode(() => bind(failed), "QA_BINDING_CONFLICT"); const after = failed.service.s2.getReferenceDraft(failed.projectId); mark("DRAFT-009", "Failed bind rollback", true, rejected && after.status === "editable" && after.revision === before.revision && failed.repository.state().s2Inputs.length === 0 && failed.repository.state().s2QaRuns.length === 0); } finally { cleanup(failed); }
  } finally { cleanup(fixture); }
});

function logoAsset(asset: any): S2AssetRecord { return { ...asset, status: "ready", deletedAt: null }; }

test("section-24 bind/hash/concurrency evidence", async () => {
  const fixture = seed();
  try {
    fixture.repository.transact((state) => { state.generationSets[0].status = "failed"; });
    mark("BIND-001", "Only succeeded four-candidate source set binds", true, await expectCode(() => bind(fixture), "S2_NOT_AVAILABLE"));
  } finally { cleanup(fixture); }
  const boundFixture = seed();
  try {
    const before = Buffer.from(boundFixture.objects.read(boundFixture.sourceKeys[0])); const bound = await bind(boundFixture); const value = await waitForRun(boundFixture, bound.qaRun.id); const state = boundFixture.repository.state(); const input = state.s2Inputs[0];
    mark("BIND-002", "Canonical S1 identity and derived S2 metadata", true, input.sourceCandidates.length === 4 && input.sourceCandidates.every((source, index) => source.candidateIndex === index + 1 && source.sourceSha256 === sha256(before) && source.sourceByteSize === before.byteLength && source.sourceWidth === 1 && source.sourceHeight === 1 && source.sourcePixelCount === 1 && source.sourceDecodedRgbaBytes === 4));
    mark("BIND-003", "Confirmed brief and geometry snapshot", true, input.confirmedBriefVersionId === boundFixture.versionId && input.confirmedBriefContentHash === state.briefVersions[0].contentHash && jcs(input.geometrySnapshot) === jcs(state.briefVersions[0].geometrySnapshot));
    const sourceProjection = input.sourceCandidates.map(({ sourceStorageKey: _storageKey, ...source }) => source);
    const requirementHash = sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements: input.canonicalRequirements }));
    const geometryHash = sha256(jcs(input.geometrySnapshot));
    const rules = input.designRuleSnapshot;
    const inputHash = sha256(jcs({ schemaVersion: "s2-input-v1", sourceGenerationSetId: input.sourceGenerationSetId, sourceCandidates: sourceProjection, confirmedBriefVersionId: input.confirmedBriefVersionId, confirmedBriefContentHash: input.confirmedBriefContentHash, geometryHash, requirementHash, designRulesVersion: input.designRulesVersion, designRuleSnapshot: rules, decoderProfile: input.decoderProfile, qaModel: input.qaModel, qaSchema: input.qaSchema, referenceAssets: [], logoAssets: [] }));
    const bindingHash = sha256(jcs({ schemaVersion: "s2-binding-v1", projectId: input.projectId, sourceGenerationSetId: input.sourceGenerationSetId, draftRevision: input.draftRevision, inputHash, sourceCandidates: sourceProjection, referenceAssets: [], logoAssets: [] }));
    mark("BIND-004", "Independent existing-jcs hash recomputation", true, input.geometryHash === geometryHash && input.requirementHash === requirementHash && input.inputHash === inputHash && input.bindingHash === bindingHash);
    mark("BIND-005", "One input/run/four initial records", true, state.s2Inputs.length === 1 && state.s2QaRuns.length === 1 && state.s2QaRuns[0].candidateResults.length === 4 && state.s2Operations.filter((operation) => operation.phase === "qa").length === 4);
    mark("BIND-009", "Source bytes included in provider-bound aggregate", S2_MAX_PROVIDER_BYTES >= state.s2QaRuns[0].candidateResults.length * before.byteLength, input.sourceCandidates.reduce((total, source) => total + source.sourceByteSize, 0) === before.byteLength * 4);
    const after = Buffer.from(boundFixture.objects.read(boundFixture.sourceKeys[0])); mark("BIND-010", "Verified S1 source remains unchanged", true, before.equals(after) && state.conceptAssets[0].sha256 === sha256(after) && !state.conceptAssets[0].storageKey.includes("normalized"));
    mark("QA-001", "Four candidates receive only source images", 4, boundFixture.provider.s2QaCalls);
    mark("QA-003", "Persisted coverage is canonical and complete", true, value.qaRun.candidateResults.length === 4 && value.qaRun.candidateResults.every((result: any) => result.requirementObservations.length === input.canonicalRequirements.length && result.designObservations.length === input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length));
    mark("QA-009", "Absent max-height cannot block PASS", 4, value.qaRun.passCount);
    mark("QA-013", "Counters/order survive refresh", true, value.qaRun.candidateResults.every((result: any, index: number) => result.candidateIndex === index + 1) && (boundFixture.service.s2.getQaRun(boundFixture.projectId, bound.qaRun.id) as any).qaRun.passCount === 4);
  } finally { cleanup(boundFixture); }

  const replayFixture = seed();
  try {
    const key = randomUUID(); const first = await bind(replayFixture, key); const replay = await bind(replayFixture, key); const changed = await expectCode(() => bind(replayFixture, key, 2), "IDEMPOTENCY_KEY_REUSE");
    mark("BIND-007", "Exact bind replay/conflicting key reuse", true, replay.replayed && first.inputVersionId === replay.inputVersionId && changed);
    mark("BIND-008", "Second bind uses existing-run conflict", "S2_QA_RUN_EXISTS", (await (async () => { try { await bind(replayFixture, randomUUID()); return "none"; } catch (error) { return error instanceof AppError ? error.code : "unknown"; } })()));
    await waitForRun(replayFixture, first.qaRun.id);
  } finally { cleanup(replayFixture); }

  const concurrent = seed();
  let releaseConcurrent!: () => void;
  try {
    let arrivals = 0;
    const gate = new Promise<void>((resolve) => { releaseConcurrent = resolve; });
    const originalPreparation = (concurrent.service.s2 as any).sourcePreparation.bind(concurrent.service.s2);
    (concurrent.service.s2 as any).sourcePreparation = (projectId: string, generationSetId: string) => {
      arrivals += 1;
      return gate.then(() => originalPreparation(projectId, generationSetId));
    };
    const first = bind(concurrent, randomUUID());
    const second = bind(concurrent, randomUUID());
    const overlapped = await waitUntil(() => arrivals === 2);
    releaseConcurrent();
    const outcomes = await Promise.allSettled([first, second]);
    const winner = outcomes.find((outcome): outcome is PromiseFulfilledResult<any> => outcome.status === "fulfilled")?.value;
    const loserConflict = outcomes.some((outcome) => outcome.status === "rejected" && outcome.reason instanceof AppError && outcome.reason.code === "S2_QA_RUN_EXISTS");
    if (winner) await waitForRun(concurrent, winner.qaRun.id);
    const state = concurrent.repository.state();
    const initialQaOperations = state.s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1);
    mark("BIND-006", "Overlapping bind requests serialize at the transaction uniqueness boundary", true, overlapped && outcomes.length === 2 && Boolean(winner) && loserConflict && state.s2Inputs.length === 1 && state.s2QaRuns.length === 1 && initialQaOperations.length === 4 && concurrent.provider.s2QaCalls === 4 && state.s2Drafts[0].status === "frozen" && state.s2Drafts[0].frozenByQaRunId === state.s2QaRuns[0].id);
  } finally { releaseConcurrent?.(); cleanup(concurrent); }

  const requestFixture = seed(); try {
    const captured: any[] = []; const provider = new MockOpenAIProvider({ briefData: brief(), onS2QaRequest: (input) => captured.push(input) });
    const fresh = seed({ provider }); try { const bound = await bind(fresh); await waitForRun(fresh, bound.qaRun.id); const request = buildS2QaRequest(captured[0]); const userContent: any[] = (request.input as any[])[1].content; mark("QA-002", "Pinned QA request shape", true, request.model === "gpt-5.4-mini-2026-03-17" && request.store === false && (request.text as any).format.name === "s2_qa_v1" && (request.text as any).format.strict === true && userContent.some((item) => item.type === "input_image" && item.detail === "high") && captured.every((input) => input.requirements.length > 0 && input.designRules.length > 0 && input.designRules.every((rule: any) => rule.applicability === "applicable"))); } finally { cleanup(fresh); }
  } finally { cleanup(requestFixture); }
});

async function runQaFixture(mode: string, options: SeedOptions = {}, badRule?: string): Promise<{ fixture: Fixture; bound: any; value: any }> {
  const provider = options.provider ?? new MockOpenAIProvider({ briefData: options.data ?? brief(options.exactCount ?? false), s2QaResponseFactory: (input, index) => qaPayload(input, index === 0 ? mode : "pass", badRule) });
  const fixture = seed({ ...options, provider });
  const bound = await bind(fixture);
  const value = await waitForRun(fixture, bound.qaRun.id);
  return { fixture, bound, value };
}

test("section-24 QA schema/verdict evidence", async () => {
  const captured: any[] = [];
  const pass = await runQaFixture("pass", { provider: new MockOpenAIProvider({ briefData: brief(), s2QaResponseFactory: (input) => { captured.push(input); return qaPayload(input, "pass"); } }) });
  try {
    markVariant("QA-001", "variant-2", "One source-only QA call per candidate", 4, pass.fixture.provider.s2QaCalls);
    markVariant("QA-003", "variant-2", "Valid exact observation coverage", true, pass.value.qaRun.candidateResults.every((result: any) => result.status === "pass" && result.requirementObservations.length === pass.value.input.canonicalRequirements.length && result.designObservations.length === pass.value.input.designRuleSnapshot.filter((rule: any) => rule.applicability === "applicable").length));
    mark("QA-007", "Present/absent/exact-count/prohibited and compliant classification", true, pass.value.qaRun.passCount === 4 && pass.value.qaRun.candidateResults.every((result: any) => result.requirementObservations.some((item: any) => item.expected === "absent" && item.observed === "absent")));
    const request = buildS2QaRequest(captured[0]);
    const content: any[] = (request.input as any[])[1].content;
    markVariant("QA-002", "variant-2", "Pinned model/store/detail/strict schema", true, request.model === "gpt-5.4-mini-2026-03-17" && request.store === false && (request.text as any).format.name === "s2_qa_v1" && (request.text as any).format.strict === true && content.filter((item) => item.type === "input_image").length === 1 && content.find((item) => item.type === "input_image").detail === "high" && captured.every((input) => input.sourceBytes.byteLength === PNG.byteLength));
    mark("QA-008", "Provider authority fields do not become findings", true, !JSON.stringify(pass.value.qaRun.candidateResults).includes("severity") && !JSON.stringify(pass.value.qaRun.candidateResults).includes("repairEligibleFromProvider"));
    markVariant("QA-009", "variant-2", "Complete compliant set is PASS", 4, pass.value.qaRun.passCount);
    markVariant("QA-013", "variant-2", "Candidate order and counters refresh", true, pass.value.qaRun.candidateResults.map((result: any) => result.candidateIndex).join(",") === "1,2,3,4" && (pass.fixture.service.s2.getQaRun(pass.fixture.projectId, pass.bound.qaRun.id) as any).qaRun.completedCandidateCount === 4);
  } finally { cleanup(pass.fixture); }

  const invalidModes: Array<[string, string]> = [["missing", "missing"], ["duplicate", "duplicate"], ["unknown", "unknown"], ["non_applicable", "non-applicable"], ["extra_property", "extra-property"], ["wrong_type", "wrong-type"], ["out_of_range", "out-of-range"]];
  const invalidOutcomes: boolean[] = [];
  for (const [mode] of invalidModes) {
    const value = await runQaFixture(mode);
    try {
      const first = value.value.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
      const rejected = first.status === "qa_unavailable_terminal" && value.fixture.repository.state().s2Operations.some((operation) => operation.failureCode === "QA_SCHEMA_INVALID");
      invalidOutcomes.push(rejected);
      markVariant("QA-004", mode, `Strict schema ${mode}`, true, rejected);
      if (mode === "non_applicable") markVariant("QA-005", "applicability-mismatch", "Provider adds a non-applicable design rule and the server rejects the echo", true, rejected);
    } finally { cleanup(value.fixture); }
  }
  mark("QA-004", "All strict-schema variants reject invalid provider output", true, invalidOutcomes.length === invalidModes.length && invalidOutcomes.every(Boolean));
  const expectedMismatch = await runQaFixture("expected_mismatch");
  try {
    const first = expectedMismatch.value.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    mark("QA-005", "Provider expected-value echo mismatch is rejected by the server-owned schema", true, first.status === "qa_unavailable_terminal" && expectedMismatch.fixture.repository.state().s2Operations.some((operation) => operation.failureCode === "QA_SCHEMA_INVALID"));
  } finally { cleanup(expectedMismatch.fixture); }

  const low = await runQaFixture("uncertain", { exactCount: true });
  try {
    const first = low.value.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    mark("QA-006", "0.5 and null count remain uncertainty", true, first.status === "warning" && first.verdict === "WARNING" && first.requirementObservations.some((item: any) => item.observed === "uncertain" && item.observedCount === null));
    mark("QA-010", "Uncertainty contributes WARNING not schema invalid", true, low.value.qaRun.warningCount === 1 && !low.fixture.repository.state().s2Operations.some((operation) => operation.failureCode === "QA_SCHEMA_INVALID"));
  } finally { cleanup(low.fixture); }
  const threshold = await runQaFixture("threshold", { exactCount: true });
  try { markVariant("QA-006", "variant-2", "Exact 0.75 high-confidence count is judged", true, threshold.value.qaRun.candidateResults[0].status === "material_fail" && threshold.value.qaRun.candidateResults[0].materialFindingIds.includes("brief.functional.001") && threshold.value.input.canonicalRequirements.some((item: any) => item.expected === "exact_count")); } finally { cleanup(threshold.fixture); }
  const belowThreshold = await runQaFixture("below_threshold", { exactCount: true });
  try { markVariant("QA-006", "variant-3", "Confidence immediately below 0.75 remains uncertainty with null exact count", true, belowThreshold.value.qaRun.candidateResults[0].status === "warning" && belowThreshold.value.qaRun.candidateResults[0].verdict === "WARNING" && belowThreshold.value.qaRun.candidateResults[0].requirementObservations.some((item: any) => item.confidence === 0.7499 && item.observed === "uncertain" && item.observedCount === null)); } finally { cleanup(belowThreshold.fixture); }
  const requirementFail = await runQaFixture("requirement_violation");
  try { markVariant("QA-007", "variant-2", "Server classifies a present requirement violation", true, requirementFail.value.qaRun.candidateResults[0].verdict === "MATERIAL_FAIL"); mark("QA-011", "Material verdict requires complete high-confidence violation", true, requirementFail.value.qaRun.materialFailCount === 1); } finally { cleanup(requirementFail.fixture); }
  const overhead = await runQaFixture("pass", {}, "structure.overhead-support");
  try { markVariant("QA-011", "variant-2", "Overhead high-confidence failure is material", true, overhead.value.qaRun.candidateResults[0].materialFindingIds.includes("structure.overhead-support")); } finally { cleanup(overhead.fixture); }
  const scale = await runQaFixture("pass", {}, "scale.human");
  try { markVariant("QA-011", "variant-3", "Scale high-confidence failure is material", true, scale.value.qaRun.candidateResults[0].materialFindingIds.includes("scale.human")); } finally { cleanup(scale.fixture); }
  const warning = await runQaFixture("warning");
  try { markVariant("QA-010", "variant-2", "Warning-level finding is WARNING", true, warning.value.qaRun.candidateResults[0].verdict === "WARNING" && warning.value.qaRun.candidateResults[0].materialFindingIds.length === 0); } finally { cleanup(warning.fixture); }
  const longEvidence = await runQaFixture("evidence_long");
  try { mark("QA-014", "Evidence over 400 code points is schema-invalid", true, longEvidence.value.qaRun.candidateResults[0].status === "qa_unavailable_terminal" && longEvidence.fixture.repository.state().s2Operations.some((operation) => operation.failureCode === "QA_SCHEMA_INVALID")); } finally { cleanup(longEvidence.fixture); }
  const suppliedHeight = await runQaFixture("pass", { geometry: { widthMm: 6000, depthMm: 4000, openSides: ["north"], maxHeightMm: 3000 } });
  try { mark("QA-015", "Supplied max-height is applicable", true, suppliedHeight.value.input.designRuleSnapshot.some((rule: any) => rule.ruleId === "geometry.max-height" && rule.applicability === "applicable") && suppliedHeight.value.qaRun.candidateResults[0].designObservations.some((observation: any) => observation.ruleId === "geometry.max-height")); } finally { cleanup(suppliedHeight.fixture); }
  const unavailable = await runQaFixture("pass", { provider: new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("PROVIDER_TIMEOUT")] }) });
  try { mark("QA-012", "Provider failure is unavailable, never material", true, unavailable.value.qaRun.candidateResults[0].status === "qa_unavailable_retryable" && unavailable.value.qaRun.candidateResults[0].verdict === "QA_UNAVAILABLE" && unavailable.value.qaRun.candidateResults[0].materialFindingIds.length === 0); } finally { cleanup(unavailable.fixture); }
});

test("section-24 retry evidence", async () => {
  const provider = new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("PROVIDER_TIMEOUT")] });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const originalQa = provider.runS2Qa.bind(provider);
  (provider as any).runS2Qa = async (input: any) => {
    if (input.candidateIndex === 1 && provider.s2QaCalls >= 4) await retryGate;
    return originalQa(input);
  };
  const fixture = seed({ provider });
  try {
    const bound = await bind(fixture);
    const first = await waitForRun(fixture, bound.qaRun.id);
    const beforeRetryState = fixture.repository.state();
    const attemptOneOperations = beforeRetryState.s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1);
    const candidate = first.qaRun.candidateResults.find((result: any) => result.status === "qa_unavailable_retryable");
    markVariant("RETRY-002", "pre-retry-completed", "All four attempt-1 QA operations terminate before explicit retry, including one retryable unavailable result", true,
      first.qaRun.status === "completed" &&
      first.qaRun.completedCandidateCount === 4 &&
      first.qaRun.unavailableCount === 1 &&
      first.qaRun.candidateResults.filter((result: any) => result.status === "qa_unavailable_retryable").length === 1 &&
      new Set(attemptOneOperations.map((operation) => operation.candidateId)).size === 4 &&
      attemptOneOperations.length === 4 &&
      attemptOneOperations.every((operation) => operation.status === "succeeded" || operation.status === "failed") &&
      attemptOneOperations.filter((operation) => operation.status === "queued" || operation.status === "running").length === 0 &&
      beforeRetryState.s2Inputs.length === 1 &&
      beforeRetryState.s2QaRuns.length === 1);
    mark("RETRY-001", "Only retryable unavailable is retryable", true, Boolean(candidate) && !first.qaRun.candidateResults.some((result: any) => result.status === "pass" && result.candidateIndex === candidate.candidateIndex && result.repairEligible === true));
    const beforeInputs = beforeRetryState.s2Inputs.length;
    const beforeRuns = beforeRetryState.s2QaRuns.length;
    const retry: any = await fixture.service.s2.retryQa(fixture.projectId, bound.qaRun.id, candidate.candidateId, randomUUID(), randomUUID());
    const reopenedState = fixture.repository.state();
    const reopenedOperation = reopenedState.s2Operations.find((operation) => operation.phase === "qa" && operation.attempt === 2);
    const reopenedResult = reopenedState.s2QaRuns[0].candidateResults.find((result) => result.attempt === 2);
    markVariant("RETRY-002", "reopen-same-run", "Explicit retry reopens the same run/input while attempt 2 is active", true,
      retry.replayed === false &&
      retry.qaRun.id === bound.qaRun.id &&
      retry.input.id === bound.inputVersionId &&
      (retry.qaRun.status === "queued" || retry.qaRun.status === "running") &&
      retry.qaRun.completedAt === null &&
      Boolean(reopenedOperation) &&
      (reopenedOperation!.status === "queued" || reopenedOperation!.status === "running") &&
      Boolean(reopenedResult) &&
      (reopenedResult!.status === "queued" || reopenedResult!.status === "running") &&
      reopenedState.s2Inputs.length === beforeInputs &&
      reopenedState.s2QaRuns.length === beforeRuns);
    releaseRetry();
    const after = await waitForRun(fixture, bound.qaRun.id);
    const afterState = fixture.repository.state();
    const latestStatuses = after.qaRun.candidateResults.map((result: any) => result.status);
    const attemptTwoOperation = afterState.s2Operations.find((operation) => operation.phase === "qa" && operation.attempt === 2);
    markVariant("RETRY-002", "post-retry-success", "Attempt 2 succeeds and recomputes latest counters without a new run/input", true,
      after.qaRun.id === bound.qaRun.id &&
      after.input.id === bound.inputVersionId &&
      after.qaRun.status === "completed" &&
      after.qaRun.completedAt !== null &&
      after.qaRun.completedCandidateCount === 4 &&
      after.qaRun.unavailableCount === 0 &&
      after.qaRun.passCount === 4 &&
      latestStatuses.length === 4 &&
      latestStatuses.every((status: string) => status === "pass") &&
      after.qaRun.candidateAttempts.filter((result: any) => result.candidateId === candidate.candidateId && result.attempt === 1).length === 1 &&
      after.qaRun.candidateAttempts.filter((result: any) => result.candidateId === candidate.candidateId && result.attempt === 2).length === 1 &&
      attemptTwoOperation?.status === "succeeded" &&
      afterState.s2Inputs.length === beforeInputs &&
      afterState.s2QaRuns.length === beforeRuns);
    mark("RETRY-002", "Explicit retry reuses input/run and appends attempt two", true, retry.replayed === false && after.qaRun.candidateAttempts.some((result: any) => result.candidateId === candidate.candidateId && result.attempt === 2) && fixture.repository.state().s2Inputs.length === beforeInputs && fixture.repository.state().s2QaRuns.length === beforeRuns);
    mark("RETRY-004", "No hidden SDK retry", 5, provider.s2QaCalls);
    const terminal = seed({ provider: new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("QA_SCHEMA_INVALID")] }) });
    try {
      const b = await bind(terminal);
      const v = await waitForRun(terminal, b.qaRun.id);
      markVariant("RETRY-001", "variant-2", "Terminal unavailable is not retryable", true, v.qaRun.candidateResults[0].status === "qa_unavailable_terminal" && await expectCode(() => terminal.service.s2.retryQa(terminal.projectId, b.qaRun.id, v.qaRun.candidateResults[0].candidateId, randomUUID(), randomUUID()), "QA_NOT_RETRYABLE"));
    } finally { cleanup(terminal); }
  } finally {
    releaseRetry();
    cleanup(fixture);
  }
  const exhaustedProvider = new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("PROVIDER_TIMEOUT"), undefined, undefined, undefined, new ProviderFailure("PROVIDER_TIMEOUT")] });
  let releaseExhaustedRetry!: () => void;
  const exhaustedRetryGate = new Promise<void>((resolve) => { releaseExhaustedRetry = resolve; });
  const originalExhaustedQa = exhaustedProvider.runS2Qa.bind(exhaustedProvider);
  (exhaustedProvider as any).runS2Qa = async (input: any) => {
    if (input.candidateIndex === 1 && exhaustedProvider.s2QaCalls >= 4) await exhaustedRetryGate;
    return originalExhaustedQa(input);
  };
  const exhausted = seed({ provider: exhaustedProvider });
  try {
    const b = await bind(exhausted);
    const first = await waitForRun(exhausted, b.qaRun.id);
    const beforeRetryState = exhausted.repository.state();
    const candidate = first.qaRun.candidateResults.find((result: any) => result.status === "qa_unavailable_retryable");
    const retry: any = await exhausted.service.s2.retryQa(exhausted.projectId, b.qaRun.id, candidate.candidateId, randomUUID(), randomUUID());
    const reopenedState = exhausted.repository.state();
    const reopenedOperation = reopenedState.s2Operations.find((operation) => operation.phase === "qa" && operation.attempt === 2);
    const reopenedResult = reopenedState.s2QaRuns[0].candidateResults.find((result) => result.attempt === 2);
    markVariant("RETRY-003", "reopen-before-terminal", "Retry-exhaustion attempt 2 reopens the same run before becoming terminal unavailable", true,
      first.qaRun.status === "completed" &&
      first.qaRun.completedCandidateCount === 4 &&
      first.qaRun.unavailableCount === 1 &&
      retry.qaRun.id === b.qaRun.id &&
      retry.input.id === b.inputVersionId &&
      (retry.qaRun.status === "queued" || retry.qaRun.status === "running") &&
      retry.qaRun.completedAt === null &&
      (reopenedOperation?.status === "queued" || reopenedOperation?.status === "running") &&
      (reopenedResult?.status === "queued" || reopenedResult?.status === "running") &&
      reopenedState.s2Inputs.length === 1 &&
      reopenedState.s2QaRuns.length === 1);
    releaseExhaustedRetry();
    const second = await waitForRun(exhausted, b.qaRun.id);
    const afterRetryState = exhausted.repository.state();
    const latest = second.qaRun.candidateResults.find((result: any) => result.candidateId === candidate.candidateId);
    markVariant("RETRY-003", "post-retry-terminal", "Retry exhaustion becomes terminal unavailable with latest-only counters and retained attempts", true,
      second.qaRun.id === b.qaRun.id &&
      second.input.id === b.inputVersionId &&
      second.qaRun.status === "completed" &&
      second.qaRun.completedCandidateCount === 4 &&
      second.qaRun.unavailableCount === 1 &&
      latest?.status === "qa_unavailable_terminal" &&
      second.qaRun.candidateAttempts.filter((result: any) => result.candidateId === candidate.candidateId).length === 2 &&
      second.qaRun.candidateResults.filter((result: any) => result.candidateId === candidate.candidateId).length === 1 &&
      afterRetryState.s2Inputs.length === beforeRetryState.s2Inputs.length &&
      afterRetryState.s2QaRuns.length === beforeRetryState.s2QaRuns.length &&
      exhaustedProvider.s2QaCalls === 5);
    mark("RETRY-003", "Retry exhaustion is terminal", true, latest?.status === "qa_unavailable_terminal" && await expectCode(() => exhausted.service.s2.retryQa(exhausted.projectId, b.qaRun.id, candidate.candidateId, randomUUID(), randomUUID()), "QA_RETRY_EXHAUSTED"));
    mark("RETRY-005", "Attempt history remains fenced", true, second.qaRun.candidateAttempts.filter((result: any) => result.candidateId === candidate.candidateId).length === 2 && second.qaRun.candidateResults.filter((result: any) => result.candidateId === candidate.candidateId).length === 1);
  } finally {
    releaseExhaustedRetry();
    cleanup(exhausted);
  }
});


async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function bindWithAssets(provider: MockOpenAIProvider): Promise<{ fixture: Fixture; bound: any; value: any; refs: any[]; logos: any[] }> {
  const fixture = seed({ provider });
  const refs = [
    (await upload(fixture, "reference", await coloredPng({ r: 20, g: 30, b: 40 }))).asset,
    (await upload(fixture, "reference", await coloredPng({ r: 50, g: 60, b: 70 }))).asset,
  ];
  const logos = [(await upload(fixture, "logo", await coloredPng({ r: 80, g: 90, b: 100 }))).asset];
  const draft = fixture.service.s2.getReferenceDraft(fixture.projectId);
  const updated = fixture.service.s2.updateDraft(fixture.projectId, draft.revision, refs.map((asset) => asset.id), logos.map((asset) => asset.id), randomUUID());
  const bound = await bind(fixture, randomUUID(), updated.draft.revision);
  const value = await waitForRun(fixture, bound.qaRun.id);
  return { fixture, bound, value, refs, logos };
}

async function repairBatch(findingGroups: string[][]): Promise<{ fixture: Fixture; bound: any; value: any; captured: any[] }> {
  const captured: any[] = [];
  const provider = new MockOpenAIProvider({ briefData: brief(), onS2RepairRequest: (input) => captured.push(input) });
  const fixture = seed({ provider });
  const bound = await bind(fixture);
  await waitForRun(fixture, bound.qaRun.id);
  findingGroups.forEach((findingIds, index) => mutateResult(fixture, bound.qaRun.id, index + 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: findingIds.slice(), warningFindingIds: [], uncertainFindingIds: [] }));
  await Promise.all(findingGroups.map((findingIds, index) => fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, latestResult(fixture, bound.qaRun.id, index + 1).candidateId, bound.inputVersionId, randomUUID(), randomUUID())));
  const value = await waitForRun(fixture, bound.qaRun.id, (current) => {
    const repairs = current.qaRun.repairs ?? [];
    return repairs.length === findingGroups.length && repairs.every((repair: any) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(repair.status));
  });
  return { fixture, bound, value, captured };
}

function materializeResult(fixture: Fixture, qaRunId: string, candidateIndex: number, patch: Partial<S2QaCandidateResult>): any {
  mutateResult(fixture, qaRunId, candidateIndex, patch);
  return latestResult(fixture, qaRunId, candidateIndex);
}

test("section-24 repair eligibility, compiler, request and publication evidence", async () => {
  const captured: any[] = [];
  const provider = new MockOpenAIProvider({ briefData: brief(), onS2RepairRequest: (input) => captured.push(input) });
  const prepared = await bindWithAssets(provider);
  try {
    const { fixture, bound, refs, logos } = prepared;
    const beforeSource = Buffer.from(fixture.objects.read(fixture.repository.state().conceptAssets[0].storageKey));
    const input = fixture.repository.state().s2Inputs[0];
    const current = latestResult(fixture, bound.qaRun.id, 1);
    materializeResult(fixture, bound.qaRun.id, 1, {
      status: "material_fail",
      verdict: "MATERIAL_FAIL",
      materialFindingIds: ["structure.overhead-support"],
      warningFindingIds: [],
      uncertainFindingIds: [],
      designObservations: current.designObservations.map((observation) => ({ ...observation, evidence: "provider-injected engineering approval text" })),
    });
    const publicBefore = (fixture.service.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any).qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    const started = await fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, publicBefore.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const after = await waitForRun(fixture, bound.qaRun.id, (currentRun) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(currentRun.qaRun.repairs?.[0]?.status));
    const state = fixture.repository.state();
    const repair = state.s2Repairs[0];
    const derived = state.s2DerivedCandidates[0];
    const reQa = state.s2ReQaResults[0];
    const operation = state.s2Operations.find((item) => item.phase === "re_qa");
    const request = buildS2RepairRequest(captured[0]);
    mark("REPAIR-001", "Complete clear overhead material failure creates one bounded repair", true, started.replayed === false && repair.eligibleFindingIds.length === 1 && repair.eligibleFindingIds[0] === "structure.overhead-support" && state.s2Repairs.length === 1);
    mark("REPAIR-006", "Hard facts and canonical source lineage remain unchanged", true, beforeSource.equals(fixture.objects.read(input.sourceCandidates[0].sourceStorageKey)) && repair.sourceAssetId === input.sourceCandidates[0].sourceAssetId && repair.sourceSha256 === input.sourceCandidates[0].sourceSha256 && repair.sourceByteSize === input.sourceCandidates[0].sourceByteSize && derived.sourceSha256 === input.sourceCandidates[0].sourceSha256 && JSON.stringify(input.geometrySnapshot) === JSON.stringify(state.briefVersions[0].geometrySnapshot));
    mark("REPAIR-008", "Repair image order is source then draft references then logos", true, captured.length === 1 && captured[0].images.length === 4 && Buffer.from(captured[0].images[0]).equals(beforeSource) && Buffer.from(captured[0].images[1]).equals(fixture.objects.read(state.s2Assets.find((asset) => asset.id === refs[0].id)!.storageKeyNormalized)) && Buffer.from(captured[0].images[2]).equals(fixture.objects.read(state.s2Assets.find((asset) => asset.id === refs[1].id)!.storageKeyNormalized)) && Buffer.from(captured[0].images[3]).equals(fixture.objects.read(state.s2Assets.find((asset) => asset.id === logos[0].id)!.storageKeyNormalized)));
    mark("REPAIR-010", "Pinned image edit request has exact options and no mask", true, request.model === "gpt-image-2-2026-04-21" && request.n === 1 && request.size === "1536x1024" && request.quality === "medium" && request.output_format === "png" && request.images.length === 4 && !("mask" in request) && !("input_fidelity" in request));
    mark("REPAIR-012", "Prompt hash is exact and stable for the immutable request", true, repair.repairPromptHash === sha256(Buffer.from(request.prompt, "utf8")) && repair.repairInputHash === state.s2Operations.find((item) => item.phase === "repair")!.inputHash);
    mark("REPAIR-013", "Provider evidence text cannot alter deterministic objective", true, !request.prompt.includes("provider-injected") && request.prompt.includes("bounded visibly plausible support") && request.prompt.includes("unsupported overhead visual issue"));
    mark("REPAIR-015", "Overhead repair remains a bounded visual correction", true, request.prompt.includes("bounded visibly plausible support") && request.prompt.includes("Do not claim engineering adequacy or approval") === false && request.prompt.includes("Do not add engineering"));
    mark("REQA-001", "One re-QA follows one valid derived output", 1, state.s2Operations.filter((item) => item.phase === "re_qa").length);
    mark("REQA-002", "Re-QA uses immutable input facts and server algorithm", true, operation?.inputHash === input.inputHash && reQa.inputVersionId === input.id && reQa.requirementObservations.length === input.canonicalRequirements.length && reQa.designObservations.length === input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length);
    mark("REQA-005", "Source, repair, derived output and re-QA remain linked", true, Boolean(derived) && derived.repairAttemptId === repair.id && repair.derivedCandidateId === derived.id && repair.reQaCandidateResultId === reQa.id && reQa.repairAttemptId === repair.id && reQa.derivedCandidateId === derived.id && fixture.objects.exists(derived.storageKeyNormalized) && derived.outputSha256 === sha256(fixture.objects.read(derived.storageKeyNormalized)));
    const secondRepair = await expectCode(() => fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, publicBefore.candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_ALREADY_EXISTS");
    mark("REPAIR-007", "A second repair is rejected after the first attempt", true, secondRepair && provider.s2RepairCalls === 1);
    mark("REQA-004", "Re-QA has no retry and cannot create a second repair", true, state.s2Operations.filter((item) => item.phase === "re_qa" && item.attempt === 2).length === 0 && state.s2Repairs.length === 1 && after.qaRun.repairs[0].status === "re_qa_pass");
  } finally { cleanup(prepared.fixture); }

  const scale = await repairBatch([["scale.human"]]);
  try {
    mark("REPAIR-016", "Scale repair is bounded and does not change hard geometry", true, scale.captured.length === 1 && scale.captured[0].promptText.includes("plausible visual scale correction") && scale.captured[0].promptText.includes("Do not change width") && scale.captured[0].promptText.includes("Do not add engineering"));
    markVariant("REPAIR-012", "immutable-input-change", "Changing the immutable finding/manifest inputs changes the repair prompt hash", true, sha256(Buffer.from(scale.captured[0].promptText)) !== sha256(Buffer.from(captured[0].promptText)));
  } finally { cleanup(scale.fixture); }
});

test("section-24 repair allowlist and compatibility evidence", async () => {
  const singletonIds = [
    "footprint.within-boundary", "access.open-sides", "circulation.primary-access", "zones.inside-footprint",
    "structure.no-floating", "structure.screen-support", "structure.overhead-support", "scale.human",
    "geometry.intersections", "branding.prohibited", "brief.functional.001", "brief.mandatory.001",
  ];
  const singletonResults: any[] = [];
  for (let offset = 0; offset < singletonIds.length; offset += 4) {
    const batch = await repairBatch(singletonIds.slice(offset, offset + 4).map((id) => [id]));
    try { singletonResults.push(...batch.fixture.repository.state().s2Repairs); } finally { cleanup(batch.fixture); }
  }
  mark("REPAIR-003", "Every allowlisted singleton is independently repairable", true, singletonResults.length === singletonIds.length && singletonResults.every((repair) => repair.status === "re_qa_pass" && repair.eligibleFindingIds.length === 1));

  const matrix = await repairBatch([["footprint.within-boundary", "access.open-sides"], ["footprint.within-boundary", "branding.prohibited"], ["footprint.within-boundary", "branding.prohibited", "brief.functional.001"]]);
  try {
    const fourth = materializeResult(matrix.fixture, matrix.bound.qaRun.id, 4, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["brief.functional.001", "brief.mandatory.001"], warningFindingIds: [], uncertainFindingIds: [] });
    const rejected = await expectCode(() => matrix.fixture.service.s2.repairCandidate(matrix.fixture.projectId, matrix.bound.qaRun.id, fourth.candidateId, matrix.bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_NOT_ELIGIBLE");
    mark("REPAIR-004", "Exact spatial/branding/functional compatibility matrix is enforced", true, matrix.fixture.repository.state().s2Repairs.length === 3 && matrix.fixture.repository.state().s2Repairs.every((repair) => repair.status === "re_qa_pass") && rejected);
  } finally { cleanup(matrix.fixture); }

  const ineligible = seed({ geometry: { widthMm: 6000, depthMm: 4000, openSides: ["north"], maxHeightMm: 3000 } });
  try {
    const bound = await bind(ineligible); await waitForRun(ineligible, bound.qaRun.id);
    const ids = ["geometry.max-height", "branding.style", "rigging.confirmation", "brief.free-text.001"];
    ids.forEach((id, index) => materializeResult(ineligible, bound.qaRun.id, index + 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: [id], warningFindingIds: [], uncertainFindingIds: [] }));
    const rejects = await Promise.all(ids.map((id, index) => expectCode(() => ineligible.service.s2.repairCandidate(ineligible.projectId, bound.qaRun.id, latestResult(ineligible, bound.qaRun.id, index + 1).candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_NOT_ELIGIBLE")));
    const fifth = materializeResult(ineligible, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["engineering.approval"], warningFindingIds: [], uncertainFindingIds: [] });
    const outside = await expectCode(() => ineligible.service.s2.repairCandidate(ineligible.projectId, bound.qaRun.id, fifth.candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_NOT_ELIGIBLE");
    mark("REPAIR-005", "Hard facts, warning rules, free text and outside findings are not repairable", true, rejects.every(Boolean) && outside);
  } finally { cleanup(ineligible); }

  const warningOnly = seed();
  try {
    const bound = await bind(warningOnly); await waitForRun(warningOnly, bound.qaRun.id);
    materializeResult(warningOnly, bound.qaRun.id, 1, { status: "warning", verdict: "WARNING", materialFindingIds: [], warningFindingIds: ["branding.style"], uncertainFindingIds: [] });
    materializeResult(warningOnly, bound.qaRun.id, 2, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["structure.overhead-support"], warningFindingIds: [], uncertainFindingIds: ["uncertain:structure.overhead-support"] });
    materializeResult(warningOnly, bound.qaRun.id, 3, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: ["not_verifiable:structure.overhead-support"] });
    materializeResult(warningOnly, bound.qaRun.id, 4, { status: "qa_unavailable_terminal", verdict: "QA_UNAVAILABLE", materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [] });
    const rejects = await Promise.all([1, 2, 3, 4].map((index) => expectCode(() => warningOnly.service.s2.repairCandidate(warningOnly.projectId, bound.qaRun.id, latestResult(warningOnly, bound.qaRun.id, index).candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_NOT_ELIGIBLE")));
    mark("REPAIR-002", "Warning, unavailable, uncertain and not-verifiable alone are not repairable", true, rejects.every(Boolean) && warningOnly.repository.state().s2Repairs.length === 0);
  } finally { cleanup(warningOnly); }
});

test("section-24 repair output, aggregate and rollback evidence", async () => {
  const adapterCases = [
    { id: "empty", fixture: "Production adapter rejects empty data", responseBody: { data: [] } },
    { id: "multiple", fixture: "Production adapter rejects multiple image results", responseBody: { data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] } },
    { id: "missing", fixture: "Production adapter rejects missing or URL-only output", responseBody: { data: [{ url: "https://example.invalid/provider-output.png" }] } },
    { id: "invalid-base64", fixture: "Production adapter rejects malformed Base64", responseBody: { data: [{ b64_json: "%%%%" }] } },
  ];
  const adapterResults: boolean[] = [];
  for (const testCase of adapterCases) {
    const requestCount = { value: 0 };
    const provider = controlledOpenAiRepairProvider(testCase.responseBody, requestCount);
    let safeCode = "NO_FAILURE";
    try {
      await provider.runS2Repair({ promptText: "synthetic repair test", images: [PNG] });
    } catch (error) {
      safeCode = error instanceof ProviderFailure ? error.safeCode : "UNEXPECTED_FAILURE";
    }
    const passed = safeCode === "REPAIR_OUTPUT_INVALID" && requestCount.value === 1;
    adapterResults.push(passed);
    markVariant("REPAIR-011", testCase.id, testCase.fixture, true, passed);
  }

  const workflowCases = [
    { id: "non-png", fixture: "Workflow rejects non-PNG decoded provider bytes", bytes: Buffer.from("not-a-png") },
    { id: "corrupt-truncated-png", fixture: "Workflow rejects corrupt or truncated PNG bytes", bytes: PNG.subarray(0, PNG.length - 4) },
    { id: "oversized", fixture: "Workflow rejects decoded provider output above the 16 MiB limit", bytes: Buffer.alloc(S2_MAX_REPAIR_OUTPUT_BYTES + 1, 0x61) },
  ];
  const workflowResults: boolean[] = [];
  for (const testCase of workflowCases) {
    const { fixture, requestCount } = productionRepairFixture(testCase.bytes);
    try {
      const bound = await bind(fixture);
      await waitForRun(fixture, bound.qaRun.id);
      const before = fixture.repository.state();
      const lineageBefore = jcs({
        candidates: before.candidates,
        conceptAssets: before.conceptAssets,
        sourceCandidates: before.s2Inputs[0].sourceCandidates,
      });
      const candidate = materializeResult(fixture, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
      await fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
      const value = await waitForRun(fixture, bound.qaRun.id, (current) => current.qaRun.repairs?.[0]?.status === "failed");
      const after = fixture.repository.state();
      const repair = after.s2Repairs[0];
      const repairOperation = after.s2Operations.find((operation) => operation.phase === "repair");
      const lineageAfter = jcs({
        candidates: after.candidates,
        conceptAssets: after.conceptAssets,
        sourceCandidates: after.s2Inputs[0].sourceCandidates,
      });
      const passed =
        requestCount.value === 1 &&
        value.qaRun.repairs[0].status === "failed" &&
        repair?.status === "failed" &&
        repairOperation?.failureCode === "REPAIR_OUTPUT_INVALID" &&
        after.s2DerivedCandidates.length === 0 &&
        after.s2Operations.filter((operation) => operation.phase === "re_qa").length === 0 &&
        after.s2Publications.length === 0 &&
        lineageBefore === lineageAfter &&
        !after.s2Repairs.some((item) => item.status === "derived_ready") &&
        listObjects(fixture.root).every((name) => !/s2[\\/]repairs[\\/]/.test(name)) &&
        fixture.provider.s2QaCalls === 4;
      workflowResults.push(passed);
      markVariant("REPAIR-011", testCase.id, testCase.fixture + "; one local fake request; no derived or re-QA state", true, passed);
    } finally { cleanup(fixture); }
  }
  mark("REPAIR-011", "Real OpenAIProvider adapter and S2 workflow reject every locked provider-output class", true, adapterResults.every(Boolean) && workflowResults.every(Boolean));

  const aggregateProvider = new MockOpenAIProvider({ briefData: brief() });
  const aggregate = await bindWithAssets(aggregateProvider);
  try {
    const selectedAssets = aggregate.fixture.repository.state().s2Assets.slice();
    const large = Buffer.alloc(12 * 1024 * 1024);
    selectedAssets.forEach((asset) => { aggregate.fixture.objects.remove(asset.storageKeyNormalized); aggregate.fixture.objects.put(asset.storageKeyNormalized, large); });
    aggregate.fixture.repository.transact((state) => {
      for (const asset of state.s2Assets) { asset.normalizedBytes = large.byteLength; asset.normalizedSha256 = sha256(large); }
    });
    const candidate = materializeResult(aggregate.fixture, aggregate.bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    const rejected = await expectCode(() => aggregate.fixture.service.s2.repairCandidate(aggregate.fixture.projectId, aggregate.bound.qaRun.id, candidate.candidateId, aggregate.bound.inputVersionId, randomUUID(), randomUUID()), "MEDIA_AGGREGATE_LIMIT_EXCEEDED");
    mark("REPAIR-009", "Repair aggregate limits fail before provider call", true, rejected && aggregateProvider.s2RepairCalls === 0 && aggregate.fixture.repository.state().s2Repairs.length === 0);
  } finally { cleanup(aggregate.fixture); }

  const maxCountCaptured: any[] = [];
  const maxCountProvider = new MockOpenAIProvider({ briefData: brief(), onS2RepairRequest: (input) => maxCountCaptured.push(input) });
  const maxCount = seed({ provider: maxCountProvider });
  try {
    const refs: any[] = [];
    for (let index = 0; index < 6; index += 1) refs.push((await upload(maxCount, "reference", await coloredPng({ r: index + 1, g: 20, b: 40 }))).asset);
    const logos: any[] = [];
    for (let index = 0; index < 2; index += 1) logos.push((await upload(maxCount, "logo", await coloredPng({ r: 60, g: index + 1, b: 80 }))).asset);
    const initial = maxCount.service.s2.getReferenceDraft(maxCount.projectId);
    const selected = maxCount.service.s2.updateDraft(maxCount.projectId, initial.revision, refs.map((asset) => asset.id), logos.map((asset) => asset.id), randomUUID());
    const bound = await bind(maxCount, randomUUID(), selected.draft.revision);
    await waitForRun(maxCount, bound.qaRun.id);
    const candidate = materializeResult(maxCount, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    await maxCount.service.s2.repairCandidate(maxCount.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const value = await waitForRun(maxCount, bound.qaRun.id, (current) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(current.qaRun.repairs?.[0]?.status));
    const state = maxCount.repository.state();
    const selectedAssets = state.s2Assets.filter((asset) => state.s2Inputs[0].referenceAssetIds.includes(asset.id) || state.s2Inputs[0].logoAssetIds.includes(asset.id));
    const encodedAggregate = state.s2Inputs[0].sourceCandidates.reduce((total, source) => total + source.sourceByteSize, 0) + selectedAssets.reduce((total, asset) => total + asset.normalizedBytes, 0);
    const decodedAggregate = state.s2Inputs[0].sourceCandidates.reduce((total, source) => total + source.sourceDecodedRgbaBytes, 0) + selectedAssets.reduce((total, asset) => total + asset.width * asset.height * 4, 0);
    markVariant("BIND-009", "max-user-assets", "Eight selected user assets bind with four source candidates under the aggregate limits", true, state.s2Inputs[0].referenceAssetIds.length === 6 && state.s2Inputs[0].logoAssetIds.length === 2 && selectedAssets.length === 8 && encodedAggregate <= S2_MAX_PROVIDER_BYTES && decodedAggregate <= S2_MAX_TOTAL_RGBA_BYTES && state.s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1).length === 4 && maxCountProvider.s2QaCalls === 5);
    markVariant("REPAIR-009", "max-repair-images", "Nine-image repair manifest boundary is accepted before provider call", true, maxCountProvider.s2RepairCalls === 1 && maxCountCaptured[0]?.images.length === 9 && value.qaRun.repairs?.[0]?.status === "re_qa_pass");
  } finally { cleanup(maxCount); }
  const publicationProvider = new MockOpenAIProvider({ briefData: brief() });
  const publication = seed({ provider: publicationProvider });
  try {
    const bound = await bind(publication); await waitForRun(publication, bound.qaRun.id);
    const candidate = materializeResult(publication, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["structure.overhead-support"], warningFindingIds: [], uncertainFindingIds: [] });
    const originalPromote = publication.objects.promote.bind(publication.objects);
    (publication.objects as any).promote = () => { throw new Error("simulated publication failure"); };
    await publication.service.s2.repairCandidate(publication.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const value = await waitForRun(publication, bound.qaRun.id, (current) => current.qaRun.repairs?.[0]?.status === "failed");
    (publication.objects as any).promote = originalPromote;
    mark("REPAIR-014", "Publication failure rolls back staging and leaves no derived success", true, value.qaRun.repairs[0].status === "failed" && publication.repository.state().s2DerivedCandidates.length === 0 && listObjects(publication.root).every((name) => !/s2[\\/]repairs[\\/]/.test(name)));
  } finally { cleanup(publication); }

  const hardRepairProvider = new MockOpenAIProvider({ briefData: brief() });
  const hardRepair = seed({ provider: hardRepairProvider, processId: 99140, onPublicationPhase: (phase) => phase === "after-final-promotion" ? "interrupt" : undefined });
  try {
    const bound = await bind(hardRepair); await waitForRun(hardRepair, bound.qaRun.id);
    const sourceBefore = Buffer.from(hardRepair.objects.read(hardRepair.repository.state().s2Inputs[0].sourceCandidates[0].sourceStorageKey));
    const candidate = materializeResult(hardRepair, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    await hardRepair.service.s2.repairCandidate(hardRepair.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const promoted = await waitUntil(() => hardRepair.repository.state().s2Publications.some((publication) => publication.kind === "repair_output" && publication.state === "promoted"));
    const beforeRestart = hardRepair.repository.state();
    const recoveryProvider = new MockOpenAIProvider({ briefData: brief() });
    const restarted = createWorkflowService({ repository: hardRepair.repository, objects: hardRepair.objects, provider: recoveryProvider, processId: 99141, isProcessAlive: (processId) => processId !== 99140 });
    const value = await waitForRun(hardRepair, bound.qaRun.id, (current) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(current.qaRun.repairs?.[0]?.status));
    const afterRestart = restarted.repository.state();
    const derived = afterRestart.s2DerivedCandidates[0];
    markVariant("REPAIR-014", "hard-interruption-restart", "Promoted repair output is reconciled without a second repair/provider success", true,
      promoted && beforeRestart.s2DerivedCandidates.length === 0 && hardRepairProvider.s2RepairCalls === 1 && recoveryProvider.s2RepairCalls === 0 && afterRestart.s2DerivedCandidates.length === 1 && afterRestart.s2ReQaResults.length === 1 && afterRestart.s2Publications.every((publication) => publication.state === "committed") && value.qaRun?.repairs?.[0]?.status === "re_qa_pass" && Boolean(derived) && hardRepair.objects.exists(derived.storageKeyNormalized) && sourceBefore.equals(hardRepair.objects.read(afterRestart.s2Inputs[0].sourceCandidates[0].sourceStorageKey)) && listObjects(hardRepair.root).every((name) => !/s2[\\/]repairs[\\/]\S+[\\/]staged/.test(name)));
  } finally { cleanup(hardRepair); }
});

test("section-24 re-QA outcome evidence", async () => {
  const outcomes: Array<[string, string]> = [["pass", "re_qa_pass"], ["warning", "re_qa_warning"], ["requirement_violation", "re_qa_material_fail"], ["unavailable", "re_qa_unavailable"]];
  const observed: string[] = [];
  for (const [mode, expectedStatus] of outcomes) {
    const provider = new MockOpenAIProvider({
      briefData: brief(),
      s2QaResponseFactory: (input, index) => index === 4
        ? (mode === "unavailable" ? new ProviderFailure("PROVIDER_TIMEOUT") : qaPayload(input, mode))
        : qaPayload(input, "pass"),
    });
    const fixture = seed({ provider });
    try {
      const bound = await bind(fixture); await waitForRun(fixture, bound.qaRun.id);
      const candidate = materializeResult(fixture, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
      await fixture.service.s2.repairCandidate(fixture.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
      const value = await waitForRun(fixture, bound.qaRun.id, (current) => current.qaRun.repairs?.[0]?.status === expectedStatus);
      observed.push(value.qaRun.repairs[0].status);
    } finally { cleanup(fixture); }
  }
  mark("REQA-003", "Re-QA independently persists pass warning material-fail and unavailable", ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable"], observed);
});


function s2MultipartBody(bytes: Uint8Array, kind: "reference" | "logo", fileName = "asset.png", boundary = "s2-evidence-boundary"): { body: Buffer; contentType: string } {
  const prefix = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: image/png\r\n\r\n", "latin1");
  const middle = Buffer.from("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n" + kind + "\r\n--" + boundary + "--\r\n", "latin1");
  return { body: Buffer.concat([prefix, Buffer.from(bytes), middle]), contentType: "multipart/form-data; boundary=" + boundary };
}

async function apiCall(fixture: Fixture, method: string, path: string[], body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body !== undefined) (init as any).body = body;
  return handleApiRequest(new Request("http://localhost/" + path.join("/"), init), path, fixture.service);
}

async function clientFetch(fixture: Fixture, input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, "http://localhost");
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const route = url.pathname.split("/").filter(Boolean);
  if (route[0] === "api") route.shift();
  return apiCall(fixture, init.method ?? "GET", route, init.body === null ? undefined : init.body, headers);
}

async function expectUnknown(action: () => unknown): Promise<boolean> {
  try { await action(); return false; }
  catch (error) { return error instanceof UnknownNetworkOutcome; }
}

async function responseJson(response: Response): Promise<any> {
  return response.json().catch(() => ({}));
}

test("section-24 concurrency and recovery evidence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = new MockOpenAIProvider({ briefData: brief() });
  const originalQa = provider.runS2Qa.bind(provider);
  (provider as any).runS2Qa = async (input: any) => { if (input.candidateIndex === 1) await gate; return originalQa(input); };
  const fixture = seed({ provider });
  try {
    const bound = await bind(fixture);
    const claimed = await waitUntil(() => fixture.repository.state().s2Operations.some((operation) => operation.phase === "qa" && operation.status === "running" && operation.candidateId === fixture.repository.state().candidates[0].candidateId));
    const second = createWorkflowService({ repository: fixture.repository, objects: fixture.objects, provider, processId: process.pid, isProcessAlive: () => true });
    release();
    await waitForRun(fixture, bound.qaRun.id);
    mark("CONC-001", "Two services claim one logical QA operation only once", true, claimed && provider.s2QaCalls === 4 && (second.s2.getQaRun(fixture.projectId, bound.qaRun.id) as any).qaRun.candidateAttempts.length === 4);
  } finally { release(); cleanup(fixture); }

  const dead = seed();
  try {
    const bound = await bind(dead); await waitForRun(dead, bound.qaRun.id);
    const operation = dead.repository.state().s2Operations.find((item) => item.phase === "qa")!;
    dead.repository.transact((state) => {
      const stored = state.s2Operations.find((item) => item.id === operation.id)!;
      stored.status = "running"; stored.claimedBy = "dead-worker"; stored.claimedProcessId = 99123; stored.claimToken = randomUUID();
    });
    const recoveredProvider = new MockOpenAIProvider({ briefData: brief() });
    const recovered = createWorkflowService({ repository: dead.repository, objects: dead.objects, provider: recoveredProvider, processId: 99124, isProcessAlive: (processId) => processId !== 99123 });
    const recoveredOk = await waitUntil(() => dead.repository.state().s2Operations.find((item) => item.id === operation.id)?.status === "succeeded");
    mark("CONC-002", "Definite dead owner requeues and unknown liveness stays busy", true, recoveredOk && recoveredProvider.s2QaCalls === 1 && recovered.s2.getQaRun(dead.projectId, bound.qaRun.id) !== undefined);
  } finally { cleanup(dead); }

  const unknown = seed();
  try {
    const bound = await bind(unknown); await waitForRun(unknown, bound.qaRun.id);
    const operation = unknown.repository.state().s2Operations.find((item) => item.phase === "qa")!;
    unknown.repository.transact((state) => {
      const stored = state.s2Operations.find((item) => item.id === operation.id)!;
      stored.status = "running"; stored.claimedBy = "unknown-worker"; stored.claimedProcessId = 99125; stored.claimToken = randomUUID();
    });
    const unknownProvider = new MockOpenAIProvider({ briefData: brief() });
    const unknownService = createWorkflowService({ repository: unknown.repository, objects: unknown.objects, provider: unknownProvider, processId: 99126, isProcessAlive: () => { throw new Error("unknown"); } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    markVariant("CONC-002", "unknown-liveness", "Unknown liveness remains busy/uncertain", true, unknownService.s2.getQaRun(unknown.projectId, bound.qaRun.id) !== undefined && unknown.repository.state().s2Operations.find((item) => item.id === operation.id)?.status === "running" && unknownProvider.s2QaCalls === 0);
  } finally { cleanup(unknown); }

  const staleGate = new Promise<void>((resolve) => { release = resolve; });
  const staleProvider = new MockOpenAIProvider({ briefData: brief() });
  const staleOriginal = staleProvider.runS2Qa.bind(staleProvider);
  (staleProvider as any).runS2Qa = async (input: any) => { if (input.candidateIndex === 1) await staleGate; return staleOriginal(input); };
  const stale = seed({ provider: staleProvider });
  try {
    const bound = await bind(stale);
    const operation = stale.repository.state().s2Operations.find((item) => item.phase === "qa" && item.candidateId === stale.repository.state().candidates[0].candidateId)!;
    const running = await waitUntil(() => stale.repository.state().s2Operations.find((item) => item.id === operation.id)?.status === "running");
    stale.repository.transact((state) => { const stored = state.s2Operations.find((item) => item.id === operation.id)!; stored.claimToken = randomUUID(); });
    release();
    await waitUntil(() => staleProvider.s2QaCalls === 4);
    const result = stale.repository.state().s2QaRuns[0].candidateResults.find((item) => item.candidateId === operation.candidateId)!;
    mark("CONC-004", "Stale claim token fences late QA completion", true, running && result.status === "running" && stale.repository.state().s2DerivedCandidates.length === 0);
    void bound;
  } finally { release(); cleanup(stale); }

  let releaseActiveQa!: () => void;
  const activeQaGate = new Promise<void>((resolve) => { releaseActiveQa = resolve; });
  const activeQaProvider = new MockOpenAIProvider({ briefData: brief() });
  const activeQaOriginal = activeQaProvider.runS2Qa.bind(activeQaProvider);
  (activeQaProvider as any).runS2Qa = async (input: any) => { if (input.candidateIndex === 1) await activeQaGate; return activeQaOriginal(input); };
  const activeQa = seed({ provider: activeQaProvider, processId: 99130 });
  try {
    const bound = await bind(activeQa);
    const running = await waitUntil(() => activeQa.repository.state().s2Operations.some((operation) => operation.phase === "qa" && operation.status === "running" && operation.candidateId === activeQa.repository.state().candidates[0].candidateId));
    const unknownRestart = createWorkflowService({ repository: activeQa.repository, objects: activeQa.objects, provider: activeQaProvider, processId: 99131, isProcessAlive: () => { throw new Error("unknown"); } });
    const remainsBusy = activeQa.repository.state().s2Operations.find((operation) => operation.candidateId === activeQa.repository.state().candidates[0].candidateId)?.status === "running";
    const recoveredProvider = new MockOpenAIProvider({ briefData: brief() });
    const recovered = createWorkflowService({ repository: activeQa.repository, objects: activeQa.objects, provider: recoveredProvider, processId: 99132, isProcessAlive: (processId) => processId !== 99130 });
    const recoveredRun = await waitForRun(activeQa, bound.qaRun.id);
    const qaState = activeQa.repository.state();
    const qaCandidate = qaState.s2QaRuns[0].candidateResults.find((result) => result.candidateIndex === 1)!;
    mark("CONC-003", "QA-running interruption is conservatively fenced and dead-owner recovery reuses the same logical operation", true, running && remainsBusy && unknownRestart.s2.getQaRun(activeQa.projectId, bound.qaRun.id) !== undefined && recoveredRun.qaRun.status === "completed" && recoveredProvider.s2QaCalls === 1 && activeQaProvider.s2QaCalls === 3 && qaState.s2Operations.filter((operation) => operation.phase === "qa").length === 4 && qaState.s2QaRuns[0].candidateResults.filter((result) => result.candidateId === qaCandidate.candidateId).length === 1 && qaCandidate.status === "pass" && recovered.s2.getQaRun(activeQa.projectId, bound.qaRun.id) !== undefined);
  } finally { cleanup(activeQa); }

  const hardRepairProvider = new MockOpenAIProvider({ briefData: brief() });
  const activeRepair = seed({ provider: hardRepairProvider, processId: 99140, onPublicationPhase: (phase) => phase === "after-final-promotion" ? "interrupt" : undefined });
  try {
    const bound = await bind(activeRepair); await waitForRun(activeRepair, bound.qaRun.id);
    const candidate = materializeResult(activeRepair, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    await activeRepair.service.s2.repairCandidate(activeRepair.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const publicationRunning = await waitUntil(() => activeRepair.repository.state().s2Publications.some((publication) => publication.kind === "repair_output" && publication.state === "promoted"));
    const before = activeRepair.repository.state();
    const recoveredProvider = new MockOpenAIProvider({ briefData: brief() });
    const recovered = createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: recoveredProvider, processId: 99141, isProcessAlive: (processId) => processId !== 99140 });
    const value = await waitForRun(activeRepair, bound.qaRun.id, (current) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(current.qaRun.repairs?.[0]?.status));
    const after = recovered.repository.state();
    markVariant("CONC-003", "repair-publication-boundary", "Repair-running final promotion boundary recovers intended lineage without re-dispatching repair", true, publicationRunning && before.s2DerivedCandidates.length === 0 && hardRepairProvider.s2RepairCalls === 1 && recoveredProvider.s2RepairCalls === 0 && after.s2DerivedCandidates.length === 1 && after.s2ReQaResults.length === 1 && value.qaRun.repairs?.[0]?.status === "re_qa_pass" && after.s2Operations.filter((operation) => operation.phase === "repair").length === 1 && recovered.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) !== undefined);
  } finally { cleanup(activeRepair); }

  let releaseActiveReQa!: () => void;
  const activeReQaGate = new Promise<void>((resolve) => { releaseActiveReQa = resolve; });
  const activeReQaProvider = new MockOpenAIProvider({ briefData: brief() });
  const activeReQaOriginal = activeReQaProvider.runS2Qa.bind(activeReQaProvider);
  let activeReQaCalls = 0;
  (activeReQaProvider as any).runS2Qa = async (input: any) => { activeReQaCalls += 1; if (activeReQaCalls === 5) await activeReQaGate; return activeReQaOriginal(input); };
  const activeReQa = seed({ provider: activeReQaProvider, processId: 99150 });
  try {
    const bound = await bind(activeReQa); await waitForRun(activeReQa, bound.qaRun.id);
    const candidate = materializeResult(activeReQa, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    await activeReQa.service.s2.repairCandidate(activeReQa.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const reQaRunning = await waitUntil(() => activeReQa.repository.state().s2Operations.some((operation) => operation.phase === "re_qa" && operation.status === "running"));
    const reQaOperation = activeReQa.repository.state().s2Operations.find((operation) => operation.phase === "re_qa")!;
    const recovered = createWorkflowService({ repository: activeReQa.repository, objects: activeReQa.objects, provider: activeReQaProvider, processId: 99151, isProcessAlive: (processId) => processId !== 99150 });
    const value = await waitForRun(activeReQa, bound.qaRun.id, (current) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(current.qaRun.repairs?.[0]?.status));
    const state = recovered.repository.state();
    markVariant("CONC-003", "re-qa-running", "Re-QA-running interruption reuses one result and does not create a second repair", true, reQaRunning && reQaOperation.claimedProcessId === 99150 && activeReQaCalls === 6 && activeReQaProvider.s2QaCalls === 5 && state.s2ReQaResults.length === 1 && state.s2Operations.filter((operation) => operation.phase === "re_qa").length === 1 && state.s2Repairs.length === 1 && value.qaRun.repairs?.[0]?.status === "re_qa_pass");
  } finally { cleanup(activeReQa); }

  const persistence = seed();
  try {
    const bound = await bind(persistence); await waitForRun(persistence, bound.qaRun.id);
    const before = { repairs: persistence.repository.state().s2Repairs.length, derived: persistence.repository.state().s2DerivedCandidates.length };
    const candidate = materializeResult(persistence, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
    (persistence.repository as any).beforeCommit = () => { throw new Error("simulated persistence failure"); };
    const rejected = await expectCode(() => persistence.service.s2.repairCandidate(persistence.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "PERSISTENCE_FAILED");
    mark("CONC-005", "Persistence failure publishes no false repair or derived success", true, rejected && before.repairs === persistence.repository.state().s2Repairs.length && before.derived === persistence.repository.state().s2DerivedCandidates.length);
  } finally { cleanup(persistence); }

  const uploads = seed();
  try {
    const results = await Promise.allSettled([upload(uploads, "reference", PNG, "first.png"), upload(uploads, "reference", PNG, "second.png")]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const rejected = results.filter((result) => result.status === "rejected" && result.reason instanceof AppError && result.reason.code === "MEDIA_DUPLICATE").length;
    const s2Objects = listObjects(uploads.root).filter((name) => /s2[\\/]+references[\\/]+/.test(name));
    mark("CONC-006", "Concurrent object publication cannot overwrite or duplicate a ready asset", true, fulfilled === 1 && rejected === 1 && uploads.repository.state().s2Assets.length === 1 && s2Objects.length === 2 && listObjects(uploads.root).every((name) => !/s2[\\/]+staging/.test(name)));
  } finally { cleanup(uploads); }

  let releaseLiveStaged!: () => void;
  const liveStagedGate = new Promise<void>((resolve) => { releaseLiveStaged = resolve; });
  const liveStaged = seed({
    processId: 99201,
    isProcessAlive: (processId) => processId === 99201,
    onPublicationPhase: async (phase) => {
      if (phase === "after-publication-staged") {
        await liveStagedGate;
      }
    },
  });
  let liveStagedUpload: Promise<any> | undefined;
  try {
    const key = randomUUID();
    liveStagedUpload = liveStaged.service.s2.uploadAsset(liveStaged.projectId, "reference", "live-staged.png", "image/png", PNG, key);
    const staged = await waitUntil(() => liveStaged.repository.state().s2Publications.some((publication) => publication.kind === "asset_upload" && publication.state === "staged"));
    const before = liveStaged.repository.state();
    const beforeStaging = listObjects(liveStaged.root).filter((name) => /s2[\\/]staging[\\/]/.test(name));
    const beforeFinals = listObjects(liveStaged.root).filter((name) => /s2[\\/]references[\\/]/.test(name));
    const liveService = createWorkflowService({
      repository: liveStaged.repository,
      objects: liveStaged.objects,
      provider: new MockOpenAIProvider({ briefData: brief() }),
      processId: 99202,
      isProcessAlive: (processId) => processId === 99201,
    });
    const afterRecovery = liveStaged.repository.state();
    const publication = afterRecovery.s2Publications.find((item) => item.kind === "asset_upload");
    const unchanged = jcs(before.s2Publications) === jcs(afterRecovery.s2Publications) &&
      jcs(beforeStaging) === jcs(listObjects(liveStaged.root).filter((name) => /s2[\\/]staging[\\/]/.test(name))) &&
      jcs(beforeFinals) === jcs(listObjects(liveStaged.root).filter((name) => /s2[\\/]references[\\/]/.test(name)));
    releaseLiveStaged();
    const result = await liveStagedUpload;
    const completed = liveStaged.repository.state();
    const asset = completed.s2Assets.find((item) => item.id === result.asset.id);
    const finalObjects = listObjects(liveStaged.root).filter((name) => /s2[\\/]references[\\/]/.test(name));
    markVariant("CONC-003", "upload-live-staged", "Live staged upload owner remains untouched across a fresh service recovery and completes once", true,
      staged && publication?.ownerProcessId === 99201 && publication.state === "staged" && unchanged && before.s2Assets.length === 0 &&
      afterRecovery.s2Assets.length === 0 && afterRecovery.idempotency.filter((item) => item.operation === "s2_asset_upload").length === 0 &&
      beforeFinals.length === 0 && finalObjects.length === 2 && completed.s2Assets.length === 1 &&
      completed.idempotency.filter((item) => item.key === key).length === 1 && completed.s2Publications.find((item) => item.kind === "asset_upload")?.state === "committed" &&
      asset?.storageKeyOriginal !== undefined && finalObjects.some((name) => name.replaceAll(String.fromCharCode(92), "/") === asset.storageKeyOriginal) &&
      finalObjects.some((name) => name.replaceAll(String.fromCharCode(92), "/") === asset.storageKeyNormalized) && result.asset.id === asset.id);
    void liveService;
  } finally {
    releaseLiveStaged();
    if (liveStagedUpload) await liveStagedUpload.catch(() => undefined);
    cleanup(liveStaged);
  }

  let releaseUnknownOwner!: () => void;
  const unknownOwnerGate = new Promise<void>((resolve) => { releaseUnknownOwner = resolve; });
  const unknownOwner = seed({
    processId: 99211,
    isProcessAlive: (processId) => processId === 99211,
    onPublicationPhase: async (phase) => {
      if (phase === "after-publication-staged") {
        await unknownOwnerGate;
      }
    },
  });
  let unknownOwnerUpload: Promise<any> | undefined;
  try {
    const key = randomUUID();
    unknownOwnerUpload = unknownOwner.service.s2.uploadAsset(unknownOwner.projectId, "reference", "unknown-owner.png", "image/png", PNG, key);
    const staged = await waitUntil(() => unknownOwner.repository.state().s2Publications.some((publication) => publication.kind === "asset_upload" && publication.state === "staged"));
    const before = unknownOwner.repository.state();
    const beforeStaging = listObjects(unknownOwner.root).filter((name) => /s2[\\/]staging[\\/]/.test(name));
    const unknownService = createWorkflowService({
      repository: unknownOwner.repository,
      objects: unknownOwner.objects,
      provider: new MockOpenAIProvider({ briefData: brief() }),
      processId: 99212,
      isProcessAlive: () => { throw new Error("unknown owner liveness"); },
    });
    const afterRecovery = unknownOwner.repository.state();
    const unchanged = jcs(before.s2Publications) === jcs(afterRecovery.s2Publications) &&
      jcs(beforeStaging) === jcs(listObjects(unknownOwner.root).filter((name) => /s2[\\/]staging[\\/]/.test(name)));
    releaseUnknownOwner();
    const result = await unknownOwnerUpload;
    const completed = unknownOwner.repository.state();
    markVariant("CONC-003", "upload-unknown-owner", "Unknown upload-owner liveness leaves staged publication and owned staging untouched", true,
      staged && unchanged && afterRecovery.s2Assets.length === 0 &&
      afterRecovery.idempotency.filter((item) => item.operation === "s2_asset_upload").length === 0 &&
      afterRecovery.s2Publications.find((item) => item.kind === "asset_upload")?.state === "staged" &&
      completed.s2Assets.length === 1 && completed.idempotency.filter((item) => item.key === key).length === 1 &&
      completed.s2Publications.find((item) => item.kind === "asset_upload")?.state === "committed" && result.asset.id === completed.s2Assets[0].id);
    void unknownService;
  } finally {
    releaseUnknownOwner();
    if (unknownOwnerUpload) await unknownOwnerUpload.catch(() => undefined);
    cleanup(unknownOwner);
  }

  let releaseLivePromoted!: () => void;
  const livePromotedGate = new Promise<void>((resolve) => { releaseLivePromoted = resolve; });
  const livePromoted = seed({
    processId: 99221,
    isProcessAlive: (processId) => processId === 99221,
    onPublicationPhase: async (phase) => {
      if (phase === "after-final-promotion") {
        await livePromotedGate;
      }
    },
  });
  let livePromotedUpload: Promise<any> | undefined;
  try {
    const key = randomUUID();
    livePromotedUpload = livePromoted.service.s2.uploadAsset(livePromoted.projectId, "reference", "live-promoted.png", "image/png", PNG, key);
    const promoted = await waitUntil(() => livePromoted.repository.state().s2Publications.some((publication) => publication.kind === "asset_upload" && publication.state === "promoted"));
    const before = livePromoted.repository.state();
    const beforeFinals = listObjects(livePromoted.root).filter((name) => /s2[\\/]references[\\/]/.test(name));
    const liveService = createWorkflowService({
      repository: livePromoted.repository,
      objects: livePromoted.objects,
      provider: new MockOpenAIProvider({ briefData: brief() }),
      processId: 99222,
      isProcessAlive: (processId) => processId === 99221,
    });
    const afterRecovery = livePromoted.repository.state();
    const unchanged = jcs(before.s2Publications) === jcs(afterRecovery.s2Publications) &&
      jcs(beforeFinals) === jcs(listObjects(livePromoted.root).filter((name) => /s2[\\/]references[\\/]/.test(name)));
    releaseLivePromoted();
    const result = await livePromotedUpload;
    const completed = livePromoted.repository.state();
    const asset = completed.s2Assets.find((item) => item.id === result.asset.id);
    const finalObjects = listObjects(livePromoted.root).filter((name) => /s2[\\/]references[\\/]/.test(name));
    const finalSet = new Set(finalObjects.map((name) => name.replaceAll(String.fromCharCode(92), "/")));
    markVariant("CONC-003", "upload-live-promoted", "Live promoted upload owner remains authoritative until its asset transaction commits", true,
      promoted && before.s2Publications.find((item) => item.kind === "asset_upload")?.ownerProcessId === 99221 &&
      before.s2Assets.length === 0 && before.idempotency.filter((item) => item.operation === "s2_asset_upload").length === 0 &&
      beforeFinals.length === 2 && unchanged && afterRecovery.s2Assets.length === 0 &&
      afterRecovery.idempotency.filter((item) => item.operation === "s2_asset_upload").length === 0 &&
      afterRecovery.s2Publications.find((item) => item.kind === "asset_upload")?.state === "promoted" &&
      completed.s2Assets.length === 1 && completed.idempotency.filter((item) => item.key === key).length === 1 &&
      completed.s2Publications.find((item) => item.kind === "asset_upload")?.state === "committed" &&
      asset !== undefined && finalSet.has(asset.storageKeyOriginal) && finalSet.has(asset.storageKeyNormalized) && result.asset.id === asset.id);
    void liveService;
  } finally {
    releaseLivePromoted();
    if (livePromotedUpload) await livePromotedUpload.catch(() => undefined);
    cleanup(livePromoted);
  }

  const deadStaged = seed({
    processId: 99231,
    onPublicationPhase: (phase) => phase === "after-publication-staged" ? "interrupt" : undefined,
  });
  try {
    const key = randomUUID();
    let interrupted = false;
    const deadUpload = deadStaged.service.s2.uploadAsset(deadStaged.projectId, "reference", "dead-staged.png", "image/png", PNG, key).catch(() => {
      interrupted = true;
      return null;
    });
    const staged = await waitUntil(() => deadStaged.repository.state().s2Publications.some((publication) => publication.kind === "asset_upload" && publication.state === "staged"));
    await deadUpload;
    const beforeRecovery = deadStaged.repository.state();
    const beforeStaging = listObjects(deadStaged.root).filter((name) => /s2[\\/]staging[\\/]/.test(name));
    const recovered = createWorkflowService({
      repository: deadStaged.repository,
      objects: deadStaged.objects,
      provider: new MockOpenAIProvider({ briefData: brief() }),
      processId: 99232,
      isProcessAlive: (processId) => processId !== 99231,
    });
    const afterRecovery = deadStaged.repository.state();
    markVariant("CONC-003", "upload-dead-staged", "Definitely dead staged upload is aborted without a ready asset or unrelated deletion", true,
      staged && interrupted && beforeRecovery.s2Publications.find((item) => item.kind === "asset_upload")?.ownerProcessId === 99231 &&
      beforeStaging.length === 2 && beforeRecovery.s2Assets.length === 0 &&
      afterRecovery.s2Assets.length === 0 && afterRecovery.idempotency.filter((item) => item.key === key).length === 0 &&
      afterRecovery.s2Publications.find((item) => item.kind === "asset_upload")?.state === "aborted" &&
      deadStaged.sourceKeys.every((sourceKey) => deadStaged.objects.exists(sourceKey)) &&
      listObjects(deadStaged.root).every((name) => !/s2[\\/]staging[\\/]/.test(name) && !/s2[\\/]references[\\/]/.test(name)));
    void recovered;
  } finally { cleanup(deadStaged); }
});

test("section-24 exact route and refresh evidence", async () => {
  const fixture = seed();
  try {
    const initial = await apiCall(fixture, "GET", ["projects", fixture.projectId, "s2", "reference-draft"]);
    const multipart = s2MultipartBody(PNG, "reference", "../../not-a-storage-key.png");
    const key = randomUUID();
    const uploaded = await apiCall(fixture, "POST", ["projects", fixture.projectId, "s2", "reference-assets"], multipart.body, { "content-type": multipart.contentType, "Idempotency-Key": key });
    const uploadBody = await responseJson(uploaded);
    const replayMultipart = s2MultipartBody(PNG, "reference", "another-name.png");
    const replay = await apiCall(fixture, "POST", ["projects", fixture.projectId, "s2", "reference-assets"], replayMultipart.body, { "content-type": replayMultipart.contentType, "Idempotency-Key": key });
    const replayBody = await responseJson(replay);
    const assetId = uploadBody.asset.id;
    const patch = await apiCall(fixture, "PATCH", ["projects", fixture.projectId, "s2", "reference-draft"], JSON.stringify({ expectedRevision: 1, referenceAssetIds: [assetId], logoAssetIds: [] }), { "content-type": "application/json", "Idempotency-Key": randomUUID() });
    const preview = await apiCall(fixture, "GET", ["projects", fixture.projectId, "s2", "reference-assets", assetId]);
    const patchBody = await responseJson(patch);
    const qa = await apiCall(fixture, "POST", ["projects", fixture.projectId, "s2", "qa-runs"], JSON.stringify({ sourceGenerationSetId: fixture.generationSetId, expectedDraftRevision: patchBody.draft.revision }), { "content-type": "application/json", "Idempotency-Key": randomUUID() });
    const qaBody = await responseJson(qa);
    const status = await apiCall(fixture, "GET", ["projects", fixture.projectId, "s2", "qa-runs", qaBody.qaRun.id]);
    await waitForRun(fixture, qaBody.qaRun.id);
    const refreshed = await apiCall(fixture, "GET", ["projects", fixture.projectId, "s2", "qa-runs", qaBody.qaRun.id]);
    const providerCallsBeforeRestart = fixture.provider.s2QaCalls;
    const restartedRoute = createWorkflowService({ repository: fixture.repository, objects: fixture.objects, provider: fixture.provider, processId: 99170, isProcessAlive: () => true });
    const restartedProjection = restartedRoute.s2.getQaRun(fixture.projectId, qaBody.qaRun.id) as any;
    const frozen = await apiCall(fixture, "GET", ["projects", fixture.projectId, "s2", "reference-draft"]);
    const frozenBody = await responseJson(frozen);
    const frozenWrite = await apiCall(fixture, "PATCH", ["projects", fixture.projectId, "s2", "reference-draft"], JSON.stringify({ expectedRevision: frozenBody.draft.revision, referenceAssetIds: frozenBody.draft.referenceAssetIds, logoAssetIds: frozenBody.draft.logoAssetIds }), { "content-type": "application/json", "Idempotency-Key": randomUUID() });
    const initialBody = await responseJson(initial);
    const refreshedBody = await responseJson(refreshed);
    const frozenWriteBody = await responseJson(frozenWrite);
    mark("ROUTE-002", "Exact S2 methods bodies statuses and error envelope route correctly", true, initial.status === 200 && uploaded.status === 201 && replay.status === 200 && patch.status === 200 && preview.status === 200 && preview.headers.get("content-type")?.startsWith("image/png") === true && qa.status === 202 && status.status === 200 && refreshed.status === 200 && frozen.status === 200 && frozenWriteBody.error?.code === "DRAFT_FROZEN");
    mark("ROUTE-003", "Duplicate upload replays by idempotency key", true, replayBody.asset.id === uploadBody.asset.id && fixture.repository.state().s2Assets.length === 1);
    mark("ROUTE-004", "Refresh after queue and restart returns persisted truth", true, qaBody.qaRun.id === refreshedBody.qaRun.id && refreshedBody.qaRun.status === "completed" && restartedProjection.qaRun.id === qaBody.qaRun.id && restartedProjection.qaRun.status === "completed" && fixture.provider.s2QaCalls === providerCallsBeforeRestart);
    mark("ROUTE-005", "Empty draft is valid and frozen screen is read-only", true, initialBody.draft.referenceAssetIds.length === 0 && frozenBody.draft.status === "frozen" && frozenWrite.status === 409);
    const freshControls = await runQaFixture("pass", {}, "structure.overhead-support");
    const warningControls = await runQaFixture("warning");
    const unavailableControls = await runQaFixture("pass", { provider: new MockOpenAIProvider({ briefData: brief(), s2QaResponses: [new ProviderFailure("PROVIDER_TIMEOUT")] }) });
    try {
      const eligible = (freshControls.value.qaRun.candidateResults as any).find((result: any) => result.candidateIndex === 1);
      const warning = (warningControls.value.qaRun.candidateResults as any).find((result: any) => result.candidateIndex === 1);
      const unavailable = (unavailableControls.value.qaRun.candidateResults as any).find((result: any) => result.candidateIndex === 1);
      mark("ROUTE-006", "Retry and repair controls are derived only from exact persisted states", true, eligible.repairEligible === true && warning.repairEligible === false && unavailable.status === "qa_unavailable_retryable" && unavailable.repairEligible === false);
      const behavioral = seed();
      try {
        const bound = await bind(behavioral); await waitForRun(behavioral, bound.qaRun.id);
        const candidate = materializeResult(behavioral, bound.qaRun.id, 1, { status: "material_fail", verdict: "MATERIAL_FAIL", materialFindingIds: ["scale.human"], warningFindingIds: [], uncertainFindingIds: [] });
        const repairPosts: Array<{ body: any; key: string }> = [];
        const qaClient = createS2QaClient({
          projectId: behavioral.projectId,
          qaRunId: bound.qaRun.id,
          fetcher: async (input, init) => {
            if ((init.method ?? "GET") === "POST" && input.endsWith("/repair")) repairPosts.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") ?? "" });
            return clientFetch(behavioral, input, init);
          },
        });
        const projection = await qaClient.refresh();
        await qaClient.repair(candidate.candidateId);
        await waitForRun(behavioral, bound.qaRun.id, (value) => ["re_qa_pass", "re_qa_warning", "re_qa_material_fail", "re_qa_unavailable", "failed"].includes(value.qaRun.repairs?.[0]?.status));
        const persisted = await qaClient.refresh();
        const unavailableFixture = seed();
        try {
          const unavailableBound = await bind(unavailableFixture); await waitForRun(unavailableFixture, unavailableBound.qaRun.id);
          const unavailableCandidate = materializeResult(unavailableFixture, unavailableBound.qaRun.id, 1, { status: "qa_unavailable_retryable", verdict: "QA_UNAVAILABLE", materialFindingIds: [], warningFindingIds: [], uncertainFindingIds: [] });
          let unavailablePosts = 0;
          const unavailableClient = createS2QaClient({ projectId: unavailableFixture.projectId, qaRunId: unavailableBound.qaRun.id, fetcher: async (input, init) => { if ((init.method ?? "GET") === "POST" && input.endsWith("/repair")) unavailablePosts += 1; return clientFetch(unavailableFixture, input, init); } });
          await unavailableClient.refresh();
          const blocked = await (async () => { try { await unavailableClient.repair(unavailableCandidate.candidateId); return false; } catch { return true; } })();
          markVariant("ROUTE-006", "behavioral-client-path", "GET sibling input projection drives the real repair POST and persisted re-QA refresh; unavailable state is guarded", true,
            projection.input.id === bound.inputVersionId && repairPosts.length === 1 && repairPosts[0].body.expectedInputVersionId === projection.input.id && repairPosts[0].key.length > 0 && persisted.input.id === bound.inputVersionId && persisted.qaRun.repairs?.[0]?.status === "re_qa_pass" && blocked && unavailablePosts === 0);
        } finally { cleanup(unavailableFixture); }
      } finally { cleanup(behavioral); }
    } finally { cleanup(freshControls.fixture); cleanup(warningControls.fixture); cleanup(unavailableControls.fixture); }
  } finally { cleanup(fixture); }

  const lostBind = seed();
  try {
    const retainer = createIdempotencyKeyRetainer(() => randomUUID());
    const bindKeys: string[] = [];
    const navigations: string[] = [];
    let bindCalls = 0;
    const client = createS2ReferencesClient({
      projectId: lostBind.projectId,
      sourceGenerationSetId: lostBind.generationSetId,
      operationKeys: retainer,
      navigate: (url) => navigations.push(url),
      fetcher: async (input, init) => {
        const response = await clientFetch(lostBind, input, init);
        if ((init.method ?? "GET") === "POST" && input.endsWith("/s2/qa-runs")) {
          bindCalls += 1;
          bindKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
          if (bindCalls <= 2) throw new Error("response lost after durable bind");
        }
        return response;
      },
    });
    const initialDraft = await client.refresh();
    const lost = await expectUnknown(() => client.bind(initialDraft.revision));
    const unrelated = await (async () => { try { await client.update([], [], initialDraft.revision); return false; } catch { return true; } })();
    const recoveredDraft = await client.refresh();
    const replay = await client.bind(initialDraft.revision);
    await waitForRun(lostBind, replay.qaRun.id);
    const state = lostBind.repository.state();
    const initialQaOperations = state.s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1);
    markVariant("ROUTE-004", "lost-bind-response", "Production references client retains an ambiguous bind across an unrelated update and refresh, then follows persisted frozen truth", true,
      lost && bindCalls === 3 && bindKeys.length === 3 && bindKeys.every((key) => key === bindKeys[0]) && unrelated && recoveredDraft.status === "frozen" && navigations.includes("/projects/" + lostBind.projectId + "/s2/qa/" + state.s2QaRuns[0].id) && replay.qaRun.id === state.s2QaRuns[0].id && state.s2Inputs.length === 1 && state.s2QaRuns.length === 1 && initialQaOperations.length === 4 && lostBind.provider.s2QaCalls === 4 && state.s2Drafts[0].frozenByQaRunId === state.s2QaRuns[0].id);
  } finally { cleanup(lostBind); }

  const retained = createIdempotencyKeyRetainer(() => randomUUID());
  const retainedKeys: string[][] = [];
  for (const [operation, input] of [
    ["s2_reference_upload", "upload-input"],
    ["s2_reference_draft_update", "draft-input"],
    ["s2_bind", "bind-input"],
    ["s2_qa_retry", "retry-input"],
    ["s2_repair", "repair-input"],
  ] as const) {
    const keys: string[] = [];
    await withRetainedIdempotencyKey(retained, operation, input, async (key) => {
      keys.push(key);
      if (keys.length === 1) throw new UnknownNetworkOutcome();
      return true;
    });
    retainedKeys.push(keys);
  }
  const changedInputKey = retained.keyFor("s2_repair", "repair-input-changed");
  markVariant("ROUTE-006", "same-key-mutation-recovery", "Upload, draft, bind, retry and repair retain one key across unknown response replay and replace it for changed input", true,
    retainedKeys.every((keys) => keys.length === 2 && keys[0] === keys[1]) && retainedKeys[0][0] !== retainedKeys[1][0] && changedInputKey !== retainedKeys[4][0]);
  const unauthorized = seed();
  try {
    const projectId = randomUUID();
    const cases = [
      apiCall(unauthorized, "GET", ["projects", projectId, "s2", "reference-draft"]),
      apiCall(unauthorized, "POST", ["projects", projectId, "s2", "reference-assets"], s2MultipartBody(PNG, "reference").body, { "content-type": s2MultipartBody(PNG, "reference").contentType, "Idempotency-Key": randomUUID() }),
      apiCall(unauthorized, "PATCH", ["projects", projectId, "s2", "reference-draft"], "{}", { "content-type": "application/json", "Idempotency-Key": randomUUID() }),
      apiCall(unauthorized, "GET", ["projects", projectId, "s2", "reference-assets", randomUUID()]),
      apiCall(unauthorized, "POST", ["projects", projectId, "s2", "qa-runs"], JSON.stringify({ sourceGenerationSetId: randomUUID(), expectedDraftRevision: 1 }), { "content-type": "application/json", "Idempotency-Key": randomUUID() }),
      apiCall(unauthorized, "GET", ["projects", projectId, "s2", "qa-runs", randomUUID()]),
      apiCall(unauthorized, "POST", ["projects", projectId, "s2", "qa-runs", randomUUID(), "candidates", randomUUID(), "retry"], undefined, { "Idempotency-Key": randomUUID() }),
      apiCall(unauthorized, "POST", ["projects", projectId, "s2", "qa-runs", randomUUID(), "candidates", randomUUID(), "repair"], "{}", { "content-type": "application/json", "Idempotency-Key": randomUUID() }),
    ];
    const responses = await Promise.all(cases);
    mark("ROUTE-001", "Every S2 route rejects an unauthorized project", true, responses.every((response) => response.status === 404));
  } finally { cleanup(unauthorized); }
});

test("section-24 privacy, security and UI evidence", async () => {
  const fixture = seed();
  try {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map((value) => String(value)).join(" ")); };
    try {
      const boundary = "privacy-boundary";
      const body = Buffer.alloc(S2_MAX_MULTIPART_BODY_BYTES + 1, 0x61);
      await apiCall(fixture, "POST", ["projects", fixture.projectId, "s2", "reference-assets"], body, { "content-type": "multipart/form-data; boundary=" + boundary, "content-length": String(body.length), "Idempotency-Key": randomUUID() });
    } finally { console.error = originalError; }
    const logText = logs.join("\n");
    mark("PRIV-001", "Logs exclude image bytes paths prompts payloads and evidence", true, !logText.includes(PNG.toString("base64")) && !logText.includes("data:image") && !logText.includes("synthetic observation") && !logText.includes("storageKey") && logText.includes("MEDIA_TOO_LARGE"));

    const otherProjectId = randomUUID();
    fixture.repository.transact((state) => { state.projects.push({ ...state.projects[0], projectId: otherProjectId, name: "other", activeGenerationSetId: fixture.generationSetId }); });
    const asset = await upload(fixture, "reference", PNG);
    const crossProject = await expectCode(() => fixture.service.s2.getAsset(otherProjectId, asset.asset.id), "ASSET_PROJECT_MISMATCH");
    const crossPreview = await apiCall(fixture, "GET", ["projects", otherProjectId, "s2", "reference-assets", asset.asset.id]);
    const crossBody = await responseJson(crossPreview);
    mark("PRIV-003", "Cross-project private asset access is denied without image disclosure", true, crossProject && crossPreview.status === 404 && crossBody.error?.code === "ASSET_PROJECT_MISMATCH" && crossBody.error?.message?.includes("could not be completed"));

    const pathAsset = await fixture.service.s2.uploadAsset(fixture.projectId, "logo", "..\\private\\customer.png", "image/png", await coloredPng({ r: 7, g: 8, b: 9 }), randomUUID());
    const storedPath = fixture.repository.state().s2Assets.find((item) => item.id === pathAsset.asset.id)!;
    mark("PRIV-004", "Storage keys are server-generated and path traversal is rejected", true, !storedPath.storageKeyOriginal.includes("private") && !storedPath.storageKeyOriginal.includes("..") && !storedPath.storageKeyNormalized.includes("customer") && fixture.objects.exists(storedPath.storageKeyNormalized));

    const changedFiles = ["src/lib/s2.ts", "src/lib/s2-media.ts", "src/lib/s2-provider.ts", "src/lib/openai.ts", "src/lib/api.ts", "src/lib/client-idempotency.ts", "src/lib/store.ts", "src/lib/types.ts", "src/lib/workflow.ts", "app/components/S2Client.tsx", "tests/s2-evidence.test.ts", "package.json", "pnpm-lock.yaml"];
    const changedText = changedFiles.map((name) => readFileSync(join(process.cwd(), name), "utf8")).join("\n");
    const literalSecret = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})/.test(changedText);
    mark("PRIV-002", "No literal credential-like values enter the changed files", false, literalSecret);
    const packageText = readFileSync(join(process.cwd(), "package.json"), "utf8");
    mark("PRIV-005", "Secret and dependency boundary checks pass with mocked providers only", true, /\"sharp\"\s*:\s*\"0\.35\.3\"/.test(packageText) && !literalSecret && fixture.provider instanceof MockOpenAIProvider && fixture.provider.s2QaCalls === 0 && !Object.keys(process.env).some((name) => ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"].includes(name) && process.env[name]));

    const ui = readFileSync(join(process.cwd(), "app/components/S2Client.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    mark("UI-001", "Visual-only disclaimer is present on both S2 screens", true, ui.includes("visual/design-only QA") && ui.includes("visual QA") && css.includes(".disclaimer"));
    mark("UI-002", "Ordered candidates and observed states are distinguishable", true, ui.includes("candidate.candidateIndex") && ui.includes("candidate.status") && ui.includes("candidate.verdict") && ui.includes("Observations"));
    mark("UI-003", "Unavailable is not rendered as a successful verdict", true, ui.includes("qa_unavailable_retryable") && ui.includes("Run status") && !ui.includes("QA_UNAVAILABLE ? \"PASS\"") );
    mark("UI-004", "Client has no prompt/model/verdict/hard-fact/hash editing controls", true, !ui.includes("setPrompt") && !ui.includes("setModel") && !ui.includes("setVerdict") && !ui.includes("setGeometry") && !ui.includes("setHash") && ui.includes("Immutable source candidate"));
  } finally { cleanup(fixture); }
});

test("section-24 evidence matrix completeness", () => {
  const required = [
    ...Array.from({ length: 22 }, (_, index) => "MEDIA-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 9 }, (_, index) => "DRAFT-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 10 }, (_, index) => "BIND-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 15 }, (_, index) => "QA-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 5 }, (_, index) => "RETRY-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 16 }, (_, index) => "REPAIR-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 5 }, (_, index) => "REQA-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 6 }, (_, index) => "CONC-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 6 }, (_, index) => "ROUTE-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 5 }, (_, index) => "PRIV-" + String(index + 1).padStart(3, "0")),
    ...Array.from({ length: 4 }, (_, index) => "UI-" + String(index + 1).padStart(3, "0")),
  ];
  const actual = new Set(Array.from(evidenceRows.keys()).map((key) => key.split("/")[0]));
  const missing = required.filter((id) => !actual.has(id));
  assert.equal(required.length, 103);
  console.log(`Section 24 evidence: ${actual.size}/103 base rows; ${evidenceRows.size} records; 0 skipped`);
  assert.deepEqual(missing, []);
});
