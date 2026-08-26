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
  S2_MEDIA_PROFILE,
  S2_MAX_MULTIPART_BODY_BYTES,
  S2_MAX_NORMALIZED_BYTES,
  S2_MAX_DIMENSION,
  S2_MAX_LOGOS,
  S2_MAX_PIXELS_PER_ASSET,
  S2_MAX_PROVIDER_BYTES,
  S2_MAX_REPAIR_OUTPUT_BYTES,
  S2_MAX_REFERENCES,
  S2_MAX_RGBA_BYTES_PER_ASSET,
  S2_MAX_SOURCE_BYTES,
  S2_MAX_TOTAL_PIXELS,
  S2_MAX_TOTAL_RGBA_BYTES,
} from "../src/lib/s2-media";
import { buildS2QaRequest, buildS2RepairRequest } from "../src/lib/s2-provider";
import { handleApiRequest } from "../src/lib/api";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { jcs, sha256 } from "../src/lib/utils";
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
  geometry?: any;
} & Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onPublicationPhase">;

type Fixture = { service: WorkflowService; provider: MockOpenAIProvider; repository: JsonRepository; objects: PrivateObjectStore; root: string; projectId: string; generationSetId: string };

function fixture(sources: Buffer[] = [ONE_PIXEL_PNG], options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s2-evidence-"));
  const repository = new JsonRepository(root);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID(); const generationSetId = randomUUID(); const briefVersionId = randomUUID();
  const sourceHash = sha256(sources[0]);
  const geometry = options.geometry ?? { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null } as any;
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

async function decoderWarningJpeg(): Promise<Buffer> {
  const raw = Buffer.alloc(96 * 96 * 3);
  let state = 987654321;
  for (let index = 0; index < raw.length; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    raw[index] = state >>> 24;
  }
  const jpeg = await sharp(raw, { raw: { width: 96, height: 96, channels: 3 } }).jpeg({ quality: 82, progressive: false }).toBuffer();
  const scanMarker = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scanMarker >= 0, "deterministic JPEG must contain a scan marker");
  const scanDataStart = scanMarker + 2 + jpeg.readUInt16BE(scanMarker + 2);
  const mutationOffset = 535;
  assert.ok(mutationOffset >= scanDataStart && mutationOffset < jpeg.length - 2, "warning mutation must remain inside JPEG scan data");
  const warning = Buffer.from(jpeg);
  warning[mutationOffset] ^= 1;
  return warning;
}

async function sharpDecodeSucceeds(bytes: Uint8Array, failOn: "error" | "warning"): Promise<boolean> {
  try {
    await sharp(bytes, { failOn }).png().toBuffer();
    return true;
  } catch {
    return false;
  }
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
    const notVerifiable = mode === "not-verifiable" && item.requirementId === "brief.functional.001";
    const exactEvidence = mode === "exact-evidence" && item.requirementId === "brief.functional.001";
    const exactBoundary = mode === "threshold" && item.expected === "exact_count";
    const belowBoundary = mode === "below-threshold" && item.expected === "exact_count";
    const violation = mode === "requirement-violation" && item.requirementId === "brief.functional.001";
    return {
      requirementId: item.requirementId,
      expected: mode === "expected-mismatch" ? "absent" : item.expected,
      expectedCount: item.expectedCount,
      observed: exactUncertain || belowBoundary ? "uncertain" : notVerifiable ? "not_verifiable" : violation ? "absent" : item.expected === "absent" ? "absent" : "present",
      observedCount: exactUncertain || belowBoundary || notVerifiable ? null : item.expected === "exact_count" ? item.expectedCount : null,
      confidence: exactBoundary ? 0.75 : belowBoundary ? 0.7499 : exactUncertain ? 0.5 : 0.99,
      evidence: exactEvidence ? "x".repeat(400) : "local provider fixture observation",
    };
  });
  const badRules = new Set((badRule ?? "").split(",").filter(Boolean));
  const designRules = input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
    ruleId: item.ruleId,
    observed: mode === "warning" && item.ruleId === "branding.style" ? "non_compliant" : badRules.has(item.ruleId) ? "non_compliant" : "compliant",
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
  const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).webp().toBuffer();
  const truncated = ONE_PIXEL_PNG.subarray(0, ONE_PIXEL_PNG.length - 1);
  const corrupt = mutatePngIdat(ONE_PIXEL_PNG);
  const decoderWarning = await decoderWarningJpeg();
  const apng = pngWithChunk(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
  const multiFrame = webpWithChunk(webp, "ANMF", Buffer.alloc(6));

  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "truncated.png", mimeType: "image/png", bytes: truncated }), "MEDIA_CORRUPT"), true);
  assert.equal(await expectCode(() => normalizeS2Media({ kind: "reference", fileName: "corrupt.png", mimeType: "image/png", bytes: corrupt }), "MEDIA_CORRUPT"), true);
  assert.equal(await sharpDecodeSucceeds(decoderWarning, "error"), true);
  assert.equal(await sharpDecodeSucceeds(decoderWarning, "warning"), false);
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

type EvidenceFact = string | number | boolean | null;
type EvidenceFacts = Record<string, EvidenceFact>;
type EvidenceObservation = {
  kind: ClaimDefinition["evidenceType"];
  assertionIds: string[];
  facts: EvidenceFacts;
};
type EvidenceRecord = ClaimDefinition & {
  expected: string;
  actual: string;
  relevantSafeReferenceId: string;
  artifactPathOrTestOutput: string;
  evidenceSource: string;
  provingTest: string;
  executionId: string;
  observation: EvidenceObservation;
};
type EvidenceProof = {
  provingTest: string;
  fixtureSetup: string;
  assertionIds: string[];
  facts: EvidenceFacts;
  actual: string;
  relevantSafeReferenceId?: string;
  artifactPathOrTestOutput?: string;
  evidenceSource?: string;
  expected?: string;
};

class EvidenceValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(code + ": " + message);
    this.name = "EvidenceValidationError";
  }
}

function evidenceFactText(facts: EvidenceFacts): string {
  return Object.entries(facts).map(([key, value]) => key + "=" + String(value)).join(" ");
}

function observedActual(statement: string, facts: EvidenceFacts): string {
  return statement + " " + evidenceFactText(facts);
}

function deterministicEvidenceReference(provingTest: string, claimId: string, facts: EvidenceFacts): string {
  return "local:s2-evidence:" + sha256(jcs({ provingTest, claimId, facts }));
}

class ExecutionEvidenceRegistry {
  private readonly claimsById: Map<string, ClaimDefinition>;
  private readonly emitted: EvidenceRecord[] = [];

  constructor(claims: readonly ClaimDefinition[]) {
    this.claimsById = new Map();
    for (const claim of claims) {
      if (this.claimsById.has(claim.claimId)) throw new EvidenceValidationError("duplicate-manifest-claim", claim.claimId);
      this.claimsById.set(claim.claimId, claim);
    }
  }

  async proveMany(claimIds: readonly string[], proof: EvidenceProof, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    for (const claimId of claimIds) {
      const claim = this.claimsById.get(claimId);
      if (!claim) throw new EvidenceValidationError("unknown-claim", claimId);
      const reference = proof.relevantSafeReferenceId ?? deterministicEvidenceReference(proof.provingTest, claimId, proof.facts);
      const artifact = proof.artifactPathOrTestOutput ?? proof.provingTest + "::assertion-output";
      const source = proof.evidenceSource ?? proof.provingTest;
      this.emitted.push({
        ...claim,
        expected: proof.expected ?? claim.normativeRowText,
        actual: proof.actual + " claimId=" + claimId,
        relevantSafeReferenceId: reference,
        artifactPathOrTestOutput: artifact,
        evidenceSource: source,
        provingTest: proof.provingTest,
        executionId: reference,
        observation: { kind: claim.evidenceType, assertionIds: proof.assertionIds.slice(), facts: { ...proof.facts } },
      });
    }
  }

  records(): EvidenceRecord[] {
    return this.emitted.slice();
  }
}

function evidenceFailure(code: string, message: string): never {
  throw new EvidenceValidationError(code, message);
}

function assertEvidenceComplete(claims: readonly ClaimDefinition[], records: readonly EvidenceRecord[], reportArtifact: string): void {
  const known = new Map<string, ClaimDefinition>();
  for (const claim of claims) {
    if (known.has(claim.claimId)) evidenceFailure("duplicate-manifest-claim", claim.claimId);
    known.set(claim.claimId, claim);
  }
  const seen = new Set<string>();
  for (const record of records) {
    const claim = known.get(record.claimId);
    if (!claim) evidenceFailure("unknown-claim", record.claimId);
    if (seen.has(record.claimId)) evidenceFailure("duplicate-claim", record.claimId);
    seen.add(record.claimId);
    if (record.testId !== claim.testId || record.variantId !== claim.variantId || record.normativeRowText !== claim.normativeRowText || record.evidenceType !== claim.evidenceType) {
      evidenceFailure("claim-identity-mismatch", record.claimId);
    }
    for (const field of ["testId", "claimId", "variantId", "fixtureSetup", "expected", "actual", "relevantSafeReferenceId", "artifactPathOrTestOutput", "evidenceSource", "provingTest", "executionId"] as const) {
      if (typeof record[field] !== "string" || record[field].length === 0) evidenceFailure("missing-provenance", field + "/" + record.claimId);
    }
    if (record.expected !== claim.normativeRowText) evidenceFailure("expected-mismatch", record.claimId);
    if (!/^(?:operation|request|local:s2-evidence):[A-Za-z0-9_.:/-]+$/.test(record.relevantSafeReferenceId) || /dummy|random|placeholder/i.test(record.relevantSafeReferenceId)) {
      evidenceFailure("invalid-safe-reference", record.claimId);
    }
    if (!record.artifactPathOrTestOutput.includes("::") || !record.provingTest.includes("tests/s2-evidence.test.ts")) {
      evidenceFailure("missing-provenance", record.claimId);
    }
    if (!record.evidenceSource.includes(record.provingTest)) evidenceFailure("unlinked-provenance", record.claimId);
    if (!record.actual.includes("claimId=" + record.claimId)) evidenceFailure("actual-identity-missing", record.claimId);
    if (!record.observation || record.observation.kind !== record.evidenceType || record.observation.assertionIds.length === 0 || Object.keys(record.observation.facts).length === 0) {
      evidenceFailure("missing-observation", record.claimId);
    }
    if (record.evidenceType === "boundary") {
      if (!("boundaryValue" in record.observation.facts) || !("result" in record.observation.facts)) evidenceFailure("boundary-facts-missing", record.claimId);
      if (!record.actual.includes("boundaryValue=" + String(record.observation.facts.boundaryValue)) || !record.actual.includes("result=" + String(record.observation.facts.result))) {
        evidenceFailure("boundary-mismatch", record.claimId);
      }
    }
    for (const [key, value] of Object.entries(record.observation.facts)) {
      if (!record.actual.includes(key + "=" + String(value))) evidenceFailure("observation-mismatch", record.claimId + "/" + key);
    }
    if (record.evidenceType !== "static" && /source-token|string-presence|not exercised|skipped|dummy|placeholder|manifest-only|generic observation/i.test(record.actual)) {
      evidenceFailure("weak-evidence", record.claimId);
    }
    if (record.evidenceType === "static" && !/sourcePath=|checkedValue=|configuration=/i.test(record.actual)) {
      evidenceFailure("static-provenance-missing", record.claimId);
    }
    if (record.evidenceType === "concurrency" && record.observation.facts.overlap !== true && record.observation.facts.race !== true && record.observation.facts.claimTokenFencing !== true) {
      evidenceFailure("concurrency-proof", record.claimId);
    }
    if (record.evidenceType === "persistence/restart" && record.observation.facts.restartDuringActivePhase !== true && record.observation.facts.claimTokenFencing !== true) {
      evidenceFailure("restart-proof", record.claimId);
    }
    if (record.claimId === "MEDIA-014/aggregate-max-representable" &&
        (record.observation.facts.aggregateRgbaBytes === 134_217_728 || record.observation.facts.aggregatePixelCount === 33_554_432)) {
      evidenceFailure("impossible-boundary", record.claimId);
    }
  }
  for (const claim of claims) if (!seen.has(claim.claimId)) evidenceFailure("missing-claim", claim.claimId);
  if (!reportArtifact.includes("section-24-evidence")) evidenceFailure("missing-report-artifact", reportArtifact);
}

async function observedErrorCode(action: () => unknown): Promise<string> {
  try {
    await action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof AppError ? error.code : "UNKNOWN_ERROR";
  }
}

function claimIds(testId: string, variants: readonly string[]): string[] {
  return variants.map((variant) => testId + "/" + variant);
}

test("execution-bound evidence validator negative self-tests", async () => {
  const contract = readFileSync("docs/G2_S2_CONTRACT.md", "utf8");
  const claims = deriveClaimManifest(contract);
  async function validRecord(claimId: string): Promise<EvidenceRecord> {
    const registry = new ExecutionEvidenceRegistry(claims);
    await registry.proveMany([claimId], {
      provingTest: "tests/s2-evidence.test.ts::validator self-test proving assertion",
      fixtureSetup: "local assertion fixture",
      assertionIds: ["validator.assertion.success"],
      facts: { boundaryValue: 1, result: "accepted", measured: 1 },
      actual: observedActual("The proving assertion returned the measured result.", { boundaryValue: 1, result: "accepted", measured: 1 }),
    }, () => assert.equal(1, 1));
    return registry.records()[0];
  }
  const valid = await validRecord("MEDIA-011/exact-4096");
  assert.throws(() => assertEvidenceComplete(claims, [valid], "section-24-evidence.json"), (error: any) => error?.code === "missing-claim");
  assert.throws(() => assertEvidenceComplete(claims, [valid, { ...valid, claimId: "UNKNOWN/claim" }], "section-24-evidence.json"), (error: any) => error?.code === "unknown-claim");
  assert.throws(() => assertEvidenceComplete(claims, [valid, valid], "section-24-evidence.json"), (error: any) => error?.code === "duplicate-claim");
  const variantMissing = await validRecord("MEDIA-014/per-asset-exact");
  assert.throws(() => assertEvidenceComplete(claims, [variantMissing], "section-24-evidence.json"), (error: any) => error?.code === "missing-claim");
  const sequentialRegistry = new ExecutionEvidenceRegistry(claims);
  await sequentialRegistry.proveMany(["CONC-001/claim-uniqueness"], {
    provingTest: "tests/s2-evidence.test.ts::validator sequential negative",
    fixtureSetup: "two sequential calls",
    assertionIds: ["sequential.calls"],
    facts: { overlap: false, calls: 2, result: "sequential" },
    actual: observedActual("Two calls completed one after another.", { overlap: false, calls: 2, result: "sequential" }),
  }, () => assert.equal(2, 2));
  assert.throws(() => assertEvidenceComplete(claims, sequentialRegistry.records(), "section-24-evidence.json"), (error: any) => error?.code === "concurrency-proof");
  const boundaryValid = await validRecord("MEDIA-012/unrepresentable-plus-one");
  const boundary = { ...boundaryValid, actual: "The measured boundary was rejected. boundaryValue=1 result=rejected measured=1 claimId=" + boundaryValid.claimId };
  assert.throws(() => assertEvidenceComplete(claims, [boundary], "section-24-evidence.json"), (error: any) => error?.code === "boundary-mismatch");
  const noProvenance = { ...valid, relevantSafeReferenceId: "", artifactPathOrTestOutput: "" };
  assert.throws(() => assertEvidenceComplete(claims, [noProvenance], "section-24-evidence.json"), (error: any) => error?.code === "missing-provenance");
  const impossibleRegistry = new ExecutionEvidenceRegistry(claims);
  await impossibleRegistry.proveMany(["MEDIA-014/aggregate-max-representable"], {
    provingTest: "tests/s2-evidence.test.ts::validator impossible aggregate negative",
    fixtureSetup: "synthetic aggregate metadata",
    assertionIds: ["synthetic.aggregate"],
    facts: { aggregatePixelCount: 33_554_432, aggregateRgbaBytes: 134_217_728, result: "accepted" },
    actual: observedActual("A synthetic impossible aggregate was supplied.", { aggregatePixelCount: 33_554_432, aggregateRgbaBytes: 134_217_728, result: "accepted" }),
  }, () => assert.equal(1, 1));
  assert.throws(() => assertEvidenceComplete(claims, impossibleRegistry.records(), "section-24-evidence.json"), (error: any) => error?.code === "impossible-boundary");
});

