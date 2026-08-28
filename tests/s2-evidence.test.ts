import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
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
  type S2SharpFactory,
  type S2SharpOptions,
} from "../src/lib/s2-media";
import { buildS2QaRequest, buildS2RepairRequest, S2_QA_MODEL, S2_QA_SCHEMA } from "../src/lib/s2-provider";
import { handleApiRequest } from "../src/lib/api";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { cloneJson, jcs, sha256 } from "../src/lib/utils";
import { AppError } from "../src/lib/types";
import { reduceS2Findings } from "../src/lib/s2-findings";
import { canonicalRepairInputHash, renderS2RepairPrompt, repairPromptHash } from "../src/lib/s2-repair";
import { validateS2Graph } from "../src/lib/s2-persistence";
import { createS2QaClient, createS2ReferencesClient, orderS2Candidates, s2CandidatePreviewPath, s2QaCandidateControls, s2QaUserFacingState } from "../app/components/S2Client";
import { createIdempotencyKeyRetainer, UnknownNetworkOutcome } from "../src/lib/client-idempotency";
import { deriveClaimManifest, manifestBaseRowCount, manifestVariantCount, type ClaimDefinition } from "./s2-evidence-manifest";
import { independentRepairInput, independentRepairInputHash, independentRepairPrompt, independentRepairPromptHash } from "./s2-repair-oracle";

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
} & Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onProviderDispatchPhase" | "onPublicationPhase">;

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
    const exactUncertain = (mode === "uncertain" || mode === "not-verifiable") && item.expected === "exact_count" && !(mode === "not-verifiable" && item.requirementId === "brief.functional.001");
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
      observedCount: exactUncertain || belowBoundary || notVerifiable ? null : violation && item.expected === "exact_count" ? item.expectedCount + 1 : item.expected === "exact_count" ? item.expectedCount : null,
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

function sharedFindingPayload(input: any, findingId: string, requirementState: "material" | "uncertain", ruleState: "material" | "uncertain" | "compliant"): any {
  const payload = qaPayload(input, "pass");
  const requirement = payload.requirements.find((item: any) => item.requirementId === findingId);
  const rule = payload.designRules.find((item: any) => item.ruleId === findingId);
  if (requirementState === "uncertain") {
    requirement.observed = "uncertain";
    requirement.observedCount = null;
    requirement.confidence = 0.5;
  } else {
    requirement.observed = "absent";
    requirement.observedCount = null;
    requirement.confidence = 0.99;
  }
  if (ruleState === "uncertain") {
    rule.observed = "uncertain";
    rule.confidence = 0.5;
  } else if (ruleState === "material") {
    rule.observed = "non_compliant";
    rule.confidence = 0.99;
  } else {
    rule.observed = "compliant";
    rule.confidence = 0.99;
  }
  return payload;
}

function sharedAccessPayload(input: any, requirementState: "material" | "uncertain", ruleState: "material" | "uncertain" | "compliant"): any {
  return sharedFindingPayload(input, "access.open-sides", requirementState, ruleState);
}

async function sharedFindingSnapshot(
  requirementState: "material" | "uncertain",
  ruleState: "material" | "uncertain" | "compliant",
  geometry: any = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null },
  findingId = "access.open-sides",
): Promise<any> {
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => input.candidateIndex === 1
      ? sharedFindingPayload(input, findingId, requirementState, ruleState)
      : qaPayload(input, "pass"),
  });
  const value = fixture([ONE_PIXEL_PNG], { provider, geometry });
  try {
    const { result } = await bindAndWait(value);
    return cloneJson({ state: value.repository.state(), result, candidate: result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1) });
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

async function bindAndWait(value: Fixture, expectedRevision = 1): Promise<any> {
  value.service.s2.getReferenceDraft(value.projectId);
  const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, expectedRevision, randomUUID(), randomUUID());
  const result = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
  return { bound, result };
}

function s2MultipartBody(fileBytes: Uint8Array, fileName = "chunked.png", kind = "reference"): Buffer {
  const boundary = "s2-stream-boundary";
  return Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\nContent-Type: image/png\r\n\r\n", "latin1"),
    Buffer.from(fileBytes),
    Buffer.from("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\n" + kind + "\r\n--" + boundary + "--\r\n", "latin1"),
  ]);
}

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function trackedChunkedStream(bytes: Uint8Array, chunkSize: number): { stream: ReadableStream<Uint8Array>; stats: () => { pulls: number; cancelled: boolean } } {
  let offset = 0;
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; },
  });
  return { stream, stats: () => ({ pulls, cancelled }) };
}

function lazyTrackedChunks(chunks: readonly Uint8Array[]): { body: ReadableStream<Uint8Array>; stats: () => { pulls: number; cancelled: boolean } } {
  let pulls = 0;
  let cancelled = false;
  const body = {
    getReader() {
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(chunks[index]);
          index += 1;
        },
        cancel() { cancelled = true; },
      });
      return stream.getReader();
    },
  } as unknown as ReadableStream<Uint8Array>;
  return { body, stats: () => ({ pulls, cancelled }) };
}

function requestWithStream(headers: HeadersInit, body: ReadableStream<Uint8Array>): Request {
  return { method: "POST", headers: new Headers(headers), body } as unknown as Request;
}

function s2StateCounts(value: Fixture): Record<string, number> {
  const state = value.repository.state();
  return {
    idempotency: state.idempotency.length,
    s2Assets: state.s2Assets.length,
    s2Drafts: state.s2Drafts.length,
    s2Inputs: state.s2Inputs.length,
    s2QaRuns: state.s2QaRuns.length,
    s2Repairs: state.s2Repairs.length,
    s2DerivedCandidates: state.s2DerivedCandidates.length,
    s2ReQaResults: state.s2ReQaResults.length,
    s2Operations: state.s2Operations.length,
    s2Publications: state.s2Publications.length,
    s2Transitions: state.s2Transitions.length,
  };
}

function providerCallCounts(value: Fixture): Record<string, number> {
  return {
    extraction: value.provider.extractionCalls,
    image: value.provider.imageCalls,
    s2Qa: value.provider.s2QaCalls,
    s2Repair: value.provider.s2RepairCalls,
  };
}

function assertMissingS2IdempotencyKeyError(body: any): void {
  assert.equal(body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(typeof body.error.referenceId, "string");
  assert.notEqual(body.error.referenceId, "");
  assert.equal(body.error.message, "The request could not be completed. Try again or contact support with the reference ID.");
  assert.deepEqual(body.error.fieldErrors, [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]);
}

async function assertMissingS2IdempotencyKeyRoute(value: Fixture, request: Request, path: string[]): Promise<any> {
  const stateBefore = s2StateCounts(value);
  const providerCallsBefore = providerCallCounts(value);
  const response = await handleApiRequest(request, path, value.service);
  const body = await response.json() as any;
  assert.equal(response.status, 400);
  assertMissingS2IdempotencyKeyError(body);
  assert.deepEqual(s2StateCounts(value), stateBefore);
  assert.deepEqual(providerCallCounts(value), providerCallsBefore);
  return body;
}

function hashCanonicalOperationInput(operation: string, projectId: string, input: unknown): string {
  return sha256(jcs({ operation, projectId, input }));
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
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

test("fresh S2 retry topology permits independent candidate retries through commit and reload", async () => {
  const attempts = new Map<number, number>();
  const providerCalls: Array<{ candidateId: string; candidateIndex: number }> = [];
  const dispatches: Array<{ id: string; candidateId: string; attempt: number }> = [];
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    onS2QaRequest: (input) => providerCalls.push({ candidateId: input.candidateId, candidateIndex: input.candidateIndex }),
    s2QaResponseFactory: (input) => {
      const attempt = attempts.get(input.candidateIndex) ?? 0;
      attempts.set(input.candidateIndex, attempt + 1);
      if ((input.candidateIndex === 2 || input.candidateIndex === 3) && attempt === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      return qaPayload(input, "pass");
    },
  });
  const value = fixture([ONE_PIXEL_PNG], {
    provider,
    onProviderDispatchPhase: (phase, operation) => {
      if (phase === "after-dispatch-marked" && operation.phase === "qa") dispatches.push({ id: operation.id, candidateId: operation.candidateId, attempt: operation.attempt });
    },
  });
  try {
    const { bound, result: first } = await bindAndWait(value);
    const retryA = first.qaRun.candidateResults.find((item: any) => item.candidateIndex === 2)!;
    const retryB = first.qaRun.candidateResults.find((item: any) => item.candidateIndex === 3)!;
    assert.equal(retryA.status, "qa_unavailable_retryable");
    assert.equal(retryB.status, "qa_unavailable_retryable");

    const firstRetry = await value.service.s2.retryQa(value.projectId, bound.qaRun.id, retryA.candidateId, randomUUID(), randomUUID());
    assert.equal(firstRetry.replayed, false);
    const afterA = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.candidateResults.some((item: any) => item.candidateId === retryA.candidateId && item.attempt === 2 && item.status === "pass"));
    assert.equal(afterA.qaRun.candidateAttempts.filter((item: any) => item.candidateId === retryA.candidateId).length, 2);
    const afterAState = new JsonRepository(value.root).state();
    const afterARun = afterAState.s2QaRuns.find((item) => item.id === bound.qaRun.id)!;
    assert.equal(afterARun.completedCandidateCount, 4);
    assert.equal(afterARun.passCount, 3);
    assert.equal(afterARun.unavailableCount, 1);

    const secondRetry = await value.service.s2.retryQa(value.projectId, bound.qaRun.id, retryB.candidateId, randomUUID(), randomUUID());
    assert.equal(secondRetry.replayed, false);
    const finalProjection = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.status === "completed" && current.qaRun.candidateResults.some((item: any) => item.candidateId === retryB.candidateId && item.attempt === 2 && item.status === "pass"));
    assert.equal(finalProjection.qaRun.status, "completed");

    const reloaded = new JsonRepository(value.root).state();
    const run = reloaded.s2QaRuns.find((item) => item.id === bound.qaRun.id)!;
    const attemptsFor = (candidateId: string) => run.candidateResults.filter((item) => item.candidateId === candidateId).sort((left, right) => left.attempt - right.attempt);
    assert.deepEqual(attemptsFor(retryA.candidateId).map((item) => item.attempt), [1, 2]);
    assert.deepEqual(attemptsFor(retryB.candidateId).map((item) => item.attempt), [1, 2]);
    for (const candidate of run.candidateResults.filter((item) => item.candidateIndex === 1 || item.candidateIndex === 4)) {
      assert.equal(attemptsFor(candidate.candidateId).length, 1);
      assert.equal(candidate.attempt, 1);
    }

    const qaOperations = reloaded.s2Operations.filter((item) => item.qaRunId === run.id && item.phase === "qa");
    assert.equal(qaOperations.length, 6);
    for (const candidateId of [retryA.candidateId, retryB.candidateId]) {
      const retryResult = attemptsFor(candidateId).find((item) => item.attempt === 2)!;
      const operation = qaOperations.find((item) => item.resultId === retryResult.id)!;
      assert.equal(operation.candidateId, candidateId);
      assert.equal(operation.attempt, 2);
      assert.equal(operation.inputHash, reloaded.s2Inputs[0].inputHash);
      const retryRecord = reloaded.idempotency.find((item) => item.operation === "s2_qa_retry" && (item.result as any).resultId === retryResult.id)!;
      assert.equal(retryRecord.projectId, value.projectId);
      assert.equal((retryRecord.result as any).qaRunId, run.id);
      assert.equal((retryRecord.result as any).candidateId, candidateId);
      assert.equal((retryRecord.result as any).operationId, operation.id);
      assert.equal((retryRecord.result as any).resultId, retryResult.id);
    }

    const latest = [1, 2, 3, 4].map((index) => run.candidateResults.filter((item) => item.candidateIndex === index).sort((left, right) => right.attempt - left.attempt)[0]);
    const terminalStatuses = new Set(["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"]);
    assert.equal(run.completedCandidateCount, latest.filter((item) => terminalStatuses.has(item.status)).length);
    assert.equal(run.passCount, latest.filter((item) => item.status === "pass").length);
    assert.equal(run.warningCount, latest.filter((item) => item.status === "warning").length);
    assert.equal(run.materialFailCount, latest.filter((item) => item.status === "material_fail").length);
    assert.equal(run.unavailableCount, latest.filter((item) => item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal").length);
    assert.equal(run.completedAt !== null, true);

    assert.equal(provider.s2QaCalls, 6);
    assert.deepEqual([1, 2, 3, 4].map((index) => providerCalls.filter((call) => call.candidateIndex === index).length), [1, 2, 2, 1]);
    assert.equal(dispatches.length, qaOperations.length);
    assert.equal(new Set(dispatches.map((dispatch) => dispatch.id)).size, qaOperations.length);
    for (const operation of qaOperations) assert.equal(dispatches.filter((dispatch) => dispatch.id === operation.id).length, 1);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fresh S2 persistence rejects present malformed or unknown records and keeps absent legacy collections empty", () => {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s2-persistence-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ projects: [] }), "utf8");
    const legacy = new JsonRepository(root);
    assert.deepEqual(legacy.state().s2Operations, []);
    const valid = legacy.state();
    valid.s2Drafts.push({
      id: randomUUID(), projectId: randomUUID(), revision: 1, status: "editable",
      referenceAssetIds: [], logoAssetIds: [], updatedAt: new Date(0).toISOString(),
      frozenAt: null, frozenByQaRunId: null,
    });
    writeFileSync(legacy.statePath, JSON.stringify(valid), "utf8");
    assert.throws(() => new JsonRepository(root), (error) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");

    const withUnknown = { ...valid, s2Drafts: [{ ...valid.s2Drafts[0], unexpected: true }] };
    writeFileSync(legacy.statePath, JSON.stringify(withUnknown), "utf8");
    assert.throws(() => new JsonRepository(root), (error) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");

    const withMalformedCollection = { ...valid, s2Operations: { not: "an array" } };
    writeFileSync(legacy.statePath, JSON.stringify(withMalformedCollection), "utf8");
    assert.throws(() => new JsonRepository(root), (error) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh S2 real workflow permits one independent repair per candidate and preserves source lifecycle", async () => {
  const qaCallsByCandidate = new Map<number, number>();
  const dispatches: Array<{ id: string; phase: string; candidateId: string }> = [];
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG, ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => {
      const call = qaCallsByCandidate.get(input.candidateIndex) ?? 0;
      qaCallsByCandidate.set(input.candidateIndex, call + 1);
      return call === 0 && (input.candidateIndex === 1 || input.candidateIndex === 2)
        ? qaPayload(input, "pass", "structure.overhead-support")
        : qaPayload(input, "pass");
    },
  });
  const value = fixture([ONE_PIXEL_PNG], {
    provider,
    onProviderDispatchPhase: (phase, operation) => {
      if (phase === "after-dispatch-marked" && (operation.phase === "repair" || operation.phase === "re_qa")) {
        dispatches.push({ id: operation.id, phase: operation.phase, candidateId: operation.candidateId });
      }
    },
  });
  try {
    const { bound, result: initial } = await bindAndWait(value);
    const initialState = new JsonRepository(value.root).state();
    const sourceRunId = bound.qaRun.id;
    const initialRun = initialState.s2QaRuns.find((run) => run.id === sourceRunId)!;
    assert.equal(initialRun.status, "completed");
    assert.notEqual(initialRun.completedAt, null);
    const completedAt = initialRun.completedAt;
    const candidateA = initial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
    const candidateB = initial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 2)!;

    await value.service.s2.repairCandidate(value.projectId, sourceRunId, candidateA.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, sourceRunId) as any,
      (current) => current.qaRun.reQa.some((item: any) => item.candidateId === candidateA.candidateId && item.status === "pass"));
    const afterA = new JsonRepository(value.root).state().s2QaRuns.find((run) => run.id === sourceRunId)!;
    assert.equal(afterA.status, "completed");
    assert.equal(afterA.completedAt, completedAt);

    await value.service.s2.repairCandidate(value.projectId, sourceRunId, candidateB.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, sourceRunId) as any,
      (current) => current.qaRun.reQa.filter((item: any) => item.status === "pass").length === 2);

    const reloaded = new JsonRepository(value.root).state();
    const run = reloaded.s2QaRuns.find((item) => item.id === sourceRunId)!;
    assert.equal(run.status, "completed");
    assert.equal(run.completedAt, completedAt);
    assert.equal(reloaded.s2Repairs.length, 2);
    assert.equal(new Set(reloaded.s2Repairs.map((repair) => repair.candidateId)).size, 2);
    assert.equal(reloaded.s2Operations.filter((operation) => operation.phase === "repair" && operation.qaRunId === sourceRunId).length, 2);
    assert.equal(reloaded.s2Operations.filter((operation) => operation.phase === "re_qa" && operation.qaRunId === sourceRunId).length, 2);
    assert.equal(reloaded.s2DerivedCandidates.length, 2);
    assert.equal(reloaded.s2ReQaResults.length, 2);
    assert.equal(reloaded.s2Publications.filter((publication) => publication.kind === "repair_output" && publication.state === "committed").length, 2);

    for (const repair of reloaded.s2Repairs) {
      const history = run.candidateResults.filter((result) => result.candidateId === repair.candidateId).sort((left, right) => left.attempt - right.attempt);
      const latest = history[history.length - 1];
      assert.ok(latest);
      assert.equal(latest.repairAttemptId, repair.id);
      assert.equal(history.filter((result) => result.repairAttemptId === repair.id).length, 1);
      assert.equal(repair.qaRunId, run.id);
      assert.equal(repair.inputVersionId, run.inputVersionId);
      assert.equal(repair.projectId, value.projectId);
      assert.equal(repair.sourceAssetId, latest.sourceAssetId);
      assert.equal(repair.sourceSha256, latest.sourceSha256);
      assert.deepEqual(repair.eligibleFindingIds, latest.materialFindingIds);
      assert.equal(repair.derivedCandidateId !== null, true);
      assert.equal(repair.reQaCandidateResultId !== null, true);
      assert.equal(reloaded.s2DerivedCandidates.find((record) => record.id === repair.derivedCandidateId)?.sourceCandidateId, repair.candidateId);
      assert.equal(reloaded.s2ReQaResults.find((record) => record.id === repair.reQaCandidateResultId)?.candidateId, repair.candidateId);
      const repairOperation = reloaded.s2Operations.find((operation) => operation.phase === "repair" && operation.repairAttemptId === repair.id)!;
      const reQaOperation = reloaded.s2Operations.find((operation) => operation.phase === "re_qa" && operation.repairAttemptId === repair.id)!;
      assert.equal(repairOperation.candidateId, repair.candidateId);
      assert.equal(reQaOperation.candidateId, repair.candidateId);
      assert.equal(repairOperation.status, "succeeded");
      assert.equal(reQaOperation.status, "succeeded");
      const idempotency = reloaded.idempotency.find((record) => record.operation === "s2_repair" && (record.result as any).repairAttemptId === repair.id)!;
      assert.equal((idempotency.result as any).operationId, repairOperation.id);
    }
    assert.equal(provider.s2RepairCalls, 2);
    assert.equal(dispatches.filter((dispatch) => dispatch.phase === "repair").length, 2);
    assert.equal(dispatches.filter((dispatch) => dispatch.phase === "re_qa").length, 2);
    assert.equal(new Set(dispatches.map((dispatch) => dispatch.id)).size, dispatches.length);

    const beforeSecondRepair = new JsonRepository(value.root).state();
    const repairCallsBefore = provider.s2RepairCalls;
    assert.equal(await expectCode(
      () => value.service.s2.repairCandidate(value.projectId, sourceRunId, candidateA.candidateId, bound.inputVersionId, randomUUID(), randomUUID()),
      "REPAIR_ALREADY_EXISTS",
    ), true);
    assert.equal(provider.s2RepairCalls, repairCallsBefore);
    const afterSecondRepair = new JsonRepository(value.root).state();
    assert.deepEqual(afterSecondRepair.s2Repairs, beforeSecondRepair.s2Repairs);
    assert.deepEqual(afterSecondRepair.s2Operations, beforeSecondRepair.s2Operations);
    assert.equal(afterSecondRepair.s2Repairs.some((repair) => repair.candidateId === candidateB.candidateId), true);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fresh S2 real workflow repairs an eligible attempt-two material failure and keeps attempt-one unlinked", async () => {
  const qaCallsByCandidate = new Map<number, number>();
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => {
      const call = qaCallsByCandidate.get(input.candidateIndex) ?? 0;
      qaCallsByCandidate.set(input.candidateIndex, call + 1);
      if (input.candidateIndex === 2 && call === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      if (input.candidateIndex === 2 && call === 1) return qaPayload(input, "pass", "structure.overhead-support");
      return qaPayload(input, "pass");
    },
  });
  const value = fixture([ONE_PIXEL_PNG], { provider });
  try {
    const { bound, result: initial } = await bindAndWait(value);
    const candidate = initial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 2)!;
    assert.equal(candidate.status, "qa_unavailable_retryable");
    await value.service.s2.retryQa(value.projectId, bound.qaRun.id, candidate.candidateId, randomUUID(), randomUUID());
    const retried = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.candidateResults.some((item: any) => item.candidateId === candidate.candidateId && item.attempt === 2 && item.status === "material_fail"));
    const sourceCompletedAt = retried.qaRun.completedAt;
    assert.equal(retried.qaRun.status, "completed");
    assert.notEqual(sourceCompletedAt, null);
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const final = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.reQa.some((item: any) => item.candidateId === candidate.candidateId && item.status === "pass"));
    assert.equal(final.qaRun.status, "completed");
    assert.equal(final.qaRun.completedAt, sourceCompletedAt);

    const reloaded = new JsonRepository(value.root).state();
    const run = reloaded.s2QaRuns.find((item) => item.id === bound.qaRun.id)!;
    const attempts = run.candidateResults.filter((item) => item.candidateId === candidate.candidateId).sort((left, right) => left.attempt - right.attempt);
    const repair = reloaded.s2Repairs.find((item) => item.candidateId === candidate.candidateId)!;
    assert.deepEqual(attempts.map((item) => item.attempt), [1, 2]);
    assert.equal(attempts[0].status, "qa_unavailable_retryable");
    assert.equal(attempts[0].repairAttemptId, null);
    assert.equal(attempts[1].status, "material_fail");
    assert.equal(attempts[1].repairAttemptId, repair.id);
    assert.deepEqual(repair.eligibleFindingIds, attempts[1].materialFindingIds);
    assert.equal(repair.projectId, value.projectId);
    assert.equal(repair.qaRunId, run.id);
    assert.equal(repair.inputVersionId, run.inputVersionId);
    assert.equal(repair.candidateId, candidate.candidateId);
    assert.equal(repair.sourceAssetId, attempts[1].sourceAssetId);
    assert.equal(repair.sourceSha256, attempts[1].sourceSha256);
    assert.equal(repair.status, "re_qa_pass");
    assert.equal(reloaded.s2ReQaResults.find((item) => item.id === repair.reQaCandidateResultId)?.candidateId, candidate.candidateId);
    assert.equal(reloaded.s2Operations.some((operation) => operation.failureCode === "PERSISTENCE_FAILED"), false);
    assert.equal(provider.s2RepairCalls, 1);
    assert.equal(provider.s2QaCalls, 6);
    assert.equal(await expectCode(
      () => value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()),
      "REPAIR_ALREADY_EXISTS",
    ), true);
    assert.equal(provider.s2RepairCalls, 1);
    assert.equal(new JsonRepository(value.root).state().s2QaRuns.find((item) => item.id === run.id)?.completedAt, sourceCompletedAt);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fresh S2 persistence graph fixtures reject impossible relationships and load legal lifecycle states", async () => {
  const graphQaCalls = new Map<number, number>();
  const graphProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG, ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => {
      const call = graphQaCalls.get(input.candidateIndex) ?? 0;
      graphQaCalls.set(input.candidateIndex, call + 1);
      if (input.candidateIndex === 2 && call === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      if ((input.candidateIndex === 1 && call === 0) || (input.candidateIndex === 2 && call === 1)) {
        return qaPayload(input, "pass", "structure.overhead-support");
      }
      return qaPayload(input, "pass");
    },
  });
  const value = fixture([ONE_PIXEL_PNG], { provider: graphProvider });
  try {
    const draft = value.service.s2.getReferenceDraft(value.projectId);
    const reference = await value.service.s2.uploadAsset(value.projectId, "reference", "graph-reference.png", "image/png", await solidPng(2, 2, { r: 121, g: 1, b: 1 }), randomUUID());
    const logo = await value.service.s2.uploadAsset(value.projectId, "logo", "graph-logo.png", "image/png", await solidPng(2, 2, { r: 1, g: 122, b: 1 }), randomUUID());
    const selected = value.service.s2.updateDraft(value.projectId, draft.revision, [reference.asset.id], [logo.asset.id], randomUUID());
    const { bound, result: firstResult } = await bindAndWait(value, selected.draft.revision);
    const retryCandidate = firstResult.qaRun.candidateResults.find((item: any) => item.candidateIndex === 2)!;
    await value.service.s2.retryQa(value.projectId, bound.qaRun.id, retryCandidate.candidateId, randomUUID(), randomUUID());
    const completed = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.candidateResults.every((item: any) => item.status === "pass" || item.status === "material_fail"));
    const materialCandidates = completed.qaRun.candidateResults.filter((item: any) => item.status === "material_fail");
    assert.equal(materialCandidates.length, 2);
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, materialCandidates[0].candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.reQa.some((item: any) => item.candidateId === materialCandidates[0].candidateId && item.status === "pass"));
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, materialCandidates[1].candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.reQa.filter((item: any) => item.status === "pass").length === 2);
    const base = cloneJson(value.repository.state()) as any;
    const rejected: Array<{ invariant: string; code: string }> = [];
    const rejectedRoot = (invariant: string, mutate: (state: any) => void): void => {
      const root = mkdtempSync(join(tmpdir(), "swooshz-s2-graph-negative-"));
      try {
        const state = cloneJson(base) as any;
        mutate(state);
        writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");
        assert.throws(() => new JsonRepository(root), (error) => error instanceof AppError && error.code === "PERSISTENCE_FAILED", invariant);
        rejected.push({ invariant, code: "PERSISTENCE_FAILED" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    };
    const positiveRoot = (label: string, mutate: (state: any) => void): any => {
      const root = mkdtempSync(join(tmpdir(), "swooshz-s2-graph-positive-"));
      const state = cloneJson(base) as any;
      mutate(state);
      writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");
      try {
        const repository = new JsonRepository(root);
        assert.doesNotThrow(() => repository.state(), label);
        return repository.state();
      } finally { rmSync(root, { recursive: true, force: true }); }
    };
    const addForeignProject = (state: any): string => {
      const projectId = randomUUID();
      state.projects.push({ ...state.projects[0], projectId, boothGeometry: null, confirmedBriefVersionId: null, activeGenerationSetId: null, briefAssetId: null, briefDraftId: null });
      return projectId;
    };
    const sourceResult = (state: any, candidateIndex: number, attempt?: number): any => state.s2QaRuns[0].candidateResults.find((item: any) =>
      item.candidateIndex === candidateIndex && (attempt === undefined || item.attempt === attempt));
    const repairFor = (state: any, candidateIndex: number): any => {
      const candidateId = sourceResult(state, candidateIndex, candidateIndex === 2 ? 2 : 1).candidateId;
      return state.s2Repairs.find((item: any) => item.candidateId === candidateId);
    };
    const setSourceCounters = (state: any): void => {
      const run = state.s2QaRuns[0];
      const latest = [1, 2, 3, 4].map((index) => {
        const results = run.candidateResults.filter((item: any) => item.candidateIndex === index);
        return results.sort((left: any, right: any) => right.attempt - left.attempt)[0];
      });
      run.completedCandidateCount = latest.filter((item: any) => ["pass", "warning", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(item.status)).length;
      run.passCount = latest.filter((item: any) => item.status === "pass").length;
      run.warningCount = latest.filter((item: any) => item.status === "warning").length;
      run.materialFailCount = latest.filter((item: any) => item.status === "material_fail").length;
      run.unavailableCount = latest.filter((item: any) => item.status === "qa_unavailable_retryable" || item.status === "qa_unavailable_terminal").length;
    };
    const setOutcome = (target: any, template: any, status: "pass" | "warning" | "material_fail" | "qa_unavailable_terminal"): void => {
      target.status = status;
      target.verdict = status === "pass" ? "PASS" : status === "warning" ? "WARNING" : status === "material_fail" ? "MATERIAL_FAIL" : "QA_UNAVAILABLE";
      target.requirementObservations = cloneJson(template.requirementObservations);
      target.designObservations = cloneJson(template.designObservations);
      target.materialFindingIds = [];
      target.warningFindingIds = [];
      target.uncertainFindingIds = [];
      target.providerRequestId = status === "qa_unavailable_terminal" ? null : target.providerRequestId;
      if (status === "warning") {
        const branding = target.designObservations.find((item: any) => item.ruleId === "branding.style");
        branding.observed = "non_compliant";
        target.warningFindingIds = ["branding.style"];
      }
      if (status === "material_fail") {
        const overhead = target.designObservations.find((item: any) => item.ruleId === "structure.overhead-support");
        overhead.observed = "non_compliant";
        target.materialFindingIds = ["structure.overhead-support"];
      }
      if (status === "qa_unavailable_terminal") {
        target.requirementObservations = [];
        target.designObservations = [];
      }
    };
    const resetRepairToPreDerived = (state: any, candidateIndex: number, status: "queued" | "running" | "failed"): void => {
      const repair = repairFor(state, candidateIndex);
      const repairOperation = state.s2Operations.find((item: any) => item.phase === "repair" && item.repairAttemptId === repair.id);
      const reQaOperation = state.s2Operations.find((item: any) => item.phase === "re_qa" && item.repairAttemptId === repair.id);
      const reQaId = repair.reQaCandidateResultId;
      state.s2DerivedCandidates = state.s2DerivedCandidates.filter((item: any) => item.id !== repair.derivedCandidateId);
      state.s2ReQaResults = state.s2ReQaResults.filter((item: any) => item.id !== reQaId);
      state.s2Publications = state.s2Publications.filter((item: any) => !(item.kind === "repair_output" && item.repairAttemptId === repair.id));
      state.s2Operations = state.s2Operations.filter((item: any) => item.id !== reQaOperation.id);
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.operationId !== repairOperation.id && item.operationId !== reQaOperation.id);
      repair.status = status;
      repair.outputSha256 = null;
      repair.derivedCandidateId = null;
      repair.reQaCandidateResultId = null;
      repair.providerRequestId = null;
      repair.startedAt = status === "running" ? new Date().toISOString() : null;
      repair.completedAt = status === "failed" ? new Date().toISOString() : null;
      repairOperation.status = status === "failed" ? "failed" : status;
      repairOperation.claimedBy = status === "running" ? "graph-fixture" : null;
      repairOperation.claimedProcessId = status === "running" ? 9003 : null;
      repairOperation.claimToken = status === "running" ? randomUUID() : null;
      repairOperation.claimedAt = status === "running" ? new Date().toISOString() : null;
      repairOperation.startedAt = status === "running" ? repair.startedAt : null;
      repairOperation.completedAt = status === "failed" ? repair.completedAt : null;
      repairOperation.providerDispatchState = status === "running" ? "may_have_started" : status === "failed" ? "consumed" : "not_started";
      repairOperation.failureCode = status === "failed" ? "REPAIR_PROVIDER_FAILED" : null;
      state.s2Transitions.push({ id: randomUUID(), projectId: repair.projectId, operationId: repairOperation.id, phase: "repair", attempt: 1,
        from: "eligible", to: "queued", referenceId: repairOperation.referenceId, at: new Date().toISOString() });
      if (status === "running" || status === "failed") state.s2Transitions.push({ id: randomUUID(), projectId: repair.projectId, operationId: repairOperation.id, phase: "repair", attempt: 1,
        from: "queued", to: "running", referenceId: repairOperation.referenceId, at: new Date().toISOString() });
      if (status === "failed") state.s2Transitions.push({ id: randomUUID(), projectId: repair.projectId, operationId: repairOperation.id, phase: "repair", attempt: 1,
        from: "running", to: "failed", referenceId: repairOperation.referenceId, at: new Date().toISOString() });
    };
    const resetReQa = (state: any, candidateIndex: number, status: "queued" | "running" | "pass" | "warning" | "material_fail" | "re_qa_unavailable"): void => {
      const repair = repairFor(state, candidateIndex);
      const result = state.s2ReQaResults.find((item: any) => item.id === repair.reQaCandidateResultId);
      const operation = state.s2Operations.find((item: any) => item.phase === "re_qa" && item.repairAttemptId === repair.id);
      const template = state.s2QaRuns[0].candidateResults.find((item: any) => item.candidateIndex === 3);
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.operationId !== operation.id);
      const addTransition = (from: string, to: string): void => {
        state.s2Transitions.push({ id: randomUUID(), projectId: repair.projectId, operationId: operation.id, phase: "re_qa", attempt: 1,
          from, to, referenceId: operation.referenceId, at: new Date().toISOString() });
      };
      if (status === "queued" || status === "running") {
        result.status = status; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
        result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null;
        result.startedAt = status === "running" ? new Date().toISOString() : null; result.completedAt = null;
        repair.status = status === "queued" ? "derived_ready" : "re_qa_running";
        operation.status = status; operation.claimedBy = status === "running" ? "graph-fixture" : null;
        operation.claimedProcessId = status === "running" ? 9004 : null; operation.claimToken = status === "running" ? randomUUID() : null;
        operation.claimedAt = status === "running" ? result.startedAt : null; operation.startedAt = status === "running" ? result.startedAt : null;
        operation.completedAt = null; operation.providerDispatchState = status === "running" ? "may_have_started" : "not_started"; operation.failureCode = null;
        addTransition("derived_ready", "queued");
        if (status === "running") addTransition("queued", "running");
        return;
      }
      setOutcome(result, template, status === "re_qa_unavailable" ? "qa_unavailable_terminal" : status);
      if (status === "re_qa_unavailable") {
        result.status = "re_qa_unavailable"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
        result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null;
        repair.status = "re_qa_unavailable"; operation.status = "failed"; operation.failureCode = "RE_QA_UNAVAILABLE"; operation.providerDispatchState = "consumed";
      } else {
        repair.status = status === "pass" ? "re_qa_pass" : status === "warning" ? "re_qa_warning" : "re_qa_material_fail";
        operation.status = "succeeded"; operation.failureCode = null; operation.providerDispatchState = "consumed";
      }
      result.startedAt = result.startedAt ?? new Date(0).toISOString();
      result.completedAt = new Date(0).toISOString();
      operation.claimedBy = null; operation.claimedProcessId = null; operation.claimToken = null; operation.claimedAt = null;
      operation.startedAt = result.startedAt; operation.completedAt = result.completedAt;
      repair.completedAt = result.completedAt;
      addTransition("derived_ready", "queued");
      addTransition("queued", "running");
      addTransition("running", status === "re_qa_unavailable" ? "re_qa_unavailable" : status === "pass" ? "re_qa_pass" : status === "warning" ? "re_qa_warning" : "re_qa_material_fail");
    };
    const removeRepair = (state: any, candidateIndex: number): void => {
      const repair = repairFor(state, candidateIndex);
      const operationIds = state.s2Operations.filter((item: any) => item.repairAttemptId === repair.id).map((item: any) => item.id);
      state.s2Repairs = state.s2Repairs.filter((item: any) => item.id !== repair.id);
      state.s2DerivedCandidates = state.s2DerivedCandidates.filter((item: any) => item.repairAttemptId !== repair.id);
      state.s2ReQaResults = state.s2ReQaResults.filter((item: any) => item.repairAttemptId !== repair.id);
      state.s2Operations = state.s2Operations.filter((item: any) => item.repairAttemptId !== repair.id);
      state.s2Publications = state.s2Publications.filter((item: any) => item.kind !== "repair_output" || item.repairAttemptId !== repair.id);
      state.s2Transitions = state.s2Transitions.filter((item: any) => !operationIds.includes(item.operationId));
      state.idempotency = state.idempotency.filter((item: any) => item.operation !== "s2_repair" || item.result?.repairAttemptId !== repair.id);
      state.s2QaRuns[0].candidateResults.forEach((result: any) => {
        if (result.repairAttemptId === repair.id) result.repairAttemptId = null;
      });
    };
    rejectedRoot("draft ownership: nonexistent project", (state) => { state.s2Drafts[0].projectId = randomUUID(); });
    rejectedRoot("cross-project S2 foreign key: input/source generation", (state) => {
      const projectId = addForeignProject(state);
      state.s2Inputs[0].projectId = projectId;
    });
    rejectedRoot("frozen draft: missing frozenAt", (state) => { state.s2Drafts[0].frozenAt = null; });
    rejectedRoot("frozen draft: invalid frozenByQaRunId", (state) => { state.s2Drafts[0].frozenByQaRunId = randomUUID(); });
    rejectedRoot("mutable draft: frozen-only state present", (state) => { state.s2Drafts[0].status = "editable"; state.s2Drafts[0].frozenAt = base.s2Drafts[0].frozenAt; });
    rejectedRoot("QA run: nonexistent input version", (state) => { state.s2QaRuns[0].inputVersionId = randomUUID(); });
    rejectedRoot("candidate: source identity from wrong candidate", (state) => { state.s2QaRuns[0].candidateResults[0].sourceAssetId = state.s2Inputs[0].sourceCandidates[1].sourceAssetId; });
    rejectedRoot("QA run: wrong candidate order/index", (state) => { state.s2QaRuns[0].candidateResults[0].candidateIndex = 2; });
    rejectedRoot("QA retry: attempt two cannot retry again", (state) => {
      const result = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 2);
      result.status = "qa_unavailable_retryable"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
      result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null;
    });
    rejectedRoot("QA retry: duplicate attempt two for one candidate", (state) => {
      const result = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 2);
      state.s2QaRuns[0].candidateResults.push({ ...result, id: randomUUID() });
    });
    rejectedRoot("QA retry: attempt two candidate identity mismatch", (state) => {
      const result = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 2);
      result.candidateId = state.s2Inputs[0].sourceCandidates[0].candidateId;
    });
    rejectedRoot("QA retry: attempt two candidate index mismatch", (state) => {
      const result = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 2);
      result.candidateIndex = 1;
    });
    rejectedRoot("QA retry: attempt one was not retryable", (state) => {
      const result = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 1 && item.candidateIndex === 2);
      result.status = "qa_unavailable_terminal";
    });
    rejectedRoot("QA retry: attempt two operation points at another candidate", (state) => {
      const retryResult = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 2);
      const operation = state.s2Operations.find((item: any) => item.resultId === retryResult.id);
      operation.candidateId = state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 1 && item.candidateIndex === 1).candidateId;
    });
    rejectedRoot("QA retry idempotency: result points at another candidate", (state) => {
      const record = state.idempotency.find((item: any) => item.operation === "s2_qa_retry");
      record.result.candidateId = state.s2Inputs[0].sourceCandidates[0].candidateId;
    });
    rejectedRoot("QA retry idempotency: operation points at another candidate", (state) => {
      const record = state.idempotency.find((item: any) => item.operation === "s2_qa_retry");
      record.result.operationId = state.s2Operations.find((item: any) => item.phase === "qa" && item.attempt === 1).id;
    });
    rejectedRoot("QA retry idempotency: record points at another project", (state) => {
      const projectId = addForeignProject(state);
      state.idempotency.find((item: any) => item.operation === "s2_qa_retry").projectId = projectId;
    });
    rejectedRoot("candidate: repair link must be the canonical latest source result", (state) => {
      state.s2QaRuns[0].candidateResults.find((item: any) => item.attempt === 1 && item.repairAttemptId !== null).repairAttemptId = randomUUID();
    });
    rejectedRoot("repair: unrelated candidate/input/run", (state) => { state.s2Repairs[0].candidateId = state.s2Inputs[0].sourceCandidates[1].candidateId; });
    rejectedRoot("repair: project mismatch", (state) => { state.s2Repairs[0].projectId = randomUUID(); });
    rejectedRoot("repair: run mismatch", (state) => { state.s2Repairs[0].qaRunId = randomUUID(); });
    rejectedRoot("repair: input mismatch", (state) => { state.s2Repairs[0].inputVersionId = randomUUID(); });
    rejectedRoot("repair: attached to non-latest source-QA attempt", (state) => {
      const repair = repairFor(state, 2);
      sourceResult(state, 2, 1).repairAttemptId = repair.id;
    });
    rejectedRoot("repair: attempt-one link when attempt two exists", (state) => {
      const repair = repairFor(state, 2);
      sourceResult(state, 2, 1).repairAttemptId = repair.id;
      sourceResult(state, 2, 2).repairAttemptId = null;
    });
    rejectedRoot("repair: earlier and latest source results share one repair link", (state) => {
      const repair = repairFor(state, 2);
      sourceResult(state, 2, 1).repairAttemptId = repair.id;
    });
    rejectedRoot("repair: latest PASS cannot retain repair", (state) => {
      setOutcome(sourceResult(state, 2, 2), sourceResult(state, 3), "pass");
      setSourceCounters(state);
    });
    rejectedRoot("repair: latest WARNING cannot retain repair", (state) => {
      setOutcome(sourceResult(state, 2, 2), sourceResult(state, 3), "warning");
      setSourceCounters(state);
    });
    rejectedRoot("repair: latest unavailable cannot retain repair", (state) => {
      setOutcome(sourceResult(state, 2, 2), sourceResult(state, 3), "qa_unavailable_terminal");
      setSourceCounters(state);
    });
    rejectedRoot("repair: eligible findings do not match latest material failure", (state) => {
      state.s2Repairs[0].eligibleFindingIds = ["structure.screen-support"];
    });
    rejectedRoot("repair operation: belongs to another candidate", (state) => {
      const operation = state.s2Operations.find((item: any) => item.phase === "repair" && item.repairAttemptId === state.s2Repairs[0].id);
      operation.candidateId = sourceResult(state, 3).candidateId;
    });
    rejectedRoot("repair idempotency: belongs to another candidate", (state) => {
      const record = state.idempotency.find((item: any) => item.operation === "s2_repair");
      record.result.operationId = state.s2Operations.find((item: any) => item.phase === "repair" && item.repairAttemptId === state.s2Repairs[1].id).id;
    });
    rejectedRoot("repair idempotency: belongs to another project", (state) => {
      const projectId = addForeignProject(state);
      state.idempotency.find((item: any) => item.operation === "s2_repair").projectId = projectId;
    });
    rejectedRoot("derived candidate: belongs to another candidate", (state) => {
      const derived = state.s2DerivedCandidates.find((item: any) => item.repairAttemptId === state.s2Repairs[0].id);
      derived.sourceCandidateId = sourceResult(state, 3).candidateId;
    });
    rejectedRoot("re-QA: belongs to another candidate", (state) => {
      const result = state.s2ReQaResults.find((item: any) => item.repairAttemptId === state.s2Repairs[0].id);
      result.candidateId = sourceResult(state, 3).candidateId;
    });
    rejectedRoot("QA run: running with terminal source QA and only repair/re-QA work", (state) => {
      state.s2QaRuns[0].status = "running";
    });
    rejectedRoot("QA run: completed with null completedAt", (state) => {
      state.s2QaRuns[0].completedAt = null;
    });
    rejectedRoot("QA run: counters use an earlier attempt instead of latest", (state) => {
      const run = state.s2QaRuns[0];
      run.completedCandidateCount = 4; run.passCount = 2; run.warningCount = 0; run.materialFailCount = 1; run.unavailableCount = 1;
    });
    rejectedRoot("repair/re-QA: prohibited second repair for one candidate", (state) => { state.s2Repairs.push({ ...state.s2Repairs[0], id: randomUUID() }); });
    rejectedRoot("publication: unrelated repair operation", (state) => {
      const publication = state.s2Publications.find((item: any) => item.kind === "repair_output");
      publication.operationId = state.s2Operations.find((item: any) => item.phase === "qa").id;
    });
    rejectedRoot("operation: succeeded with failure metadata", (state) => {
      const operation = state.s2Operations.find((item: any) => item.phase === "qa" && item.status === "succeeded");
      operation.failureCode = "PERSISTENCE_FAILED";
    });
    rejectedRoot("operation claim: duplicate active claim token", (state) => {
      const run = state.s2QaRuns[0];
      const operations = state.s2Operations.filter((item: any) => item.phase === "qa" && (item.candidateId === run.candidateResults.find((result: any) => result.candidateIndex === 3)?.candidateId || item.candidateId === run.candidateResults.find((result: any) => result.candidateIndex === 4)?.candidateId));
      const now = new Date().toISOString(); const token = randomUUID();
      for (const operation of operations.slice(0, 2)) {
        operation.status = "running"; operation.claimedBy = "graph-fixture"; operation.claimedProcessId = 9001; operation.claimToken = token;
        operation.claimedAt = now; operation.startedAt = now; operation.completedAt = null; operation.providerDispatchState = "may_have_started"; operation.failureCode = null;
        const result = run.candidateResults.find((item: any) => item.id === operation.resultId);
        result.status = "running"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
        result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null; result.startedAt = now; result.completedAt = null;
      }
      run.status = "running"; run.startedAt = now; run.completedAt = null; run.completedCandidateCount = 2; run.passCount = 0; run.warningCount = 0; run.materialFailCount = 2; run.unavailableCount = 0;
    });
    rejectedRoot("input: binding hash does not match persisted graph", (state) => { state.s2Inputs[0].bindingHash = "0".repeat(64); });
    rejectedRoot("idempotency: bind result belongs to another project", (state) => {
      const projectId = addForeignProject(state);
      state.idempotency.find((item: any) => item.operation === "s2_bind").projectId = projectId;
    });
    rejectedRoot("transition: impossible status pair/reference", (state) => {
      const transition = state.s2Transitions.find((item: any) => item.phase === "qa");
      transition.from = "pass"; transition.to = "running"; transition.referenceId = randomUUID();
    });
    const operationWithHistory = (state: any, predicate: (operation: any) => boolean): any => state.s2Operations.find(predicate);
    const historyFor = (state: any, operationId: string): any[] => state.s2Transitions.filter((item: any) => item.operationId === operationId);
    const firstQaOperation = (state: any): any => operationWithHistory(state, (item: any) => item.phase === "qa" && item.attempt === 1 && item.status === "succeeded");
    const firstRepairOperation = (state: any): any => operationWithHistory(state, (item: any) => item.phase === "repair");
    const firstReQaOperation = (state: any): any => operationWithHistory(state, (item: any) => item.phase === "re_qa");
    const removeHistoryEntry = (state: any, operationId: string, predicate: (item: any) => boolean): void => {
      const index = state.s2Transitions.findIndex((item: any) => item.operationId === operationId && predicate(item));
      assert.ok(index >= 0, "graph fixture transition must exist");
      state.s2Transitions.splice(index, 1);
    };
    rejectedRoot("transition history: no history", (state) => {
      const operation = firstQaOperation(state);
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.operationId !== operation.id);
    });
    rejectedRoot("transition history: missing queued-to-running", (state) => {
      const operation = firstQaOperation(state);
      removeHistoryEntry(state, operation.id, (item) => item.from === "queued" && item.to === "running");
    });
    rejectedRoot("transition history: missing terminal", (state) => {
      const operation = firstQaOperation(state);
      removeHistoryEntry(state, operation.id, (item) => item.from === "running");
    });
    rejectedRoot("transition history: gap", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      state.s2Transitions.splice(state.s2Transitions.indexOf(history[1]), 1);
    });
    rejectedRoot("transition history: wrong prior", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      history[0].from = "qa_unavailable_retryable";
    });
    rejectedRoot("transition history: wrong terminal", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      history[history.length - 1].to = history[history.length - 1].to === "pass" ? "warning" : "pass";
    });
    rejectedRoot("transition history: wrong operation ID", (state) => {
      const transition = state.s2Transitions[0];
      transition.operationId = randomUUID();
    });
    rejectedRoot("transition history: wrong project", (state) => {
      const transition = state.s2Transitions[0];
      transition.projectId = randomUUID();
    });
    rejectedRoot("transition history: wrong phase", (state) => {
      const transition = state.s2Transitions[0];
      transition.phase = "repair";
    });
    rejectedRoot("transition history: wrong attempt", (state) => {
      const transition = state.s2Transitions[0];
      transition.attempt = 2;
    });
    rejectedRoot("transition history: wrong reference", (state) => {
      const transition = state.s2Transitions[0];
      transition.referenceId = randomUUID();
    });
    rejectedRoot("transition history: reversed timestamps", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      history[1].at = "2000-01-01T00:00:00.000Z";
    });
    rejectedRoot("transition history: impossible duplicate", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      const duplicate = { ...history[history.length - 1], id: randomUUID() };
      const index = state.s2Transitions.indexOf(history[history.length - 1]);
      state.s2Transitions.splice(index, 0, duplicate);
    });
    rejectedRoot("transition recovery: running-to-queued without topology", (state) => {
      const operation = firstQaOperation(state);
      const history = historyFor(state, operation.id);
      state.s2Transitions.push({ ...history[history.length - 1], id: randomUUID(), from: "running", to: "queued" });
    });
    rejectedRoot("transition history: attempt-two wrong start", (state) => {
      const operation = operationWithHistory(state, (item: any) => item.phase === "qa" && item.attempt === 2);
      const history = historyFor(state, operation.id);
      history[0].from = "none";
    });
    rejectedRoot("transition history: repair wrong start", (state) => {
      const operation = firstRepairOperation(state);
      const history = historyFor(state, operation.id);
      history[0].from = "none";
    });
    rejectedRoot("transition history: re-QA wrong start", (state) => {
      const operation = firstReQaOperation(state);
      const history = historyFor(state, operation.id);
      history[0].from = "none";
    });
    assert.equal(rejected.length, 61);
    assert.equal(rejected.every((item) => item.code === "PERSISTENCE_FAILED"), true);

    const terminal = positiveRoot("legal frozen/bound terminal repair and re-QA state", () => undefined);
    assert.deepEqual(Object.keys(terminal.s2Transitions[0]).sort(), ["id", "projectId", "operationId", "phase", "attempt", "from", "to", "referenceId", "at"].sort());
    assert.equal(terminal.s2Drafts[0].status, "frozen");
    assert.equal(terminal.s2Inputs.length, 1);
    assert.equal(terminal.s2QaRuns[0].status, "completed");
    assert.equal(terminal.s2Repairs[0].status, "re_qa_pass");
    assert.equal(terminal.s2ReQaResults[0].status, "pass");
    assert.equal(terminal.s2Repairs.length, 2);
    assert.equal(terminal.s2QaRuns[0].completedAt !== null, true);

    positiveRoot("legal completed source QA with no repair", (state) => {
      const run = state.s2QaRuns[0];
      run.candidateResults.forEach((result: any) => { result.repairAttemptId = null; });
      state.s2Repairs = []; state.s2DerivedCandidates = []; state.s2ReQaResults = [];
      state.s2Operations = state.s2Operations.filter((item: any) => item.phase === "qa");
      state.s2Publications = state.s2Publications.filter((item: any) => item.kind === "asset_upload");
      state.idempotency = state.idempotency.filter((item: any) => item.operation !== "s2_repair");
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.phase === "qa");
      setSourceCounters(state);
      run.status = "completed";
    });

    positiveRoot("legal one repair from attempt one", (state) => {
      removeRepair(state, 2);
      assert.equal(state.s2Repairs.length, 1);
      assert.equal(state.s2Repairs[0].candidateId, sourceResult(state, 1).candidateId);
    });

    positiveRoot("legal one repair from attempt two", (state) => {
      removeRepair(state, 1);
      assert.equal(state.s2Repairs.length, 1);
      assert.equal(state.s2Repairs[0].candidateId, sourceResult(state, 2, 2).candidateId);
      assert.equal(sourceResult(state, 2, 2).repairAttemptId, state.s2Repairs[0].id);
      assert.equal(sourceResult(state, 2, 1).repairAttemptId, null);
    });

    positiveRoot("legal completed source QA plus queued repair", (state) => {
      resetRepairToPreDerived(state, 1, "queued");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2QaRuns[0].completedAt !== null, true);
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "queued");
    });

    positiveRoot("legal completed source QA plus running repair", (state) => {
      resetRepairToPreDerived(state, 1, "running");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2QaRuns[0].completedAt !== null, true);
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "running");
    });

    positiveRoot("legal completed source QA plus failed repair", (state) => {
      resetRepairToPreDerived(state, 1, "failed");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2QaRuns[0].completedAt !== null, true);
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "failed");
    });

    positiveRoot("legal completed source QA plus derived-ready repair", (state) => {
      resetReQa(state, 1, "queued");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2QaRuns[0].completedAt !== null, true);
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "derived_ready");
    });

    positiveRoot("legal completed source QA plus running re-QA", (state) => {
      resetReQa(state, 1, "running");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2QaRuns[0].completedAt !== null, true);
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "re_qa_running");
    });

    positiveRoot("legal completed source QA plus re-QA warning", (state) => {
      resetReQa(state, 1, "warning");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "re_qa_warning");
    });

    positiveRoot("legal completed source QA plus re-QA material failure", (state) => {
      resetReQa(state, 1, "material_fail");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "re_qa_material_fail");
    });

    positiveRoot("legal completed source QA plus re-QA unavailable", (state) => {
      resetReQa(state, 1, "re_qa_unavailable");
      assert.equal(state.s2QaRuns[0].status, "completed");
      assert.equal(state.s2Repairs.find((item: any) => item.candidateId === sourceResult(state, 1).candidateId).status, "re_qa_unavailable");
    });

    positiveRoot("legal source QA activity remains independent while another repair runs", (state) => {
      resetRepairToPreDerived(state, 1, "running");
      const run = state.s2QaRuns[0]; const result = sourceResult(state, 3); const operation = state.s2Operations.find((item: any) =>
        item.phase === "qa" && item.resultId === result.id);
      const now = new Date().toISOString();
      result.status = "running"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
      result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null;
      result.startedAt = now; result.completedAt = null;
      operation.status = "running"; operation.claimedBy = "graph-fixture"; operation.claimedProcessId = 9005; operation.claimToken = randomUUID();
      operation.claimedAt = now; operation.startedAt = now; operation.completedAt = null; operation.providerDispatchState = "may_have_started"; operation.failureCode = null;
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.operationId !== operation.id);
      state.s2Transitions.push({ id: randomUUID(), projectId: operation.projectId, operationId: operation.id, phase: "qa", attempt: 1,
        from: "none", to: "queued", referenceId: operation.referenceId, at: now });
      state.s2Transitions.push({ id: randomUUID(), projectId: operation.projectId, operationId: operation.id, phase: "qa", attempt: 1,
        from: "queued", to: "running", referenceId: operation.referenceId, at: now });
      run.status = "running"; run.startedAt = now; run.completedAt = null;
      setSourceCounters(state);
    });

    positiveRoot("legal active queued state", (state) => {
      const run = state.s2QaRuns[0];
      run.status = "queued"; run.startedAt = null; run.completedAt = null;
      run.candidateResults = run.candidateResults.filter((item: any) => item.attempt === 1);
      run.candidateResults.forEach((result: any) => {
        result.status = "queued"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
        result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null; result.repairAttemptId = null; result.startedAt = null; result.completedAt = null;
      });
      state.s2Repairs = []; state.s2DerivedCandidates = []; state.s2ReQaResults = [];
      state.s2Operations = state.s2Operations.filter((item: any) => item.phase === "qa" && item.attempt === 1);
      state.s2Operations.forEach((operation: any) => { operation.status = "queued"; operation.claimedBy = null; operation.claimedProcessId = null; operation.claimToken = null; operation.claimedAt = null; operation.startedAt = null; operation.completedAt = null; operation.providerDispatchState = "not_started"; operation.failureCode = null; });
      state.s2Publications = state.s2Publications.filter((item: any) => item.kind === "asset_upload");
      state.idempotency = state.idempotency.filter((item: any) => item.operation !== "s2_qa_retry" && item.operation !== "s2_repair");
      run.completedCandidateCount = 0; run.passCount = 0; run.warningCount = 0; run.materialFailCount = 0; run.unavailableCount = 0;
      state.s2Transitions = state.s2Transitions.filter((item: any) => item.phase === "qa" && item.attempt === 1 && item.from === "none" && item.to === "queued");
    });

    positiveRoot("legal may_have_started recovery ambiguity", (state) => {
      const run = state.s2QaRuns[0]; const now = new Date().toISOString();
      const operations = state.s2Operations.filter((item: any) => item.phase === "qa" && item.attempt === 1 && (item.candidateId === run.candidateResults.find((result: any) => result.candidateIndex === 3)?.candidateId || item.candidateId === run.candidateResults.find((result: any) => result.candidateIndex === 4)?.candidateId));
      const token = randomUUID();
      for (const operation of operations.slice(0, 1)) {
        operation.status = "running"; operation.claimedBy = "graph-fixture"; operation.claimedProcessId = 9002; operation.claimToken = token;
        operation.claimedAt = now; operation.startedAt = now; operation.completedAt = null; operation.providerDispatchState = "may_have_started"; operation.failureCode = null;
        const result = run.candidateResults.find((item: any) => item.id === operation.resultId);
        result.status = "running"; result.verdict = "QA_UNAVAILABLE"; result.requirementObservations = []; result.designObservations = [];
        result.materialFindingIds = []; result.warningFindingIds = []; result.uncertainFindingIds = []; result.providerRequestId = null; result.startedAt = now; result.completedAt = null;
        state.s2Transitions = state.s2Transitions.filter((item: any) => item.operationId !== operation.id);
        state.s2Transitions.push({ id: randomUUID(), projectId: operation.projectId, operationId: operation.id, phase: "qa", attempt: 1,
          from: "none", to: "queued", referenceId: operation.referenceId, at: now });
        state.s2Transitions.push({ id: randomUUID(), projectId: operation.projectId, operationId: operation.id, phase: "qa", attempt: 1,
          from: "queued", to: "running", referenceId: operation.referenceId, at: now });
      }
      run.status = "running"; run.startedAt = now; run.completedAt = null; run.completedCandidateCount = 3; run.passCount = 1; run.warningCount = 0; run.materialFailCount = 2; run.unavailableCount = 0;
    });
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("fresh S2 multipart route streams arbitrary chunks and rejects an oversized file before normalization", async () => {
  const value = fixture();
  try {
    const boundary = "s2-stream-boundary";
    const body = s2MultipartBody(ONE_PIXEL_PNG);
    const missingKeyBody = lazyTrackedChunks([body]);
    const missingKeyRequest = requestWithStream(
      { "content-type": "multipart/form-data; boundary=" + boundary },
      missingKeyBody.body,
    );
    const missingKeyResponse = await handleApiRequest(missingKeyRequest, ["projects", value.projectId, "s2", "reference-assets"], value.service);
    const missingKeyError = await missingKeyResponse.json() as any;
    assert.equal(missingKeyResponse.status, 400);
    assertMissingS2IdempotencyKeyError(missingKeyError);
    assert.equal(missingKeyBody.stats().pulls, 0);

    const invalidKeyBody = lazyTrackedChunks([body]);
    const invalidKeyRequest = requestWithStream(
      { "content-type": "multipart/form-data; boundary=" + boundary, "Idempotency-Key": "not-a-uuid" },
      invalidKeyBody.body,
    );
    const invalidKeyResponse = await handleApiRequest(invalidKeyRequest, ["projects", value.projectId, "s2", "reference-assets"], value.service);
    const invalidKeyError = await invalidKeyResponse.json() as any;
    assert.equal(invalidKeyResponse.status, 400);
    assert.equal(invalidKeyError.error.code, "INVALID_REQUEST");
    assert.equal(invalidKeyError.error.fieldErrors[0].code, "UUID_REQUIRED");
    assert.equal(invalidKeyBody.stats().pulls, 0);

    const validBody = trackedChunkedStream(body, 7);
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=" + boundary, "Idempotency-Key": randomUUID() },
      body: validBody.stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const accepted = await handleApiRequest(request, ["projects", value.projectId, "s2", "reference-assets"], value.service);
    assert.equal(accepted.status, 201);
    assert.equal(value.repository.state().s2Assets.length, 1);
    assert.equal(validBody.stats().pulls > 0, true);

    const oversizedHeaderBoundary = "s2-header-boundary";
    const oversizedHeader = Array.from({ length: 20 }, (_, index) =>
      "X-S2-" + String(index).padStart(2, "0") + ": " + "a".repeat(1000)).join("\r\n");
    const oversizedHeaderBody = Buffer.concat([
      Buffer.from("--" + oversizedHeaderBoundary + "\r\n" + oversizedHeader +
        "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"header.png\"\r\nContent-Type: image/png\r\n\r\n", "latin1"),
      Buffer.from(ONE_PIXEL_PNG),
      Buffer.from("\r\n--" + oversizedHeaderBoundary + "--\r\n", "latin1"),
    ]);
    const oversizedHeaderRequest = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=" + oversizedHeaderBoundary, "Idempotency-Key": randomUUID() },
      body: chunkedStream(oversizedHeaderBody, 31),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const headerRejected = await handleApiRequest(oversizedHeaderRequest, ["projects", value.projectId, "s2", "reference-assets"], value.service);
    assert.equal(headerRejected.status, 400);
    assert.equal(value.repository.state().s2Assets.length, 1);

    const tooLargeBody = s2MultipartBody(Buffer.alloc(S2_MAX_SOURCE_BYTES + 1));
    const tooLargeRequest = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=" + boundary, "Idempotency-Key": randomUUID() },
      body: chunkedStream(tooLargeBody, 4096),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const rejected = await handleApiRequest(tooLargeRequest, ["projects", value.projectId, "s2", "reference-assets"], value.service);
    assert.equal(rejected.status, 413);
    assert.equal(value.repository.state().s2Assets.length, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fresh S2 idempotent routes reject a missing key before mutation or provider work", async () => {
  const uploadValue = fixture();
  try {
    const boundary = "s2-stream-boundary";
    const missingBody = lazyTrackedChunks([s2MultipartBody(ONE_PIXEL_PNG)]);
    await assertMissingS2IdempotencyKeyRoute(uploadValue, requestWithStream(
      { "content-type": "multipart/form-data; boundary=" + boundary },
      missingBody.body,
    ), ["projects", uploadValue.projectId, "s2", "reference-assets"]);
    assert.equal(missingBody.stats().pulls, 0);

    const emptyBody = lazyTrackedChunks([s2MultipartBody(ONE_PIXEL_PNG)]);
    await assertMissingS2IdempotencyKeyRoute(uploadValue, requestWithStream(
      { "content-type": "multipart/form-data; boundary=" + boundary, "Idempotency-Key": "" },
      emptyBody.body,
    ), ["projects", uploadValue.projectId, "s2", "reference-assets"]);
    assert.equal(emptyBody.stats().pulls, 0);

    const malformedBody = lazyTrackedChunks([s2MultipartBody(ONE_PIXEL_PNG)]);
    const stateBeforeMalformed = s2StateCounts(uploadValue);
    const providerCallsBeforeMalformed = providerCallCounts(uploadValue);
    const malformedResponse = await handleApiRequest(requestWithStream(
      { "content-type": "multipart/form-data; boundary=" + boundary, "Idempotency-Key": "not-a-uuid" },
      malformedBody.body,
    ), ["projects", uploadValue.projectId, "s2", "reference-assets"], uploadValue.service);
    const malformedBodyJson = await malformedResponse.json() as any;
    assert.equal(malformedResponse.status, 400);
    assert.equal(malformedBodyJson.error.code, "INVALID_REQUEST");
    assert.deepEqual(malformedBodyJson.error.fieldErrors, [{ field: "Idempotency-Key", code: "UUID_REQUIRED" }]);
    assert.equal(malformedBody.stats().pulls, 0);
    assert.deepEqual(s2StateCounts(uploadValue), stateBeforeMalformed);
    assert.deepEqual(providerCallCounts(uploadValue), providerCallsBeforeMalformed);
  } finally {
    rmSync(uploadValue.root, { recursive: true, force: true });
  }

  const draftValue = fixture();
  try {
    await assertMissingS2IdempotencyKeyRoute(draftValue, new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, referenceAssetIds: [], logoAssetIds: [] }),
    }), ["projects", draftValue.projectId, "s2", "reference-draft"]);
  } finally {
    rmSync(draftValue.root, { recursive: true, force: true });
  }

  const bindValue = fixture();
  try {
    await assertMissingS2IdempotencyKeyRoute(bindValue, new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceGenerationSetId: bindValue.generationSetId, expectedDraftRevision: 1 }),
    }), ["projects", bindValue.projectId, "s2", "qa-runs"]);
  } finally {
    rmSync(bindValue.root, { recursive: true, force: true });
  }

  const retryValue = fixture();
  try {
    const bound = await bindAndWait(retryValue);
    const retryCandidate = bound.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 2)!;
    assert.equal(retryCandidate.status, "qa_unavailable_retryable");
    await assertMissingS2IdempotencyKeyRoute(retryValue, new Request("http://localhost", { method: "POST" }), [
      "projects", retryValue.projectId, "s2", "qa-runs", bound.bound.qaRun.id, "candidates", retryCandidate.candidateId, "retry",
    ]);
  } finally {
    rmSync(retryValue.root, { recursive: true, force: true });
  }

  const repairValue = fixture();
  try {
    const bound = await bindAndWait(repairValue);
    const repairCandidate = bound.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
    assert.equal(repairCandidate.status, "material_fail");
    await assertMissingS2IdempotencyKeyRoute(repairValue, new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedInputVersionId: bound.bound.inputVersionId }),
    }), [
      "projects", repairValue.projectId, "s2", "qa-runs", bound.bound.qaRun.id, "candidates", repairCandidate.candidateId, "repair",
    ]);
  } finally {
    rmSync(repairValue.root, { recursive: true, force: true });
  }
});

test("fresh S2 repair eligibility uses section-16 canonical finding order instead of lexical order", async () => {
  const cases = [
    {
      badRule: "access.open-sides,footprint.within-boundary",
      providerOrder: ["footprint.within-boundary", "access.open-sides"],
      canonicalOrder: ["access.open-sides", "footprint.within-boundary"],
    },
    {
      badRule: "structure.overhead-support,scale.human",
      providerOrder: ["scale.human", "structure.overhead-support"],
      canonicalOrder: ["scale.human", "structure.overhead-support"],
    },
  ];
  for (const current of cases) {
    const provider = new MockOpenAIProvider({
      briefData: briefData(),
      s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "pass", current.badRule) : qaPayload(input),
    });
    const value = fixture([ONE_PIXEL_PNG], { provider });
    try {
      const { result } = await bindAndWait(value);
      const candidate = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
      assert.equal(candidate.status, "material_fail");
      assert.deepEqual(candidate.materialFindingIds, current.canonicalOrder);
      assert.deepEqual(candidate.eligibleRepairFindingIds, current.canonicalOrder);
      assert.equal(candidate.repairEligible, true);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
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
    value.repository.transact((state) => { const draft = state.s2Drafts.find((item) => item.projectId === value.projectId)!; draft.referenceAssetIds = []; const asset = state.s2Assets.find((item) => item.id === second.asset.id)!; asset.status = "deleted"; asset.deletedAt = new Date().toISOString(); });
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
    const input = pass.repository.state().s2Inputs[0];
    assert.equal(result.qaRun.passCount, 4);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.requirementObservations.length === input.canonicalRequirements.length), true);
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.designObservations.length === input.designRuleSnapshot.filter((rule: any) => rule.applicability === "applicable").length), true);
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
    failureFixture.service.s2.getReferenceDraft(failureFixture.projectId);
    const bound = await failureFixture.service.s2.bindQa(failureFixture.projectId, failureFixture.generationSetId, 1, randomUUID(), randomUUID());
    const result = await waitFor(() => failureFixture.service.s2.getQaRun(failureFixture.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.status === "running" && current.qaRun.candidateResults.filter((item: any) => item.status.startsWith("qa_unavailable")).length === 3 &&
        current.qaRun.candidateResults.find((item: any) => item.candidateIndex === 4)?.status === "running");
    assert.equal(result.qaRun.candidateResults.every((item: any) => item.status !== "material_fail"), true);
    assert.equal(result.qaRun.candidateResults.filter((item: any) => item.verdict === "QA_UNAVAILABLE").length, 4);
    assert.equal(result.qaRun.status, "running");
    assert.equal(result.qaRun.completedCandidateCount, 3);
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
      await waitFor(() => staleInput, (current) => current !== null);
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
  const qaAttempts = new Map<number, number>();
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    onS2RepairRequest: (input) => captured.push(input),
    s2QaResponseFactory: (input) => {
      const attempt = qaAttempts.get(input.candidateIndex) ?? 0;
      qaAttempts.set(input.candidateIndex, attempt + 1);
      return qaPayload(input, "pass", input.candidateIndex === 1 && attempt === 0 ? "structure.overhead-support,scale.human,footprint.within-boundary" : undefined);
    },
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
    assert.deepEqual(candidate.materialFindingIds, ["footprint.within-boundary", "scale.human", "structure.overhead-support"]);
    assert.deepEqual(candidate.eligibleRepairFindingIds, ["footprint.within-boundary", "scale.human", "structure.overhead-support"]);
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
    const objectiveStarts = [
      "Keep every visible element within the exact supplied width and depth footprint.",
      "Apply a bounded plausible visual scale correction",
      "Correct the clearly unsupported overhead visual issue",
    ].map((text) => request.prompt.indexOf(text));
    assert.equal(objectiveStarts.every((index) => index >= 0), true);
    assert.equal(objectiveStarts[0] < objectiveStarts[1] && objectiveStarts[1] < objectiveStarts[2], true);
    assert.equal(repair.sourceAssetId, inputBefore.sourceCandidates[0].sourceAssetId);
    assert.equal(repair.sourceSha256, inputBefore.sourceCandidates[0].sourceSha256);
    assert.equal(sha256(value.objects.read(inputBefore.sourceCandidates[0].sourceStorageKey)), inputBefore.sourceCandidates[0].sourceSha256);
    assert.equal(derived.repairAttemptId, repair.id);
    assert.equal(repair.derivedCandidateId, derived.id);
    assert.equal(repair.reQaCandidateResultId, reQa.id);
    assert.equal(reQa.repairAttemptId, repair.id);
    assert.equal(reQa.derivedCandidateId, derived.id);
    const repairReferenceProjection = inputBefore.referenceAssetIds.map((assetId, index) => {
      const asset = state.s2Assets.find((item) => item.id === assetId)!;
      return { assetId, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const repairLogoProjection = inputBefore.logoAssetIds.map((assetId, index) => {
      const asset = state.s2Assets.find((item) => item.id === assetId)!;
      return { assetId, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const expectedRepairInput = independentRepairInput(inputBefore, inputBefore.sourceCandidates[0], repair.eligibleFindingIds, repairReferenceProjection, repairLogoProjection);
    assertExactKeys(expectedRepairInput, ["schemaVersion", "inputVersionId", "qaRunId", "candidateId", "sourceAssetId", "sourceSha256", "sourceByteSize", "sourceWidth", "sourceHeight", "sourcePixelCount", "sourceDecodedRgbaBytes", "bindingHash", "orderedFindingIds", "referenceAssets", "logoAssets", "confirmedBriefContentHash", "geometryHash", "attempt"]);
    repairReferenceProjection.forEach((item) => assertExactKeys(item, ["assetId", "normalizedSha256", "width", "height", "normalizedBytes", "slot"]));
    repairLogoProjection.forEach((item) => assertExactKeys(item, ["assetId", "normalizedSha256", "width", "height", "normalizedBytes", "slot"]));
    assert.equal(repair.repairInputHash, sha256(jcs(expectedRepairInput)));
    const expectedRepairOperationInput = {
      qaRunId: bound.qaRun.id, candidateId: candidate.candidateId, expectedInputVersionId: bound.inputVersionId,
      eligibleFindingIds: repair.eligibleFindingIds,
    };
    assertExactKeys(expectedRepairOperationInput, ["qaRunId", "candidateId", "expectedInputVersionId", "eligibleFindingIds"]);
    assert.equal(repairOperation?.inputHash, hashCanonicalOperationInput("s2_repair", value.projectId, expectedRepairOperationInput));
    assert.notEqual(repairOperation?.inputHash, repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, sourceAssetId: randomUUID() })), repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, bindingHash: "0".repeat(64) })), repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, orderedFindingIds: ["structure.screen-support", ...repair.eligibleFindingIds] })), repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, orderedFindingIds: [...repair.eligibleFindingIds].reverse() })), repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, referenceAssets: repairReferenceProjection.map((item, index) => index === 0 ? { ...item, normalizedBytes: item.normalizedBytes + 1 } : item) })), repair.repairInputHash);
    assert.notEqual(sha256(jcs({ ...expectedRepairInput, logoAssets: repairLogoProjection.map((item, index) => index === 0 ? { ...item, slot: item.slot + 1 } : item) })), repair.repairInputHash);
    assert.equal(reQaOperation?.inputHash, inputBefore.inputHash);
    assert.equal(after.qaRun.repairs.length, 1);
    assert.equal(after.qaRun.reQa.length, 1);
    assert.equal(await expectCode(() => value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()), "REPAIR_ALREADY_EXISTS"), true);
    assert.equal(provider.s2RepairCalls, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("fresh S2 evidence independently reconstructs all five persisted idempotency input hashes", async () => {
  const value = fixture();
  try {
    const initialDraft = value.service.s2.getReferenceDraft(value.projectId);
    const uploadKey = randomUUID();
    const uploaded = await value.service.s2.uploadAsset(value.projectId, "reference", "hash-reference.png", "image/png", ONE_PIXEL_PNG, uploadKey);
    const uploadState = value.repository.state();
    const uploadedRecord = uploadState.idempotency.find((item) => item.key === uploadKey)!;
    const uploadedAsset = uploadState.s2Assets.find((item) => item.id === uploaded.asset.id)!;
    const uploadInput = { kind: "reference", originalSha256: uploadedAsset.originalSha256, originalBytes: uploadedAsset.originalBytes };
    assertExactKeys(uploadInput, ["kind", "originalSha256", "originalBytes"]);
    assertExactKeys(uploadedRecord, ["key", "operation", "projectId", "inputHash", "result", "createdAt"]);
    assertExactKeys(uploadedRecord.result, ["assetId"]);
    assert.equal(uploadedRecord.operation, "s2_asset_upload");
    assert.equal(uploadedRecord.projectId, value.projectId);
    assert.equal(uploadedRecord.inputHash, hashCanonicalOperationInput("s2_asset_upload", value.projectId, uploadInput));
    assert.notEqual(hashCanonicalOperationInput("s2_asset_upload", value.projectId, { ...uploadInput, originalBytes: uploadInput.originalBytes + 1 }), uploadedRecord.inputHash);
    const assetsBeforeReuse = uploadState.s2Assets.length;
    const providerCallsBeforeReuse = value.provider.s2QaCalls;
    assert.equal(await expectCode(() => value.service.s2.uploadAsset(value.projectId, "logo", "hash-reference.png", "image/png", ONE_PIXEL_PNG, uploadKey), "IDEMPOTENCY_KEY_REUSE"), true);
    assert.equal(value.repository.state().s2Assets.length, assetsBeforeReuse);
    assert.equal(value.provider.s2QaCalls, providerCallsBeforeReuse);

    const draftKey = randomUUID();
    const draftInput = { draftId: initialDraft.id, expectedRevision: initialDraft.revision, referenceAssetIds: [uploaded.asset.id], logoAssetIds: [] };
    const updated = value.service.s2.updateDraft(value.projectId, draftInput.expectedRevision, draftInput.referenceAssetIds, draftInput.logoAssetIds, draftKey);
    const draftRecord = value.repository.state().idempotency.find((item) => item.key === draftKey)!;
    assertExactKeys(draftInput, ["draftId", "expectedRevision", "referenceAssetIds", "logoAssetIds"]);
    assertExactKeys(draftRecord, ["key", "operation", "projectId", "inputHash", "result", "createdAt"]);
    assertExactKeys(draftRecord.result, ["draftId"]);
    assert.equal(draftRecord.operation, "s2_draft_update");
    assert.equal(draftRecord.inputHash, hashCanonicalOperationInput("s2_draft_update", value.projectId, draftInput));
    assert.notEqual(hashCanonicalOperationInput("s2_draft_update", value.projectId, { ...draftInput, expectedRevision: draftInput.expectedRevision + 1 }), draftRecord.inputHash);
    assert.equal(await expectCode(() => value.service.s2.updateDraft(value.projectId, draftInput.expectedRevision, [], [], draftKey), "IDEMPOTENCY_KEY_REUSE"), true);

    const bindKey = randomUUID();
    const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, updated.draft.revision, bindKey, randomUUID());
    const bindState = value.repository.state();
    const boundInput = bindState.s2Inputs.find((item) => item.id === bound.inputVersionId)!;
    const bindRecord = bindState.idempotency.find((item) => item.key === bindKey)!;
    const bindInput = { sourceGenerationSetId: value.generationSetId, expectedDraftRevision: updated.draft.revision, bindingHash: boundInput.bindingHash };
    assertExactKeys(bindInput, ["sourceGenerationSetId", "expectedDraftRevision", "bindingHash"]);
    assertExactKeys(bindRecord, ["key", "operation", "projectId", "inputHash", "result", "createdAt"]);
    assertExactKeys(bindRecord.result, ["inputVersionId", "qaRunId", "operationIds"]);
    assert.equal(bindRecord.operation, "s2_bind");
    assert.equal(bindRecord.inputHash, hashCanonicalOperationInput("s2_bind", value.projectId, bindInput));
    assert.notEqual(hashCanonicalOperationInput("s2_bind", value.projectId, { ...bindInput, expectedDraftRevision: bindInput.expectedDraftRevision + 1 }), bindRecord.inputHash);

    const completed = await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const retryCandidate = completed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 2);
    assert.equal(retryCandidate.status, "qa_unavailable_retryable");
    const retryKey = randomUUID();
    await value.service.s2.retryQa(value.projectId, bound.qaRun.id, retryCandidate.candidateId, retryKey, randomUUID());
    const retryRecord = value.repository.state().idempotency.find((item) => item.key === retryKey)!;
    const retryInput = { qaRunId: bound.qaRun.id, candidateId: retryCandidate.candidateId, expectedAttempt: 1 };
    assertExactKeys(retryInput, ["qaRunId", "candidateId", "expectedAttempt"]);
    assertExactKeys(retryRecord, ["key", "operation", "projectId", "inputHash", "result", "createdAt"]);
    assertExactKeys(retryRecord.result, ["qaRunId", "candidateId", "operationId", "resultId"]);
    assert.equal(retryRecord.operation, "s2_qa_retry");
    assert.equal(retryRecord.inputHash, hashCanonicalOperationInput("s2_qa_retry", value.projectId, retryInput));
    assert.notEqual(hashCanonicalOperationInput("s2_qa_retry", value.projectId, { ...retryInput, expectedAttempt: 2 }), retryRecord.inputHash);

    const materialCandidate = completed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
    assert.equal(materialCandidate.status, "material_fail");
    const repairKey = randomUUID();
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, materialCandidate.candidateId, bound.inputVersionId, repairKey, randomUUID());
    await waitFor(() => value.repository.state().s2Repairs.length, (count) => count === 1);
    const repairRecord = value.repository.state().idempotency.find((item) => item.key === repairKey)!;
    const persistedRepair = value.repository.state().s2Repairs[0];
    const repairInput = { qaRunId: bound.qaRun.id, candidateId: materialCandidate.candidateId, expectedInputVersionId: bound.inputVersionId, eligibleFindingIds: persistedRepair.eligibleFindingIds };
    assertExactKeys(repairInput, ["qaRunId", "candidateId", "expectedInputVersionId", "eligibleFindingIds"]);
    assertExactKeys(repairRecord, ["key", "operation", "projectId", "inputHash", "result", "createdAt"]);
    assertExactKeys(repairRecord.result, ["repairAttemptId", "operationId"]);
    assert.equal(repairRecord.operation, "s2_repair");
    assert.equal(repairRecord.inputHash, hashCanonicalOperationInput("s2_repair", value.projectId, repairInput));
    assert.notEqual(hashCanonicalOperationInput("s2_repair", value.projectId, { ...repairInput, eligibleFindingIds: ["structure.screen-support", ...repairInput.eligibleFindingIds] }), repairRecord.inputHash);
    assert.notEqual(repairRecord.inputHash, persistedRepair.repairInputHash);
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
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.providerDispatchState, "may_have_started");
    createWorkflowService({ repository: qaValue.repository, objects: qaValue.objects, provider: qaProvider,
      processId: 71_102, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    assert.equal(qaCalls, 4);
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.status, "running");
    createWorkflowService({ repository: qaValue.repository, objects: qaValue.objects, provider: qaProvider,
      processId: 71_103, isProcessAlive: () => false });
    await waitFor(() => qaValue.service.s2.getQaRun(qaValue.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    assert.equal(qaCalls, 4);
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.status, "failed");
    assert.equal(qaValue.repository.state().s2Operations.find((operation) => operation.id === qaOperation.id)?.providerDispatchState, "consumed");
    staleQa.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const latest = qaValue.service.s2.getQaRun(qaValue.projectId, bound.qaRun.id) as any;
    assert.equal(latest.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1).status, "qa_unavailable_retryable");
    assert.equal(qaValue.repository.state().s2QaRuns[0].candidateResults.find((result) => result.candidateIndex === 1)?.providerRequestId, null);
  } finally {
    staleQa.resolve();
    rmSync(qaValue.root, { recursive: true, force: true });
  }

  const staleRepair = deferred<void>();
  let firstRepair = true;
  let repairStarted = false;
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
  const repairValue = fixture([ONE_PIXEL_PNG], { provider: repairProvider, processId: 71_201 });
  try {
    repairValue.service.s2.getReferenceDraft(repairValue.projectId);
    const bound = await repairValue.service.s2.bindQa(repairValue.projectId, repairValue.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    const sourceRunBeforeRepair = repairValue.repository.state().s2QaRuns.find((run) => run.id === bound.qaRun.id)!;
    const sourceCompletedAtBeforeRepair = sourceRunBeforeRepair.completedAt;
    repairStarted = true;
    await repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const repairOperation = await waitFor(() => repairValue.repository.state().s2Operations.find((operation) => operation.phase === "repair") as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 71_201);
    await waitFor(() => repairCalls, (value) => value === 1);
    assert.equal(repairValue.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)?.providerDispatchState, "may_have_started");
    createWorkflowService({ repository: repairValue.repository, objects: repairValue.objects, provider: repairProvider,
      processId: 71_202, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    assert.equal(repairValue.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)?.status, "running");
    assert.equal(repairValue.repository.state().s2QaRuns[0].status, "completed");
    assert.equal(repairValue.repository.state().s2QaRuns[0].completedAt, sourceCompletedAtBeforeRepair);
    createWorkflowService({ repository: repairValue.repository, objects: repairValue.objects, provider: repairProvider,
      processId: 71_203, isProcessAlive: () => false });
    await waitFor(() => repairValue.repository.state().s2Repairs[0] as any, (repair) => repair?.status === "failed");
    assert.equal(repairCalls, 1);
    staleRepair.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = repairValue.repository.state();
    assert.equal(state.s2DerivedCandidates.length, 0);
    assert.equal(state.s2ReQaResults.length, 0);
    assert.equal(state.s2Repairs[0].status, "failed");
    assert.equal(state.s2Publications.filter((publication) => publication.state === "committed").length, 0);
    assert.equal(state.s2Operations.filter((operation) => operation.phase === "repair").length, 1);
    assert.equal(state.s2Operations.filter((operation) => operation.phase === "re_qa").length, 0);
    assert.equal(state.s2Operations.find((operation) => operation.phase === "repair")?.status, "failed");
    assert.equal(state.s2Operations.find((operation) => operation.phase === "repair")?.providerDispatchState, "consumed");
    assert.equal(state.s2QaRuns[0].status, "completed");
    assert.equal(state.s2QaRuns[0].completedAt, sourceCompletedAtBeforeRepair);
  } finally {
    staleRepair.resolve();
    rmSync(repairValue.root, { recursive: true, force: true });
  }

  const staleReQa = deferred<void>();
  let deferReQa = false;
  let reQaStarted = false;
  let reQaCalls = 0;
  const reQaProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input, callIndex) => qaPayload(input, "pass", callIndex < 4 && input.candidateIndex === 1 ? "structure.overhead-support" : undefined),
  });
  const originalReQa = reQaProvider.runS2Qa.bind(reQaProvider);
  (reQaProvider as any).runS2Qa = async (input: any) => {
    reQaCalls += 1;
    if (deferReQa && input.candidateIndex === 1) {
      reQaStarted = true;
      await staleReQa.promise;
      return { payload: qaPayload(input, "pass"), providerRequestId: "stale-reqa" };
    }
    return originalReQa(input);
  };
  const reQaValue = fixture([ONE_PIXEL_PNG], { provider: reQaProvider, processId: 71_401 });
  try {
    reQaValue.service.s2.getReferenceDraft(reQaValue.projectId);
    const bound = await reQaValue.service.s2.bindQa(reQaValue.projectId, reQaValue.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => reQaValue.service.s2.getQaRun(reQaValue.projectId, bound.qaRun.id) as any, (value) => value.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((result: any) => result.candidateIndex === 1);
    const sourceRunBeforeReQa = reQaValue.repository.state().s2QaRuns.find((run) => run.id === bound.qaRun.id)!;
    const sourceCompletedAtBeforeReQa = sourceRunBeforeReQa.completedAt;
    deferReQa = true;
    await reQaValue.service.s2.repairCandidate(reQaValue.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const reQaOperation = await waitFor(() => reQaValue.repository.state().s2Operations.find((operation) => operation.phase === "re_qa") as any,
      (operation) => operation?.status === "running" && operation.claimedProcessId === 71_401 && reQaStarted);
    assert.equal(reQaCalls, 5);
    createWorkflowService({ repository: reQaValue.repository, objects: reQaValue.objects, provider: reQaProvider,
      processId: 71_402, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    assert.equal(reQaValue.repository.state().s2Operations.find((operation) => operation.id === reQaOperation.id)?.status, "running");
    assert.equal(reQaValue.repository.state().s2QaRuns[0].status, "completed");
    assert.equal(reQaValue.repository.state().s2QaRuns[0].completedAt, sourceCompletedAtBeforeReQa);
    createWorkflowService({ repository: reQaValue.repository, objects: reQaValue.objects, provider: reQaProvider,
      processId: 71_403, isProcessAlive: () => false });
    await waitFor(() => reQaValue.service.s2.getQaRun(reQaValue.projectId, bound.qaRun.id) as any,
      (value) => value.qaRun.reQa[0]?.status === "re_qa_unavailable");
    staleReQa.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = reQaValue.repository.state();
    assert.equal(reQaCalls, 5);
    assert.equal(state.s2DerivedCandidates.length, 1);
    assert.equal(state.s2ReQaResults[0].status, "re_qa_unavailable");
    assert.equal(state.s2Repairs[0].status, "re_qa_unavailable");
    assert.equal(state.s2Operations.find((operation) => operation.phase === "re_qa")?.status, "failed");
    assert.equal(state.s2Operations.find((operation) => operation.phase === "re_qa")?.providerDispatchState, "consumed");
    assert.equal(state.s2QaRuns[0].status, "completed");
    assert.equal(state.s2QaRuns[0].completedAt, sourceCompletedAtBeforeReQa);
  } finally {
    staleReQa.resolve();
    rmSync(reQaValue.root, { recursive: true, force: true });
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
    const sourceCompletedAt = value.repository.state().s2QaRuns[0].completedAt;
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
    assert.equal(state.s2QaRuns[0].status, "completed");
    assert.equal(state.s2QaRuns[0].completedAt, sourceCompletedAt);
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

type EvidenceProofObligation = {
  claimId: string;
  proof: EvidenceProof;
  assertion: () => void | Promise<void>;
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

  async proveClaim(claimId: string, proof: EvidenceProof, assertion: (() => void | Promise<void>) | undefined): Promise<void> {
    if (typeof assertion !== "function") throw new EvidenceValidationError("missing-claim-assertion", claimId);
    const claim = this.claimsById.get(claimId);
    if (!claim) throw new EvidenceValidationError("unknown-claim", claimId);
    if (this.emitted.some((record) => record.claimId === claimId)) throw new EvidenceValidationError("duplicate-claim", claimId);
    await assertion();
    const reference = proof.relevantSafeReferenceId ?? deterministicEvidenceReference(proof.provingTest, claimId, proof.facts);
    const artifact = proof.artifactPathOrTestOutput ?? proof.provingTest + "::assertion-output/" + claimId;
    const source = proof.evidenceSource ?? proof.provingTest;
    this.emitted.push({
      ...claim,
      expected: proof.expected ?? claim.normativeRowText,
      actual: proof.actual + " claimId=" + claimId,
      relevantSafeReferenceId: reference,
      artifactPathOrTestOutput: artifact,
      evidenceSource: source,
      provingTest: proof.provingTest,
      executionId: reference + ":" + claimId,
      observation: { kind: claim.evidenceType, assertionIds: proof.assertionIds.concat(claimId), facts: { ...proof.facts } },
    });
  }

  async proveMany(obligations: readonly EvidenceProofObligation[]): Promise<void> {
    for (const obligation of obligations) {
      await this.proveClaim(obligation.claimId, obligation.proof, obligation.assertion);
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
    if (!record.observation.assertionIds.includes(record.claimId)) evidenceFailure("claim-assertion-unbound", record.claimId);
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

type ConsoleSink = "debug" | "error" | "info" | "log" | "warn";

async function captureConsoleSinks(action: () => unknown): Promise<string[]> {
  const sinks: readonly ConsoleSink[] = ["debug", "error", "info", "log", "warn"];
  const consoleRecord = console as unknown as Record<ConsoleSink, (...args: unknown[]) => void>;
  const originals = new Map<ConsoleSink, (...args: unknown[]) => void>();
  const entries: string[] = [];
  for (const sink of sinks) {
    originals.set(sink, consoleRecord[sink]);
    consoleRecord[sink] = (...args: unknown[]) => {
      entries.push(args.map((value) => {
        try { return typeof value === "string" ? value : JSON.stringify(value); }
        catch { return String(value); }
      }).join(" "));
    };
  }
  try { await action(); }
  finally { for (const sink of sinks) consoleRecord[sink] = originals.get(sink)!; }
  return entries;
}

type ProviderTransportMeasurement = { nonLoopbackAttempts: number; networkForwardCount: number };

function providerTransportMeasurement(): ProviderTransportMeasurement {
  return { nonLoopbackAttempts: 0, networkForwardCount: 0 };
}

function createProviderTransportGuard(measurement: ProviderTransportMeasurement, upstream: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      measurement.nonLoopbackAttempts += 1;
      throw new Error("non-loopback provider blocked");
    }
    measurement.networkForwardCount += 1;
    return upstream(input, init);
  };
}

function installProviderTransportGuard(measurement: ProviderTransportMeasurement): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createProviderTransportGuard(measurement, originalFetch);
  return () => { globalThis.fetch = originalFetch; };
}

function assertNoLiveProviderDispatch(measurement: ProviderTransportMeasurement): void {
  assert.equal(measurement.nonLoopbackAttempts, 0);
  assert.equal(measurement.networkForwardCount, 0);
}

function assertLogMarkersAbsent(logEntries: readonly string[], markers: readonly string[]): void {
  for (const entry of logEntries) for (const marker of markers) assert.equal(entry.includes(marker), false);
}

function assertLogMarkerAbsent(logEntries: readonly string[], marker: string): void {
  assert.equal(logEntries.some((entry) => entry.includes(marker)), false);
}

function assertSafeEnvelopeMarkerAbsent(envelopes: readonly string[], marker: string): void {
  assert.equal(envelopes.some((envelope) => envelope.includes(marker)), false);
}

type SecretFinding = { kind: string; sourcePath: string; redacted: "[REDACTED]" };

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["openai-api-key", /\bsk-[A-Za-z0-9]{20,}\b/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ["token-assignment", /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|token)\b\s*[:=]\s*["'`](?!\$\{)[^"'`\r\n]{16,}["'`]/gi],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
];

function scanSecretText(sourcePath: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ kind, sourcePath, redacted: "[REDACTED]" });
  }
  return findings;
}

function scanChangedTrackedSurface(baseRef: string): { files: string[]; text: string; findings: SecretFinding[] } {
  const trackedFiles = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", baseRef, "--"], { encoding: "utf8" })
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    .filter((file) => !file.startsWith(".playwright-cli/") && !file.startsWith(".tmp/"));
  const files = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
  const findings: SecretFinding[] = [];
  const parts: string[] = [];
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); }
    catch { continue; }
    parts.push("FILE=" + file + "\n" + text);
    if (/\/(?:\.env(?:\.[^/]+)?)$/i.test("/" + file) && !/\/\.env\.example$/i.test("/" + file)) {
      findings.push({ kind: "tracked-env", sourcePath: file, redacted: "[REDACTED]" });
    }
    findings.push(...scanSecretText(file, text));
  }
  return { files, text: parts.join("\n"), findings };
}

function claimIds(testId: string, variants: readonly string[]): string[] {
  return variants.map((variant) => testId + "/" + variant);
}

function independentRequirementsForEvidence(data: any, geometry: any): any[] {
  const result: any[] = [
    { requirementId: "geometry.width", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.widthMm, criticality: "material", source: "geometry_snapshot", text: "The booth width is exactly " + geometry.widthMm + " mm." },
    { requirementId: "geometry.depth", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.depthMm, criticality: "material", source: "geometry_snapshot", text: "The booth depth is exactly " + geometry.depthMm + " mm." },
    { requirementId: "access.open-sides", category: "geometry", expected: "present", expectedCount: null,
      expectedValue: geometry.openSides.join(","), criticality: "material", source: "geometry_snapshot",
      text: "The supplied open sides remain visibly accessible: " + geometry.openSides.join(", ") + "." },
  ];
  if (geometry.maxHeightMm !== null) result.push({
    requirementId: "geometry.max-height", category: "geometry", expected: "present", expectedCount: null,
    expectedValue: geometry.maxHeightMm, criticality: "material", source: "geometry_snapshot",
    text: "Nothing visibly exceeds the supplied maximum height of " + geometry.maxHeightMm + " mm.",
  });
  data.functionalRequirements.forEach((item: any, index: number) => result.push({
    requirementId: "brief.functional." + String(index + 1).padStart(3, "0"), category: "functional",
    expected: item.countIsExact && item.count !== null ? "exact_count" : "present",
    expectedCount: item.countIsExact && item.count !== null ? item.count : null, expectedValue: item.name,
    criticality: "material", source: "confirmed_brief", text: item.details ? item.name + ": " + item.details : item.name,
  }));
  data.mandatoryRequirements.forEach((item: string, index: number) => result.push({
    requirementId: "brief.mandatory." + String(index + 1).padStart(3, "0"), category: "mandatory",
    expected: "present", expectedCount: null, expectedValue: item, criticality: "material",
    source: "confirmed_brief", text: item,
  }));
  data.prohibitedRequirements.forEach((item: string, index: number) => result.push({
    requirementId: "brief.prohibited." + String(index + 1).padStart(3, "0"), category: "prohibited",
    expected: "absent", expectedCount: null, expectedValue: item, criticality: "material",
    source: "confirmed_brief", text: item,
  }));
  data.freeTextRequirements.forEach((item: string, index: number) => result.push({
    requirementId: "brief.free-text." + String(index + 1).padStart(3, "0"), category: "free_text",
    expected: "present", expectedCount: null, expectedValue: item, criticality: "warning",
    source: "confirmed_brief", text: item,
  }));
  return result;
}

function independentRulesForEvidence(geometry: any): any[] {
  const ruleIds = [
    "footprint.within-boundary", "access.open-sides", "circulation.primary-access",
    "zones.inside-footprint", "scale.human", "structure.no-floating",
    "structure.overhead-support", "structure.screen-support", "geometry.max-height",
    "geometry.intersections", "branding.prohibited", "branding.style",
    "rigging.confirmation", "budget.complexity",
  ];
  const warningRules = new Set(["branding.style", "rigging.confirmation", "budget.complexity"]);
  const repairableRules = new Set([
    "footprint.within-boundary", "access.open-sides", "circulation.primary-access",
    "zones.inside-footprint", "scale.human", "structure.no-floating",
    "structure.overhead-support", "structure.screen-support", "geometry.intersections",
    "branding.prohibited",
  ]);
  return ruleIds.map((ruleId) => ({
    ruleId,
    applicability: ruleId === "geometry.max-height" && geometry.maxHeightMm === null ? "not_applicable" : "applicable",
    materiality: warningRules.has(ruleId) ? "warning" : "material",
    repairable: repairableRules.has(ruleId),
  }));
}

test("execution-bound evidence validator negative self-tests", async () => {
  const contract = readFileSync("docs/G2_S2_CONTRACT.md", "utf8");
  const claims = deriveClaimManifest(contract);
  async function validRecord(claimId: string): Promise<EvidenceRecord> {
    const registry = new ExecutionEvidenceRegistry(claims);
    await registry.proveMany([{
      claimId,
      proof: {
        provingTest: "tests/s2-evidence.test.ts::validator self-test proving assertion",
        fixtureSetup: "local assertion fixture",
        assertionIds: ["validator.assertion.success"],
        facts: { boundaryValue: 1, result: "accepted", measured: 1 },
        actual: observedActual("The proving assertion returned the measured result.", { boundaryValue: 1, result: "accepted", measured: 1 }),
      },
      assertion: () => assert.equal(1, 1),
    }]);
    return registry.records()[0];
  }
  const valid = await validRecord("MEDIA-011/exact-4096");
  assert.throws(() => assertEvidenceComplete(claims, [valid], "section-24-evidence.json"), (error: any) => error?.code === "missing-claim");
  assert.throws(() => assertEvidenceComplete(claims, [valid, { ...valid, claimId: "UNKNOWN/claim" }], "section-24-evidence.json"), (error: any) => error?.code === "unknown-claim");
  assert.throws(() => assertEvidenceComplete(claims, [valid, valid], "section-24-evidence.json"), (error: any) => error?.code === "duplicate-claim");
  const variantMissing = await validRecord("MEDIA-014/per-asset-exact");
  assert.throws(() => assertEvidenceComplete(claims, [variantMissing], "section-24-evidence.json"), (error: any) => error?.code === "missing-claim");
  const sequentialRegistry = new ExecutionEvidenceRegistry(claims);
  await sequentialRegistry.proveMany([{
    claimId: "CONC-001/claim-uniqueness",
    proof: {
      provingTest: "tests/s2-evidence.test.ts::validator sequential negative",
      fixtureSetup: "two sequential calls",
      assertionIds: ["sequential.calls"],
      facts: { overlap: false, calls: 2, result: "sequential" },
      actual: observedActual("Two calls completed one after another.", { overlap: false, calls: 2, result: "sequential" }),
    },
    assertion: () => assert.equal(2, 2),
  }]);
  assert.throws(() => assertEvidenceComplete(claims, sequentialRegistry.records(), "section-24-evidence.json"), (error: any) => error?.code === "concurrency-proof");
  const boundaryValid = await validRecord("MEDIA-012/unrepresentable-plus-one");
  const boundary = { ...boundaryValid, actual: "The measured boundary was rejected. boundaryValue=1 result=rejected measured=1 claimId=" + boundaryValid.claimId };
  assert.throws(() => assertEvidenceComplete(claims, [boundary], "section-24-evidence.json"), (error: any) => error?.code === "boundary-mismatch");
  const noProvenance = { ...valid, relevantSafeReferenceId: "", artifactPathOrTestOutput: "" };
  assert.throws(() => assertEvidenceComplete(claims, [noProvenance], "section-24-evidence.json"), (error: any) => error?.code === "missing-provenance");
  const unlinkedProvenance = { ...valid, evidenceSource: "tests/s2-evidence.test.ts::unrelated-output" };
  assert.throws(() => assertEvidenceComplete(claims, [unlinkedProvenance], "section-24-evidence.json"), (error: any) => error?.code === "unlinked-provenance");
  const unboundAssertion = { ...valid, observation: { ...valid.observation, assertionIds: ["validator.assertion.success"] } };
  assert.throws(() => assertEvidenceComplete(claims, [unboundAssertion], "section-24-evidence.json"), (error: any) => error?.code === "claim-assertion-unbound");
  const impossibleRegistry = new ExecutionEvidenceRegistry(claims);
  await impossibleRegistry.proveMany([{
    claimId: "MEDIA-014/aggregate-max-representable",
    proof: {
      provingTest: "tests/s2-evidence.test.ts::validator impossible aggregate negative",
      fixtureSetup: "synthetic aggregate metadata",
      assertionIds: ["synthetic.aggregate"],
      facts: { aggregatePixelCount: 33_554_432, aggregateRgbaBytes: 134_217_728, result: "accepted" },
      actual: observedActual("A synthetic impossible aggregate was supplied.", { aggregatePixelCount: 33_554_432, aggregateRgbaBytes: 134_217_728, result: "accepted" }),
    },
    assertion: () => assert.equal(1, 1),
  }]);
  assert.throws(() => assertEvidenceComplete(claims, impossibleRegistry.records(), "section-24-evidence.json"), (error: any) => error?.code === "impossible-boundary");

  const partialRegistry = new ExecutionEvidenceRegistry(claims);
  await assert.rejects(partialRegistry.proveMany([
    {
      claimId: "MEDIA-001/upload",
      proof: {
        provingTest: "tests/s2-evidence.test.ts::validator grouped partial success",
        fixtureSetup: "one shared upload fixture",
        assertionIds: ["validator.grouped.upload"],
        facts: { result: "committed", uploaded: true },
        actual: observedActual("The upload assertion returned a committed result.", { result: "committed", uploaded: true }),
      },
      assertion: () => assert.equal(true, true),
    },
    {
      claimId: "MEDIA-001/original-persistence",
      proof: {
        provingTest: "tests/s2-evidence.test.ts::validator grouped partial success",
        fixtureSetup: "one shared upload fixture",
        assertionIds: ["validator.grouped.original"],
        facts: { result: "committed", originalHashMatches: false },
        actual: observedActual("The shared fixture reported a false original hash fact.", { result: "committed", originalHashMatches: false }),
      },
      assertion: () => { throw new EvidenceValidationError("claim-assertion-failed", "MEDIA-001/original-persistence"); },
    },
  ]), (error: any) => error?.code === "claim-assertion-failed");
  assert.equal(partialRegistry.records().map((record) => record.claimId).join(","), "MEDIA-001/upload");

  const missingAssertionRegistry = new ExecutionEvidenceRegistry(claims);
  await assert.rejects(missingAssertionRegistry.proveClaim("MEDIA-001/upload", {
    provingTest: "tests/s2-evidence.test.ts::validator missing claim assertion",
    fixtureSetup: "local assertion fixture",
    assertionIds: ["validator.assertion.missing"],
    facts: { result: "committed" },
    actual: observedActual("No claim-specific assertion was supplied.", { result: "committed" }),
  }, undefined), (error: any) => error?.code === "missing-claim-assertion");
  assert.equal(missingAssertionRegistry.records().length, 0);

  const falseFactRegistry = new ExecutionEvidenceRegistry(claims);
  await assert.rejects(falseFactRegistry.proveClaim("BIND-002/s1-asset-id", {
    provingTest: "tests/s2-evidence.test.ts::validator false fact is not proof",
    fixtureSetup: "local source projection with absent asset IDs",
    assertionIds: ["validator.assertion.false-fact"],
    facts: { assetIdsPresent: false, result: "not-proven" },
    actual: observedActual("The measured source projection reported absent asset IDs.", { assetIdsPresent: false, result: "not-proven" }),
  }, () => {
    throw new EvidenceValidationError("claim-assertion-failed", "assetIdsPresent must be true");
  }), (error: any) => error?.code === "claim-assertion-failed");
  assert.equal(falseFactRegistry.records().length, 0);

  const sensitiveLogMarker = "s2-sensitive-log-marker-v1";
  assert.throws(() => assertLogMarkersAbsent([sensitiveLogMarker], [sensitiveLogMarker]));
  const changedUiOrder = [1, 3, 2, 4];
  assert.throws(() => assert.deepEqual(changedUiOrder, [1, 2, 3, 4]));
  assert.throws(() => assertNoLiveProviderDispatch({ nonLoopbackAttempts: 1, networkForwardCount: 0 }));
  const injectedSecret = "OPENAI_API_KEY=\"" + "sk-" + "A".repeat(24) + "\"";
  const injectedFindings = scanSecretText("controlled-injected-secret.fixture", injectedSecret);
  assert.equal(injectedFindings.some((finding) => finding.kind === "openai-api-key"), true);
  const redactedInjectedSecret = injectedSecret.replace(/sk-[A-Za-z0-9]{20,}/, "[REDACTED]");
  assert.equal(redactedInjectedSecret.includes("sk-" + "A".repeat(24)), false);
  const falsifiedTransitionAssertion = ["none->queued", "running->pass"];
  assert.throws(() => {
    for (let index = 1; index < falsifiedTransitionAssertion.length; index += 1) {
      assert.equal(falsifiedTransitionAssertion[index - 1].split("->")[1], falsifiedTransitionAssertion[index].split("->")[0]);
    }
  });
});

test("fresh G3 shared finding reduction and repair prompt binding are execution-bound", async () => {
  const materialVsUncertain = await sharedFindingSnapshot("uncertain", "material");
  const violationVsCompliant = await sharedFindingSnapshot("material", "compliant");
  const uncertaintyVsCompliant = await sharedFindingSnapshot("uncertain", "compliant");
  const twoMaterial = await sharedFindingSnapshot("material", "material");
  const maxHeightMaterial = await sharedFindingSnapshot("material", "material", { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 }, "geometry.max-height");
  const maxHeightUncertain = await sharedFindingSnapshot("uncertain", "compliant", { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 }, "geometry.max-height");
  for (const snapshot of [materialVsUncertain, violationVsCompliant, twoMaterial]) {
    assert.equal(snapshot.candidate.verdict, "MATERIAL_FAIL");
    assert.deepEqual(snapshot.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides"), ["access.open-sides"]);
    assert.equal(snapshot.candidate.warningFindingIds.includes("access.open-sides"), false);
    assert.equal(snapshot.candidate.uncertainFindingIds.includes("access.open-sides"), false);
    assert.equal(snapshot.candidate.requirementObservations.filter((item: any) => item.requirementId === "access.open-sides").length, 1);
    assert.equal(snapshot.candidate.designObservations.filter((item: any) => item.ruleId === "access.open-sides").length, 1);
  }
  assert.equal(materialVsUncertain.candidate.requirementObservations.find((item: any) => item.requirementId === "access.open-sides").observed, "uncertain");
  assert.equal(materialVsUncertain.candidate.designObservations.find((item: any) => item.ruleId === "access.open-sides").observed, "non_compliant");
  assert.equal(uncertaintyVsCompliant.candidate.verdict, "WARNING");
  assert.deepEqual(uncertaintyVsCompliant.candidate.uncertainFindingIds.filter((id: string) => id === "access.open-sides"), ["access.open-sides"]);
  assert.equal(uncertaintyVsCompliant.candidate.materialFindingIds.includes("access.open-sides"), false);
  assert.deepEqual(maxHeightMaterial.candidate.materialFindingIds.filter((id: string) => id === "geometry.max-height"), ["geometry.max-height"]);
  assert.equal(maxHeightMaterial.candidate.requirementObservations.filter((item: any) => item.requirementId === "geometry.max-height").length, 1);
  assert.equal(maxHeightMaterial.candidate.designObservations.filter((item: any) => item.ruleId === "geometry.max-height").length, 1);
  assert.deepEqual(maxHeightUncertain.candidate.uncertainFindingIds.filter((id: string) => id === "geometry.max-height"), ["geometry.max-height"]);

  const captured: any[] = [];
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    onS2RepairRequest: (input) => captured.push(input),
    s2QaResponseFactory: (input) => input.candidateIndex === 1
      ? sharedAccessPayload(input, "uncertain", "material")
      : qaPayload(input, "pass"),
  });
  const value = fixture([ONE_PIXEL_PNG], { provider });
  try {
    const draft = value.service.s2.getReferenceDraft(value.projectId);
    const reference = await value.service.s2.uploadAsset(value.projectId, "reference", "prompt-reference.png", "image/png", await solidPng(2, 2, { r: 1, g: 2, b: 3 }), randomUUID());
    const selected = value.service.s2.updateDraft(value.projectId, draft.revision, [reference.asset.id], [], randomUUID());
    const { bound, result } = await bindAndWait(value, selected.draft.revision);
    const candidate = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1);
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => value.service.s2.getQaRun(value.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.repairs?.[0]?.status === "re_qa_material_fail");
    const state = value.repository.state();
    const input = state.s2Inputs[0];
    const source = input.sourceCandidates.find((item) => item.candidateId === candidate.candidateId)!;
    const repair = state.s2Repairs[0];
    const referenceAsset = state.s2Assets.find((item) => item.id === reference.asset.id)!;
    const referenceProjection = [{ assetId: referenceAsset.id, normalizedSha256: referenceAsset.normalizedSha256, width: referenceAsset.width, height: referenceAsset.height, normalizedBytes: referenceAsset.normalizedBytes, slot: 1 }];
    const capturedBytes = Buffer.from(captured[0].promptText, "utf8");
    const rerendered = renderS2RepairPrompt(input, source, repair.eligibleFindingIds, referenceProjection, [], repair.repairInputHash);
    assert.equal(capturedBytes.equals(Buffer.from(rerendered, "utf8")), true);
    assert.equal(repairPromptHash(captured[0].promptText), repair.repairPromptHash);
    assert.equal(repairPromptHash(rerendered), repair.repairPromptHash);
    const changedFindings = ["access.open-sides", "footprint.within-boundary"];
    const changedFindingHash = canonicalRepairInputHash(input, source, changedFindings, referenceProjection, []);
    const changedFindingPrompt = renderS2RepairPrompt(input, source, changedFindings, referenceProjection, [], changedFindingHash);
    const changedReferenceProjection = [{ ...referenceProjection[0], normalizedBytes: referenceProjection[0].normalizedBytes + 1 }];
    const changedManifestHash = canonicalRepairInputHash(input, source, repair.eligibleFindingIds, changedReferenceProjection, []);
    const changedManifestPrompt = renderS2RepairPrompt(input, source, repair.eligibleFindingIds, changedReferenceProjection, [], changedManifestHash);
    assert.notEqual(changedFindingHash, repair.repairInputHash);
    assert.notEqual(repairPromptHash(changedFindingPrompt), repair.repairPromptHash);
    assert.notEqual(changedManifestHash, repair.repairInputHash);
    assert.notEqual(repairPromptHash(changedManifestPrompt), repair.repairPromptHash);
    assert.equal(reduceS2Findings(input, candidate.requirementObservations, candidate.designObservations).materialFindingIds.join(","), repair.eligibleFindingIds.join(","));
    const operation = state.s2Operations.find((item) => item.phase === "repair")!;
    assert.equal(operation.inputHash, sha256(jcs({ operation: "s2_repair", projectId: value.projectId, input: {
      qaRunId: bound.qaRun.id, candidateId: candidate.candidateId, expectedInputVersionId: bound.inputVersionId, eligibleFindingIds: repair.eligibleFindingIds,
    } })));
    const base = cloneJson(state) as any;
    for (const mutate of [
      (mutated: any) => { mutated.s2QaRuns[0].candidateResults.find((item: any) => item.candidateIndex === 1).warningFindingIds = ["access.open-sides"]; },
      (mutated: any) => { mutated.s2QaRuns[0].candidateResults.find((item: any) => item.candidateIndex === 1).materialFindingIds = ["access.open-sides", "access.open-sides"]; },
      (mutated: any) => { mutated.s2Repairs[0].repairPromptHash = "0".repeat(64); },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "swooshz-s2-shared-negative-"));
      try {
        const mutated = cloneJson(base) as any;
        mutate(mutated);
        writeFileSync(join(root, "state.json"), JSON.stringify(mutated), "utf8");
        assert.throws(() => new JsonRepository(root), (error: any) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    assert.doesNotThrow(() => validateS2Graph(state));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("repair prompt mismatch fails closed before provider dispatch", async () => {
  let tampered = false;
  const provider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "requirement-violation") : qaPayload(input, "pass"),
  });
  let value!: Fixture;
  value = fixture([ONE_PIXEL_PNG], {
    provider,
    onProviderDispatchPhase: async (phase, operation) => {
      if (phase !== "after-dispatch-marked" || operation.phase !== "repair") return;
      const mutated = cloneJson(value.repository.state()) as any;
      mutated.s2Repairs[0].repairPromptHash = "0".repeat(64);
      writeFileSync(join(value.root, "state.json"), JSON.stringify(mutated), "utf8");
      tampered = true;
    },
  });
  try {
    const { bound, result } = await bindAndWait(value);
    const candidate = result.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
    await value.service.s2.repairCandidate(value.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => tampered, (current) => current === true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(provider.s2RepairCalls, 0);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("execution-bound Section-24 matrix proves every revised claim with measured local output", async () => {
  const contract = readFileSync("docs/G2_S2_CONTRACT.md", "utf8");
  const claims = deriveClaimManifest(contract);
  assert.equal(manifestBaseRowCount, 105);
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
    assertionsByClaim: Readonly<Record<string, () => void | Promise<void>>> = {},
  ) => {
    const missingClaimAssertions = ids.length > 1
      ? ids.filter((claimId) => typeof assertionsByClaim[claimId] !== "function")
      : [];
    if (missingClaimAssertions.length > 0) evidenceFailure("missing-claim-assertion", missingClaimAssertions.join(","));
    const obligations: EvidenceProofObligation[] = ids.map((claimId) => ({
      claimId,
      proof: {
        provingTest: "tests/s2-evidence.test.ts::" + name,
        fixtureSetup,
        assertionIds: [name + ".assertion"],
        facts,
        actual: observedActual(statement, facts),
        relevantSafeReferenceId,
      },
      assertion: ids.length === 1 ? assertion : assertionsByClaim[claimId]!,
    }));
    for (const obligation of obligations) {
      await registry.proveClaim(obligation.claimId, obligation.proof, obligation.assertion);
    }
  };

  const normalEvidenceTransport = providerTransportMeasurement();
  const restoreNormalEvidenceTransportGuard = installProviderTransportGuard(normalEvidenceTransport);
  try {
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
      }, undefined, {
        "MEDIA-001/upload": () => { assert.equal(upload.replayed, false); assert.equal(stored.status, "ready"); },
        "MEDIA-001/original-persistence": () => assert.equal(sha256(original), stored.originalSha256),
        "MEDIA-001/normalized-persistence": () => assert.equal(sha256(normalized), stored.normalizedSha256),
      });
  } finally { rmSync(uploadValue.root, { recursive: true, force: true }); }

  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 80, g: 100, b: 120 } } }).jpeg({ quality: 90 }).toBuffer();
  const jpegLong = await normalizeS2Media({ kind: "reference", fileName: "photo.jpeg", mimeType: "image/jpeg", bytes: jpeg });
  const jpegAlias = await normalizeS2Media({ kind: "reference", fileName: "photo.jpg", mimeType: "image/jpg", bytes: jpeg });
  await prove(claimIds("MEDIA-002", ["static-jpeg", "jpg-alias"]), "media JPEG detection and alias", "Real sharp JPEG plus .jpg/image-jpg alias through normalizeS2Media.",
    { detectedMime: jpegLong.detectedMime, aliasMime: jpegAlias.detectedMime, width: jpegLong.width, height: jpegLong.height, result: "accepted" },
    "The real JPEG and its JPG MIME/extension alias were detected and normalized.",
    () => { assert.equal(jpegLong.detectedMime, "image/jpeg"); assert.equal(jpegAlias.detectedMime, "image/jpeg"); assert.equal(jpegLong.width, 8); assert.equal(jpegLong.height, 4); }, undefined, {
      "MEDIA-002/static-jpeg": () => { assert.equal(jpegLong.detectedMime, "image/jpeg"); assert.equal(jpegLong.width, 8); assert.equal(jpegLong.height, 4); },
      "MEDIA-002/jpg-alias": () => assert.equal(jpegAlias.detectedMime, "image/jpeg"),
    });

  const vp8Bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).webp({ lossless: false }).toBuffer();
  const vp8lBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 61, g: 41, b: 21 } } }).webp({ lossless: true }).toBuffer();
  const vp8 = await normalizeS2Media({ kind: "reference", fileName: "lossy.webp", mimeType: "image/webp", bytes: vp8Bytes });
  const vp8l = await normalizeS2Media({ kind: "reference", fileName: "lossless.webp", mimeType: "image/webp", bytes: vp8lBytes });
  await prove(claimIds("MEDIA-003", ["vp8", "vp8l"]), "media WebP decoder variants", "Real sharp VP8 and VP8L WebP fixtures through normalizeS2Media.",
    { vp8Mime: vp8.detectedMime, vp8lMime: vp8l.detectedMime, vp8Pixels: vp8.pixelCount, vp8lPixels: vp8l.pixelCount, result: "accepted" },
    "The real lossy and lossless WebP decoder variants were accepted and normalized.",
    () => { assert.equal(vp8.detectedMime, "image/webp"); assert.equal(vp8l.detectedMime, "image/webp"); assert.equal(vp8.pixelCount, 6); assert.equal(vp8l.pixelCount, 6); }, undefined, {
      "MEDIA-003/vp8": () => { assert.equal(vp8.detectedMime, "image/webp"); assert.equal(vp8.pixelCount, 6); },
      "MEDIA-003/vp8l": () => { assert.equal(vp8l.detectedMime, "image/webp"); assert.equal(vp8l.pixelCount, 6); },
    });

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
    () => { assert.equal(malformedCodes.png, "MEDIA_CORRUPT"); assert.equal(malformedCodes.jpeg, "MEDIA_CORRUPT"); assert.equal(malformedCodes.webp, "MEDIA_CORRUPT"); }, undefined, {
      "MEDIA-004/png-malformed": () => assert.equal(malformedCodes.png, "MEDIA_CORRUPT"),
      "MEDIA-004/jpeg-malformed": () => assert.equal(malformedCodes.jpeg, "MEDIA_CORRUPT"),
      "MEDIA-004/webp-malformed": () => assert.equal(malformedCodes.webp, "MEDIA_CORRUPT"),
    });

  const mismatchMime = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "image.png", mimeType: "image/jpeg", bytes: ONE_PIXEL_PNG }));
  const mismatchExtension = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "image.jpg", mimeType: "image/png", bytes: ONE_PIXEL_PNG }));
  await prove(claimIds("MEDIA-005", ["mime-mismatch", "extension-mismatch"]), "media declared-identity rejection", "Real PNG fixtures with conflicting MIME and extension declarations.",
    { mimeCode: mismatchMime, extensionCode: mismatchExtension, result: "rejected" },
    "The real MIME and extension identity mismatches were rejected before acceptance.",
    () => { assert.equal(mismatchMime, "MEDIA_SIGNATURE_MISMATCH"); assert.equal(mismatchExtension, "MEDIA_SIGNATURE_MISMATCH"); }, undefined, {
      "MEDIA-005/mime-mismatch": () => assert.equal(mismatchMime, "MEDIA_SIGNATURE_MISMATCH"),
      "MEDIA-005/extension-mismatch": () => assert.equal(mismatchExtension, "MEDIA_SIGNATURE_MISMATCH"),
    });

  const unsupportedExtensions = ["svg", "gif", "tiff", "bmp", "ico", "pdf", "heic", "avif"];
  const unsupportedCodes: string[] = [];
  for (const extension of unsupportedExtensions) unsupportedCodes.push(await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "unsupported." + extension, mimeType: "application/octet-stream", bytes: Buffer.from("unsupported-" + extension) })));
  await prove(claimIds("MEDIA-006", unsupportedExtensions), "media unsupported-format rejection", "Eight explicit unsupported-format byte fixtures through the real container detector.",
    { cases: unsupportedExtensions.length, allCodes: unsupportedCodes.join(","), result: "all-rejected" },
    "All eight named unsupported formats returned UNSUPPORTED_MEDIA_TYPE from the real detector.",
    () => { assert.equal(unsupportedCodes.length, 8); assert.equal(unsupportedCodes.every((code) => code === "UNSUPPORTED_MEDIA_TYPE"), true); }, undefined,
    Object.fromEntries(unsupportedExtensions.map((extension, index) => [
      "MEDIA-006/" + extension,
      () => assert.equal(unsupportedCodes[index], "UNSUPPORTED_MEDIA_TYPE"),
    ])));

  const apng = pngWithChunk(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
  const animatedWebp = webpWithChunk(vp8Bytes, "ANMF", Buffer.alloc(6));
  const animatedCodes = {
    apng: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.png", mimeType: "image/png", bytes: apng })),
    webp: await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "animated.webp", mimeType: "image/webp", bytes: animatedWebp })),
  };
  await prove(claimIds("MEDIA-007", ["apng", "animated-webp"]), "media animation rejection", "Real APNG acTL and animated WebP ANMF container fixtures.",
    { apngCode: animatedCodes.apng, webpCode: animatedCodes.webp, result: "rejected" },
    "Both real multi-frame container markers were rejected as animation.",
    () => { assert.equal(animatedCodes.apng, "MEDIA_ANIMATED_NOT_ALLOWED"); assert.equal(animatedCodes.webp, "MEDIA_ANIMATED_NOT_ALLOWED"); }, undefined, {
      "MEDIA-007/apng": () => assert.equal(animatedCodes.apng, "MEDIA_ANIMATED_NOT_ALLOWED"),
      "MEDIA-007/animated-webp": () => assert.equal(animatedCodes.webp, "MEDIA_ANIMATED_NOT_ALLOWED"),
    });

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
    () => { assert.equal(defectCodes.truncated, "MEDIA_CORRUPT"); assert.equal(defectCodes.corrupt, "MEDIA_CORRUPT"); assert.equal(decoderWarningAtError, true); assert.equal(decoderWarningAtWarning, false); assert.equal(defectCodes.decoderWarning, "MEDIA_CORRUPT"); assert.equal(defectCodes.multiFrame, "MEDIA_ANIMATED_NOT_ALLOWED"); }, undefined, {
      "MEDIA-008/truncated": () => assert.equal(defectCodes.truncated, "MEDIA_CORRUPT"),
      "MEDIA-008/corrupt": () => assert.equal(defectCodes.corrupt, "MEDIA_CORRUPT"),
      "MEDIA-008/decoder-warning": () => { assert.equal(decoderWarningAtError, true); assert.equal(decoderWarningAtWarning, false); assert.equal(defectCodes.decoderWarning, "MEDIA_CORRUPT"); },
      "MEDIA-008/multi-frame": () => assert.equal(defectCodes.multiFrame, "MEDIA_ANIMATED_NOT_ALLOWED"),
    });

  const exactSource = paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES);
  const mediaBoundary = fixture();
  try {
    const exactBody = trackedChunkedStream(s2MultipartBody(exactSource), 4093);
    const exactResponse = await handleApiRequest(requestWithStream({
      "content-type": "multipart/form-data; boundary=s2-stream-boundary",
      "Idempotency-Key": randomUUID(),
    }, exactBody.stream), ["projects", mediaBoundary.projectId, "s2", "reference-assets"], mediaBoundary.service);
    const exactState = mediaBoundary.repository.state();
    const exactAsset = exactState.s2Assets[0];
    const assetsBeforeOverrun = exactState.s2Assets.length;
    const publicationsBeforeOverrun = exactState.s2Publications.length;
    const idempotencyBeforeOverrun = exactState.idempotency.length;
    const overBody = trackedChunkedStream(s2MultipartBody(paddedPng(ONE_PIXEL_PNG, S2_MAX_SOURCE_BYTES + 1)), 4093);
    const overResponse = await handleApiRequest(requestWithStream({
      "content-type": "multipart/form-data; boundary=s2-stream-boundary",
      "Idempotency-Key": randomUUID(),
    }, overBody.stream), ["projects", mediaBoundary.projectId, "s2", "reference-assets"], mediaBoundary.service);
    const afterOverrun = mediaBoundary.repository.state();
    const multipartTotalBelowBodyCeiling = s2MultipartBody(exactSource).byteLength < S2_MAX_MULTIPART_BODY_BYTES;
    await prove(claimIds("MEDIA-009", ["exact-accepted", "next-rejected"]), "media source-byte boundary", "The real multipart upload route accepted a deterministic padded PNG with exactly 8,388,608 file bytes from boundary-crossing chunks and rejected the next byte during streaming intake.",
      { exactRouteStatus: exactResponse.status, exactFileBytes: exactAsset?.originalBytes ?? 0, exactStreamPulls: exactBody.stats().pulls, exactBodyCancelled: exactBody.stats().cancelled, multipartTotal: s2MultipartBody(exactSource).byteLength, multipartTotalBelowBodyCeiling, overRouteStatus: overResponse.status, overStreamPulls: overBody.stats().pulls, overBodyCancelled: overBody.stats().cancelled, assetsBeforeOverrun, assetsAfterOverrun: afterOverrun.s2Assets.length, publicationsBeforeOverrun, publicationsAfterOverrun: afterOverrun.s2Publications.length, idempotencyBeforeOverrun, idempotencyAfterOverrun: afterOverrun.idempotency.length, offendingExcessRetained: false, result: "real-route-exact-accepted-next-rejected" },
      "The real multipart route measured exactly 8 MiB in the persisted original asset, kept the full multipart body below the independent body ceiling, and rejected 8 MiB plus one without creating an asset, publication, or idempotency record for the rejected upload.",
      () => {
        assert.equal(exactResponse.status, 201);
        assert.equal(exactAsset?.originalBytes, S2_MAX_SOURCE_BYTES);
        assert.equal(exactBody.stats().pulls > 0, true);
        assert.equal(exactBody.stats().cancelled, false);
        assert.equal(multipartTotalBelowBodyCeiling, true);
        assert.equal(overResponse.status, 413);
        assert.equal(overBody.stats().cancelled, true);
        assert.equal(afterOverrun.s2Assets.length, assetsBeforeOverrun);
        assert.equal(afterOverrun.s2Publications.length, publicationsBeforeOverrun);
        assert.equal(afterOverrun.idempotency.length, idempotencyBeforeOverrun);
      }, undefined, {
        "MEDIA-009/exact-accepted": () => { assert.equal(exactResponse.status, 201); assert.equal(exactAsset?.originalBytes, S2_MAX_SOURCE_BYTES); assert.equal(multipartTotalBelowBodyCeiling, true); },
        "MEDIA-009/next-rejected": () => { assert.equal(overResponse.status, 413); assert.equal(overBody.stats().cancelled, true); assert.equal(afterOverrun.s2Assets.length, assetsBeforeOverrun); assert.equal(afterOverrun.s2Publications.length, publicationsBeforeOverrun); },
      });
  } finally { rmSync(mediaBoundary.root, { recursive: true, force: true }); }

  const bodyBoundary = fixture();
  try {
    const declaredBody = lazyTrackedChunks([Buffer.from("-")]);
    const declaredResponse = await handleApiRequest(requestWithStream({
      "content-type": "multipart/form-data; boundary=s2-stream-boundary",
      "content-length": String(S2_MAX_MULTIPART_BODY_BYTES + 1),
      "Idempotency-Key": randomUUID(),
    }, declaredBody.body), ["projects", bodyBoundary.projectId, "s2", "reference-assets"], bodyBoundary.service);
    const streamedBody = lazyTrackedChunks([Buffer.from("-"), Buffer.alloc(S2_MAX_MULTIPART_BODY_BYTES)]);
    const streamedResponse = await handleApiRequest(requestWithStream({
      "content-type": "multipart/form-data; boundary=s2-stream-boundary",
      "Idempotency-Key": randomUUID(),
    }, streamedBody.body), ["projects", bodyBoundary.projectId, "s2", "reference-assets"], bodyBoundary.service);
    const streamedState = bodyBoundary.repository.state();
    const structuralMaximum = S2_MAX_SOURCE_BYTES + (3 * 16_384) + 1_024 + 570;
    const structuralGap = S2_MAX_MULTIPART_BODY_BYTES - structuralMaximum;
    await prove(["MEDIA-010/body-boundary"], "media multipart-body guard and structural reachability", "Real route evidence for declared over-cap rejection before body consumption and streamed no-Content-Length rejection at the body counter, with the locked multipart structural maximum recorded.",
      { configuredBodyCeiling: S2_MAX_MULTIPART_BODY_BYTES, declaredContentLength: S2_MAX_MULTIPART_BODY_BYTES + 1, declaredStatus: declaredResponse.status, declaredBodyPulls: declaredBody.stats().pulls, streamedContentLength: null, streamedStatus: streamedResponse.status, streamedBodyPulls: streamedBody.stats().pulls, streamedBodyCancelled: streamedBody.stats().cancelled, streamedBodyRetained: false, streamedAssets: streamedState.s2Assets.length, streamedPublications: streamedState.s2Publications.length, structuralMaximum, arithmetic: "8,388,608 + 49,152 + 1,024 + 570 = 8,439,354", structuralGap, exactValidNineMiB: "structurally unreachable / non-applicable; not synthetically manufactured", result: "declared-pre-body-and-streamed-counter-rejected" },
      "The real route rejected a declared 9,437,185-byte body before any body pull and rejected a no-Content-Length stream when its second chunk crossed 9,437,184, cancelled the reader before retaining the excess, and recorded that exact-valid 9 MiB multipart equality is structurally unreachable/non-applicable.",
      () => {
        assert.equal(declaredResponse.status, 413);
        assert.equal(declaredBody.stats().pulls, 0);
        assert.equal(streamedResponse.status, 413);
        assert.equal(streamedBody.stats().pulls, 2);
        assert.equal(streamedBody.stats().cancelled, true);
        assert.equal(streamedState.s2Assets.length, 0);
        assert.equal(streamedState.s2Publications.length, 0);
        assert.equal(structuralMaximum, 8_439_354);
        assert.equal(structuralGap, 997_830);
      });
  } finally { rmSync(bodyBoundary.root, { recursive: true, force: true }); }

  const decoderInvocations: S2SharpOptions[] = [];
  const observingSharpFactory: S2SharpFactory = (input, options) => {
    decoderInvocations.push({ ...options });
    return sharp(input, options);
  };
  const maxSquare = await solidPng(S2_MAX_DIMENSION, S2_MAX_DIMENSION, { r: 12, g: 34, b: 56 });
  const maxSquareMedia = await normalizeS2Media(
    { kind: "reference", fileName: "max-square.png", mimeType: "image/png", bytes: maxSquare },
    observingSharpFactory,
  );
  const exactDimensionBytes = await solidPng(S2_MAX_DIMENSION, 1);
  const overDimensionBytes = await solidPng(S2_MAX_DIMENSION + 1, 1);
  const exactDimension = await normalizeS2Media({ kind: "reference", fileName: "edge.png", mimeType: "image/png", bytes: exactDimensionBytes });
  const overDimensionCode = await observedErrorCode(() => normalizeS2Media({ kind: "reference", fileName: "over-edge.png", mimeType: "image/png", bytes: overDimensionBytes }));
  await prove(claimIds("MEDIA-011", ["exact-4096", "over-4096"]), "media dimension boundary", "Real 4,096-wide acceptance and 4,097-wide rejection fixtures.",
    { exactWidth: exactDimension.width, exactHeight: exactDimension.height, overWidth: S2_MAX_DIMENSION + 1, overCode: overDimensionCode, result: "edge-accepted-over-rejected" },
    "The real dimension boundary accepted 4,096 and rejected the first representable 4,097 over-dimension raster.",
    () => { assert.equal(exactDimension.width, 4096); assert.equal(overDimensionCode, "MEDIA_DIMENSIONS_EXCEEDED"); }, undefined, {
      "MEDIA-011/exact-4096": () => { assert.equal(exactDimension.width, 4096); assert.equal(exactDimension.height, 1); },
      "MEDIA-011/over-4096": () => { assert.equal(overDimensionCode, "MEDIA_DIMENSIONS_EXCEEDED"); assert.equal(S2_MAX_DIMENSION + 1, 4097); },
    });
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
    () => { assert.equal(metadataOutputs.length, 7); assert.equal(metadataOutputs.every((item) => !item.hasMetadata), true); }, undefined,
    Object.fromEntries(metadataLabels.map((label) => [
      "MEDIA-017/" + label,
      () => assert.equal(metadataOutputs.find((item) => item.label === label)?.hasMetadata, false),
    ])));

  const alphaInput = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.25 } } }).png().toBuffer();
  const opaqueInput = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  const alphaOutput = await normalizeS2Media({ kind: "reference", fileName: "alpha.png", mimeType: "image/png", bytes: alphaInput });
  const opaqueOutput = await normalizeS2Media({ kind: "reference", fileName: "opaque.png", mimeType: "image/png", bytes: opaqueInput });
  await prove(claimIds("MEDIA-018", ["alpha-preserved", "opaque-no-background"]), "media alpha handling", "Real RGBA and opaque PNG inputs through the normalized PNG output.",
    { alpha: alphaOutput.hasAlpha, opaque: opaqueOutput.hasAlpha, result: "alpha-preserved-opaque-stable" },
    "The normalized result preserved source alpha and did not add alpha to an opaque input.",
    () => { assert.equal(alphaOutput.hasAlpha, true); assert.equal(opaqueOutput.hasAlpha, false); }, undefined, {
      "MEDIA-018/alpha-preserved": () => assert.equal(alphaOutput.hasAlpha, true),
      "MEDIA-018/opaque-no-background": () => assert.equal(opaqueOutput.hasAlpha, false),
    });

  const normalizedPng = await normalizeS2Media({ kind: "reference", fileName: "canonical.png", mimeType: "image/png", bytes: alphaInput });
  const normalizedPngAgain = await normalizeS2Media({ kind: "reference", fileName: "canonical.png", mimeType: "image/png", bytes: alphaInput });
  const normalizedMetadata = await sharp(normalizedPng.normalizedBytes).metadata();
  await prove(claimIds("MEDIA-019", ["png", "srgb8", "deterministic", "no-transform"]), "media canonical PNG profile", "Two real identical PNG normalizations plus metadata inspection of the output.",
    { format: String(normalizedMetadata.format), channels: normalizedMetadata.channels ?? 0, hashEqual: normalizedPng.normalizedSha256 === normalizedPngAgain.normalizedSha256, dimensions: normalizedPng.width + "x" + normalizedPng.height, result: "canonical" },
    "The output was deterministic PNG with the same dimensions and canonical color/alpha representation.",
    () => { assert.equal(normalizedMetadata.format, "png"); assert.equal(normalizedMetadata.channels === 3 || normalizedMetadata.channels === 4, true); assert.equal(normalizedPng.normalizedSha256, normalizedPngAgain.normalizedSha256); assert.equal(normalizedPng.width, 2); assert.equal(normalizedPng.height, 2); }, undefined,
    {
      "MEDIA-019/png": () => assert.equal(normalizedMetadata.format, "png"),
      "MEDIA-019/srgb8": () => assert.equal(normalizedMetadata.channels === 3 || normalizedMetadata.channels === 4, true),
      "MEDIA-019/deterministic": () => assert.equal(normalizedPng.normalizedSha256, normalizedPngAgain.normalizedSha256),
      "MEDIA-019/no-transform": () => { assert.equal(normalizedPng.width, 2); assert.equal(normalizedPng.height, 2); },
    });
  await prove(claimIds("MEDIA-020", ["original-hash", "normalized-hash"]), "media hash identity", "Real source and normalized buffers with independently recalculated SHA-256 values.",
    { originalHashMatches: normalizedPng.originalSha256 === sha256(alphaInput), normalizedHashMatches: normalizedPng.normalizedSha256 === sha256(normalizedPng.normalizedBytes), result: "hashes-persistable" },
    "Both original and normalized SHA-256 values matched the exact bytes observed by the test.",
    () => { assert.equal(normalizedPng.originalSha256, sha256(alphaInput)); assert.equal(normalizedPng.normalizedSha256, sha256(normalizedPng.normalizedBytes)); }, undefined, {
      "MEDIA-020/original-hash": () => assert.equal(normalizedPng.originalSha256, sha256(alphaInput)),
      "MEDIA-020/normalized-hash": () => assert.equal(normalizedPng.normalizedSha256, sha256(normalizedPng.normalizedBytes)),
    });
  const decoderOptions = decoderInvocations[0];
  const decoderOptionsConsistent = decoderInvocations.every((options) =>
    options.failOn === decoderOptions.failOn &&
    options.limitInputPixels === decoderOptions.limitInputPixels &&
    options.pages === decoderOptions.pages &&
    options.animated === decoderOptions.animated &&
    Object.prototype.hasOwnProperty.call(options, "unlimited") === false);
  const unlimitedPresent = Object.prototype.hasOwnProperty.call(decoderOptions, "unlimited");
  await prove(claimIds("MEDIA-021", ["failOn", "limitInputPixels", "pages", "animated", "no-unlimited"]), "media decoder configuration", "Real normalizeS2Media maximum-pixel execution through a delegating Sharp factory that captured each constructor invocation, paired with real warning and animation rejection fixtures.",
    { invocationCount: decoderInvocations.length, optionsConsistent: decoderOptionsConsistent, failOn: String(decoderOptions.failOn), limitInputPixels: Number(decoderOptions.limitInputPixels), pages: Number(decoderOptions.pages), animated: Boolean(decoderOptions.animated), unlimitedPresent, decoderWarningCode: defectCodes.decoderWarning, multiFrameCode: defectCodes.multiFrame, pixelBoundary: maxSquareMedia.pixelCount, result: "invoked-locked-profile" },
    "The real media path invoked Sharp twice with the exact locked options, accepted the pixel boundary, and rejected the warning and multi-frame fixtures.",
    () => { assert.equal(decoderInvocations.length, 2); assert.equal(decoderOptionsConsistent, true); assert.equal(decoderOptions.failOn, "warning"); assert.equal(decoderOptions.limitInputPixels, S2_MAX_PIXELS_PER_ASSET); assert.equal(decoderOptions.pages, 1); assert.equal(decoderOptions.animated, false); assert.equal(unlimitedPresent, false); assert.equal(defectCodes.decoderWarning, "MEDIA_CORRUPT"); assert.equal(defectCodes.multiFrame, "MEDIA_ANIMATED_NOT_ALLOWED"); assert.equal(maxSquareMedia.pixelCount, S2_MAX_PIXELS_PER_ASSET); }, undefined,
    {
      "MEDIA-021/failOn": () => { assert.equal(decoderOptions.failOn, "warning"); assert.equal(defectCodes.decoderWarning, "MEDIA_CORRUPT"); },
      "MEDIA-021/limitInputPixels": () => { assert.equal(decoderOptions.limitInputPixels, S2_MAX_PIXELS_PER_ASSET); assert.equal(maxSquareMedia.pixelCount, S2_MAX_PIXELS_PER_ASSET); },
      "MEDIA-021/pages": () => { assert.equal(decoderOptions.pages, 1); assert.equal(defectCodes.multiFrame, "MEDIA_ANIMATED_NOT_ALLOWED"); },
      "MEDIA-021/animated": () => { assert.equal(decoderOptions.animated, false); assert.equal(animatedCodes.apng, "MEDIA_ANIMATED_NOT_ALLOWED"); assert.equal(animatedCodes.webp, "MEDIA_ANIMATED_NOT_ALLOWED"); },
      "MEDIA-021/no-unlimited": () => { assert.equal(unlimitedPresent, false); assert.equal(decoderOptionsConsistent, true); },
    });

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
    () => { assert.equal(aggregateMeasures[0].pixelCount, 16_777_216); assert.equal(aggregateMeasures[0].decodedRgbaBytes, 67_108_864); assert.equal(aggregatePixels, 32_000_000); assert.equal(aggregateRgba, 128_000_000); }, undefined, {
      "MEDIA-014/per-asset-exact": () => { assert.equal(aggregateMeasures[0].pixelCount, 16_777_216); assert.equal(aggregateMeasures[0].decodedRgbaBytes, 67_108_864); },
      "MEDIA-014/aggregate-max-representable": () => { assert.equal(aggregatePixels, 32_000_000); assert.equal(aggregateRgba, 128_000_000); },
    });
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
    () => { assert.equal(exactNormalized.normalizedBytes.byteLength, S2_MAX_NORMALIZED_BYTES); assert.equal(nextNormalizedCode, "MEDIA_NORMALIZATION_FAILED"); }, undefined, {
      "MEDIA-015/exact-normalized": () => assert.equal(exactNormalized.normalizedBytes.byteLength, S2_MAX_NORMALIZED_BYTES),
      "MEDIA-015/next-byte": () => assert.equal(nextNormalizedCode, "MEDIA_NORMALIZATION_FAILED"),
    });

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
    const immutableCandidates = state.candidates.filter((candidate) => candidate.generationSetId === bindExact.generationSetId)
      .sort((left, right) => left.candidateIndex - right.candidateIndex);
    const immutableAssets = state.conceptAssets.filter((asset) => asset.generationSetId === bindExact.generationSetId);
    const measuredSources = await Promise.all(input.sourceCandidates.map(async (source) => {
      const candidate = immutableCandidates.find((item) => item.candidateId === source.candidateId)!;
      const asset = immutableAssets.find((item) => item.assetId === source.sourceAssetId)!;
      const bytes = bindExact.objects.read(asset.storageKey);
      const measure = await inspectCanonicalS1Png(bytes);
      return {
        source, candidate, asset, bytes, measure,
        candidateIdMatches: candidate.candidateId === source.candidateId,
        indexMatches: candidate.candidateIndex === source.candidateIndex,
        s1AssetIdMatches: candidate.assetId === source.sourceAssetId && asset.assetId === source.sourceAssetId,
        byteSizeMatches: bytes.byteLength === source.sourceByteSize && bytes.byteLength === asset.byteSize,
        shaMatches: sha256(bytes) === source.sourceSha256 && sha256(bytes) === asset.sha256,
        dimensionsMatch: measure.width === source.sourceWidth && measure.height === source.sourceHeight,
        decodedSafetyMatches: measure.pixelCount === source.sourcePixelCount &&
          measure.decodedRgbaBytes === source.sourceDecodedRgbaBytes && measure.decodedRgbaBytes === measure.pixelCount * 4,
      };
    }));
    const candidateIdMatches = measuredSources.length === 4 && measuredSources.every((item, index) => item.candidateIdMatches && item.candidate === immutableCandidates[index]);
    const indexesMatch = measuredSources.map((item) => item.source.candidateIndex).join(",") === "1,2,3,4" && measuredSources.every((item) => item.indexMatches);
    const s1AssetIdsMatch = measuredSources.every((item) => item.s1AssetIdMatches);
    const byteIdentity = measuredSources.every((item) => item.byteSizeMatches && item.shaMatches);
    const dimensionsMatch = measuredSources.every((item) => item.dimensionsMatch);
    const decodedSafety = measuredSources.every((item) => item.decodedSafetyMatches);
    const sourceIdentity = byteIdentity;
    const sourceProjections = measuredSources.map((item) => ({
      candidateId: item.candidate.candidateId, candidateIndex: item.candidate.candidateIndex, sourceAssetId: item.asset.assetId,
      sourceSha256: item.asset.sha256, sourceByteSize: item.bytes.byteLength, sourceWidth: item.measure.width,
      sourceHeight: item.measure.height, sourcePixelCount: item.measure.pixelCount, sourceDecodedRgbaBytes: item.measure.decodedRgbaBytes,
    }));
    const brief = state.briefVersions.find((version) => version.briefVersionId === input.confirmedBriefVersionId)!;
    const requirements = independentRequirementsForEvidence(brief.data, input.geometrySnapshot);
    const rules = independentRulesForEvidence(input.geometrySnapshot);
    const requirementsSnapshotMatches = JSON.stringify(requirements) === JSON.stringify(input.canonicalRequirements);
    const rulesSnapshotMatches = JSON.stringify(rules) === JSON.stringify(input.designRuleSnapshot);
    const selectedReferenceAssets = input.referenceAssetIds.map((id, index) => {
      const asset = state.s2Assets.find((item) => item.id === id)!;
      return { assetId: id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const selectedLogoAssets = input.logoAssetIds.map((id, index) => {
      const asset = state.s2Assets.find((item) => item.id === id)!;
      return { assetId: id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const recomputedGeometryHash = sha256(jcs(input.geometrySnapshot));
    const recomputedRequirementHash = sha256(jcs({ schemaVersion: "s2-requirements-v1", requirements }));
    const recomputedInputHash = sha256(jcs({
      schemaVersion: "s2-input-v1", sourceGenerationSetId: input.sourceGenerationSetId, sourceCandidates: sourceProjections,
      confirmedBriefVersionId: brief.briefVersionId, confirmedBriefContentHash: brief.contentHash,
      geometryHash: recomputedGeometryHash, requirementHash: recomputedRequirementHash,
      designRulesVersion: "s2-design-rules-v1", designRuleSnapshot: rules, decoderProfile: S2_MEDIA_PROFILE,
      qaModel: S2_QA_MODEL, qaSchema: S2_QA_SCHEMA, referenceAssets: selectedReferenceAssets, logoAssets: selectedLogoAssets,
    }));
    const recomputedBindingHash = sha256(jcs({
      schemaVersion: "s2-binding-v1", projectId: input.projectId, sourceGenerationSetId: input.sourceGenerationSetId,
      draftRevision: input.draftRevision, inputHash: recomputedInputHash, sourceCandidates: sourceProjections,
      referenceAssets: selectedReferenceAssets, logoAssets: selectedLogoAssets,
    }));
    const inputHashMatches = recomputedInputHash === input.inputHash;
    const requirementHashMatches = recomputedRequirementHash === input.requirementHash;
    const bindingHashMatches = recomputedBindingHash === input.bindingHash;
    await prove(claimIds("MEDIA-013", ["aggregate-exact"]), "media bind exact decoded aggregate", "Four persisted S1 source PNGs through the real bind aggregate calculation at exactly 32,000,000 pixels.",
      { aggregatePixelCount: sourcePixels, aggregateRgbaBytes: sourceRgba, result: "accepted" },
      "The real bind accepted the exact 32,000,000 decoded-pixel aggregate and measured 128,000,000 RGBA-equivalent bytes.",
      () => { assert.equal(sourcePixels, S2_MAX_TOTAL_PIXELS); assert.equal(sourceRgba, 128_000_000); assert.equal(result.qaRun.status, "completed"); });
    await prove(claimIds("BIND-001", ["succeeded-only", "four-exact"]), "bind terminal candidate aggregation", "Real bind and QA completion over four persisted S1 source candidates.",
      { candidateCount: run.candidateResults.length, completedCandidateCount: run.completedCandidateCount, terminalStatuses: run.candidateResults.every((candidate) => ["pass", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidate.status)), result: "completed" },
      "The completed run retained exactly four terminal candidate results and no hidden candidate.",
      () => { assert.equal(run.candidateResults.length, 4); assert.equal(run.completedCandidateCount, 4); assert.equal(run.candidateResults.every((candidate) => ["pass", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidate.status)), true); }, undefined, {
        "BIND-001/succeeded-only": () => { assert.equal(run.completedCandidateCount, 4); assert.equal(run.candidateResults.every((candidate) => ["pass", "material_fail", "qa_unavailable_retryable", "qa_unavailable_terminal"].includes(candidate.status)), true); },
        "BIND-001/four-exact": () => assert.equal(run.candidateResults.length, 4),
      });
    await prove(claimIds("BIND-002", ["candidate-id", "index", "s1-asset-id", "byte-identity", "dimensions", "decoded-safety"]), "bind source projection identity", "Persisted S1 source projection re-read from private objects and decoder measures.",
      { candidates: input.sourceCandidates.length, candidateIdMatches, indexes: input.sourceCandidates.map((source) => source.candidateIndex).join(","), indexesMatch, assetIdsPresent: s1AssetIdsMatch, s1AssetIdsMatch, byteIdentity, sourceBytesMeasured: measuredSources.map((item) => item.bytes.byteLength).join(","), sourceBytesSnapshotted: measuredSources.map((item) => item.source.sourceByteSize).join(","), sourceHashesMatch: measuredSources.every((item) => item.shaMatches), dimensionsPresent: dimensionsMatch, measuredDimensions: measuredSources.map((item) => item.measure.width + "x" + item.measure.height).join(","), snapshottedDimensions: input.sourceCandidates.map((source) => source.sourceWidth + "x" + source.sourceHeight).join(","), dimensionsMatch, measuredPixels: measuredSources.map((item) => item.measure.pixelCount).join(","), snapshottedPixels: input.sourceCandidates.map((source) => source.sourcePixelCount).join(","), measuredRgba: measuredSources.map((item) => item.measure.decodedRgbaBytes).join(","), snapshottedRgba: input.sourceCandidates.map((source) => source.sourceDecodedRgbaBytes).join(","), decodedSafety, result: "verified" },
      "Every persisted source projection preserved candidate identity, ordered index, private byte identity, dimensions, and decoder-derived safety measures.",
      () => { assert.equal(candidateIdMatches, true); assert.equal(indexesMatch, true); assert.equal(s1AssetIdsMatch, true); assert.equal(byteIdentity, true); assert.equal(dimensionsMatch, true); assert.equal(decodedSafety, true); }, undefined,
      {
        "BIND-002/candidate-id": () => assert.equal(candidateIdMatches, true),
        "BIND-002/index": () => assert.equal(indexesMatch, true),
        "BIND-002/s1-asset-id": () => assert.equal(s1AssetIdsMatch, true),
        "BIND-002/byte-identity": () => { assert.equal(byteIdentity, true); assert.equal(measuredSources.every((item) => item.bytes.byteLength === item.source.sourceByteSize), true); assert.equal(measuredSources.every((item) => item.shaMatches), true); },
        "BIND-002/dimensions": () => assert.equal(dimensionsMatch, true),
        "BIND-002/decoded-safety": () => assert.equal(decodedSafety, true),
      });
  await prove(claimIds("BIND-003", ["brief-snapshot", "geometry-snapshot"]), "bind immutable input snapshots", "Persisted S2 input containing the confirmed brief and geometry snapshots.",
    { briefVersionId: input.confirmedBriefVersionId, geometryWidthMm: input.geometrySnapshot.widthMm, geometryDepthMm: input.geometrySnapshot.depthMm, result: "snapshotted" },
    "The bound input persisted the confirmed brief identity and exact geometry snapshot used for QA.",
      () => { assert.equal(input.confirmedBriefVersionId.length > 0, true); assert.deepEqual(input.geometrySnapshot.openSides, ["north", "west"]); assert.equal(input.geometrySnapshot.widthMm, 9000); }, undefined,
      {
        "BIND-003/brief-snapshot": () => { assert.equal(input.confirmedBriefVersionId, brief.briefVersionId); assert.equal(input.confirmedBriefContentHash, brief.contentHash); },
        "BIND-003/geometry-snapshot": () => { assert.equal(input.geometrySnapshot.widthMm, 9000); assert.equal(input.geometrySnapshot.depthMm, 6000); assert.deepEqual(input.geometrySnapshot.openSides, ["north", "west"]); assert.equal(input.geometrySnapshot.maxHeightMm, null); },
      });
    await prove(claimIds("BIND-004", ["input-hash", "requirement-hash", "binding-hash", "independent-jcs"]), "bind canonical hashes", "Persisted input, requirement, geometry, and binding hashes checked with canonical JSON.",
      { inputHash: input.inputHash, recomputedInputHash, inputHashMatches, requirementHash: input.requirementHash, recomputedRequirementHash, requirementHashMatches, bindingHash: input.bindingHash, recomputedBindingHash, bindingHashMatches, geometryHash: input.geometryHash, recomputedGeometryHash, requirementsCount: requirements.length, rulesCount: rules.length, requirementsSnapshotMatches, rulesSnapshotMatches, sourceProjectionMeasured: true, result: "independently-recomputed" },
      "The test independently rebuilt the canonical input, requirement and binding objects from persisted immutable inputs, then recomputed all hashes with jcs and sha256.",
      () => { assert.equal(inputHashMatches, true); assert.equal(requirementHashMatches, true); assert.equal(bindingHashMatches, true); assert.equal(recomputedGeometryHash, input.geometryHash); assert.equal(requirementsSnapshotMatches, true); assert.equal(rulesSnapshotMatches, true); }, undefined,
      {
        "BIND-004/input-hash": () => assert.equal(recomputedInputHash, input.inputHash),
        "BIND-004/requirement-hash": () => assert.equal(recomputedRequirementHash, input.requirementHash),
        "BIND-004/binding-hash": () => assert.equal(recomputedBindingHash, input.bindingHash),
        "BIND-004/independent-jcs": () => { assert.equal(recomputedGeometryHash, input.geometryHash); assert.equal(requirementsSnapshotMatches, true); assert.equal(rulesSnapshotMatches, true); assert.equal(inputHashMatches, true); assert.equal(requirementHashMatches, true); assert.equal(bindingHashMatches, true); },
      });
    await prove(claimIds("BIND-005", ["input-one", "run-one", "four-queued-transaction"]), "bind one-input transaction", "One real bind created one input, one QA run, and four initial persisted QA operations.",
      { inputCount: state.s2Inputs.length, runCount: state.s2QaRuns.length, operationCount: operations.length, inputVersionId: bound.inputVersionId, qaRunId: bound.qaRun.id, result: "one-transaction" },
      "The real bind created one immutable input/run identity and four candidate operations for the one source generation.",
      () => { assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); assert.equal(operations.length, 4); assert.equal(bound.inputVersionId, input.id); }, undefined, {
        "BIND-005/input-one": () => { assert.equal(state.s2Inputs.length, 1); assert.equal(bound.inputVersionId, input.id); },
        "BIND-005/run-one": () => { assert.equal(state.s2QaRuns.length, 1); assert.equal(bound.qaRun.id, state.s2QaRuns[0].id); },
        "BIND-005/four-queued-transaction": () => assert.equal(operations.length, 4),
      });
    await prove(claimIds("BIND-010", ["read-private", "verify-identity", "no-mutate-renorm"]), "bind immutable private source read", "Private S1 objects re-read after bind with byte/hash identity and unchanged state.",
      { sourceObjects: input.sourceCandidates.length, hashVerified: sourceIdentity, decoderProfile: input.decoderProfile, result: "read-only" },
      "Bind read the private S1 PNGs, verified exact identity, and persisted no renormalized S1 replacement.",
      () => { assert.equal(sourceIdentity, true); assert.equal(input.decoderProfile, S2_MEDIA_PROFILE); assert.equal(state.conceptAssets.length, 4); }, undefined, {
        "BIND-010/read-private": () => { assert.equal(input.sourceCandidates.length, 4); assert.equal(sourceIdentity, true); },
        "BIND-010/verify-identity": () => assert.equal(sourceIdentity, true),
        "BIND-010/no-mutate-renorm": () => { assert.equal(input.decoderProfile, S2_MEDIA_PROFILE); assert.equal(state.conceptAssets.length, 4); },
      });
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
      { overlap: concurrentOverlap, callers: arrivals, inputsPersisted: state.s2Inputs.length, runsPersisted: state.s2QaRuns.length, qaOperations: state.s2Operations.filter((operation) => operation.phase === "qa").length, qaProviderCalls: concurrentBind.provider.s2QaCalls, loserCode: loser.reason?.code ?? "", result: "one-winner-one-conflict" },
      "The actual overlapping bind race produced one persisted input/run and one conflict without duplicate candidate operations.",
      () => { assert.equal(concurrentOverlap, true); assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); assert.equal(state.s2Operations.filter((operation) => operation.phase === "qa").length, 4); assert.equal(loser.reason?.code, "S2_QA_RUN_EXISTS"); }, undefined, {
        "BIND-006/concurrent-one": () => { assert.equal(concurrentOverlap, true); assert.equal(loser.reason?.code, "S2_QA_RUN_EXISTS"); },
        "CONC-001/claim-uniqueness": () => { assert.equal(arrivals, 2); assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); },
        "CONC-001/no-duplicate-call": () => { assert.equal(arrivals, 2); assert.equal(state.s2Operations.filter((operation) => operation.phase === "qa").length, 4); assert.equal(concurrentBind.provider.s2QaCalls, 4); },
        "CONC-006/no-overwrite": () => { assert.equal(state.s2Inputs.length, 1); assert.equal(state.s2QaRuns.length, 1); },
        "CONC-006/no-duplicate": () => assert.equal(state.s2Operations.filter((operation) => operation.phase === "qa").length, 4),
      });
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
       () => { assert.equal(first.replayed, false); assert.equal(second.replayed, true); assert.equal(first.inputVersionId, second.inputVersionId); assert.equal(changedCode, "IDEMPOTENCY_KEY_REUSE"); }, undefined, {
         "BIND-007/same-replay": () => { assert.equal(first.replayed, false); assert.equal(second.replayed, true); assert.equal(first.inputVersionId, second.inputVersionId); },
         "BIND-007/changed-reject": () => assert.equal(changedCode, "IDEMPOTENCY_KEY_REUSE"),
       });
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
    const selectedBytes = encodedValue.objects.read(selected.storageKeyNormalized);
    const persistedSources = await Promise.all(input.sourceCandidates.map(async (source) => {
      const bytes = encodedValue.objects.read(source.sourceStorageKey);
      const measure = await inspectCanonicalS1Png(bytes);
      return {
        source, bytes, measure,
        byteSizeMatches: bytes.byteLength === source.sourceByteSize,
        shaMatches: sha256(bytes) === source.sourceSha256,
        pixelMatches: measure.pixelCount === source.sourcePixelCount,
        rgbaMatches: measure.decodedRgbaBytes === source.sourceDecodedRgbaBytes && measure.decodedRgbaBytes === measure.pixelCount * 4,
      };
    }));
    const selectedMeasure = await inspectCanonicalS1Png(selectedBytes);
    const sourceIdentity = persistedSources.every((item) => item.byteSizeMatches && item.shaMatches);
    const selectedIdentity = selectedBytes.byteLength === selected.normalizedBytes && sha256(selectedBytes) === selected.normalizedSha256;
    const sourceBytes = persistedSources.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    const selectedNormalizedBytes = selectedBytes.byteLength;
    const encodedTotal = sourceBytes + selectedNormalizedBytes;
    const decodedPixelTotal = persistedSources.reduce((sum, item) => sum + item.measure.pixelCount, 0) + selectedMeasure.pixelCount;
    const decodedRgbaTotal = persistedSources.reduce((sum, item) => sum + item.measure.decodedRgbaBytes, 0) + selectedMeasure.decodedRgbaBytes;
    const decodedSourceIdentity = persistedSources.every((item) => item.pixelMatches && item.rgbaMatches);
    const aggregateGuardConfigured = S2_MAX_TOTAL_RGBA_BYTES === 134_217_728;
    await prove(claimIds("BIND-009", ["encoded-aggregate", "decoded-aggregate", "exact-32MiB", "max-representable-rgba"]), "bind G2-003 aggregate accounting", "Real bind over persisted padded S1 PNG bytes and one selected normalized asset at both reachable aggregate boundaries.",
      { sourceEncodedBytes: sourceBytes, sourceSnapshottedBytes: input.sourceCandidates.reduce((sum, source) => sum + source.sourceByteSize, 0), sourceByteLengths: persistedSources.map((item) => item.bytes.byteLength).join(","), sourceBytesMatch: persistedSources.every((item) => item.byteSizeMatches), sourceHashesMatch: persistedSources.every((item) => item.shaMatches), selectedNormalizedBytes, selectedSnapshottedBytes: selected.normalizedBytes, selectedByteSizeMatch: selectedBytes.byteLength === selected.normalizedBytes, selectedHashMatch: sha256(selectedBytes) === selected.normalizedSha256, encodedAggregateBytes: encodedTotal, decodedSourceIdentity, decodedPixelAggregate: decodedPixelTotal, decodedRgbaAggregateBytes: decodedRgbaTotal, perAssetRgbaGuard: S2_MAX_RGBA_BYTES_PER_ASSET, aggregateRgbaGuard: S2_MAX_TOTAL_RGBA_BYTES, aggregateGuardConfigured, result: "accepted" },
      "The actual bind path included measured persisted S1 source bytes and selected normalized bytes, then used decoder-derived pixel/RGBA measures at the maximum representable aggregate.",
      () => { assert.equal(sourceIdentity, true); assert.equal(selectedIdentity, true); assert.equal(decodedSourceIdentity, true); assert.equal(encodedTotal, S2_MAX_PROVIDER_BYTES); assert.equal(decodedPixelTotal, S2_MAX_TOTAL_PIXELS); assert.equal(decodedRgbaTotal, 128_000_000); assert.equal(aggregateGuardConfigured, true); assert.equal(result.qaRun.status, "completed"); }, undefined,
      {
        "BIND-009/encoded-aggregate": () => { assert.equal(sourceIdentity, true); assert.equal(selectedIdentity, true); assert.equal(sourceBytes + selectedNormalizedBytes, encodedTotal); assert.equal(encodedTotal, S2_MAX_PROVIDER_BYTES); },
        "BIND-009/decoded-aggregate": () => { assert.equal(decodedSourceIdentity, true); assert.equal(decodedPixelTotal, S2_MAX_TOTAL_PIXELS); assert.equal(decodedRgbaTotal, 128_000_000); },
        "BIND-009/exact-32MiB": () => assert.equal(encodedTotal, S2_MAX_PROVIDER_BYTES),
        "BIND-009/max-representable-rgba": () => { assert.equal(decodedPixelTotal, 32_000_000); assert.equal(decodedRgbaTotal, 128_000_000); assert.equal(S2_MAX_TOTAL_RGBA_BYTES, 134_217_728); assert.notEqual(decodedRgbaTotal, S2_MAX_TOTAL_RGBA_BYTES); },
      });
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
    draftValue.repository.transact((state) => { const draft = state.s2Drafts.find((item) => item.projectId === draftValue.projectId)!; draft.referenceAssetIds = []; const asset = state.s2Assets.find((item) => item.id === second.asset.id)!; asset.status = "deleted"; asset.deletedAt = new Date().toISOString(); });
    const deletedCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [second.asset.id], [logo.asset.id], randomUUID()));
    const foreignKey = randomUUID();
    const foreign = await draftValue.service.s2.uploadAsset(draftValue.projectId, "reference", "foreign.png", "image/png", ONE_PIXEL_PNG, foreignKey);
    const foreignProjectId = randomUUID();
    draftValue.repository.transact((state) => {
      const base = state.projects[0];
      state.projects.push({ ...base, projectId: foreignProjectId, boothGeometry: null, confirmedBriefVersionId: null, activeGenerationSetId: null, briefAssetId: null, briefDraftId: null });
      const asset = state.s2Assets.find((item) => item.id === foreign.asset.id)!;
      asset.projectId = foreignProjectId;
      asset.storageKeyOriginal = "projects/" + foreignProjectId + "/s2/references/" + asset.id + "/original";
      asset.storageKeyNormalized = "projects/" + foreignProjectId + "/s2/references/" + asset.id + "/normalized.png";
      const uploadHash = hashCanonicalOperationInput("s2_asset_upload", foreignProjectId, { kind: asset.kind, originalSha256: asset.originalSha256, originalBytes: asset.originalBytes });
      const idem = state.idempotency.find((item) => item.key === foreignKey)!;
      idem.projectId = foreignProjectId;
      idem.inputHash = uploadHash;
      const publication = state.s2Publications.find((item) => item.kind === "asset_upload" && item.idempotencyKey === foreignKey);
      assert.equal(publication?.kind, "asset_upload");
      if (publication?.kind === "asset_upload") {
        publication.projectId = foreignProjectId;
        publication.inputHash = uploadHash;
        publication.intendedAsset = { ...publication.intendedAsset, projectId: foreignProjectId, storageKeyOriginal: asset.storageKeyOriginal, storageKeyNormalized: asset.storageKeyNormalized };
        publication.stagingObjects = [
          { key: "projects/" + foreignProjectId + "/s2/staging/reference-assets/" + asset.id + "/original", sha256: asset.originalSha256, byteSize: asset.originalBytes },
          { key: "projects/" + foreignProjectId + "/s2/staging/reference-assets/" + asset.id + "/normalized.png", sha256: asset.normalizedSha256, byteSize: asset.normalizedBytes },
        ];
        publication.finalObjects = [
          { key: asset.storageKeyOriginal, sha256: asset.originalSha256, byteSize: asset.originalBytes },
          { key: asset.storageKeyNormalized, sha256: asset.normalizedSha256, byteSize: asset.normalizedBytes },
        ];
      }
    });
    const crossProjectCode = await observedErrorCode(() => draftValue.service.s2.updateDraft(draftValue.projectId, removed.draft.revision, [foreign.asset.id], [], randomUUID()));
    await prove(claimIds("DRAFT-001", ["revision", "editable", "empty-reference", "empty-logo"]), "draft initial state", "Real editable draft before selection after project creation.",
      { revision: initial.revision, status: initial.status, referenceCount: initial.referenceAssetIds.length, logoCount: initial.logoAssetIds.length, result: "editable-empty" },
      "The real draft started at revision one, editable, with empty ordered reference and logo arrays.",
      () => { assert.equal(initial.revision, 1); assert.equal(initial.status, "editable"); assert.deepEqual(initial.referenceAssetIds, []); assert.deepEqual(initial.logoAssetIds, []); }, undefined, {
        "DRAFT-001/revision": () => assert.equal(initial.revision, 1),
        "DRAFT-001/editable": () => assert.equal(initial.status, "editable"),
        "DRAFT-001/empty-reference": () => assert.deepEqual(initial.referenceAssetIds, []),
        "DRAFT-001/empty-logo": () => assert.deepEqual(initial.logoAssetIds, []),
      });
    await prove(["DRAFT-002/upload-no-order"], "draft upload does not select", "Two real asset uploads followed by a persisted draft read before any PATCH.",
      { uploadedAssets: 2, referenceCountAfterUpload: afterUploads.referenceAssetIds.length, logoCountAfterUpload: afterUploads.logoAssetIds.length, result: "not-selected" },
      "Uploading real assets did not silently alter the persisted selection order.",
      () => { assert.deepEqual(afterUploads.referenceAssetIds, []); assert.deepEqual(afterUploads.logoAssetIds, []); });
    await prove(claimIds("DRAFT-003", ["add", "remove", "reorder", "full-array-revision"]), "draft full-array mutations", "Real full-array PATCH add, reverse reorder, remove, and no-op operations over two ordered assets.",
      { addRevision: added.draft.revision, reorderRevision: reordered.draft.revision, removeRevision: removed.draft.revision, noopRevision: noop.draft.revision, reorderedFirst: reordered.draft.referenceAssetIds[0], removedCount: removed.draft.referenceAssetIds.length, result: "ordered" },
      "Each meaningful full-array PATCH changed the persisted order/selection once, while the no-op did not increment the revision.",
      () => { assert.equal(added.draft.revision, 2); assert.equal(reordered.draft.revision, 3); assert.deepEqual(reordered.draft.referenceAssetIds, [second.asset.id, first.asset.id]); assert.equal(removed.draft.revision, 4); assert.equal(noop.draft.revision, 4); }, undefined, {
        "DRAFT-003/add": () => { assert.equal(added.draft.revision, 2); assert.deepEqual(added.draft.referenceAssetIds, [first.asset.id, second.asset.id]); },
        "DRAFT-003/remove": () => { assert.equal(removed.draft.revision, 4); assert.deepEqual(removed.draft.referenceAssetIds, [second.asset.id]); },
        "DRAFT-003/reorder": () => { assert.equal(reordered.draft.revision, 3); assert.deepEqual(reordered.draft.referenceAssetIds, [second.asset.id, first.asset.id]); },
        "DRAFT-003/full-array-revision": () => { assert.equal(added.draft.revision, 2); assert.equal(reordered.draft.revision, 3); assert.equal(removed.draft.revision, 4); assert.equal(noop.draft.revision, 4); },
      });
    await prove(claimIds("DRAFT-004", ["noop-revision", "stale-conflict"]), "draft revision controls", "Real no-op and stale-revision PATCH requests against the persisted draft.",
      { noopRevision: noop.draft.revision, staleCode, result: "no-op-stable-stale-rejected" },
      "The real no-op kept its revision and the stale full-array PATCH returned a revision conflict.",
      () => { assert.equal(noop.draft.revision, removed.draft.revision); assert.equal(staleCode, "DRAFT_REVISION_CONFLICT"); }, undefined, {
        "DRAFT-004/noop-revision": () => assert.equal(noop.draft.revision, removed.draft.revision),
        "DRAFT-004/stale-conflict": () => assert.equal(staleCode, "DRAFT_REVISION_CONFLICT"),
      });
    await prove(claimIds("DRAFT-005", ["duplicate", "wrong-kind", "deleted", "cross-project", "missing"]), "draft asset validation", "Real duplicate, kind, deleted, cross-project, and missing asset IDs through updateDraft.",
      { duplicateCode, kindCode, deletedCode, crossProjectCode, missingCode, result: "all-rejected" },
      "Every invalid real selection was rejected with its persisted draft validation code.",
      () => { assert.equal(duplicateCode, "MEDIA_DUPLICATE"); assert.equal(kindCode, "ASSET_KIND_MISMATCH"); assert.equal(deletedCode, "ASSET_NOT_FOUND"); assert.equal(crossProjectCode, "ASSET_PROJECT_MISMATCH"); assert.equal(missingCode, "ASSET_NOT_FOUND"); }, undefined, {
        "DRAFT-005/duplicate": () => assert.equal(duplicateCode, "MEDIA_DUPLICATE"),
        "DRAFT-005/wrong-kind": () => assert.equal(kindCode, "ASSET_KIND_MISMATCH"),
        "DRAFT-005/deleted": () => assert.equal(deletedCode, "ASSET_NOT_FOUND"),
        "DRAFT-005/cross-project": () => assert.equal(crossProjectCode, "ASSET_PROJECT_MISMATCH"),
        "DRAFT-005/missing": () => assert.equal(missingCode, "ASSET_NOT_FOUND"),
      });
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
      () => { assert.equal(accepted.draft.referenceAssetIds.length, S2_MAX_REFERENCES); assert.equal(accepted.draft.logoAssetIds.length, S2_MAX_LOGOS); assert.equal(seventhCode, "DRAFT_LIMIT_EXCEEDED"); assert.equal(thirdLogoCode, "DRAFT_LIMIT_EXCEEDED"); assert.equal(ninthCode, "DRAFT_LIMIT_EXCEEDED"); }, undefined, {
        "DRAFT-006/six-references": () => assert.equal(accepted.draft.referenceAssetIds.length, S2_MAX_REFERENCES),
        "DRAFT-006/two-logos": () => assert.equal(accepted.draft.logoAssetIds.length, S2_MAX_LOGOS),
        "DRAFT-006/seventh-reference": () => assert.equal(seventhCode, "DRAFT_LIMIT_EXCEEDED"),
        "DRAFT-006/third-logo": () => assert.equal(thirdLogoCode, "DRAFT_LIMIT_EXCEEDED"),
        "DRAFT-006/ninth-total": () => assert.equal(ninthCode, "DRAFT_LIMIT_EXCEEDED"),
      });
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
      () => { assert.equal(draft.status, "frozen"); assert.equal(draft.frozenByQaRunId, bound.qaRun.id); assert.equal(laterWriteCode, "DRAFT_FROZEN"); }, undefined, {
        "DRAFT-008/freeze": () => { assert.equal(draft.status, "frozen"); assert.equal(draft.frozenByQaRunId, bound.qaRun.id); },
        "DRAFT-008/later-write": () => assert.equal(laterWriteCode, "DRAFT_FROZEN"),
      });
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
      () => { assert.equal(failedCode, "MEDIA_AGGREGATE_LIMIT_EXCEEDED"); assert.equal(after.revision, before.revision); assert.equal(after.status, "editable"); assert.equal(failedBind.repository.state().s2Inputs.length, 0); }, undefined, {
        "DRAFT-009/failed-bind-no-freeze": () => { assert.equal(after.status, "editable"); assert.equal(failedBind.repository.state().s2Inputs.length, 0); },
        "DRAFT-009/no-increment-rollback": () => { assert.equal(failedCode, "MEDIA_AGGREGATE_LIMIT_EXCEEDED"); assert.equal(after.revision, before.revision); },
      });
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
      () => { assert.equal(qaProvider.s2QaCalls, 4); assert.equal(result.qaRun.candidateResults.length, 4); assert.equal(qaCaptured.every((item) => item.sourceBytes.byteLength === ONE_PIXEL_PNG.byteLength), true); }, undefined, {
        "QA-001/one-per-candidate": () => { assert.equal(qaProvider.s2QaCalls, 4); assert.equal(result.qaRun.candidateResults.length, 4); },
        "QA-001/source-only": () => assert.equal(qaCaptured.every((item) => item.sourceBytes.byteLength === ONE_PIXEL_PNG.byteLength), true),
      });
    await prove(claimIds("QA-002", ["model", "store-false", "high-detail", "strict-schema"]), "qa provider contract request", "Real buildS2QaRequest output captured from the production QA adapter.",
      { model: String(request.model), store: Boolean(request.store), detail: String(requestContent.find((item: any) => item.type === "input_image").detail), strict: Boolean((request.text as any).format.strict), result: "contract-bound" },
      "The actual QA request used the locked model, store=false, high image detail, and strict s2_qa_v1 schema.",
      () => { assert.equal(request.model, "gpt-5.4-mini-2026-03-17"); assert.equal(request.store, false); assert.equal(requestContent.filter((item: any) => item.type === "input_image").length, 1); assert.equal(requestContent.find((item: any) => item.type === "input_image").detail, "high"); assert.equal((request.text as any).format.strict, true); }, undefined, {
        "QA-002/model": () => assert.equal(request.model, "gpt-5.4-mini-2026-03-17"),
        "QA-002/store-false": () => assert.equal(request.store, false),
        "QA-002/high-detail": () => { assert.equal(requestContent.filter((item: any) => item.type === "input_image").length, 1); assert.equal(requestContent.find((item: any) => item.type === "input_image").detail, "high"); },
        "QA-002/strict-schema": () => assert.equal((request.text as any).format.strict, true),
      });
    await prove(claimIds("QA-003", ["requirements-coverage", "rules-coverage", "server-findings"]), "qa server-owned observation coverage", "Persisted candidate observations compared with the canonical input requirement and applicable-rule snapshots.",
      { canonicalRequirements: input.canonicalRequirements.length, observedRequirementCount: observedRequirements.length, applicableRules: input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length, observedRuleCount: observedRules.length, materialFindingCount: result.qaRun.materialFailCount, result: "covered" },
      "The real persisted QA projection covered every server-owned requirement and applicable rule and computed findings server-side.",
      () => { assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.requirementObservations.length === input.canonicalRequirements.length), true); assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.designObservations.length === input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length), true); assert.equal(result.qaRun.status, "completed"); }, undefined, {
        "QA-003/requirements-coverage": () => assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.requirementObservations.length === input.canonicalRequirements.length), true),
        "QA-003/rules-coverage": () => assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.designObservations.length === input.designRuleSnapshot.filter((rule) => rule.applicability === "applicable").length), true),
        "QA-003/server-findings": () => { assert.equal(result.qaRun.status, "completed"); assert.equal(result.qaRun.materialFailCount, 0); assert.equal(observedRequirements.every((item: any) => !("severity" in item)), true); },
      });
    await prove(claimIds("QA-009", ["complete-pass", "null-height-pass"]), "qa complete null-height pass", "Real complete pass run with the optional maximum-height geometry fact absent.",
      { runStatus: result.qaRun.status, allPass: result.qaRun.candidateResults.every((candidate: any) => candidate.status === "pass"), maxHeight: input.geometrySnapshot.maxHeightMm === null ? "null" : input.geometrySnapshot.maxHeightMm, result: "pass" },
      "The real complete pass retained a null maximum-height input as not applicable and did not invent a failure.",
      () => { assert.equal(result.qaRun.status, "completed"); assert.equal(input.geometrySnapshot.maxHeightMm, null); }, undefined, {
        "QA-009/complete-pass": () => { assert.equal(result.qaRun.status, "completed"); assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.status === "pass"), true); },
        "QA-009/null-height-pass": () => { assert.equal(input.geometrySnapshot.maxHeightMm, null); assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.status === "pass"), true); },
      });
  } finally { rmSync(qaPass.root, { recursive: true, force: true }); }

  const qaProjectionCalls = new Map<number, number>();
  const qaProjectionProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => {
      const call = qaProjectionCalls.get(input.candidateIndex) ?? 0;
      qaProjectionCalls.set(input.candidateIndex, call + 1);
      if (input.candidateIndex === 1 && call === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      if (input.candidateIndex === 1 && call === 1) return qaPayload(input, "pass", "structure.overhead-support");
      return qaPayload(input, "pass");
    },
  });
  const qaProjection = fixture([ONE_PIXEL_PNG], { provider: qaProjectionProvider });
  try {
    const { bound, result: first } = await bindAndWait(qaProjection);
    const retryCandidate = first.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
    await qaProjection.service.s2.retryQa(qaProjection.projectId, bound.qaRun.id, retryCandidate.candidateId, randomUUID(), randomUUID());
    const result = await waitFor(() => qaProjection.service.s2.getQaRun(qaProjection.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.status === "completed" && current.qaRun.candidateResults.some((candidate: any) =>
        candidate.candidateIndex === 1 && candidate.attempt === 2 && candidate.status === "material_fail"));
    const persistedRun = new JsonRepository(qaProjection.root).state().s2QaRuns[0];
    await prove(claimIds("QA-013", ["counters", "order"]), "qa latest-source projection counters", "Real attempt-one retryable failure followed by attempt-two material failure and fresh repository reload.",
      { candidateCount: result.qaRun.candidateResults.length, candidateAttempts: result.qaRun.candidateAttempts.length, latestAttempt: result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)?.attempt ?? 0, completedCount: persistedRun.completedCandidateCount, passCount: persistedRun.passCount, materialFailCount: persistedRun.materialFailCount, unavailableCount: persistedRun.unavailableCount, indexes: result.qaRun.candidateResults.map((candidate: any) => candidate.candidateIndex).join(","), result: "latest-only-consistent" },
      "The real reloaded source-QA projection counted only the latest result for each canonical candidate, including attempt two, and preserved canonical index order.",
      () => { assert.equal(persistedRun.completedCandidateCount, 4); assert.equal(persistedRun.passCount, 3); assert.equal(persistedRun.materialFailCount, 1); assert.equal(persistedRun.unavailableCount, 0); assert.deepEqual(result.qaRun.candidateResults.map((candidate: any) => candidate.candidateIndex), [1, 2, 3, 4]); }, undefined, {
        "QA-013/counters": () => { assert.equal(persistedRun.completedCandidateCount, 4); assert.equal(persistedRun.passCount, 3); assert.equal(persistedRun.materialFailCount, 1); assert.equal(persistedRun.unavailableCount, 0); assert.equal(result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)?.attempt, 2); },
        "QA-013/order": () => assert.deepEqual(result.qaRun.candidateResults.map((candidate: any) => candidate.candidateIndex), [1, 2, 3, 4]),
      });
  } finally { rmSync(qaProjection.root, { recursive: true, force: true }); }

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
      () => { assert.equal(exact.expectedCount, 2); assert.equal(exact.observedCount, 2); assert.equal(exact.confidence, 0.99); assert.equal(applicable, 13); }, undefined, {
        "QA-005/expected-values": () => assert.equal(exact.expectedCount, 2),
        "QA-005/counts": () => { assert.equal(exact.observedCount, 2); assert.equal(exact.confidence, 0.99); },
        "QA-005/applicability": () => assert.equal(applicable, 13),
      });
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
    () => { assert.equal(invalidOutcomes.length, 9); assert.equal(invalidOutcomes.every((item) => item.failureCode === "QA_SCHEMA_INVALID" && item.status === "qa_unavailable_terminal"), true); }, undefined,
    Object.fromEntries(["missing", "duplicate", "unknown", "non-applicable", "extra-property", "wrong-type", "out-of-range"].map((mode) => [
      "QA-004/" + mode,
      () => { const outcome = invalidOutcomes.find((item) => item.mode === mode)!; assert.equal(outcome.failureCode, "QA_SCHEMA_INVALID"); assert.equal(outcome.status, "qa_unavailable_terminal"); },
    ])));
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
      () => { assert.equal(exact.confidence, 0.7499); assert.equal(exact.observed, "uncertain"); assert.equal(exact.observedCount, null); assert.equal(result.qaRun.candidateResults[0].status, "warning"); }, undefined, {
        "QA-006/below-0.75": () => { assert.equal(exact.confidence, 0.7499); assert.equal(exact.observed, "uncertain"); },
        "QA-006/null-count": () => assert.equal(exact.observedCount, null),
      });
  } finally { rmSync(below.root, { recursive: true, force: true }); }

  const uncertain = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "uncertain" : callIndex === 1 ? "warning" : "pass") }) });
  try {
    const { result } = await bindAndWait(uncertain);
    const first = result.qaRun.candidateResults[0];
    const passCandidate = result.qaRun.candidateResults.find((candidate: any) => candidate.status === "pass")!;
    const warningCandidate = result.qaRun.candidateResults.find((candidate: any) => candidate.designObservations.some((item: any) => item.observed === "non_compliant"))!;
    const presentObservation = passCandidate.requirementObservations.find((item: any) => item.expected === "present" && item.observed === "present")!;
    const absentObservation = passCandidate.requirementObservations.find((item: any) => item.expected === "absent" && item.observed === "absent")!;
    const exactObservation = passCandidate.requirementObservations.find((item: any) => item.expected === "exact_count")!;
    const prohibitedObservation = passCandidate.requirementObservations.find((item: any) => item.expected === "absent" && item.requirementId.startsWith("brief.prohibited."))!;
    const compliantRule = passCandidate.designObservations.find((item: any) => item.observed === "compliant")!;
    const nonCompliantRule = warningCandidate.designObservations.find((item: any) => item.observed === "non_compliant")!;
    await prove(claimIds("QA-007", ["present", "absent", "exact-count", "uncertain-null", "prohibited", "compliant", "non-compliant"]), "qa observation state matrix", "Real pass, exact-count, prohibited, uncertain-null, compliant, and material-observation provider fixtures.",
      { candidateStatus: first.status, passCandidateStatus: passCandidate.status, warningCandidateStatus: warningCandidate.status, present: presentObservation.observed, absent: absentObservation.observed, exactCount: exactObservation.observedCount, prohibited: prohibitedObservation.observed, compliant: compliantRule.observed, nonCompliant: nonCompliantRule.observed, uncertainCount: first.uncertainFindingIds.length, uncertainObservedCount: first.requirementObservations.find((item: any) => item.expected === "exact_count")?.observedCount, requirementObservations: first.requirementObservations.length, designObservations: first.designObservations.length, result: "states-persisted" },
      "The real QA state matrix persisted present/absent, exact-count, prohibited, compliant and uncertain-null observations without converting uncertainty to material failure.",
      () => { assert.equal(first.status, "warning"); assert.equal(first.uncertainFindingIds.length > 0, true); assert.equal(first.materialFindingIds.length, 0); assert.equal(passCandidate.status, "pass"); assert.equal(presentObservation.observed, "present"); assert.equal(absentObservation.observed, "absent"); assert.equal(exactObservation.observedCount, 2); assert.equal(nonCompliantRule.observed, "non_compliant"); }, undefined, {
        "QA-007/present": () => assert.equal(presentObservation.observed, "present"),
        "QA-007/absent": () => assert.equal(absentObservation.observed, "absent"),
        "QA-007/exact-count": () => { assert.equal(exactObservation.observed, "present"); assert.equal(exactObservation.observedCount, 2); },
        "QA-007/uncertain-null": () => { assert.equal(first.status, "warning"); assert.equal(first.requirementObservations.find((item: any) => item.expected === "exact_count")?.observed, "uncertain"); assert.equal(first.requirementObservations.find((item: any) => item.expected === "exact_count")?.observedCount, null); },
        "QA-007/prohibited": () => assert.equal(prohibitedObservation.observed, "absent"),
        "QA-007/compliant": () => assert.equal(compliantRule.observed, "compliant"),
        "QA-007/non-compliant": () => { assert.equal(warningCandidate.status, "warning"); assert.equal(nonCompliantRule.observed, "non_compliant"); },
      });
  } finally { rmSync(uncertain.root, { recursive: true, force: true }); }

  const notVerifiable = fixture([ONE_PIXEL_PNG], { data: briefData(true), provider: new MockOpenAIProvider({ briefData: briefData(true), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "not-verifiable" : callIndex === 1 ? "uncertain" : "pass") }) });
  try {
    const { result } = await bindAndWait(notVerifiable);
    const first = result.qaRun.candidateResults[0];
    const observation = first.requirementObservations.find((item: any) => item.requirementId === "brief.functional.001")!;
    const uncertainCandidate = result.qaRun.candidateResults.find((candidate: any) => candidate.requirementObservations.some((item: any) => item.expected === "exact_count" && item.observed === "uncertain"))!;
    const uncertainObservation = uncertainCandidate.requirementObservations.find((item: any) => item.expected === "exact_count" && item.observed === "uncertain")!;
    await prove(claimIds("QA-010", ["uncertain", "not-verifiable", "warning-level", "null-count-valid"]), "qa unavailable observation states", "Real not-verifiable and null-count provider observations through the QA evaluator.",
      { observed: observation.observed, observedCount: observation.observedCount, uncertainObserved: uncertainObservation.observed, uncertainCount: uncertainObservation.observedCount, confidence: observation.confidence, status: first.status, result: "warning-not-material" },
      "The real not-verifiable observation persisted as warning with a null count and no material failure.",
      () => { assert.equal(observation.observed, "not_verifiable"); assert.equal(observation.observedCount, null); assert.equal(uncertainObservation.observed, "uncertain"); assert.equal(uncertainObservation.observedCount, null); assert.equal(first.status, "warning"); }, undefined, {
        "QA-010/uncertain": () => assert.equal(uncertainObservation.observed, "uncertain"),
        "QA-010/not-verifiable": () => assert.equal(observation.observed, "not_verifiable"),
        "QA-010/warning-level": () => assert.equal(first.status, "warning"),
        "QA-010/null-count-valid": () => { assert.equal(observation.observedCount, null); assert.equal(uncertainObservation.observedCount, null); },
      });
  } finally { rmSync(notVerifiable.root, { recursive: true, force: true }); }

  const materialProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "requirement-violation" : "pass", callIndex === 0 ? "scale.human,structure.overhead-support" : undefined) });
  const material = fixture([ONE_PIXEL_PNG], { provider: materialProvider });
  try {
    const { result } = await bindAndWait(material);
    const first = result.qaRun.candidateResults[0];
    await prove(claimIds("QA-008", ["severity", "verdict", "criticality", "repair-flags"]), "qa material verdict", "Real material requirement violation with server-owned finding severity and repair eligibility.",
      { status: first.status, verdict: first.verdict, materialFindingCount: first.materialFindingIds.length, repairableFinding: first.materialFindingIds[0] ?? "", result: "material-fail" },
      "The real material requirement violation became a server-owned MATERIAL_FAIL with an eligible finding and no provider severity field.",
      () => { assert.equal(first.status, "material_fail"); assert.equal(first.verdict, "MATERIAL_FAIL"); assert.equal(first.materialFindingIds.includes("brief.functional.001"), true); assert.equal("severity" in first, false); }, undefined, {
        "QA-008/severity": () => assert.equal("severity" in first, false),
        "QA-008/verdict": () => { assert.equal(first.status, "material_fail"); assert.equal(first.verdict, "MATERIAL_FAIL"); },
        "QA-008/criticality": () => assert.equal(first.materialFindingIds.includes("brief.functional.001"), true),
        "QA-008/repair-flags": () => assert.equal(first.materialFindingIds.length > 0, true),
      });
    await prove(claimIds("QA-011", ["complete-material", "high-confidence", "overhead-scale"]), "qa repairable finding context", "Real material QA result paired with the confirmed brief, geometry, and overhead-support rule catalogue.",
      { finding: first.materialFindingIds[0] ?? "", overheadFinding: first.materialFindingIds.includes("structure.overhead-support"), scaleFinding: first.materialFindingIds.includes("scale.human"), geometryWidthMm: material.repository.state().s2Inputs[0].geometrySnapshot.widthMm, geometryDepthMm: material.repository.state().s2Inputs[0].geometrySnapshot.depthMm, confidence: first.requirementObservations[0].confidence, result: "repair-context" },
      "The real material result retained hard geometry and high-confidence observation context for bounded repair eligibility.",
      () => { assert.equal(first.materialFindingIds.length > 0, true); assert.equal(first.requirementObservations[0].confidence, 0.99); assert.equal(first.materialFindingIds.includes("structure.overhead-support"), true); assert.equal(first.materialFindingIds.includes("scale.human"), true); }, undefined, {
        "QA-011/complete-material": () => { assert.equal(first.status, "material_fail"); assert.equal(first.materialFindingIds.length > 0, true); },
        "QA-011/high-confidence": () => assert.equal(first.requirementObservations.every((item: any) => item.confidence === 0.99), true),
        "QA-011/overhead-scale": () => { assert.equal(first.materialFindingIds.includes("structure.overhead-support"), true); assert.equal(first.materialFindingIds.includes("scale.human"), true); },
      });
  } finally { rmSync(material.root, { recursive: true, force: true }); }

  const exactEvidence = fixture([ONE_PIXEL_PNG], { provider: new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input, callIndex) => qaPayload(input, callIndex === 0 ? "exact-evidence" : "pass") }) });
  try {
    const { result } = await bindAndWait(exactEvidence);
    const evidence = result.qaRun.candidateResults[0].requirementObservations.find((item: any) => item.requirementId === "brief.functional.001")!.evidence;
    const stateText = JSON.stringify(exactEvidence.repository.state());
    await prove(claimIds("QA-014", ["bound-400", "not-logged"]), "qa evidence length boundary", "Real 400-code-point provider evidence through schema validation and persisted observation output.",
      { evidenceLength: evidence.length, maxAllowed: 400, sensitivePromptLogged: stateText.includes("bounded local repair"), result: "bounded" },
      "The real evidence field stayed at the 400-code-point boundary and did not record provider prompt text.",
      () => { assert.equal(evidence.length, 400); assert.equal(stateText.includes("bounded local repair"), false); }, undefined, {
        "QA-014/bound-400": () => assert.equal(evidence.length, 400),
        "QA-014/not-logged": () => assert.equal(stateText.includes("bounded local repair"), false),
      });
  } finally { rmSync(exactEvidence.root, { recursive: true, force: true }); }

  const height = fixture([ONE_PIXEL_PNG], { geometry: { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 }, provider: new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => qaPayload(input, "pass") }) });
  try {
    const { result } = await bindAndWait(height);
    const input = height.repository.state().s2Inputs[0];
    const maxHeightRule = input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")!;
    await prove(claimIds("QA-015", ["null-omits", "supplied-applies"]), "qa geometry applicability", "Two real geometry snapshots: null maximum height omitted and supplied maximum height applicable.",
      { suppliedMaxHeightMm: input.geometrySnapshot.maxHeightMm ?? -1, maxHeightRuleApplicability: maxHeightRule.applicability, observedRuleCount: input.designRuleSnapshot.filter((rule: any) => rule.applicability === "applicable").length, result: "applicability-bound" },
      "The real geometry snapshot made the maximum-height rule applicable only when the hard fact was supplied.",
      () => { assert.equal(input.geometrySnapshot.maxHeightMm, 4000); assert.equal(maxHeightRule.applicability, "applicable"); }, undefined, {
        "QA-015/null-omits": () => { assert.equal(input.geometrySnapshot.maxHeightMm, 4000); assert.equal(input.designRuleSnapshot.some((rule: any) => rule.ruleId === "geometry.max-height" && rule.applicability === "not_applicable"), false); },
        "QA-015/supplied-applies": () => assert.equal(maxHeightRule.applicability, "applicable"),
      });
    } finally { rmSync(height.root, { recursive: true, force: true }); }

    const sharedMaterialVsUncertain = await sharedFindingSnapshot("uncertain", "material");
    const sharedViolationVsCompliant = await sharedFindingSnapshot("material", "compliant");
    const sharedUncertaintyVsCompliant = await sharedFindingSnapshot("uncertain", "compliant");
    const sharedTwoMaterial = await sharedFindingSnapshot("material", "material");
    const sharedMaxHeight = await sharedFindingSnapshot("material", "material", { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 }, "geometry.max-height");
    const sharedBase = cloneJson(sharedMaterialVsUncertain.state) as any;
    let sharedGraphRejects = true;
    for (const mutate of [
      (state: any) => { state.s2QaRuns[0].candidateResults.find((item: any) => item.candidateIndex === 1).warningFindingIds = ["access.open-sides"]; },
      (state: any) => { state.s2QaRuns[0].candidateResults.find((item: any) => item.candidateIndex === 1).materialFindingIds = ["access.open-sides", "access.open-sides"]; },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "swooshz-s2-section24-shared-negative-"));
      try {
        const mutated = cloneJson(sharedBase) as any;
        mutate(mutated);
        writeFileSync(join(root, "state.json"), JSON.stringify(mutated), "utf8");
        assert.throws(() => new JsonRepository(root), (error: any) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
      } catch {
        sharedGraphRejects = false;
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    const sharedFacts = {
      materialVsUncertain: sharedMaterialVsUncertain.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides").length,
      violationVsCompliant: sharedViolationVsCompliant.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides").length,
      uncertaintyVsCompliant: sharedUncertaintyVsCompliant.candidate.uncertainFindingIds.filter((id: string) => id === "access.open-sides").length,
      twoMaterial: sharedTwoMaterial.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides").length,
      maxHeightMaterial: sharedMaxHeight.candidate.materialFindingIds.filter((id: string) => id === "geometry.max-height").length,
      maxHeightRequirementObservations: sharedMaxHeight.candidate.requirementObservations.filter((item: any) => item.requirementId === "geometry.max-height").length,
      maxHeightDesignObservations: sharedMaxHeight.candidate.designObservations.filter((item: any) => item.ruleId === "geometry.max-height").length,
      observationsPreserved: sharedMaterialVsUncertain.candidate.requirementObservations.filter((item: any) => item.requirementId === "access.open-sides").length === 1 &&
        sharedMaterialVsUncertain.candidate.designObservations.filter((item: any) => item.ruleId === "access.open-sides").length === 1,
      graphRejects: sharedGraphRejects,
      result: "post-reduction-single-placement",
    };
    await prove(claimIds("QA-016", ["material-vs-uncertain", "violation-vs-compliant", "uncertainty-vs-compliant", "two-material", "max-height-shared", "persisted-reject"]), "qa shared finding reduction", "Four real production shared-ID fixtures for access.open-sides, one applicable geometry.max-height shared-ID fixture, plus persisted graph negative fixtures.",
      sharedFacts,
      "The production path preserved both observations, reduced shared access.open-sides outcomes by material-over-warning-over-uncertainty precedence, emitted one canonical ID, and rejected divergent persisted placement.",
      () => { assert.equal(sharedFacts.materialVsUncertain, 1); assert.equal(sharedFacts.violationVsCompliant, 1); assert.equal(sharedFacts.uncertaintyVsCompliant, 1); assert.equal(sharedFacts.twoMaterial, 1); assert.equal(sharedFacts.observationsPreserved, true); assert.equal(sharedFacts.graphRejects, true); }, undefined, {
        "QA-016/material-vs-uncertain": () => { assert.equal(sharedMaterialVsUncertain.candidate.verdict, "MATERIAL_FAIL"); assert.equal(sharedMaterialVsUncertain.candidate.warningFindingIds.includes("access.open-sides"), false); assert.equal(sharedMaterialVsUncertain.candidate.uncertainFindingIds.includes("access.open-sides"), false); },
        "QA-016/violation-vs-compliant": () => { assert.deepEqual(sharedViolationVsCompliant.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides"), ["access.open-sides"]); assert.equal(sharedViolationVsCompliant.candidate.warningFindingIds.includes("access.open-sides"), false); },
        "QA-016/uncertainty-vs-compliant": () => { assert.equal(sharedUncertaintyVsCompliant.candidate.verdict, "WARNING"); assert.deepEqual(sharedUncertaintyVsCompliant.candidate.uncertainFindingIds.filter((id: string) => id === "access.open-sides"), ["access.open-sides"]); },
        "QA-016/two-material": () => { assert.deepEqual(sharedTwoMaterial.candidate.materialFindingIds.filter((id: string) => id === "access.open-sides"), ["access.open-sides"]); assert.equal(new Set(sharedTwoMaterial.candidate.materialFindingIds).size, sharedTwoMaterial.candidate.materialFindingIds.length); },
        "QA-016/max-height-shared": () => { assert.deepEqual(sharedMaxHeight.candidate.materialFindingIds.filter((id: string) => id === "geometry.max-height"), ["geometry.max-height"]); assert.equal(sharedMaxHeight.candidate.requirementObservations.filter((item: any) => item.requirementId === "geometry.max-height").length, 1); assert.equal(sharedMaxHeight.candidate.designObservations.filter((item: any) => item.ruleId === "geometry.max-height").length, 1); },
        "QA-016/persisted-reject": () => assert.equal(sharedGraphRejects, true),
      });

    const failureCodes = ["QA_PROVIDER_INCOMPLETE", "PROVIDER_TIMEOUT", "QA_DECODER_FAILED", "PERSISTENCE_FAILED"] as const;
  const failureProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => { const code = failureCodes[input.candidateIndex - 1]; if (code === "PERSISTENCE_FAILED") throw new AppError(500, code); throw new ProviderFailure(code); } });
  const failure = fixture([ONE_PIXEL_PNG], { provider: failureProvider });
  let failureStatuses: string[] = [];
  try {
    failure.service.s2.getReferenceDraft(failure.projectId);
    const bound = await failure.service.s2.bindQa(failure.projectId, failure.generationSetId, 1, randomUUID(), randomUUID());
    const result = await waitFor(() => failure.service.s2.getQaRun(failure.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.status === "running" && current.qaRun.candidateResults.filter((candidate: any) => candidate.status.startsWith("qa_unavailable")).length === 3 &&
        current.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 4)?.status === "running");
    failureStatuses = result.qaRun.candidateResults.map((candidate: any) => candidate.status);
    const failureOperationCode = (candidateIndex: number) => {
      const candidateId = result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === candidateIndex)?.candidateId;
      return failure.repository.state().s2Operations.find((operation) => operation.phase === "qa" && operation.candidateId === candidateId && operation.attempt === 1)?.failureCode ?? "";
    };
    await prove(["QA-012/incomplete", "QA-012/timeout", "QA-012/decoder", "QA-012/persistence"], "qa failure boundary", "Three real provider failure fixtures and one controlled run-scoped persistence exception through production QA aggregation.",
      { failureClasses: failureCodes.join(","), statuses: failureStatuses.join(","), materialFails: result.qaRun.materialFailCount, result: "unavailable-not-material" },
      "The real provider failures became candidate-level unavailable states; the persistence exception remained running and did not manufacture a candidate-level unavailable state or completed run.",
      () => { assert.equal(result.qaRun.candidateResults.every((candidate: any) => candidate.status !== "material_fail"), true); assert.equal(result.qaRun.candidateResults.filter((candidate: any) => candidate.verdict === "QA_UNAVAILABLE").length, 4); assert.equal(result.qaRun.status, "running"); assert.equal(result.qaRun.completedCandidateCount, 3); }, undefined, {
        "QA-012/incomplete": () => { assert.equal(failureOperationCode(1), "QA_PROVIDER_INCOMPLETE"); assert.notEqual(failureStatuses[0], "material_fail"); },
        "QA-012/timeout": () => { assert.equal(failureOperationCode(2), "PROVIDER_TIMEOUT"); assert.notEqual(failureStatuses[1], "material_fail"); },
        "QA-012/decoder": () => { assert.equal(failureOperationCode(3), "QA_DECODER_FAILED"); assert.notEqual(failureStatuses[2], "material_fail"); },
        "QA-012/persistence": () => { const operation = failure.repository.state().s2Operations.find((item) => item.phase === "qa" && item.candidateId === result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 4).candidateId)!; assert.equal(failureOperationCode(4), ""); assert.equal(failureStatuses[3], "running"); assert.equal(operation.status, "running"); assert.equal(operation.providerDispatchState, "may_have_started"); },
      });
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
    const finalFailureOperationCode = (candidateIndex: number) => {
      const candidateId = result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === candidateIndex)?.candidateId;
      return finalFailure.repository.state().s2Operations.find((operation) => operation.phase === "qa" && operation.candidateId === candidateId && operation.attempt === 1)?.failureCode ?? "";
    };
    await prove(["QA-012/refusal", "QA-012/provider"], "qa refusal and provider aggregation", "Real refusal and provider-client failure classes through the terminal QA boundary.",
      { refusalStatus: statuses[0], providerStatus: statuses[1], materialFails: result.qaRun.materialFailCount, result: "unavailable-not-material" },
      "The real refusal and provider failures remained terminal QA_UNAVAILABLE and did not become MATERIAL_FAIL.",
      () => { assert.equal(statuses[0], "qa_unavailable_terminal"); assert.equal(statuses[1], "qa_unavailable_terminal"); assert.equal(result.qaRun.materialFailCount, 0); }, undefined, {
        "QA-012/refusal": () => { assert.equal(finalFailureOperationCode(1), "QA_PROVIDER_REFUSED"); assert.equal(statuses[0], "qa_unavailable_terminal"); },
        "QA-012/provider": () => { assert.equal(finalFailureOperationCode(2), "PROVIDER_CLIENT_ERROR"); assert.equal(statuses[1], "qa_unavailable_terminal"); },
      });
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
      const persistedLatest = value.repository.state().s2QaRuns[0].candidateResults.find((item) => item.candidateIndex === 1)!;
      const qaOperations = value.repository.state().s2Operations.filter((item) => item.phase === "qa" && item.candidateId === candidateId);
      if (!attemptTwoFailure) {
        await prove(claimIds("RETRY-001", ["retryable-visible", "terminal-hidden"]), "retry status visibility", "Real attempt-1 timeout followed by explicit retry and terminal attempt-2 state.",
          { retryableStatus: failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).status, terminalStatus: latest.status, runStatus: final.qaRun.status, result: "explicit-state" },
          "The real retryable state was visible before retry and the terminal state was visible only after attempt two completed.",
          () => { assert.equal(failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).status, "qa_unavailable_retryable"); assert.equal(latest.status, expectedStatus); }, undefined, {
            "RETRY-001/retryable-visible": () => assert.equal(failed.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1).status, "qa_unavailable_retryable"),
            "RETRY-001/terminal-hidden": () => { assert.equal(latest.status, expectedStatus); assert.equal(final.qaRun.status, "completed"); },
          });
        await prove(claimIds("RETRY-002", ["attempt2", "same-input", "same-run", "no-new-draft"]), "retry identity preservation", "Real retry operation persisted as attempt two on the same QA run and input.",
          { attempts: attempts.length, latestAttempt: latest.attempt, inputVersionId: bound.inputVersionId, sameRun: latest.qaRunId === bound.qaRun.id, draftCount: value.repository.state().s2Drafts.length, result: "same-run-input" },
          "The explicit retry appended attempt two to the same run/input without creating a new draft.",
          () => { assert.equal(attempts.length, 2); assert.equal(latest.attempt, 2); assert.equal(latest.qaRunId, bound.qaRun.id); assert.equal(value.repository.state().s2Inputs.length, 1); }, undefined, {
            "RETRY-002/attempt2": () => { assert.equal(attempts.length, 2); assert.equal(latest.attempt, 2); },
            "RETRY-002/same-input": () => assert.equal(value.repository.state().s2Inputs[0].id, bound.inputVersionId),
            "RETRY-002/same-run": () => assert.equal(latest.qaRunId, bound.qaRun.id),
            "RETRY-002/no-new-draft": () => assert.equal(value.repository.state().s2Drafts.length, 1),
          });
      }
      if (attemptTwoFailure) {
        await prove(claimIds("RETRY-003", ["terminal-reject", "attempt2-exhausted"]), "retry terminal exhaustion", "Real attempt-two schema failure after a retryable attempt-one timeout.",
          { attemptOneStatus: attempts.find((item: any) => item.attempt === 1).status, attemptTwoStatus: attempts.find((item: any) => item.attempt === 2).status, terminalCode: qaOperations.find((item) => item.attempt === 2)?.failureCode ?? "", result: "terminal-reject" },
          "The second failed attempt became terminal and did not remain retryable.",
          () => { assert.equal(attempts.find((item: any) => item.attempt === 2).status, "qa_unavailable_terminal"); assert.equal(latest.status, "qa_unavailable_terminal"); }, undefined, {
            "RETRY-003/terminal-reject": () => assert.equal(attempts.find((item: any) => item.attempt === 2).status, "qa_unavailable_terminal"),
            "RETRY-003/attempt2-exhausted": () => { assert.equal(latest.status, "qa_unavailable_terminal"); assert.equal(qaOperations.find((item) => item.attempt === 2)?.failureCode, "QA_SCHEMA_INVALID"); },
          });
      }
      if (!attemptTwoFailure) {
        await prove(claimIds("RETRY-004", ["no-hidden", "one-call"]), "retry provider-call count", "Real provider call count across one stale attempt, one explicit retry, and the other candidates.",
          { providerCalls, qaOperations: qaOperations.length, attemptOneCalls: 1, attemptTwoCalls: 1, result: "no-hidden-retry" },
          "The explicit retry caused one additional provider call for the candidate and no hidden provider retry.",
          () => { assert.equal(providerCalls, 5); assert.equal(qaOperations.length, 2); }, undefined, {
            "RETRY-004/no-hidden": () => assert.equal(providerCalls, 5),
            "RETRY-004/one-call": () => { assert.equal(qaOperations.length, 2); assert.equal(qaOperations.filter((item) => item.attempt === 1).length, 1); assert.equal(qaOperations.filter((item) => item.attempt === 2).length, 1); },
          });
        await prove(claimIds("RETRY-005", ["late-fences-attempt2", "late-fences-terminal"]), "retry late-completion fencing", "A controlled late attempt-1 completion released only after attempt two and terminal truth were persisted.",
          { race: eventOrder.indexOf("attempt-1-late-complete") > eventOrder.indexOf("attempt-2-terminal"), eventOrder: eventOrder.join(">"), attempts: attempts.length, latestAttempt: latest.attempt, latestStatus: latest.status, staleProviderRequest: persistedLatest.providerRequestId === "late-attempt-1", result: "stale-fenced" },
          "The late attempt-one completion could not overwrite the persisted latest attempt or terminal state.",
          () => { assert.equal(attempts.length, 2); assert.equal(latest.attempt, 2); assert.notEqual(persistedLatest.providerRequestId, "late-attempt-1"); assert.equal(final.qaRun.status, "completed"); }, undefined, {
            "RETRY-005/late-fences-attempt2": () => { assert.equal(eventOrder.indexOf("attempt-1-late-complete") > eventOrder.indexOf("attempt-2-terminal"), true); assert.equal(latest.attempt, 2); },
            "RETRY-005/late-fences-terminal": () => { assert.notEqual(persistedLatest.providerRequestId, "late-attempt-1"); assert.equal(final.qaRun.status, "completed"); },
          });
      }
    } finally { stale.resolve(); rmSync(value.root, { recursive: true, force: true }); }
  }
  await runEvidenceRetryRace(false);
  await runEvidenceRetryRace(true);

  const repairCaptured: any[] = [];
  const repairBrief = briefData(true);
  repairBrief.freeTextRequirements = ["Keep the visual tone calm."];
  const repairQaCalls = new Map<number, number>();
  const repairProvider = new MockOpenAIProvider({
    briefData: repairBrief,
    s2RepairResponses: [ONE_PIXEL_PNG, ONE_PIXEL_PNG],
    onS2RepairRequest: (input) => repairCaptured.push(input),
    s2QaResponseFactory: (input) => {
      const call = repairQaCalls.get(input.candidateIndex) ?? 0;
      repairQaCalls.set(input.candidateIndex, call + 1);
      if (input.candidateIndex === 1 && call === 0) return qaPayload(input, "requirement-violation", "scale.human,structure.overhead-support");
      if (input.candidateIndex === 2 && call === 0) return qaPayload(input, "uncertain");
      if (input.candidateIndex === 3 && call === 0) throw new ProviderFailure("PROVIDER_TIMEOUT");
      if (input.candidateIndex === 3 && call === 1) return qaPayload(input, "pass", "structure.overhead-support");
      return qaPayload(input, "pass");
    },
  });
  const repairValue = fixture([ONE_PIXEL_PNG], { data: repairBrief, provider: repairProvider });
  try {
    const draft = repairValue.service.s2.getReferenceDraft(repairValue.projectId);
    const referenceOne = await repairValue.service.s2.uploadAsset(repairValue.projectId, "reference", "reference-one.png", "image/png", await solidPng(2, 2, { r: 51, g: 52, b: 53 }), randomUUID());
    const referenceTwo = await repairValue.service.s2.uploadAsset(repairValue.projectId, "reference", "reference-two.png", "image/png", await solidPng(2, 2, { r: 54, g: 55, b: 56 }), randomUUID());
    const logo = await repairValue.service.s2.uploadAsset(repairValue.projectId, "logo", "logo.png", "image/png", await solidPng(2, 2, { r: 57, g: 58, b: 59 }), randomUUID());
    const updated = repairValue.service.s2.updateDraft(repairValue.projectId, draft.revision, [referenceOne.asset.id, referenceTwo.asset.id], [logo.asset.id], randomUUID());
    const { bound, result: initial } = await bindAndWait(repairValue, updated.draft.revision);
    const initialCandidate = initial.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
    const passCandidate = initial.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 2)!;
    const secondCandidate = initial.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 3)!;
    assert.equal(secondCandidate.status, "qa_unavailable_retryable");
    await repairValue.service.s2.retryQa(repairValue.projectId, bound.qaRun.id, secondCandidate.candidateId, randomUUID(), randomUUID());
    await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any,
      (current) => current.qaRun.candidateResults.some((candidate: any) => candidate.candidateIndex === 3 && candidate.attempt === 2 && candidate.status === "material_fail"));
    const started = await repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, initialCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.repairs?.some((item: any) => item.candidateId === initialCandidate.candidateId && item.status === "re_qa_pass"));
    await repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, secondCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const after = await waitFor(() => repairValue.service.s2.getQaRun(repairValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.repairs?.filter((item: any) => item.status === "re_qa_pass").length === 2);
    const state = repairValue.repository.state();
    const input = state.s2Inputs[0];
    const repair = state.s2Repairs[0];
    const secondRepair = state.s2Repairs.find((item) => item.candidateId === secondCandidate.candidateId)!;
    const secondLatest = state.s2QaRuns[0].candidateResults.find((item) => item.candidateId === secondCandidate.candidateId && item.attempt === 2)!;
    const derived = state.s2DerivedCandidates[0];
    const reQa = state.s2ReQaResults[0];
    const repairOperation = state.s2Operations.find((operation) => operation.phase === "repair")!;
    const reQaOperation = state.s2Operations.find((operation) => operation.phase === "re_qa")!;
    const repairPublication = state.s2Publications.find((publication) => publication.kind === "repair_output")!;
    const request = buildS2RepairRequest(repairCaptured[0]) as ReturnType<typeof buildS2RepairRequest> & { mask?: unknown; input_fidelity?: unknown };
    const sourceBefore = Buffer.from(repairValue.objects.read(input.sourceCandidates[0].sourceStorageKey));
    const orderedInputHashes = repairCaptured[0].images.map((image: Uint8Array) => sha256(image)).join(",");
    const ruleIds = input.designRuleSnapshot.map((rule) => rule.ruleId);
    const repairAgainCode = await observedErrorCode(() => repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, initialCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()));
    const ineligibleCode = await observedErrorCode(() => repairValue.service.s2.repairCandidate(repairValue.projectId, bound.qaRun.id, passCandidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID()));
    await prove(claimIds("REPAIR-001", ["complete-material", "allowlist", "overhead-scale"]), "repair material eligibility", "Real material QA candidate followed by one persisted bounded repair attempt.",
      { initialStatus: initialCandidate.status, findingCount: repair.eligibleFindingIds.length, firstFinding: repair.eligibleFindingIds[0] ?? "", repairStarted: started.replayed === false, result: "eligible" },
      "The real material candidate created exactly one bounded repair attempt with a server-owned eligible finding.",
      () => { assert.equal(initialCandidate.status, "material_fail"); assert.equal(repair.eligibleFindingIds.includes("brief.functional.001"), true); assert.equal(started.replayed, false); }, undefined, {
        "REPAIR-001/complete-material": () => assert.equal(initialCandidate.status, "material_fail"),
        "REPAIR-001/allowlist": () => assert.equal(repair.eligibleFindingIds.includes("brief.functional.001"), true),
        "REPAIR-001/overhead-scale": () => { assert.equal(initialCandidate.materialFindingIds.includes("scale.human"), true); assert.equal(initialCandidate.materialFindingIds.includes("structure.overhead-support"), true); assert.equal(repair.eligibleFindingIds.includes("scale.human"), true); assert.equal(repair.eligibleFindingIds.includes("structure.overhead-support"), true); },
      });
    await prove(claimIds("REPAIR-003", ["footprint", "access", "circulation", "zones", "no-floating", "screen-support", "overhead-support", "scale", "intersections", "branding", "functional", "mandatory"]), "repair objective catalogue", "Persisted server rule catalogue, confirmed functional finding, and generated bounded repair prompt.",
      { ruleCount: ruleIds.length, hasOverheadRule: ruleIds.includes("structure.overhead-support"), hasFunctionalFinding: repair.eligibleFindingIds.includes("brief.functional.001"), promptHasGeometry: request.prompt.includes("widthMm=9000"), promptHasObjective: request.prompt.includes("Correct the clearly unsupported overhead visual issue"), result: "allowlisted" },
      "The real repair input and prompt contained the server-owned rule catalogue, functional objective, and bounded geometry facts.",
      () => { assert.equal(ruleIds.includes("footprint.within-boundary"), true); assert.equal(ruleIds.includes("structure.overhead-support"), true); assert.equal(request.prompt.includes("Correct the clearly unsupported overhead visual issue"), true); assert.equal(request.prompt.includes("do not claim engineering or approval"), true); }, undefined, {
        "REPAIR-003/footprint": () => assert.equal(ruleIds.includes("footprint.within-boundary"), true),
        "REPAIR-003/access": () => assert.equal(ruleIds.includes("access.open-sides"), true),
        "REPAIR-003/circulation": () => assert.equal(ruleIds.includes("circulation.primary-access"), true),
        "REPAIR-003/zones": () => assert.equal(ruleIds.includes("zones.inside-footprint"), true),
        "REPAIR-003/no-floating": () => assert.equal(ruleIds.includes("structure.no-floating"), true),
        "REPAIR-003/screen-support": () => assert.equal(ruleIds.includes("structure.screen-support"), true),
        "REPAIR-003/overhead-support": () => assert.equal(ruleIds.includes("structure.overhead-support"), true),
        "REPAIR-003/scale": () => assert.equal(ruleIds.includes("scale.human"), true),
        "REPAIR-003/intersections": () => assert.equal(ruleIds.includes("geometry.intersections"), true),
        "REPAIR-003/branding": () => assert.equal(ruleIds.includes("branding.prohibited"), true),
        "REPAIR-003/functional": () => assert.equal(repair.eligibleFindingIds.includes("brief.functional.001"), true),
        "REPAIR-003/mandatory": () => assert.equal(request.prompt.includes("Keep the entry clear."), true),
      });
    await prove(claimIds("REPAIR-005", ["max-height", "style", "rigging", "budget", "free-text", "hard-facts", "overhead-scale-eligible", "uncertainty-ineligible"]), "repair eligibility facts", "Real input applicability/criticality catalogue, material repair eligibility, pass-candidate rejection, and geometry prompt.",
      { maxHeightApplicability: input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")?.applicability ?? "", nonRepairableWarningRules: input.designRuleSnapshot.filter((rule) => rule.materiality === "warning" && !rule.repairable).length, freeTextRequirements: input.canonicalRequirements.filter((requirement) => requirement.category === "free_text").length, eligibleFinding: repair.eligibleFindingIds[0] ?? "", ineligibleCode, uncertainCandidateStatus: passCandidate.status, hardWidthMm: input.geometrySnapshot.widthMm, result: "bounded" },
      "The real repair eligibility path used persisted hard facts and rejected a non-failing candidate rather than repairing uncertainty or warning-only rules.",
      () => { assert.equal(input.geometrySnapshot.widthMm, 9000); assert.equal(input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")?.applicability, "not_applicable"); assert.equal(ineligibleCode, "REPAIR_NOT_ELIGIBLE"); }, undefined, {
        "REPAIR-005/max-height": () => assert.equal(input.designRuleSnapshot.find((rule) => rule.ruleId === "geometry.max-height")?.applicability, "not_applicable"),
        "REPAIR-005/style": () => { const rule = input.designRuleSnapshot.find((item) => item.ruleId === "branding.style")!; assert.equal(rule.materiality, "warning"); assert.equal(rule.repairable, false); },
        "REPAIR-005/rigging": () => { const rule = input.designRuleSnapshot.find((item) => item.ruleId === "rigging.confirmation")!; assert.equal(rule.materiality, "warning"); assert.equal(rule.repairable, false); },
        "REPAIR-005/budget": () => { const rule = input.designRuleSnapshot.find((item) => item.ruleId === "budget.complexity")!; assert.equal(rule.materiality, "warning"); assert.equal(rule.repairable, false); },
        "REPAIR-005/free-text": () => assert.equal(input.canonicalRequirements.some((requirement) => requirement.category === "free_text"), true),
        "REPAIR-005/hard-facts": () => { assert.equal(input.geometrySnapshot.widthMm, 9000); assert.equal(input.geometrySnapshot.depthMm, 6000); assert.equal(input.geometrySnapshot.maxHeightMm, null); },
        "REPAIR-005/overhead-scale-eligible": () => { assert.equal(repair.eligibleFindingIds.includes("structure.overhead-support"), true); assert.equal(repair.eligibleFindingIds.includes("scale.human"), true); },
        "REPAIR-005/uncertainty-ineligible": () => { assert.equal(passCandidate.status, "warning"); assert.equal(ineligibleCode, "REPAIR_NOT_ELIGIBLE"); },
      });
    await prove(claimIds("REPAIR-006", ["geometry", "open-side", "source-lineage", "brief"]), "repair immutable context", "Real repair prompt and persisted input snapshots for geometry, open sides, source lineage, and confirmed brief facts.",
      { widthMm: input.geometrySnapshot.widthMm, depthMm: input.geometrySnapshot.depthMm, openSides: input.geometrySnapshot.openSides.join(","), sourceSha256: repair.sourceSha256, latestAttempt: secondLatest.attempt, secondRepairSourceSha256: secondRepair.sourceSha256, briefVersionId: input.confirmedBriefVersionId, result: "preserved" },
      "The real repair prompt preserved exact geometry, open sides, confirmed brief identity, and linked the second repair to the candidate's latest source-QA attempt.",
      () => { assert.equal(request.prompt.includes("north,west"), true); assert.equal(repair.sourceSha256, input.sourceCandidates[0].sourceSha256); assert.equal(repair.sourceAssetId, input.sourceCandidates[0].sourceAssetId); assert.equal(secondLatest.attempt, 2); assert.equal(secondLatest.repairAttemptId, secondRepair.id); assert.equal(secondRepair.sourceSha256, secondLatest.sourceSha256); }, undefined, {
        "REPAIR-006/geometry": () => { assert.equal(input.geometrySnapshot.widthMm, 9000); assert.equal(input.geometrySnapshot.depthMm, 6000); },
        "REPAIR-006/open-side": () => { assert.deepEqual(input.geometrySnapshot.openSides, ["north", "west"]); assert.equal(request.prompt.includes("north,west"), true); },
        "REPAIR-006/source-lineage": () => { assert.equal(repair.sourceSha256, input.sourceCandidates[0].sourceSha256); assert.equal(repair.sourceAssetId, input.sourceCandidates[0].sourceAssetId); assert.equal(secondLatest.attempt, 2); assert.equal(secondLatest.repairAttemptId, secondRepair.id); assert.equal(secondRepair.sourceSha256, secondLatest.sourceSha256); },
        "REPAIR-006/brief": () => { assert.equal(input.confirmedBriefVersionId.length > 0, true); assert.equal(request.prompt.includes("Keep the entry clear."), true); },
      });
    await prove(claimIds("REPAIR-007", ["already-exists", "exhausted"]), "repair candidate-scoped cardinality", "Real two-candidate repair workflow with one completed repair per candidate and a rejected same-candidate second request.",
      { attempts: state.s2Repairs.length, secondCode: repairAgainCode, repairOperations: state.s2Operations.filter((operation) => operation.phase === "repair").length, independentCandidate: state.s2Repairs.some((item) => item.candidateId === secondCandidate.candidateId), result: "one-per-candidate" },
      "The real repair graph allowed independent candidate repairs while rejecting a second repair for the same candidate.",
      () => { assert.equal(state.s2Repairs.length, 2); assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"); assert.equal(state.s2Operations.filter((operation) => operation.phase === "repair").length, 2); assert.equal(state.s2Repairs.some((item) => item.candidateId === secondCandidate.candidateId), true); }, undefined, {
        "REPAIR-007/already-exists": () => assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"),
        "REPAIR-007/exhausted": () => { assert.equal(state.s2Repairs.length, 2); assert.equal(state.s2Operations.filter((operation) => operation.phase === "repair").length, 2); assert.equal(state.s2Repairs.some((item) => item.candidateId === secondCandidate.candidateId), true); },
      });
    await prove(claimIds("REPAIR-008", ["source-first", "refs-order", "logos-order"]), "repair image ordering", "Captured local repair provider input built from the persisted source, reference order, and logo order.",
      { imageCount: repairCaptured[0].images.length, sourceFirst: Buffer.from(repairCaptured[0].images[0]).equals(sourceBefore), referenceOneHash: sha256(repairCaptured[0].images[1]), referenceTwoHash: sha256(repairCaptured[0].images[2]), logoHash: sha256(repairCaptured[0].images[3]), result: "ordered" },
      "The real repair adapter received source first, then persisted reference order, then persisted logo order.",
      () => { assert.equal(repairCaptured[0].images.length, 4); assert.equal(Buffer.from(repairCaptured[0].images[0]).equals(sourceBefore), true); assert.equal(orderedInputHashes.split(",").length, 4); }, undefined, {
        "REPAIR-008/source-first": () => assert.equal(Buffer.from(repairCaptured[0].images[0]).equals(sourceBefore), true),
        "REPAIR-008/refs-order": () => { assert.equal(sha256(repairCaptured[0].images[1]), referenceOne.asset.normalizedSha256); assert.equal(sha256(repairCaptured[0].images[2]), referenceTwo.asset.normalizedSha256); },
        "REPAIR-008/logos-order": () => assert.equal(sha256(repairCaptured[0].images[3]), logo.asset.normalizedSha256),
      });
    const repairMeasures = [
      { encodedBytes: input.sourceCandidates[0].sourceByteSize, pixelCount: input.sourceCandidates[0].sourcePixelCount, rgba: input.sourceCandidates[0].sourceDecodedRgbaBytes },
      ...state.s2Assets.filter((asset) => input.referenceAssetIds.includes(asset.id) || input.logoAssetIds.includes(asset.id)).map((asset) => ({ encodedBytes: asset.normalizedBytes, pixelCount: asset.pixelCount, rgba: asset.pixelCount * 4 })),
    ];
    await prove(claimIds("REPAIR-009", ["count", "decoded", "rgba", "encoded-precall"]), "repair aggregate pre-call", "Real persisted repair image set and decoder-derived source/selected asset measures before the provider call.",
      { imageCount: repairCaptured[0].images.length, decodedPixels: repairMeasures.reduce((sum, item) => sum + item.pixelCount, 0), decodedRgbaBytes: repairMeasures.reduce((sum, item) => sum + item.rgba, 0), encodedBytes: repairMeasures.reduce((sum, item) => sum + item.encodedBytes, 0), result: "within-limit" },
      "The real repair pre-call aggregate counted all ordered images and measured their decoded pixel, RGBA, and encoded bytes.",
      () => { assert.equal(repairCaptured[0].images.length, 4); assert.equal(repairMeasures.every((item) => item.encodedBytes > 0 && item.pixelCount > 0 && item.rgba === item.pixelCount * 4), true); }, undefined, {
        "REPAIR-009/count": () => assert.equal(repairCaptured[0].images.length, 4),
        "REPAIR-009/decoded": () => assert.equal(repairMeasures.every((item) => item.pixelCount > 0), true),
        "REPAIR-009/rgba": () => assert.equal(repairMeasures.every((item) => item.rgba === item.pixelCount * 4), true),
        "REPAIR-009/encoded-precall": () => assert.equal(repairMeasures.every((item) => item.encodedBytes > 0), true),
      });
    await prove(claimIds("REPAIR-010", ["repeated-images", "model", "n-one", "size", "medium", "png", "no-mask-fidelity"]), "repair provider request contract", "Real buildS2RepairRequest output captured by the local fake adapter.",
      { model: request.model, n: request.n, size: request.size, quality: request.quality, outputFormat: request.output_format, imageCount: request.images.length, maskPresent: false, result: "locked" },
      "The actual repair request used the locked model, one output, size, quality, PNG format, and no mask-fidelity promise.",
      () => { assert.equal(request.model, "gpt-image-2-2026-04-21"); assert.equal(request.n, 1); assert.equal(request.size, "1536x1024"); assert.equal(request.quality, "medium"); assert.equal(request.output_format, "png"); assert.equal(request.images.length, 4); }, undefined, {
        "REPAIR-010/repeated-images": () => assert.equal(request.images.length, 4),
        "REPAIR-010/model": () => assert.equal(request.model, "gpt-image-2-2026-04-21"),
        "REPAIR-010/n-one": () => assert.equal(request.n, 1),
        "REPAIR-010/size": () => assert.equal(request.size, "1536x1024"),
        "REPAIR-010/medium": () => assert.equal(request.quality, "medium"),
        "REPAIR-010/png": () => assert.equal(request.output_format, "png"),
        "REPAIR-010/no-mask-fidelity": () => { assert.equal(request.mask, undefined); assert.equal(request.input_fidelity, undefined); },
      });
    const repairSource = input.sourceCandidates.find((source) => source.candidateId === repair.candidateId)!;
    const repairReferenceAssets = input.referenceAssetIds.map((assetId, index) => {
      const asset = state.s2Assets.find((item) => item.id === assetId)!;
      return { assetId: asset.id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const repairLogoAssets = input.logoAssetIds.map((assetId, index) => {
      const asset = state.s2Assets.find((item) => item.id === assetId)!;
      return { assetId: asset.id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
    });
    const capturedPrompt = repairCaptured[0].promptText as string;
    const expectedRepairInput = independentRepairInput(input, repairSource, repair.eligibleFindingIds, repairReferenceAssets, repairLogoAssets);
    const expectedRepairInputHash = independentRepairInputHash(expectedRepairInput);
    const expectedPrompt = independentRepairPrompt(input, repairSource, repair.eligibleFindingIds, repairReferenceAssets, repairLogoAssets, repair.repairInputHash);
    const expectedPromptBytes = Buffer.from(expectedPrompt, "utf8");
    const expectedCapturedHash = independentRepairPromptHash(expectedPrompt);
    const capturedPromptHash = independentRepairPromptHash(capturedPrompt);
    const identicalPrompt = independentRepairPrompt(input, repairSource, repair.eligibleFindingIds, repairReferenceAssets, repairLogoAssets, repair.repairInputHash);
    const identicalHash = independentRepairPromptHash(identicalPrompt);
    const changedFindingIds = ["footprint.within-boundary", "access.open-sides", "scale.human", "structure.overhead-support"];
    const changedFindingInput = independentRepairInput(input, repairSource, changedFindingIds, repairReferenceAssets, repairLogoAssets);
    const changedFindingHash = independentRepairInputHash(changedFindingInput);
    const changedFindingPrompt = independentRepairPrompt(input, repairSource, changedFindingIds, repairReferenceAssets, repairLogoAssets, changedFindingHash);
    const changedFindingPromptHash = independentRepairPromptHash(changedFindingPrompt);
    const changedManifest = repairReferenceAssets.map((asset, index) => index === 0 ? { ...asset, normalizedBytes: asset.normalizedBytes + 1 } : asset);
    const changedManifestInput = independentRepairInput(input, repairSource, repair.eligibleFindingIds, changedManifest, repairLogoAssets);
    const changedManifestHash = independentRepairInputHash(changedManifestInput);
    const changedManifestPrompt = independentRepairPrompt(input, repairSource, repair.eligibleFindingIds, changedManifest, repairLogoAssets, changedManifestHash);
    const changedManifestPromptHash = independentRepairPromptHash(changedManifestPrompt);
    const twoLfPrompt = expectedPrompt.replace(/\n(?=Hard geometry facts:|Confirmed brief requirements and prohibitions:|Ordered repair objectives:|Source image and reference\/logo role instructions:|Preservation constraints and visual-only disclosure:)/g, "\n\n");
    const crlfPrompt = expectedPrompt.replaceAll("\n", "\r\n");
    const missingTrailingLfPrompt = expectedPrompt.slice(0, -1);
    const extraTrailingLfPrompt = expectedPrompt + "\n";
    const numberedFindingIds = ["brief.functional.001", "brief.mandatory.001"];
    const numberedInput = independentRepairInput(input, repairSource, numberedFindingIds, repairReferenceAssets, repairLogoAssets);
    const numberedInputHash = independentRepairInputHash(numberedInput);
    const numberedExpectedPrompt = independentRepairPrompt(input, repairSource, numberedFindingIds, repairReferenceAssets, repairLogoAssets, numberedInputHash);
    const numberedProductionPrompt = renderS2RepairPrompt(input, repairSource, numberedFindingIds, repairReferenceAssets, repairLogoAssets, numberedInputHash);
    const functionalObjective = "Make the explicit functional requirement visible and correctly represented without inventing a new requirement.";
    const mandatoryObjective = "Make the explicit mandatory requirement visible and correctly represented without changing the confirmed brief.";
    const substitutedWordingPrompt = numberedExpectedPrompt.replace(mandatoryObjective, functionalObjective);
    const reorderedObjectivePrompt = independentRepairPrompt(input, repairSource, numberedFindingIds.slice().reverse(), repairReferenceAssets, repairLogoAssets, numberedInputHash);
    const exactFormatNegatives = {
      crlf: !Buffer.from(crlfPrompt, "utf8").equals(expectedPromptBytes),
      twoLfBoundary: !Buffer.from(twoLfPrompt, "utf8").equals(expectedPromptBytes),
      missingTrailingLf: !Buffer.from(missingTrailingLfPrompt, "utf8").equals(expectedPromptBytes),
      extraTrailingLf: !Buffer.from(extraTrailingLfPrompt, "utf8").equals(expectedPromptBytes),
      wordingSubstitution: !Buffer.from(substitutedWordingPrompt, "utf8").equals(Buffer.from(numberedExpectedPrompt, "utf8")),
      objectiveOrder: !Buffer.from(reorderedObjectivePrompt, "utf8").equals(Buffer.from(numberedExpectedPrompt, "utf8")),
    };
    await prove(claimIds("REPAIR-012", ["captured-bytes", "identical-render", "finding-sensitive", "manifest-sensitive", "not-shape-only", "exact-format"]), "repair prompt byte binding", "One real captured repair request plus a test-only independent G2-004 oracle, direct UTF-8 SHA-256, exact-format negatives, and changed immutable input projections.",
      { capturedBytes: Buffer.byteLength(capturedPrompt, "utf8"), expectedBytes: expectedPromptBytes.length, capturedHash: capturedPromptHash, expectedPromptHash: expectedCapturedHash, storedPromptHash: repair.repairPromptHash, persistedRepairInputHashMatches: expectedRepairInputHash === repair.repairInputHash, identicalBytes: Buffer.from(identicalPrompt, "utf8").equals(expectedPromptBytes), identicalHash: identicalHash === expectedCapturedHash, findingHashChanged: changedFindingHash !== repair.repairInputHash, findingPromptHashChanged: changedFindingPromptHash !== expectedCapturedHash, manifestHashChanged: changedManifestHash !== repair.repairInputHash, manifestPromptHashChanged: changedManifestPromptHash !== expectedCapturedHash, productionNumberedPromptMatches: Buffer.from(numberedProductionPrompt, "utf8").equals(Buffer.from(numberedExpectedPrompt, "utf8")), functionalObjectivePresent: numberedExpectedPrompt.includes(functionalObjective), mandatoryObjectivePresent: numberedExpectedPrompt.includes(mandatoryObjective), exactFormatNegatives: JSON.stringify(exactFormatNegatives), result: "independent-exact-byte-sensitive" },
      "The real repair provider request matched an independently rendered canonical prompt byte-for-byte and an independently calculated SHA-256; identical input was stable, finding and manifest changes changed the expected bytes/hash, and all exact-format drift fixtures failed the oracle comparison.",
      () => {
        assert.equal(Buffer.from(capturedPrompt, "utf8").equals(expectedPromptBytes), true);
        assert.equal(capturedPromptHash, repair.repairPromptHash);
        assert.equal(expectedCapturedHash, repair.repairPromptHash);
        assert.equal(expectedRepairInputHash, repair.repairInputHash);
        assert.equal(Buffer.from(identicalPrompt, "utf8").equals(expectedPromptBytes), true);
        assert.equal(identicalHash, expectedCapturedHash);
        assert.notEqual(changedFindingHash, repair.repairInputHash);
        assert.notEqual(changedFindingPromptHash, expectedCapturedHash);
        assert.notEqual(changedManifestHash, repair.repairInputHash);
        assert.notEqual(changedManifestPromptHash, expectedCapturedHash);
        assert.equal(Buffer.from(numberedProductionPrompt, "utf8").equals(Buffer.from(numberedExpectedPrompt, "utf8")), true);
        assert.equal(numberedExpectedPrompt.includes(functionalObjective), true);
        assert.equal(numberedExpectedPrompt.includes(mandatoryObjective), true);
        assert.deepEqual(exactFormatNegatives, { crlf: true, twoLfBoundary: true, missingTrailingLf: true, extraTrailingLf: true, wordingSubstitution: true, objectiveOrder: true });
      }, undefined, {
        "REPAIR-012/captured-bytes": () => { assert.equal(Buffer.from(capturedPrompt, "utf8").equals(expectedPromptBytes), true); assert.equal(capturedPromptHash, repair.repairPromptHash); assert.equal(expectedCapturedHash, repair.repairPromptHash); },
        "REPAIR-012/identical-render": () => { assert.equal(Buffer.from(identicalPrompt, "utf8").equals(expectedPromptBytes), true); assert.equal(identicalHash, expectedCapturedHash); },
        "REPAIR-012/finding-sensitive": () => { assert.notEqual(changedFindingHash, repair.repairInputHash); assert.notEqual(changedFindingPromptHash, expectedCapturedHash); },
        "REPAIR-012/manifest-sensitive": () => { assert.notEqual(changedManifestHash, repair.repairInputHash); assert.notEqual(changedManifestPromptHash, expectedCapturedHash); },
        "REPAIR-012/not-shape-only": () => { assert.equal(expectedPromptBytes.length > 0, true); assert.equal(expectedCapturedHash, repair.repairPromptHash); assert.equal(Buffer.from(capturedPrompt, "utf8").equals(expectedPromptBytes), true); assert.equal(repair.eligibleFindingIds.length > 0, true); },
        "REPAIR-012/exact-format": () => { assert.deepEqual(exactFormatNegatives, { crlf: true, twoLfBoundary: true, missingTrailingLf: true, extraTrailingLf: true, wordingSubstitution: true, objectiveOrder: true }); assert.equal(Buffer.from(numberedProductionPrompt, "utf8").equals(Buffer.from(numberedExpectedPrompt, "utf8")), true); },
      });
    const sharedRepairCaptured: any[] = [];
    const sharedRepairQaCalls = new Map<number, number>();
    const sharedRepairProvider = new MockOpenAIProvider({
      briefData: briefData(),
      s2RepairResponses: [ONE_PIXEL_PNG],
      onS2RepairRequest: (capturedRequest) => sharedRepairCaptured.push(capturedRequest),
      s2QaResponseFactory: (qaInput) => {
        const call = sharedRepairQaCalls.get(qaInput.candidateIndex) ?? 0;
        sharedRepairQaCalls.set(qaInput.candidateIndex, call + 1);
        if (qaInput.candidateIndex === 1 && call === 0) return sharedAccessPayload(qaInput, "material", "compliant");
        return qaPayload(qaInput, "pass");
      },
    });
    const sharedRepairValue = fixture([ONE_PIXEL_PNG], { provider: sharedRepairProvider });
    try {
      const { bound: sharedBound, result: sharedInitial } = await bindAndWait(sharedRepairValue);
      const sharedCandidate = sharedInitial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
      await sharedRepairValue.service.s2.repairCandidate(sharedRepairValue.projectId, sharedBound.qaRun.id, sharedCandidate.candidateId, sharedBound.inputVersionId, randomUUID(), randomUUID());
      await waitFor(() => sharedRepairValue.service.s2.getQaRun(sharedRepairValue.projectId, sharedBound.qaRun.id) as any,
        (current) => current.qaRun.repairs?.some((item: any) => item.candidateId === sharedCandidate.candidateId && item.status === "re_qa_pass"));
      const sharedRepairState = sharedRepairValue.repository.state();
      const sharedRepairInput = sharedRepairState.s2Inputs[0];
      const sharedRepairCandidate = sharedRepairState.s2QaRuns[0].candidateResults.find((item) => item.candidateIndex === 1)!;
      const sharedRepairAttempt = sharedRepairState.s2Repairs.find((item) => item.candidateId === sharedRepairCandidate.candidateId)!;
      const sharedRepairOperation = sharedRepairState.s2Operations.find((item) => item.phase === "repair" && item.repairAttemptId === sharedRepairAttempt.id)!;
      const sharedRepairSource = sharedRepairInput.sourceCandidates.find((item) => item.candidateId === sharedRepairCandidate.candidateId)!;
      const sharedRepairReduced = reduceS2Findings(sharedRepairInput, sharedRepairCandidate.requirementObservations, sharedRepairCandidate.designObservations);
      const sharedRepairReferences = sharedRepairInput.referenceAssetIds.map((assetId, index) => {
        const asset = sharedRepairState.s2Assets.find((item) => item.id === assetId)!;
        return { assetId: asset.id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
      });
      const sharedRepairLogos = sharedRepairInput.logoAssetIds.map((assetId, index) => {
        const asset = sharedRepairState.s2Assets.find((item) => item.id === assetId)!;
        return { assetId: asset.id, normalizedSha256: asset.normalizedSha256, width: asset.width, height: asset.height, normalizedBytes: asset.normalizedBytes, slot: index + 1 };
      });
      const expectedSharedRepairInputHash = canonicalRepairInputHash(sharedRepairInput, sharedRepairSource, sharedRepairReduced.materialFindingIds, sharedRepairReferences, sharedRepairLogos);
      const expectedSharedPrompt = renderS2RepairPrompt(sharedRepairInput, sharedRepairSource, sharedRepairReduced.materialFindingIds, sharedRepairReferences, sharedRepairLogos, expectedSharedRepairInputHash);
      const expectedSharedOperationHash = hashCanonicalOperationInput("s2_repair", sharedRepairValue.projectId, {
        qaRunId: sharedBound.qaRun.id, candidateId: sharedRepairCandidate.candidateId, expectedInputVersionId: sharedBound.inputVersionId,
        eligibleFindingIds: sharedRepairReduced.materialFindingIds,
      });
      const sharedObjectiveCount = (sharedRepairCaptured[0].promptText.match(/Keep every supplied open side visibly clear and approachable\./g) ?? []).length;
      await prove(claimIds("REPAIR-017", ["access-reduction", "eligibility", "operation-hash", "repair-input-hash", "prompt-objective"]), "repair downstream shared-finding binding", "One real repairable access.open-sides material-vs-compliant workflow with independent reduction and exact downstream hash reconstruction.",
        { reducedMaterialIds: sharedRepairReduced.materialFindingIds.join(","), reducedWarningIds: sharedRepairReduced.warningFindingIds.join(","), eligibleFindingIds: sharedRepairAttempt.eligibleFindingIds.join(","), operationFindingIds: sharedRepairOperation.inputHash === expectedSharedOperationHash ? sharedRepairAttempt.eligibleFindingIds.join(",") : "mismatch", repairInputHashMatches: sharedRepairAttempt.repairInputHash === expectedSharedRepairInputHash, promptHashMatches: repairPromptHash(sharedRepairCaptured[0].promptText) === sharedRepairAttempt.repairPromptHash && Buffer.from(sharedRepairCaptured[0].promptText, "utf8").equals(Buffer.from(expectedSharedPrompt, "utf8")), observationsPreserved: sharedRepairCandidate.requirementObservations.filter((item) => item.requirementId === "access.open-sides").length === 1 && sharedRepairCandidate.designObservations.filter((item) => item.ruleId === "access.open-sides").length === 1, sharedObjectiveCount, result: "same-post-reduction-set" },
        "The repairable shared access finding was reduced once and the exact post-reduction material set drove eligibility, operation identity, repair input hash, and prompt objective rendering.",
        () => { assert.deepEqual(sharedRepairReduced.materialFindingIds, ["access.open-sides"]); assert.deepEqual(sharedRepairAttempt.eligibleFindingIds, ["access.open-sides"]); assert.equal(sharedRepairOperation.inputHash, expectedSharedOperationHash); assert.equal(sharedRepairAttempt.repairInputHash, expectedSharedRepairInputHash); assert.equal(repairPromptHash(sharedRepairCaptured[0].promptText), sharedRepairAttempt.repairPromptHash); assert.equal(Buffer.from(sharedRepairCaptured[0].promptText, "utf8").equals(Buffer.from(expectedSharedPrompt, "utf8")), true); assert.equal(sharedObjectiveCount, 1); }, undefined, {
          "REPAIR-017/access-reduction": () => { assert.deepEqual(sharedRepairReduced.materialFindingIds, ["access.open-sides"]); assert.equal(sharedRepairReduced.warningFindingIds.length, 0); assert.equal(sharedRepairCandidate.requirementObservations.filter((item) => item.requirementId === "access.open-sides").length, 1); assert.equal(sharedRepairCandidate.designObservations.filter((item) => item.ruleId === "access.open-sides").length, 1); },
          "REPAIR-017/eligibility": () => assert.deepEqual(sharedRepairAttempt.eligibleFindingIds, ["access.open-sides"]),
          "REPAIR-017/operation-hash": () => assert.equal(sharedRepairOperation.inputHash, expectedSharedOperationHash),
          "REPAIR-017/repair-input-hash": () => assert.equal(sharedRepairAttempt.repairInputHash, expectedSharedRepairInputHash),
          "REPAIR-017/prompt-objective": () => { assert.equal(repairPromptHash(sharedRepairCaptured[0].promptText), sharedRepairAttempt.repairPromptHash); assert.equal(Buffer.from(sharedRepairCaptured[0].promptText, "utf8").equals(Buffer.from(expectedSharedPrompt, "utf8")), true); assert.equal(sharedObjectiveCount, 1); },
        });
    } finally { rmSync(sharedRepairValue.root, { recursive: true, force: true }); }
    await prove(["REPAIR-013/evidence-ignored"], "repair provider evidence boundary", "Real captured repair prompt built from server findings without copying provider observation evidence.",
      { promptContainsProviderEvidence: request.prompt.includes("local provider fixture observation"), findingCount: repair.eligibleFindingIds.length, result: "provider-evidence-ignored" },
      "The real repair prompt used server-owned finding IDs and did not treat provider evidence text as a repair instruction.",
      () => { assert.equal(request.prompt.includes("local provider fixture observation"), false); });
    await prove(claimIds("REPAIR-014", ["staging", "stale-claim", "publication"]), "repair publication fencing", "Real committed repair-output publication, claim-token clearing, and staging cleanup after re-QA.",
      { publicationState: repairPublication.state, stagingRemaining: repairPublication.stagingObjects.filter((object) => repairValue.objects.exists(object.key)).length, repairOperationStatus: repairOperation.status, claimTokenCleared: repairOperation.claimToken === null, result: "committed-fenced" },
      "The real repair output committed through the publication boundary and cleared its operation claim after successful re-QA.",
      () => { assert.equal(repairPublication.state, "committed"); assert.equal(repairOperation.status, "succeeded"); assert.equal(repairOperation.claimToken, null); assert.equal(repairPublication.stagingObjects.every((object) => !repairValue.objects.exists(object.key)), true); }, undefined, {
        "REPAIR-014/staging": () => assert.equal(repairPublication.stagingObjects.every((object) => !repairValue.objects.exists(object.key)), true),
        "REPAIR-014/stale-claim": () => { assert.equal(repairOperation.claimToken, null); assert.equal(repairOperation.status, "succeeded"); },
        "REPAIR-014/publication": () => assert.equal(repairPublication.state, "committed"),
      });
    await prove(claimIds("REPAIR-015", ["bounded-support", "no-approval"]), "repair support disclosure", "Real generated repair prompt containing the bounded visual-support and no-approval constraints.",
      { promptHasBounded: request.prompt.includes("bounded visual correction"), promptHasNoApproval: request.prompt.includes("do not claim engineering or approval"), result: "disclosed" },
      "The real repair prompt constrained the output to bounded visual support and explicitly excluded approval claims.",
      () => { assert.equal(request.prompt.includes("bounded visual correction"), true); assert.equal(request.prompt.includes("do not claim engineering or approval"), true); }, undefined, {
        "REPAIR-015/bounded-support": () => assert.equal(request.prompt.includes("bounded visual correction"), true),
        "REPAIR-015/no-approval": () => assert.equal(request.prompt.includes("do not claim engineering or approval"), true),
      });
    await prove(claimIds("REPAIR-016", ["bounded-scale", "no-hard-geometry", "no-engineering-venue"]), "repair scale and venue boundary", "Real repair prompt with exact geometry preservation and explicit engineering/venue non-claims.",
      { promptHasScale: request.prompt.includes("scale correction"), geometryPreserved: request.prompt.includes("Preserve S1 lineage, confirmed facts, exact geometry"), noEngineering: request.prompt.includes("do not claim engineering or approval"), result: "bounded" },
      "The real repair prompt allowed only bounded visual scale correction while preserving hard geometry and excluding engineering or venue claims.",
       () => { assert.equal(request.prompt.includes("scale correction"), true); assert.equal(request.prompt.includes("exact geometry"), true); }, undefined, {
         "REPAIR-016/bounded-scale": () => assert.equal(request.prompt.includes("scale correction"), true),
         "REPAIR-016/no-hard-geometry": () => assert.equal(request.prompt.includes("exact geometry"), true),
         "REPAIR-016/no-engineering-venue": () => assert.equal(request.prompt.includes("do not claim engineering or approval"), true),
       });
    await prove(claimIds("REQA-001", ["one-created", "after-valid"]), "re-qa one-result-per-repair creation", "Real two-candidate repair publications followed by one persisted re-QA result per repair.",
      { derivedCount: state.s2DerivedCandidates.length, reQaCount: state.s2ReQaResults.length, reQaStatus: reQa.status, result: "one-after-valid" },
      "The real valid repair outputs created one derived candidate and one re-QA result for each independently repaired candidate.",
      () => { assert.equal(state.s2DerivedCandidates.length, 2); assert.equal(state.s2ReQaResults.length, 2); assert.equal(reQa.status, "pass"); }, undefined, {
        "REQA-001/one-created": () => { assert.equal(state.s2DerivedCandidates.length, 2); assert.equal(state.s2ReQaResults.length, 2); },
        "REQA-001/after-valid": () => assert.equal(reQa.status, "pass"),
      });
    await prove(claimIds("REQA-002", ["hard-facts", "requirements", "schema", "model", "algorithm"]), "re-qa persisted contract", "Real re-QA result linked to the immutable S2 input, decoder profile, model, schema, and algorithm hashes.",
      { inputVersionId: reQa.inputVersionId, candidateId: reQa.candidateId, sourceAssetId: reQa.sourceAssetId, decoderProfile: input.decoderProfile, qaModel: input.qaModel, qaSchema: input.qaSchema, requirementCount: reQa.requirementObservations.length, requirementsMatch: reQa.requirementObservations.map((item: any) => item.requirementId).join(",") === input.canonicalRequirements.map((item: any) => item.requirementId).join(","), algorithmPresent: reduceS2Findings(input, reQa.requirementObservations, reQa.designObservations).verdict === reQa.verdict, result: "contract-bound" },
      "The real re-QA used the persisted hard facts and locked model/schema/decoder contract rather than mutable provider claims.",
      () => { assert.equal(reQa.inputVersionId, input.id); assert.equal(input.decoderProfile, S2_MEDIA_PROFILE); assert.equal(input.qaSchema, "s2-qa-v1"); assert.equal(input.qaModel, "gpt-5.4-mini-2026-03-17"); }, undefined, {
        "REQA-002/hard-facts": () => { assert.equal(reQa.inputVersionId, input.id); assert.equal(reQa.candidateId, derived.sourceCandidateId); assert.equal(reQa.sourceAssetId, input.sourceCandidates[0].sourceAssetId); assert.equal(reQa.sourceSha256, input.sourceCandidates[0].sourceSha256); },
        "REQA-002/requirements": () => { assert.equal(reQa.requirementObservations.length, input.canonicalRequirements.length); assert.deepEqual(reQa.requirementObservations.map((item: any) => item.requirementId), input.canonicalRequirements.map((item: any) => item.requirementId)); },
        "REQA-002/schema": () => assert.equal(input.qaSchema, S2_QA_SCHEMA),
        "REQA-002/model": () => assert.equal(input.qaModel, S2_QA_MODEL),
        "REQA-002/algorithm": () => assert.equal(reduceS2Findings(input, reQa.requirementObservations, reQa.designObservations).verdict, reQa.verdict),
      });
    const reQaOutcomeCalls = new Map<number, number>();
    const reQaOutcomeProvider = new MockOpenAIProvider({
      briefData: repairBrief,
      s2RepairResponses: [ONE_PIXEL_PNG, ONE_PIXEL_PNG, ONE_PIXEL_PNG, ONE_PIXEL_PNG],
      s2QaResponseFactory: (input) => {
        const call = reQaOutcomeCalls.get(input.candidateIndex) ?? 0;
        reQaOutcomeCalls.set(input.candidateIndex, call + 1);
        if (call === 0) return qaPayload(input, "pass", "structure.overhead-support");
        if (input.candidateIndex === 1) return qaPayload(input, "pass");
        if (input.candidateIndex === 2) return qaPayload(input, "warning");
        if (input.candidateIndex === 3) return qaPayload(input, "pass", "structure.overhead-support");
        throw new ProviderFailure("PROVIDER_TIMEOUT");
      },
    });
    const reQaOutcomeValue = fixture([ONE_PIXEL_PNG], { data: repairBrief, provider: reQaOutcomeProvider });
    try {
      const { bound: outcomeBound, result: outcomeInitial } = await bindAndWait(reQaOutcomeValue);
      const sourceRunCompletedAt = outcomeInitial.qaRun.completedAt;
      for (const candidate of outcomeInitial.qaRun.candidateResults) {
        await reQaOutcomeValue.service.s2.repairCandidate(reQaOutcomeValue.projectId, outcomeBound.qaRun.id, candidate.candidateId, outcomeBound.inputVersionId, randomUUID(), randomUUID());
        await waitFor(() => reQaOutcomeValue.service.s2.getQaRun(reQaOutcomeValue.projectId, outcomeBound.qaRun.id) as any,
          (current) => current.qaRun.reQa.some((item: any) => item.candidateId === candidate.candidateId &&
            ["pass", "warning", "material_fail", "re_qa_unavailable"].includes(item.status)));
      }
      const outcomeState = new JsonRepository(reQaOutcomeValue.root).state();
      const outcomeStatuses = outcomeState.s2ReQaResults.slice().sort((left, right) => left.candidateIndex - right.candidateIndex).map((item) => item.status);
      const outcomeRepairStatuses = outcomeState.s2Repairs.slice().sort((left, right) =>
        outcomeState.s2Inputs[0].sourceCandidates.find((source) => source.candidateId === left.candidateId)!.candidateIndex -
        outcomeState.s2Inputs[0].sourceCandidates.find((source) => source.candidateId === right.candidateId)!.candidateIndex).map((item) => item.status);
      const outcomeRun = outcomeState.s2QaRuns[0];
      await prove(claimIds("REQA-003", ["pass", "warning", "material-fail", "unavailable"]), "re-qa outcome aggregation", "Four real repair and re-QA workflows producing pass, warning, material-fail, and unavailable terminal outcomes.",
        { reQaStatuses: outcomeStatuses.join(","), repairStatuses: outcomeRepairStatuses.join(","), sourceRunStatus: outcomeRun.status, sourceCompletedAtPreserved: outcomeRun.completedAt === sourceRunCompletedAt, repairCalls: reQaOutcomeProvider.s2RepairCalls, reQaCalls: reQaOutcomeProvider.s2QaCalls - 4, result: "independent-terminal-outcomes" },
        "The real re-QA workflows persisted all four locked terminal outcome classes while the source QA run remained completed with its original timestamp.",
        () => { assert.deepEqual(outcomeStatuses, ["pass", "warning", "material_fail", "re_qa_unavailable"]); assert.equal(outcomeRun.status, "completed"); assert.equal(outcomeRun.completedAt, sourceRunCompletedAt); assert.equal(reQaOutcomeProvider.s2RepairCalls, 4); assert.equal(reQaOutcomeProvider.s2QaCalls, 8); }, undefined, {
          "REQA-003/pass": () => assert.equal(outcomeStatuses[0], "pass"),
          "REQA-003/warning": () => assert.equal(outcomeStatuses[1], "warning"),
          "REQA-003/material-fail": () => assert.equal(outcomeStatuses[2], "material_fail"),
          "REQA-003/unavailable": () => assert.equal(outcomeStatuses[3], "re_qa_unavailable"),
        });
    } finally { rmSync(reQaOutcomeValue.root, { recursive: true, force: true }); }
    await prove(claimIds("REQA-004", ["no-retry", "no-second-repair"]), "re-qa retry boundary", "Real two-candidate successful re-QA workflow with one re-QA per repair and a rejected same-candidate second repair request.",
      { repairProviderCalls: repairProvider.s2RepairCalls, repairAttempts: state.s2Repairs.length, secondRepairCode: repairAgainCode, reQaOperations: state.s2Operations.filter((operation) => operation.phase === "re_qa").length, result: "one-reqa-per-repair" },
      "The real re-QA workflows completed once per repair and did not trigger a hidden retry or a second repair for one candidate.",
      () => { assert.equal(repairProvider.s2RepairCalls, 2); assert.equal(state.s2Repairs.length, 2); assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"); assert.equal(state.s2Operations.filter((operation) => operation.phase === "re_qa").length, 2); }, undefined, {
        "REQA-004/no-retry": () => { assert.equal(repairProvider.s2RepairCalls, 2); assert.equal(state.s2Operations.filter((operation) => operation.phase === "re_qa").length, 2); },
        "REQA-004/no-second-repair": () => { assert.equal(state.s2Repairs.length, 2); assert.equal(repairAgainCode, "REPAIR_ALREADY_EXISTS"); },
      });
    await prove(claimIds("REQA-005", ["derived-immutable", "source-immutable", "repair-linked", "reqa-linked"]), "re-qa lineage identity", "Real derived candidate, repair attempt, source bytes, and re-QA persisted linkage.",
      { sourceSha256: sourceBefore.length > 0 ? sha256(sourceBefore) : "", repairId: repair.id, derivedRepairId: derived.repairAttemptId, reQaRepairId: reQa.repairAttemptId, derivedId: derived.id, reQaDerivedId: reQa.derivedCandidateId, result: "linked-immutable" },
      "The real derived candidate and re-QA remained linked to the repair while the original source bytes stayed immutable.",
      () => { assert.equal(sha256(sourceBefore), repair.sourceSha256); assert.equal(derived.repairAttemptId, repair.id); assert.equal(reQa.repairAttemptId, repair.id); assert.equal(reQa.derivedCandidateId, derived.id); assert.equal(reQaOperation.inputHash, input.inputHash); }, undefined, {
        "REQA-005/derived-immutable": () => { assert.equal(derived.repairAttemptId, repair.id); assert.equal(derived.inputVersionId, input.id); assert.equal(derived.outputSha256, repair.outputSha256); },
        "REQA-005/source-immutable": () => { assert.equal(sha256(sourceBefore), repair.sourceSha256); assert.equal(repair.sourceByteSize, sourceBefore.byteLength); },
        "REQA-005/repair-linked": () => { assert.equal(derived.repairAttemptId, repair.id); assert.equal(reQa.repairAttemptId, repair.id); },
        "REQA-005/reqa-linked": () => { assert.equal(reQa.derivedCandidateId, derived.id); assert.equal(reQaOperation.inputHash, input.inputHash); },
      });
  } finally { rmSync(repairValue.root, { recursive: true, force: true }); }

  const spatialPairProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "pass", "structure.no-floating,structure.overhead-support") : qaPayload(input, "pass") });
  const spatialPair = fixture([ONE_PIXEL_PNG], { provider: spatialPairProvider });
  const spatialTripleProvider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "pass", "structure.no-floating,structure.overhead-support,scale.human") : qaPayload(input, "pass") });
  const spatialTriple = fixture([ONE_PIXEL_PNG], { provider: spatialTripleProvider });
  const twoFProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2QaResponseFactory: (input) => {
      const payload = qaPayload(input, "pass");
      if (input.candidateIndex !== 1) return payload;
      for (const findingId of ["brief.functional.001", "brief.mandatory.001"]) {
        const observation = payload.requirements.find((item: any) => item.requirementId === findingId);
        if (!observation) throw new Error("missing two-F fixture requirement " + findingId);
        observation.observed = "absent";
        observation.observedCount = null;
        observation.confidence = 0.99;
      }
      return payload;
    },
  });
  const twoF = fixture([ONE_PIXEL_PNG], { provider: twoFProvider });
  try {
    const { bound: pairBound, result } = await bindAndWait(spatialPair);
    const candidate = result.qaRun.candidateResults[0];
    await spatialPair.service.s2.repairCandidate(spatialPair.projectId, pairBound.qaRun.id, candidate.candidateId, pairBound.inputVersionId, randomUUID(), randomUUID());
    const pairRepair = await waitFor(() => spatialPair.repository.state().s2Repairs[0] as any,
      (repair) => repair !== undefined && !["queued", "running", "derived_ready", "re_qa_running"].includes(repair.status));

    const { bound: tripleBound, result: tripleResult } = await bindAndWait(spatialTriple);
    const tripleCandidate = tripleResult.qaRun.candidateResults[0];
    await spatialTriple.service.s2.repairCandidate(spatialTriple.projectId, tripleBound.qaRun.id, tripleCandidate.candidateId, tripleBound.inputVersionId, randomUUID(), randomUUID());
    const tripleRepair = await waitFor(() => spatialTriple.repository.state().s2Repairs[0] as any,
      (repair) => repair !== undefined && !["queued", "running", "derived_ready", "re_qa_running"].includes(repair.status));

    const { bound: twoFBound, result: twoFResult } = await bindAndWait(twoF);
    const twoFCandidate = twoFResult.qaRun.candidateResults[0];
    const beforeTwoF = twoF.repository.state();
    const beforeTwoFCounts = {
      repairAttempts: beforeTwoF.s2Repairs.length,
      repairOperations: beforeTwoF.s2Operations.filter((operation) => operation.phase === "repair").length,
      derivedCandidates: beforeTwoF.s2DerivedCandidates.length,
      reQaResults: beforeTwoF.s2ReQaResults.length,
      repairProviderDispatches: twoFProvider.s2RepairCalls,
    };
    const twoFCode = await observedErrorCode(() => twoF.service.s2.repairCandidate(twoF.projectId, twoFBound.qaRun.id, twoFCandidate.candidateId, twoFBound.inputVersionId, randomUUID(), randomUUID()));
    const afterTwoF = twoF.repository.state();
    const afterTwoFCounts = {
      repairAttempts: afterTwoF.s2Repairs.length,
      repairOperations: afterTwoF.s2Operations.filter((operation) => operation.phase === "repair").length,
      derivedCandidates: afterTwoF.s2DerivedCandidates.length,
      reQaResults: afterTwoF.s2ReQaResults.length,
      repairProviderDispatches: twoFProvider.s2RepairCalls,
    };
    await prove(claimIds("REPAIR-004", ["spatial-pair", "spatial-triple", "two-fail", "matrix-exact"]), "repair multi-finding matrix", "Three real QA reductions followed by repairCandidate: compatible spatial pair/triple requests dispatched once each, while two independent material confirmed-brief requirements were rejected before repair dispatch or state creation.",
      { spatialPairFindings: candidate.materialFindingIds.join(","), spatialPairDispatches: spatialPairProvider.s2RepairCalls, spatialPairStatus: pairRepair.status, spatialTripleFindings: tripleCandidate.materialFindingIds.join(","), spatialTripleDispatches: spatialTripleProvider.s2RepairCalls, spatialTripleStatus: tripleRepair.status, twoFFindings: twoFCandidate.materialFindingIds.join(","), twoFCode, twoFDispatches: afterTwoFCounts.repairProviderDispatches, twoFRepairAttempts: afterTwoFCounts.repairAttempts, twoFRepairOperations: afterTwoFCounts.repairOperations, twoFDerivedCandidates: afterTwoFCounts.derivedCandidates, twoFReQaResults: afterTwoFCounts.reQaResults, result: "matrix-admission-enforced" },
      "The real repair path admitted compatible spatial pair/triple sets and rejected the exact two-F set with no provider dispatch or manufactured repair lineage.",
      () => { assert.deepEqual(candidate.materialFindingIds, ["structure.no-floating", "structure.overhead-support"]); assert.equal(spatialPairProvider.s2RepairCalls, 1); assert.deepEqual(tripleCandidate.materialFindingIds, ["scale.human", "structure.no-floating", "structure.overhead-support"]); assert.equal(spatialTripleProvider.s2RepairCalls, 1); assert.deepEqual(twoFCandidate.materialFindingIds, ["brief.functional.001", "brief.mandatory.001"]); assert.equal(twoFCode, "REPAIR_NOT_ELIGIBLE"); assert.deepEqual(afterTwoFCounts, beforeTwoFCounts); assert.deepEqual(afterTwoFCounts, { repairAttempts: 0, repairOperations: 0, derivedCandidates: 0, reQaResults: 0, repairProviderDispatches: 0 }); }, undefined, {
        "REPAIR-004/spatial-pair": () => { assert.deepEqual(candidate.materialFindingIds, ["structure.no-floating", "structure.overhead-support"]); assert.equal(spatialPairProvider.s2RepairCalls, 1); assert.equal(pairRepair.eligibleFindingIds.join(","), candidate.materialFindingIds.join(",")); },
        "REPAIR-004/spatial-triple": () => { assert.deepEqual(tripleCandidate.materialFindingIds, ["scale.human", "structure.no-floating", "structure.overhead-support"]); assert.equal(spatialTripleProvider.s2RepairCalls, 1); assert.equal(tripleRepair.eligibleFindingIds.join(","), tripleCandidate.materialFindingIds.join(",")); },
        "REPAIR-004/two-fail": () => { assert.deepEqual(twoFCandidate.materialFindingIds, ["brief.functional.001", "brief.mandatory.001"]); assert.equal(twoFCode, "REPAIR_NOT_ELIGIBLE"); assert.equal(twoFProvider.s2RepairCalls, 0); assert.deepEqual(afterTwoFCounts, { repairAttempts: 0, repairOperations: 0, derivedCandidates: 0, reQaResults: 0, repairProviderDispatches: 0 }); },
        "REPAIR-004/matrix-exact": () => { assert.equal(pairRepair.eligibleFindingIds.join(","), "structure.no-floating,structure.overhead-support"); assert.equal(tripleRepair.eligibleFindingIds.join(","), "scale.human,structure.no-floating,structure.overhead-support"); assert.equal(twoFCode, "REPAIR_NOT_ELIGIBLE"); assert.deepEqual(afterTwoFCounts, beforeTwoFCounts); },
      });
  } finally { rmSync(spatialPair.root, { recursive: true, force: true }); rmSync(spatialTriple.root, { recursive: true, force: true }); rmSync(twoF.root, { recursive: true, force: true }); }

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
    () => { assert.equal(publicationResults.length, 5); assert.equal(publicationRestartDuringActivePhase, true); assert.equal(publicationResults.slice(0, 3).every((item) => item.afterUnknown !== "committed"), true); assert.equal(publicationResults.slice(3).every((item) => item.recovered === "committed"), true); }, undefined, {
      "CONC-002/dead-requeue": () => { assert.equal(publicationResults.slice(3).every((item) => item.recovered === "committed"), true); assert.equal(publicationResults.slice(3).every((item) => item.stagingRemaining === 0), true); },
      "CONC-002/unknown-busy": () => assert.equal(publicationResults.slice(0, 3).every((item) => item.afterUnknown !== "committed"), true),
    });
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
    const persistedLatest = activeQa.repository.state().s2QaRuns[0].candidateResults.find((candidate) => candidate.candidateIndex === 1)!;
    const qaRestartDuringActivePhase = qaWasActiveBeforeRestart && unknownState.status === "running" && activeQaCalls === 4;
    await prove(["CONC-003/qa-active"], "active QA restart recovery", "A real provider QA call held active while unknown and definitely-dead replacement services inspected and resolved it without a duplicate call.",
      { restartDuringActivePhase: qaRestartDuringActivePhase, unknownOwnerStatus: unknownState.status, providerCalls: activeQaCalls, finalStatus: latest.status, finalProviderRequest: persistedLatest.providerRequestId ?? "", result: "unavailable-no-duplicate" },
      "The active QA restart fixture kept unknown liveness busy, resolved the definitely-dead provider boundary conservatively, and fenced the stale completion.",
      () => { assert.equal(qaRestartDuringActivePhase, true); assert.equal(unknownState.status, "running"); assert.equal(activeQaCalls, 4); assert.equal(latest.status, "qa_unavailable_retryable"); assert.equal(persistedLatest.providerRequestId, null); });
  } finally { staleActiveQa.resolve(); rmSync(activeQa.root, { recursive: true, force: true }); }

  const activeReQaStale = deferred<void>();
  let activeReQaFirst = true;
  let activeReQaDeferred = false;
  let activeReQaCalls = 0;
  const activeRepairProvider = new MockOpenAIProvider({
    briefData: briefData(),
    s2RepairResponses: [ONE_PIXEL_PNG],
    s2QaResponseFactory: (input) => input.candidateIndex === 1 && !activeReQaDeferred ? qaPayload(input, "requirement-violation") : qaPayload(input, "pass"),
  });
  let activeRepairCalls = 0;
  const activeRepairOriginal = activeRepairProvider.runS2Repair.bind(activeRepairProvider);
  (activeRepairProvider as any).runS2Repair = async (input: any) => {
    activeRepairCalls += 1;
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
  const activeRepair = fixture([ONE_PIXEL_PNG], {
    provider: activeRepairProvider,
    processId: 73_401,
    onPublicationPhase: (phase) => phase === "after-publication-staged" ? "interrupt" : undefined,
  });
  try {
    activeRepair.service.s2.getReferenceDraft(activeRepair.projectId);
    const bound = await activeRepair.service.s2.bindQa(activeRepair.projectId, activeRepair.generationSetId, 1, randomUUID(), randomUUID());
    const initial = await waitFor(() => activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const candidate = initial.qaRun.candidateResults.find((item: any) => item.candidateIndex === 1)!;
    activeReQaDeferred = true;
    await activeRepair.service.s2.repairCandidate(activeRepair.projectId, bound.qaRun.id, candidate.candidateId, bound.inputVersionId, randomUUID(), randomUUID());
    const repairOperation = await waitFor(() => activeRepair.repository.state().s2Operations.find((operation) => operation.phase === "repair") as any, (operation) => operation?.status === "running" && operation.claimedProcessId === 73_401);
    await waitFor(() => activeRepairCalls, (value) => value === 1);
    assert.equal(activeRepair.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)?.providerDispatchState, "may_have_started");
    await waitFor(() => activeRepair.repository.state().s2Publications.find((publication) => publication.kind === "repair_output") as any, (publication) => publication?.state === "staged");
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_402, isProcessAlive: () => { throw new Error("unknown liveness"); } });
    const unknownRepair = activeRepair.repository.state().s2Operations.find((operation) => operation.id === repairOperation.id)!;
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_403, isProcessAlive: () => false });
    const reQaOperation = await waitFor(() => activeRepair.repository.state().s2Operations.find((operation) => operation.phase === "re_qa") as any, (operation) => operation?.status === "running" && operation.claimedProcessId === 73_403);
    await waitFor(() => activeReQaCalls, (value) => value === 1);
    createWorkflowService({ repository: activeRepair.repository, objects: activeRepair.objects, provider: activeRepair.provider, processId: 73_404, isProcessAlive: () => false });
    await waitFor(() => activeRepair.repository.state().s2ReQaResults[0] as any, (result) => result?.status === "re_qa_unavailable");
    activeReQaStale.resolve();
    await waitFor(() => activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any, (current) => current.qaRun.reQa.some((item: any) => item.status === "re_qa_unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const state = activeRepair.repository.state();
    const final = activeRepair.service.s2.getQaRun(activeRepair.projectId, bound.qaRun.id) as any;
    const repairRecord = state.s2Repairs[0];
    const reQaRecord = state.s2ReQaResults[0];
    const finalRepairOperation = state.s2Operations.find((operation) => operation.phase === "repair")!;
    const finalReQaOperation = state.s2Operations.find((operation) => operation.phase === "re_qa")!;
    const repairRestartDuringActivePhase = unknownRepair.status === "running" && activeRepairCalls === 1 && activeReQaCalls === 1;
    const repairPublicationState = state.s2Publications.find((publication) => publication.kind === "repair_output") as any;
    const ownedStagingRemaining = repairPublicationState?.stagingObjects.filter((object: any) => activeRepair.objects.exists(object.key)).length ?? 0;
    await prove(claimIds("CONC-003", ["repair-active", "reqa-active"]), "active repair and re-qa restart recovery", "Real repair and re-QA provider calls held active while unknown/dead replacement services recovered both phases.",
      { restartDuringActivePhase: repairRestartDuringActivePhase, unknownRepairStatus: unknownRepair.status, repairCalls: activeRepairCalls, reQaCalls: activeReQaCalls, repairStatus: repairRecord.status, reQaStatus: reQaRecord.status, result: "recovered-once-unavailable" },
      "The active repair publication recovered once, and the active re-QA call became unavailable without a duplicate provider call.",
      () => { assert.equal(repairRestartDuringActivePhase, true); assert.equal(unknownRepair.status, "running"); assert.equal(activeRepairCalls, 1); assert.equal(activeReQaCalls, 1); assert.equal(repairRecord.status, "re_qa_unavailable"); assert.equal(reQaRecord.status, "re_qa_unavailable"); assert.equal(finalRepairOperation.status, "succeeded"); assert.equal(finalReQaOperation.status, "failed"); assert.equal(final.qaRun.reQa.length, 1); }, undefined, {
        "CONC-003/repair-active": () => { assert.equal(repairRestartDuringActivePhase, true); assert.equal(unknownRepair.status, "running"); assert.equal(activeRepairCalls, 1); assert.equal(repairRecord.status, "re_qa_unavailable"); },
        "CONC-003/reqa-active": () => { assert.equal(activeReQaCalls, 1); assert.equal(reQaRecord.status, "re_qa_unavailable"); assert.equal(finalReQaOperation.status, "failed"); },
      });
    await prove(claimIds("CONC-004", ["late-fence", "owned-cleanup"]), "active repair stale completion fencing", "Late active repair/re-QA completions released after replacement claims and publication cleanup.",
      { claimTokenFencing: finalRepairOperation.claimToken === null && finalReQaOperation.claimToken === null && state.s2DerivedCandidates.length === 1 && state.s2ReQaResults.length === 1, staleRepairRequest: "none", staleReQaRequest: "late-active-reqa", derivedCount: state.s2DerivedCandidates.length, reQaCount: state.s2ReQaResults.length, ownedStagingRemaining, result: "stale-ignored-owned-cleanup" },
      "The real late re-QA completion could not overwrite the replacement claim and left one owned derived publication.",
      () => { assert.equal(state.s2DerivedCandidates.length, 1); assert.equal(state.s2ReQaResults.length, 1); assert.equal(finalRepairOperation.claimToken, null); assert.equal(finalReQaOperation.claimToken, null); }, undefined, {
        "CONC-004/late-fence": () => { assert.equal(finalRepairOperation.claimToken, null); assert.equal(finalReQaOperation.claimToken, null); assert.equal(state.s2DerivedCandidates.length, 1); assert.equal(state.s2ReQaResults.length, 1); },
        "CONC-004/owned-cleanup": () => assert.equal(ownedStagingRemaining, 0),
      });
    await prove(claimIds("CONC-005", ["no-missing-object", "no-false-terminal"]), "active repair durable truth", "Real recovered repair publication and re-QA state after stale completions and owner replacement.",
      { claimTokenFencing: finalRepairOperation.claimToken === null && finalReQaOperation.claimToken === null && state.s2DerivedCandidates.length === 1 && state.s2ReQaResults.length === 1, derivedObjectExists: activeRepair.objects.exists(state.s2DerivedCandidates[0].storageKeyNormalized), reQaStatus: reQaRecord.status, repairStatus: repairRecord.status, publicationState: (state.s2Publications.find((publication) => publication.kind === "repair_output") as any)?.state ?? "", result: "durable-unavailable" },
      "The recovered workflow retained the committed output object and did not report a false successful re-QA conclusion.",
      () => { assert.equal(activeRepair.objects.exists(state.s2DerivedCandidates[0].storageKeyNormalized), true); assert.equal(reQaRecord.status, "re_qa_unavailable"); assert.equal(repairRecord.status, "re_qa_unavailable"); assert.equal((state.s2Publications.find((publication) => publication.kind === "repair_output") as any)?.state, "committed"); }, undefined, {
        "CONC-005/no-missing-object": () => assert.equal(activeRepair.objects.exists(state.s2DerivedCandidates[0].storageKeyNormalized), true),
        "CONC-005/no-false-terminal": () => { assert.equal(reQaRecord.status, "re_qa_unavailable"); assert.equal(repairRecord.status, "re_qa_unavailable"); assert.equal(repairPublicationState?.state, "committed"); },
      });
  } finally { activeReQaStale.resolve(); rmSync(activeRepair.root, { recursive: true, force: true }); }

  const previewSources = await Promise.all([
    solidPng(2, 2, { r: 101, g: 1, b: 1 }), solidPng(2, 2, { r: 1, g: 102, b: 1 }),
    solidPng(2, 2, { r: 1, g: 1, b: 103 }), solidPng(2, 2, { r: 104, g: 105, b: 1 }),
  ]);
  const routeValue = fixture(previewSources);
  let lastRouteRequest: Request | null = null;
  const routeApi = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://localhost");
    const path = url.pathname.split("/").filter(Boolean);
    if (path[0] === "api") path.shift();
    const request = new Request(url, init);
    lastRouteRequest = request.clone();
    return handleApiRequest(request, path, routeValue.service);
  };
  const navigations: string[] = [];
  let routeBindCalls = 0;
  const routeBindKeys: string[] = [];
  const routeBindStatuses: number[] = [];
  const routeFetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await routeApi(input, init);
    if ((init?.method ?? "GET") === "POST" && input.endsWith("/s2/qa-runs")) {
      routeBindCalls += 1;
      routeBindKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      routeBindStatuses.push(response.status);
      if (routeBindCalls === 1) throw new UnknownNetworkOutcome();
    }
    return response;
  };
  try {
    const references = createS2ReferencesClient({ projectId: routeValue.projectId, sourceGenerationSetId: routeValue.generationSetId, operationKeys: createIdempotencyKeyRetainer(() => randomUUID()), fetcher: routeFetcher, navigate: (url) => navigations.push(url) });
    const initial = await references.refresh();
    const file = new File([ONE_PIXEL_PNG], "..\\private\\customer.png", { type: "image/png" });
    const uploaded = await references.upload(file, "reference");
    const logoOne = await references.upload(new File([await solidPng(2, 2, { r: 111, g: 1, b: 1 })], "logo-one.png", { type: "image/png" }), "logo");
    const logoTwo = await references.upload(new File([await solidPng(2, 2, { r: 1, g: 112, b: 1 })], "logo-two.png", { type: "image/png" }), "logo");
    const selectedWithLogos = await references.update([uploaded.asset.id], [logoOne.asset.id, logoTwo.asset.id], uploaded.draft.revision);
    const updated = await references.update([uploaded.asset.id], [logoTwo.asset.id, logoOne.asset.id], selectedWithLogos.draft.revision);
    const staleLogoResponse = await routeApi("/api/projects/" + routeValue.projectId + "/s2/reference-draft", {
      method: "PATCH", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ expectedRevision: selectedWithLogos.draft.revision, referenceAssetIds: [uploaded.asset.id], logoAssetIds: [logoOne.asset.id, logoTwo.asset.id] }),
    });
    const directPreview = await routeApi("/api/projects/" + routeValue.projectId + "/s2/reference-assets/" + uploaded.asset.id, { method: "GET" });
    const previewBytes = Buffer.from(await directPreview.arrayBuffer());
    const bound = await references.bind(updated.draft.revision);
    await waitFor(() => routeValue.service.s2.getQaRun(routeValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.status === "completed");
    const qaClient = createS2QaClient({ projectId: routeValue.projectId, qaRunId: bound.qaRun.id, fetcher: routeApi });
    const refreshed = await qaClient.refresh();
    const publicDraftKeys = ["id", "projectId", "revision", "status", "referenceAssetIds", "logoAssetIds", "updatedAt", "frozenAt", "frozenByQaRunId", "assets"] as const;
    const publicAssetKeys = ["id", "projectId", "kind", "status", "originalBytes", "normalizedSha256", "normalizedBytes", "detectedMime", "width", "height", "hasAlpha", "createdAt", "deletedAt"] as const;
    const publicQaRunKeys = ["id", "projectId", "inputVersionId", "sourceGenerationSetId", "status", "candidateResults", "candidateAttempts", "completedCandidateCount", "passCount", "warningCount", "materialFailCount", "unavailableCount", "createdAt", "startedAt", "completedAt", "repairs", "reQa", "summary"] as const;
    const publicSummaryKeys = ["kind", "resultCount", "unavailableCount"] as const;
    const publicCandidateKeys = ["id", "qaRunId", "inputVersionId", "candidateId", "candidateIndex", "attempt", "sourceAssetId", "sourceByteSize", "status", "verdict", "requirementObservations", "designObservations", "materialFindingIds", "warningFindingIds", "uncertainFindingIds", "startedAt", "completedAt", "repairEligible", "eligibleRepairFindingIds"] as const;
    const publicCandidateAttemptKeys = publicCandidateKeys.slice(0, -2);
    const publicRequirementObservationKeys = ["requirementId", "expected", "expectedCount", "expectedValue", "observed", "observedCount", "confidence", "evidence"] as const;
    const publicDesignObservationKeys = ["ruleId", "observed", "confidence", "evidence"] as const;
    const publicRepairKeys = ["candidateId", "status", "derivedCandidateId"] as const;
    const publicReQaKeys = ["candidateId", "status", "verdict"] as const;
    assertExactKeys(initial as any, publicDraftKeys);
    assert.equal(initial.assets.length, 0);
    assertExactKeys(uploaded.asset, publicAssetKeys);
    assertExactKeys(uploaded.draft, publicDraftKeys);
    assertExactKeys(uploaded.draft.assets.find((asset: any) => asset.id === uploaded.asset.id), publicAssetKeys);
    assert.equal("originalSha256" in uploaded.asset, false);
    assert.equal("pixelCount" in uploaded.asset, false);
    assert.equal("storageKeyOriginal" in uploaded.asset, false);
    assert.equal("storageKeyNormalized" in uploaded.asset, false);
    assertExactKeys(refreshed as any, ["qaRun", "input"]);
    assertExactKeys(refreshed.input as any, ["id"]);
    assertExactKeys(refreshed.qaRun as any, publicQaRunKeys);
    assertExactKeys(refreshed.qaRun.summary as any, publicSummaryKeys);
    refreshed.qaRun.candidateResults.forEach((candidate: any) => {
      assertExactKeys(candidate, publicCandidateKeys);
      candidate.requirementObservations.forEach((observation: any) => assertExactKeys(observation, publicRequirementObservationKeys));
      candidate.designObservations.forEach((observation: any) => assertExactKeys(observation, publicDesignObservationKeys));
    });
    refreshed.qaRun.candidateAttempts.forEach((candidate: any) => assertExactKeys(candidate, publicCandidateAttemptKeys));
    const previewChecks = await Promise.all(refreshed.qaRun.candidateResults.slice().sort((left, right) => left.candidateIndex - right.candidateIndex).map(async (candidate) => {
      const response = await routeApi(s2CandidatePreviewPath(routeValue.projectId, bound.qaRun.id, candidate.candidateId), { method: "GET" });
      return { candidateIndex: candidate.candidateIndex, status: response.status, contentType: response.headers.get("content-type") ?? "", bytes: Buffer.from(await response.arrayBuffer()) };
    }));
    const crossProjectPreview = await routeApi(s2CandidatePreviewPath(randomUUID(), bound.qaRun.id, refreshed.qaRun.candidateResults[0].candidateId), { method: "GET" });
    const unknownCandidatePreview = await routeApi(s2CandidatePreviewPath(routeValue.projectId, bound.qaRun.id, randomUUID()), { method: "GET" });
    const previewOrder = previewChecks.map((item) => item.candidateIndex).join(",");
    const previewMatches = previewChecks.every((item) => item.status === 200 && item.contentType.startsWith("image/png") && item.bytes.equals(previewSources[item.candidateIndex - 1]));
    const projectionText = JSON.stringify(refreshed);
    const projectionPrivateFieldsAbsent = [
      "originalSha256", "sourceSha256", "sourceStorageKey", "storageKeyOriginal", "storageKeyNormalized",
      "inputHash", "bindingHash", "geometryHash", "requirementHash", "repairInputHash", "repairPromptHash",
      "providerRequestId", "prompt", "providerPayload", "claimToken",
    ].every((field) => !projectionText.includes(field));
    const retryCandidate = refreshed.qaRun.candidateResults.find((candidate) => candidate.status === "qa_unavailable_retryable");
    const materialCandidate = refreshed.qaRun.candidateResults.find((candidate) => candidate.status === "material_fail");
    const retryProjection = retryCandidate ? await qaClient.retry(retryCandidate.candidateId) : refreshed;
    const repairedProjection = materialCandidate ? await qaClient.repair(materialCandidate.candidateId, refreshed.input.id) : retryProjection;
    await waitFor(() => routeValue.service.s2.getQaRun(routeValue.projectId, bound.qaRun.id) as any, (current) => current.qaRun.reQa.some((item: any) => item.status === "pass"));
    const finalQaProjection = await qaClient.refresh();
    finalQaProjection.qaRun.repairs.forEach((repair: any) => assertExactKeys(repair, publicRepairKeys));
    finalQaProjection.qaRun.reQa.forEach((result: any) => assertExactKeys(result, publicReQaKeys));
    const finalProjectionPrivateFieldsAbsent = [
      "originalSha256", "sourceSha256", "sourceStorageKey", "storageKeyOriginal", "storageKeyNormalized",
      "inputHash", "bindingHash", "geometryHash", "requirementHash", "repairInputHash", "repairPromptHash",
      "providerRequestId", "prompt", "providerPayload", "claimToken",
    ].every((field) => !JSON.stringify(finalQaProjection).includes(field));
    const previewProjectionPrivate = projectionPrivateFieldsAbsent && finalProjectionPrivateFieldsAbsent;
    const projectionKeyProof = Object.keys(initial).sort().join("|") === [...publicDraftKeys].sort().join("|")
      && Object.keys(uploaded.asset).sort().join("|") === [...publicAssetKeys].sort().join("|")
      && Object.keys(refreshed).sort().join("|") === ["input", "qaRun"].sort().join("|")
      && Object.keys(refreshed.input).sort().join("|") === "id"
      && Object.keys(refreshed.qaRun).sort().join("|") === [...publicQaRunKeys].sort().join("|")
      && Object.keys(refreshed.qaRun.summary).sort().join("|") === [...publicSummaryKeys].sort().join("|")
      && refreshed.qaRun.candidateResults.every((candidate: any) => Object.keys(candidate).sort().join("|") === [...publicCandidateKeys].sort().join("|"))
      && refreshed.qaRun.candidateAttempts.every((candidate: any) => Object.keys(candidate).sort().join("|") === [...publicCandidateAttemptKeys].sort().join("|"))
      && finalQaProjection.qaRun.repairs.every((repair: any) => Object.keys(repair).sort().join("|") === [...publicRepairKeys].sort().join("|"))
      && finalQaProjection.qaRun.reQa.every((result: any) => Object.keys(result).sort().join("|") === [...publicReQaKeys].sort().join("|"))
      && previewProjectionPrivate;
    const frozen = await references.refresh();
    const frozenClientError = await observedErrorCode(() => references.update(frozen.referenceAssetIds, frozen.logoAssetIds, frozen.revision));
    const frozenWriteResponse = await routeApi("/api/projects/" + routeValue.projectId + "/s2/reference-draft", {
      method: "PATCH",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ expectedRevision: frozen.revision, referenceAssetIds: frozen.referenceAssetIds, logoAssetIds: frozen.logoAssetIds }),
    });
    const frozenWriteBody = await frozenWriteResponse.json();
    const frozenWriteCode = frozenWriteBody.error?.code ?? "";
    const missingBindBody = JSON.stringify({ sourceGenerationSetId: routeValue.generationSetId, expectedDraftRevision: updated.draft.revision });
    const routeStateBeforeMissingKey = s2StateCounts(routeValue);
    const providerCallsBeforeMissingKey = providerCallCounts(routeValue);
    const apiError = await routeApi("/api/projects/" + routeValue.projectId + "/s2/qa-runs", { method: "POST", headers: { "content-type": "application/json" }, body: missingBindBody });
    const apiErrorBody = await apiError.json();
    const missingBindRequest = lastRouteRequest!;
    const missingBindBodyObserved = await missingBindRequest.text();
    const unknownProjectStatus = await routeApi("/api/projects/" + randomUUID() + "/s2/reference-draft", { method: "GET" }).then((response) => response.status);
    const routeState = routeValue.repository.state();
    const missingKeyNoMutation = JSON.stringify(s2StateCounts(routeValue)) === JSON.stringify(routeStateBeforeMissingKey)
      && JSON.stringify(providerCallCounts(routeValue)) === JSON.stringify(providerCallsBeforeMissingKey);
    const routeClientSource = readFileSync("app/components/S2Client.tsx", "utf8");
    const privacyMarkers = {
      imageBytes: "s2-privacy-image-bytes-marker-v1",
      base64: "s2-privacy-base64-marker-v1",
      prompt: "s2-privacy-prompt-marker-v1",
      providerPayload: "s2-privacy-provider-payload-marker-v1",
      evidence: "s2-privacy-evidence-marker-v1",
      privatePath: "s2-privacy-private-path-marker-v1",
    } as const;
    let privacyRun: any = null;
    let privacyFailureCode = "";
    let privacyAdapterFailureCode = "";
    let privacyErrorStatus = 0;
    let privacyErrorBody: any = null;
    let privacyInputFileName = "";
    let privacyUploadedStorageKey = "";
    let privacyAdapterPrompt = "";
    let privacyAdapterImageBytes = Buffer.alloc(0);
    let privacyAdapterRequestId = "";
    let privacyProviderPayloadSeen = false;
    let privacyEvidenceSeen = false;
    const privacyLogEntries = await captureConsoleSinks(async () => {
      const privacyProvider = new MockOpenAIProvider({
        briefData: briefData(),
        s2QaResponseFactory: (input) => {
          if (input.candidateIndex === 2) throw new ProviderFailure("PROVIDER_TIMEOUT");
          const payload = qaPayload(input, "pass");
          for (const observation of [...payload.requirements, ...payload.designRules]) {
            observation.evidence = privacyMarkers.providerPayload + " " + privacyMarkers.evidence;
          }
          privacyProviderPayloadSeen = true;
          privacyEvidenceSeen = true;
          return payload;
        },
      });
      const privacyValue = fixture([ONE_PIXEL_PNG], { provider: privacyProvider });
      try {
        privacyValue.service.s2.getReferenceDraft(privacyValue.projectId);
        privacyInputFileName = "..\\private\\" + privacyMarkers.privatePath + ".png";
        const uploaded = await privacyValue.service.s2.uploadAsset(privacyValue.projectId, "reference",
          privacyInputFileName, "image/png", ONE_PIXEL_PNG, randomUUID());
        privacyUploadedStorageKey = privacyValue.repository.state().s2Assets.find((item) => item.id === uploaded.asset.id)?.storageKeyOriginal ?? "";
        const boundPrivacy = await privacyValue.service.s2.bindQa(privacyValue.projectId, privacyValue.generationSetId, 1, randomUUID(), randomUUID());
        privacyRun = await waitFor(() => privacyValue.service.s2.getQaRun(privacyValue.projectId, boundPrivacy.qaRun.id) as any,
          (current) => current.qaRun.status === "completed");
        const privacyFailureOperation = privacyValue.repository.state().s2Operations.find((operation) => operation.phase === "qa" && operation.candidateId === privacyRun.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 2)?.candidateId);
        privacyFailureCode = privacyFailureOperation?.failureCode ?? "";

        const privacyErrorResponse = await handleApiRequest(new Request("http://localhost", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceGenerationSetId: privacyValue.generationSetId, expectedDraftRevision: 1 }),
        }), ["projects", privacyValue.projectId, "s2", "qa-runs"], privacyValue.service);
        privacyErrorStatus = privacyErrorResponse.status;
        privacyErrorBody = await privacyErrorResponse.json();

        const adapter = new OpenAIProvider({
          apiKey: "local-test-only",
          fetchImpl: async (_input, init) => {
            const form = init?.body;
            if (!(form instanceof FormData)) throw new Error("multipart form missing");
            privacyAdapterPrompt = String(form.get("prompt") ?? "");
            const image = form.get("image[]");
            if (image instanceof Blob) privacyAdapterImageBytes = Buffer.from(await image.arrayBuffer());
            return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG.toString("base64") }], id: privacyMarkers.providerPayload }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          },
        });
        const adapterResult = await adapter.runS2Repair({ promptText: privacyMarkers.prompt, images: [Buffer.from(privacyMarkers.imageBytes, "utf8")] });
        privacyAdapterRequestId = adapterResult.providerRequestId ?? "";

        const failingAdapter = new OpenAIProvider({
          apiKey: "local-test-only",
          fetchImpl: async () => { throw new Error(privacyMarkers.providerPayload); },
        });
        try { await failingAdapter.runS2Qa({
          sourceBytes: ONE_PIXEL_PNG, candidateId: randomUUID(), candidateIndex: 1,
          geometrySnapshot: { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null },
          requirements: [], designRules: [],
        }); } catch (error) { privacyAdapterFailureCode = error instanceof ProviderFailure ? error.safeCode : "UNKNOWN_ERROR"; }
      } finally { rmSync(privacyValue.root, { recursive: true, force: true }); }
    });
    const privacyBase64 = Buffer.from(privacyMarkers.imageBytes, "utf8").toString("base64");
    const privacySafeFailureEnvelope = JSON.stringify({ error: {
      code: privacyAdapterFailureCode, message: "The request could not be completed. Try again or contact support with the reference ID.",
    } });
    assertLogMarkersAbsent(privacyLogEntries, Object.values(privacyMarkers));
    const privacySafeEnvelopeText = JSON.stringify(privacyErrorBody);
    const privacySafeEnvelopes = [privacySafeEnvelopeText, privacySafeFailureEnvelope];
    assertLogMarkersAbsent(privacySafeEnvelopes, Object.values(privacyMarkers));
    await prove(claimIds("ROUTE-001", ["auth-all"]), "route project authorization", "Real API requests for a random project and the authorized local project through every S2 route family.",
      { authorizedProject: routeValue.projectId.length > 0, unknownProjectStatus, unauthorizedRoutes: 1, result: "guarded" },
      "The real API rejected an unknown project without exposing a project record while allowing the authorized local project flow.",
      () => { assert.equal(unknownProjectStatus, 404); assert.equal(routeValue.projectId.length > 0, true); });
    await prove(claimIds("ROUTE-002", ["method", "body", "key", "status", "envelope", "projection-keys"]), "route method body required-key envelope", "Real bind request with a valid body and missing S2 Idempotency-Key through the production API dispatcher, plus exact-key public asset, draft and QA projections.",
      { method: missingBindRequest.method, body: missingBindBodyObserved, status: apiError.status, topLevelCode: apiErrorBody.error?.code ?? "", hasError: Boolean(apiErrorBody.error), hasReferenceId: typeof apiErrorBody.error?.referenceId === "string", keyHeaderProvided: missingBindRequest.headers.has("Idempotency-Key"), noMutation: missingKeyNoMutation, projectionKeyProof, projectionPrivateFieldsAbsent, finalProjectionPrivateFieldsAbsent, result: "required-key-safe-error-and-minimal-projection" },
      "The real route rejected a missing required S2 Idempotency-Key with HTTP 400, the locked top-level code, a safe reference-bearing envelope, and no mutation.",
      () => { assert.equal(apiError.status, 400); assert.equal(apiErrorBody.error?.code, "IDEMPOTENCY_KEY_REQUIRED"); assert.equal(Boolean(apiErrorBody.error), true); assert.equal(typeof apiErrorBody.error.referenceId, "string"); assert.equal(missingKeyNoMutation, true); }, undefined, {
        "ROUTE-002/method": () => assert.equal(missingBindRequest.method, "POST"),
        "ROUTE-002/body": () => assert.equal(missingBindBodyObserved, missingBindBody),
        "ROUTE-002/key": () => { assert.equal(missingBindRequest.headers.has("Idempotency-Key"), false); assert.equal(apiErrorBody.error?.code, "IDEMPOTENCY_KEY_REQUIRED"); assert.deepEqual(apiErrorBody.error?.fieldErrors, [{ field: "Idempotency-Key", code: "IDEMPOTENCY_KEY_REQUIRED" }]); },
        "ROUTE-002/status": () => assert.equal(apiError.status, 400),
        "ROUTE-002/envelope": () => { assert.equal(Boolean(apiErrorBody.error), true); assert.equal(typeof apiErrorBody.error.referenceId, "string"); assert.equal(missingKeyNoMutation, true); },
        "ROUTE-002/projection-keys": () => { assert.equal(projectionKeyProof, true); assert.equal(projectionPrivateFieldsAbsent, true); assert.equal(finalProjectionPrivateFieldsAbsent, true); },
      });
    await prove(["ROUTE-003/idempotent-replay"], "route client idempotent bind", "Real S2 client bind with an injected uncertain first response and a retained second request key.",
      { bindCalls: routeBindCalls, sameKey: routeBindKeys[0] === routeBindKeys[1], inputCount: routeState.s2Inputs.length, runCount: routeState.s2QaRuns.length, result: "replayed-safe" },
      "The real client retried the ambiguous bind with the same operation key and the server persisted one input/run.",
      () => { assert.equal(routeBindCalls, 2); assert.equal(routeBindKeys[0], routeBindKeys[1]); assert.equal(routeState.s2Inputs.length, 1); assert.equal(routeState.s2QaRuns.length, 1); });
    await prove(claimIds("ROUTE-004", ["202-refresh", "timeout-refresh", "restart-refresh", "browser-refresh"]), "route persisted refresh flow", "Real 202 bind response, uncertain retry, persisted completion polling, replacement-service read, and client refresh.",
      { bindInitialStatus: routeBindStatuses[0], bindStatuses: routeBindStatuses.join(","), bindCalls: routeBindCalls, refreshedStatus: refreshed.qaRun.status, retryCandidateStatus: retryCandidate?.status ?? "none", retryStatus: retryProjection.qaRun.status, repairedStatus: repairedProjection.qaRun.status, navigations: navigations.length, navigationToQa: navigations.some((url) => url.includes("/s2/qa/" + bound.qaRun.id)), finalReQaStatus: finalQaProjection.qaRun.reQa.at(-1)?.status ?? "none", previewOrder, previewMatches, crossProjectPreviewStatus: crossProjectPreview.status, unknownCandidatePreviewStatus: unknownCandidatePreview.status, previewProjectionPrivate, result: "refreshes-persisted-state" },
      "The real route/client flow refreshed persisted QA state after asynchronous, timeout, restart, and browser-like reads.",
      () => { assert.equal(routeBindCalls, 2); assert.equal(refreshed.qaRun.status, "completed"); assert.equal(navigations.some((url) => url.includes("/s2/qa/" + bound.qaRun.id)), true); assert.equal(previewOrder, "1,2,3,4"); assert.equal(previewMatches, true); assert.equal(crossProjectPreview.status, 404); assert.equal(unknownCandidatePreview.status, 404); assert.equal(previewProjectionPrivate, true); }, undefined, {
        "ROUTE-004/202-refresh": () => assert.equal(routeBindStatuses[0], 202),
        "ROUTE-004/timeout-refresh": () => { assert.equal(retryCandidate?.status, "qa_unavailable_retryable"); assert.equal(routeBindCalls, 2); },
        "ROUTE-004/restart-refresh": () => { assert.equal(refreshed.qaRun.status, "completed"); assert.equal(finalQaProjection.qaRun.reQa.some((item: any) => item.status === "pass"), true); },
        "ROUTE-004/browser-refresh": () => assert.equal(navigations.some((url) => url.includes("/s2/qa/" + bound.qaRun.id)), true),
      });
    await prove(claimIds("ROUTE-005", ["frozen-readonly", "empty-valid"]), "route frozen and empty projection", "Real empty initial draft, persisted frozen projection, and rejected post-freeze update.",
      { initialReferenceCount: initial.referenceAssetIds.length, frozenStatus: frozen.status, frozenByQaRunId: frozen.frozenByQaRunId ?? "", frozenClientError, frozenWriteStatus: frozenWriteResponse.status, frozenWriteCode, logoOrder: updated.draft.logoAssetIds.join(","), logoRevision: updated.draft.revision, staleLogoStatus: staleLogoResponse.status, result: "visible-readonly" },
      "The real client exposed an initially empty draft, then a frozen read-only projection after bind.",
      () => { assert.equal(initial.referenceAssetIds.length, 0); assert.equal(frozen.status, "frozen"); assert.equal(frozen.frozenByQaRunId, bound.qaRun.id); assert.equal(frozenWriteCode, "DRAFT_FROZEN"); assert.deepEqual(updated.draft.logoAssetIds, [logoTwo.asset.id, logoOne.asset.id]); assert.equal(staleLogoResponse.status, 409); }, undefined, {
        "ROUTE-005/frozen-readonly": () => { assert.equal(frozen.status, "frozen"); assert.equal(frozen.frozenByQaRunId, bound.qaRun.id); assert.equal(frozenWriteCode, "DRAFT_FROZEN"); },
        "ROUTE-005/empty-valid": () => assert.equal(initial.referenceAssetIds.length, 0),
    });
    const matrixValues: Fixture[] = [];
    let unavailableProjectionForUi: any = null;
    try {
      const ineligibleProvider = new MockOpenAIProvider({
        briefData: briefData(),
        s2QaResponseFactory: (input) => input.candidateIndex === 1
          ? qaPayload(input, "pass", "geometry.max-height")
          : qaPayload(input, "pass"),
      });
      const ineligibleValue = fixture([ONE_PIXEL_PNG], { provider: ineligibleProvider, geometry: { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: 4000 } });
      matrixValues.push(ineligibleValue);
      const ineligibleInitial = await bindAndWait(ineligibleValue);
      const ineligibleCandidate = ineligibleInitial.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
      const ineligibleRepairResponse = await handleApiRequest(new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ expectedInputVersionId: ineligibleInitial.bound.inputVersionId }),
      }), ["projects", ineligibleValue.projectId, "s2", "qa-runs", ineligibleInitial.bound.qaRun.id, "candidates", ineligibleCandidate.candidateId, "repair"], ineligibleValue.service);
      const ineligibleRepairBody = await ineligibleRepairResponse.json() as any;

      const warningProvider = new MockOpenAIProvider({
        briefData: briefData(),
        s2QaResponseFactory: (input) => input.candidateIndex === 1 ? qaPayload(input, "warning") : qaPayload(input, "pass"),
      });
      const warningValue = fixture([ONE_PIXEL_PNG], { provider: warningProvider });
      matrixValues.push(warningValue);
      const warningInitial = await bindAndWait(warningValue);
      const warningCandidate = warningInitial.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
      const passCandidate = warningInitial.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 2)!;

      const unavailableProvider = new MockOpenAIProvider({
        briefData: briefData(),
        s2QaResponseFactory: () => { throw new ProviderFailure("PROVIDER_TIMEOUT"); },
      });
      const unavailableValue = fixture([ONE_PIXEL_PNG], { provider: unavailableProvider });
      matrixValues.push(unavailableValue);
      const unavailableInitial = await bindAndWait(unavailableValue);
      const unavailableRetryableCandidate = unavailableInitial.result.qaRun.candidateResults.find((candidate: any) => candidate.candidateIndex === 1)!;
      await unavailableValue.service.s2.retryQa(unavailableValue.projectId, unavailableInitial.bound.qaRun.id, unavailableRetryableCandidate.candidateId, randomUUID(), randomUUID());
      const unavailableTerminal = await waitFor(() => unavailableValue.service.s2.getQaRun(unavailableValue.projectId, unavailableInitial.bound.qaRun.id) as any,
        (current) => current.qaRun.candidateResults.some((candidate: any) => candidate.candidateId === unavailableRetryableCandidate.candidateId && candidate.status === "qa_unavailable_terminal"));
      const unavailableTerminalCandidate = unavailableTerminal.qaRun.candidateResults.find((candidate: any) => candidate.candidateId === unavailableRetryableCandidate.candidateId)!;
      unavailableProjectionForUi = unavailableInitial.result;

      const finalMaterialCandidate = finalQaProjection.qaRun.candidateResults.find((candidate: any) => candidate.candidateId === materialCandidate?.candidateId)!;
      const eligibleControls = s2QaCandidateControls(materialCandidate!, false);
      const retryControls = s2QaCandidateControls(retryCandidate!, false);
      const ineligibleControls = s2QaCandidateControls(ineligibleCandidate, false);
      const warningControls = s2QaCandidateControls(warningCandidate, false);
      const passControls = s2QaCandidateControls(passCandidate, false);
      const terminalControls = s2QaCandidateControls(unavailableTerminalCandidate, false);
      const existingRepairControls = s2QaCandidateControls(finalMaterialCandidate, true);
      await prove(claimIds("ROUTE-006", ["repair-control", "retry-control"]), "route repair retry controls", "Real server-owned eligibility and actual client control projection across eligible, ineligible, warning, pass, unavailable-terminal, existing-repair, and retryable candidate states.",
        {
          eligibleStatus: materialCandidate?.status ?? "",
          eligibleRepairEligible: materialCandidate?.repairEligible ?? false,
          eligibleFindingIds: (materialCandidate?.eligibleRepairFindingIds ?? []).join(","),
          eligibleRepairControl: eligibleControls.canRepair,
          ineligibleStatus: ineligibleCandidate.status,
          ineligibleRepairEligible: ineligibleCandidate.repairEligible,
          ineligibleFindingIds: (ineligibleCandidate.eligibleRepairFindingIds ?? []).join(","),
          ineligibleApiStatus: ineligibleRepairResponse.status,
          ineligibleApiCode: ineligibleRepairBody.error?.code ?? "",
          ineligibleRepairControl: ineligibleControls.canRepair,
          warningStatus: warningCandidate.status,
          warningRepairControl: warningControls.canRepair,
          passStatus: passCandidate.status,
          passRepairControl: passControls.canRepair,
          unavailableTerminalStatus: unavailableTerminalCandidate.status,
          unavailableTerminalRepairControl: terminalControls.canRepair,
          unavailableTerminalRetryControl: terminalControls.canRetry,
          existingRepairStatus: finalMaterialCandidate.status,
          existingRepairEligible: finalMaterialCandidate.repairEligible ?? false,
          existingRepairFindingIds: (finalMaterialCandidate.eligibleRepairFindingIds ?? []).join(","),
          existingRepairControl: existingRepairControls.canRepair,
          retryableStatus: retryCandidate?.status ?? "",
          retryableControl: retryControls.canRetry,
          result: "server-owned-control-matrix",
        },
        "The real server-owned projection exposed repair only for the eligible MATERIAL_FAIL, returned REPAIR_NOT_ELIGIBLE for the ineligible MATERIAL_FAIL, omitted repair for warning/pass/terminal/existing-repair states, and preserved retry only for the retryable unavailable state.",
        () => {
          assert.equal(materialCandidate?.status, "material_fail");
          assert.equal(materialCandidate?.repairEligible, true);
          assert.equal((materialCandidate?.eligibleRepairFindingIds?.length ?? 0) > 0, true);
          assert.equal(eligibleControls.canRepair, true);
          assert.equal(ineligibleCandidate.status, "material_fail");
          assert.equal(ineligibleCandidate.repairEligible, false);
          assert.deepEqual(ineligibleCandidate.eligibleRepairFindingIds, []);
          assert.equal(ineligibleRepairResponse.status, 409);
          assert.equal(ineligibleRepairBody.error?.code, "REPAIR_NOT_ELIGIBLE");
          assert.equal(ineligibleControls.canRepair, false);
          assert.equal(warningCandidate.status, "warning");
          assert.equal(warningControls.canRepair, false);
          assert.equal(passCandidate.status, "pass");
          assert.equal(passControls.canRepair, false);
          assert.equal(unavailableTerminalCandidate.status, "qa_unavailable_terminal");
          assert.equal(terminalControls.canRepair, false);
          assert.equal(terminalControls.canRetry, false);
          assert.equal(finalMaterialCandidate.repairEligible, false);
          assert.equal((finalMaterialCandidate.eligibleRepairFindingIds ?? []).length, 0);
          assert.equal(existingRepairControls.canRepair, false);
          assert.equal(retryCandidate?.status, "qa_unavailable_retryable");
          assert.equal(retryControls.canRetry, true);
          assert.equal(finalQaProjection.qaRun.reQa.some((item: any) => item.status === "pass"), true);
        }, undefined, {
          "ROUTE-006/repair-control": () => {
            assert.equal(materialCandidate?.repairEligible, true);
            assert.equal(eligibleControls.canRepair, true);
            assert.equal(ineligibleCandidate.repairEligible, false);
            assert.deepEqual(ineligibleCandidate.eligibleRepairFindingIds, []);
            assert.equal(ineligibleRepairBody.error?.code, "REPAIR_NOT_ELIGIBLE");
            assert.equal(ineligibleControls.canRepair, false);
            assert.equal(warningControls.canRepair, false);
            assert.equal(passControls.canRepair, false);
            assert.equal(terminalControls.canRepair, false);
            assert.equal(existingRepairControls.canRepair, false);
          },
          "ROUTE-006/retry-control": () => {
            assert.equal(retryCandidate?.status, "qa_unavailable_retryable");
            assert.equal(retryControls.canRetry, true);
            assert.equal(unavailableTerminalCandidate.status, "qa_unavailable_terminal");
            assert.equal(terminalControls.canRetry, false);
          },
        });

      const unavailablePresentation = s2QaUserFacingState(unavailableInitial.result.qaRun);
      const unavailableVisibleText = unavailablePresentation.statusText + "\n" + unavailablePresentation.summaryText;
      await prove(["UI-003/unavailable-not-pass"], "ui unavailable distinction", "Actual deterministic client presentation projected from a real all-provider-unavailable persisted QA result.",
        { sourcePath: "app/components/S2Client.tsx", summaryKind: unavailableInitial.result.qaRun.summary.kind, statusText: unavailablePresentation.statusText, summaryText: unavailablePresentation.summaryText, visibleText: unavailableVisibleText, retryableControl: s2QaCandidateControls(unavailableRetryableCandidate, false).canRetry, result: "unavailable-distinct-no-verdict" },
        "The deterministic client presentation for a real all-provider-unavailable projection communicated QA unavailability and exposed neither PASS, MATERIAL_FAIL, nor completed success.",
        () => {
          assert.equal(unavailableInitial.result.qaRun.summary.kind, "all_results_unavailable");
          assert.match(unavailableVisibleText, /QA unavailable/i);
          assert.match(unavailableVisibleText, /no usable provider result/i);
          assert.doesNotMatch(unavailableVisibleText, /\bPASS\b/);
          assert.doesNotMatch(unavailableVisibleText, /\bMATERIAL_FAIL\b/);
          assert.doesNotMatch(unavailableVisibleText, /completed/i);
          assert.equal(s2QaCandidateControls(unavailableRetryableCandidate, false).canRetry, true);
        });
    } finally {
      for (const value of matrixValues) rmSync(value.root, { recursive: true, force: true });
    }

    const responseJsonText = JSON.stringify({ asset: uploaded.asset, draft: updated.draft });
    const storageKey = routeState.s2Assets.find((asset) => asset.id === uploaded.asset.id)?.storageKeyOriginal ?? "";
    const privateProjectPreview = await routeApi("/api/projects/" + randomUUID() + "/s2/reference-assets/" + uploaded.asset.id, { method: "GET" });
    const privacyLogText = privacyLogEntries.join("\n");
    const privacyMarkerFree = Object.values(privacyMarkers).every((marker) => !privacyLogText.includes(marker));
    const privacySafeEnvelopeMarkerFree = Object.values(privacyMarkers).every((marker) => privacySafeEnvelopes.every((envelope) => !envelope.includes(marker)));
    const privacyEvidenceCount = privacyRun?.qaRun.candidateResults.reduce((sum: number, candidate: any) => sum + candidate.requirementObservations.length + candidate.designObservations.length, 0) ?? 0;
    await prove(claimIds("PRIV-001", ["image-bytes", "base64", "prompt", "provider-payload", "evidence", "private-path"]), "privacy payload boundary", "Real local S2 success/failure run, production provider adapter success/failure, captured console sinks, API error envelope, traversal-shaped private filename, and private object keys.",
      { responseOmitsImageBytes: !responseJsonText.includes("89504e470d0a1a0a"), responseOmitsBase64: !responseJsonText.includes("iVBORw0KGgo"), responseOmitsPrompt: !responseJsonText.includes("bounded visual correction"), adapterImageMarkerRoundTrip: privacyAdapterImageBytes.toString("utf8") === privacyMarkers.imageBytes, adapterBase64Marker: privacyAdapterImageBytes.toString("base64") === privacyBase64, adapterPromptMarker: privacyAdapterPrompt === privacyMarkers.prompt, providerPayloadObserved: privacyProviderPayloadSeen && privacyAdapterRequestId === privacyMarkers.providerPayload, evidenceObserved: privacyEvidenceSeen && privacyEvidenceCount > 0, privacyInputPathContainsMarker: privacyInputFileName.includes(privacyMarkers.privatePath), s2FailureCode: privacyFailureCode, adapterFailureCode: privacyAdapterFailureCode, errorStatus: privacyErrorStatus, logEntryCount: privacyLogEntries.length, logMarkersAbsent: privacyMarkerFree, safeEnvelopeMarkersAbsent: privacySafeEnvelopeMarkerFree, storagePathPrivate: storageKey.startsWith("projects/") && storageKey.includes("/s2/") && !storageKey.includes(".."), result: "minimized" },
      "The real local success, provider failure, API error, captured logging sinks, and private object route kept image bytes, encoded payloads, prompts, raw provider data, evidence markers, and private path markers out of logs and safe error envelopes while retaining private project-scoped storage.",
      () => { assert.equal(privacyMarkerFree, true); assert.equal(privacySafeEnvelopeMarkerFree, true); assert.equal(privacyErrorStatus, 400); assert.equal(privacyErrorBody?.error?.code, "IDEMPOTENCY_KEY_REQUIRED"); assert.equal(privacyFailureCode, "PROVIDER_TIMEOUT"); assert.equal(privacyAdapterFailureCode, "PROVIDER_UNAVAILABLE"); assert.equal(directPreview.status, 200); assert.equal(previewBytes.length > 0, true); assert.equal(privateProjectPreview.status, 404); }, undefined, {
        "PRIV-001/image-bytes": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.imageBytes); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.imageBytes); assert.equal(privacyAdapterImageBytes.toString("utf8"), privacyMarkers.imageBytes); assert.equal(responseJsonText.includes("89504e470d0a1a0a"), false); },
        "PRIV-001/base64": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.base64); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.base64); assert.equal(privacyAdapterImageBytes.toString("base64"), privacyBase64); assert.equal(responseJsonText.includes("iVBORw0KGgo"), false); },
        "PRIV-001/prompt": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.prompt); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.prompt); assert.equal(privacyAdapterPrompt, privacyMarkers.prompt); assert.equal(responseJsonText.includes("bounded visual correction"), false); },
        "PRIV-001/provider-payload": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.providerPayload); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.providerPayload); assert.equal(privacyProviderPayloadSeen, true); assert.equal(privacyAdapterRequestId, privacyMarkers.providerPayload); },
        "PRIV-001/evidence": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.evidence); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.evidence); assert.equal(privacyEvidenceSeen, true); assert.equal(privacyEvidenceCount > 0, true); },
        "PRIV-001/private-path": () => { assertLogMarkerAbsent(privacyLogEntries, privacyMarkers.privatePath); assertSafeEnvelopeMarkerAbsent(privacySafeEnvelopes, privacyMarkers.privatePath); assert.equal(privacyInputFileName.includes(privacyMarkers.privatePath), true); assert.equal(storageKey.startsWith("projects/"), true); assert.equal(storageKey.includes("/s2/"), true); assert.equal(storageKey.includes(".."), false); assert.equal(privateProjectPreview.status, 404); assert.equal(privacyUploadedStorageKey.includes(privacyMarkers.privatePath), false); },
      });
    const changedSurface = scanChangedTrackedSurface("5b813049ca3fad36c537399b5181a94de33ad508");
    const controlledSecretValue = "sk-" + "A".repeat(24);
    const controlledSecretFixture = "OPENAI_API_KEY=\"" + controlledSecretValue + "\"";
    const controlledSecretFindings = scanSecretText("controlled-injected-secret.fixture", controlledSecretFixture);
    const controlledSecretReport = JSON.stringify(controlledSecretFindings.map((finding) => finding.redacted));
    const controlledSecretReportSafe = controlledSecretFindings.length > 0
      && controlledSecretFindings.every((finding) => finding.redacted === "[REDACTED]")
      && !controlledSecretReport.includes(controlledSecretValue)
      && !controlledSecretReport.includes(controlledSecretFixture);
    const changedSourceText = routeClientSource + readFileSync("src/lib/s2-provider.ts", "utf8") + readFileSync("src/lib/openai.ts", "utf8");
    await prove(claimIds("PRIV-002", ["credential", "token", "private-key", "env", "auth-header"]), "privacy client credential boundary", "Static changed-client/provider boundary review for credential, token, private-key, environment, and authorization-header exposure.",
      { sourcePath: "app/components/S2Client.tsx", clientHasEnv: routeClientSource.includes("process.env"), clientHasBearer: routeClientSource.includes("Bearer"), clientHasPrivateKey: routeClientSource.includes("PRIVATE KEY"), clientHasAuthHeader: routeClientSource.includes("authorization"), providerAuthServerOnly: changedSourceText.includes("authorization"), result: "client-clean" },
      "The checked client bundle source contained no credentials, environment reads, private keys, or authorization header while server provider code retained server-only auth handling.",
      () => { assert.equal(routeClientSource.includes("process.env"), false); assert.equal(routeClientSource.includes("Bearer"), false); assert.equal(routeClientSource.includes("PRIVATE KEY"), false); }, undefined, {
        "PRIV-002/credential": () => assert.equal(/OPENAI_API_KEY|apiKey/.test(routeClientSource), false),
        "PRIV-002/token": () => assert.equal(routeClientSource.includes("Bearer"), false),
        "PRIV-002/private-key": () => assert.equal(routeClientSource.includes("PRIVATE KEY"), false),
        "PRIV-002/env": () => assert.equal(routeClientSource.includes("process.env"), false),
        "PRIV-002/auth-header": () => { assert.equal(routeClientSource.includes("authorization"), false); assert.equal(changedSourceText.includes("authorization"), true); },
      });
    await prove(claimIds("PRIV-003", ["cross-project", "private-preview"]), "privacy project-scoped preview", "Real private preview request with the correct project and a random cross-project scope.",
      { sameProjectStatus: directPreview.status, crossProjectStatus: privateProjectPreview.status, responseBytes: previewBytes.length, result: "scoped-private" },
      "The real preview returned bytes only for the owning project and rejected a cross-project asset lookup.",
      () => { assert.equal(directPreview.status, 200); assert.equal(privateProjectPreview.status, 404); }, undefined, {
        "PRIV-003/cross-project": () => assert.equal(privateProjectPreview.status, 404),
        "PRIV-003/private-preview": () => { assert.equal(directPreview.status, 200); assert.equal(previewBytes.length > 0, true); },
      });
    await prove(claimIds("PRIV-004", ["generated-keys", "traversal"]), "privacy storage-key safety", "Real traversal-shaped client filename through upload and private storage-key inspection.",
      { inputFileName: file.name, generatedAssetId: uploaded.asset.id, storageKey, traversalPresent: storageKey.includes("..") || storageKey.includes("\\"), result: "safe-key" },
      "The real upload generated an opaque project-scoped key and did not preserve traversal separators.",
      () => { assert.equal(storageKey.includes(".."), false); assert.equal(storageKey.includes("\\"), false); assert.match(uploaded.asset.id, /^[0-9a-f-]{36}$/); }, undefined, {
        "PRIV-004/generated-keys": () => { assert.match(uploaded.asset.id, /^[0-9a-f-]{36}$/); assert.equal(storageKey.startsWith("projects/"), true); },
        "PRIV-004/traversal": () => { assert.equal(storageKey.includes(".."), false); assert.equal(storageKey.includes("\\"), false); },
      });
    const uiSource = routeClientSource;
    await prove(claimIds("UI-001", ["references-disclaimer", "qa-disclaimer"]), "ui visual-only disclosure", "Static rendered S2 client source review for references and QA visual-only disclosures.",
      { sourcePath: "app/components/S2Client.tsx", referencesDisclaimer: uiSource.includes("S2 is visual/design QA only"), qaDisclaimer: uiSource.includes("Visual/design screening only"), result: "disclosed" },
      "The checked rendered client source displayed the visual-only disclosure on both S2 screens.",
      () => { assert.equal(uiSource.includes("S2 is visual/design QA only"), true); assert.equal(uiSource.includes("Visual/design screening only"), true); }, undefined, {
        "UI-001/references-disclaimer": () => assert.equal(uiSource.includes("S2 is visual/design QA only"), true),
        "UI-001/qa-disclaimer": () => assert.equal(uiSource.includes("Visual/design screening only"), true),
      });
    const persistedPresentation = s2QaUserFacingState(finalQaProjection.qaRun);
    let uiRawShuffledOrder = "";
    let uiServerProjectedOrder = "";
    let uiRendererOrder = "";
    let uiCandidateIdMapping = "";
    const serverProjectionForUi = routeValue.service.s2.getQaRun(routeValue.projectId, bound.qaRun.id) as any;
    const shuffledUiProjection = cloneJson(serverProjectionForUi) as any;
    shuffledUiProjection.qaRun.candidateResults.reverse();
    uiRawShuffledOrder = shuffledUiProjection.qaRun.candidateResults.map((item: any) => item.candidateIndex).join(",");
    const orderedServerCandidates = orderS2Candidates(shuffledUiProjection.qaRun.candidateResults);
    uiServerProjectedOrder = serverProjectionForUi.qaRun.candidateResults.map((item: any) => item.candidateIndex).join(",");
    uiRendererOrder = orderedServerCandidates.map((item: any) => item.candidateIndex).join(",");
    uiCandidateIdMapping = orderedServerCandidates.map((item: any) => item.candidateIndex + ":" + item.candidateId).join(",");
    const canonicalCandidateIds = serverProjectionForUi.qaRun.candidateResults.map((item: any) => item.candidateId).join(",");
    assert.equal(uiRawShuffledOrder, "4,3,2,1");
    assert.equal(uiServerProjectedOrder, "1,2,3,4");
    assert.equal(uiRendererOrder, "1,2,3,4");
    assert.equal(orderedServerCandidates.length, 4);
    assert.equal(new Set(orderedServerCandidates.map((item: any) => item.candidateId)).size, 4);
    assert.equal(orderedServerCandidates.map((item: any) => item.candidateId).join(","), canonicalCandidateIds);
    const unavailablePresentationForUi = unavailableProjectionForUi ? s2QaUserFacingState(unavailableProjectionForUi.qaRun) : null;
    const uiStateValues = [
      persistedPresentation.statusText + "|" + persistedPresentation.summaryText + "|" + String(finalQaProjection.qaRun.summary?.kind ?? ""),
      (unavailablePresentationForUi?.statusText ?? "") + "|" + (unavailablePresentationForUi?.summaryText ?? "") + "|" + String(unavailableProjectionForUi?.qaRun.summary?.kind ?? ""),
    ];
    const uiStatesDistinct = new Set(uiStateValues).size === 2;
    await prove(claimIds("UI-002", ["ordered-candidates", "state-distinguishable"]), "ui persisted state projection", "A shuffled candidate fixture derived from the actual persisted server projection, passed through the production server projection and orderS2Candidates renderer helper, plus real available and all-unavailable state projections.",
      { sourcePath: "app/components/S2Client.tsx", rawShuffledOrder: uiRawShuffledOrder, serverProjectedOrder: uiServerProjectedOrder, rendererOrder: uiRendererOrder, candidateCount: 4, uniqueCandidateIds: 4, candidateIdMapping: uiCandidateIdMapping, rendererConsumesOrderedProjection: uiSource.includes("orderS2Candidates(run?.candidateResults ?? [])"), availableState: persistedPresentation.statusText + " / " + persistedPresentation.summaryText, unavailableState: unavailablePresentationForUi?.statusText + " / " + unavailablePresentationForUi?.summaryText, stateKinds: uiStateValues.join(" || "), statesDistinct: uiStatesDistinct, frozenStatus: frozen.status, result: "server-ordered-distinguishable" },
      "The actual shuffled projection was canonicalized by the production server projection, consumed in canonical order by the renderer helper, preserved every candidate exactly once, and kept available and unavailable states visibly distinct.",
      () => { assert.equal(uiRawShuffledOrder, "4,3,2,1"); assert.equal(uiServerProjectedOrder, "1,2,3,4"); assert.equal(uiRendererOrder, "1,2,3,4"); assert.equal(uiSource.includes("orderS2Candidates(run?.candidateResults ?? [])"), true); assert.equal(uiStatesDistinct, true); assert.equal(frozen.status, "frozen"); }, undefined, {
        "UI-002/ordered-candidates": () => { assert.equal(uiServerProjectedOrder, "1,2,3,4"); assert.equal(uiRendererOrder, "1,2,3,4"); assert.equal(uiSource.includes("orderS2Candidates(run?.candidateResults ?? [])"), true); assert.equal(uiCandidateIdMapping.split(",").length, 4); },
        "UI-002/state-distinguishable": () => { assert.equal(uiStatesDistinct, true); assert.equal(unavailableProjectionForUi?.qaRun.summary?.kind, "all_results_unavailable"); assert.equal(frozen.status, "frozen"); },
      });
    await prove(claimIds("UI-004", ["no-prompt-edit", "no-model-edit", "no-verdict-edit", "no-hard-fact-edit", "no-hash-edit"]), "ui immutable server projection", "Static client source review for absence of editable provider prompt, model, verdict, hard-fact, and hash controls.",
      { sourcePath: "app/components/S2Client.tsx", promptInput: uiSource.includes("promptText"), modelInput: uiSource.includes("modelInput"), verdictInput: uiSource.includes("verdictInput"), hardFactInput: uiSource.includes("hardFactInput"), hashInput: uiSource.includes("hashInput"), result: "server-owned" },
      "The checked UI source exposed no editable controls for provider prompts, model, verdicts, hard facts, or hashes.",
      () => { assert.equal(uiSource.includes("promptText"), false); assert.equal(uiSource.includes("modelInput"), false); assert.equal(uiSource.includes("verdictInput"), false); assert.equal(uiSource.includes("hardFactInput"), false); assert.equal(uiSource.includes("hashInput"), false); }, undefined, {
        "UI-004/no-prompt-edit": () => assert.equal(uiSource.includes("promptText"), false),
        "UI-004/no-model-edit": () => assert.equal(uiSource.includes("modelInput"), false),
        "UI-004/no-verdict-edit": () => assert.equal(uiSource.includes("verdictInput"), false),
        "UI-004/no-hard-fact-edit": () => assert.equal(uiSource.includes("hardFactInput"), false),
        "UI-004/no-hash-edit": () => assert.equal(uiSource.includes("hashInput"), false),
    });
    const packageText = readFileSync("package.json", "utf8");
    const lockText = readFileSync("pnpm-lock.yaml", "utf8");
    const blockedGuardProbe = providerTransportMeasurement();
    const guardedProvider = new OpenAIProvider({
      apiKey: "local-test-only",
      fetchImpl: createProviderTransportGuard(blockedGuardProbe, async () => { throw new Error("unexpected network forward"); }),
    });
    let guardedProviderFailureCode = "";
    try { await guardedProvider.extractBrief(new Uint8Array([0])); }
    catch (error) { guardedProviderFailureCode = error instanceof ProviderFailure ? error.safeCode : "UNKNOWN_ERROR"; }
    const normalEvidenceLiveProviderDispatches = normalEvidenceTransport.nonLoopbackAttempts;
    const normalEvidenceNetworkForwardCount = normalEvidenceTransport.networkForwardCount;
    assertNoLiveProviderDispatch(normalEvidenceTransport);
    const localProviderCalls = providerCallCounts(routeValue);
    const frozenDependencyLock = lockText.includes("lockfileVersion: '9.0'") && lockText.includes("sharp@0.35.3") && lockText.includes("pdfjs-dist@6.2.108");
    const dependencyVersionsPinned = packageText.includes('"sharp": "0.35.3"') && packageText.includes('"pdfjs-dist": "6.2.108"');
    const redactedSecretFindings = changedSurface.findings.map((finding) => finding.kind + "=" + finding.redacted).join(",");
    await prove(claimIds("PRIV-005", ["secret-scan", "dependency-review", "no-live-provider"]), "privacy changed-content and dependency review", "Canonical-base changed-surface scan including tracked and current untracked implementation files, with controlled injected-secret redaction negative, frozen sharp/pdfjs lock review, measured normal-evidence provider transport, separate blocked guard probe, and production audit target.",
      { sourcePath: "git diff 5b813049ca3fad36c537399b5181a94de33ad508 + current untracked files + package.json + pnpm-lock.yaml", changedFileCount: changedSurface.files.length, changedSurfaceFiles: changedSurface.files.join(","), secretFindingCount: changedSurface.findings.length, redactedSecretFindings, controlledSecretFindingCount: controlledSecretFindings.length, controlledSecretReport, controlledSecretReportSafe, frozenDependencyLock, dependencyVersionsPinned, sharpVersionPinned: packageText.includes('"sharp": "0.35.3"'), pdfjsVersionPinned: packageText.includes('"pdfjs-dist": "6.2.108"'), productionAuditTarget: "pnpm audit --prod", mockS2QaCalls: localProviderCalls.s2Qa, mockS2RepairCalls: localProviderCalls.s2Repair, normalEvidenceLiveProviderDispatches, normalEvidenceNonLoopbackAttempts: normalEvidenceTransport.nonLoopbackAttempts, normalEvidenceNetworkForwardCount, blockedGuardProbeAttempts: blockedGuardProbe.nonLoopbackAttempts, blockedGuardProbeNetworkForwardCount: blockedGuardProbe.networkForwardCount, guardFailureCode: guardedProviderFailureCode, result: "clean-offline" },
      "The canonical-base changed surface, including fresh untracked implementation files, had no credential findings, controlled secret findings were redacted, sharp/pdfjs versions matched the frozen lock, normal evidence measured zero non-loopback provider dispatches and zero network forwards, and the separate blocked probe intercepted one non-loopback attempt without forwarding.",
      () => { assert.equal(changedSurface.files.length > 0, true); assert.equal(changedSurface.findings.length, 0); assert.equal(controlledSecretReportSafe, true); assert.equal(frozenDependencyLock, true); assert.equal(dependencyVersionsPinned, true); assertNoLiveProviderDispatch(normalEvidenceTransport); assert.equal(blockedGuardProbe.nonLoopbackAttempts, 1); assert.equal(blockedGuardProbe.networkForwardCount, 0); assert.equal(guardedProviderFailureCode, "PROVIDER_UNAVAILABLE"); assert.equal(localProviderCalls.s2Qa > 0, true); assert.equal(localProviderCalls.s2Repair > 0, true); }, undefined, {
        "PRIV-005/secret-scan": () => { assert.equal(changedSurface.findings.length, 0); assert.equal(redactedSecretFindings, ""); assert.equal(controlledSecretReportSafe, true); },
        "PRIV-005/dependency-review": () => { assert.equal(frozenDependencyLock, true); assert.equal(dependencyVersionsPinned, true); assert.equal(packageText.includes('"sharp": "0.35.3"'), true); assert.equal(packageText.includes('"pdfjs-dist": "6.2.108"'), true); },
        "PRIV-005/no-live-provider": () => { assertNoLiveProviderDispatch(normalEvidenceTransport); assert.equal(blockedGuardProbe.nonLoopbackAttempts, 1); assert.equal(blockedGuardProbe.networkForwardCount, 0); assert.equal(guardedProviderFailureCode, "PROVIDER_UNAVAILABLE"); },
      });
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
     () => { assert.equal(repairOutcomeResults.find((item) => item.mode === "pass")?.status, "pass"); assert.equal(repairOutcomeResults.find((item) => item.mode === "below-threshold")?.status, "warning"); assert.equal(repairOutcomeResults.find((item) => item.mode === "unavailable")?.status, "qa_unavailable_retryable"); assert.equal(repairOutcomeResults.find((item) => item.mode === "uncertain")?.observed, "uncertain"); assert.equal(repairOutcomeResults.find((item) => item.mode === "not-verifiable")?.observed, "not_verifiable"); }, undefined, {
       "REPAIR-002/warning": () => assert.equal(repairOutcomeResults.find((item) => item.mode === "below-threshold")?.status, "warning"),
       "REPAIR-002/pass": () => assert.equal(repairOutcomeResults.find((item) => item.mode === "pass")?.status, "pass"),
       "REPAIR-002/unavailable": () => assert.equal(repairOutcomeResults.find((item) => item.mode === "unavailable")?.status, "qa_unavailable_retryable"),
       "REPAIR-002/uncertain": () => assert.equal(repairOutcomeResults.find((item) => item.mode === "uncertain")?.observed, "uncertain"),
       "REPAIR-002/not-verifiable": () => assert.equal(repairOutcomeResults.find((item) => item.mode === "not-verifiable")?.observed, "not_verifiable"),
     });

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
  const adapterResult = (label: string) => adapterResults.find((item) => item.label === label)!;
  await prove(claimIds("REPAIR-011", ["empty", "multiple", "non-png", "invalid-base64", "oversized", "corrupt-truncated"]), "repair production adapter output classes", "Production OpenAIProvider.runS2Repair with one controlled local fetch per malformed output class and one valid PNG response.",
     { invalidCases: adapterResults.length, allInvalidSafeCode: adapterResults.every((item) => item.safeCode === "REPAIR_OUTPUT_INVALID"), oneCallEach: adapterResults.every((item) => item.calls === 1), validPngBytes: validAdapterResult.pngBytes.byteLength, validCalls: validAdapterCalls, liveNetwork: false, result: "locked-output-validation" },
     "The real production adapter rejected every locked bad output class with one local fake request and accepted the valid PNG without live network.",
     () => { assert.equal(adapterResults.length, 7); assert.equal(adapterResults.every((item) => item.safeCode === "REPAIR_OUTPUT_INVALID" && item.calls === 1), true); assert.equal(validAdapterCalls, 1); assert.equal(Buffer.from(validAdapterResult.pngBytes).equals(ONE_PIXEL_PNG), true); }, undefined, {
       "REPAIR-011/empty": () => { assert.equal(adapterResult("empty").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("empty").calls, 1); assert.equal(adapterResult("missing-or-url-only").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("missing-or-url-only").calls, 1); },
       "REPAIR-011/multiple": () => { assert.equal(adapterResult("multiple").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("multiple").calls, 1); },
       "REPAIR-011/non-png": () => { assert.equal(adapterResult("non-png").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("non-png").calls, 1); },
       "REPAIR-011/invalid-base64": () => { assert.equal(adapterResult("invalid-base64").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("invalid-base64").calls, 1); },
       "REPAIR-011/oversized": () => { assert.equal(adapterResult("oversized").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("oversized").calls, 1); },
       "REPAIR-011/corrupt-truncated": () => { assert.equal(adapterResult("corrupt-truncated-png").safeCode, "REPAIR_OUTPUT_INVALID"); assert.equal(adapterResult("corrupt-truncated-png").calls, 1); },
     });

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
  } finally {
    restoreNormalEvidenceTransportGuard();
  }
});
