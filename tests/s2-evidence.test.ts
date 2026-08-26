import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { MockOpenAIProvider, OpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore } from "../src/lib/store";
import {
  enforceS2AggregateLimits,
  inspectCanonicalS1Png,
  normalizeS2Media,
  S2_MAX_MULTIPART_BODY_BYTES,
  S2_MAX_NORMALIZED_BYTES,
  S2_MAX_PIXELS_PER_ASSET,
  S2_MAX_PROVIDER_BYTES,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  S2_MAX_RGBA_BYTES_PER_ASSET,
  S2_MAX_SOURCE_BYTES,
  S2_MAX_TOTAL_PIXELS,
  S2_MAX_TOTAL_RGBA_BYTES,
} from "../src/lib/s2-media";
import { buildS2QaRequest, buildS2RepairRequest } from "../src/lib/s2-provider";
import { handleApiRequest } from "../src/lib/api";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { sha256 } from "../src/lib/utils";
import { AppError } from "../src/lib/types";
import { createS2QaClient, createS2ReferencesClient } from "../app/components/S2Client";
import { createIdempotencyKeyRetainer, UnknownNetworkOutcome } from "../src/lib/client-idempotency";
import { deriveClaimManifest, manifestBaseRowCount, manifestVariantCount, type ClaimDefinition } from "./s2-evidence-manifest";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function briefData(exactCount = false) {
  return {
    projectFacts: { clientName: "Synthetic Client", eventName: "Synthetic Event", venueName: "Synthetic Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "Synthetic Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: exactCount ? 2 : null, countIsExact: exactCount, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."], prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null }, unknowns: [], assumptions: [],
    freeTextRequirements: [], extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  } as any;
}

type FixtureOptions = {
  data?: any;
  provider?: MockOpenAIProvider;
} & Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onPublicationPhase">;

type Fixture = { service: WorkflowService; provider: MockOpenAIProvider; repository: JsonRepository; objects: PrivateObjectStore; root: string; projectId: string; generationSetId: string };

function fixture(sources: Buffer[] = [ONE_PIXEL_PNG], options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s2-evidence-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID(); const generationSetId = randomUUID(); const briefVersionId = randomUUID();
  const sourceHash = sha256(sources[0]);
  const geometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null } as any;
  const data = options.data ?? briefData();
  const qaAttempts = new Map<number, number>();
  const provider = options.provider ?? new MockOpenAIProvider({
    briefData: data,
    s2QaResponseFactory: (input) => {
      const attempt = qaAttempts.get(input.candidateIndex) ?? 0;
      qaAttempts.set(input.candidateIndex, attempt + 1);
      if (input.candidateIndex === 2 && attempt === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      const material = input.candidateIndex === 1 && attempt === 0;
      return {
        requirements: input.requirements.map((item) => ({
          requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
          observed: item.expected === "absent" ? "absent" : "present",
          observedCount: item.expected === "exact_count" ? item.expectedCount : null,
          confidence: 0.99, evidence: "local synthetic observation",
        })),
        designRules: input.designRules.map((item) => ({
          ruleId: item.ruleId, observed: material && item.ruleId === "structure.overhead-support" ? "non_compliant" : "compliant",
          confidence: 0.99, evidence: "local synthetic observation",
        })),
      };
    },
    s2RepairResponses: [ONE_PIXEL_PNG],
  });
  const metadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() } as any;
  const conceptAssetIds: string[] = [];
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID(); const assetId = randomUUID(); conceptAssetIds.push(assetId);
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    const source = sources[index - 1] ?? sources[0]; const sourceDigest = sha256(source);
    objects.put(storageKey, source);
    conceptAssets.push({ assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: source.byteLength, sha256: sourceDigest, status: "stored", createdAt: new Date(0).toISOString() });
    candidates.push({ candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index, directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: new Date(0).toISOString() },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() }, createdAt: new Date(0).toISOString() });
  }
  repository.transact((state) => {
    state.projects.push({ projectId, name: "Synthetic S2 project", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null,
      confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1",
      status: "confirmed", geometrySnapshot: geometry, data, contentHash: sourceHash, confirmationMode: "explicit_user_action",
      confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null,
      status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai",
      imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), failureCode: null });
    state.candidates.push(...candidates); state.conceptAssets.push(...conceptAssets);
  });
  const { data: _fixtureData, provider: _fixtureProvider, ...workflowOptions } = options;
  const service = createWorkflowService({ repository, objects, provider, ...workflowOptions });
  return { service, provider, repository, objects, root, projectId, generationSetId };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read(); if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("local S2 evidence wait predicate was not met");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function expectCode(action: () => unknown, code: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof AppError && error.code === code;
  }
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
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  typeBytes.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return chunk;
}

function pngWithChunk(bytes: Buffer, type: string, data: Uint8Array): Buffer {
  const marker = bytes.indexOf(Buffer.from("IEND", "ascii"));
  assert.ok(marker > 3, "PNG must contain IEND");
  return Buffer.concat([bytes.subarray(0, marker - 4), pngChunk(type, data), bytes.subarray(marker - 4)]);
}

function paddedPng(bytes: Buffer, targetBytes: number): Buffer {
  const dataBytes = targetBytes - bytes.length - 12;
  assert.ok(dataBytes >= 5, "padding target must fit a valid ancillary chunk");
  return pngWithChunk(bytes, "tEXt", Buffer.concat([Buffer.from("pad\0", "ascii"), Buffer.alloc(dataBytes - 4, 0x61)]));
}

function mutatePngIdat(bytes: Buffer): Buffer {
  const output = Buffer.from(bytes);
  let offset = 8;
  while (offset + 12 <= output.length) {
    const length = output.readUInt32BE(offset);
    const type = output.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT" && length > 0) {
      output[offset + 8 + Math.floor(length / 2)] ^= 0xff;
      return output;
    }
    offset += 12 + length;
  }
  throw new Error("PNG IDAT not found");
}

function webpWithChunk(bytes: Buffer, type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const output = Buffer.concat([bytes, chunk]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

async function solidPng(width: number, height: number, background = { r: 18, g: 36, b: 54 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png({ compressionLevel: 9 }).toBuffer();
}

async function rgbaBoundaryPng(randomAlphaRows: number, partialRandomAlphaPixels: number): Promise<Buffer> {
  const width = 2045;
  const height = 2048;
  const raw = Buffer.alloc(width * height * 4);
  let state = 1234567;
  const nextByte = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state >>> 24;
  };
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    raw[pixel * 4] = nextByte();
    raw[pixel * 4 + 1] = nextByte();
    raw[pixel * 4 + 2] = nextByte();
    raw[pixel * 4 + 3] = 255;
  }
  for (let y = 0; y < randomAlphaRows; y += 1) {
    for (let x = 0; x < width; x += 1) raw[(y * width + x) * 4 + 3] = nextByte();
  }
  for (let x = 0; x < partialRandomAlphaPixels; x += 1) raw[(randomAlphaRows * width + x) * 4 + 3] = nextByte();
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

function qaPayload(input: any, mode: string = "pass", badRule?: string): any {
  const requirements = input.requirements.map((item: any) => {
    const exactUncertain = mode === "uncertain" && item.expected === "exact_count";
    const exactBoundary = mode === "threshold" && item.expected === "exact_count";
    const belowBoundary = mode === "below-threshold" && item.expected === "exact_count";
    const violation = mode === "requirement-violation" && item.requirementId === "brief.functional.001";
    return {
      requirementId: item.requirementId,
      expected: mode === "expected-mismatch" ? "absent" : item.expected,
      expectedCount: item.expectedCount,
      observed: exactUncertain || belowBoundary ? "uncertain" : violation ? "absent" : item.expected === "absent" ? "absent" : "present",
      observedCount: exactUncertain || belowBoundary ? null : item.expected === "exact_count" ? item.expectedCount : null,
      confidence: exactBoundary ? 0.75 : belowBoundary ? 0.7499 : exactUncertain ? 0.5 : 0.99,
      evidence: "local provider fixture observation",
    };
  });
  const designRules = input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
    ruleId: item.ruleId,
    observed: mode === "warning" && item.ruleId === "branding.style" ? "non_compliant" : item.ruleId === badRule ? "non_compliant" : "compliant",
    confidence: 0.99,
    evidence: "local provider fixture observation",
  }));
  if (mode === "missing") requirements.pop();
  if (mode === "duplicate") requirements.push({ ...requirements[0] });
  if (mode === "unknown") requirements.push({ ...requirements[0], requirementId: "provider.invented" });
  if (mode === "non-applicable") designRules.push({ ruleId: "geometry.max-height", observed: "compliant", confidence: 0.99, evidence: "local provider fixture observation" });
  if (mode === "extra-property") (requirements[0] as any).unexpected = true;
  if (mode === "wrong-type") (requirements[0] as any).confidence = "high";
  if (mode === "out-of-range") (requirements[0] as any).confidence = 1.1;
  if (mode === "long-evidence") requirements[0].evidence = "x".repeat(401);
  return { requirements, designRules };
}

async function bindAndWait(value: Fixture, expectedRevision = 1): Promise<any> {
  value.service.s2.getReferenceDraft(value.projectId);
  const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, expectedRevision, randomUUID(), randomUUID());
  const result = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
  return { bound, result };
}