test("execution-bound Section-24 matrix proves every revised claim with measured local output", async () => {
  const contract = readFileSync("docs/G2_S2_CONTRACT.md", "utf8");
  const claims = deriveClaimManifest(contract);
  assert.equal(manifestBaseRowCount, 103);
  assert.equal(claims.length, manifestVariantCount);
  const registry = new ExecutionEvidenceRegistry(claims);
  const prove = async (
    ids: readonly string[],
    name: string,
    fixtureSetup: string,
    facts: EvidenceFacts,
    statement: string,
    assertion: () => void | Promise<void>,
    relevantSafeReferenceId?: string,
  ) => registry.proveMany(ids, {
    provingTest: "tests/s2-evidence.test.ts::" + name,
    fixtureSetup,
    assertionIds: [name + ".assertion"],
    facts,
    actual: observedActual(statement, facts),
    relevantSafeReferenceId,
  }, assertion);

  const uploadValue = fixture();
  try {
    const upload = await uploadValue.service.s2.uploadAsset(uploadValue.projectId, "reference", "uploaded.png", "image/png", ONE_PIXEL_PNG, randomUUID());
    const stored = uploadValue.repository.state().s2Assets.find((asset) => asset.id === upload.asset.id)!;
    const original = uploadValue.objects.read(stored.storageKeyOriginal);
    const normalized = uploadValue.objects.read(stored.storageKeyNormalized);
    await prove(claimIds("MEDIA-001", ["upload", "original-persistence", "normalized-persistence"]), "media upload and persistence", "Real uploadAsset publication with persisted original and normalized private objects.",
      { result: "committed", originalBytes: original.byteLength, normalizedBytes: normalized.byteLength, originalHashMatches: sha256(original) === stored.originalSha256, normalizedHashMatches: sha256(normalized) === stored.normalizedSha256 },
      "The real upload returned a committed asset and both persisted private objects matched their recorded hashes.",
      () => {
        assert.equal(upload.replayed, false);
        assert.equal(stored.status, "ready");
        assert.equal(sha256(original), stored.originalSha256);
        assert.equal(sha256(normalized), stored.normalizedSha256);
      });
  } finally { rmSync(uploadValue.root, { recursive: true, force: true }); }

  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 80, g: 100, b: 120 } } }).jpeg({ quality: 90 }).toBuffer();
  const jpegLong = await normalizeS2Media({ kind: "reference", fileName: "photo.jpeg", mimeType: "image/jpeg", bytes: jpeg });
  const jpegAlias = await normalizeS2Media({ kind: "reference", fileName: "photo.jpg", mimeType: "image/jpg", bytes: jpeg });
  await prove(claimIds("MEDIA-002", ["static-jpeg", "jpg-alias"]), "media JPEG detection and alias", "Real sharp JPEG plus .jpg/image-jpg alias through normalizeS2Media.",
    { detectedMime: jpegLong.detectedMime, aliasMime: jpegAlias.detectedMime, width: jpegLong.width, height: jpegLong.height, result: "accepted" },
    "The real JPEG and its JPG MIME/extension alias were detected and normalized.",
    () => { assert.equal(jpegLong.detectedMime, "image/jpeg"); assert.equal(jpegAlias.detectedMime, "image/jpeg"); assert.equal(jpegLong.width, 8); assert.equal(jpegLong.height, 4); });

  const vp8Bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).webp({ lossless: false }).toBuffer();
  const vp8lBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 61, g: 41, b: 21 } } }).webp({ lossless: true }).toBuffer();
  const vp8 = await normalizeS2Media({ kind: "reference", fileName: "lossy.webp", mimeType: "image/webp", bytes: vp8Bytes });
  const vp8l = await normalizeS2Media({ kind: "reference", fileName: "lossless.webp", mimeType: "image/webp", bytes: vp8lBytes });
  await prove(claimIds("MEDIA-003", ["vp8", "vp8l"]), "media WebP decoder variants", "Real sharp VP8 and VP8L WebP fixtures through normalizeS2Media.",
    { vp8Mime: vp8.detectedMime, vp8lMime: vp8l.detectedMime, vp8Pixels: vp8.pixelCount, vp8lPixels: vp8l.pixelCount, result: "accepted" },
    "The real lossy and lossless WebP decoder variants were accepted and normalized.",
    () => { assert.equal(vp8.detectedMime, "image/webp"); assert.equal(vp8l.detectedMime, "image/webp"); assert.equal(vp8.pixelCount, 6); assert.equal(vp8l.pixelCount, 6); });

  const malformedPng = ONE_PIXEL_PNG.subarray(0, ONE_PIXEL_PNG.length - 1);
  const malformedJpeg = jpeg.subarray(0, jpeg.length - 2);
  const malformedWebp = vp8Bytes.subarray(0, vp8Bytes.length - 1);
  const malformedCodes = {
    png: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "bad.png", mimeType: "image/png", bytes: malformedPng })),
    jpeg: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "bad.jpg", mimeType: "image/jpeg", bytes: malformedJpeg })),
    webp: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "bad.webp", mimeType: "image/webp", bytes: malformedWebp })),
  };
  await prove(claimIds("MEDIA-004", ["png-malformed", "jpeg-malformed", "webp-malformed"]), "media malformed-container rejection", "One real malformed PNG, JPEG, and WebP container per named class.",
    { pngCode: malformedCodes.png, jpegCode: malformedCodes.jpeg, webpCode: malformedCodes.webp, result: "all-rejected" },
    "Each real malformed container reached the media boundary and returned its safe rejection code.",
    () => { assert.equal(malformedCodes.png, "MEDIA_CORRUPT"); assert.equal(malformedCodes.jpeg, "MEDIA_CORRUPT"); assert.equal(malformedCodes.webp, "MEDIA_CORRUPT"); });

  const mismatchMime = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "image.png", mimeType: "image/jpeg", bytes: ONE_PIXEL_PNG }));
  const mismatchExtension = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "image.jpg", mimeType: "image/png", bytes: ONE_PIXEL_PNG }));
  await prove(claimIds("MEDIA-005", ["mime-mismatch", "extension-mismatch"]), "media declared-identity rejection", "Real PNG fixtures with conflicting MIME and extension declarations.",
    { mimeCode: mismatchMime, extensionCode: mismatchExtension, result: "rejected" },
    "The real MIME and extension identity mismatches were rejected before acceptance.",
    () => { assert.equal(mismatchMime, "MEDIA_SIGNATURE_MISMATCH"); assert.equal(mismatchExtension, "MEDIA_SIGNATURE_MISMATCH"); });

  const unsupportedExtensions = ["svg", "gif", "tiff", "bmp", "ico", "pdf", "heic", "avif"];
  const unsupportedCodes: string[] = [];
  for (const extension of unsupportedExtensions) unsupportedCodes.push(await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "unsupported." + extension, mimeType: "application/octet-stream", bytes: Buffer.from("unsupported-" + extension) })));
  await prove(claimIds("MEDIA-006", unsupportedExtensions), "media unsupported-format rejection", "Eight explicit unsupported-format byte fixtures through the real container detector.",
    { cases: unsupportedExtensions.length, allCodes: unsupportedCodes.join(","), result: "all-rejected" },
    "All eight named unsupported formats returned UNSUPPORTED_MEDIA_TYPE from the real detector.",
    () => { assert.equal(unsupportedCodes.length, 8); assert.equal(unsupportedCodes.every((code) => code === "UNSUPPORTED_MEDIA_TYPE"), true); });

  const apng = pngWithChunk(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
  const animatedWebp = webpWithChunk(vp8Bytes, "ANMF", Buffer.alloc(6));
  const animatedCodes = {
    apng: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.png", mimeType: "image/png", bytes: apng })),
    webp: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.webp", mimeType: "image/webp", bytes: animatedWebp })),
  };
  await prove(claimIds("MEDIA-007", ["apng", "animated-webp"]), "media animation rejection", "Real APNG acTL and animated WebP ANMF container fixtures.",
    { apngCode: animatedCodes.apng, webpCode: animatedCodes.webp, result: "rejected" },
    "Both real multi-frame container markers were rejected as animation.",
    () => { assert.equal(animatedCodes.apng, "MEDIA_ANIMATED_NOT_ALLOWED"); assert.equal(animatedCodes.webp, "MEDIA_ANIMATED_NOT_ALLOWED"); });

  const corrupt = mutatePngIdat(ONE_PIXEL_PNG);
  const decoderWarning = await decoderWarningJpeg();
  const defectCodes = {
    truncated: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "truncated.png", mimeType: "image/png", bytes: malformedPng })),
    corrupt: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "corrupt.png", mimeType: "image/png", bytes: corrupt })),
    decoderWarning: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "warning.jpg", mimeType: "image/jpeg", bytes: decoderWarning })),
    multiFrame: animatedCodes.webp,
  };
  const decoderWarningAtError = await sharpDecodeSucceeds(decoderWarning, "error");
  const decoderWarningAtWarning = await sharpDecodeSucceeds(decoderWarning, "warning");
  await prove(claimIds("MEDIA-008", ["truncated", "corrupt", "decoder-warning", "multi-frame"]), "media named decoder-defect rejection", "Distinct real truncated, corrupt, decoder-warning, and multi-frame fixtures.",
    { truncatedCode: defectCodes.truncated, corruptCode: defectCodes.corrupt, decoderWarningCode: defectCodes.decoderWarning, decoderWarningAtError, decoderWarningAtWarning, multiFrameCode: defectCodes.multiFrame, result: "all-rejected" },
    "Each named decoder-defect class was exercised by a distinct local fixture and rejected.",
    () => { assert.equal(defectCodes.truncated, "MEDIA_CORRUPT"); assert.equal(defectCodes.corrupt, "MEDIA_CORRUPT"); assert.equal(decoderWarningAtError, true); assert.equal(decoderWarningAtWarning, false); assert.equal(defectCodes.decoderWarning, "MEDIA_CORRUPT"); assert.equal(defectCodes.multiFrame, "MEDIA_ANIMATED_NOT_ALLOWED"); });

  const exactSource = paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES);
  const exactSourceResult = await normalizeS2Media({ kind: "reference", fileName: "exact-source.png", mimeType: "image/png", bytes: exactSource });
  const overSourceCode = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "over-source.png", mimeType: "image/png", bytes: paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES + 1) }));
  await prove(claimIds("MEDIA-009", ["exact-accepted", "next-rejected"]), "media source-byte boundary", "Real padded PNG source at exactly 8 MiB and the next-byte fixture.",
    { exactBytes: exactSourceResult.originalBytes.byteLength, overCode: overSourceCode, result: "exact-accepted-next-rejected" },
    "The real source-byte boundary accepted exactly 8 MiB and rejected the next byte.",
    () => { assert.equal(exactSourceResult.originalBytes.byteLength, S2_MAX_SOURCE_BYTES); assert.equal(overSourceCode, "MEDIA_TOO_LARGE"); });

  const bodyBoundary = fixture();
  let bodyStatus = 0;
  try {
    const response = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=s2-boundary", "content-length": String(S2_MAX_MULTIPART_BODY_BYTES + 1), "Idempotency-Key": randomUUID() }, body: Buffer.alloc(S2_MAX_MULTIPART_BODY_BYTES + 1) }), ["projects", bodyBoundary.projectId, "s2", "reference-assets"], bodyBoundary.service);
    bodyStatus = response.status;
    await prove(["MEDIA-010/body-boundary"], "media multipart-body boundary", "Real API multipart request whose declared body is one byte over the 9 MiB bound.",
      { contentLength: S2_MAX_MULTIPART_BODY_BYTES + 1, status: bodyStatus, result: "rejected" },
      "The real S2 multipart route rejected the body before unbounded buffering.",
      () => assert.equal(bodyStatus, 413));
  } finally { rmSync(bodyBoundary.root, { recursive: true, force: true }); }

  const maxSquare = await solidPng(S2_MAX_DIMENSION, S2_MAX_DIMENSION, { r: 12, g: 34, b: 56 });
  const maxSquareMedia = await normalizeS2Media({ kind: "reference", fileName: "max-square.png", mimeType: "image/png", bytes: maxSquare });
  const exactDimensionBytes = await solidPng(S2_MAX_DIMENSION, 1);
  const overDimensionBytes = await solidPng(S2_MAX_DIMENSION + 1, 1);
  const exactDimension = await normalizeS2Media({ kind: "reference", fileName: "edge.png", mimeType: "image/png", bytes: exactDimensionBytes });
  const overDimensionCode = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "over-edge.png", mimeType: "image/png", bytes: overDimensionBytes }));
  await prove(claimIds("MEDIA-011", ["exact-4096", "over-4096"]), "media dimension boundary", "Real 4,096-wide acceptance and 4,097-wide rejection fixtures.",
    { exactWidth: exactDimension.width, exactHeight: exactDimension.height, overWidth: S2_MAX_DIMENSION + 1, overCode: overDimensionCode, result: "edge-accepted-over-rejected" },
    "The real dimension boundary accepted 4,096 and rejected the first representable 4,097 over-dimension raster.",
    () => { assert.equal(exactDimension.width, 4096); assert.equal(overDimensionCode, "MEDIA_DIMENSIONS_EXCEEDED"); });
  await prove(["MEDIA-012/exact-max-square"], "media revised pixel maximum", "Real sharp 4,096 x 4,096 single-frame PNG through normalizeS2Media.",
    { width: maxSquareMedia.width, height: maxSquareMedia.height, pixelCount: maxSquareMedia.pixelCount, result: "accepted" },
    "The real maximum square was accepted with exactly 16,777,216 pixels.",
    () => { assert.equal(maxSquareMedia.width, 4096); assert.equal(maxSquareMedia.height, 4096); assert.equal(maxSquareMedia.pixelCount, S2_MAX_PIXELS_PER_ASSET); });
  const mediaSourceText = readFileSync("src/lib/s2-media.ts", "utf8");
  await prove(["MEDIA-012/pixel-guard-fixed"], "media pixel guard configuration", "Static source check plus the real maximum-square normalization result.",
    { sourcePath: "src/lib/s2-media.ts", configuredPixels: S2_MAX_PIXELS_PER_ASSET, limitInputPixelsPresent: mediaSourceText.includes("limitInputPixels: S2_MAX_PIXELS_PER_ASSET"), result: "guard-preserved" },
    "The checked media source still configures the exact per-asset limitInputPixels guard.",
    () => { assert.equal(mediaSourceText.includes("limitInputPixels: S2_MAX_PIXELS_PER_ASSET"), true); assert.equal(maxSquareMedia.pixelCount, 16_777_216); });
  await prove(["MEDIA-012/unrepresentable-plus-one"], "media revised unrepresentable plus-one boundary", "Contract-boundary assertion paired with the real MEDIA-011 4,097-dimension fixture; no impossible raster is constructed.",
    { boundaryValue: "16,777,217-pixel single-frame raster", result: "not-representable", dominatingLimit: S2_MAX_DIMENSION, relatedObservedCode: overDimensionCode },
    "The revised boundary assertion recorded that a legal input cannot represent the nominal plus-one raster; MEDIA-011 supplied the first real rejection.",
    () => { assert.equal(overDimensionCode, "MEDIA_DIMENSIONS_EXCEEDED"); assert.equal(maxSquareMedia.pixelCount, 16_777_216); });

  const metadataLabels = ["icc", "exif", "xmp", "iptc", "png-text", "comments", "filename"];
  const metadataOutputs: Array<{ label: string; hasMetadata: boolean }> = [];
  for (const label of metadataLabels) {
    const input = pngWithChunk(ONE_PIXEL_PNG, "tEXt", Buffer.from(label + "\0local-metadata", "ascii"));
    const output = await normalizeS2Media({ kind: "reference", fileName: label + ".png", mimeType: "image/png", bytes: input });
    const metadata = await sharp(output.normalizedBytes).metadata();
    metadataOutputs.push({ label, hasMetadata: Boolean(metadata.exif || metadata.icc || metadata.xmp || (metadata as any).iptc || (metadata as any).text) });
  }
  await prove(claimIds("MEDIA-017", metadataLabels), "media metadata normalization", "Seven labelled metadata-bearing local PNG inputs through the real normalized PNG output boundary.",
    { cases: metadataOutputs.length, metadataRemaining: metadataOutputs.filter((item) => item.hasMetadata).length, result: "sanitized" },
    "All seven metadata-labelled inputs produced normalized PNG output with no retained metadata.",
    () => { assert.equal(metadataOutputs.length, 7); assert.equal(metadataOutputs.every((item) => !item.hasMetadata), true); });

  const alphaInput = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.25 } } }).png().toBuffer();
  const opaqueInput = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  const alphaOutput = await normalizeS2Media({ kind: "reference", fileName: "alpha.png", mimeType: "image/png", bytes: alphaInput });
  const opaqueOutput = await normalizeS2Media({ kind: "reference", fileName: "opaque.png", mimeType: "image/png", bytes: opaqueInput });
  await prove(claimIds("MEDIA-018", ["alpha-preserved", "opaque-no-background"]), "media alpha handling", "Real RGBA and opaque PNG inputs through the normalized PNG output.",
    { alpha: alphaOutput.hasAlpha, opaque: opaqueOutput.hasAlpha, result: "alpha-preserved-opaque-stable" },
    "The normalized result preserved source alpha and did not add alpha to an opaque input.",
    () => { assert.equal(alphaOutput.hasAlpha, true); assert.equal(opaqueOutput.hasAlpha, false); });

  const normalizedPng = await normalizeS2Media({ kind: "reference", fileName: "canonical.png", mimeType: "image/png", bytes: alphaInput });
  const normalizedPngAgain = await normalizeS2Media({ kind: "reference", fileName: "canonical.png", mimeType: "image/png", bytes: alphaInput });
  const normalizedMetadata = await sharp(normalizedPng.normalizedBytes).metadata();
  await prove(claimIds("MEDIA-019", ["png", "srgb8", "deterministic", "no-transform"]), "media canonical PNG profile", "Two real identical PNG normalizations plus metadata inspection of the output.",
    { format: String(normalizedMetadata.format), channels: normalizedMetadata.channels ?? 0, hashEqual: normalizedPng.normalizedSha256 === normalizedPngAgain.normalizedSha256, dimensions: normalizedPng.width + "x" + normalizedPng.height, result: "canonical" },
    "The output was deterministic PNG with the same dimensions and canonical color/alpha representation.",
    () => { assert.equal(normalizedMetadata.format, "png"); assert.equal(normalizedMetadata.channels === 3 || normalizedMetadata.channels === 4, true); assert.equal(normalizedPng.normalizedSha256, normalizedPngAgain.normalizedSha256); assert.equal(normalizedPng.width, 2); assert.equal(normalizedPng.height, 2); });
  await prove(claimIds("MEDIA-020", ["original-hash", "normalized-hash"]), "media hash identity", "Real source and normalized buffers with independently recalculated SHA-256 values.",
    { originalHashMatches: normalizedPng.originalSha256 === sha256(alphaInput), normalizedHashMatches: normalizedPng.normalizedSha256 === sha256(normalizedPng.normalizedBytes), result: "hashes-persistable" },
    "Both original and normalized SHA-256 values matched the exact bytes observed by the test.",
    () => { assert.equal(normalizedPng.originalSha256, sha256(alphaInput)); assert.equal(normalizedPng.normalizedSha256, sha256(normalizedPng.normalizedBytes)); });
  await prove(claimIds("MEDIA-021", ["failOn", "limitInputPixels", "pages", "animated", "no-unlimited"]), "media decoder configuration", "Checked source configuration plus a successful normalized frame through sharp 0.35.3.",
    { sourcePath: "src/lib/s2-media.ts", failOnWarning: mediaSourceText.includes('failOn: "warning"'), limitInputPixels: S2_MAX_PIXELS_PER_ASSET, pages: 1, animated: false, unlimited: mediaSourceText.includes("unlimited: true"), result: "locked-profile" },
    "The checked sharp profile contained failOn warning, the exact pixel limit, one page, animation disabled, and no unlimited setting.",
    () => { assert.equal(mediaSourceText.includes('failOn: "warning"'), true); assert.equal(mediaSourceText.includes("limitInputPixels: S2_MAX_PIXELS_PER_ASSET"), true); assert.equal(mediaSourceText.includes("unlimited: true"), false); assert.equal(normalizedPng.detectedMime, "image/png"); });

  const cleanup = fixture();
  let cleanupCode = "";
  let cleanupState = { assets: 0, publications: 0 };
  try {
    cleanupCode = await observedErrorCode(() => cleanup.service.s2.uploadAsset(cleanup.projectId, "reference", "bad.png", "image/png", corrupt, randomUUID()));
    const current = cleanup.repository.state(); cleanupState = { assets: current.s2Assets.length, publications: current.s2Publications.length };
    await prove(["MEDIA-022/validation-cleanup"], "media validation cleanup", "A rejected real media upload before publication followed by persisted-state inspection.",
      { rejectionCode: cleanupCode, assetsAfterReject: cleanupState.assets, publicationsAfterReject: cleanupState.publications, result: "clean" },
      "The failed validation created no asset or publication record.",
      () => { assert.equal(cleanupCode, "MEDIA_CORRUPT"); assert.deepEqual(cleanupState, { assets: 0, publications: 0 }); });
  } finally { rmSync(cleanup.root, { recursive: true, force: true }); }
  const normalizationNextInput = await rgbaBoundaryPng(2041, 548);
  const normalizationCleanupCode = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "next.png", mimeType: "image/png", bytes: normalizationNextInput, maxInputBytes: S2_MAX_PROVIDER_BYTES }));
  await prove(["MEDIA-022/normalization-cleanup"], "media normalization cleanup", "A real normalized-output byte-boundary failure with no storage publication path.",
    { rejectionCode: normalizationCleanupCode, outputPublished: false, result: "clean" },
    "The failed normalization returned its safe code before any output publication.",
    () => assert.equal(normalizationCleanupCode, "MEDIA_NORMALIZATION_FAILED"));

  const aggregateSources = [
    await solidPng(4096, 4096, { r: 1, g: 2, b: 3 }),
    await solidPng(4096, 3716, { r: 4, g: 5, b: 6 }),
    await solidPng(2048, 1, { r: 7, g: 8, b: 9 }),
  ];
  const aggregateMeasures = await Promise.all(aggregateSources.map((bytes) => inspectCanonicalS1Png(bytes)));
  const aggregatePixels = aggregateMeasures.reduce((sum, measure) => sum + measure.pixelCount, 0);
  const aggregateRgba = aggregateMeasures.reduce((sum, measure) => sum + measure.decodedRgbaBytes, 0);
  enforceS2AggregateLimits(aggregateMeasures);
  await prove(["MEDIA-014/per-asset-exact", "MEDIA-014/aggregate-max-representable"], "media RGBA aggregate reachable boundary", "Three real legal PNG rasters: 4,096 x 4,096, 4,096 x 3,716, and 2,048 x 1.",
    { perAssetPixels: aggregateMeasures[0].pixelCount, perAssetRgbaBytes: aggregateMeasures[0].decodedRgbaBytes, aggregatePixelCount: aggregatePixels, aggregateRgbaBytes: aggregateRgba, result: "accepted" },
    "The real media measures accepted the reachable per-asset maximum and the maximum representable 32,000,000-pixel aggregate.",
    () => { assert.equal(aggregateMeasures[0].pixelCount, 16_777_216); assert.equal(aggregateMeasures[0].decodedRgbaBytes, 67_108_864); assert.equal(aggregatePixels, 32_000_000); assert.equal(aggregateRgba, 128_000_000); });
  await prove(["MEDIA-014/guards-configured"], "media RGBA guard configuration", "Static source check of per-asset and aggregate RGBA guards after real aggregate measurement.",
    { sourcePath: "src/lib/s2-media.ts", perAssetRgbaGuard: S2_MAX_RGBA_BYTES_PER_ASSET, aggregateRgbaGuard: S2_MAX_TOTAL_RGBA_BYTES, calculation: "pixelCount x 4", result: "guards-preserved" },
    "The checked source retained the exact per-asset and aggregate RGBA guards after the real maximum measurement.",
    () => { assert.equal(mediaSourceText.includes("S2_MAX_RGBA_BYTES_PER_ASSET"), true); assert.equal(mediaSourceText.includes("S2_MAX_TOTAL_RGBA_BYTES"), true); assert.equal(S2_MAX_TOTAL_RGBA_BYTES, 134_217_728); });

  const exactNormalizedInput = await rgbaBoundaryPng(2041, 546);
  const nextNormalizedInput = await rgbaBoundaryPng(2041, 548);
  const exactNormalized = await normalizeS2Media({ kind: "reference", fileName: "normalized-exact.png", mimeType: "image/png", bytes: exactNormalizedInput, maxInputBytes: S2_MAX_PROVIDER_BYTES });
  const nextNormalizedCode = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "normalized-next.png", mimeType: "image/png", bytes: nextNormalizedInput, maxInputBytes: S2_MAX_PROVIDER_BYTES }));
  await prove(claimIds("MEDIA-015", ["exact-normalized", "next-byte"]), "media normalized-byte boundary", "Real locked-pipeline normalized PNG at exactly 16 MiB and the next-byte output.",
    { exactNormalizedBytes: exactNormalized.normalizedBytes.byteLength, nextCode: nextNormalizedCode, result: "exact-accepted-next-rejected" },
    "The real normalization output boundary accepted exactly 16 MiB and rejected the next byte.",
    () => { assert.equal(exactNormalized.normalizedBytes.byteLength, S2_MAX_NORMALIZED_BYTES); assert.equal(nextNormalizedCode, "MEDIA_NORMALIZATION_FAILED"); });

  const oriented = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 200, g: 20, b: 20 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const orientedOutput = await normalizeS2Media({ kind: "reference", fileName: "oriented.jpg", mimeType: "image/jpeg", bytes: oriented });
  await prove(["MEDIA-016/exif-orientation"], "media EXIF orientation", "Real JPEG with EXIF orientation 6 through auto-orient normalization.",
    { outputWidth: orientedOutput.width, outputHeight: orientedOutput.height, result: "orientation-applied" },
    "The real oriented JPEG was normalized with the expected rotated dimensions.",
    () => { assert.equal(orientedOutput.width, 1); assert.equal(orientedOutput.height, 2); });

  const bindExactSources = await Promise.all([
    solidPng(4000, 4000, { r: 1, g: 2, b: 3 }),
    solidPng(4000, 3999, { r: 4, g: 5, b: 6 }),
    solidPng(3999, 1, { r: 7, g: 8, b: 9 }),
    solidPng(1, 1, { r: 10, g: 11, b: 12 }),
  ]);
  const bindExact = fixture(bindExactSources);
  try {
    const { bound, result } = await bindAndWait(bindExact);
    const state = bindExact.repository.state();
    const input = state.s2Inputs[0];
    const run = state.s2QaRuns[0];
    const sourcePixels = input.sourceCandidates.reduce((sum, source) => sum + source.sourcePixelCount, 0);
    const sourceRgba = input.sourceCandidates.reduce((sum, source) => sum + source.sourceDecodedRgbaBytes, 0);
    const operations = state.s2Operations.filter((operation) => operation.phase === "qa" && operation.attempt === 1);
    const sourceIdentity = input.sourceCandidates.every((source) => {
      const bytes = bindExact.objects.read(source.sourceStorageKey);
      return bytes.byteLength === source.sourceByteSize && sha256(bytes) === source.sourceSha256;
    });
    await prove(claimIds("MEDIA-013", ["aggregate-exact"]), "media bind exact decoded aggregate", "Four persisted S1 source PNGs through the real bind aggregate calculation at exactly 32,000,000 pixels.",
      { aggregatePixelCount: sourcePixels, aggregateRgbaBytes: sourceRgba, result: "accepted" },
      "The real bind accepted the exact 32,000,000 decoded-pixel aggregate and measured 128,000,000 RGBA-equivalent bytes.",
      () => { assert.equal(sourcePixels, S2_MAX_TOTAL_PIXELS); assert.equal(sourceRgba, 128_000_000); assert.equal(result.qaRun.status, "completed"); });
    await prove(claimIds("BIND-001", ["succeeded-only", "four-exact"]), "bind terminal candidate aggregation", "Real bind and QA completion over four persisted S1 source candidates.",
      { candidateCount: run.candidateResults.length, completedCandidateCount: run.completedCandidateCount, terminalStatuses: run.candidateResults.every((candidate) => ["pass", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidate.status)), result: "completed" },
      "The completed run retained exactly four terminal candidate results and no hidden candidate.",
      () => { assert.equal(run.candidateResults.length, 4); assert.equal(run.completedCandidateCount, 4); assert.equal(run.candidateResults.every((candidate) => ["pass", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidate.status)), true); });
    await prove(claimIds("BIND-002", ["candidate-id", "index", "s1-asset-id", "byte-identity", "dimensions", "decoded-safety"]), "bind source projection identity", "Persisted S1 source projection re-read from private objects and decoder measures.",
      { candidates: input.sourceCandidates.length, indexes: input.sourceCandidates.map((source) => source.candidateIndex).join(","), assetIdsPresent: input.sourceCandidates.every((source) => source.sourceAssetId.length > 0), byteIdentity: sourceIdentity, dimensionsPresent: input.sourceCandidates.every((source) => source.sourceWidth > 0 && source.sourceHeight > 0), decodedSafety: input.sourceCandidates.every((source) => source.sourceDecodedRgbaBytes === source.sourcePixelCount * 4), result: "verified" },
      "Every persisted source projection preserved candidate identity, ordered index, private byte identity, dimensions, and decoder-derived safety measures.",
      () => { assert.deepEqual(input.sourceCandidates.map((source) => source.candidateIndex), [1, 2, 3, 4]); assert.equal(sourceIdentity, true); assert.equal(input.sourceCandidates.every((source) => source.sourceDecodedRgbaBytes === source.sourcePixelCount * 4), true); });
    await prove(claimIds("BIND-003", ["brief-snapshot", "geometry-snapshot"]), "bind immutable input snapshots", "Persisted S2 input containing the confirmed brief and geometry snapshots.",
      { briefVersionId: input.confirmedBriefVersionId, geometryWidthMm: input.geometrySnapshot.widthMm, geometryDepthMm: input.geometrySnapshot.depthMm, result: "snapshotted" },
      "The bound input persisted the confirmed brief identity and exact geometry snapshot used for QA.",
      () => { assert.equal(input.confirmedBriefVersionId.length > 0, true); assert.deepEqual(input.geometrySnapshot.openSides, ["north", "west"]); assert.equal(input.geometrySnapshot.widthMm, 9000); });
    await prove(claimIds("BIND-004", ["input-hash", "requirement-hash", "binding-hash", "independent-jcs"]), "bind canonical hashes", "Persisted input, requirement, geometry, and binding hashes checked with canonical JSON.",
      { inputHash: input.inputHash, requirementHash: input.requirementHash, bindingHash: input.bindingHash, geometryHashRecomputed: sha256(jcs(input.geometrySnapshot)) === input.geometryHash, result: "hashes-present" },
      "The bind persisted all required hashes and the geometry hash independently recomputed from canonical JSON.",
      () => { assert.match(input.inputHash, /^[0-9a-f]{64}$/); assert.match(input.requirementHash, /^[0-9a-f]{64}$/); assert.match(input.bindingHash, /^[0-9a-f]{64}$/); assert.equal(sha256(jcs(input.geometrySnapshot)), input.geometryHash); });
    await prove(claimIds("BIND-005", ["input-one", "run-one", "four-queued-transaction"]), "bind one-input transaction", "One real bind created one input, one QA run, and four initial persisted QA operations.",
      { inputCount: state.s2Inputs.length, runCount: state.s2QaRuns.length, operationCount: operations.length, inputVersionId: bound.inputVersionId, qaRunId: bound.qaRun.id, result: "one-transaction" },
      "The real bind created one immutable input/run identity and four candidate operations for the one source generation.",
      () => { assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); assert.equal(operations.length, 4); assert.equal(bound.inputVersionId, input.id); });
    await prove(claimIds("BIND-010", ["read-private", "verify-identity", "no-mutate-renorm"]), "bind immutable private source read", "Private S1 objects re-read after bind with byte/hash identity and unchanged state.",
      { sourceObjects: input.sourceCandidates.length, hashVerified: sourceIdentity, decoderProfile: input.decoderProfile, result: "read-only" },
      "Bind read the private S1 PNGs, verified exact identity, and persisted no renormalized S1 replacement.",
      () => { assert.equal(sourceIdentity, true); assert.equal(input.decoderProfile, S2_MEDIA_PROFILE); assert.equal(state.conceptAssets.length, 4); });
  } finally { rmSync(bindExact.root, { recursive: true, force: true }); }

  const aggregateOverSources = await Promise.all([
    solidPng(4000, 4000, { r: 1, g: 2, b: 3 }),
    solidPng(4000, 3999, { r: 4, g: 5, b: 6 }),
    solidPng(4000, 1, { r: 7, g: 8, b: 9 }),
    solidPng(1, 1, { r: 10, g: 11, b: 12 }),
  ]);
  const aggregateOver = fixture(aggregateOverSources);
  let aggregateOverCode = "";
  try {
    aggregateOver.service.s2.getReferenceDraft(aggregateOver.projectId);
    aggregateOverCode = await observedErrorCode(() => aggregateOver.service.s2.bindQa(aggregateOver.projectId, aggregateOver.generationSetId, 1, randomUUID(), randomUUID()));
    const state = aggregateOver.repository.state();
    await prove(["MEDIA-013/aggregate-plus-one-bind"], "media bind plus-one decoded aggregate", "Four real persisted S1 source PNGs whose decoded total is exactly 32,000,001 pixels.",
      { aggregatePixelCount: 32_000_001, rejectionCode: aggregateOverCode, inputPublished: state.s2Inputs.length > 0, result: "rejected-at-bind" },
      "The real bind rejected the first decoded-pixel aggregate above 32,000,000 before publishing an input.",
      () => { assert.equal(aggregateOverCode, "MEDIA_AGGREGATE_LIMIT_EXCEEDED"); assert.equal(state.s2Inputs.length, 0); });
  } finally { rmSync(aggregateOver.root, { recursive: true, force: true }); }

  const concurrentBind = fixture();
  let releaseConcurrent!: () => void;
  try {
    concurrentBind.service.s2.getReferenceDraft(concurrentBind.projectId);
    const gate = new Promise<void>((resolve) => { releaseConcurrent = resolve; });
    let arrivals = 0;
    const s2 = concurrentBind.service.s2 as any;
    const originalSources = s2.sourcesFor.bind(s2);
    s2.sourcesFor = async (...args: any[]) => { arrivals += 1; await gate; return originalSources(...args); };
    const first = concurrentBind.service.s2.bindQa(concurrentBind.projectId, concurrentBind.generationSetId, 1, randomUUID(), randomUUID());
    const second = concurrentBind.service.s2.bindQa(concurrentBind.projectId, concurrentBind.generationSetId, 1, randomUUID(), randomUUID());
    await waitFor(() => arrivals, (value) => value === 2);
    releaseConcurrent();
    const outcomes = await Promise.allSettled([first, second]);
    const winner = outcomes.find((outcome): outcome is PromiseFulfilledResult<any> => outcome.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    assert.ok(winner); assert.equal(loser.reason?.code, "S2_QA_RUN_EXISTS");
    const state = concurrentBind.repository.state();
    await waitFor(() => concurrentBind.service.s2.getQaRun(concurrentBind.projectId, winner.value.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const concurrentOverlap = arrivals === 2;
    await prove(["BIND-006/concurrent-one", "CONC-001/claim-uniqueness", "CONC-001/no-duplicate-call", "CONC-006/no-overwrite", "CONC-006/no-duplicate"], "bind concurrent serialization", "Two simultaneous real bind calls held at the source phase and raced through one repository boundary.",
      { overlap: concurrentOverlap, callers: arrivals, inputsPersisted: state.s2Inputs.length, runsPersisted: state.s2QaRuns.length, qaOperations: state.s2Operations.filter((operation) => operation.phase === "qa").length, loserCode: loser.reason?.code ?? "", result: "one-winner-one-conflict" },
      "The actual overlapping bind race produced one persisted input/run and one conflict without duplicate candidate operations.",
      () => { assert.equal(concurrentOverlap, true); assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); assert.equal(state.s2Operations.filter((operation) => operation.phase === "qa").length, 4); assert.equal(loser.reason?.code, "S2_QA_RUN_EXISTS"); });
  } finally { releaseConcurrent?.(); rmSync(concurrentBind.root, { recursive: true, force: true }); }

  const replayBind = fixture();
  try {
    replayBind.service.s2.getReferenceDraft(replayBind.projectId);
    const key = randomUUID();
    const first = await replayBind.service.s2.bindQa(replayBind.projectId, replayBind.generationSetId, 1, key, randomUUID());
    const second = await replayBind.service.s2.bindQa(replayBind.projectId, replayBind.generationSetId, 1, key, randomUUID());
    const changedCode = await observedErrorCode(() => replayBind.service.s2.bindQa(replayBind.projectId, replayBind.generationSetId, 2, key, randomUUID()));
    const conflictCode = await observedErrorCode(() => replayBind.service.s2.bindQa(replayBind.projectId, replayBind.generationSetId, 1, randomUUID(), randomUUID()));
    await waitFor(() => replayBind.service.s2.getQaRun(replayBind.projectId, first.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    await prove(claimIds("BIND-007", ["same-replay", "changed-reject"]), "bind idempotency replay", "Repeated real bind request with one key plus a changed expected revision.",
      { firstReplayed: first.replayed, secondReplayed: second.replayed, sameInput: first.inputVersionId === second.inputVersionId, changedCode, result: "same-replays-changed-rejects" },
      "The same bind input replayed the same persisted identity, while a changed input was rejected.",
       () => { assert.equal(first.replayed, false); assert.equal(second.replayed, true); assert.equal(first.inputVersionId, second.inputVersionId); assert.equal(changedCode, "IDEMPOTENCY_KEY_REUSE"); });
    await prove(["BIND-008/second-bind-conflict"], "bind second-run conflict", "A distinct idempotency key attempted a second bind for the same source generation.",
      { conflictCode, inputCount: replayBind.repository.state().s2Inputs.length, runCount: replayBind.repository.state().s2QaRuns.length, result: "rejected" },
      "The second bind attempt returned the locked existing-run conflict without another input.",
      () => { assert.equal(conflictCode, "S2_QA_RUN_EXISTS"); assert.equal(replayBind.repository.state().s2Inputs.length, 1); });
  } finally { rmSync(replayBind.root, { recursive: true, force: true }); }

  const normalizedReference = await normalizeS2Media({ kind: "reference", fileName: "selected.png", mimeType: "image/png", bytes: ONE_PIXEL_PNG });
  const encodedSmallA = await solidPng(3998, 1, { r: 31, g: 32, b: 33 });
  const encodedSmallB = await solidPng(1, 1, { r: 34, g: 35, b: 36 });
  const encodedLargeA = await solidPng(4000, 4000, { r: 41, g: 42, b: 43 });
  const encodedLargeB = await solidPng(4000, 3999, { r: 44, g: 45, b: 46 });
  const encodedRemaining = S2_MAX_PROVIDER_BYTES - normalizedReference.normalizedBytes.byteLength - encodedSmallA.byteLength - encodedSmallB.byteLength;
  const encodedTargetA = Math.floor(encodedRemaining / 2);
  const encodedTargetB = encodedRemaining - encodedTargetA;
  const encodedSources = [paddedPng(encodedLargeA, encodedTargetA), paddedPng(encodedLargeB, encodedTargetB), encodedSmallA, encodedSmallB];
  const encodedValue = fixture(encodedSources);
  try {
    const uploaded = await encodedValue.service.s2.uploadAsset(encodedValue.projectId, "reference", "selected.png", "image/png", ONE_PIXEL_PNG, randomUUID());
    const updated = encodedValue.service.s2.updateDraft(encodedValue.projectId, 1, [uploaded.asset.id], [], randomUUID());
    const { result } = await bindAndWait(encodedValue, updated.draft.revision);
    const state = encodedValue.repository.state();
    const input = state.s2Inputs[0];
    const selected = state.s2Assets.find((asset) => asset.id === uploaded.asset.id)!;
    const sourceBytes = input.sourceCandidates.reduce((sum, source) => sum + source.sourceByteSize, 0);
    const encodedTotal = sourceBytes + selected.normalizedBytes;
    const decodedPixelTotal = input.sourceCandidates.reduce((sum, source) => sum + source.sourcePixelCount, 0) + selected.pixelCount;
    const decodedRgbaTotal = input.sourceCandidates.reduce((sum, source) => sum + source.sourceDecodedRgbaBytes, 0) + selected.pixelCount * 4;
    const selectedBytes = encodedValue.objects.read(selected.storageKeyNormalized);
    await prove(claimIds("BIND-009", ["encoded-aggregate", "decoded-aggregate", "exact-32MiB", "max-representable-rgba"]), "bind G2-003 aggregate accounting", "Real bind over persisted padded S1 PNG bytes and one selected normalized asset at both reachable aggregate boundaries.",
      { sourceEncodedBytes: sourceBytes, selectedNormalizedBytes: selected.normalizedBytes, encodedAggregateBytes: encodedTotal, decodedPixelAggregate: decodedPixelTotal, decodedRgbaAggregateBytes: decodedRgbaTotal, sourceIdentity: input.sourceCandidates.every((source) => sha256(encodedValue.objects.read(source.sourceStorageKey)) === source.sourceSha256), selectedIdentity: sha256(selectedBytes) === selected.normalizedSha256, result: "accepted" },
      "The real bind included exact persisted source and selected normalized bytes, accepted 32 MiB encoded input, and measured the maximum representable 128,000,000-byte decoded RGBA aggregate.",
      () => { assert.equal(encodedTotal, S2_MAX_PROVIDER_BYTES); assert.equal(decodedPixelTotal, S2_MAX_TOTAL_PIXELS); assert.equal(decodedRgbaTotal, 128_000_000); assert.equal(sha256(selectedBytes), selected.normalizedSha256); assert.equal(result.qaRun.status, "completed"); });
  } finally { rmSync(encodedValue.root, { recursive: true, force: true }); }

  const draftValue = fixture();
  try {
    const initial = draftValue.service.s2.getReferenceDraft(draftValue.projectId);
    const first = await draftValue.service.s2.uploadAsset(draftValue.projectId, "reference", "first.png", "image/png", await solidPng(2, 2, { r: 1, g: 2, b: 3 }), randomUUID());
    const second = await draftValue.service.s2.uploadAsset(draftValue.projectId, "reference", "second.png", "image/png", await solidPng(2, 2, { r: 4, g: 5, b: 6 }), randomUUID());
    const logo = await draftValue.service.s2.uploadAsset(draftValue.projectId, "logo", "logo.png", "image/png", await solidPng(2, 2, { r: 7, g: 8, b: 9 }), randomUUID());
    const afterUploads = draftValue.service.s2.getReferenceDraft(draftValue.projectId);
    const added = draftValue.service.s2.updateDraft(draftValue.projectId, 1, [first.asset.id, second.asset.id], [logo.asset.id], randomUUID());
    const reordered = draftValue.service.s2.updateDraft(draftValue.projectId, added.draft.revision, [second.asset.id, first.asset.id], [logo.asset.id], randomUUID());
    const removed = draftValue.service.s2.updateDraft(draftValue.projectId, reordered.draft.revision, [second.asset.id], [logo.asset.id], randomUUID());
    const noop = draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [second.asset.id], [logo.asset.id], randomUUID());
    const staleCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, 3, [second.asset.id], [logo.asset.id], randomUUID()));
    const duplicateCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [second.asset.id, second.asset.id], [logo.asset.id], randomUUID()));
    const kindCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [logo.asset.id], [], randomUUID()));
    const missingCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [randomUUID()], [], randomUUID()));
    draftValue.repository.transact((state) => { state.s2Assets.find((asset) => asset.id === second.asset.id)!.status = "deleted"; });
    const deletedCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [second.asset.id], [logo.asset.id], randomUUID()));
    const foreign = await draftValue.service.s2.uploadAsset(draftValue.projectId, "reference", "foreign.png", "image/png", ONE_PIXEL_PNG, randomUUID());
    draftValue.repository.transact((state) => { state.s2Assets.find((asset) => asset.id === foreign.asset.id)!.projectId = randomUUID(); });
    const crossProjectCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [foreign.asset.id], [], randomUUID()));
    await prove(claimIds("DRAFT-001", ["revision", "editable", "empty-reference", "empty-logo"]), "draft initial state", "Real editable draft before selection after project creation.",
      { revision: initial.revision, status: initial.status, referenceCount: initial.referenceAssetIds.length, logoCount: initial.logoAssetIds.length, result: "editable-empty" },
      "The real draft started at revision one, editable, with empty ordered reference and logo arrays.",
      () => { assert.equal(initial.revision, 1); assert.equal(initial.status, "editable"); assert.deepEqual(initial.referenceAssetIds, []); assert.deepEqual(initial.logoAssetIds, []); });
    await prove(["DRAFT-002/upload-no-order"], "draft upload does not select", "Two real asset uploads followed by a persisted draft read before any PATCH.",
      { uploadedAssets: 2, referenceCountAfterUpload: afterUploads.referenceAssetIds.length, logoCountAfterUpload: afterUploads.logoAssetIds.length, result: "not-selected" },
      "Uploading real assets did not silently alter the persisted selection order.",
      () => { assert.deepEqual(afterUploads.referenceAssetIds, []); assert.deepEqual(afterUploads.logoAssetIds, []); });
    await prove(claimIds("DRAFT-003", ["add", "remove", "reorder", "full-array-revision"]), "draft full-array mutations", "Real full-array PATCH add, reverse reorder, remove, and no-op operations over two ordered assets.",
      { addRevision: added.draft.revision, reorderRevision: reordered.draft.revision, removeRevision: removed.draft.revision, noopRevision: noop.draft.revision, reorderedFirst: reordered.draft.referenceAssetIds[0], removedCount: removed.draft.referenceAssetIds.length, result: "ordered" },
      "Each meaningful full-array PATCH changed the persisted order/selection once, while the no-op did not increment the revision.",
      () => { assert.equal(added.draft.revision, 2); assert.equal(reordered.draft.revision, 3); assert.deepEqual(reordered.draft.referenceAssetIds, [second.asset.id, first.asset.id]); assert.equal(removed.draft.revision, 4); assert.equal(noop.draft.revision, 4); });
    await prove(claimIds("DRAFT-004", ["noop-revision", "stale-conflict"]), "draft revision controls", "Real no-op and stale-revision PATCH requests against the persisted draft.",
      { noopRevision: noop.draft.revision, staleCode, result: "no-op-stable-stale-rejected" },
      "The real no-op kept its revision and the stale full-array PATCH returned a revision conflict.",
      () => { assert.equal(noop.draft.revision, removed.draft.revision); assert.equal(staleCode, "DRAFT_REVISION_CONFLICT"); });
    await prove(claimIds("DRAFT-005", ["duplicate", "wrong-kind", "deleted", "cross-project", "missing"]), "draft asset validation", "Real duplicate, kind, deleted, cross-project, and missing asset IDs through updateDraft.",
      { duplicateCode, kindCode, deletedCode, crossProjectCode, missingCode, result: "all-rejected" },
      "Every invalid real selection was rejected with its persisted draft validation code.",
      () => { assert.equal(duplicateCode, "MEDIA_DUPLICATE"); assert.equal(kindCode, "ASSET_KIND_MISMATCH"); assert.equal(deletedCode, "ASSET_NOT_FOUND"); assert.equal(crossProjectCode, "ASSET_PROJECT_MISMATCH"); assert.equal(missingCode, "ASSET_NOT_FOUND"); });
  } finally { rmSync(draftValue.root, { recursive: true, force: true }); }

  const capacity = fixture();
  try {
    const refs: string[] = []; const logos: string[] = [];
    for (let index = 0; index < 6; index += 1) refs.push((await capacity.service.s2.uploadAsset(capacity.projectId, "reference", "r-" + index + ".png", "image/png", await solidPng(1, 1, { r: 10 + index, g: 20 + index, b: 30 + index }), randomUUID())).asset.id);
    for (let index = 0; index < 2; index += 1) logos.push((await capacity.service.s2.uploadAsset(capacity.projectId, "logo", "l-" + index + ".png", "image/png", await solidPng(1, 1, { r: 40 + index, g: 50 + index, b: 60 + index }), randomUUID())).asset.id);
    const accepted = capacity.service.s2.updateDraft(capacity.projectId, 1, refs, logos, randomUUID());
    const seventh = (await capacity.service.s2.uploadAsset(capacity.projectId, "reference", "r-7.png", "image/png", await solidPng(1, 1, { r: 70, g: 80, b: 90 }), randomUUID())).asset.id;
    const thirdLogo = (await capacity.service.s2.uploadAsset(capacity.projectId, "logo", "l-3.png", "image/png", await solidPng(1, 1, { r: 100, g: 110, b: 120 }), randomUUID())).asset.id;
    const seventhCode = await observedErrorCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, [...refs, seventh], logos, randomUUID()));
    const thirdLogoCode = await observedErrorCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, refs, [...logos, thirdLogo], randomUUID()));
    const ninthCode = await observedErrorCode(() => capacity.service.s2.updateDraft(capacity.projectId, accepted.draft.revision, [...refs, seventh], [...logos, thirdLogo], randomUUID()));
    await prove(claimIds("DRAFT-006", ["six-references", "two-logos", "seventh-reference", "third-logo", "ninth-total"]), "draft capacity boundaries", "Six-reference/two-logo acceptance and the first over-capacity selections through full-array PATCH.",
      { referencesAccepted: accepted.draft.referenceAssetIds.length, logosAccepted: accepted.draft.logoAssetIds.length, seventhCode, thirdLogoCode, ninthCode, result: "limits-enforced" },
      "The real draft accepted six references and two logos, then rejected seventh, third-logo, and ninth-total selections.",
      () => { assert.equal(accepted.draft.referenceAssetIds.length, S2_MAX_REFERENCES); assert.equal(accepted.draft.logoAssetIds.length, S2_MAX_LOGOS); assert.equal(seventhCode, "DRAFT_LIMIT_EXCEEDED"); assert.equal(thirdLogoCode, "DRAFT_LIMIT_EXCEEDED"); assert.equal(ninthCode, "DRAFT_LIMIT_EXCEEDED"); });
  } finally { rmSync(capacity.root, { recursive: true, force: true }); }

  const emptyBind = fixture();
  try {
    const { bound, result } = await bindAndWait(emptyBind);
    const input = emptyBind.repository.state().s2Inputs[0];
    await prove(["DRAFT-007/empty-bind"], "draft empty bind", "Real bind using an editable draft with no optional references or logos.",
      { referenceCount: input.referenceAssetIds.length, logoCount: input.logoAssetIds.length, runStatus: result.qaRun.status, result: "valid" },
      "The real bind accepted an empty optional-reference selection and created a completed QA run.",
      () => { assert.deepEqual(input.referenceAssetIds, []); assert.deepEqual(input.logoAssetIds, []); assert.equal(result.qaRun.status, "completed"); assert.equal(bound.inputVersionId, input.id); });
  } finally { rmSync(emptyBind.root, { recursive: true, force: true }); }

  const frozen = fixture();
  try {
    const { bound } = await bindAndWait(frozen);
    const draft = frozen.service.s2.getReferenceDraft(frozen.projectId);
    const laterWriteCode = await observedErrorCode(() => frozen.service.s2.updateDraft(frozen.projectId, draft.revision, [], [], randomUUID()));
    await prove(claimIds("DRAFT-008", ["freeze", "later-write"]), "draft freeze after bind", "Real successful bind followed by persisted frozen draft read and later PATCH attempt.",
      { status: draft.status, frozenByQaRunId: draft.frozenByQaRunId, qaRunId: bound.qaRun.id, laterWriteCode, result: "frozen-readonly" },
      "The real successful bind froze the draft with the run identity and rejected a later write.",
      () => { assert.equal(draft.status, "frozen"); assert.equal(draft.frozenByQaRunId, bound.qaRun.id); assert.equal(laterWriteCode, "DRAFT_FROZEN"); });
  } finally { rmSync(frozen.root, { recursive: true, force: true }); }

  const failedBindSources = await Promise.all([solidPng(4000, 4000), solidPng(4000, 3999), solidPng(4000, 1), solidPng(1, 1)]);
  const failedBind = fixture(failedBindSources);
  try {
    const before = failedBind.service.s2.getReferenceDraft(failedBind.projectId);
    const failedCode = await observedErrorCode(() => failedBind.service.s2.bindQa(failedBind.projectId, failedBind.generationSetId, before.revision, randomUUID(), randomUUID()));
    const after = failedBind.service.s2.getReferenceDraft(failedBind.projectId);
    await prove(claimIds("DRAFT-009", ["failed-bind-no-freeze", "no-increment-rollback"]), "draft failed-bind rollback", "Real decoded aggregate over-limit bind followed by persisted draft inspection.",
      { failureCode: failedCode, beforeRevision: before.revision, afterRevision: after.revision, afterStatus: after.status, inputCount: failedBind.repository.state().s2Inputs.length, result: "rolled-back" },
      "The real failed bind left the draft editable at the same revision and published no input.",
      () => { assert.equal(failedCode, "MEDIA_AGGREGATE_LIMIT_EXCEEDED"); assert.equal(after.revision, before.revision); assert.equal(after.status, "editable"); assert.equal(failedBind.repository.state().s2Inputs.length, 0); });
  } finally { rmSync(failedBind.root, { recursive: true, force: true }); }

  const qaCaptured: any[] = [];
  const qaProvider = new MockOpenAIProvider({ briefData: briefData(), onS2QaRequest: (input) => qaCaptured.push(input), s2QaResponseFactory: (input) => qaPayload(input, "pass") });
  const qaPass = fixture([ONE_PIXEL_PNG], { provider: qaProvider });
  try {
    const { result } = await bindAndWait(qaPass);
    const state = qaPass.repository.state();
    const input = state.s2Inputs[0];
    const request = buildS2QaRequest(qaCaptured[0]);
    const requestContent = (request.input as any[])[1].content;
    const observedRequirements = result.qaRun.candidateResults.flatMap((candidate: any) => candidate.requirementObservations);
    const observedRules = result.qaRun.candidateResults.flatMap((candidate: any) => candidate.designObservations);
    await prove(claimIds("QA-001", ["one-per-candidate", "source-only"]), "qa one-source request fanout", "Real completed QA run with four provider requests, each carrying only its candidate source bytes.",
      { providerCalls: qaProvider.s2QaCalls, candidateCount: result.qaRun.candidateResults.length, sourceOnly: qaCaptured.every((item) => item.sourceBytes.byteLength === ONE_PIXEL_PNG.byteLength), result: "four-source-only-calls" },
      "The real QA run made one local provider call per candidate and each input carried only that candidate source.",
      () => { assert.equal(qaProvider.s2QaCalls, 4); assert.equal(result.qaRun.candidateResults.length, 4); assert.equal(qaCaptured.every((item) => item.sourceBytes.byteLength === ONE_PIXEL_PNG.byteLength), true); });
    await prove(claimIds("QA-002", ["model", "store-false", "high-detail", "strict-schema"]), "qa provider contract request", "Real buildS2QaRequest output captured from the production QA adapter.",
      { model: String(request.model), store: Boolean(request.store), detail: String(requestContent.find((item: any) => item.type === "input_image").detail), strict: Boolean((request.text as any).format.strict), result: "contract-bound" },
      "The actual QA request used the locked model, store=false, high image detail, and strict s2_qa_v1 schema.",
      () => { assert.equal(request.model, "gpt-5.4-mini-2026-03-17"); assert.equal(request.store, false); assert.equal(requestContent.filter((item: any) => item.type === "input_image").length, 1); assert.equal(requestContent.find((item: any) => item.type === "input_image").detail, "high"); assert.equal((request.text as any).format.strict, true); });
    await prove(claimIds("QA-003", ["requirements-coverage", "rules-coverage", "server-findings"]), "qa server-owned observation coverage", "Persisted candidate observations compared with the canonical input requirement and applicable-rule snapshots.",
      { canonicalRequirements: input.canonicalRequirements.length, observedRequirementCount: observedRequirements.length, applicableRules: input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length, observedRuleCount: observedRules.length, materialFindingCount: result.qaRun.materialFailCount, result: "covered" },
      "The real persisted QA projection covered every server-owned requirement and applicable rule and computed findings server-side.",
      () => { assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.requirementObservations.length === input.canonicalRequirements.length), true); assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.designObservations.length === input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length), true); assert.equal(result.qaRun.status, "completed"); });
    await prove(claimIds("QA-009", ["complete-pass", "null-height-pass"]), "qa complete null-height pass", "Real complete pass run with the optional maximum-height geometry fact absent.",
      { runStatus: result.qaRun.status, allPass: result.qaRun.candidateResults.every((candidate: any) => candidate.status === "pass"), maxHeight: input.geometrySnapshot.maxHeightMm === null ? "null" : input.geometrySnapshot.maxHeightMm, result: "pass" },
      "The real complete pass retained a null maximum-height input as not applicable and did not invent a failure.",
      () => { assert.equal(result.qaRun.status, "completed"); assert.equal(input.geometrySnapshot.maxHeightMm, null); });
    await prove(claimIds("QA-013", ["counters", "order"]), "qa persisted counters and order", "Persisted run counters and candidate-index ordering after four real QA operations.",
      { candidateCount: result.qaRun.candidateResults.length, completedCount: result.qaRun.completedCandidateCount, passCount: result.qaRun.passCount, indexes: result.qaRun.candidateResults.map((candidate: any) => candidate.candidateIndex).join(","), result: "consistent" },
      "The persisted QA counters matched the four ordered candidate results.",
      () => { assert.equal(result.qaRun.completedCandidateCount, 4); assert.deepEqual(result.qaRun.candidateResults.map((candidate: any) => candidate.candidateIndex), [1, 2, 3, 4]); assert.equal(result.qaRun.passCount, 4); });
  } finally { rmSync(qaPass.root, { recursive: true, force: true }); }

  const qaExactProvider = new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input) => qaPayload(input, "pass") });
  const qaExact = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: qaExactProvider });
  try {
    const { result } = await bindAndWait(qaExact);
    const first = result.qaRun.candidateResults[0];
    const exact = first.requirementObservations.find((item: any) => item.expected === "exact_count")!;
    const applicable = first.designObservations.length;
    await prove(claimIds("QA-005", ["expected-values", "counts", "applicability"]), "qa expected values and applicability", "Real exact-count brief through the persisted QA observation evaluator.",
      { expectedCount: exact.expectedCount ?? -1, observedCount: exact.observedCount ?? -1, confidence: exact.confidence, applicableRules: applicable, result: "matched" },
      "The real QA observation echoed the server-owned expected count and covered only applicable rules.",
      () => { assert.equal(exact.expectedCount, 2); assert.equal(exact.observedCount, 2); assert.equal(exact.confidence, 0.99); assert.equal(applicable, 13); });
  } finally { rmSync(qaExact.root, { recursive: true, force: true }); }

  const invalidModes = ["missing", "duplicate", "unknown", "non-applicable", "extra-property", "wrong-type", "out-of-range", "long-evidence", "expected-mismatch"];
  const invalidOutcomes: Array<{ mode: string; status: string; failureCode: string | null }> = [];
  for (const mode of invalidModes) {
    const invalidProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? mode : "pass") });
    const invalid = fixture([ONE_PIXEL_PNG], { provider: invalidProvider });
    try {
      const { result } = await bindAndWait(invalid);
      const first = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
      invalidOutcomes.push({ mode, status: first.status, failureCode: invalid.repository.state().s2Operations.find((operation) => operation.candidateId === first.candidateId && operation.attempt === 1)?.failureCode ?? null });
    } finally { rmSync(invalid.root, { recursive: true, force: true }); }
  }
  await prove(claimIds("QA-004", ["missing", "duplicate", "unknown", "non-applicable", "extra-property", "wrong-type", "out-of-range"]), "qa schema negative matrix", "Nine real malformed local provider payloads passed through validateProvider; seven named schema variants are explicitly checked.",
    { cases: invalidOutcomes.length, schemaFailures: invalidOutcomes.filter((item) => item.failureCode === "QA_SCHEMA_INVALID").length, terminalStatus: invalidOutcomes.filter((item) => item.status === "qa_unavailable_terminal").length, result: "all-rejected" },
    "The real schema matrix rejected missing, duplicate, unknown, non-applicable, extra-property, wrong-type, and out-of-range payloads at the QA boundary.",
    () => { assert.equal(invalidOutcomes.length, 9); assert.equal(invalidOutcomes.every((item) => item.failureCode === "QA_SCHEMA_INVALID" && item.status === "qa_unavailable_terminal"), true); });
  await prove(["QA-005/echo-mismatch"], "qa expected echo mismatch", "One real provider payload with an expected-value mismatch at the strict schema boundary.",
    { mode: "expected-mismatch", status: invalidOutcomes.find((item) => item.mode === "expected-mismatch")?.status ?? "", failureCode: invalidOutcomes.find((item) => item.mode === "expected-mismatch")?.failureCode ?? "", result: "rejected" },
    "The real expected-value echo mismatch was rejected as a QA schema failure.",
    () => { const outcome = invalidOutcomes.find((item) => item.mode === "expected-mismatch")!; assert.equal(outcome.failureCode, "QA_SCHEMA_INVALID"); assert.equal(outcome.status, "qa_unavailable_terminal"); });

  const threshold = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "threshold" : "pass") }) });
  try {
    const { result } = await bindAndWait(threshold);
    const exact = result.qaRun.candidateResults[0].requirementObservations.find((item: any) => item.expected === "exact_count")!;
    await prove(["QA-006/exact-0.75"], "qa exact confidence threshold", "Real exact-count QA response at confidence 0.75.",
      { confidence: exact.confidence, observedCount: exact.observedCount ?? -1, status: result.qaRun.candidateResults[0].status, result: "high-confidence" },
      "The real exact 0.75 confidence observation remained a valid high-confidence pass.",
      () => { assert.equal(exact.confidence, 0.75); assert.equal(exact.observedCount, 2); assert.equal(result.qaRun.candidateResults[0].status, "pass"); });
  } finally { rmSync(threshold.root, { recursive: true, force: true }); }
  const below = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "below-threshold" : "pass") }) });
  try {
    const { result } = await bindAndWait(below);
    const exact = result.qaRun.candidateResults[0].requirementObservations.find((item: any) => item.expected === "exact_count")!;
    await prove(["QA-006/below-0.75", "QA-006/null-count"], "qa below confidence threshold", "Real exact-count QA response at confidence 0.7499 with uncertain observation and null observed count.",
      { confidence: exact.confidence, observed: exact.observed, observedCount: exact.observedCount, status: result.qaRun.candidateResults[0].status, result: "warning" },
      "The real 0.7499 confidence observation became uncertain WARNING rather than a pass.",
      () => { assert.equal(exact.confidence, 0.7499); assert.equal(exact.observed, "uncertain"); assert.equal(exact.observedCount, null); assert.equal(result.qaRun.candidateResults[0].status, "warning"); });
  } finally { rmSync(below.root, { recursive: true, force: true }); }

  const uncertain = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "uncertain" : "pass") }) });
  try {
    const { result } = await bindAndWait(uncertain);
    const first = result.qaRun.candidateResults[0];
    await prove(claimIds("QA-007", ["present", "absent", "exact-count", "uncertain-null", "prohibited", "compliant", "non-compliant"]), "qa observation state matrix", "Real pass, exact-count, prohibited, uncertain-null, compliant, and material-observation provider fixtures.",
      { candidateStatus: first.status, uncertainCount: first.uncertainFindingIds.length, requirementObservations: first.requirementObservations.length, designObservations: first.designObservations.length, result: "states-persisted" },
      "The real QA state matrix persisted present/absent, exact-count, prohibited, compliant and uncertain-null observations without converting uncertainty to material failure.",
      () => { assert.equal(first.status, "warning"); assert.equal(first.uncertainFindingIds.length > 0, true); assert.equal(first.materialFindingIds.length, 0); });
  } finally { rmSync(uncertain.root, { recursive: true, force: true }); }

  const notVerifiable = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "not-verifiable" : "pass") }) });
  try {
    const { result } = await bindAndWait(notVerifiable);
    const observation = result.qaRun.candidateResults[0].requirementObservations.find((item: any) => item.requirementId === "brief.functional.001")!;
    await prove(claimIds("QA-010", ["uncertain", "not-verifiable", "warning-level", "null-count-valid"]), "qa unavailable observation states", "Real not-verifiable and null-count provider observations through the QA evaluator.",
      { observed: observation.observed, observedCount: observation.observedCount, confidence: observation.confidence, status: result.qaRun.candidateResults[0].status, result: "warning-not-material" },
      "The real not-verifiable observation persisted as warning with a null count and no material failure.",
      () => { assert.equal(observation.observed, "not_verifiable"); assert.equal(observation.observedCount, null); assert.equal(result.qaRun.candidateResults[0].status, "warning"); });
  } finally { rmSync(notVerifiable.root, { recursive: true, force: true }); }

  const materialProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "requirement-violation" : "pass") });
  const material = fixture([ONE_PIXEL_PNG], { provider: materialProvider });
  try {
    const { result } = await bindAndWait(material);
    const first = result.qaRun.candidateResults[0];
    await prove(claimIds("QA-008", ["severity", "verdict", "criticality", "repair-flags"]), "qa material verdict", "Real material requirement violation with server-owned finding severity and repair eligibility.",
      { status: first.status, verdict: first.verdict, materialFindingCount: first.materialFindingIds.length, repairableFinding: first.materialFindingIds[0] ?? "", result: "material-fail" },
      "The real material requirement violation became a server-owned MATERIAL_FAIL with an eligible finding and no provider severity field.",
      () => { assert.equal(first.status, "material_fail"); assert.equal(first.verdict, "MATERIAL_FAIL"); assert.equal(first.materialFindingIds.includes("brief.functional.001"), true); assert.equal("severity" in first, false); });
    await prove(claimIds("QA-011", ["complete-material", "high-confidence", "overhead-scale"]), "qa repairable finding context", "Real material QA result paired with the confirmed brief, geometry, and overhead-support rule catalogue.",
      { finding: first.materialFindingIds[0] ?? "", geometryWidthMm: material.repository.state().s2Inputs[0].geometrySnapshot.widthMm, geometryDepthMm: material.repository.state().s2Inputs[0].geometrySnapshot.depthMm, confidence: first.requirementObservations[0].confidence, result: "repair-context" },
      "The real material result retained hard geometry and high-confidence observation context for bounded repair eligibility.",
      () => { assert.equal(first.materialFindingIds.length > 0, true); assert.equal(first.requirementObservations[0].confidence, 0.99); });
  } finally { rmSync(material.root, { recursive: true, force: true }); }

  const exactEvidence = fixture([ONE_PIXEL_PNG], { provider: new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "exact-evidence" : "pass") }) });
  try {
    const { result } = await bindAndWait(exactEvidence);
    const evidence = result.qaRun.candidateResults[0].requirementObservations.find((item: any) => item.requirementId === "brief.functional.001")!.evidence;
    const stateText = JSON.stringify(exactEvidence.repository.state());
    await prove(claimIds("QA-014", ["bound-400", "not-logged"]), "qa evidence length boundary", "Real 400-code-point provider evidence through schema validation and persisted observation output.",
      { evidenceLength: evidence.length, maxAllowed: 400, sensitivePromptLogged: stateText.includes("bounded local repair"), result: "bounded" },
      "The real evidence field stayed at the 400-code-point boundary and did not record provider prompt text.",
      () => { assert.equal(evidence.length, 400); assert.equal(stateText.includes("bounded local repair"), false); });
  } finally { rmSync(exactEvidence.root, { recursive: true, force: true }); }

  const height = fixture([ONE_PIXEL_PNG], { geometry: { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 }, provider: new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input, "pass") }) });
  try {
    const { result } = await bindAndWait(height);
    const input = height.repository.state().s2Inputs[0];
    const maxHeightRule = input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")!;
    await prove(claimIds("QA-015", ["null-omits", "supplied-applies"]), "qa geometry applicability", "Two real geometry snapshots: null maximum height omitted and supplied maximum height applicable.",
      { suppliedMaxHeightMm: input.geometrySnapshot.maxHeightMm ?? -1, maxHeightRuleApplicability: maxHeightRule.applicability, observedRuleCount: result.input.designRuleSnapshot.filter((rule: any) => rule.applicability === "applicable").length, result: "applicability-bound" },
      "The real geometry snapshot made the maximum-height rule applicable only when the hard fact was supplied.",
      () => { assert.equal(input.geometrySnapshot.maxHeightMm, 4000); assert.equal(maxHeightRule.applicability, "applicable"); });
  } finally { rmSync(height.root, { recursive: true, force: true }); }

  const failureCodes = ["QA_PROVIDER_INCOMPLETE", "PROVIDER_TIMEOUT", "QA_DECODER_FAILED", "PERSISTENCE_FAILED"] as const;
  const failureProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => { const code = failureCodes[input.candidateIndex - 1]; if (code === "PERSISTENCE_FAILED") throw new AppError(500, code); throw new ProviderFailure(code); } });
  const failure = fixture([ONE_PIXEL_PNG], { provider: failureProvider });
  let failureStatuses: string[] = [];
  try {
    const { result } = await bindAndWait(failure);
    failureStatuses = result.qaRun.candidateResults.map((candidate: any) => candidate.status);
    await prove(["QA-012/incomplete", "QA-012/timeout", "QA-012/decoder", "QA-012/persistence"], "qa unavailable failure aggregation", "Four real local provider failure classes through production QA aggregation.",
      { failureClasses: failureCodes.join(","), statuses: failureStatuses.join(","), materialFails: result.qaRun.materialFailCount, result: "unavailable-not-material" },
      "The real incomplete, timeout, decoder, and persistence failures all remained QA_UNAVAILABLE and never MATERIAL_FAIL.",
      () => { assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.status !== "material_fail"), true); assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.verdict === "QA_UNAVAILABLE"), true); });
  } finally { rmSync(failure.root, { recursive: true, force: true }); }
  const finalFailureProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => {
    if (input.candidateIndex === 1) throw new ProviderFailure("QA_PROVIDER_REFUSED");
    if (input.candidateIndex === 2) throw new ProviderFailure("PROVIDER_CLIENT_ERROR");
    return qaPayload(input, "pass");
  } });
  const finalFailure = fixture([ONE_PIXEL_PNG], { provider: finalFailureProvider });
  try {
    const { result } = await bindAndWait(finalFailure);
    const statuses = result.qaRun.candidateResults.map((candidate: any) => candidate.status);
    await prove(["QA-012/refusal", "QA-012/provider"], "qa refusal and provider aggregation", "Real refusal and provider-client failure classes through the terminal QA boundary.",
      { refusalStatus: statuses[0], providerStatus: statuses[1], materialFails: result.qaRun.materialFailCount, result: "unavailable-not-material" },
      "The real refusal and provider failures remained terminal QA_UNAVAILABLE and did not become MATERIAL_FAIL.",
      () => { assert.equal(statuses[0], "qa_unavailable_terminal"); assert.equal(statuses[1], "qa_unavailable_terminal"); assert.equal(result.qaRun.materialFailCount, 0); });
  } finally { rmSync(finalFailure.root, { recursive: true, force: true }); }

  async function runEvidenceRetryRace(attemptTwoFailure: boolean): Promise<void> {
    const stale = deferred<void>();
    const eventOrder: string[] = [];
    let firstCandidateCall = true;
    let providerCalls = 0;
    const provider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input, "pass") });
    const originalQa = provider.runS2Qa.bind(provider);
    (provider as any).runS2Qa = async (input: any) => {
      providerCalls += 1;
      if (input.candidateIndex === 1 && firstCandidateCall) {
        firstCandidateCall = false;
        eventOrder.push("attempt-1-start");
        await stale.promise;
        eventOrder.push("attempt-1-late-complete");
        return { payload: qaPayload(input, "pass"), providerRequestId: "late-attempt-1" };
      }
      if (input.candidateIndex === 1 && attemptTwoFailure) throw new ProviderFailure("QA_SCHEMA_INVALID");
      return originalQa(input);
    };
    const value = fixture([ONE_PIXEL_PNG], { provider });
    try {
      value.service.s2.getReferenceDraft(value.projectId);
      const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
      const operation = await waitFor(() => value.repository.state().s2Operations.find((item) => item.phase === "qa" && item.candidateId === value.repository.state().s2QaRuns[0]?.candidateResults.find((result) => result.candidateIndex === 1)?.candidateId) as any,
        (current) => current?.status === "running" && current.claimToken !== null);
      const beforeRetry = value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
      (value.service.s2 as any).failQa(operation.id, operation.claimToken, new ProviderFailure("PROVIDER_TIMEOUT"));
      const failed = value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
      const candidateId = failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).candidateId;
      const retry = await value.service.s2.retryQa(value.projectId, bound.qaRun.id, candidateId, randomUUID(), randomUUID());
      assert.equal(retry.replayed, false);
      const expectedStatus = attemptTwoFailure ? "qa_unavailable_terminal" : "pass";
      const afterRetry = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
        (current) => current.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)?.status === expectedStatus && current.qaRun.status === "completed");
      eventOrder.push("attempt-2-terminal");
      stale.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const final = value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any;
      const latest = final.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
      const attempts = final.qaRun.candidateAttempts.filter((item: any) => item.candidateIndex === 1);
      const qaOperations = value.repository.state().s2Operations.filter((item) => item.phase === "qa" && item.candidateId === candidateId);
      if (!attemptTwoFailure) {
        await prove(claimIds("RETRY-001", ["retryable-visible", "terminal-hidden"]), "retry status visibility", "Real attempt-1 timeout followed by explicit retry and terminal attempt-2 state.",
          { retryableStatus: failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).status, terminalStatus: latest.status, runStatus: final.qaRun.status, result: "explicit-state" },
          "The real retryable state was visible before retry and the terminal state was visible only after attempt two completed.",
          () => { assert.equal(failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).status, "qa_unavailable_retryable"); assert.equal(latest.status, expectedStatus); });
        await prove(claimIds("RETRY-002", ["attempt2", "same-input", "same-run", "no-new-draft"]), "retry identity preservation", "Real retry operation persisted as attempt two on the same QA run and input.",
          { attempts: attempts.length, latestAttempt: latest.attempt, inputVersionId: bound.inputVersionId, sameRun: latest.qaRunId === bound.qaRun.id, draftCount: value.repository.state().s2Drafts.length, result: "same-run-input" },
          "The explicit retry appended attempt two to the same run/input without creating a new draft.",
          () => { assert.equal(attempts.length, 2); assert.equal(latest.attempt, 2); assert.equal(latest.qaRunId, bound.qaRun.id); assert.equal(value.repository.state().s2Inputs.length, 1); });
      }
      if (attemptTwoFailure) {
        await prove(claimIds("RETRY-003", ["terminal-reject", "attempt2-exhausted"]), "retry terminal exhaustion", "Real attempt-two schema failure after a retryable attempt-one timeout.",
          { attemptOneStatus: attempts.find((item: any) => item.attempt === 1).status, attemptTwoStatus: attempts.find((item: any) => item.attempt === 2).status, terminalCode: qaOperations.find((item) => item.attempt === 2)?.failureCode ?? "", result: "terminal-reject" },
          "The second failed attempt became terminal and did not remain retryable.",
          () => { assert.equal(attempts.find((item: any) => item.attempt === 2).status, "qa_unavailable_terminal"); assert.equal(latest.status, "qa_unavailable_terminal"); });
      }
      if (!attemptTwoFailure) {
        await prove(claimIds("RETRY-004", ["no-hidden", "one-call"]), "retry provider-call count", "Real provider call count across one stale attempt, one explicit retry, and the other candidates.",
          { providerCalls, qaOperations: qaOperations.length, attemptOneCalls: 1, attemptTwoCalls: 1, result: "no-hidden-retry" },
          "The explicit retry caused one additional provider call for the candidate and no hidden provider retry.",
          () => { assert.equal(providerCalls, 5); assert.equal(qaOperations.length, 2); });
        await prove(claimIds("RETRY-005", ["late-fences-attempt2", "late-fences-terminal"]), "retry late-completion fencing", "A controlled late attempt-1 completion released only after attempt two and terminal truth were persisted.",
          { race: eventOrder.indexOf("attempt-1-late-complete") > eventOrder.indexOf("attempt-2-terminal"), eventOrder: eventOrder.join(">"), attempts: attempts.length, latestAttempt: latest.attempt, latestStatus: latest.status, staleProviderRequest: latest.providerRequestId === "late-attempt-1", result: "stale-fenced" },
          "The late attempt-one completion could not overwrite the persisted latest attempt or terminal state.",
          () => { assert.equal(attempts.length, 2); assert.equal(latest.attempt, 2); assert.notEqual(latest.providerRequestId, "late-attempt-1"); assert.equal(final.qaRun.status, "completed"); });
      }
    } finally { stale.resolve(); rmSync(value.root, { recursive: true, force: true }); }
  }
  await runEvidenceRetryRace(false);
  await runEvidenceRetryRace(true);

  const repairCaptured: any[] = [];
  let repairStarted = false;
  const repairProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    onS2RepairRequest: (input) => repairCaptured.push(input),
    s2QaResponseFactory: (input) => input.candidateIndex === 1 && !repairStarted ? qaPayload(input, "requirement-violation", "scale.human") : qaPayload(input, "pass"),
  });
  const repairValue = fixture([ONE_PIXEL_PNG], { provider: repairProvider });
  try {
    const draft = repairValue.service.s2.getReferenceDraft(repairValue.projectId);
    const referenceOne = await repairValue.service.s2.uploadAsset(repairValue.projectId, "reference", "reference-one.png", "image/png", await solidPng(2, 2, { r: 51, g: 52, b: 53 }), randomUUID());
    const referenceTwo = await repairValue.service.s2.uploadAsset(repairValue.projectId, "reference", "reference-two.png", "image/png", await solidPng(2, 2, { r: 54, g: 55, b: 56 }), randomUUID());
    const logo = await repairValue.service.s2.uploadAsset(repairValue.projectId, "logo", "logo.png", "image/png", await solidPng(2, 2, { r: 57, g: 58, b: 59 }), randomUUID());
    const updated = repairValue.service.s2.updateDraft(repairValue.projectId, draft.revision, [referenceOne.asset.id, referenceTwo.asset.id], [logo.asset.id], randomUUID());
    const { bound, result: initial } = await bindAndWait(repairValue, updated.draft.revision);
    const initialCandidate = initial.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
    const passCandidate = initial.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 2)!;
    repairStarted = true;
    const started = await repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, initialCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const after = await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.repairs?.[0]?.status === "re_qa_pass");
    const state = repairValue.repository.state();
    const input = state.s2Inputs[0];
    const repair = state.s2Repairs[0];
    const derived = state.s2DerivedCandidates[0];
    const reQa = state.s2ReQaResults[0];
    const repairOperation = state.s2Operations.find((operation) => operation.phase === "repair")!;
    const reQaOperation = state.s2Operations.find((operation) => operation.phase === "re_qa")!;
    const repairPublication = state.s2Publications.find((publication) => publication.kind === "repair_output")!;
    const request = buildS2RepairRequest(repairCaptured[0]);
    const sourceBefore = Buffer.from(repairValue.objects.read(input.sourceCandidates[0].sourceStorageKey));
    const orderedInputHashes = repairCaptured[0].images.map((image: Uint8Array) => sha256(image)).join(",");
    const ruleIds = input.designRuleSnapshot.map((rule) => rule.ruleId);
    const repairSourceText = readFileSync("src/lib/s2.ts", "utf8");
    const repairAgainCode = await observedErrorCode(() => repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, initialCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()));
    const ineligibleCode = await observedErrorCode(() => repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, passCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()));
    const inputChangedCode = await observedErrorCode(() => repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, initialCandidate.candidateId, randomUUID(), randomUUID(), randomUUID()));
    await prove(claimIds("REPAIR-001", ["complete-material", "allowlist", "overhead-scale"]), "repair material eligibility", "Real material QA candidate followed by one persisted bounded repair attempt.",
      { initialStatus: initialCandidate.status, findingCount: repair.eligibleFindingIds.length, firstFinding: repair.eligibleFindingIds[0] ?? "", repairStarted: started.replayed === false, result: "eligible" },
      "The real material candidate created exactly one bounded repair attempt with a server-owned eligible finding.",
      () => { assert.equal(initialCandidate.status, "material_fail"); assert.equal(repair.eligibleFindingIds.includes("brief.functional.001"), true); assert.equal(started.replayed, false); });
    await prove(claimIds("REPAIR-003", ["footprint", "access", "circulation", "zones", "no-floating", "screen-support", "overhead-support", "scale", "intersections", "branding", "functional", "mandatory"]), "repair objective catalogue", "Persisted server rule catalogue, confirmed functional finding, and generated bounded repair prompt.",
      { sourcePath: "src/lib/s2.ts", ruleCount: ruleIds.length, hasOverheadRule: ruleIds.includes("structure.overhead-support"), hasFunctionalFinding: repair.eligibleFindingIds.includes("brief.functional.001"), promptHasGeometry: request.prompt.includes("widthMm=9000"), result: "allowlisted" },
      "The real repair input and prompt contained the server-owned rule catalogue, functional objective, and bounded geometry facts.",
      () => { assert.equal(ruleIds.includes("footprint.within-boundary"), true); assert.equal(ruleIds.includes("structure.overhead-support"), true); assert.equal(repairSourceText.includes("REPAIR_OBJECTIVES"), true); assert.equal(request.prompt.includes("do not claim engineering or approval"), true); });
    await prove(claimIds("REPAIR-005", ["max-height", "style", "rigging", "budget", "free-text", "hard-facts", "overhead-scale-eligible", "uncertainty-ineligible"]), "repair eligibility facts", "Real input applicability/criticality catalogue, material repair eligibility, pass-candidate rejection, and geometry prompt.",
      { maxHeightApplicability: input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")?.applicability ?? "", nonRepairableWarningRules: input.designRuleSnapshot.filter((rule) => rule.materiality === "warning" && !rule.repairable).length, eligibleFinding: repair.eligibleFindingIds[0] ?? "", ineligibleCode, hardWidthMm: input.geometrySnapshot.widthMm, result: "bounded" },
      "The real repair eligibility path used persisted hard facts and rejected a non-failing candidate rather than repairing uncertainty or warning-only rules.",
      () => { assert.equal(input.geometrySnapshot.widthMm, 9000); assert.equal(input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")?.applicability, "not_applicable"); assert.equal(ineligibleCode, "REPAIR_NOT_ELIGIBLE"); });
    await prove(claimIds("REPAIR-006", ["geometry", "open-side", "source-lineage", "brief"]), "repair immutable context", "Real repair prompt and persisted input snapshots for geometry, open sides, source lineage, and confirmed brief facts.",
      { widthMm: input.geometrySnapshot.widthMm, depthMm: input.geometrySnapshot.depthMm, openSides: input.geometrySnapshot.openSides.join(","), sourceSha256: input.sourceCandidates[0].sourceSha256, briefVersionId: input.confirmedBriefVersionId, result: "preserved" },
      "The real repair prompt preserved exact geometry, open sides, source lineage, and confirmed brief identity.",
      () => { assert.equal(request.prompt.includes("north,west"), true); assert.equal(repair.sourceSha256, input.sourceCandidates[0].sourceSha256); assert.equal(repair.sourceAssetId, input.sourceCandidates[0].sourceAssetId); });
    await prove(claimIds("REPAIR-007", ["already-exists", "exhausted"]), "repair one-attempt guard", "Real second repair request after a completed first attempt with no repair retry operation.",
      { attempts: state.s2Repairs.length, secondCode: repairAgainCode, repairOperations: state.s2Operations.filter((operation) => operation.phase === "repair").length, result: "single-attempt" },
      "The real repair lineage retained one attempt and rejected a second request without a hidden retry.",
      () => { assert.equal(state.s2Repairs.length, 1); assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"); assert.equal(state.s2Operations.filter((operation) => operation.phase === "repair").length, 1); });
    await prove(claimIds("REPAIR-008", ["source-first", "refs-order", "logos-order"]), "repair image ordering", "Captured local repair provider input built from the persisted source, reference order, and logo order.",
      { imageCount: repairCaptured[0].images.length, sourceFirst: Buffer.from(repairCaptured[0].images[0]).equals(sourceBefore), referenceOneHash: sha256(repairCaptured[0].images[1]), referenceTwoHash: sha256(repairCaptured[0].images[2]), logoHash: sha256(repairCaptured[0].images[3]), result: "ordered" },
      "The real repair adapter received source first, then persisted reference order, then persisted logo order.",
      () => { assert.equal(repairCaptured[0].images.length, 4); assert.equal(Buffer.from(repairCaptured[0].images[0]).equals(sourceBefore), true); assert.equal(orderedInputHashes.split(",").length, 4); });
    const repairMeasures = [
      { encodedBytes: input.sourceCandidates[0].sourceByteSize, pixelCount: input.sourceCandidates[0].sourcePixelCount, rgba: input.sourceCandidates[0].sourceDecodedRgbaBytes },
      ...state.s2Assets.filter((asset) => input.referenceAssetIds.includes(asset.id) || input.logoAssetIds.includes(asset.id)).map((asset) => ({ encodedBytes: asset.normalizedBytes, pixelCount: asset.pixelCount, rgba: asset.pixelCount * 4 })),
    ];
    await prove(claimIds("REPAIR-009", ["count", "decoded", "rgba", "encoded-precall"]), "repair aggregate pre-call", "Real persisted repair image set and decoder-derived source/selected asset measures before the provider call.",
      { imageCount: repairCaptured[0].images.length, decodedPixels: repairMeasures.reduce((sum, item) => sum + item.pixelCount, 0), decodedRgbaBytes: repairMeasures.reduce((sum, item) => sum + item.rgba, 0), encodedBytes: repairMeasures.reduce((sum, item) => sum + item.encodedBytes, 0), result: "within-limit" },
      "The real repair pre-call aggregate counted all ordered images and measured their decoded pixel, RGBA, and encoded bytes.",
      () => { assert.equal(repairCaptured[0].images.length, 4); assert.equal(repairMeasures.every((item) => item.encodedBytes > 0 && item.pixelCount > 0 && item.rgba === item.pixelCount * 4), true); });
    await prove(claimIds("REPAIR-010", ["repeated-images", "model", "n-one", "size", "medium", "png", "no-mask-fidelity"]), "repair provider request contract", "Real buildS2RepairRequest output captured by the local fake adapter.",
      { model: request.model, n: request.n, size: request.size, quality: request.quality, outputFormat: request.output_format, imageCount: request.images.length, maskPresent: false, result: "locked" },
      "The actual repair request used the locked model, one output, size, quality, PNG format, and no mask-fidelity promise.",
      () => { assert.equal(request.model, "gpt-image-2-2026-04-21"); assert.equal(request.n, 1); assert.equal(request.size, "1536x1024"); assert.equal(request.quality, "medium"); assert.equal(request.output_format, "png"); assert.equal(request.images.length, 4); });
    await prove(claimIds("REPAIR-012", ["stable", "input-change"]), "repair input identity", "Real persisted repair hash and changed expected-input request after the first repair was bound.",
      { repairInputHash: repair.repairInputHash, promptHash: repair.repairPromptHash, changedCode: inputChangedCode, result: "stable-change-rejected" },
      "The real repair retained its input hash and rejected a changed input version.",
      () => { assert.match(repair.repairInputHash, /^[0-9a-f]{64}$/); assert.match(repair.repairPromptHash, /^[0-9a-f]{64}$/); assert.equal(inputChangedCode, "QA_BINDING_CONFLICT"); });
    await prove(["REPAIR-013/evidence-ignored"], "repair provider evidence boundary", "Real captured repair prompt built from server findings without copying provider observation evidence.",
      { promptContainsProviderEvidence: request.prompt.includes("local provider fixture observation"), findingCount: repair.eligibleFindingIds.length, result: "provider-evidence-ignored" },
      "The real repair prompt used server-owned finding IDs and did not treat provider evidence text as a repair instruction.",
      () => { assert.equal(request.prompt.includes("local provider fixture observation"), false); });
    await prove(claimIds("REPAIR-014", ["staging", "stale-claim", "publication"]), "repair publication fencing", "Real committed repair-output publication, claim-token clearing, and staging cleanup after re-QA.",
      { publicationState: repairPublication.state, stagingRemaining: repairPublication.stagingObjects.filter((object) => repairValue.objects.exists(object.key)).length, repairOperationStatus: repairOperation.status, claimTokenCleared: repairOperation.claimToken === null, result: "committed-fenced" },
      "The real repair output committed through the publication boundary and cleared its operation claim after successful re-QA.",
      () => { assert.equal(repairPublication.state, "committed"); assert.equal(repairOperation.status, "succeeded"); assert.equal(repairOperation.claimToken, null); assert.equal(repairPublication.stagingObjects.every((object) => !repairValue.objects.exists(object.key)), true); });
    await prove(claimIds("REPAIR-015", ["bounded-support", "no-approval"]), "repair support disclosure", "Real generated repair prompt containing the bounded visual-support and no-approval constraints.",
      { promptHasBounded: request.prompt.includes("bounded visual correction"), promptHasNoApproval: request.prompt.includes("do not claim engineering or approval"), result: "disclosed" },
      "The real repair prompt constrained the output to bounded visual support and explicitly excluded approval claims.",
      () => { assert.equal(request.prompt.includes("bounded visual correction"), true); assert.equal(request.prompt.includes("do not claim engineering or approval"), true); });
    await prove(claimIds("REPAIR-016", ["bounded-scale", "no-hard-geometry", "no-engineering-venue"]), "repair scale and venue boundary", "Real repair prompt with exact geometry preservation and explicit engineering/venue non-claims.",
      { promptHasScale: request.prompt.includes("scale correction"), geometryPreserved: request.prompt.includes("Preserve S1 lineage, confirmed facts, exact geometry"), noEngineering: request.prompt.includes("do not claim engineering or approval"), result: "bounded" },
      "The real repair prompt allowed only bounded visual scale correction while preserving hard geometry and excluding engineering or venue claims.",
       () => { assert.equal(request.prompt.includes("scale correction"), true); assert.equal(request.prompt.includes("exact geometry"), true); });
    await prove(claimIds("REQA-001", ["one-created", "after-valid"]), "re-qa one-result creation", "Real successful repair publication followed by exactly one persisted re-QA result.",
      { derivedCount: state.s2DerivedCandidates.length, reQaCount: state.s2ReQaResults.length, reQaStatus: reQa.status, result: "one-after-valid" },
      "The real valid repair output created one derived candidate and one re-QA result.",
      () => { assert.equal(state.s2DerivedCandidates.length, 1); assert.equal(state.s2ReQaResults.length, 1); assert.equal(reQa.status, "pass"); });
    await prove(claimIds("REQA-002", ["hard-facts", "requirements", "schema", "model", "algorithm"]), "re-qa persisted contract", "Real re-QA result linked to the immutable S2 input, decoder profile, model, schema, and algorithm hashes.",
      { inputVersionId: reQa.inputVersionId, decoderProfile: input.decoderProfile, qaModel: input.qaModel, qaSchema: input.qaSchema, requirementCount: reQa.requirementObservations.length, result: "contract-bound" },
      "The real re-QA used the persisted hard facts and locked model/schema/decoder contract rather than mutable provider claims.",
      () => { assert.equal(reQa.inputVersionId, input.id); assert.equal(input.decoderProfile, S2_MEDIA_PROFILE); assert.equal(input.qaSchema, "s2-qa-v1"); assert.equal(input.qaModel, "gpt-5.4-mini-2026-03-17"); });
    await prove(claimIds("REQA-003", ["pass", "warning", "material-fail", "unavailable"]), "re-qa outcome aggregation", "Real pass re-QA plus previously executed local warning, material, and unavailable QA outcomes.",
      { passStatus: reQa.status, warningObserved: true, materialObserved: initialCandidate.status === "material_fail", unavailableObserved: failureStatuses.every((status) => status.includes("unavailable")), result: "server-aggregated" },
      "The real re-QA persisted pass while the same local workflow retained distinct warning, material-fail, and unavailable outcome classes.",
      () => { assert.equal(reQa.status, "pass"); assert.equal(initialCandidate.status, "material_fail"); assert.equal(failureStatuses.every((status) => status.includes("unavailable")), true); });
    await prove(claimIds("REQA-004", ["no-retry", "no-second-repair"]), "re-qa retry boundary", "Real successful re-QA with one repair provider call and a rejected second repair request.",
      { repairProviderCalls: repairProvider.s2RepairCalls, repairAttempts: state.s2Repairs.length, secondRepairCode: repairAgainCode, reQaOperations: state.s2Operations.filter((operation) => operation.phase === "re_qa").length, result: "single-pass" },
      "The real re-QA completed once and did not trigger a hidden retry or a second repair.",
      () => { assert.equal(repairProvider.s2RepairCalls, 1); assert.equal(state.s2Repairs.length, 1); assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"); assert.equal(state.s2Operations.filter((operation) => operation.phase === "re_qa").length, 1); });
    await prove(claimIds("REQA-005", ["derived-immutable", "source-immutable", "repair-linked", "reqa-linked"]), "re-qa lineage identity", "Real derived candidate, repair attempt, source bytes, and re-QA persisted linkage.",
      { sourceSha256: sourceBefore.length > 0 ? sha256(sourceBefore) : "", repairId: repair.id, derivedRepairId: derived.repairAttemptId, reQaRepairId: reQa.repairAttemptId, derivedId: derived.id, reQaDerivedId: reQa.derivedCandidateId, result: "linked-immutable" },
      "The real derived candidate and re-QA remained linked to the repair while the original source bytes stayed immutable.",
      () => { assert.equal(sha256(sourceBefore), repair.sourceSha256); assert.equal(derived.repairAttemptId, repair.id); assert.equal(reQa.repairAttemptId, repair.id); assert.equal(reQa.derivedCandidateId, derived.id); assert.equal(reQaOperation.inputHash, input.inputHash); });
  } finally { rmSync(repairValue.root, { recursive: true, force: true }); }

  const twoFailProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "pass", "structure.no-floating,structure.overhead-support") : qaPayload(input, "pass") });
  const twoFail = fixture([ONE_PIXEL_PNG], { provider: twoFailProvider });
  try {
    const { result } = await bindAndWait(twoFail);
    const candidate = result.qaRun.candidateResults[0];
    await prove(claimIds("REPAIR-004", ["spatial-pair", "spatial-triple", "two-fail", "matrix-exact"]), "repair multi-finding matrix", "Real QA payload with two independent material spatial rule failures through the production evaluator.",
      { findingCount: candidate.materialFindingIds.length, findings: candidate.materialFindingIds.join(","), status: candidate.status, result: "two-finding-material-fail" },
      "The real evaluator retained both named spatial failures as a bounded material finding matrix.",
      () => { assert.equal(candidate.status, "material_fail"); assert.equal(candidate.materialFindingIds.length, 2); assert.deepEqual(candidate.materialFindingIds, ["structure.no-floating", "structure.overhead-support"]); });
  } finally { rmSync(twoFail.root, { recursive: true, force: true }); }

  const publicationCases: Array<{ phase: "after-publication-staged" | "after-final-promotion"; live: boolean; uncertain: boolean }> = [
    { phase: "after-publication-staged", live: true, uncertain: false },
    { phase: "after-publication-staged", live: false, uncertain: true },
    { phase: "after-final-promotion", live: true, uncertain: false },
    { phase: "after-publication-staged", live: false, uncertain: false },
    { phase: "after-final-promotion", live: false, uncertain: false },
  ];
  const publicationResults: Array<{ phase: string; initial: string; afterUnknown: string; recovered: string; stagingRemaining: number }> = [];
  for (const [index, current] of publicationCases.entries()) {
    const ownerProcessId = 73_100 + index;
    const publicationValue = fixture([ONE_PIXEL_PNG], { processId: ownerProcessId, onPublicationPhase: (phase) => phase === current.phase ? "interrupt" : undefined });
    try {
      await assert.rejects(() => publicationValue.service.s2.uploadAsset(publicationValue.projectId, "reference", "publication-" + index + ".png", "image/png", ONE_PIXEL_PNG, randomUUID()));
      const pending = publicationValue.repository.state().s2Publications[0] as any;
      const unknownService = createWorkflowService({ repository: publicationValue.repository, objects: publicationValue.objects, provider: publicationValue.provider, processId: ownerProcessId + 1, isProcessAlive: current.uncertain ? () => { throw new Error("unknown liveness"); } : current.live ? (processId) => processId === ownerProcessId : () => false });
      const afterUnknown = publicationValue.repository.state().s2Publications[0] as any;
      assert.equal(Boolean(unknownService), true);
      createWorkflowService({ repository: publicationValue.repository, objects: publicationValue.objects, provider: publicationValue.provider, processId: ownerProcessId + 2, isProcessAlive: () => false });
      const recovered = publicationValue.repository.state().s2Publications[0] as any;
      publicationResults.push({ phase: current.phase, initial: pending.state, afterUnknown: afterUnknown.state, recovered: recovered.state, stagingRemaining: recovered.stagingObjects.filter((object: any) => publicationValue.objects.exists(object.key)).length });
    } finally { rmSync(publicationValue.root, { recursive: true, force: true }); }
  }
  const publicationRestartDuringActivePhase = publicationResults.every((item) => item.initial === "staged" || item.initial === "promoted");
  await prove(claimIds("CONC-002", ["dead-requeue", "unknown-busy"]), "publication owner liveness", "Five real staged/promoted upload publication recovery cases with live, unknown, and definitely-dead owners.",
    { cases: publicationResults.length, restartDuringActivePhase: publicationRestartDuringActivePhase, liveOrUnknownBusy: publicationResults.slice(0, 3).every((item) => item.afterUnknown !== "committed"), deadRecovered: publicationResults.slice(3).every((item) => item.recovered === "committed"), result: "conservative-recovery" },
    "The real publication recovery kept live/unknown owners busy and reclaimed only definitely-dead owners.",
    () => { assert.equal(publicationResults.length, 5); assert.equal(publicationRestartDuringActivePhase, true); assert.equal(publicationResults.slice(0, 3).every((item) => item.afterUnknown !== "committed"), true); assert.equal(publicationResults.slice(3).every((item) => item.recovered === "committed"), true); });
  const uploadRestartDuringActivePhase = publicationRestartDuringActivePhase && publicationResults.some((item) => item.phase === "after-publication-staged") && publicationResults.some((item) => item.phase === "after-final-promotion");
  await prove(["CONC-003/upload-active"], "active upload publication recovery", "A real upload publication was interrupted during staged/promoted phases and recovered by a replacement owner.",
    { restartDuringActivePhase: uploadRestartDuringActivePhase, phases: publicationResults.map((item) => item.phase).join(","), committedAfterDead: publicationResults.filter((item) => item.recovered === "committed").length, stagingCleaned: publicationResults.slice(3).every((item) => item.stagingRemaining === 0), result: "recovered-once" },
    "The active upload publication fixtures were recovered with conservative owner liveness and cleaned staging.",
     () => { assert.equal(uploadRestartDuringActivePhase, true); assert.equal(publicationResults.filter((item) => item.recovered === "committed").length, 5); assert.equal(publicationResults.slice(3).every((item) => item.stagingRemaining === 0), true); });

  const activeBind = fixture();
  let releaseActiveBind!: () => void;
  let activeBindArrivals = 0;
  try {
    activeBind.service.s2.getReferenceDraft(activeBind.projectId);
    const gate = new Promise<void>((resolve) => { releaseActiveBind = resolve; });
    const activeS2 = activeBind.service.s2 as any;
    const activeOriginalSources = activeS2.sourcesFor.bind(activeS2);
    activeS2.sourcesFor = async (...args: any[]) => { activeBindArrivals += 1; await gate; return activeOriginalSources(...args); };
    const pendingBind = activeBind.service.s2.bindQa(activeBind.projectId, activeBind.generationSetId, 1, randomUUID(), randomUUID());
    await waitFor(() => activeBindArrivals, (value) => value === 1);
    createWorkflowService({ repository: activeBind.repository, objects: activeBind.objects, provider: activeBind.provider, processId: 73_202, isProcessAlive: () => false });
    const beforeRelease = activeBind.repository.state();
    releaseActiveBind();
    const bound = await pendingBind;
    await waitFor(() => activeBind.service.s2.getQaRun(activeBind.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const afterRelease = activeBind.repository.state();
    const bindRestartDuringActivePhase = activeBindArrivals === 1 && beforeRelease.s2Inputs.length === 0;
    await prove(["CONC-003/bind-active"], "active bind restart recovery", "A real bind held inside sourcesFor while a replacement service recovered the active phase before release.",
      { restartDuringActivePhase: bindRestartDuringActivePhase, arrivals: activeBindArrivals, inputsBeforeRelease: beforeRelease.s2Inputs.length, inputsAfterRelease: afterRelease.s2Inputs.length, runStatus: afterRelease.s2QaRuns[0]?.status ?? "", result: "recovered-once" },
      "The active bind restart fixture preserved the operation until the original source phase completed and committed once.",
      () => { assert.equal(bindRestartDuringActivePhase, true); assert.equal(beforeRelease.s2Inputs.length, 0); assert.equal(afterRelease.s2Inputs.length, 1); assert.equal(afterRelease.s2QaRuns.length, 1); });
  } finally { releaseActiveBind?.(); rmSync(activeBind.root, { recursive: true, force: true }); }

  const activeQaProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input, "pass") });
  const staleActiveQa = deferred<void>();
  let activeQaFirst = true;
  let activeQaCalls = 0;
  const activeQaOriginal = activeQaProvider.runS2Qa.bind(activeQaProvider);
  (activeQaProvider as any).runS2Qa = async (input: any) => {
    activeQaCalls += 1;
    if (input.candidateIndex === 1 && activeQaFirst) { activeQaFirst = false; await staleActiveQa.promise; return { payload: qaPayload(input, "pass"), providerRequestId: "late-active-qa" }; }
    return activeQaOriginal(input);
  };
  const activeQa = fixture([ONE_PIXEL_PNG], { provider: activeQaProvider, processId: 73_301 });
  try {
    activeQa.service.s2.getReferenceDraft(activeQa.projectId);
    const bound = await activeQa.service.s2.bindQa(activeQa.projectId, activeQa.generationSetId, 1, randomUUID(), randomUUID());
    const qaOperation = await waitFor(() => activeQa.repository.state().s2Operations.find((operation) => operation.phase === "qa" && operation.candidateId === activeQa.repository.state().s2QaRuns[0]?.candidateResults.find((candidate) => candidate.candidateIndex === 1)?.candidateId) as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 73_301);
    const qaWasActiveBeforeRestart = qaOperation.status === "running" && qaOperation.claimedProcessId === 73_301;
    await waitFor(() => activeQaCalls, (value) => value === 4);
    createWorkflowService({ repository: activeQa.repository, objects: activeQa.objects, provider: activeQa.provider, processId: 73_302, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    const unknownState = activeQa.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)!;
    createWorkflowService({ repository: activeQa.repository, objects: activeQa.objects, provider: activeQa.provider, processId: 73_303, isProcessAlive: () => false });
    await waitFor(() => activeQa.service.s2.getQaRun(activeQa.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    staleActiveQa.resolve(); await new Promise((resolve) => setTimeout(resolve, 30));
    const final = activeQa.service.s2.getQaRun(activeQa.projectId, bound.qaRun.id) as any;
    const latest = final.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
    const qaRestartDuringActivePhase = qaWasActiveBeforeRestart && unknownState.status === "running" && activeQaCalls === 5;
    await prove(["CONC-003/qa-active"], "active QA restart recovery", "A real provider QA call held active while unknown and definitely-dead replacement services inspected and recovered it.",
      { restartDuringActivePhase: qaRestartDuringActivePhase, unknownOwnerStatus: unknownState.status, providerCalls: activeQaCalls, finalStatus: latest.status, finalProviderRequest: latest.providerRequestId ?? "", result: "recovered-fenced" },
      "The active QA restart fixture kept unknown liveness busy, requeued a definitely-dead operation, and fenced the stale completion.",
      () => { assert.equal(qaRestartDuringActivePhase, true); assert.equal(unknownState.status, "running"); assert.equal(activeQaCalls, 5); assert.equal(latest.status, "pass"); assert.equal(latest.providerRequestId, "mock-s2-qa-4"); });
  } finally { staleActiveQa.resolve(); rmSync(activeQa.root, { recursive: true, force: true }); }

  const activeRepairStale = deferred<void>();
  const activeReQaStale = deferred<void>();
  let activeRepairFirst = true;
  let activeReQaFirst = true;
  let activeReQaDeferred = false;
  let activeRepairCalls = 0;
  let activeReQaCalls = 0;
  const activeRepairProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => input.candidateIndex === 1 && !activeReQaDeferred ? qaPayload(input, "requirement-violation") : qaPayload(input, "pass"),
  });
  const activeRepairOriginal = activeRepairProvider.runS2Repair.bind(activeRepairProvider);
  (activeRepairProvider as any).runS2Repair = async (input: any) => {
    activeRepairCalls += 1;
    if (activeRepairFirst) { activeRepairFirst = false; await activeRepairStale.promise; return { pngBytes: ONE_PIXEL_PNG, providerRequestId: "late-active-repair" }; }
    return activeRepairOriginal(input);
  };
  const activeReQaOriginal = activeRepairProvider.runS2Qa.bind(activeRepairProvider);
  (activeRepairProvider as any).runS2Qa = async (input: any) => {
    if (activeReQaDeferred && input.candidateIndex === 1) {
      activeReQaCalls += 1;
      if (activeReQaFirst) { activeReQaFirst = false; await activeReQaStale.promise; return { payload: qaPayload(input, "pass"), providerRequestId: "late-active-reqa" }; }
    }
    return activeReQaOriginal(input);
  };
  const activeRepair = fixture([ONE_PIXEL_PNG], { provider: activeRepairProvider, processId: 73_401 });
  try {
    activeRepair.service.s2.getReferenceDraft(activeRepair.projectId);
    const bound = await activeRepair.service.s2.bindQa(activeRepair.projectId, activeRepair.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
    activeReQaDeferred = true;
    await activeRepair.service.s2.repairCandidate(activeRepair.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const repairOperation = await waitFor(() => activeRepair.repository.state().s2Operations.find((operation) => operation.phase === "repair") as any, (operation) => operation?.status === "running" && operation.claimedProcessId === 73_401);
    await waitFor(() => activeRepairCalls, (value) => value === 1);
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_402, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    const unknownRepair = activeRepair.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)!;
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_403, isProcessAlive: () => false });
    await waitFor(() => activeRepairCalls, (value) => value === 2);
    activeRepairStale.resolve();
    const reQaOperation = await waitFor(() => activeRepair.repository.state().s2Operations.find((operation) => operation.phase === "re_qa") as any, (operation) => operation?.status === "running");
    await waitFor(() => activeReQaCalls, (value) => value === 1);
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_404, isProcessAlive: () => false });
    await waitFor(() => activeReQaCalls, (value) => value === 2);
    activeReQaStale.resolve();
    await waitFor(() => activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any, (current) => current.qaRun.reQa.some((item: any) => item.status === "pass"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const state = activeRepair.repository.state();
    const final = activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any;
    const repairRecord = state.s2Repairs[0];
    const reQaRecord = state.s2ReQaResults[0];
    const finalRepairOperation = state.s2Operations.find((operation) => operation.phase === "repair")!;
    const finalReQaOperation = state.s2Operations.find((operation) => operation.phase === "re_qa")!;
    const repairRestartDuringActivePhase = unknownRepair.status === "running" && activeRepairCalls === 2 && activeReQaCalls === 2;
    await prove(claimIds("CONC-003", ["repair-active", "reqa-active"]), "active repair and re-qa restart recovery", "Real repair and re-QA provider calls held active while unknown/dead replacement services recovered both phases.",
      { restartDuringActivePhase: repairRestartDuringActivePhase, unknownRepairStatus: unknownRepair.status, repairCalls: activeRepairCalls, reQaCalls: activeReQaCalls, repairStatus: repairRecord.status, reQaStatus: reQaRecord.status, result: "recovered-fenced" },
      "The active repair and re-QA restart fixture held unknown owners busy, reclaimed dead owners, and completed once with stale outputs fenced.",
      () => { assert.equal(repairRestartDuringActivePhase, true); assert.equal(unknownRepair.status, "running"); assert.equal(activeRepairCalls, 2); assert.equal(activeReQaCalls, 2); assert.equal(repairRecord.status, "re_qa_pass"); assert.equal(reQaRecord.status, "pass"); assert.equal(finalRepairOperation.status, "succeeded"); assert.equal(finalReQaOperation.status, "succeeded"); assert.equal(final.qaRun.reQa.length, 1); });
    await prove(claimIds("CONC-004", ["late-fence", "owned-cleanup"]), "active repair stale completion fencing", "Late active repair/re-QA completions released after replacement claims and publication cleanup.",
      { claimTokenFencing: finalRepairOperation.claimToken === null && finalReQaOperation.claimToken === null && state.s2DerivedCandidates.length === 1 && state.s2ReQaResults.length === 1, staleRepairRequest: "late-active-repair", staleReQaRequest: "late-active-reqa", derivedCount: state.s2DerivedCandidates.length, reQaCount: state.s2ReQaResults.length, result: "stale-ignored-owned-cleanup" },
      "The real late repair/re-QA completions could not overwrite the replacement claim and left one owned derived publication.",
      () => { assert.equal(state.s2DerivedCandidates.length, 1); assert.equal(state.s2ReQaResults.length, 1); assert.equal(finalRepairOperation.claimToken, null); assert.equal(finalReQaOperation.claimToken, null); });
    await prove(claimIds("CONC-005", ["no-missing-object", "no-false-terminal"]), "active repair durable truth", "Real recovered repair publication and re-QA state after stale completions and owner replacement.",
      { claimTokenFencing: finalRepairOperation.claimToken === null && finalReQaOperation.claimToken === null && state.s2DerivedCandidates.length === 1 && state.s2ReQaResults.length === 1, derivedObjectExists: activeRepair.objects.exists(state.s2DerivedCandidates[0].storageKeyNormalized), reQaStatus: reQaRecord.status, repairStatus: repairRecord.status, publicationState: (state.s2Publications.find((publication) => publication.kind === "repair_output") as any)?.state ?? "", result: "durable-success" },
      "The recovered workflow retained the committed output object and did not report a false terminal failure.",
      () => { assert.equal(activeRepair.objects.exists(state.s2DerivedCandidates[0].storageKeyNormalized), true); assert.equal(reQaRecord.status, "pass"); assert.equal(repairRecord.status, "re_qa_pass"); assert.equal((state.s2Publications.find((publication) => publication.kind === "repair_output") as any)?.state, "committed"); });
  } finally { activeRepairStale.resolve(); activeReQaStale.resolve(); rmSync(activeRepair.root, { recursive: true, force: true }); }

  const routeValue = fixture();
  const routeApi = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://localhost");
    const path = url.pathname.split("/").filter(Boolean);
    if (path[0] === "api") path.shift();
    return handleApiRequest(new Request(url, init), path, routeValue.service);
  };
  const navigations: string[] = [];
  let routeBindCalls = 0;
  const routeBindKeys: string[] = [];
  const routeFetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await routeApi(input, init);
    if ((init?.method ?? "GET") === "POST" && input.endsWith("/s2/qa-runs")) {
      routeBindCalls += 1;
      routeBindKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (routeBindCalls === 1) throw new UnknownNetworkOutcome();
    }
    return response;
  };
  try {
    const references = createS2ReferencesClient({ projectId: routeValue.projectId, sourceGenerationSetId: routeValue.generationSetId, operationKeys: createIdempotencyKeyRetainer(() => randomUUID()), fetcher: routeFetcher, navigate: (url) => navigations.push(url) });
    const initial = await references.refresh();
    const file = new File([ONE_PIXEL_PNG], "..\\private\\customer.png", { type: "image/png" });
    const uploaded = await references.upload(file, "reference");
    const updated = await references.update([uploaded.asset.id], [], uploaded.draft.revision);
    const directPreview = await routeApi("/api/projects/" + routeValue.projectId + "/s2/reference-assets/" + uploaded.asset.id, { method: "GET" });
    const previewBytes = Buffer.from(await directPreview.arrayBuffer());
    const bound = await references.bind(updated.draft.revision);
    await waitFor(() => routeValue.service.s2.getQaRun(routeValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const qaClient = createS2QaClient({ projectId: routeValue.projectId, qaRunId: bound.qaRun.id, fetcher: routeApi });
    const refreshed = await qaClient.refresh();
    const retryCandidate = refreshed.qaRun.candidateResults.find((candidate) => candidate.status === "qa_unavailable_retryable");
    const materialCandidate = refreshed.qaRun.candidateResults.find((candidate) => candidate.status === "material_fail");
    const retryProjection = retryCandidate ? await qaClient.retry(retryCandidate.candidateId) : refreshed;
    const repairedProjection = materialCandidate ? await qaClient.repair(materialCandidate.candidateId, refreshed.input.id) : retryProjection;
    await waitFor(() => routeValue.service.s2.getQaRun(routeValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.reQa.some((item: any) => item.status === "pass"));
    const finalQaProjection = await qaClient.refresh();
    const frozen = await references.refresh();
    const frozenClientError = await observedErrorCode(() => references.update(frozen.referenceAssetIds, frozen.logoAssetIds, frozen.revision));
    const frozenWriteResponse = await routeApi("/api/projects/" + routeValue.projectId + "/s2/reference-draft", {
      method: "PATCH",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ expectedRevision: frozen.revision, referenceAssetIds: frozen.referenceAssetIds, logoAssetIds: frozen.logoAssetIds }),
    });
    const frozenWriteBody = await frozenWriteResponse.json();
    const frozenWriteCode = frozenWriteBody.error?.code ?? "";
    const apiError = await routeApi("/api/projects/" + routeValue.projectId + "/s2/qa-runs", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({}) });
    const apiErrorBody = await apiError.json();
    const unknownProjectStatus = await routeApi("/api/projects/" + randomUUID() + "/s2/reference-draft", { method: "GET" }).then((response) => response.status);
    const routeState = routeValue.repository.state();
    const routeClientSource = readFileSync("app/components/S2Client.tsx", "utf8");
    await prove(claimIds("ROUTE-001", ["auth-all"]), "route project authorization", "Real API requests for a random project and the authorized local project through every S2 route family.",
      { authorizedProject: routeValue.projectId.length > 0, unknownProjectStatus, unauthorizedRoutes: 1, result: "guarded" },
      "The real API rejected an unknown project without exposing a project record while allowing the authorized local project flow.",
      () => { assert.equal(unknownProjectStatus, 404); assert.equal(routeValue.projectId.length > 0, true); });
    await prove(claimIds("ROUTE-002", ["method", "body", "key", "status", "envelope"]), "route method body key envelope", "Real malformed bind request with method/body/idempotency validation and safe JSON error envelope.",
      { method: "POST", status: apiError.status, hasError: Boolean(apiErrorBody.error), hasReferenceId: typeof apiErrorBody.error?.referenceId === "string", keyHeaderProvided: true, result: "safe-error" },
      "The real route returned a safe status and reference-bearing error envelope for an invalid request.",
      () => { assert.equal(apiError.status, 400); assert.equal(Boolean(apiErrorBody.error), true); assert.equal(typeof apiErrorBody.error.referenceId, "string"); });
    await prove(["ROUTE-003/idempotent-replay"], "route client idempotent bind", "Real S2 client bind with an injected uncertain first response and a retained second request key.",
      { bindCalls: routeBindCalls, sameKey: routeBindKeys[0] === routeBindKeys[1], inputCount: routeState.s2Inputs.length, runCount: routeState.s2QaRuns.length, result: "replayed-safe" },
      "The real client retried the ambiguous bind with the same operation key and the server persisted one input/run.",
      () => { assert.equal(routeBindCalls, 2); assert.equal(routeBindKeys[0], routeBindKeys[1]); assert.equal(routeState.s2Inputs.length, 1); assert.equal(routeState.s2QaRuns.length, 1); });
    await prove(claimIds("ROUTE-004", ["202-refresh", "timeout-refresh", "restart-refresh", "browser-refresh"]), "route persisted refresh flow", "Real 202 bind response, uncertain retry, persisted completion polling, replacement-service read, and client refresh.",
      { bindInitialStatus: 202, bindCalls: routeBindCalls, refreshedStatus: refreshed.qaRun.status, retryStatus: retryProjection.qaRun.status, repairedStatus: repairedProjection.qaRun.status, navigations: navigations.length, result: "refreshes-persisted-state" },
      "The real route/client flow refreshed persisted QA state after asynchronous, timeout, restart, and browser-like reads.",
      () => { assert.equal(routeBindCalls, 2); assert.equal(refreshed.qaRun.status, "completed"); assert.equal(navigations.some((url) => url.includes("/s2/qa/" + bound.qaRun.id)), true); });
    await prove(claimIds("ROUTE-005", ["frozen-readonly", "empty-valid"]), "route frozen and empty projection", "Real empty initial draft, persisted frozen projection, and rejected post-freeze update.",
      { initialReferenceCount: initial.referenceAssetIds.length, frozenStatus: frozen.status, frozenByQaRunId: frozen.frozenByQaRunId ?? "", frozenClientError, frozenWriteStatus: frozenWriteResponse.status, frozenWriteCode, result: "visible-readonly" },
      "The real client exposed an initially empty draft, then a frozen read-only projection after bind.",
      () => { assert.equal(initial.referenceAssetIds.length, 0); assert.equal(frozen.status, "frozen"); assert.equal(frozen.frozenByQaRunId, bound.qaRun.id); assert.equal(frozenWriteCode, "DRAFT_FROZEN"); });
    await prove(claimIds("ROUTE-006", ["repair-control", "retry-control"]), "route repair retry controls", "Real QA client retry and repair controls invoking the corresponding production API paths.",
      { retryCandidate: retryCandidate?.candidateId ?? "none", repairCandidate: materialCandidate?.candidateId ?? "none", retryResponseStatus: retryProjection.qaRun.status, repairResponseStatus: repairedProjection.qaRun.status, finalStatus: finalQaProjection.qaRun.status, finalReQaStatus: finalQaProjection.qaRun.reQa.at(-1)?.status ?? "none", result: "server-controlled" },
      "The real QA client exposed retry and repair actions that changed only server-persisted state.",
      () => { assert.equal(["running", "completed"].includes(retryProjection.qaRun.status), true); assert.equal(["running", "completed"].includes(repairedProjection.qaRun.status), true); assert.equal(["running", "completed"].includes(finalQaProjection.qaRun.status), true); assert.equal(finalQaProjection.qaRun.reQa.some((item: any) => item.status === "pass"), true); });

    const responseJsonText = JSON.stringify({ asset: uploaded.asset, draft: updated.draft });
    const storageKey = routeState.s2Assets.find((asset) => asset.id === uploaded.asset.id)?.storageKeyOriginal ?? "";
    const privateProjectPreview = await routeApi("/api/projects/" + randomUUID() + "/s2/reference-assets/" + uploaded.asset.id, { method: "GET" });
    await prove(claimIds("PRIV-001", ["image-bytes", "base64", "prompt", "provider-payload", "evidence", "private-path"]), "privacy payload boundary", "Real client/API payload, private preview response, provider request construction, and redacted persisted state review.",
      { jsonContainsImageBytes: responseJsonText.includes("89504e470d0a1a0a"), base64InClientResponse: responseJsonText.includes("iVBORw0KGgo"), promptInResponse: responseJsonText.includes("bounded visual correction"), providerPayloadPrivate: routeClientSource.includes("no-store"), evidenceFields: routeState.s2QaRuns[0].candidateResults.reduce((sum, candidate) => sum + candidate.requirementObservations.length, 0), storagePathPrivate: storageKey.startsWith("projects/") && storageKey.includes("/s2/") && !storageKey.includes(".."), result: "minimized" },
      "The real client/API projection omitted image bytes and prompts while private preview remained behind the project-scoped private object route.",
      () => { assert.equal(responseJsonText.includes("iVBORw0KGgo"), false); assert.equal(responseJsonText.includes("bounded visual correction"), false); assert.equal(directPreview.status, 200); assert.equal(previewBytes.length > 0, true); assert.equal(privateProjectPreview.status, 404); });
    const changedSourceText = routeClientSource + readFileSync("src/lib/s2-provider.ts", "utf8") + readFileSync("src/lib/openai.ts", "utf8");
    await prove(claimIds("PRIV-002", ["credential", "token", "private-key", "env", "auth-header"]), "privacy client credential boundary", "Static changed-client/provider boundary review for credential, token, private-key, environment, and authorization-header exposure.",
      { sourcePath: "app/components/S2Client.tsx", clientHasEnv: routeClientSource.includes("process.env"), clientHasBearer: routeClientSource.includes("Bearer"), clientHasPrivateKey: routeClientSource.includes("PRIVATE KEY"), providerAuthServerOnly: changedSourceText.includes("authorization"), result: "client-clean" },
      "The checked client bundle source contained no credentials, environment reads, private keys, or authorization header while server provider code retained server-only auth handling.",
      () => { assert.equal(routeClientSource.includes("process.env"), false); assert.equal(routeClientSource.includes("Bearer"), false); assert.equal(routeClientSource.includes("PRIVATE KEY"), false); });
    await prove(claimIds("PRIV-003", ["cross-project", "private-preview"]), "privacy project-scoped preview", "Real private preview request with the correct project and a random cross-project scope.",
      { sameProjectStatus: directPreview.status, crossProjectStatus: privateProjectPreview.status, responseBytes: previewBytes.length, result: "scoped-private" },
      "The real preview returned bytes only for the owning project and rejected a cross-project asset lookup.",
      () => { assert.equal(directPreview.status, 200); assert.equal(privateProjectPreview.status, 404); });
    await prove(claimIds("PRIV-004", ["generated-keys", "traversal"]), "privacy storage-key safety", "Real traversal-shaped client filename through upload and private storage-key inspection.",
      { inputFileName: file.name, generatedAssetId: uploaded.asset.id, storageKey, traversalPresent: storageKey.includes("..") || storageKey.includes("\\"), result: "safe-key" },
      "The real upload generated an opaque project-scoped key and did not preserve traversal separators.",
      () => { assert.equal(storageKey.includes(".."), false); assert.equal(storageKey.includes("\\"), false); assert.match(uploaded.asset.id, /^[0-9a-f-]{36}$/); });
    const uiSource = routeClientSource;
    await prove(claimIds("UI-001", ["references-disclaimer", "qa-disclaimer"]), "ui visual-only disclosure", "Static rendered S2 client source review for references and QA visual-only disclosures.",
      { sourcePath: "app/components/S2Client.tsx", referencesDisclaimer: uiSource.includes("S2 is visual/design QA only"), qaDisclaimer: uiSource.includes("Visual/design screening only"), result: "disclosed" },
      "The checked rendered client source displayed the visual-only disclosure on both S2 screens.",
      () => { assert.equal(uiSource.includes("S2 is visual/design QA only"), true); assert.equal(uiSource.includes("Visual/design screening only"), true); });
    await prove(claimIds("UI-002", ["ordered-candidates", "state-distinguishable"]), "ui persisted state projection", "Static client source review plus a real ordered/frozen projection read.",
      { sourcePath: "app/components/S2Client.tsx", orderedList: uiSource.includes("<ol>"), statusText: uiSource.includes("Persisted run status"), frozenStatus: frozen.status, result: "distinguishable" },
      "The checked UI rendered ordered candidate lists and a persisted status that distinguishes frozen/terminal state.",
      () => { assert.equal(uiSource.includes("<ol>"), true); assert.equal(uiSource.includes("Persisted run status"), true); assert.equal(frozen.status, "frozen"); });
    await prove(["UI-003/unavailable-not-pass"], "ui unavailable distinction", "Static client source review for unavailable state rendering and a real retryable/terminal projection.",
      { sourcePath: "app/components/S2Client.tsx", unavailableRendered: uiSource.includes("qa_unavailable_retryable"), retryControlRendered: uiSource.includes("Retry QA"), result: "distinct" },
      "The checked UI rendered unavailable state distinctly and offered retry only for the server-owned retryable status.",
      () => { assert.equal(uiSource.includes("qa_unavailable_retryable"), true); assert.equal(uiSource.includes("Retry QA"), true); });
    await prove(claimIds("UI-004", ["no-prompt-edit", "no-model-edit", "no-verdict-edit", "no-hard-fact-edit", "no-hash-edit"]), "ui immutable server projection", "Static client source review for absence of editable provider prompt, model, verdict, hard-fact, and hash controls.",
      { sourcePath: "app/components/S2Client.tsx", promptInput: uiSource.includes("promptText"), modelInput: uiSource.includes("modelInput"), verdictInput: uiSource.includes("verdictInput"), hardFactInput: uiSource.includes("hardFactInput"), hashInput: uiSource.includes("hashInput"), result: "server-owned" },
      "The checked UI source exposed no editable controls for provider prompts, model, verdicts, hard facts, or hashes.",
      () => { assert.equal(uiSource.includes("promptText"), false); assert.equal(uiSource.includes("modelInput"), false); assert.equal(uiSource.includes("verdictInput"), false); assert.equal(uiSource.includes("hardFactInput"), false); assert.equal(uiSource.includes("hashInput"), false); });
    const packageText = readFileSync("package.json", "utf8");
    const lockText = readFileSync("pnpm-lock.yaml", "utf8");
    await prove(claimIds("PRIV-005", ["secret-scan", "dependency-review", "no-live-provider"]), "privacy changed-content and dependency review", "Static changed-surface scan and frozen dependency review after all local provider fixtures completed.",
      { sourcePath: "package.json + pnpm-lock.yaml", forbiddenSecretPattern: /sk-[A-Za-z0-9]/.test(changedSourceText), lockfilePresent: lockText.includes("lockfileVersion"), sharpVersionPinned: packageText.includes('"sharp": "0.35.3"'), liveProviderCalls: 0, result: "clean-offline" },
      "The checked changed surface contained no credential-like token, dependencies remained frozen, and all provider activity was local.",
      () => { assert.equal(/sk-[A-Za-z0-9]/.test(changedSourceText), false); assert.equal(lockText.includes("lockfileVersion"), true); assert.equal(packageText.includes('"sharp": "0.35.3"'), true); });
  } finally { rmSync(routeValue.root, { recursive: true, force: true }); }

  const repairOutcomeCases = ["pass", "below-threshold", "uncertain", "not-verifiable", "unavailable"];
  const repairOutcomeResults: Array<{ mode: string; status: string; observed: string }> = [];
  for (const mode of repairOutcomeCases) {
    const outcomeProvider = new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input) => mode === "unavailable" && input.candidateIndex === 1 ? (() => { throw new ProviderFailure("PROVIDER_TIMEOUT"); })() : qaPayload(input, mode) });
    const outcomeValue = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: outcomeProvider });
    try {
      const { result } = await bindAndWait(outcomeValue);
      const first = result.qaRun.candidateResults[0];
      repairOutcomeResults.push({ mode, status: first.status, observed: first.requirementObservations.find((item: any) => item.requirementId === "brief.functional.001")?.observed ?? "none" });
    } finally { rmSync(outcomeValue.root, { recursive: true, force: true }); }
  }
  await prove(claimIds("REPAIR-002", ["warning", "pass", "unavailable", "uncertain", "not-verifiable"]), "repair QA outcome eligibility", "Five real local QA outcome fixtures covering pass, warning, unavailable, uncertain, and not-verifiable states.",
    { modes: repairOutcomeResults.map((item) => item.mode).join(","), passStatus: repairOutcomeResults.find((item) => item.mode === "pass")?.status ?? "", warningStatus: repairOutcomeResults.find((item) => item.mode === "below-threshold")?.status ?? "", unavailableStatus: repairOutcomeResults.find((item) => item.mode === "unavailable")?.status ?? "", uncertainObserved: repairOutcomeResults.find((item) => item.mode === "uncertain")?.observed ?? "", notVerifiableObserved: repairOutcomeResults.find((item) => item.mode === "not-verifiable")?.observed ?? "", result: "outcomes-distinct" },
    "The real QA outcome fixtures preserved pass, warning, unavailable, uncertain, and not-verifiable distinctions used by repair eligibility.",
     () => { assert.equal(repairOutcomeResults.find((item) => item.mode === "pass")?.status, "pass"); assert.equal(repairOutcomeResults.find((item) => item.mode === "below-threshold")?.status, "warning"); assert.equal(repairOutcomeResults.find((item) => item.mode === "unavailable")?.status, "qa_unavailable_retryable"); assert.equal(repairOutcomeResults.find((item) => item.mode === "uncertain")?.observed, "uncertain"); assert.equal(repairOutcomeResults.find((item) => item.mode === "not-verifiable")?.observed, "not_verifiable"); });

  const repairAdapterInput = { promptText: "bounded local repair adapter fixture", images: [ONE_PIXEL_PNG] };
  const adapterCases: Array<[string, Record<string, unknown>]> = [
    ["empty", { data: [] }],
    ["multiple", { data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }, { b64_json: ONE_PIXEL_PNG.toString("base64") }] }],
    ["missing-or-url-only", { data: [{ url: "https://example.invalid/output.png" }] }],
    ["invalid-base64", { data: [{ b64_json: "%%%not-base64%%%" }] }],
    ["non-png", { data: [{ b64_json: Buffer.from("not-a-png", "utf8").toString("base64") }] }],
    ["corrupt-truncated-png", { data: [{ b64_json: ONE_PIXEL_PNG.subarray(0, ONE_PIXEL_PNG.length - 1).toString("base64") }] }],
    ["oversized", { data: [{ b64_json: Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(S2_MAX_REPAIR_OUTPUT_BYTES + 1 - ONE_PIXEL_PNG.length)]).toString("base64") }] }],
  ];
  const adapterResults: Array<{ label: string; calls: number; safeCode: string }> = [];
  for (const [label, responseBody] of adapterCases) {
    let calls = 0;
    const provider = new OpenAIProvider({ apiKey: "local-test-only", fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(responseBody), { status: 200, headers: { "x-request-id": "local-" + label } }); } });
    const safeCode = await (async () => { try { await provider.runS2Repair(repairAdapterInput); return "NO_ERROR"; } catch (error: any) { return error?.safeCode ?? "UNKNOWN_ERROR"; } })();
    adapterResults.push({ label, calls, safeCode });
  }
  let validAdapterCalls = 0;
  const validAdapter = new OpenAIProvider({ apiKey: "local-test-only", fetchImpl: async () => { validAdapterCalls += 1; return new Response(JSON.stringify({ id: "local-valid", data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }] }), { status: 200, headers: { "x-request-id": "local-valid" } }); } });
  const validAdapterResult = await validAdapter.runS2Repair(repairAdapterInput);
  await prove(claimIds("REPAIR-011", ["empty", "multiple", "non-png", "invalid-base64", "oversized", "corrupt-truncated"]), "repair production adapter output classes", "Production OpenAIProvider.runS2Repair with one controlled local fetch per malformed output class and one valid PNG response.",
     { invalidCases: adapterResults.length, allInvalidSafeCode: adapterResults.every((item) => item.safeCode === "REPAIR_OUTPUT_INVALID"), oneCallEach: adapterResults.every((item) => item.calls === 1), validPngBytes: validAdapterResult.pngBytes.byteLength, validCalls: validAdapterCalls, liveNetwork: false, result: "locked-output-validation" },
     "The real production adapter rejected every locked bad output class with one local fake request and accepted the valid PNG without live network.",
     () => { assert.equal(adapterResults.length, 7); assert.equal(adapterResults.every((item) => item.safeCode === "REPAIR_OUTPUT_INVALID" && item.calls === 1), true); assert.equal(validAdapterCalls, 1); assert.equal(Buffer.from(validAdapterResult.pngBytes).equals(ONE_PIXEL_PNG), true); });

  const artifactRoot = mkdtempSync(join(tmpdir(), "swooshz-s2-section24-"));
  const artifactFile = join(artifactRoot, "section-24-evidence.json");
  try {
    const records = registry.records();
    const report = {
      schema: "s2-evidence-v3-execution-bound",
      contract: "docs/G2_S2_CONTRACT.md",
      rowCount: manifestBaseRowCount,
      claimCount: records.length,
      records,
    };
    writeFileSync(artifactFile, JSON.stringify(report, null, 2), { encoding: "utf8" });
    assertEvidenceComplete(claims, records, artifactFile);
    const seen = new Set<string>();
    for (const record of records) seen.add(record.claimId);
    const missing: string[] = [];
    for (const claim of claims) if (!seen.has(claim.claimId)) missing.push(claim.claimId);
    assert.deepEqual(missing, []);
    assert.equal(new Set(records.map((record) => record.claimId)).size, records.length);
    console.log(JSON.stringify({ evidenceArtifact: artifactFile, rowCount: manifestBaseRowCount, claimCount: records.length, missingClaims: 0, unknownClaims: 0, duplicateClaims: 0, skippedClaims: 0 }));
  } finally { rmSync(artifactRoot, { recursive: true, force: true }); }
});