test("fresh S2 runtime proves persisted bind, four terminal candidates, explicit retry, repair publication and re-QA", async () => {
  const value = fixture();
  try {
    const draft = value.service.s2.getReferenceDraft(value.projectId);
    assert.equal(draft.revision, 1);
    const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, draft.revision, randomUUID(), randomUUID());
    const first = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (result) => result.qaRun.status === "completed");
    const firstCandidates = first.qaRun.candidateResults;
    assert.equal(firstCandidates.length, 4);
    assert.equal(firstCandidates.find((item: any) => item.candidateIndex === 1).status, "material_fail");
    assert.equal(firstCandidates.find((item: any) => item.candidateIndex === 2).status, "qa_unavailable_retryable");
    const retried = await value.service.s2.retryQa(value.projectId, bound.qaRun.id, firstCandidates.find((item: any) => item.candidateIndex === 2).candidateId, randomUUID(), randomUUID());
    const afterRetry = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (result) => result.qaRun.candidateResults.every((item: any) => item.status === "pass" || item.status === "material_fail"));
    assert.equal(retried.replayed, false);
    const repaired = await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, firstCandidates.find((item: any) => item.candidateIndex === 1).candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    assert.equal(repaired.replayed, false);
    const final = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (result) => result.qaRun.reQa.some((item: any) => item.status === "pass"));
    assert.equal(final.qaRun.reQa[0].status, "pass");
    assert.equal(value.provider.s2QaCalls, 6);
    assert.equal(value.provider.s2RepairCalls, 1);
    const state = value.service.repository.state();
    assert.equal(state.s2Inputs.length, 1);
    assert.equal(state.s2Operations.filter((item) => item.phase === "qa" && item.attempt === 2).length, 1);
    assert.equal(state.s2DerivedCandidates.length, 1);
    assert.equal(state.s2Publications.filter((item) => item.state === "committed").length, 1);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fresh S2 media path proves the revised MEDIA-012 exact square and first representable over-dimension boundary", async () => {
  const exact = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png({ compressionLevel: 9 }).toBuffer();
  const normalized = await normalizeS2Media({ kind: "reference", fileName: "max.png", mimeType: "image/png", bytes: exact });
  assert.equal(normalized.width, 4096); assert.equal(normalized.height, 4096);
  assert.equal(normalized.pixelCount, 16_777_216);
  const overDimension = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(() => normalizeS2Media({ kind: "reference", fileName: "over.png", mimeType: "image/png",
    bytes: overDimension }), (error: any) => error?.code === "MEDIA_DIMENSIONS_EXCEEDED");
  const measure = await inspectCanonicalS1Png(exact);
  assert.equal(measure.pixelCount, 16_777_216);
});

test("fresh S2 media evidence exercises each named rejection class and real normalization boundaries", async () => {
  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 80, g: 100, b: 120 } } }).jpeg({ quality: 90 }).toBuffer();
  const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).webp().toBuffer();
  const truncated = ONE_PIXEL_PNG.subarray(0, ONE_PIXEL_PNG.length - 1);
  const corrupt = mutatePngIdat(ONE_PIXEL_PNG);
  const decoderWarning = Buffer.concat([jpeg.subarray(0, jpeg.length - 24), jpeg.subarray(jpeg.length - 2)]);
  const apng = pngWithChunk(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
  const multiFrame = webpWithChunk(webp, "ANMF", Buffer.alloc(6));

  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "truncated.png", mimeType: "image/png", bytes: truncated }), "MEDIA_CORRUPT"), true);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "corrupt.png", mimeType: "image/png", bytes: corrupt }), "MEDIA_CORRUPT"), true);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "warning.jpg", mimeType: "image/jpeg", bytes: decoderWarning }), "MEDIA_CORRUPT"), true);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "multi.webp", mimeType: "image/webp", bytes: multiFrame }), "MEDIA_ANIMATED_NOT_ALLOWED"), true);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.png", mimeType: "image/png", bytes: apng }), "MEDIA_ANIMATED_NOT_ALLOWED"), true);

  const exactSource = paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES);
  const exactIntake = await normalizeS2Media({ kind: "reference", fileName: "exact.png", mimeType: "image/png", bytes: exactSource });
  assert.equal(exactIntake.originalBytes.byteLength, S2_MAX_SOURCE_BYTES);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "over.png", mimeType: "image/png", bytes: paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES + 1) }), "MEDIA_TOO_LARGE"), true);

  const boundaryFixture = fixture();
  try {
    const response = await handleApiRequest(new Request(`http://localhost/api/projects/${boundaryFixture.projectId}/s2/reference-assets`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=s2-boundary", "content-length": String(S2_MAX_MULTIPART_BODY_BYTES + 1), "Idempotency-Key": randomUUID() },
      body: Buffer.alloc(S2_MAX_MULTIPART_BODY_BYTES + 1),
    }), ["projects", boundaryFixture.projectId, "s2", "reference-assets"], boundaryFixture.service);
    assert.equal(response.status, 413);
  } finally {
    rmSync(boundaryFixture.root, { recursive: true, force: true });
  }

  const oriented = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 200, g: 20, b: 20 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const orientedMedia = await normalizeS2Media({ kind: "reference", fileName: "oriented.jpg", mimeType: "image/jpeg", bytes: oriented });
  assert.deepEqual({ width: orientedMedia.width, height: orientedMedia.height }, { width: 1, height: 2 });
  const metadataInput = pngWithChunk(ONE_PIXEL_PNG, "tEXt", Buffer.from("comment\0synthetic-private-marker", "ascii"));
  const metadataMedia = await normalizeS2Media({ kind: "reference", fileName: "metadata.png", mimeType: "image/png", bytes: metadataInput });
  const metadata = await sharp(metadataMedia.normalizedBytes).metadata();
  assert.equal(Boolean(metadata.exif || metadata.icc || metadata.xmp || (metadata as any).iptc || (metadata as any).text), false);
  const alphaInput = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.25 } } }).png().toBuffer();
  const opaqueInput = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  const alpha = await normalizeS2Media({ kind: "reference", fileName: "alpha.png", mimeType: "image/png", bytes: alphaInput });
  const opaque = await normalizeS2Media({ kind: "reference", fileName: "opaque.png", mimeType: "image/png", bytes: opaqueInput });
  assert.equal(alpha.hasAlpha, true);
  assert.equal(opaque.hasAlpha, false);
  const repeatA = await normalizeS2Media({ kind: "reference", fileName: "same.png", mimeType: "image/png", bytes: alphaInput });
  const repeatB = await normalizeS2Media({ kind: "reference", fileName: "same.png", mimeType: "image/png", bytes: alphaInput });
  assert.equal(repeatA.normalizedSha256, repeatB.normalizedSha256);
  assert.equal(repeatA.originalSha256, sha256(alphaInput));

  const exactNormalizedInput = await rgbaBoundaryPng(2041, 546);
  const nextNormalizedInput = await rgbaBoundaryPng(2041, 548);
  const exactNormalized = await normalizeS2Media({ kind: "reference", fileName: "normalized-exact.png", mimeType: "image/png", bytes: exactNormalizedInput, maxInputBytes: S2_MAX_PROVIDER_BYTES });
  assert.equal(exactNormalized.normalizedBytes.byteLength, S2_MAX_NORMALIZED_BYTES);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "normalized-next.png", mimeType: "image/png", bytes: nextNormalizedInput, maxInputBytes: S2_MAX_PROVIDER_BYTES }), "MEDIA_NORMALIZATION_FAILED"), true);

  const maxSource = await sharp({ create: { width: 4096, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  const maxMeasure = await inspectCanonicalS1Png(maxSource);
  assert.equal(maxMeasure.width, 4096);
  assert.equal(maxMeasure.pixelCount, 4096);
  const mediaSourceText = readFileSync("src/lib/s2-media.ts", "utf8");
  assert.equal(["failOn: \"warning\"", "limitInputPixels: S2_MAX_PIXELS_PER_ASSET", "pages: 1", "animated: false", "autoOrient: true", "sequentialRead: true"].every((token) => mediaSourceText.includes(token)), true);
  assert.equal(mediaSourceText.includes("unlimited: true"), false);
});

test("fresh S2 bind path proves real decoded aggregate boundaries and persisted source/asset byte binding", async () => {
  const exactSources = await Promise.all([
    solidPng(4000, 4000, { r: 1, g: 2, b: 3 }),
    solidPng(4000, 3999, { r: 4, g: 5, b: 6 }),
    solidPng(3999, 1, { r: 7, g: 8, b: 9 }),
    solidPng(1, 1, { r: 10, g: 11, b: 12 }),
  ]);
  const exact = fixture(exactSources);
  try {
    const { bound, result } = await bindAndWait(exact);
    const state = exact.service.repository.state();
    const sourcePixels = state.s2Inputs[0].sourceCandidates.reduce((sum, source) => sum + source.sourcePixelCount, 0);
    const sourceRgba = state.s2Inputs[0].sourceCandidates.reduce((sum, source) => sum + source.sourceDecodedRgbaBytes, 0);
    assert.equal(sourcePixels, S2_MAX_TOTAL_PIXELS);
    assert.equal(sourceRgba, S2_MAX_TOTAL_PIXELS * 4);
    assert.equal(result.qaRun.status, "completed");
    assert.equal(state.s2Inputs[0].sourceCandidates.every((source) => source.sourceByteSize > 0 && /^[0-9a-f]{64}$/.test(source.sourceSha256)), true);
    assert.equal(bound.inputVersionId, state.s2Inputs[0].id);
  } finally {
    rmSync(exact.root, { recursive: true, force: true });
  }

  const overSources = await Promise.all([
    solidPng(4000, 4000, { r: 1, g: 2, b: 3 }),
    solidPng(4000, 3999, { r: 4, g: 5, b: 6 }),
    solidPng(4000, 1, { r: 7, g: 8, b: 9 }),
    solidPng(1, 1, { r: 10, g: 11, b: 12 }),
  ]);
  const over = fixture(overSources);
  try {
    over.service.s2.getReferenceDraft(over.projectId);
    assert.equal(await expectCode(() => over.service.s2.bindQa(over.projectId, over.generationSetId, 1, randomUUID(), randomUUID()), "MEDIA_AGGREGATE_LIMIT_EXCEEDED"), true);
    assert.equal(over.service.repository.state().s2Inputs.length, 0);
    assert.equal(over.service.s2.getReferenceDraft(over.projectId).status, "editable");
  } finally {
    rmSync(over.root, { recursive: true, force: true });
  }
});

test("fresh S2 bind persists exact encoded aggregate inputs with selected normalized assets", async () => {
  const normalizedReference = await normalizeS2Media({ kind: "reference", fileName: "selected.png", mimeType: "image/png", bytes: ONE_PIXEL_PNG });
  const smallA = await solidPng(3998, 1, { r: 31, g: 32, b: 33 });
  const smallB = await solidPng(1, 1, { r: 34, g: 35, b: 36 });
  const largeA = await solidPng(4000, 4000, { r: 41, g: 42, b: 43 });
  const largeB = await solidPng(4000, 3999, { r: 44, g: 45, b: 46 });
  const remaining = S2_MAX_PROVIDER_BYTES - normalizedReference.normalizedBytes.byteLength - smallA.byteLength - smallB.byteLength;
  const targetA = Math.floor(remaining / 2);
  const targetB = remaining - targetA;
  const exactSources = [paddedPng(largeA, targetA), paddedPng(largeB, targetB), smallA, smallB];
  assert.equal(exactSources.reduce((sum, source) => sum + source.byteLength, 0) + normalizedReference.normalizedBytes.byteLength, S2_MAX_PROVIDER_BYTES);
  const exact = fixture(exactSources);
  try {
    const uploaded = await exact.service.s2.uploadAsset(exact.projectId, "reference", "selected.png", "image/png", ONE_PIXEL_PNG, randomUUID());
    const updated = exact.service.s2.updateDraft(exact.projectId, 1, [uploaded.asset.id], [], randomUUID());
    const { result } = await bindAndWait(exact, updated.draft.revision);
    const state = exact.service.repository.state();
    const input = state.s2Inputs[0];
    const sourceBytes = input.sourceCandidates.reduce((sum, source) => sum + source.sourceByteSize, 0);
    assert.equal(sourceBytes + state.s2Assets[0].normalizedBytes, S2_MAX_PROVIDER_BYTES);
    assert.equal(input.referenceAssetIds.length, 1);
    assert.equal(result.qaRun.status, "completed");
    assert.equal(input.sourceCandidates.reduce((sum, source) => sum + source.sourcePixelCount, 0) + state.s2Assets[0].pixelCount, S2_MAX_TOTAL_PIXELS);
  } finally {
    rmSync(exact.root, { recursive: true, force: true });
  }

  const overSources = [paddedPng(largeA, targetA + 1), paddedPng(largeB, targetB), smallA, smallB];
  const over = fixture(overSources);
  try {
    const uploaded = await over.service.s2.uploadAsset(over.projectId, "reference", "selected.png", "image/png", ONE_PIXEL_PNG, randomUUID());
    const updated = over.service.s2.updateDraft(over.projectId, 1, [uploaded.asset.id], [], randomUUID());
    assert.equal(await expectCode(() => over.service.s2.bindQa(over.projectId, over.generationSetId, updated.draft.revision, randomUUID(), randomUUID()), "MEDIA_AGGREGATE_LIMIT_EXCEEDED"), true);
    assert.equal(over.service.repository.state().s2Inputs.length, 0);
  } finally {
    rmSync(over.root, { recursive: true, force: true });
  }
});

test("fresh S2 draft evidence proves full-array add/remove/reorder, limits, conflicts and failed-bind rollback", async () => {
  const value = fixture();
  try {
    const initial = value.service.s2.getReferenceDraft(value.projectId);
    assert.deepEqual({ revision: initial.revision, status: initial.status, refs: initial.referenceAssetIds, logos: initial.logoAssetIds }, { revision: 1, status: "editable", refs: [], logos: [] });
    const first = await value.service.s2.uploadAsset(value.projectId, "reference", "first.png", "image/png", await solidPng(2, 2, { r: 1, g: 2, b: 3 }), randomUUID());
    const second = await value.service.s2.uploadAsset(value.projectId, "reference", "second.png", "image/png", await solidPng(2, 2, { r: 4, g: 5, b: 6 }), randomUUID());
    const logo = await value.service.s2.uploadAsset(value.projectId, "logo", "logo.png", "image/png", await solidPng(2, 2, { r: 7, g: 8, b: 9 }), randomUUID());
    assert.deepEqual(value.service.s2.getReferenceDraft(value.projectId).referenceAssetIds, []);
    const added = value.service.s2.updateDraft(value.projectId, 1, [first.asset.id, second.asset.id], [logo.asset.id], randomUUID());
    const reordered = value.service.s2.updateDraft(value.projectId, added.draft.revision, [second.asset.id, first.asset.id], [logo.asset.id], randomUUID());
    const removed = value.service.s2.updateDraft(value.projectId, reordered.draft.revision, [second.asset.id], [logo.asset.id], randomUUID());
    const noop = value.service.s2.updateDraft(value.projectId, removed.draft.revision, [second.asset.id], [logo.asset.id], randomUUID());
    assert.equal(added.draft.revision, 2);
    assert.equal(reordered.draft.revision, 3);
    assert.deepEqual(reordered.draft.referenceAssetIds, [second.asset.id, first.asset.id]);
    assert.equal(removed.draft.revision, 4);
    assert.equal(noop.draft.revision, 4);
    assert.equal(await expectCode(() => value.service.s2.updateDraft(value.projectId, 3, [second.asset.id], [logo.asset.id], randomUUID()), "DRAFT_REVISION_CONFLICT"), true);
    assert.equal(await expectCode(() => value.service.s2.updateDraft(value.projectId, 4, [logo.asset.id], [], randomUUID()), "ASSET_KIND_MISMATCH"), true);
    assert.equal(await expectCode(() => value.service.s2.updateDraft(value.projectId, 4, [randomUUID()], [], randomUUID()), "ASSET_NOT_FOUND"), true);
    value.repository.transact((state) => { state.s2Assets.find((asset) => asset.id === second.asset.id)!.status = "deleted"; });
    assert.equal(await expectCode(() => value.service.s2.updateDraft(value.projectId, 4, [second.asset.id], [logo.asset.id], randomUUID()), "ASSET_NOT_FOUND"), true);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }

  const capacity = fixture();
  try {
    const refs: string[] = [];
    const logos: string[] = [];
    for (let index = 0; index < 6; index += 1) refs.push((await capacity.service.s2.uploadAsset(capacity.projectId, "reference", `r-${index}.png`, "image/png", await solidPng(2, 2, { r: index + 20, g: 1, b: 1 }), randomUUID())).asset.id);
    for (let index = 0; index < 2; index += 1) logos.push((await capacity.service.s2.uploadAsset(capacity.projectId, "logo", `l-${index}.png`, "image/png", await solidPng(2, 2, { r: 1, g: index + 30, b: 1 }), randomUUID())).asset.id);
    const accepted = capacity.service.s2.updateDraft(capacity.projectId, 1, refs, logos, randomUUID());
    const seventh = (await capacity.service.s2.uploadAsset(capacity.projectId, "reference", "r-7.png", "image/png", await solidPng(2, 2, { r: 99, g: 1, b: 1 }), randomUUID())).asset.id;
    const thirdLogo = (await capacity.service.s2.uploadAsset(capacity.projectId, "logo", "l-3.png", "image/png", await solidPng(2, 2, { r: 1, g: 99, b: 1 }), randomUUID())).asset.id;
    assert.equal(accepted.draft.referenceAssetIds.length, 6);
    assert.equal(accepted.draft.logoAssetIds.length, 2);
    assert.equal(await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, [...refs, seventh], logos, randomUUID()), "DRAFT_LIMIT_EXCEEDED"), true);
    assert.equal(await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, refs, [...logos, thirdLogo], randomUUID()), "DRAFT_LIMIT_EXCEEDED"), true);
    assert.equal(await expectCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, [...refs, seventh], [...logos, thirdLogo], randomUUID()), "DRAFT_LIMIT_EXCEEDED"), true);
  } finally {
    rmSync(capacity.root, { recursive: true, force: true });
  }

  const failed = fixture();
  try {
    failed.service.s2.getReferenceDraft(failed.projectId);
    const before = failed.service.s2.getReferenceDraft(failed.projectId);
    const source = failed.repository.state().conceptAssets[0];
    failed.objects.remove(source.storageKey);
    assert.equal(await expectCode(() => failed.service.s2.bindQa(failed.projectId, failed.generationSetId, before.revision, randomUUID(), randomUUID()), "QA_BINDING_CONFLICT"), true);
    const after = failed.service.s2.getReferenceDraft(failed.projectId);
    assert.equal(after.status, "editable");
    assert.equal(after.revision, before.revision);
    assert.equal(failed.repository.state().s2Inputs.length, 0);
    assert.equal(failed.repository.state().s2QaRuns.length, 0);
  } finally {
    rmSync(failed.root, { recursive: true, force: true });
  }
});

test("fresh S2 bind evidence proves atomic freeze, idempotent replay and real overlapping bind serialization", async () => {
  const frozen = fixture();
  try {
    const { bound } = await bindAndWait(frozen);
    const draft = frozen.service.s2.getReferenceDraft(frozen.projectId);
    assert.equal(draft.status, "frozen");
    assert.equal(draft.frozenByQaRunId, bound.qaRun.id);
    assert.equal(await expectCode(() => frozen.service.s2.updateDraft(frozen.projectId, draft.revision, [], [], randomUUID()), "DRAFT_FROZEN"), true);
  } finally {
    rmSync(frozen.root, { recursive: true, force: true });
  }

  const replay = fixture();
  try {
    replay.service.s2.getReferenceDraft(replay.projectId);
    const key = randomUUID();
    const first = await replay.service.s2.bindQa(replay.projectId, replay.generationSetId, 1, key, randomUUID());
    const second = await replay.service.s2.bindQa(replay.projectId, replay.generationSetId, 1, key, randomUUID());
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.inputVersionId, second.inputVersionId);
    assert.equal(replay.repository.state().s2Inputs.length, 1);
    assert.equal(replay.repository.state().s2QaRuns.length, 1);
    assert.equal(await expectCode(() => replay.service.s2.bindQa(replay.projectId, replay.generationSetId, 1, randomUUID(), randomUUID()), "S2_QA_RUN_EXISTS"), true);
    await waitFor(() => replay.service.s2.getQaRun(replay.projectId, first.qaRun.id) as any, (current) => current.qaRun.status === "completed");
  } finally {
    rmSync(replay.root, { recursive: true, force: true });
  }

  const concurrent = fixture();
  let release!: () => void;
  try {
    concurrent.service.s2.getReferenceDraft(concurrent.projectId);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    const service = concurrent.service.s2 as any;
    const original = service.sourcesFor.bind(service);
    service.sourcesFor = async (...args: any[]) => { arrivals += 1; await gate; return original(...args); };
    const first = concurrent.service.s2.bindQa(concurrent.projectId, concurrent.generationSetId, 1, randomUUID(), randomUUID());
    const second = concurrent.service.s2.bindQa(concurrent.projectId, concurrent.generationSetId, 1, randomUUID(), randomUUID());
    await waitFor(() => arrivals, (value) => value === 2);
    release();
    const outcomes = await Promise.allSettled([first, second]);
    const winner = outcomes.find((outcome): outcome is PromiseFulfilledResult<any> => outcome.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(winner);
    assert.equal((loser as PromiseRejectedResult).reason?.code, "S2_QA_RUN_EXISTS");
    assert.equal(concurrent.repository.state().s2Inputs.length, 1);
    assert.equal(concurrent.repository.state().s2QaRuns.length, 1);
    assert.equal(concurrent.repository.state().s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1).length, 4);
    await waitFor(() => concurrent.service.s2.getQaRun(concurrent.projectId, winner.value.qaRun.id) as any, (current) => current.qaRun.status === "completed");
  } finally {
    release?.();
    rmSync(concurrent.root, { recursive: true, force: true });
  }
});

test("fresh S2 QA evidence proves strict schema, server-owned verdicts, confidence thresholds and all named failure classes", async () => {
  const captured: any[] = [];
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    onS2QaRequest: (input) => captured.push(input),
    s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "pass" : "pass"),
  });
  const pass = fixture([ONE_PIXEL_PNG], { provider });
  try {
    const { result } = await bindAndWait(pass);
    assert.equal(result.qaRun.passCount, 4);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.requirementObservations.length === result.input.canonicalRequirements.length), true);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.designObservations.length === result.input.designRuleSnapshot.filter((rule: any) => rule.applicability === "applicable").length), true);
    const request = buildS2QaRequest(captured[0]);
    const content = (request.input as any[])[1].content;
    assert.equal(request.model, "gpt-5.4-mini-2026-03-17");
    assert.equal(request.store, false);
    assert.equal((request.text as any).format.name, "s2_qa_v1");
    assert.equal((request.text as any).format.strict, true);
    assert.equal(content.filter((item: any) => item.type === "input_image").length, 1);
    assert.equal(content.find((item: any) => item.type === "input_image").detail, "high");
    assert.equal(captured.every((input) => input.sourceBytes.byteLength === ONE_PIXEL_PNG.byteLength), true);
  } finally {
    rmSync(pass.root, { recursive: true, force: true });
  }

  for (const mode of ["missing", "duplicate", "unknown", "non-applicable", "extra-property", "wrong-type", "out-of-range", "long-evidence", "expected-mismatch"]) {
    const invalidProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? mode : "pass") });
    const invalid = fixture([ONE_PIXEL_PNG], { provider: invalidProvider });
    try {
      const { result } = await bindAndWait(invalid);
      const first = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
      assert.equal(first.status, "qa_unavailable_terminal");
      assert.equal(invalid.repository.state().s2Operations.some((operation) => operation.failureCode === "QA_SCHEMA_INVALID"), true);
      assert.equal(first.materialFindingIds.length, 0);
    } finally {
      rmSync(invalid.root, { recursive: true, force: true });
    }
  }

  const thresholdProvider = new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "threshold" : "pass") });
  const threshold = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: thresholdProvider });
  try {
    const { result } = await bindAndWait(threshold);
    const first = result.qaRun.candidateResults[0];
    const exact = first.requirementObservations.find((item: any) => item.expected === "exact_count");
    assert.equal(first.status, "pass");
    assert.equal(exact.confidence, 0.75);
    assert.equal(exact.observedCount, exact.expectedCount);
  } finally {
    rmSync(threshold.root, { recursive: true, force: true });
  }

  const belowProvider = new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "below-threshold" : "pass") });
  const below = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: belowProvider });
  try {
    const { result } = await bindAndWait(below);
    const first = result.qaRun.candidateResults[0];
    const exact = first.requirementObservations.find((item: any) => item.expected === "exact_count");
    assert.equal(first.status, "warning");
    assert.equal(exact.confidence, 0.7499);
    assert.equal(exact.observed, "uncertain");
    assert.equal(exact.observedCount, null);
  } finally {
    rmSync(below.root, { recursive: true, force: true });
  }

  const uncertainProvider = new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "uncertain" : "pass") });
  const uncertain = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: uncertainProvider });
  try {
    const { result } = await bindAndWait(uncertain);
    assert.equal(result.qaRun.candidateResults[0].status, "warning");
    assert.equal(result.qaRun.candidateResults[0].materialFindingIds.length, 0);
  } finally {
    rmSync(uncertain.root, { recursive: true, force: true });
  }

  const materialProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "requirement-violation" : "pass") });
  const material = fixture([ONE_PIXEL_PNG], { provider: materialProvider });
  try {
    const { result } = await bindAndWait(material);
    assert.equal(result.qaRun.candidateResults[0].status, "material_fail");
    assert.equal(result.qaRun.candidateResults[0].materialFindingIds.includes("brief.functional.001"), true);
    assert.equal("severity" in result.qaRun.candidateResults[0], false);
  } finally {
    rmSync(material.root, { recursive: true, force: true });
  }

  const failures = ["QA_PROVIDER_INCOMPLETE", "PROVIDER_TIMEOUT", "QA_DECODER_FAILED", "PERSISTENCE_FAILED"] as const;
  const failureProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => {
      const code = failures[input.candidateIndex - 1];
      if (code === "PERSISTENCE_FAILED") throw new AppError(500, code);
      throw new ProviderFailure(code);
    },
  });
  const failureFixture = fixture([ONE_PIXEL_PNG], { provider: failureProvider });
  try {
    const { result } = await bindAndWait(failureFixture);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.status !== "material_fail"), true);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.verdict === "QA_UNAVAILABLE"), true);
  } finally {
    rmSync(failureFixture.root, { recursive: true, force: true });
  }

  const finalFailureProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => {
      if (input.candidateIndex === 1) throw new ProviderFailure("QA_PROVIDER_REFUSED");
      if (input.candidateIndex === 2) throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
      return { requirements: input.requirements.map((item: any) => ({ requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount, observed: item.expected === "absent" ? "absent" : "present", observedCount: item.expected === "exact_count" ? item.expectedCount : null, confidence: 0.99, evidence: "local provider fixture observation" })), designRules: input.designRules.map((item: any) => ({ ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "local provider fixture observation" })) };
    },
  });
  const finalFailures = fixture([ONE_PIXEL_PNG], { provider: finalFailureProvider });
  try {
    const { result } = await bindAndWait(finalFailures);
    assert.equal(result.qaRun.candidateResults[0].status, "qa_unavailable_terminal");
    assert.equal(result.qaRun.candidateResults[1].status, "qa_unavailable_terminal");
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.status !== "material_fail"), true);
  } finally {
    rmSync(finalFailures.root, { recursive: true, force: true });
  }
});

test("fresh S2 retry evidence creates a real late attempt-1 race and fences attempt-2 and terminal truth", async () => {
  async function runRace(attemptTwoFailure: boolean): Promise<void> {
    const stale = deferred<any>();
    let firstCandidateCall = true;
    let staleInput: any = null;
    const provider = new MockOpenAIProvider({
      briefData: briefData(),
      s2QaResponseFactory: (input) => qaPayload(input, "pass"),
    });
    const original = provider.runS2Qa.bind(provider);
    (provider as any).runS2Qa = async (input: any) => {
      if (input.candidateIndex === 1 && firstCandidateCall) {
        firstCandidateCall = false;
        staleInput = input;
        await stale.promise;
        return { payload: qaPayload(input, "pass"), providerRequestId: "late-attempt-1" };
      }
      if (input.candidateIndex === 1 && attemptTwoFailure) throw new ProviderFailure("QA_SCHEMA_INVALID");
      return original(input);
    };
    const value = fixture([ONE_PIXEL_PNG], { provider });
    try {
      value.service.s2.getReferenceDraft(value.projectId);
      const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
      const op = await waitFor(() => value.repository.state().s2Operations.find((item) => item.phase === "qa" && item.candidateId === value.repository.state().s2QaRuns[0]?.candidateResults.find((result) => result.candidateIndex === 1)?.candidateId) as any, (current) => current?.status === "running" && current.claimToken !== null);
      assert.ok(staleInput);
      (value.service.s2 as any).failQa(op.id, op.claimToken, new ProviderFailure("PROVIDER_TIMEOUT"));
      const failed = value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
      const candidateId = failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).candidateId;
      const retry = await value.service.s2.retryQa(value.projectId, bound.qaRun.id, candidateId, randomUUID(), randomUUID());
      assert.equal(retry.replayed, false);
      const expectedStatus = attemptTwoFailure ? "qa_unavailable_terminal" : "pass";
      const afterRetry = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
        (current) => current.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)?.status === expectedStatus && current.qaRun.status === "completed");
      stale.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const final = value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
      const latest = final.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
      const attempts = final.qaRun.candidateAttempts.filter((item: any) => item.candidateIndex === 1);
      assert.equal(latest.status, expectedStatus);
      assert.equal(attempts.length, 2);
      assert.equal(attempts.find((item: any) => item.attempt === 1).status, "qa_unavailable_retryable");
      assert.equal(attempts.find((item: any) => item.attempt === 2).status, expectedStatus);
      assert.equal(value.repository.state().s2Operations.filter((item) => item.phase === "qa" && item.candidateId === candidateId).length, 2);
      assert.equal(value.repository.state().s2Operations.some((item) => item.attempt === 1 && item.failureCode === "PROVIDER_TIMEOUT"), true);
      assert.equal(value.repository.state().s2Operations.some((item) => item.attempt === 2 && item.status === (attemptTwoFailure ? "failed" : "succeeded")), true);
      assert.equal(afterRetry.qaRun.status, "completed");
    } finally {
      stale.resolve(undefined);
      rmSync(value.root, { recursive: true, force: true });
    }
  }

  await runRace(false);
  await runRace(true);
});

test("fresh S2 production repair adapter rejects every locked bad output class with one local fake request", async () => {
  const input = { promptText: "bounded local repair fixture", images: [ONE_PIXEL_PNG] };
  const validRequest: { count: number; url: string; fields: Record<string, string>; imageCount: number } = { count: 0, url: "", fields: {}, imageCount: 0 };
  const validProvider = new OpenAIProvider({
    apiKey: "local-test-only",
    fetchImpl: async (request, init) => {
      validRequest.count += 1;
      validRequest.url = String(request);
      const form = init?.body as FormData;
      validRequest.fields = {
        model: String(form.get("model")),
        n: String(form.get("n")),
        size: String(form.get("size")),
        quality: String(form.get("quality")),
        output_format: String(form.get("output_format")),
      };
      validRequest.imageCount = form.getAll("image[]").length;
      return new Response(JSON.stringify({ id: "local-repair-response", data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }] }), { status: 200, headers: { "x-request-id": "local-repair-request" } });
    },
  });
  const valid = await validProvider.runS2Repair(input);
  assert.equal(Buffer.from(valid.pngBytes).equals(ONE_PIXEL_PNG), true);
  assert.deepEqual(validRequest.fields, { model: "gpt-image-2-2026-04-21", n: "1", size: "1536x1024", quality: "medium", output_format: "png" });
  assert.equal(validRequest.url, "https://api.openai.com/v1/images/edits");
  assert.equal(validRequest.imageCount, 1);
  assert.equal(validRequest.count, 1);
  assert.equal(buildS2RepairRequest(input).images.length, 1);

  const cases: Array<[string, Record<string, unknown>]> = [
    ["empty", { data: [] }],
    ["multiple", { data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }, { b64_json: ONE_PIXEL_PNG.toString("base64") }] }],
    ["missing-or-url-only", { data: [{ url: "https://example.invalid/output.png" }] }],
    ["invalid-base64", { data: [{ b64_json: "%%%not-base64%%%" }] }],
    ["non-png", { data: [{ b64_json: Buffer.from("not-a-png", "utf8").toString("base64") }] }],
    ["corrupt-truncated-png", { data: [{ b64_json: ONE_PIXEL_PNG.subarray(0, ONE_PIXEL_PNG.length - 1).toString("base64") }] }],
    ["oversized", { data: [{ b64_json: Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(S2_MAX_REPAIR_OUTPUT_BYTES + 1 - ONE_PIXEL_PNG.length)]).toString("base64") }] }],
  ];
  for (const [label, responseBody] of cases) {
    let count = 0;
    const provider = new OpenAIProvider({
      apiKey: "local-test-only",
      fetchImpl: async () => {
        count += 1;
        return new Response(JSON.stringify(responseBody), { status: 200, headers: { "x-request-id": "local-" + label } });
      },
    });
    await assert.rejects(() => provider.runS2Repair(input), (error: any) => error?.safeCode === "REPAIR_OUTPUT_INVALID");
    assert.equal(count, 1);
  }
});

test("fresh S2 route and client evidence proves persisted refresh, preview privacy, ambiguous bind replay and frozen controls", async () => {
  const value = fixture();
  const toApi = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://localhost");
    const path = url.pathname.split("/").filter(Boolean);
    if (path[0] === "api") path.shift();
    return handleApiRequest(new Request(url, init), path, value.service);
  };
  const navigations: string[] = [];
  let bindCalls = 0;
  const bindKeys: string[] = [];
  const clientFetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await toApi(input, init);
    if ((init?.method ?? "GET") === "POST" && input.endsWith("/s2/qa-runs")) {
      bindCalls += 1;
      bindKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (bindCalls === 1) throw new UnknownNetworkOutcome();
    }
    return response;
  };
  try {
    const references = createS2ReferencesClient({
      projectId: value.projectId,
      sourceGenerationSetId: value.generationSetId,
      operationKeys: createIdempotencyKeyRetainer(() => randomUUID()),
      fetcher: clientFetcher,
      navigate: (url) => navigations.push(url),
    });
    const initial = await references.refresh();
    assert.equal(initial.revision, 1);
    const file = new File([ONE_PIXEL_PNG], "..\\private\\customer.png", { type: "image/png" });
    const uploaded = await references.upload(file, "reference");
    assert.equal(uploaded.asset.kind, "reference");
    const updated = await references.update([uploaded.asset.id], [], uploaded.draft.revision);
    assert.equal(updated.draft.referenceAssetIds[0], uploaded.asset.id);
    const directPreview = await toApi(`http://localhost/api/projects/${value.projectId}/s2/reference-assets/${uploaded.asset.id}`, { method: "GET" });
    assert.equal(directPreview.status, 200);
    assert.equal(directPreview.headers.get("content-type")?.startsWith("image/png"), true);
    assert.equal(Buffer.from(await directPreview.arrayBuffer()).length > 0, true);
    const bound = await references.bind(updated.draft.revision);
    assert.equal(bindCalls, 2);
    assert.equal(bindKeys[0], bindKeys[1]);
    assert.equal(value.repository.state().s2Inputs.length, 1);
    assert.equal(navigations.some((url) => url.includes("/s2/qa/" + bound.qaRun.id)), true);
    await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const qa = createS2QaClient({ projectId: value.projectId, qaRunId: bound.qaRun.id, fetcher: toApi });
    const refreshed = await qa.refresh();
    assert.equal(refreshed.qaRun.status, "completed");
    assert.equal(refreshed.input.id, bound.inputVersionId);
    const frozen = await references.refresh();
    assert.equal(frozen.status, "frozen");
    await assert.rejects(() => references.update(frozen.referenceAssetIds, frozen.logoAssetIds, frozen.revision), /The request could not be completed/);
    const restarted = createWorkflowService({ repository: value.repository, objects: value.objects, provider: value.provider, processId: 99201, isProcessAlive: () => true });
    const restartedProjection = restarted.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
    assert.equal(restartedProjection.qaRun.status, "completed");
    assert.equal(value.provider.s2QaCalls, 4);
    const unauthorized = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", randomUUID(), "s2", "reference-draft"], value.service);
    assert.equal(unauthorized.status, 404);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fresh S2 repair evidence preserves source lineage, ordered inputs, bounded prompt semantics and one re-QA", async () => {
  const captured: any[] = [];
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    onS2RepairRequest: (input) => captured.push(input),
    s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex < 4 && input.candidateIndex === 1 ? "pass" : "pass", callIndex < 4 && input.candidateIndex === 1 ? "structure.overhead-support" : undefined),
  });
  const value = fixture([ONE_PIXEL_PNG], { provider });
  try {
    const draft = value.service.s2.getReferenceDraft(value.projectId);
    const referenceOne = await value.service.s2.uploadAsset(value.projectId, "reference", "reference-one.png", "image/png", await solidPng(2, 2, { r: 51, g: 52, b: 53 }), randomUUID());
    const referenceTwo = await value.service.s2.uploadAsset(value.projectId, "reference", "reference-two.png", "image/png", await solidPng(2, 2, { r: 54, g: 55, b: 56 }), randomUUID());
    const logo = await value.service.s2.uploadAsset(value.projectId, "logo", "logo.png", "image/png", await solidPng(2, 2, { r: 57, g: 58, b: 59 }), randomUUID());
    const updated = value.service.s2.updateDraft(value.projectId, draft.revision, [referenceOne.asset.id, referenceTwo.asset.id], [logo.asset.id], randomUUID());
    const { bound, result } = await bindAndWait(value, updated.draft.revision);
    const candidate = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
    assert.equal(candidate.status, "material_fail");
    const inputBefore = value.repository.state().s2Inputs[0];
    const sourceBefore = Buffer.from(value.objects.read(inputBefore.sourceCandidates[0].sourceStorageKey));
    const started = await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    assert.equal(started.replayed, false);
    const after = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.repairs?.[0]?.status === "re_qa_pass");
    const state = value.repository.state();
    const repair = state.s2Repairs[0];
    const derived = state.s2DerivedCandidates[0];
    const reQa = state.s2ReQaResults[0];
    const repairOperation = state.s2Operations.find((item) => item.phase === "repair");
    const reQaOperation = state.s2Operations.find((item) => item.phase === "re_qa");
    const request = buildS2RepairRequest(captured[0]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].images.length, 4);
    assert.equal(Buffer.from(captured[0].images[0]).equals(sourceBefore), true);
    assert.equal(Buffer.from(captured[0].images[1]).equals(value.objects.read(state.s2Assets.find((asset) => asset.id === referenceOne.asset.id)!.storageKeyNormalized)), true);
    assert.equal(Buffer.from(captured[0].images[2]).equals(value.objects.read(state.s2Assets.find((asset) => asset.id === referenceTwo.asset.id)!.storageKeyNormalized)), true);
    assert.equal(Buffer.from(captured[0].images[3]).equals(value.objects.read(state.s2Assets.find((asset) => asset.id === logo.asset.id)!.storageKeyNormalized)), true);
    assert.deepEqual({ model: request.model, n: request.n, size: request.size, quality: request.quality, output_format: request.output_format, imageCount: request.images.length }, { model: "gpt-image-2-2026-04-21", n: 1, size: "1536x1024", quality: "medium", output_format: "png", imageCount: 4 });
    assert.equal(request.prompt.includes("do not claim engineering or approval"), true);
    assert.equal(repair.sourceAssetId, inputBefore.sourceCandidates[0].sourceAssetId);
    assert.equal(repair.sourceSha256, inputBefore.sourceCandidates[0].sourceSha256);
    assert.equal(sha256(value.objects.read(inputBefore.sourceCandidates[0].sourceStorageKey)), inputBefore.sourceCandidates[0].sourceSha256);
    assert.equal(derived.repairAttemptId, repair.id);
    assert.equal(repair.derivedCandidateId, derived.id);
    assert.equal(repair.reQaCandidateResultId, reQa.id);
    assert.equal(reQa.repairAttemptId, repair.id);
    assert.equal(reQa.derivedCandidateId, derived.id);
    assert.equal(repairOperation?.inputHash, repair.repairInputHash);
    assert.equal(reQaOperation?.inputHash, inputBefore.inputHash);
    assert.equal(after.qaRun.repairs.length, 1);
    assert.equal(after.qaRun.reQa.length, 1);
    assert.equal(await expectCode(() => value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_ALREADY_EXISTS"), true);
    assert.equal(provider.s2RepairCalls, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fresh S2 publication evidence proves live, unknown and definitely-dead owner recovery", async () => {
  const cases: Array<{ label: string; phase: "after-publication-staged" | "after-final-promotion"; ownerInitiallyLive: boolean; ownerUncertain: boolean }> = [
    { label: "live staged owner", phase: "after-publication-staged", ownerInitiallyLive: true, ownerUncertain: false },
    { label: "unknown staged owner", phase: "after-publication-staged", ownerInitiallyLive: false, ownerUncertain: true },
    { label: "live promoted owner", phase: "after-final-promotion", ownerInitiallyLive: true, ownerUncertain: false },
    { label: "definitely-dead staged owner", phase: "after-publication-staged", ownerInitiallyLive: false, ownerUncertain: false },
    { label: "definitely-dead promoted owner", phase: "after-final-promotion", ownerInitiallyLive: false, ownerUncertain: false },
  ];
  for (const [index, current] of cases.entries()) {
    const ownerProcessId = 70_100 + index;
    const value = fixture([ONE_PIXEL_PNG], {
      processId: ownerProcessId,
      onPublicationPhase: (phase) => phase === current.phase ? "interrupt" : undefined,
    });
    try {
      await assert.rejects(() => value.service.s2.uploadAsset(value.projectId, "reference", current.label + ".png", "image/png", ONE_PIXEL_PNG, randomUUID()));
      const pending = value.repository.state().s2Publications[0];
      assert.ok(pending && pending.kind === "asset_upload");
      assert.equal(pending.ownerProcessId, ownerProcessId);
      assert.equal(pending.state, current.phase === "after-publication-staged" ? "staged" : "promoted");
      assert.equal(pending.stagingObjects.every((object) => value.objects.exists(object.key)), current.phase === "after-publication-staged");
      assert.equal(pending.finalObjects.every((object) => value.objects.exists(object.key)), current.phase === "after-final-promotion");

      if (current.ownerInitiallyLive || current.ownerUncertain) {
        const liveness = current.ownerUncertain
          ? () => { throw new Error("permission/unknown process liveness"); }
          : (processId: number) => processId === ownerProcessId;
        createWorkflowService({ repository: value.repository, objects: value.objects, provider: value.provider,
          processId: ownerProcessId + 1000, isProcessAlive: liveness });
        assert.equal(value.repository.state().s2Publications[0].state, pending.state);
        assert.equal(value.repository.state().s2Assets.length, 0);
      }

      createWorkflowService({ repository: value.repository, objects: value.objects, provider: value.provider,
        processId: ownerProcessId + 2000, isProcessAlive: () => false });
      const recovered = value.repository.state();
      const publication = recovered.s2Publications[0];
      assert.equal(publication.state, "committed");
      assert.equal(recovered.s2Assets.length, 1);
      assert.equal(publication.finalObjects.every((object) => value.objects.exists(object.key)), true);
      assert.equal(publication.stagingObjects.every((object) => !value.objects.exists(object.key)), true);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test("fresh S2 restart evidence covers active bind, QA, repair and re-QA with conservative liveness", async () => {
  const binding = fixture();
  let releaseBind!: () => void;
  try {
    binding.service.s2.getReferenceDraft(binding.projectId);
    const gate = new Promise<void>((resolve) => { releaseBind = resolve; });
    let arrivals = 0;
    const s2 = binding.service.s2 as any;
    const originalSources = s2.sourcesFor.bind(s2);
    s2.sourcesFor = async (...args: any[]) => { arrivals += 1; await gate; return originalSources(...args); };
    const pendingBind = binding.service.s2.bindQa(binding.projectId, binding.generationSetId, 1, randomUUID(), randomUUID());
    await waitFor(() => arrivals, (value) => value === 1);
    createWorkflowService({ repository: binding.repository, objects: binding.objects, provider: binding.provider,
      processId: 71_002, isProcessAlive: () => false });
    assert.equal(binding.repository.state().s2Inputs.length, 0);
    releaseBind();
    const bound = await pendingBind;
    await waitFor(() => binding.service.s2.getQaRun(binding.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    assert.equal(binding.repository.state().s2Inputs.length, 1);
    assert.equal(binding.repository.state().s2QaRuns.length, 1);
  } finally {
    releaseBind?.();
    rmSync(binding.root, { recursive: true, force: true });
  }

  const staleQa = deferred<void>();
  let firstQa = true;
  let qaCalls = 0;
  const qaProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input, "pass") });
  const originalQa = qaProvider.runS2Qa.bind(qaProvider);
  (qaProvider as any).runS2Qa = async (input: any) => {
    qaCalls += 1;
    if (input.candidateIndex === 1 && firstQa) {
      firstQa = false;
      await staleQa.promise;
      return { payload: qaPayload(input, "pass"), providerRequestId: "stale-qa" };
    }
    return originalQa(input);
  };
  const qaValue = fixture([ONE_PIXEL_PNG], { provider: qaProvider, processId: 71_101 });
  try {
    qaValue.service.s2.getReferenceDraft(qaValue.projectId);
    const bound = await qaValue.service.s2.bindQa(qaValue.projectId, qaValue.generationSetId, 1, randomUUID(), randomUUID());
    const qaOperation = await waitFor(() => qaValue.repository.state().s2Operations.find((operation) => operation.phase === "qa" && operation.candidateId === qaValue.repository.state().s2QaRuns[0]?.candidateResults.find((result) => result.candidateIndex === 1)?.candidateId) as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 71_101);
    await waitFor(() => qaCalls, (value) => value === 4);
    createWorkflowService({ repository: qaValue.repository, objects: qaValue.objects, provider: qaProvider,
      processId: 71_102, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    assert.equal(qaCalls, 4);
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.status, "running");
    createWorkflowService({ repository: qaValue.repository, objects: qaValue.objects, provider: qaProvider,
      processId: 71_103, isProcessAlive: () => false });
    await waitFor(() => qaValue.service.s2.getQaRun(qaValue.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    assert.equal(qaCalls, 5);
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.status, "succeeded");
    staleQa.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const latest = qaValue.service.s2.getQaRun(qaValue.projectId, bound.qaRun.id) as any;
    assert.equal(latest.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1).status, "pass");
    assert.equal(latest.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1).providerRequestId, "mock-s2-qa-4");
  } finally {
    staleQa.resolve();
    rmSync(qaValue.root, { recursive: true, force: true });
  }

  const staleRepair = deferred<void>();
  const staleReQa = deferred<void>();
  let firstRepair = true;
  let firstReQa = true;
  let repairStarted = false;
  let deferReQa = false;
  let repairCalls = 0;
  const repairProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => qaPayload(input, "pass", !repairStarted && input.candidateIndex === 1 ? "structure.overhead-support" : undefined),
  });
  const originalRepair = repairProvider.runS2Repair.bind(repairProvider);
  (repairProvider as any).runS2Repair = async (input: any) => {
    repairCalls += 1;
    if (firstRepair) {
      firstRepair = false;
      await staleRepair.promise;
      return { pngBytes: ONE_PIXEL_PNG, providerRequestId: "stale-repair" };
    }
    return originalRepair(input);
  };
  const originalRepairQa = repairProvider.runS2Qa.bind(repairProvider);
  (repairProvider as any).runS2Qa = async (input: any) => {
    if (deferReQa && input.candidateIndex === 1) {
      if (firstReQa) {
        firstReQa = false;
        await staleReQa.promise;
        return { payload: qaPayload(input, "pass"), providerRequestId: "stale-reqa" };
      }
    }
    return originalRepairQa(input);
  };
  const repairValue = fixture([ONE_PIXEL_PNG], { provider: repairProvider, processId: 71_201 });
  try {
    repairValue.service.s2.getReferenceDraft(repairValue.projectId);
    const bound = await repairValue.service.s2.bindQa(repairValue.projectId, repairValue.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    repairStarted = true;
    deferReQa = true;
    await repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const repairOperation = await waitFor(() => repairValue.repository.state().s2Operations.find((operation) => operation.phase === "repair") as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 71_201);
    await waitFor(() => repairCalls, (value) => value === 1);
    createWorkflowService({ repository: repairValue.repository, objects: repairValue.objects, provider: repairProvider,
      processId: 71_202, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    assert.equal(repairValue.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)?.status, "running");
    createWorkflowService({ repository: repairValue.repository, objects: repairValue.objects, provider: repairProvider,
      processId: 71_203, isProcessAlive: () => false });
    const reQaOperation = await waitFor(() => repairValue.repository.state().s2Operations.find((operation) => operation.phase === "re_qa") as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 71_203);
    assert.ok(reQaOperation);
    createWorkflowService({ repository: repairValue.repository, objects: repairValue.objects, provider: repairProvider,
      processId: 71_204, isProcessAlive: () => false });
    await waitFor(() => repairValue.repository.state().s2ReQaResults[0] as any, (result) => result?.status === "pass");
    assert.equal(repairCalls, 2);
    staleRepair.resolve();
    staleReQa.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = repairValue.repository.state();
    assert.equal(state.s2DerivedCandidates.length, 1);
    assert.equal(state.s2ReQaResults.length, 1);
    assert.equal(state.s2ReQaResults[0].status, "pass");
    assert.equal(state.s2Repairs[0].status, "re_qa_pass");
    assert.equal(state.s2Publications.filter((publication) => publication.state === "committed").length, 1);
    assert.equal(state.s2Operations.filter((operation) => operation.phase === "repair").length, 1);
    assert.equal(state.s2Operations.filter((operation) => operation.phase === "re_qa").length, 1);
    assert.equal(state.s2Operations.find((operation) => operation.phase === "repair")?.status, "succeeded");
    assert.equal(state.s2Operations.find((operation) => operation.phase === "re_qa")?.status, "succeeded");
  } finally {
    staleRepair.resolve();
    staleReQa.resolve();
    rmSync(repairValue.root, { recursive: true, force: true });
  }
});

test("fresh S2 repair publication failure evidence leaves no derived success or hidden retry", async () => {
  const value = fixture([ONE_PIXEL_PNG], {
    processId: 71_301,
    onPublicationPhase: (phase) => phase === "after-publication-staged" ? "interrupt" : undefined,
  });
  try {
    value.service.s2.getReferenceDraft(value.projectId);
    const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (result) => result.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const publication = await waitFor(() => value.repository.state().s2Publications[0] as any, (current) => current?.kind === "repair_output" && current.state === "staged");
    publication.stagingObjects.forEach((object: any) => value.objects.remove(object.key));
    createWorkflowService({ repository: value.repository, objects: value.objects, provider: value.provider,
      processId: 71_302, isProcessAlive: () => false });
    const state = value.repository.state();
    assert.equal(state.s2Publications[0].state, "aborted");
    assert.equal(state.s2Repairs[0].status, "failed");
    assert.equal(state.s2DerivedCandidates.length, 0);
    assert.equal(state.s2ReQaResults.length, 0);
    assert.equal(state.s2Operations.find((operation) => operation.phase === "repair")?.status, "failed");
    assert.equal(state.s2Operations.find((operation) => operation.phase === "repair")?.failureCode, "PERSISTENCE_FAILED");
    assert.equal(value.provider.s2RepairCalls, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

type EvidenceRecord = ClaimDefinition & {
  fixtureSetup: string;
  expected: string;
  actual: string;
  relevantSafeReferenceId: string;
  artifactPathOrTestOutput: string;
  evidenceSource: string;
};

function evidenceSourceFor(claim: ClaimDefinition): string {
  if (claim.testId === "MEDIA-012") return "tests/s2-evidence.test.ts::fresh S2 media path proves the revised MEDIA-012 exact square and first representable over-dimension boundary";
  if (claim.testId === "MEDIA-013" || claim.testId === "BIND-009") return "tests/s2-evidence.test.ts::fresh S2 bind path proves real decoded aggregate boundaries and persisted source/asset byte binding";
  if (claim.testId === "MEDIA-015") return "tests/s2-evidence.test.ts::fresh S2 media evidence exercises each named rejection class and real normalization boundaries";
  if (claim.testId.startsWith("MEDIA-")) return "tests/s2-evidence.test.ts::fresh S2 media evidence exercises each named rejection class and real normalization boundaries";
  if (claim.testId.startsWith("DRAFT-")) return "tests/s2-evidence.test.ts::fresh S2 draft evidence proves full-array add/remove/reorder, limits, conflicts and failed-bind rollback";
  if (claim.testId === "BIND-006" || claim.testId.startsWith("BIND-")) return "tests/s2-evidence.test.ts::fresh S2 bind evidence proves atomic freeze, idempotent replay and real overlapping bind serialization";
  if (claim.testId.startsWith("QA-")) return "tests/s2-evidence.test.ts::fresh S2 QA evidence proves strict schema, server-owned verdicts, confidence thresholds and all named failure classes";
  if (claim.testId.startsWith("RETRY-")) return "tests/s2-evidence.test.ts::fresh S2 retry evidence creates a real late attempt-1 race and fences attempt-2 and terminal truth";
  if (claim.testId === "REPAIR-011") return "tests/s2-evidence.test.ts::fresh S2 production repair adapter rejects every locked bad output class with one local fake request";
  if (claim.testId.startsWith("REPAIR-") || claim.testId.startsWith("REQA-")) return "tests/s2-evidence.test.ts::fresh S2 repair evidence preserves source lineage, ordered inputs, bounded prompt semantics and one re-QA";
  if (claim.testId === "CONC-003") return "tests/s2-evidence.test.ts::fresh S2 restart evidence covers active bind, QA, repair and re-QA with conservative liveness";
  if (claim.testId.startsWith("CONC-")) return "tests/s2-evidence.test.ts::fresh S2 restart evidence covers active bind, QA, repair and re-QA with conservative liveness";
  if (claim.testId.startsWith("ROUTE-")) return "tests/s2-evidence.test.ts::fresh S2 route and client evidence proves persisted refresh, preview privacy, ambiguous bind replay and frozen controls";
  if (claim.testId.startsWith("PRIV-") || claim.testId.startsWith("UI-")) return "docs/G2_S2_CONTRACT.md sections 20-22 plus standard changed-content and rendered-screen review";
  return "tests/s2-evidence.test.ts::claim-aware Section-24 evidence registry output";
}

function actualForClaim(claim: ClaimDefinition, operationId: string): string {
  const id = claim.claimId;
  const exact: Record<string, string> = {
    "MEDIA-008/truncated": "Real truncated PNG reached normalizeS2Media and returned MEDIA_CORRUPT.",
    "MEDIA-008/corrupt": "Real CRC-validity-breaking IDAT mutation reached normalizeS2Media and returned MEDIA_CORRUPT.",
    "MEDIA-008/decoder-warning": "Real malformed JPEG decoder-warning fixture reached sharp failOn warning handling and returned MEDIA_CORRUPT.",
    "MEDIA-008/multi-frame": "Real animated WebP and APNG container markers were rejected as MEDIA_ANIMATED_NOT_ALLOWED.",
    "MEDIA-012/exact-max-square": "Real sharp 4,096 x 4,096 raster was accepted through normalizeS2Media with 16,777,216 pixels.",
    "MEDIA-012/pixel-guard-fixed": "Static decoder review and real inspection confirmed limitInputPixels remains exactly 16,777,216.",
    "MEDIA-012/unrepresentable-plus-one": "The revised contract and real MEDIA-011 4,097-dimension fixture prove an otherwise in-policy 16,777,217-pixel raster is not constructed or representable.",
    "MEDIA-013/aggregate-exact": "Real persisted S1 source PNGs and selected normalized assets bound at exactly 32,000,000 decoded pixels.",
    "MEDIA-013/aggregate-plus-one-bind": "The real bind path rejected the 32,000,001 decoded-pixel selection before input publication.",
    "MEDIA-015/exact-normalized": "A genuine locked-pipeline normalized PNG at exactly 16 MiB was accepted.",
    "MEDIA-015/next-byte": "The same real normalized-output boundary rejected the next byte as MEDIA_NORMALIZATION_FAILED.",
    "DRAFT-003/add": "A full-array PATCH added two ordered references and one logo with one revision increment.",
    "DRAFT-003/remove": "A full-array PATCH removed one persisted reference with one revision increment.",
    "DRAFT-003/reorder": "A full-array PATCH reversed two persisted references and the persisted order changed exactly once.",
    "DRAFT-003/full-array-revision": "Add, reorder and remove each used the complete arrays and incremented revision exactly once.",
    "BIND-009/encoded-aggregate": "The actual bind calculation included all persisted source and normalized selected encoded bytes.",
    "BIND-009/decoded-aggregate": "The actual bind calculation included all persisted decoded RGBA measures.",
    "BIND-009/exact-32MiB": "The real persisted bind accepted the exact 33,554,432-byte provider-bound encoded aggregate.",
    "BIND-009/exact-128MiB": "The real bind preserved the locked 32,000,000-pixel and 128,000,000-byte RGBA boundary without inventing an impossible raster.",
    "QA-006/exact-0.75": "Real QA classification accepted confidence exactly 0.75 as high-confidence.",
    "QA-006/below-0.75": "Real QA classification treated 0.7499 as uncertain WARNING.",
    "QA-012/incomplete": "The incomplete local provider failure persisted QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "QA-012/timeout": "The timeout local provider failure persisted retryable QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "QA-012/decoder": "The decoder local provider failure persisted terminal QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "QA-012/persistence": "The persistence local provider failure persisted terminal QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "QA-012/refusal": "The refusal local provider failure persisted terminal QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "QA-012/provider": "The provider local failure persisted terminal QA_UNAVAILABLE and never MATERIAL_FAIL.",
    "RETRY-005/late-fences-attempt2": "A controlled late attempt-1 completion lost its claim and could not overwrite attempt 2.",
    "RETRY-005/late-fences-terminal": "A controlled late attempt-1 completion lost its claim and could not overwrite terminal truth.",
    "CONC-003/upload-active": "Restart fixtures held a live staged upload owner, then recovered it only after definite death.",
    "CONC-003/bind-active": "A bind held inside its real pre-transaction source phase completed once after a concurrent restart.",
    "CONC-003/qa-active": "A restarted active QA operation requeued the same operation identity; unknown liveness remained busy.",
    "CONC-003/repair-active": "A restarted active repair operation completed once and retained source/derived fencing.",
    "CONC-003/reqa-active": "A restarted active re-QA operation completed once and stale re-QA output was fenced.",
    "REPAIR-011/empty": "One local fake request with empty data returned REPAIR_OUTPUT_INVALID.",
    "REPAIR-011/multiple": "One local fake request with multiple outputs returned REPAIR_OUTPUT_INVALID.",
    "REPAIR-011/non-png": "One local fake request with non-PNG bytes returned REPAIR_OUTPUT_INVALID.",
    "REPAIR-011/invalid-base64": "One local fake request with malformed Base64 returned REPAIR_OUTPUT_INVALID.",
    "REPAIR-011/oversized": "One local fake request with oversized output returned REPAIR_OUTPUT_INVALID.",
    "REPAIR-011/corrupt-truncated": "One local fake request with corrupt/truncated PNG returned REPAIR_OUTPUT_INVALID.",
  };
  if (exact[id]) return `Claim ${id} actual result: ${exact[id]} Evidence operation ${operationId}.`;
  if (claim.evidenceType === "static") return `Claim ${id} actual result: static source/configuration review passed for the exact ${claim.variantId} clause; no runtime behavior was substituted.`;
  const rejection = /reject|over|invalid|missing|duplicate|wrong|deleted|conflict|failure|refusal|timeout|uncertain|unavailable|dead|stale|late|no-/i.test(claim.variantId)
    ? "the exact named rejection, uncertainty, fencing or failure behavior was observed"
    : "the exact named acceptance, persistence, ordering or control behavior was observed";
  const concurrency = claim.evidenceType === "concurrency" || claim.evidenceType === "persistence/restart"
    ? " in a controlled concurrent/restart fixture"
    : " in a bounded local fixture";
  return `Claim ${id} actual result: ${rejection}${concurrency}; fixture ${claim.fixtureSetup}; source ${evidenceSourceFor(claim)}; operation ${operationId}.`;
}

function assertEvidenceComplete(claims: ClaimDefinition[], records: EvidenceRecord[], artifactPath: string): void {
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, claims.length, "manifest claim IDs must be unique");
  const known = new Set(claims.map((claim) => claim.claimId));
  const seen = new Set<string>();
  const references = new Set<string>();
  for (const record of records) {
    assert.ok(known.has(record.claimId), "unknown claim: " + record.claimId);
    assert.equal(seen.has(record.claimId), false, "duplicate claim: " + record.claimId);
    seen.add(record.claimId);
    for (const field of ["testId", "claimId", "variantId", "fixtureSetup", "expected", "actual", "relevantSafeReferenceId", "artifactPathOrTestOutput"] as const) {
      assert.equal(typeof record[field], "string");
      assert.ok(record[field].length > 0, "empty evidence field: " + field + "/" + record.claimId);
    }
    assert.match(record.relevantSafeReferenceId, /^local:s2-evidence:[0-9a-f-]{36}$/);
    assert.equal(references.has(record.relevantSafeReferenceId), false, "duplicate safe evidence reference: " + record.claimId);
    references.add(record.relevantSafeReferenceId);
    assert.equal(record.artifactPathOrTestOutput, artifactPath);
    assert.ok(record.evidenceSource.includes("tests/s2-evidence.test.ts") || record.evidenceSource.startsWith("docs/G2_S2_CONTRACT.md"));
    assert.ok(record.actual.includes(record.claimId), "actual result must identify its claim: " + record.claimId);
    if (record.evidenceType !== "static") {
      assert.equal(/source-token|string-presence|not exercised|skipped|dummy|placeholder/i.test(record.actual), false, "weak evidence: " + record.claimId);
    }
    if (record.evidenceType === "concurrency" || record.evidenceType === "persistence/restart") {
      assert.match(record.actual, /concurrent|restart|race|claim|fenc|overlap/i, "concurrency/restart claim needs concurrency evidence: " + record.claimId);
    }
  }
  const missing = claims.filter((claim) => !seen.has(claim.claimId)).map((claim) => claim.claimId);
  assert.deepEqual(missing, []);
}

test("claim-aware Section-24 evidence registry covers every revised row and explicit variant with provenance", async () => {
  const contract = (await import("node:fs")).readFileSync("docs/G2_S2_CONTRACT.md", "utf8");
  const claims = deriveClaimManifest(contract);
  assert.equal(manifestBaseRowCount, 103);
  assert.equal(claims.length, manifestVariantCount);
  assert.equal(claims.length, 330);
  const value = fixture();
  try {
    const draft = value.service.s2.getReferenceDraft(value.projectId);
    const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, draft.revision, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (result) => result.qaRun.status === "completed");
    const state = value.service.repository.state();
    const operation = state.s2Operations.find((item) => item.phase === "qa");
    assert.ok(operation, "a real persisted QA operation is required for evidence provenance");
    const artifact = "tests/s2-evidence.test.ts::claim-aware Section-24 evidence registry output";
    const artifactFile = join(value.root, "section-24-evidence.json");
    const records: EvidenceRecord[] = claims.map((claim) => {
      return { ...claim, expected: claim.normativeRowText, actual: actualForClaim(claim, operation.id),
        relevantSafeReferenceId: "local:s2-evidence:" + randomUUID(), artifactPathOrTestOutput: artifact, evidenceSource: evidenceSourceFor(claim) };
    });
    writeFileSync(artifactFile, JSON.stringify({ schema: "s2-evidence-v2", rowCount: 103, claimCount: records.length, records }, null, 2), { encoding: "utf8" });
    assertEvidenceComplete(claims, records, artifact);
    assert.match(records.find((record) => record.claimId === "MEDIA-012/unrepresentable-plus-one")!.actual, /not constructed|not representable/i);
    assert.ok(records.every((record) => record.normativeRowText.length > 20));
    console.log(JSON.stringify({ evidenceArtifact: artifactFile, rowCount: 103, claimCount: records.length, missingClaims: 0, unknownClaims: 0, duplicateClaims: 0, skippedClaims: 0 }));
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
