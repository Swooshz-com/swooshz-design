import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { AppError, type BoothGeometry, type ProviderMetadata, type S4MaskPrimitive, type UUID } from "../src/lib/types";
import { MockOpenAIProvider, ProviderFailure } from "../src/lib/openai";
import { JsonRepository, PrivateObjectStore, type RepositoryLockPhase, type RepositoryLockRecord } from "../src/lib/store";
import { createWorkflowService, type WorkflowService, type WorkflowServiceOptions } from "../src/lib/workflow";
import { handleApiRequest, type ApiRequestDependencies } from "../src/lib/api";
import { createExactS3FixturePng } from "../src/lib/s3-media";
import { materializeS4Mask } from "../src/lib/s4-mask";
import { evaluateS4Preservation } from "../src/lib/s4-preservation";
import { OpenAIS4Provider, type S4ProviderContract } from "../src/lib/s4-provider";
import { resolveActiveVisualRevision, resolveVisualRevision } from "../src/lib/revision-resolver";
import { validateS4Collections, validateS4Graph } from "../src/lib/s4-persistence";
import { cloneJson, sha256 } from "../src/lib/utils";
import { createS4Client, instructionDraftState, isS4DraftClearEnabled, isS4DraftSubmitReady, isS4PrimitiveLocallyValid, S4Screen } from "../app/components/S4Client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { proveS4Claims } from "./s4-proof";
import { auditRepositorySurfaces, s4DependencyMetadataReferenceHash, type S4RepositoryAuditInput } from "./s4-repository-audit";
import { S4_G3_AUTHORIZED_DEPENDENCY_METADATA } from "./s4-dependency-authority";
import { S5_PDF_DEPENDENCIES } from "./s5-dependency-authority";

const WIDTH = 1536;
const HEIGHT = 1024;
const PIXELS = WIDTH * HEIGHT;
const FOREIGN_UUID = "11111111-1111-4111-8111-111111111111" as UUID;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function errorCode(error: unknown): string | null {
  return error instanceof AppError ? error.code : error instanceof Error ? error.message : null;
}

async function proveS4Variants(
  testId: string,
  provingTest: string,
  scenario: string,
  actualResult: string,
  assertions: Record<string, () => void | Promise<void>>,
  observationFacts: string[] = [],
): Promise<void> {
  await proveS4Claims(testId, provingTest, Object.entries(assertions).map(([variantId, assertion]) => ({
    variantId,
    assertionId: testId + "." + variantId + ".assertion",
    scenario: scenario + "/" + variantId,
    expectedResult: "The frozen " + testId + " variant is established by its executed lifecycle assertion.",
    actualResult,
    observationFacts,
    assertion,
  })));
}

function briefData(): any {
  return {
    projectFacts: { clientName: "S4 Fixture", eventName: "S4 Event", venueName: "Synthetic Venue", eventLocation: "Local", eventStartDate: null, eventEndDate: null, notes: null },
    brandStyle: { brandName: "S4 Brand", brandValues: ["clear"], visualDirection: "calm", preferredColors: ["blue"], materials: ["timber"], logoInstructions: null },
    functionalRequirements: [{ name: "Reception", count: null, countIsExact: false, mandatory: true, details: null }],
    mandatoryRequirements: ["Keep the entry clear."],
    prohibitedRequirements: ["No enclosed ceiling."],
    budget: { amount: null, currency: null, basis: "unknown", notes: null },
    unknowns: [], assumptions: [], freeTextRequirements: [],
    extractedGeometryMentions: { widthText: null, depthText: null, openSidesText: null, maxHeightText: null },
  };
}

function s2QaPayload(input: any): any {
  return {
    requirements: input.requirements.map((item: any) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "S4 source fixture observation",
    })),
    designRules: input.designRules.filter((item: any) => item.applicability === "applicable").map((item: any) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "S4 source fixture observation",
    })),
  };
}

function s4AssessmentPayload(repository: JsonRepository): any {
  const assessment = repository.state().s4Assessments.at(-1);
  if (!assessment) throw new Error("assessment fixture is not persisted");
  return {
    requirements: assessment.canonicalRequirements.map((item) => ({
      requirementId: item.requirementId, expected: item.expected, expectedCount: item.expectedCount,
      expectedValue: item.expectedValue, observed: item.expected === "absent" ? "absent" : "present",
      observedCount: item.expected === "exact_count" ? item.expectedCount : null,
      confidence: 0.99, evidence: "S4 assessment fixture observation",
    })),
    designRules: assessment.designRuleSnapshot.filter((item) => item.applicability === "applicable").map((item) => ({
      ruleId: item.ruleId, observed: "compliant", confidence: 0.99, evidence: "S4 assessment fixture observation",
    })),
    requestedEdit: { outcome: "satisfied", evidence: "The marked local region was updated." },
    overall: { requirementResult: "satisfied", buildabilityResult: "buildable", evidence: "The fixture remains buildable." },
  };
}

async function editedFixturePng(): Promise<Buffer> {
  const rgba = Buffer.alloc(PIXELS * 4);
  for (let index = 0; index < PIXELS; index += 1) {
    const offset = index * 4;
    rgba[offset] = 43; rgba[offset + 1] = 91; rgba[offset + 2] = 134; rgba[offset + 3] = 255;
  }
  for (let y = 210; y < 510; y += 1) for (let x = 315; x < 760; x += 1) {
    const offset = (y * WIDTH + x) * 4;
    rgba[offset] = 188; rgba[offset + 1] = 132; rgba[offset + 2] = 74;
  }
  return sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function mutateFixturePng(
  input: Uint8Array,
  x: number,
  y: number,
  channel: 0 | 1 | 2 | 3,
  delta: number,
): Promise<Buffer> {
  const raw = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * WIDTH + x) * 4 + channel;
  raw.data[offset] = Math.max(0, Math.min(255, raw.data[offset] + delta));
  return sharp(raw.data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function protectedFixtureMutation(source: Uint8Array, output: Uint8Array): Promise<Buffer> {
  const sourceRaw = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const outputRaw = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (100 * WIDTH + 100) * 4;
  outputRaw.data[offset] = (sourceRaw.data[offset] + 128) % 256;
  return sharp(outputRaw.data, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

function warningAssessmentPayload(repository: JsonRepository): any {
  const payload = s4AssessmentPayload(repository);
  return {
    ...payload,
    requirements: payload.requirements.map((item: any) => ({ ...item, confidence: 0.74 })),
    designRules: payload.designRules.map((item: any) => ({ ...item, confidence: 0.74 })),
  };
}

function materialAssessmentPayload(repository: JsonRepository): any {
  return { ...s4AssessmentPayload(repository), requestedEdit: { outcome: "not_satisfied", evidence: "The deterministic material-failure fixture rejects the requested edit." } };
}

function unavailableAssessmentPayload(repository: JsonRepository): any {
  return { ...s4AssessmentPayload(repository), requestedEdit: { outcome: "uncertain", evidence: "The deterministic QA fixture cannot verify the requested edit." } };
}

type S4Fixture = {
  root: string;
  repository: JsonRepository;
  objects: PrivateObjectStore;
  service: WorkflowService;
  provider: MockOpenAIProvider;
  s4Provider: S4ProviderContract;
  projectId: string;
  generationSetId: string;
  sourceBytes: Buffer;
  outputBytes: Buffer;
  imageCallCount: () => number;
  assessmentCallCount: () => number;
  imageInputs: unknown[];
  assessmentInputs: unknown[];
};

type S4FixtureOptions = Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onS4ProviderDispatchPhase" | "onS4PublicationPhase"> & {
  imageResults?: Array<Buffer | ProviderFailure>;
  assessmentResults?: Array<any | ProviderFailure>;
  s4Provider?: S4ProviderContract;
  beforeCommit?: () => void;
  onLockPhase?: (phase: RepositoryLockPhase, record: RepositoryLockRecord, path: string) => void;
};

async function fixture(options: S4FixtureOptions = {}): Promise<S4Fixture> {
  const root = mkdtempSync(join(tmpdir(), "swooshz-s4-g3-"));
  const repository = new JsonRepository(root, { beforeCommit: options.beforeCommit, onLockPhase: options.onLockPhase });
  const objects = new PrivateObjectStore(join(root, "objects"));
  const projectId = randomUUID();
  const generationSetId = randomUUID();
  const briefVersionId = randomUUID();
  const geometry: BoothGeometry = { widthMm: 9000, depthMm: 6000, openSides: ["north", "west"], maxHeightMm: null };
  const sourceBytes = await createExactS3FixturePng();
  const outputBytes = await editedFixturePng();
  const sourceHash = sha256(sourceBytes);
  const metadata: ProviderMetadata = { provider: "openai", api: "responses", model: "gpt-5.4-mini", modelSnapshot: "gpt-5.4-mini-2026-03-17", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() };
  const candidates: any[] = [];
  const conceptAssets: any[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const candidateId = randomUUID();
    const assetId = randomUUID();
    const storageKey = "projects/" + projectId + "/generations/" + generationSetId + "/" + assetId + ".png";
    objects.put(storageKey, sourceBytes);
    conceptAssets.push({ assetId, projectId, generationSetId, storageKey, mimeType: "image/png", byteSize: sourceBytes.byteLength, sha256: sourceHash, status: "stored", createdAt: new Date(0).toISOString() });
    candidates.push({
      candidateId, generationSetId, projectId, confirmedBriefVersionId: briefVersionId, candidateIndex: index,
      directionKey: "open-demo", assetId,
      compilerMetadata: { compilerVersion: "g2-booth-v1", directionKey: "open-demo", canonicalInputHash: sourceHash, promptHash: sourceHash, compiledAt: new Date(0).toISOString() },
      providerMetadata: { provider: "openai", api: "images", model: "gpt-image-2", modelSnapshot: "gpt-image-2-2026-04-21", providerRequestId: null, inputTokens: null, outputTokens: null, totalTokens: null, receivedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
    });
  }
  repository.transact((state) => {
    state.projects.push({ projectId, name: "S4 fixture", status: "concepts_ready", boothGeometry: geometry, briefAssetId: null, briefDraftId: null, confirmedBriefVersionId: briefVersionId, activeGenerationSetId: generationSetId, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    state.briefVersions.push({ briefVersionId, projectId, sourceDraftId: randomUUID(), sourceAssetId: randomUUID(), versionNumber: 1, schemaVersion: "brief-v1", status: "confirmed", geometrySnapshot: geometry, data: briefData(), contentHash: sourceHash, confirmationMode: "explicit_user_action", confirmedAt: new Date(0).toISOString(), extractionProviderMetadata: metadata });
    state.generationSets.push({ generationSetId, projectId, confirmedBriefVersionId: briefVersionId, generationRequestId: randomUUID(), attempt: 1, retryOfGenerationSetId: null, status: "succeeded", expectedCandidateCount: 4, promptCompilerVersion: "g2-booth-v1", promptManifestHash: sourceHash, provider: "openai", imageModelSnapshot: "gpt-image-2-2026-04-21", createdAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), failureCode: null });
    state.candidates.push(...candidates);
    state.conceptAssets.push(...conceptAssets);
  });
  let imageCalls = 0;
  let assessmentCalls = 0;
  const imageInputs: unknown[] = [];
  const assessmentInputs: unknown[] = [];
  const imageResults = [...(options.imageResults ?? [outputBytes])];
  const assessmentResults = [...(options.assessmentResults ?? [null])];
  const s4Provider: S4ProviderContract = {
    runS4ImageEdit: async (input) => {
      imageCalls += 1;
      imageInputs.push(input);
      const next = imageResults.shift() ?? outputBytes;
      if (next instanceof ProviderFailure) throw next;
      return { pngBytes: next, providerRequestId: "s4-image-fixture-" + String(imageCalls) };
    },
    runS4Assessment: async (input) => {
      assessmentCalls += 1;
      assessmentInputs.push(input);
      const next = assessmentResults.shift() ?? null;
      if (next instanceof ProviderFailure) throw next;
      return { payload: next ?? s4AssessmentPayload(repository), providerRequestId: "s4-assessment-fixture-" + String(assessmentCalls) };
    },
  };
  const provider = new MockOpenAIProvider({ briefData: briefData(), s2QaResponseFactory: (input) => s2QaPayload(input) });
  const { imageResults: _images, assessmentResults: _assessments, s4Provider: suppliedS4Provider, ...workflowOptions } = options;
  const activeS4Provider = suppliedS4Provider ?? s4Provider;
  const service = createWorkflowService({ repository, objects, provider, s4Provider: activeS4Provider, ...workflowOptions });
  return { root, repository, objects, service, provider, s4Provider: activeS4Provider, projectId, generationSetId, sourceBytes, outputBytes, imageCallCount: () => imageCalls, assessmentCallCount: () => assessmentCalls, imageInputs, assessmentInputs };
}

type S4RestartOptions = Pick<WorkflowServiceOptions, "processId" | "isProcessAlive" | "onS4ProviderDispatchPhase" | "onS4PublicationPhase"> & { s4Provider?: S4ProviderContract };

function restart(value: S4Fixture, options: S4RestartOptions = {}): WorkflowService {
  const { s4Provider, ...workflowOptions } = options;
  const repository = new JsonRepository(value.root, workflowOptions.processId === undefined ? {} : { processId: workflowOptions.processId, isProcessAlive: workflowOptions.isProcessAlive });
  const objects = new PrivateObjectStore(join(value.root, "objects"));
  return createWorkflowService({ repository, objects, provider: value.provider, s4Provider: s4Provider ?? value.s4Provider, ...workflowOptions });
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("S4 fixture timed out: " + JSON.stringify(read()));
}

async function ready(value: S4Fixture): Promise<{ sourceRevisionId: string; selectionVersion: number }> {
  value.service.s2.getReferenceDraft(value.projectId);
  const bound = await value.service.s2.bindQa(value.projectId, value.generationSetId, 1, randomUUID(), randomUUID());
  await waitFor(() => value.repository.state().s2QaRuns.find((item) => item.id === bound.qaRun.id)?.status, (status) => status === "completed");
  const before = value.service.s3.getState(value.projectId);
  const source = before.screenedCandidates.find((item) => item.originalSourceId)?.originalSourceId;
  assert.ok(source);
  const selected = value.service.s3.selectSource(value.projectId, "source_root", source, 0, randomUUID(), randomUUID());
  assert.equal(selected.replayed, false);
  return { sourceRevisionId: selected.result.activeRevisionId, selectionVersion: selected.result.selectionVersion };
}

function cleanup(value: S4Fixture): void { rmSync(value.root, { recursive: true, force: true }); }

function runStoreRaceWriter(root: string, barrier: string, key: string, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/s4-object-store-race-worker.ts", root, barrier, key, bytes.toString("hex")], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error("store race writer failed")); return; }
      resolve(output.trim());
    });
  });
}

const EDIT_PRIMITIVES: S4MaskPrimitive[] = [{ kind: "rectangle", xQ16: 13_107, yQ16: 13_107, widthQ16: 19_661, heightQ16: 19_661 }];

function admit(
  value: S4Fixture,
  selected: { sourceRevisionId: string; selectionVersion: number },
  instructionText = "Replace the marked counter finish.",
  key = randomUUID(),
  referenceId = randomUUID(),
) {
  return value.service.s4.admitEdit(value.projectId, {
    baseRevisionId: selected.sourceRevisionId,
    expectedSelectionVersion: selected.selectionVersion,
    primitives: EDIT_PRIMITIVES,
    instructionText,
  }, key, referenceId);
}

function expectErrorCode(action: () => unknown, expected: string): void {
  let actual: string | null = null;
  try { action(); } catch (error) { actual = errorCode(error); }
  assert.equal(actual, expected);
}

test("S4 repository audit enforces exact resolved package identity and fails closed", () => {
  const baseSha = "2e01a90b6b2f40f4729764970a8cb89f25bbe0c8";
  const baseTree = "b144ae4bc0bb80bee82d696be0f7e550af0a3ae9";
  const authorityRef = "5481945791";
  const packageName = "react-test-renderer";
  const packageVersion = "19.2.8";
  const purpose = "direct in-process rendered S4Screen component/event evidence for submit, image retry, assessment retry and rollback.";
  const baseScript = "tsx --test tests/g3.test.ts tests/s2-evidence.test.ts tests/s2-lifecycle.test.ts";
  const candidateScript = "tsx --test tests/g3.test.ts tests/s2-evidence.test.ts tests/s2-lifecycle.test.ts tests/s3.test.ts tests/s3-evidence.test.ts tests/s4.test.ts tests/s4-evidence.test.ts";
  const basePackageText = execFileSync("git", ["show", baseSha + ":package.json"], { encoding: "utf8" });
  const baseLockfileText = execFileSync("git", ["show", baseSha + ":pnpm-lock.yaml"], { encoding: "utf8" });
  const candidatePackageText = readFileSync("package.json", "utf8");
  const candidateLockfileText = readFileSync("pnpm-lock.yaml", "utf8").replace(/\r\n/g, "\n");
  const sourceFiles = { "tests/s4.test.ts": 'import { create } from "react-test-renderer";', "src/lib/s5-pdf.ts": 'import { PDFDocument } from "pdf-lib"; import fontkit from "@pdf-lib/fontkit";' };
  type AuditOverrides = {
    basePackageText?: string;
    candidatePackageText?: string;
    baseLockfileText?: string;
    candidateLockfileText?: string;
    sourceFiles?: Record<string, string>;
    dependencyAuthority?: Partial<S4RepositoryAuditInput["dependencyAuthority"]>;
    scriptAuthority?: Partial<S4RepositoryAuditInput["scriptAuthority"]>;
  };

  function replaceOnce(text: string, search: string, replacement: string): string {
    assert.equal(text.split(search).length - 1, 1, "expected one disposable fixture match: " + search);
    return text.replace(search, replacement);
  }

  function rendererIdentityLock(importerVersion: string, snapshotLocator: string, packageLocator = "react-test-renderer@19.2.8:"): string {
    let result = replaceOnce(
      candidateLockfileText,
      "      react-test-renderer:\n        specifier: 19.2.8\n        version: 19.2.8(react@19.2.8)\n",
      "      react-test-renderer:\n        specifier: 19.2.8\n        version: " + importerVersion + "\n",
    );
    result = replaceOnce(result, "  react-test-renderer@19.2.8(react@19.2.8):", "  " + snapshotLocator + ":");
    return replaceOnce(result, "  react-test-renderer@19.2.8:", "  " + packageLocator);
  }

  const rendererPackageEntry = [
    "  react-test-renderer@19.2.8:",
    "    resolution: {integrity: sha512-GHKPaDRaNYU24PHTLG8Bx8VMY9t+qNfxQbt/Yjp7aMWBkKU6766SR0n6TnYu7P5I1MfEuAMUadqiyDHyI4Yy9Q==}",
    "    peerDependencies:",
    "      react: ^19.2.8",
    "",
  ].join("\n");
  const rendererSnapshotEntry = [
    "  react-test-renderer@19.2.8(react@19.2.8):",
    "    dependencies:",
    "      react: 19.2.8",
    "      react-is: 19.2.8",
    "      scheduler: 0.27.0",
    "",
  ].join("\n");

  function rendererPackageMetadataLock(replacement: string): string {
    return replaceOnce(candidateLockfileText, rendererPackageEntry, replacement);
  }

  function rendererSnapshotMetadataLock(replacement: string): string {
    return replaceOnce(candidateLockfileText, rendererSnapshotEntry, replacement);
  }

  function input(overrides: AuditOverrides = {}): S4RepositoryAuditInput {
    return {
      basePackageText: overrides.basePackageText ?? basePackageText,
      candidatePackageText: overrides.candidatePackageText ?? candidatePackageText,
      baseLockfileText: overrides.baseLockfileText ?? baseLockfileText,
      candidateLockfileText: overrides.candidateLockfileText ?? candidateLockfileText,
      sourceFiles: overrides.sourceFiles ?? sourceFiles,
      dependencyAuthority: {
        packageName,
        packageVersion,
        baseManifestValue: null,
        manifestPath: "devDependencies",
        purpose,
        allowedImportSurface: ["tests/s4.test.ts"],
        authorityRefs: [authorityRef],
        requiredAuthorityRef: authorityRef,
        baselineSha: baseSha,
        baselineTree: baseTree,
        expectedMetadata: S4_G3_AUTHORIZED_DEPENDENCY_METADATA,
        ...overrides.dependencyAuthority,
      },
      additionalDependencyAuthorities: S5_PDF_DEPENDENCIES,
      scriptAuthority: {
        scriptName: "test",
        baseValue: baseScript,
        candidateValue: candidateScript,
        purpose: "S4 implementation and evidence tests remain in the shared validation script.",
        authorityRefs: [authorityRef],
        requiredAuthorityRef: authorityRef,
        preservedRequiredValidation: ["testFile=tests/g3.test.ts", "build=next build"],
        removedRequiredValidation: [],
        executedRequiredValidation: ["s1Tests=exitCode:0"],
        requiredValidationLabels: ["s1Tests"],
        ...overrides.scriptAuthority,
      },
    };
  }

  function audit(overrides: AuditOverrides = {}) {
    return auditRepositorySurfaces(input(overrides)).dependencyAudit;
  }

  function assertIncomplete(label: string, result: ReturnType<typeof audit>): void {
    assert.equal(result.auditState, "incomplete", label + " audit state");
    assert.equal(result.disposition, null, label + " disposition");
  }

  function assertNonconformant(label: string, result: ReturnType<typeof audit>): void {
    assert.notEqual(result.disposition, "changed_authorized_conformant", label + " must not be conformant");
  }

  const valid = audit();
  assert.equal(valid.auditState, "complete", "valid locator audit state");
  assert.equal(valid.disposition, "changed_authorized_conformant", "valid actual locator");
  assert.equal(S4_G3_AUTHORIZED_DEPENDENCY_METADATA.sourceSha, "3ff5676478cc6cab4aec4d1afe65bbb1c1c029ee");
  assert.equal(S4_G3_AUTHORIZED_DEPENDENCY_METADATA.sourceTree, "ffa1d9e9f19bf563a6562aa8f4d94ac557ab4e77");
  assert.equal(S4_G3_AUTHORIZED_DEPENDENCY_METADATA.metadataSha256, s4DependencyMetadataReferenceHash(S4_G3_AUTHORIZED_DEPENDENCY_METADATA));

  function assertKnownNonconformant(label: string, result: ReturnType<typeof audit>): void {
    assert.equal(result.auditState, "complete", label + " audit state");
    assert.equal(result.disposition, "changed_unauthorized_nonconformant", label + " disposition");
  }

  assertIncomplete("malformed locator", audit({
    candidateLockfileText: rendererIdentityLock("19.2.8(react@19.2.8", "react-test-renderer@19.2.8(react@19.2.8)"),
  }));
  assertIncomplete("missing resolved locator", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "      react-test-renderer:\n        specifier: 19.2.8\n        version: 19.2.8(react@19.2.8)\n",
      "      react-test-renderer:\n        specifier: 19.2.8\n",
    ),
  }));
  assertIncomplete("importer and snapshot peer-context mismatch", audit({
    candidateLockfileText: rendererIdentityLock("19.2.8(react@19.2.80)", "react-test-renderer@19.2.8(react@19.2.8)"),
  }));
  assertNonconformant("peer-context mismatch", audit({
    candidateLockfileText: rendererIdentityLock("19.2.8(react@19.2.80)", "react-test-renderer@19.2.8(react@19.2.80)"),
  }));
  assertKnownNonconformant("incompatible peer declaration", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace("react: ^19.2.8", "react: ^18.0.0")),
  }));
  assertKnownNonconformant("compatible but different peer declaration", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace("react: ^19.2.8", "react: ^19.0.0")),
  }));
  assertKnownNonconformant("extra optional peer declaration", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace(
      "      react: ^19.2.8\n",
      "      react: ^19.2.8\n      react-dom: ^19.2.8\n    peerDependenciesMeta:\n      react-dom:\n        optional: true\n",
    )),
  }));
  assertKnownNonconformant("changed optional flag", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace(
      "      react: ^19.2.8\n",
      "      react: ^19.2.8\n    peerDependenciesMeta:\n      react:\n        optional: true\n",
    )),
  }));
  assertKnownNonconformant("missing authorised peer declaration", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace(
      "    peerDependencies:\n      react: ^19.2.8\n",
      "",
    )),
  }));
  assertKnownNonconformant("extra peer metadata", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace(
      "      react: ^19.2.8\n",
      "      react: ^19.2.8\n    peerDependenciesMeta:\n      react-dom:\n        optional: true\n",
    )),
  }));
  assertKnownNonconformant("direct package metadata drift", audit({
    candidateLockfileText: rendererPackageMetadataLock(rendererPackageEntry.replace(
      "sha512-GHKPaDRaNYU24PHTLG8Bx8VMY9t+qNfxQbt/Yjp7aMWBkKU6766SR0n6TnYu7P5I1MfEuAMUadqiyDHyI4Yy9Q==",
      "sha512-" + "A".repeat(86) + "==",
    )),
  }));
  assertKnownNonconformant("snapshot metadata drift", audit({
    candidateLockfileText: rendererSnapshotMetadataLock(rendererSnapshotEntry.replace(
      "      scheduler: 0.27.0\n",
      "      scheduler: 0.27.0\n    optionalDependencies:\n      react-is: 19.2.8\n",
    )),
  }));
  assertKnownNonconformant("authorised closure metadata drift", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "sha512-s5un28nYxKJw5gvUHyW5PCC28CvBqLu9r3cWgzHT4Vo/5fqqkFcdRYsGcKf50WMPpjjFZS5d76fn3YCo2njKwQ==",
      "sha512-" + "B".repeat(86) + "==",
    ),
  }));
  assertIncomplete("direct package version mismatch", audit({
    candidateLockfileText: rendererIdentityLock("19.2.80(react@19.2.8)", "react-test-renderer@19.2.80(react@19.2.8)", "react-test-renderer@19.2.80:"),
  }));
  assertIncomplete("textual prefix or suffix collision", audit({
    candidateLockfileText: rendererIdentityLock("19.2.8-suffix(react@19.2.8)", "react-test-renderer@19.2.8-suffix(react@19.2.8)", "react-test-renderer@19.2.8-suffix:"),
  }));
  assertIncomplete("ambiguous package locator", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "  react-test-renderer@19.2.8:\n",
      "  react-test-renderer@19.2.8(react@19.2.8): {}\n  react-test-renderer@19.2.8:\n",
    ),
  }));
  assertIncomplete("ambiguous snapshot dependency locator", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "  react-test-renderer@19.2.8(react@19.2.8):\n    dependencies:\n      react: 19.2.8\n      react-is: 19.2.8\n      scheduler: 0.27.0\n",
      "  react-test-renderer@19.2.8(react@19.2.8):\n    dependencies:\n      react: 19.2.8\n      react-is: 19.2.8\n      scheduler: 0.27.0\n    optionalDependencies:\n      react: 19.2.80\n",
    ),
  }));
  assertNonconformant("missing integrity", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "  react-test-renderer@19.2.8:\n    resolution: {integrity: sha512-GHKPaDRaNYU24PHTLG8Bx8VMY9t+qNfxQbt/Yjp7aMWBkKU6766SR0n6TnYu7P5I1MfEuAMUadqiyDHyI4Yy9Q==}\n",
      "  react-test-renderer@19.2.8:\n    resolution: {}\n",
    ),
  }));
  assertNonconformant("integrity mismatch", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "sha512-GHKPaDRaNYU24PHTLG8Bx8VMY9t+qNfxQbt/Yjp7aMWBkKU6766SR0n6TnYu7P5I1MfEuAMUadqiyDHyI4Yy9Q==",
      "sha512-AAAA",
    ),
  }));
  assertNonconformant("runtime import", audit({
    sourceFiles: { ...sourceFiles, "src/runtime.ts": 'import "react-test-renderer";' },
  }));

  const productionPackage = JSON.parse(candidatePackageText) as Record<string, unknown>;
  productionPackage.dependencies = {
    ...(productionPackage.dependencies as Record<string, string>),
    [packageName]: packageVersion,
  };
  assertNonconformant("production-graph overlap", audit({
    candidatePackageText: JSON.stringify(productionPackage, null, 2) + "\n",
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "      sharp:\n",
      "      react-test-renderer:\n        specifier: 19.2.8\n        version: 19.2.8(react@19.2.8)\n      sharp:\n",
    ),
  }));
  assertNonconformant("unrelated lockfile entry", audit({
    candidateLockfileText: replaceOnce(
      candidateLockfileText,
      "sha512-DTg4MJbGMWkfi6VZFdNt2/caMbQy4Ou+Op/hJQvGEWcnVfoA1QA+xzRKAzw9jD6+GVOOeYr/mIcuDSdug6F6+w==",
      "sha512-" + "A".repeat(86) + "==",
    ),
  }));
  assertNonconformant("missing Web authority", audit({
    dependencyAuthority: { authorityRefs: [] },
  }));
  assertIncomplete("missing expected authority metadata", audit({
    dependencyAuthority: { expectedMetadata: undefined },
  }));
  const ambiguousExpectedMetadata = {
    ...S4_G3_AUTHORIZED_DEPENDENCY_METADATA,
    packageEntries: [
      ...S4_G3_AUTHORIZED_DEPENDENCY_METADATA.packageEntries,
      S4_G3_AUTHORIZED_DEPENDENCY_METADATA.packageEntries[0],
    ],
  };
  assertIncomplete("ambiguous expected authority metadata", audit({
    dependencyAuthority: {
      expectedMetadata: {
        ...ambiguousExpectedMetadata,
        metadataSha256: s4DependencyMetadataReferenceHash(ambiguousExpectedMetadata),
      },
    },
  }));
});

test("S4 mask and preservation fixtures use deterministic exact geometry", async () => {
  const first = materializeS4Mask(EDIT_PRIMITIVES);
  const second = materializeS4Mask(EDIT_PRIMITIVES);
  assert.equal(first.maskIdentityHash, second.maskIdentityHash);
  assert.equal(first.rasterSha256, second.rasterSha256);
  assert.equal(first.providerPngSha256, second.providerPngSha256);
  assert.ok(first.editablePixelCount >= 256);
  assert.ok(first.comparisonPixelCount >= 65_536);
  assert.throws(() => materializeS4Mask([]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_INVALID");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 1, heightQ16: 1 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_AREA_TOO_SMALL");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 65_536, heightQ16: 65_536 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_FULL_IMAGE");
  assert.throws(() => materializeS4Mask([{ kind: "rectangle", xQ16: 0, yQ16: 0, widthQ16: 60_000, heightQ16: 60_000 }]), (error: unknown) => error instanceof AppError && error.code === "S4_MASK_AREA_TOO_LARGE");

  const sourceBytes = await createExactS3FixturePng();
  const outputBytes = await editedFixturePng();
  const run = await evaluateS4Preservation({
    preservationCheckId: randomUUID(), editId: randomUUID(), sourceBytes, outputBytes,
    sourceSha256: sha256(sourceBytes), outputSha256: sha256(outputBytes),
    maskRaster: first.raster, maskIdentityHash: first.maskIdentityHash,
  });
  assert.equal(run.status, "PASS");
  assert.equal(run.noOpDetected, false);
  assert.equal(run.differingPixelCount, 0);
  assert.equal(run.evidence.status, "PASS");
});

test("S4 successful edit persists one stage, one cycle, and activates through the shared pointer", async () => {
  const value = await fixture();
  try {
    const selected = await ready(value);
    const admission = admit(value, selected);
    assert.equal(admission.replayed, false);
    const state = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    assert.equal(state.stageStatus, "started");
    assert.equal(state.s3RefinementClosed, true);
    assert.equal(state.cyclesConsumed, 1);
    assert.equal(state.cyclesRemaining, 1);
    assert.equal(state.activeRevisionKind, "s4");
    assert.equal(state.activeQuality, "PASS");
    assert.equal(state.edits.length, 1);
    assert.equal(state.edits[0].maskReady, true);
    assert.equal(state.edits[0].preservationStatus, "PASS");
    assert.equal(state.edits[0].assessment?.status, "PASS");
    assert.equal(value.repository.state().s4ImageOperations.length, 1);
    assert.equal(value.repository.state().s4AssessmentAttempts.length, 1);
    assert.equal(value.repository.state().s3Selections[0].activeRevisionId, state.activeRevisionId);
    validateS4Graph(value.repository.state());
    validateS4Collections({
      s4Stages: value.repository.state().s4Stages,
      s4Masks: value.repository.state().s4Masks,
      s4Edits: value.repository.state().s4Edits,
      s4Revisions: value.repository.state().s4Revisions,
      s4Assets: value.repository.state().s4Assets,
      s4ImageOperations: value.repository.state().s4ImageOperations,
      s4PreservationChecks: value.repository.state().s4PreservationChecks,
      s4Assessments: value.repository.state().s4Assessments,
      s4AssessmentAttempts: value.repository.state().s4AssessmentAttempts,
      s4Publications: value.repository.state().s4Publications,
      s4Transitions: value.repository.state().s4Transitions,
    }, value.repository.state());
    const resolved = resolveActiveVisualRevision(value.repository.state(), value.projectId, value.objects);
    assert.equal(resolved?.kind, "s4");
    assert.equal(resolved?.revisionId, state.activeRevisionId);
    const preview = await value.service.s3.getPreview(value.projectId, state.activeRevisionId!);
    assert.equal(preview.bytes.equals(value.outputBytes), true);
    const persisted = value.repository.state();
    const revision = persisted.s4Revisions[0];
    const asset = persisted.s4Assets[0];
    assert.ok(revision && asset);
    await proveS4Variants("REVISION-001", "S4 successful edit persists one stage, one cycle, and activates through the shared pointer", "successful-s4-revision", "The executed lifecycle assertion established one immutable S4 revision identity or projection.", {
      "s4-own": () => { assert.equal(state.activeRevisionKind, "s4"); assert.equal(revision.kind, "s4_local_edit"); },
      "immutable": () => { assert.equal(persisted.s4Revisions.length, 1); assert.equal(persisted.s4Assets.length, 1); },
      "parent-exact": () => { assert.equal(revision.parentRevisionId, admission.result.baseRevisionId); assert.equal(revision.parentRevisionKind, "s3"); },
      "lineage": () => assert.equal(revision.lineageRootRevisionId, persisted.s4Stages[0].lineageRootRevisionId),
      "no-copy": () => assert.notEqual(revision.sourceAssetId, revision.outputAssetId),
      "derived-activation": () => assert.equal(persisted.s4Transitions.some((item) => item.phase === "activation" && item.resultingRevisionId === revision.revisionId), true),
      "historical-projection": () => assert.equal(state.edits[0].activationState, "active_tip"),
      "asset-link": () => { assert.equal(asset.revisionId, revision.revisionId); assert.equal(preview.bytes.byteLength, asset.normalizedBytes); },
    }, [
      "s4Revisions=" + persisted.s4Revisions.length,
      "s4Assets=" + persisted.s4Assets.length,
      "activeRevisionKind=" + state.activeRevisionKind,
      "previewHash=" + sha256(preview.bytes),
    ]);
    const handoff = value.service.s4.toS5Handoff(value.projectId);
    assert.equal(handoff.activeRevisionId, state.activeRevisionId);
    assert.equal(handoff.activeRevisionKind, "s4");
    assert.equal(handoff.quality, "PASS");
    assert.equal(handoff.s4CyclesConsumed, 1);
    await proveS4Variants("S5-001", "S4 successful edit persists one stage, one cycle, and activates through the shared pointer", "s5-handoff", "The executed handoff assertion established one optional S5 projection boundary without an S5 write.", {
      "optional": () => assert.equal(handoff.s4StageStatus, "started"),
      "active-s3": () => assert.equal(handoff.activeRevisionKind === "s3", false),
      "active-s4": () => assert.equal(handoff.activeRevisionKind, "s4"),
      "quality": () => assert.equal(handoff.quality, "PASS"),
      "selection-version": () => assert.equal(handoff.selectionVersion, state.selectionVersion),
      "projection": () => assert.equal(handoff.activeRevisionId, state.activeRevisionId),
      "no-s5": () => assert.deepEqual({ approvalEvents: value.repository.state().s5ApprovalEvents, artifacts: value.repository.state().s5Artifacts }, { approvalEvents: [], artifacts: [] }),
    });
    assert.throws(() => value.service.s3.refine(value.projectId, state.activeRevisionId!, state.selectionVersion, "S3 must be closed", randomUUID(), randomUUID()), (error: unknown) => error instanceof AppError && error.code === "S3_LINEAGE_CONFLICT");
  } finally { cleanup(value); }
});

test("S4 pre-dispatch preflight keeps local failures not_started and recovers the same attempt", async () => {
  const missingImageMethod = await fixture();
  const missingAssessmentMethod = await fixture();
  const missingImageConfig = await fixture();
  let missingAssessmentConfig!: S4Fixture;
  let missingAssessmentProvider!: OpenAIS4Provider;
  const missingAssessmentFetchUrls: string[] = [];
  missingAssessmentProvider = new OpenAIS4Provider({
    apiKey: "",
    fetchImpl: async (input) => {
      missingAssessmentFetchUrls.push(String(input));
      return new Response("{}", { status: 200 });
    },
  });
  missingAssessmentConfig = await fixture({
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "before-dispatch" && "assessmentAttemptId" in operation) {
        missingAssessmentConfig.s4Provider.runS4Assessment = missingAssessmentProvider.runS4Assessment.bind(missingAssessmentProvider);
        missingAssessmentConfig.s4Provider.assertS4AssessmentReady = missingAssessmentProvider.assertS4AssessmentReady.bind(missingAssessmentProvider);
      }
    },
  });
  const missingImageFetchUrls: string[] = [];
  const correctedImageFetch: typeof fetch = async (input) => {
    const url = String(input);
    missingImageFetchUrls.push(url);
    if (url.endsWith("/images/edits")) {
      return new Response(JSON.stringify({ data: [{ b64_json: missingImageConfig.outputBytes.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "synthetic-assessment", output_text: JSON.stringify(s4AssessmentPayload(missingImageConfig.repository)) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const missingImageProvider = new OpenAIS4Provider({ apiKey: "", fetchImpl: correctedImageFetch });
  const correctedImageProvider = new OpenAIS4Provider({ apiKey: "synthetic-" + "test-key", fetchImpl: correctedImageFetch });
  try {
    const missingImageMethodOriginal = missingImageMethod.s4Provider.runS4ImageEdit;
    delete (missingImageMethod.s4Provider as Partial<S4ProviderContract>).runS4ImageEdit;
    const missingImageSelected = await ready(missingImageMethod);
    admit(missingImageMethod, missingImageSelected, "missing image provider method");
    const missingImageQueued = await waitFor(() => missingImageMethod.repository.state(), (state) => state.s4ImageOperations[0]?.status === "queued" && state.s4ImageOperations[0]?.providerDispatchState === "not_started");
    const missingImageOperation = missingImageQueued.s4ImageOperations[0];
    assert.ok(missingImageOperation);
    assert.equal(missingImageOperation.attempt, 1);
    assert.equal(missingImageOperation.providerDispatchState, "not_started");
    assert.equal(missingImageOperation.claimedBy, null);
    assert.equal(missingImageOperation.claimedProcessId, null);
    assert.equal(missingImageMethod.imageCallCount(), 0);
    assert.equal(missingImageQueued.s4ImageOperations.length, 1);
    assert.equal(missingImageQueued.s4Edits.length, 1);
    assert.equal(missingImageQueued.s4Stages[0].cyclesConsumed, 1);
    missingImageMethod.s4Provider.runS4ImageEdit = missingImageMethodOriginal;
    const missingImageRecovered = restart(missingImageMethod, { processId: 8601, isProcessAlive: (processId) => processId === 8601 });
    const missingImageDone = await waitFor(() => missingImageRecovered.s4.getState(missingImageMethod.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const missingImageAfter = missingImageMethod.repository.state();
    assert.equal(missingImageAfter.s4ImageOperations[0].operationId, missingImageOperation.operationId);
    assert.equal(missingImageAfter.s4ImageOperations[0].attempt, 1);
    assert.equal(missingImageAfter.s4ImageOperations[0].providerDispatchState, "consumed");
    assert.equal(missingImageMethod.imageCallCount(), 1);
    assert.equal(missingImageDone.activeRevisionKind, "s4");

    const missingAssessmentMethodOriginal = missingAssessmentMethod.s4Provider.runS4Assessment;
    delete (missingAssessmentMethod.s4Provider as Partial<S4ProviderContract>).runS4Assessment;
    const missingAssessmentSelected = await ready(missingAssessmentMethod);
    admit(missingAssessmentMethod, missingAssessmentSelected, "missing assessment provider method");
    const missingAssessmentQueued = await waitFor(() => missingAssessmentMethod.repository.state(), (state) => state.s4AssessmentAttempts[0]?.status === "queued" && state.s4AssessmentAttempts[0]?.providerDispatchState === "not_started");
    const missingAssessmentAttempt = missingAssessmentQueued.s4AssessmentAttempts[0];
    assert.ok(missingAssessmentAttempt);
    assert.equal(missingAssessmentAttempt.attempt, 1);
    assert.equal(missingAssessmentAttempt.providerDispatchState, "not_started");
    assert.equal(missingAssessmentAttempt.claimedBy, null);
    assert.equal(missingAssessmentMethod.assessmentCallCount(), 0);
    assert.equal(missingAssessmentQueued.s4AssessmentAttempts.length, 1);
    assert.equal(missingAssessmentQueued.s4Edits.length, 1);
    missingAssessmentMethod.s4Provider.runS4Assessment = missingAssessmentMethodOriginal;
    const missingAssessmentRecovered = restart(missingAssessmentMethod, { processId: 8602, isProcessAlive: (processId) => processId === 8602 });
    const missingAssessmentDone = await waitFor(() => missingAssessmentRecovered.s4.getState(missingAssessmentMethod.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const missingAssessmentAfter = missingAssessmentMethod.repository.state();
    assert.equal(missingAssessmentAfter.s4AssessmentAttempts[0].assessmentAttemptId, missingAssessmentAttempt.assessmentAttemptId);
    assert.equal(missingAssessmentAfter.s4AssessmentAttempts[0].attempt, 1);
    assert.equal(missingAssessmentAfter.s4AssessmentAttempts[0].providerDispatchState, "consumed");
    assert.equal(missingAssessmentMethod.assessmentCallCount(), 1);
    assert.equal(missingAssessmentDone.activeRevisionKind, "s4");

    assert.throws(() => missingImageProvider.assertS4ImageEditReady(), (error: unknown) => error instanceof ProviderFailure && error.safeCode === "PROVIDER_NOT_CONFIGURED");
    const missingImageConfigSelected = await ready(missingImageConfig);
    missingImageConfig.service = createWorkflowService({
      repository: missingImageConfig.repository,
      objects: missingImageConfig.objects,
      provider: missingImageConfig.provider,
      s4Provider: missingImageProvider,
    });
    const configAdmission = admit(missingImageConfig, missingImageConfigSelected, "missing image configuration");
    const configQueued = await waitFor(() => missingImageConfig.repository.state(), (state) => state.s4ImageOperations[0]?.status === "queued" && state.s4ImageOperations[0]?.providerDispatchState === "not_started");
    const configOperation = configQueued.s4ImageOperations[0];
    assert.ok(configOperation);
    assert.equal(configOperation.attempt, 1);
    assert.equal(configOperation.providerDispatchState, "not_started");
    assert.equal(missingImageFetchUrls.length, 0);
    assert.equal(configQueued.s4ImageOperations.length, 1);
    assert.equal(configQueued.s4Stages[0].cyclesConsumed, configAdmission.result.cyclesConsumed);
    const configRecovered = restart(missingImageConfig, { processId: 8603, isProcessAlive: (processId) => processId === 8603, s4Provider: correctedImageProvider });
    const configDone = await waitFor(() => configRecovered.s4.getState(missingImageConfig.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const configAfter = missingImageConfig.repository.state();
    assert.equal(configAfter.s4ImageOperations[0].operationId, configOperation.operationId);
    assert.equal(configAfter.s4ImageOperations[0].attempt, 1);
    assert.equal(configAfter.s4ImageOperations[0].providerDispatchState, "consumed");
    assert.equal(missingImageFetchUrls.filter((url) => url.endsWith("/images/edits")).length, 1);
    assert.equal(configAfter.s4ImageOperations.length, 1);
    assert.equal(configDone.activeRevisionKind, "s4");

    assert.throws(() => missingAssessmentProvider.assertS4AssessmentReady(), (error: unknown) => error instanceof ProviderFailure && error.safeCode === "PROVIDER_NOT_CONFIGURED");
    const missingAssessmentConfigSelected = await ready(missingAssessmentConfig);
    admit(missingAssessmentConfig, missingAssessmentConfigSelected, "missing assessment configuration");
    const assessmentConfigQueued = await waitFor(() => missingAssessmentConfig.repository.state(), (state) => state.s4AssessmentAttempts[0]?.status === "queued" && state.s4AssessmentAttempts[0]?.providerDispatchState === "not_started");
    const assessmentConfigAttempt = assessmentConfigQueued.s4AssessmentAttempts[0];
    assert.ok(assessmentConfigAttempt);
    assert.equal(assessmentConfigAttempt.attempt, 1);
    assert.equal(assessmentConfigAttempt.providerDispatchState, "not_started");
    assert.equal(missingAssessmentFetchUrls.length, 0);
    const correctedAssessmentProvider = new OpenAIS4Provider({
      apiKey: "synthetic-" + "test-key",
      fetchImpl: async (input) => {
        missingAssessmentFetchUrls.push(String(input));
        return new Response(JSON.stringify({ id: "synthetic-assessment", output_text: JSON.stringify(s4AssessmentPayload(missingAssessmentConfig.repository)) }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const correctedAssessmentProviderContract: S4ProviderContract = {
      runS4ImageEdit: missingAssessmentConfig.s4Provider.runS4ImageEdit,
      runS4Assessment: correctedAssessmentProvider.runS4Assessment.bind(correctedAssessmentProvider),
      assertS4AssessmentReady: correctedAssessmentProvider.assertS4AssessmentReady.bind(correctedAssessmentProvider),
    };
    const assessmentConfigRecovered = restart(missingAssessmentConfig, { processId: 8604, isProcessAlive: (processId) => processId === 8604, s4Provider: correctedAssessmentProviderContract });
    const assessmentConfigDone = await waitFor(() => assessmentConfigRecovered.s4.getState(missingAssessmentConfig.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const assessmentConfigAfter = missingAssessmentConfig.repository.state();
    assert.equal(assessmentConfigAfter.s4AssessmentAttempts[0].assessmentAttemptId, assessmentConfigAttempt.assessmentAttemptId);
    assert.equal(assessmentConfigAfter.s4AssessmentAttempts[0].attempt, 1);
    assert.equal(assessmentConfigAfter.s4AssessmentAttempts[0].providerDispatchState, "consumed");
    assert.equal(missingAssessmentFetchUrls.filter((url) => url.endsWith("/responses")).length, 1);
    assert.equal(missingAssessmentConfig.imageCallCount(), 1);
    assert.equal(assessmentConfigAfter.s4AssessmentAttempts.length, 1);
    assert.equal(assessmentConfigDone.activeRevisionKind, "s4");

    await proveS4Variants("RECOVERY-001", "S4 pre-dispatch preflight keeps local failures not_started and recovers the same attempt", "pre-dispatch-preflight", "The executed image and assessment missing-method and missing-configuration fixtures completed no transport before preflight, preserved not_started accounting, and recovered the original attempt exactly once after local correction.", {
      "pre-dispatch": () => {
        assert.equal(missingImageOperation.providerDispatchState, "not_started");
        assert.equal(missingAssessmentAttempt.providerDispatchState, "not_started");
        assert.equal(configOperation.providerDispatchState, "not_started");
        assert.equal(assessmentConfigAttempt.providerDispatchState, "not_started");
        assert.equal(missingImageMethod.imageCallCount(), 1);
        assert.equal(missingAssessmentMethod.assessmentCallCount(), 1);
        assert.equal(missingImageFetchUrls.filter((url) => url.endsWith("/images/edits")).length, 1);
        assert.equal(missingAssessmentFetchUrls.filter((url) => url.endsWith("/responses")).length, 1);
        assert.equal(missingImageAfter.s4ImageOperations.length, 1);
        assert.equal(missingAssessmentAfter.s4AssessmentAttempts.length, 1);
        assert.equal(configAfter.s4ImageOperations.length, 1);
        assert.equal(assessmentConfigAfter.s4AssessmentAttempts.length, 1);
      },
    }, [
      "missingImageMethodCalls=0-before/1-after",
      "missingAssessmentMethodCalls=0-before/1-after",
      "missingImageConfigFetches=0-before/1-image-after",
      "missingAssessmentConfigFetches=0-before/1-response-after",
      "sameAttempt=true",
      "newCycle=false",
    ]);
  } finally {
    cleanup(missingImageMethod);
    cleanup(missingAssessmentMethod);
    cleanup(missingImageConfig);
    cleanup(missingAssessmentConfig);
  }
});

test("S4 object publication is exclusive under a competing writer and exact recovery", async () => {
  const raceRoot = mkdtempSync(join(tmpdir(), "swooshz-s4-store-race-"));
  const objects = new PrivateObjectStore(join(raceRoot, "objects"));
  const barrier = join(raceRoot, "race.barrier");
  const raceKey = "projects/" + FOREIGN_UUID + "/s4/race.bin";
  const firstBytes = Buffer.from("complete-object-first");
  const secondBytes = Buffer.from("complete-object-second");
  let publicationFixture: S4Fixture | null = null;
  let directRaceFixture: S4Fixture | null = null;
  try {
    const outcomes = await Promise.all([
      runStoreRaceWriter(objects.root, barrier, raceKey, firstBytes),
      runStoreRaceWriter(objects.root, barrier, raceKey, secondBytes),
    ]);
    const winners = outcomes.filter((value) => value.startsWith("won:"));
    const losers = outcomes.filter((value) => value === "lost:PERSISTENCE_FAILED");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const finalRaceBytes = objects.read(raceKey);
    const finalRaceHash = sha256(finalRaceBytes);
    assert.equal(winners[0], "won:" + finalRaceHash);
    assert.equal(finalRaceBytes.equals(firstBytes) || finalRaceBytes.equals(secondBytes), true);

    const existingKey = "projects/" + FOREIGN_UUID + "/s4/existing.bin";
    const existingBytes = Buffer.from("existing-object");
    const conflictingBytes = Buffer.from("different-object");
    objects.put(existingKey, existingBytes);
    assert.throws(() => objects.putExact(existingKey, conflictingBytes), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
    assert.equal(objects.read(existingKey).equals(existingBytes), true);
    const conflictingStageKey = "projects/" + FOREIGN_UUID + "/s4/staging-conflict.bin";
    objects.put(conflictingStageKey, conflictingBytes);
    assert.throws(() => objects.promoteExact(conflictingStageKey, existingKey, conflictingBytes), (error: unknown) => error instanceof AppError && error.code === "PUBLICATION_OBJECT_MISMATCH");
    assert.equal(objects.read(existingKey).equals(existingBytes), true);
    assert.equal(objects.read(conflictingStageKey).equals(conflictingBytes), true);
    const identicalStageKey = "projects/" + FOREIGN_UUID + "/s4/staging-identical.bin";
    objects.put(identicalStageKey, existingBytes);
    objects.putExact(existingKey, existingBytes);
    objects.promoteExact(identicalStageKey, existingKey, existingBytes);
    assert.equal(objects.read(existingKey).equals(existingBytes), true);
    objects.remove(conflictingStageKey);
    objects.remove(identicalStageKey);

    const genericStageKey = "projects/" + FOREIGN_UUID + "/s4/staging-generic.bin";
    const genericFinalKey = "projects/" + FOREIGN_UUID + "/s4/final-generic.bin";
    objects.put(genericStageKey, existingBytes);
    const originalPromote = objects.promote.bind(objects);
    objects.promote = () => { throw new AppError(500, "PERSISTENCE_FAILED"); };
    try {
      assert.throws(() => objects.promoteExact(genericStageKey, genericFinalKey, existingBytes), (error: unknown) => error instanceof AppError && error.code === "PERSISTENCE_FAILED");
    } finally {
      objects.promote = originalPromote;
    }
    assert.equal(objects.exists(genericFinalKey), false);
    assert.equal(objects.read(genericStageKey).equals(existingBytes), true);
    objects.remove(genericStageKey);

    directRaceFixture = await fixture();
    const directRaceSelected = await ready(directRaceFixture);
    const directRaceConflict = Buffer.from("direct-race-winning-bytes");
    const originalPromoteExact = directRaceFixture.objects.promoteExact.bind(directRaceFixture.objects);
    directRaceFixture.objects.promoteExact = (stagingKey: string, finalKey: string, expected: Uint8Array): void => {
      directRaceFixture!.objects.put(finalKey, directRaceConflict);
      originalPromoteExact(stagingKey, finalKey, expected);
    };
    admit(directRaceFixture, directRaceSelected, "publication direct race");
    const directRaceState = await waitFor(() => directRaceFixture!.repository.state(), (state) => state.s4ImageOperations[0]?.status === "failed");
    directRaceFixture.objects.promoteExact = originalPromoteExact;
    const directRacePublication = directRaceState.s4Publications[0];
    const directRaceOperation = directRaceState.s4ImageOperations[0];
    const directRaceEdit = directRaceFixture.service.s4.getState(directRaceFixture.projectId).edits[0];
    assert.ok(directRacePublication && directRaceOperation && directRaceEdit);
    assert.equal(directRacePublication.state, "aborted");
    assert.equal(directRaceOperation.failureCode, "PUBLICATION_OBJECT_MISMATCH");
    assert.equal(directRaceEdit.status, "publication_failed");
    assert.equal(directRaceEdit.imageRetryAvailable, false);
    assert.equal(directRaceEdit.assessmentRetryAvailable, false);
    assert.equal(directRaceFixture.objects.read(directRacePublication.finalObjects[0].key).equals(directRaceConflict), true);
    assert.equal(directRaceState.s3Selections[0].activeRevisionId, directRaceSelected.sourceRevisionId);
    assert.equal(directRaceState.s4Revisions.length, 0);
    assert.equal(directRaceState.s4Assets.length, 0);
    assert.equal(directRaceState.s4PreservationChecks.length, 0);
    assert.equal(directRaceState.s4Assessments.length, 0);
    assert.equal(directRaceState.s4AssessmentAttempts.length, 0);
    validateS4Graph(directRaceState);

    const stagedReached = deferred<void>();
    publicationFixture = await fixture({
      processId: 8701,
      isProcessAlive: () => true,
      onS4PublicationPhase: (phase) => {
        if (phase === "after-publication-staged") {
          stagedReached.resolve();
          return "interrupt";
        }
      },
    });
    const selected = await ready(publicationFixture);
    admit(publicationFixture, selected, "publication competing writer");
    await stagedReached.promise;
    const stagedState = publicationFixture.repository.state();
    const publication = stagedState.s4Publications[0];
    const stagedOperation = stagedState.s4ImageOperations[0];
    assert.ok(publication && stagedOperation);
    assert.equal(publication.state, "staged");
    const publicationConflict = Buffer.from("conflicting-final-publication");
    publicationFixture.objects.put(publication.finalObjects[0].key, publicationConflict);
    const recovered = restart(publicationFixture, { processId: 8702, isProcessAlive: (processId) => processId === 8702 });
    const recoveredState = await waitFor(() => publicationFixture!.repository.state(), (state) => state.s4ImageOperations[0]?.status === "failed");
    assert.equal(recovered.s4.getState(publicationFixture.projectId).edits[0]?.status, "publication_failed");
    assert.equal(recoveredState.s4Publications[0].state, "aborted");
    assert.equal(recoveredState.s4ImageOperations[0].failureCode, "PUBLICATION_OBJECT_MISMATCH");
    assert.equal(recoveredState.s4ImageOperations[0].providerDispatchState, "consumed");
    assert.equal(publicationFixture.objects.read(publication.finalObjects[0].key).equals(publicationConflict), true);
    assert.equal(publicationFixture.objects.exists(publication.stagingObjects[0].key), false);
    assert.equal(recoveredState.s4Revisions.length, 0);
    assert.equal(recoveredState.s4Assets.length, 0);
    assert.equal(recoveredState.s4PreservationChecks.length, 0);
    assert.equal(recoveredState.s4Assessments.length, 0);
    assert.equal(recoveredState.s4AssessmentAttempts.length, 0);
    assert.equal(recoveredState.s3Selections[0].activeRevisionId, selected.sourceRevisionId);
    const recoveredEdit = recovered.s4.getState(publicationFixture.projectId).edits[0];
    assert.ok(recoveredEdit);
    assert.equal(recoveredEdit.imageRetryAvailable, false);
    assert.equal(recoveredEdit.assessmentRetryAvailable, false);
    validateS4Graph(recoveredState);
    await proveS4Variants("RECOVERY-001", "S4 object publication is exclusive under a competing writer and exact recovery", "publication-competing-writer", "The executed competing-writer and publication-recovery fixtures preserved complete winning bytes, rejected conflicting exact publication, accepted identical recovery, and aborted a conflicting final without fake activation.", {
      "no-overwrite": () => {
        assert.equal(finalRaceHash, winners[0].slice(4));
        assert.equal(directRaceOperation.failureCode, "PUBLICATION_OBJECT_MISMATCH");
        assert.equal(directRacePublication.state, "aborted");
        assert.equal(directRaceFixture!.objects.read(directRacePublication.finalObjects[0].key).equals(directRaceConflict), true);
        assert.equal(directRaceEdit.status, "publication_failed");
        assert.equal(directRaceEdit.imageRetryAvailable, false);
        assert.equal(directRaceEdit.assessmentRetryAvailable, false);
        assert.equal(directRaceState.s4Revisions.length, 0);
        assert.equal(directRaceState.s4Assets.length, 0);
        assert.equal(directRaceState.s4PreservationChecks.length, 0);
        assert.equal(directRaceState.s4AssessmentAttempts.length, 0);
        assert.equal(directRaceState.s3Selections[0].activeRevisionId, directRaceSelected.sourceRevisionId);
        assert.equal(publicationFixture!.objects.read(publication.finalObjects[0].key).equals(publicationConflict), true);
        assert.equal(recoveredState.s4Publications[0].state, "aborted");
        assert.equal(recoveredState.s4ImageOperations[0].failureCode, "PUBLICATION_OBJECT_MISMATCH");
        assert.equal(recoveredEdit.imageRetryAvailable, false);
        assert.equal(recoveredEdit.assessmentRetryAvailable, false);
        assert.equal(recoveredState.s4Revisions.length, 0);
        assert.equal(recoveredState.s4Assets.length, 0);
        assert.equal(recoveredState.s4PreservationChecks.length, 0);
        assert.equal(recoveredState.s4Assessments.length, 0);
        assert.equal(recoveredState.s4AssessmentAttempts.length, 0);
        assert.equal(recoveredState.s3Selections[0].activeRevisionId, selected.sourceRevisionId);
      },
    }, [
      "raceWinnerHash=" + finalRaceHash,
      "raceLoser=PERSISTENCE_FAILED",
      "putExactConflictHash=" + sha256(existingBytes),
      "promoteExactConflictCode=PUBLICATION_OBJECT_MISMATCH",
      "genericStorageFailureCode=PERSISTENCE_FAILED",
      "directRaceFailureCode=" + directRaceOperation.failureCode,
      "directRaceWinnerHash=" + sha256(directRaceConflict),
      "recoveryRaceFailureCode=" + recoveredState.s4ImageOperations[0].failureCode,
      "publicationConflictHash=" + sha256(publicationConflict),
    ]);
  } finally {
    if (directRaceFixture) cleanup(directRaceFixture);
    if (publicationFixture) cleanup(publicationFixture);
    rmSync(raceRoot, { recursive: true, force: true });
  }
});

test("S4 client draft readiness enforces local mask and instruction bounds", () => {
  const validRectangle = { kind: "rectangle" as const, xQ16: 0, yQ16: 1, widthQ16: 65_536, heightQ16: 1 };
  const validBrush = { kind: "brush" as const, radiusQ8: 64, points: [{ xQ16: 65_536, yQ16: 0 }] };
  assert.equal(isS4PrimitiveLocallyValid(validRectangle), true);
  assert.equal(isS4PrimitiveLocallyValid(validBrush), true);
  assert.equal(isS4PrimitiveLocallyValid({ ...validRectangle, widthQ16: 0 }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validRectangle, xQ16: 1, widthQ16: 65_536 }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validRectangle, yQ16: 1, heightQ16: 65_536 }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validBrush, radiusQ8: 63 }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validBrush, points: [{ xQ16: 65_537, yQ16: 0 }] }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validBrush, points: [{ xQ16: 65_536, yQ16: 0 }, { xQ16: 65_536, yQ16: 0 }] }), false);
  assert.equal(isS4PrimitiveLocallyValid({ ...validBrush, points: Array.from({ length: 1_025 }, () => ({ xQ16: 1, yQ16: 1 })) }), false);
  const tooManyBrushPoints = Array.from({ length: 5 }, (_, index) => ({ kind: "brush" as const, radiusQ8: 64 + index, points: Array.from({ length: 1_024 }, () => ({ xQ16: index, yQ16: index })) }));
  assert.equal(isS4DraftSubmitReady({ primitives: tooManyBrushPoints, instructionText: "edit", hasActiveRevision: true, cyclesRemaining: 1 }), false);
  const atScalarAndByteLimit = instructionDraftState("😀".repeat(600));
  assert.deepEqual(atScalarAndByteLimit, { scalarCount: 600, utf8ByteCount: 2_400, valid: true });
  assert.equal(instructionDraftState("😀".repeat(601)).valid, false);
  assert.equal(instructionDraftState("\ud800").valid, false);
  assert.equal(instructionDraftState("   ").valid, false);
  for (const control of ["\u0080", "\u061c", "\u200e", "\u2060", "\u202a", "\u2066", "\ufeff"]) {
    assert.equal(instructionDraftState(control).valid, false);
  }
  const readyInput = { primitives: [validRectangle], instructionText: "edit", hasActiveRevision: true, cyclesRemaining: 1 };
  assert.equal(isS4DraftSubmitReady({ ...readyInput, primitives: [] }), false);
  assert.equal(isS4DraftSubmitReady({ ...readyInput, primitives: [validRectangle] }), true);
  assert.equal(isS4DraftSubmitReady({ ...readyInput, primitives: [validRectangle, validRectangle] }), false);
  assert.equal(isS4DraftSubmitReady({ ...readyInput, cyclesRemaining: 0 }), false);
  assert.equal(isS4DraftSubmitReady({ ...readyInput, busy: true }), false);
  assert.equal(isS4DraftClearEnabled([], false), false);
  assert.equal(isS4DraftClearEnabled([validRectangle], false), true);
  assert.equal(isS4DraftClearEnabled([validRectangle], true), false);
  const markup = renderToStaticMarkup(createElement(S4Screen, {
    projectId: FOREIGN_UUID,
    initialState: {
      projectId: FOREIGN_UUID,
      generationSetId: randomUUID(),
      selectionVersion: 1,
      activeRevisionId: randomUUID(),
      activeRevisionKind: "s3",
      activeQuality: "PASS",
      activePreviewAvailable: false,
      stageStatus: "started",
      s3RefinementClosed: true,
      cyclesConsumed: 1,
      cyclesRemaining: 1,
      edits: [],
    },
  }));
  assert.match(markup, /0\/600 Unicode scalar values \/ 0\/2400 UTF-8 bytes/);
  assert.match(markup, /Clear local mask/);
  assert.match(markup, /Submit local edit/);
  assert.match(markup, /disabled=""[^>]*>Clear local mask|disabled=""[^>]*>Submit local edit/);
});

test("S4 high-risk resolver matrix resolves exact S3 and S4 identities", async () => {
  const value = await fixture();
  try {
    const sourceSelected = await ready(value);
    const sourceResolved = resolveVisualRevision(value.repository.state(), value.projectId, sourceSelected.sourceRevisionId, value.objects);
    const refinementAdmission = value.service.s3.refine(value.projectId, sourceSelected.sourceRevisionId, sourceSelected.selectionVersion, "resolver refinement fixture", randomUUID(), randomUUID());
    await waitFor(() => value.service.s3.getState(value.projectId), (state) => state.cycles[0]?.status === "usable_pass");
    const afterRefinement = value.service.s3.getState(value.projectId);
    assert.ok(afterRefinement.activeRevisionId);
    const refinementResolved = resolveVisualRevision(value.repository.state(), value.projectId, afterRefinement.activeRevisionId, value.objects);
    const selected = { sourceRevisionId: afterRefinement.activeRevisionId, selectionVersion: afterRefinement.selectionVersion };
    const admission = admit(value, selected, "resolver S4 revision fixture");
    const completed = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const persisted = value.repository.state();
    const revision = persisted.s4Revisions[0];
    assert.ok(revision);
    const s4Resolved = resolveVisualRevision(persisted, value.projectId, revision.revisionId, value.objects);
    assert.equal(sourceResolved.kind, "s3");
    assert.equal(refinementResolved.kind, "s3");
    assert.equal(s4Resolved.kind, "s4");

    const duplicate = cloneJson(persisted);
    duplicate.s4Revisions.push(cloneJson(revision));
    const foreignProject = cloneJson(persisted);
    foreignProject.s4Revisions[0].projectId = FOREIGN_UUID;
    const foreignGeneration = cloneJson(persisted);
    foreignGeneration.s4Revisions[0].generationSetId = FOREIGN_UUID;
    const foreignLineage = cloneJson(persisted);
    foreignLineage.s4Revisions[0].lineageRootRevisionId = FOREIGN_UUID;
    const badQuality = cloneJson(persisted);
    badQuality.s4Assessments[0].status = "material_fail";
    const pointerOnly = cloneJson(persisted);
    pointerOnly.s3Selections[0].activeRevisionId = null;
    const publicResolverCases = [
      { name: "missing", state: (() => { const candidate = cloneJson(persisted); candidate.s3Selections[0].activeRevisionId = FOREIGN_UUID; return candidate; })() },
      { name: "duplicate", state: duplicate },
      { name: "cross-boundary", state: foreignProject },
      { name: "invalid-quality", state: badQuality },
    ];
    const publicResolverResponses: Array<{ name: string; status: number; body: any }> = [];
    let publicEditDetailResponse: { status: number; body: any } | null = null;
    const originalRepositoryState = value.repository.state.bind(value.repository);
    const publicDependencies: ApiRequestDependencies = {
      workflowService: value.service,
      s3Authorization: {
        resolveContext: async () => ({ subjectId: "resolver-public-proof" }),
        authorizeProject: async (_context, projectId) => projectId === value.projectId,
      },
    };
    try {
      value.repository.state = () => badQuality;
      const editDetail = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4", "edits", admission.result.editId], publicDependencies);
      const editDetailBody = await editDetail.json();
      publicEditDetailResponse = { status: editDetail.status, body: editDetailBody };
      assert.equal(editDetail.status, 500);
      assert.equal(editDetailBody.error.code, "S4_INTERNAL_ERROR");
      assert.equal(editDetailBody.error.message, "The request could not be completed. Try again or contact support with the reference ID.");
      assert.equal(typeof editDetailBody.error.referenceId, "string");
      assert.equal(editDetailBody.activationState, undefined);
      assert.equal(editDetailBody.previewAvailable, undefined);
      assert.equal(JSON.stringify(editDetailBody).includes("active_tip"), false);
      assert.equal(JSON.stringify(editDetailBody).includes("previewAvailable"), false);
      for (const candidate of publicResolverCases) {
        value.repository.state = () => candidate.state;
        const response = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4"], publicDependencies);
        const body = await response.json();
        publicResolverResponses.push({ name: candidate.name, status: response.status, body });
      }
    } finally {
      value.repository.state = originalRepositoryState;
    }
    for (const result of publicResolverResponses) {
      assert.equal(result.status, 500);
      assert.equal(result.body.error.code, "S4_INTERNAL_ERROR");
      assert.equal(result.body.error.message, "The request could not be completed. Try again or contact support with the reference ID.");
      assert.equal(typeof result.body.error.referenceId, "string");
      assert.equal(result.body.activeRevisionKind, undefined);
      assert.equal(result.body.activeQuality, undefined);
    }

    await proveS4Variants("RESOLVE-001", "S4 high-risk resolver matrix resolves exact S3 and S4 identities", "resolver-matrix", "The executed resolver scenarios established exact positive resolution, fail-closed identity fences, and generic public S4 errors for corrupt active records.", {
      "s3-source": () => assert.equal(sourceResolved.kind, "s3"),
      "s3-refinement": () => { assert.equal(refinementAdmission.result.cycleNumber, 1); assert.equal(refinementResolved.kind, "s3"); assert.notEqual(refinementResolved.revisionId, sourceResolved.revisionId); },
      "s4-revision": () => { assert.equal(s4Resolved.kind, "s4"); assert.equal(completed.activeRevisionId, revision.revisionId); },
      "duplicate-id-fail": () => assert.throws(() => resolveVisualRevision(duplicate, value.projectId, revision.revisionId, value.objects)),
      "foreign-project": () => assert.throws(() => resolveVisualRevision(foreignProject, value.projectId, revision.revisionId, value.objects)),
      "foreign-generation": () => assert.throws(() => resolveVisualRevision(foreignGeneration, value.projectId, revision.revisionId, value.objects)),
      "lineage": () => assert.throws(() => resolveVisualRevision(foreignLineage, value.projectId, revision.revisionId, value.objects)),
      "quality": () => assert.throws(() => resolveVisualRevision(badQuality, value.projectId, revision.revisionId, value.objects)),
      "pointer-only": () => assert.equal(resolveActiveVisualRevision(pointerOnly, value.projectId, value.objects), null),
      "public-kind": () => {
        assert.equal(publicResolverResponses.length, 4);
        assert.equal(publicEditDetailResponse?.status, 500);
        assert.equal(publicEditDetailResponse?.body.error.code, "S4_INTERNAL_ERROR");
        assert.equal(publicEditDetailResponse?.body.activationState, undefined);
        assert.equal(publicEditDetailResponse?.body.previewAvailable, undefined);
        for (const result of publicResolverResponses) {
          assert.equal(result.status, 500);
          assert.equal(result.body.error.code, "S4_INTERNAL_ERROR");
          assert.equal(result.body.activeRevisionKind, undefined);
          assert.equal(result.body.activeQuality, undefined);
        }
      },
    }, [
      "s3SourceRevision=" + sourceResolved.revisionId,
      "s3RefinementRevision=" + refinementResolved.revisionId,
      "s4Revision=" + s4Resolved.revisionId,
      "s4ImageOperations=" + persisted.s4ImageOperations.length,
      "publicResolverCases=" + publicResolverResponses.map((result) => result.name).join(","),
      "publicEditDetailStatus=" + publicEditDetailResponse?.status,
      "publicEditDetailError=" + publicEditDetailResponse?.body.error.code,
      "publicEditDetailNoContradictoryProjection=" + (!JSON.stringify(publicEditDetailResponse?.body).includes("active_tip") && !JSON.stringify(publicEditDetailResponse?.body).includes("previewAvailable")),
      "publicResolverError=S4_INTERNAL_ERROR/status-500",
    ]);
  } finally { cleanup(value); }
});

test("S4 image and assessment retries are explicit, bounded, and preserve the same output identity", async () => {
  const value = await fixture({
    imageResults: [new ProviderFailure("PROVIDER_RATE_LIMIT")],
    assessmentResults: [new ProviderFailure("QA_PROVIDER_EMPTY")],
  });
  try {
    const selected = await ready(value);
    const admission = admit(value, selected, "Retry the marked finish once if the provider fails.");
    const imageRetryState = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "image_retry_available");
    assert.equal(imageRetryState.edits[0].imageRetryAvailable, true);
    value.service.s4.imageRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    const assessmentRetryState = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "assessment_retry_available");
    assert.equal(assessmentRetryState.edits[0].assessmentRetryAvailable, true);
    const before = value.repository.state();
    assert.equal(before.s4ImageOperations.length, 2);
    assert.equal(before.s4AssessmentAttempts.length, 1);
    const beforeAttempt = before.s4AssessmentAttempts[0];
    const beforeAssessment = before.s4Assessments[0];
    const beforeEdit = before.s4Edits[0];
    assert.ok(beforeAttempt && beforeAssessment && beforeEdit);
    const firstOutputAsset = beforeAttempt.outputAssetId;
    const firstOutputHash = beforeAttempt.outputSha256;
    const retryableBeforeRestart = {
      attemptStatus: beforeAttempt.status,
      failureCode: beforeAttempt.failureCode,
      disposition: beforeAttempt.disposition,
      providerDispatchState: beforeAttempt.providerDispatchState,
      assessmentStatus: beforeAssessment.status,
      assessmentRetryState: beforeAssessment.retryState,
      editStatus: beforeEdit.status,
      editRetryState: beforeEdit.retryState,
      outputAssetId: beforeAttempt.outputAssetId,
      outputSha256: beforeAttempt.outputSha256,
      outputRevisionId: beforeAttempt.revisionId,
      imageCalls: value.imageCallCount(),
      assessmentCalls: value.assessmentCallCount(),
    };
    assert.equal(retryableBeforeRestart.providerDispatchState, "consumed");
    assert.equal(retryableBeforeRestart.attemptStatus, "failed");
    assert.equal(retryableBeforeRestart.failureCode, "QA_PROVIDER_EMPTY");
    assert.equal(retryableBeforeRestart.disposition, "qa_unavailable_retryable");
    assert.equal(retryableBeforeRestart.assessmentStatus, "qa_unavailable_retryable");
    assert.equal(retryableBeforeRestart.assessmentRetryState, "available");
    assert.equal(retryableBeforeRestart.editStatus, "assessment_retry_available");
    assert.equal(retryableBeforeRestart.editRetryState, "assessment_available");
    const retryableRestarted = restart(value, { processId: 9102, isProcessAlive: (processId) => processId === 9102 });
    const retryableAfterRestart = value.repository.state();
    const retryableRestartState = retryableRestarted.s4.getState(value.projectId);
    const retryableAttemptAfterRestart = retryableAfterRestart.s4AssessmentAttempts[0];
    const retryableAssessmentAfterRestart = retryableAfterRestart.s4Assessments[0];
    const retryableEditAfterRestart = retryableAfterRestart.s4Edits[0];
    assert.ok(retryableAttemptAfterRestart && retryableAssessmentAfterRestart && retryableEditAfterRestart);
    assert.equal(retryableAttemptAfterRestart.status, retryableBeforeRestart.attemptStatus);
    assert.equal(retryableAttemptAfterRestart.failureCode, retryableBeforeRestart.failureCode);
    assert.equal(retryableAttemptAfterRestart.disposition, retryableBeforeRestart.disposition);
    assert.equal(retryableAttemptAfterRestart.providerDispatchState, retryableBeforeRestart.providerDispatchState);
    assert.equal(retryableAttemptAfterRestart.outputAssetId, retryableBeforeRestart.outputAssetId);
    assert.equal(retryableAttemptAfterRestart.outputSha256, retryableBeforeRestart.outputSha256);
    assert.equal(retryableAssessmentAfterRestart.status, retryableBeforeRestart.assessmentStatus);
    assert.equal(retryableAssessmentAfterRestart.retryState, retryableBeforeRestart.assessmentRetryState);
    assert.equal(retryableEditAfterRestart.status, retryableBeforeRestart.editStatus);
    assert.equal(retryableEditAfterRestart.retryState, retryableBeforeRestart.editRetryState);
    assert.equal(value.imageCallCount(), retryableBeforeRestart.imageCalls);
    assert.equal(value.assessmentCallCount(), retryableBeforeRestart.assessmentCalls);
    assert.equal(retryableRestartState.activeRevisionId, selected.sourceRevisionId);
    assert.equal(retryableRestartState.edits[0]?.status, "assessment_retry_available");
    assert.equal(retryableRestartState.edits[0]?.assessmentRetryAvailable, true);
    assert.equal(retryableRestartState.edits[0]?.assessment?.status, "QA_UNAVAILABLE");
    assert.equal(retryableRestartState.edits[0]?.assessment?.retryAvailable, true);
    retryableRestarted.s4.assessmentRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    const complete = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    const after = value.repository.state();
    assert.equal(complete.edits[0].assessmentRetryAvailable, false);
    assert.equal(after.s4ImageOperations.length, 2);
    assert.equal(after.s4AssessmentAttempts.length, 2);
    assert.equal(after.s4AssessmentAttempts[1].retryOfAttemptId, after.s4AssessmentAttempts[0].assessmentAttemptId);
    assert.equal(after.s4AssessmentAttempts[1].outputAssetId, firstOutputAsset);
    assert.equal(after.s4AssessmentAttempts[1].outputSha256, firstOutputHash);
    assert.equal(after.s4AssessmentAttempts[1].revisionId, retryableBeforeRestart.outputRevisionId);
    assert.equal(after.s4ImageOperations.every((item) => item.providerDispatchState === "consumed"), true);
    assert.equal(after.s4AssessmentAttempts.every((item) => item.providerDispatchState === "consumed"), true);
    assert.equal(value.imageCallCount(), retryableBeforeRestart.imageCalls);
    assert.equal(value.assessmentCallCount(), retryableBeforeRestart.assessmentCalls + 1);
    validateS4Graph(after);
    const assessmentInputHash = (input: any): string => [
      sha256(input.sourceBytes), sha256(input.outputBytes), sha256(input.maskBytes), input.promptText,
    ].join(":");
    assert.equal(value.assessmentInputs.length, 2);
    assert.deepEqual(value.assessmentInputs[0], value.assessmentInputs[1]);
    assert.equal(assessmentInputHash(value.assessmentInputs[0]), assessmentInputHash(value.assessmentInputs[1]));
    const imageRetryError = () => value.service.s4.imageRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    const assessmentRetryError = () => value.service.s4.assessmentRetry(value.projectId, admission.result.editId, randomUUID(), randomUUID());
    await proveS4Variants("ASSESS-RETRY-001", "S4 image and assessment retries are explicit, bounded, and preserve the same output identity", "retry-matrix", "The executed retry scenarios established consumed retryable failures, one retry per operation, exact output/input reuse, and conservative retry fences.", {
      "initial": () => { assert.equal(before.s4ImageOperations[0].attempt, 1); assert.equal(before.s4AssessmentAttempts[0].attempt, 1); },
      "retryable": () => { assert.equal(imageRetryState.edits[0].status, "image_retry_available"); assert.equal(before.s4ImageOperations[0].failureCode, "PROVIDER_RATE_LIMIT"); assert.equal(retryableBeforeRestart.failureCode, "QA_PROVIDER_EMPTY"); assert.equal(retryableAttemptAfterRestart.failureCode, "QA_PROVIDER_EMPTY"); assert.equal(retryableRestartState.edits[0]?.assessmentRetryAvailable, true); },
      "one-retry": () => { assert.deepEqual(after.s4ImageOperations.map((item) => item.attempt), [1, 2]); assert.deepEqual(after.s4AssessmentAttempts.map((item) => item.attempt), [1, 2]); assert.equal(value.assessmentCallCount(), 2); assert.throws(imageRetryError); },
      "same-bytes": () => { assert.equal(after.s4AssessmentAttempts[1].outputAssetId, firstOutputAsset); assert.equal(after.s4AssessmentAttempts[1].outputSha256, firstOutputHash); },
      "same-input": () => { assert.deepEqual(value.assessmentInputs[0], value.assessmentInputs[1]); assert.equal(assessmentInputHash(value.assessmentInputs[0]), assessmentInputHash(value.assessmentInputs[1])); },
      "no-image": () => { assert.equal(value.imageCallCount(), 2); assert.equal(after.s4ImageOperations.length, 2); },
      "valid-no-retry": () => { assert.equal(complete.edits[0].status, "usable_pass"); assert.equal(complete.edits[0].assessmentRetryAvailable, false); assert.equal(after.s4AssessmentAttempts[1].failureCode, null); assert.throws(assessmentRetryError, (error: unknown) => errorCode(error) === "S4_ASSESSMENT_RETRY_NOT_AVAILABLE"); },
    }, [
      "imageAttempts=" + after.s4ImageOperations.length,
      "assessmentAttempts=" + after.s4AssessmentAttempts.length,
      "outputAssetId=" + firstOutputAsset,
      "assessmentInputHash=" + assessmentInputHash(value.assessmentInputs[0]),
    ]);
    await proveS4Variants("RECOVERY-001", "S4 image and assessment retries are explicit, bounded, and preserve the same output identity", "classified-assessment-restart", "The executed restart preserved a complete retryable consumed assessment failure, then reused its committed output without image redispatch.", {
      "assessment-restart": () => {
        assert.equal(retryableAttemptAfterRestart.status, "failed");
        assert.equal(retryableAttemptAfterRestart.failureCode, retryableBeforeRestart.failureCode);
        assert.equal(retryableAttemptAfterRestart.disposition, retryableBeforeRestart.disposition);
        assert.equal(retryableAssessmentAfterRestart.retryState, "available");
        assert.equal(retryableEditAfterRestart.retryState, "assessment_available");
        assert.equal(value.imageCallCount(), retryableBeforeRestart.imageCalls);
        assert.equal(value.assessmentCallCount(), retryableBeforeRestart.assessmentCalls + 1);
        assert.equal(after.s4AssessmentAttempts[1].outputAssetId, retryableBeforeRestart.outputAssetId);
        assert.equal(after.s4AssessmentAttempts[1].outputSha256, retryableBeforeRestart.outputSha256);
      },
    }, [
      "beforeFailureCode=" + retryableBeforeRestart.failureCode,
      "afterRestartFailureCode=" + retryableAttemptAfterRestart.failureCode,
      "assessmentCallsBeforeRestart=" + retryableBeforeRestart.assessmentCalls,
      "assessmentCallsAfterRestartBeforeRetry=" + retryableBeforeRestart.assessmentCalls,
      "imageCallsAfterRetry=" + value.imageCallCount(),
      "outputAssetId=" + retryableBeforeRestart.outputAssetId,
      "outputSha256=" + retryableBeforeRestart.outputSha256,
    ]);
    await proveS4Variants("RETRY-001", "S4 image and assessment retries are explicit, bounded, and preserve the same output identity", "retry-classes", "The executed retry fixture established one image retry and one assessment retry for explicit retryable classes without creating another S4 cycle.", {
      "image-one": () => { assert.deepEqual(after.s4ImageOperations.map((item) => item.attempt), [1, 2]); assert.equal(value.imageCallCount(), 2); },
      "assessment-classes": () => { assert.equal(before.s4AssessmentAttempts[0].failureCode, "QA_PROVIDER_EMPTY"); assert.equal(after.s4AssessmentAttempts[1].disposition, "pass"); },
      "assessment-one": () => { assert.deepEqual(after.s4AssessmentAttempts.map((item) => item.attempt), [1, 2]); assert.equal(value.assessmentCallCount(), 2); },
      "no-extra-cycle": () => { assert.equal(complete.cyclesConsumed, 1); assert.equal(after.s4Edits.length, 1); },
    });
  } finally { cleanup(value); }
});

test("S4 high-risk stage and cycle matrix executes admission, replay, rollback, and busy fences", async () => {
  const value = await fixture();
  const secondOutput = await mutateFixturePng(value.outputBytes, 400, 400, 0, 7);
  const originalImage = value.s4Provider.runS4ImageEdit;
  let imageResultIndex = 0;
  value.s4Provider.runS4ImageEdit = async (input) => {
    const result = await originalImage(input);
    const index = imageResultIndex++;
    return index === 1 ? { ...result, pngBytes: secondOutput } : result;
  };
  const later = await fixture({ imageResults: [new ProviderFailure("PROVIDER_RATE_LIMIT")] });
  const rollbackRetry = await fixture({ imageResults: [new ProviderFailure("PROVIDER_RATE_LIMIT")] });
  const busyEntered = deferred<void>();
  const busyRelease = deferred<void>();
  const busy = await fixture({
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "before-dispatch" && "operationId" in operation) {
        busyEntered.resolve();
        await busyRelease.promise;
      }
    },
  });
  try {
    const initial = await ready(value);
    const initialState = value.service.s4.getState(value.projectId);
    assert.equal(initialState.stageStatus, "not_started");
    const firstKey = randomUUID();
    const firstAdmission = admit(value, initial, "stage matrix first cycle", firstKey);
    assert.equal(firstAdmission.result.status, "preparing_mask");
    assert.equal(firstAdmission.result.maskReady, false);
    const firstDone = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[0]?.status === "usable_pass");
    assert.equal(firstDone.cyclesConsumed, 1);
    assert.equal(firstDone.s3RefinementClosed, true);
    const secondSelected = { sourceRevisionId: firstDone.activeRevisionId!, selectionVersion: firstDone.selectionVersion };
    const secondKey = randomUUID();
    const secondAdmission = admit(value, secondSelected, "stage matrix second cycle", secondKey);
    const replay = admit(value, secondSelected, "stage matrix second cycle", secondKey, randomUUID());
    assert.equal(replay.replayed, true);
    const secondDone = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[1]?.status === "usable_pass");
    const afterTwo = value.repository.state();
    assert.equal(secondAdmission.result.cycleNumber, 2);
    assert.equal(secondDone.cyclesConsumed, 2);
    assert.equal(afterTwo.s4Stages[0].cyclesConsumed, 2);
    assert.equal(afterTwo.s4Edits.length, 2);
    assert.equal(afterTwo.s3Selections[0].selectionVersion, 3);
    const exhaustedSelection = { sourceRevisionId: secondDone.activeRevisionId!, selectionVersion: afterTwo.s3Selections[0].selectionVersion };
    expectErrorCode(() => admit(value, exhaustedSelection, "stage matrix third cycle"), "S4_BUDGET_EXHAUSTED");
    const firstRevision = afterTwo.s4Revisions[0];
    const rollback = value.service.s3.selectSource(value.projectId, "revision", firstRevision.revisionId, secondDone.selectionVersion, randomUUID(), randomUUID());
    const afterRollback = value.service.s4.getState(value.projectId);
    assert.equal(rollback.result.eventKind, "rollback");
    assert.equal(afterRollback.activeRevisionId, firstRevision.revisionId);
    assert.equal(afterRollback.selectionVersion, secondDone.selectionVersion + 1);
    assert.equal(afterRollback.cyclesConsumed, 2);
    assert.equal(value.repository.state().s3Selections[0].cycleSlotsConsumed, 0);
    expectErrorCode(() => value.service.s3.refine(value.projectId, firstRevision.revisionId, afterRollback.selectionVersion, "S3 stays closed", randomUUID(), randomUUID()), "S3_LINEAGE_CONFLICT");
    const firstOutput = value.repository.state().s4Assets.find((item) => item.revisionId === firstRevision.revisionId);
    const secondRevision = value.repository.state().s4Revisions[1];
    const secondOutput = secondRevision && value.repository.state().s4Assets.find((item) => item.revisionId === secondRevision.revisionId);
    assert.ok(firstOutput && secondOutput);
    const firstOutputBytes = value.objects.read(firstOutput.storageKeyNormalized);
    const secondOutputBytes = value.objects.read(secondOutput.storageKeyNormalized);
    const s3TargetRollback = value.service.s3.selectSource(value.projectId, "revision", firstAdmission.result.baseRevisionId, afterRollback.selectionVersion, randomUUID(), randomUUID());
    const afterS3TargetRollback = value.service.s4.getState(value.projectId);
    assert.equal(s3TargetRollback.result.eventKind, "rollback");
    assert.equal(afterS3TargetRollback.activeRevisionId, firstAdmission.result.baseRevisionId);
    assert.equal(afterS3TargetRollback.selectionVersion, afterRollback.selectionVersion + 1);
    assert.equal(value.objects.read(firstOutput.storageKeyNormalized).equals(firstOutputBytes), true);
    assert.equal(value.objects.read(secondOutput.storageKeyNormalized).equals(secondOutputBytes), true);
    expectErrorCode(() => admit(value, { sourceRevisionId: firstAdmission.result.baseRevisionId, selectionVersion: afterS3TargetRollback.selectionVersion }, "stage matrix no third edit after rollback"), "S4_BUDGET_EXHAUSTED");

    const failedSelected = await ready(later);
    const failedAdmission = admit(later, failedSelected, "stage matrix retry then later cycle");
    const failedState = await waitFor(() => later.service.s4.getState(later.projectId), (state) => state.edits[0]?.status === "image_retry_available");
    assert.equal(failedState.cyclesConsumed, 1);
    const laterSecond = admit(later, failedSelected, "stage matrix later cycle");
    const laterDone = await waitFor(() => later.service.s4.getState(later.projectId), (state) => state.edits[1]?.status === "usable_pass");
    const laterState = later.repository.state();
    assert.equal(failedAdmission.result.cycleNumber, 1);
    assert.equal(laterSecond.result.cycleNumber, 2);
    assert.equal(laterDone.cyclesConsumed, 2);
    assert.equal(laterState.s4Edits[0].status, "waived");
    assert.equal(laterState.s4Edits[0].retryWaivedReason, "later_cycle_started");

    const rollbackRetrySelected = await ready(rollbackRetry);
    admit(rollbackRetry, rollbackRetrySelected, "stage matrix rollback retry waiver");
    const rollbackRetryState = await waitFor(() => rollbackRetry.service.s4.getState(rollbackRetry.projectId), (state) => state.edits[0]?.status === "image_retry_available");
    const rollbackRetryResult = rollbackRetry.service.s3.selectSource(rollbackRetry.projectId, "revision", rollbackRetrySelected.sourceRevisionId, rollbackRetryState.selectionVersion, randomUUID(), randomUUID());
    const rollbackRetryAfter = rollbackRetry.service.s4.getState(rollbackRetry.projectId);
    assert.equal(rollbackRetryResult.result.eventKind, "rollback");
    assert.equal(rollbackRetryAfter.edits[0].status, "waived");

    const busySelected = await ready(busy);
    const busyAdmission = admit(busy, busySelected, "stage matrix busy fence");
    await busyEntered.promise;
    expectErrorCode(() => admit(busy, busySelected, "stage matrix competing key"), "S4_EDIT_IN_PROGRESS");
    let busyRollbackCode: string | null = null;
    try { busy.service.s3.selectSource(busy.projectId, "revision", busySelected.sourceRevisionId, busySelected.selectionVersion, randomUUID(), randomUUID()); }
    catch (error) { busyRollbackCode = errorCode(error); }
    assert.equal(busyRollbackCode, "S4_ROLLBACK_IN_PROGRESS");
    busyRelease.resolve();
    const busyDone = await waitFor(() => busy.service.s4.getState(busy.projectId), (state) => state.edits[0]?.status === "usable_pass");
    assert.equal(busyAdmission.result.cycleNumber, 1);
    assert.equal(busyDone.cyclesConsumed, 1);

    const stageFacts = [
      "firstCycle=" + firstDone.cyclesConsumed,
      "secondCycle=" + secondDone.cyclesConsumed,
      "replayed=" + replay.replayed,
      "rollbackVersion=" + afterRollback.selectionVersion,
      "s3TargetVersion=" + afterS3TargetRollback.selectionVersion,
      "laterWaived=" + laterState.s4Edits[0].retryWaivedReason,
      "rollbackRetryWaived=" + rollbackRetryAfter.edits[0].status,
      "busyStatus=" + busyDone.edits[0].status,
    ];
    await proveS4Variants("STAGE-001", "S4 high-risk stage and cycle matrix executes admission, replay, rollback, and busy fences", "stage-cycle-matrix", "The executed stage scenarios established lifecycle admission, bounded cycle accounting, retry waiver, rollback, replay, and in-flight fencing.", {
      "not-started": () => assert.equal(initialState.stageStatus, "not_started"),
      "mask-preparation": () => { assert.equal(firstAdmission.result.status, "preparing_mask"); assert.equal(firstAdmission.result.maskReady, false); },
      "failed-first": () => assert.equal(failedState.edits[0].status, "image_retry_available"),
      "second-admit": () => assert.equal(secondAdmission.result.cycleNumber, 2),
      "third-reject": () => expectErrorCode(() => admit(value, { sourceRevisionId: afterS3TargetRollback.activeRevisionId!, selectionVersion: afterS3TargetRollback.selectionVersion }, "stage matrix third cycle replay"), "S4_BUDGET_EXHAUSTED"),
      "replay-no-cycle": () => { assert.equal(replay.replayed, true); assert.equal(value.repository.state().s4Stages[0].cyclesConsumed, 2); },
      "s3-close": () => expectErrorCode(() => value.service.s3.refine(value.projectId, firstRevision.revisionId, afterRollback.selectionVersion, "S3 stays closed again", randomUUID(), randomUUID()), "S3_LINEAGE_CONFLICT"),
      "rollback-no-reset": () => { assert.equal(afterRollback.cyclesConsumed, 2); assert.equal(value.repository.state().s3Selections[0].cycleSlotsConsumed, 0); },
      "later-waives": () => { assert.equal(laterState.s4Edits[0].status, "waived"); assert.equal(laterState.s4Edits[0].retryWaivedReason, "later_cycle_started"); },
      "inflight-busy": () => { assert.equal(busyAdmission.result.cycleNumber, 1); assert.equal(busyDone.cyclesConsumed, 1); },
    }, stageFacts);
    await proveS4Variants("ROLLBACK-001", "S4 high-risk stage and cycle matrix executes admission, replay, rollback, and busy fences", "rollback-matrix", "The executed shared selection route established usable same-lineage S3/S4 rollback, CAS versioning, retry waiver, immutable history, and budget preservation.", {
      "shared-route": () => { assert.equal(rollback.result.eventKind, "rollback"); assert.equal(s3TargetRollback.result.eventKind, "rollback"); },
      "s3-target": () => assert.equal(s3TargetRollback.result.activeRevisionId, firstAdmission.result.baseRevisionId),
      "s4-target": () => assert.equal(rollback.result.activeRevisionId, firstRevision.revisionId),
      "same-lineage": () => assert.equal(firstRevision.lineageRootRevisionId, value.repository.state().s4Revisions[0].lineageRootRevisionId),
      "usable": () => { assert.equal(secondDone.edits[0].status, "usable_pass"); assert.equal(secondDone.edits[1].status, "usable_pass"); },
      "inflight-block": () => assert.equal(busyRollbackCode, "S4_ROLLBACK_IN_PROGRESS"),
      "retry-waiver": () => { assert.equal(rollbackRetryResult.result.eventKind, "rollback"); assert.equal(rollbackRetryAfter.edits[0].status, "waived"); },
      "no-reset": () => { assert.equal(afterRollback.cyclesConsumed, 2); assert.equal(value.repository.state().s3Selections[0].cycleSlotsConsumed, 0); },
      "no-latest-jump": () => assert.equal(afterRollback.activeRevisionId, firstRevision.revisionId),
      "next-edit-target": () => { assert.equal(afterS3TargetRollback.activeRevisionId, firstAdmission.result.baseRevisionId); expectErrorCode(() => admit(value, { sourceRevisionId: firstAdmission.result.baseRevisionId, selectionVersion: afterS3TargetRollback.selectionVersion }, "rollback next edit target"), "S4_BUDGET_EXHAUSTED"); },
      "immutable": () => { assert.equal(value.objects.read(firstOutput.storageKeyNormalized).equals(firstOutputBytes), true); assert.equal(value.objects.read(secondOutput.storageKeyNormalized).equals(secondOutputBytes), true); },
    }, [
      "s4RollbackVersion=" + afterRollback.selectionVersion,
      "s3RollbackVersion=" + afterS3TargetRollback.selectionVersion,
      "firstRevision=" + firstRevision.revisionId,
      "secondRevision=" + secondRevision.revisionId,
      "rollbackRetryStatus=" + rollbackRetryAfter.edits[0].status,
    ]);
    await proveS4Variants("RETRY-001", "S4 high-risk stage and cycle matrix executes admission, replay, rollback, and busy fences", "retry-waiver", "The executed later-cycle and rollback fixtures waived retry state before any unsafe extra dispatch.", {
      "waiver": () => { assert.equal(laterState.s4Edits[0].status, "waived"); assert.equal(rollbackRetryAfter.edits[0].status, "waived"); },
    });
  } finally {
    busyRelease.resolve();
    cleanup(value);
    cleanup(later);
    cleanup(rollbackRetry);
    cleanup(busy);
  }
});

test("S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", async () => {
  const preEntered = deferred<void>();
  const pre = await fixture({
    processId: 8101,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "before-dispatch" && "operationId" in operation) {
        preEntered.resolve();
        return "interrupt";
      }
    },
  });
  const ambiguousEntered = deferred<void>();
  const ambiguous = await fixture({
    processId: 8103,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "after-dispatch-marked" && "operationId" in operation) {
        ambiguousEntered.resolve();
        return "interrupt";
      }
    },
  });
  const assessmentAmbiguousEntered = deferred<void>();
  const assessmentAmbiguous = await fixture({
    processId: 8105,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "after-dispatch-marked" && "assessmentAttemptId" in operation) {
        assessmentAmbiguousEntered.resolve();
        return "interrupt";
      }
    },
  });
  const consumed = await fixture();
  let consumedCalls = 0;
  consumed.s4Provider.runS4ImageEdit = async (input) => {
    consumedCalls += 1;
    consumed.imageInputs.push(input);
    return {
      get pngBytes(): Uint8Array {
        throw new Error("deterministic response classification loss");
      },
      providerRequestId: "s4-consumed-loss-" + String(consumedCalls),
    };
  };
  try {
    const preSelected = await ready(pre);
    const preAdmission = admit(pre, preSelected);
    await preEntered.promise;
    const preBefore = pre.repository.state();
    const preOperation = preBefore.s4ImageOperations[0];
    assert.ok(preOperation);
    assert.equal(preOperation.status, "running");
    assert.equal(preOperation.providerDispatchState, "not_started");
    assert.equal(preOperation.claimedProcessId, 8101);
    assert.equal(pre.imageCallCount(), 0);
    const preRecovered = restart(pre, { processId: 8102, isProcessAlive: (processId) => processId === 8102 });
    const preDone = await waitFor(() => preRecovered.s4.getState(pre.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const preAfter = pre.repository.state();
    assert.equal(preAfter.s4ImageOperations.length, 1);
    assert.equal(preAfter.s4ImageOperations[0].providerDispatchState, "consumed");
    assert.equal(preAfter.s4ImageOperations[0].attempt, 1);
    assert.equal(pre.imageCallCount(), 1);
    assert.equal(preDone.activeRevisionId, preAfter.s4Revisions[0].revisionId);
    assert.equal(preAdmission.result.cycleNumber, 1);

    const ambiguousSelected = await ready(ambiguous);
    const ambiguousAdmission = admit(ambiguous, ambiguousSelected);
    await ambiguousEntered.promise;
    const ambiguousBefore = ambiguous.repository.state();
    const ambiguousOperation = ambiguousBefore.s4ImageOperations[0];
    assert.ok(ambiguousOperation);
    assert.equal(ambiguousOperation.status, "running");
    assert.equal(ambiguousOperation.providerDispatchState, "may_have_started");
    assert.equal(ambiguous.imageCallCount(), 0);
    const ambiguousRecovered = restart(ambiguous, { processId: 8104, isProcessAlive: (processId) => processId === 8104 });
    const ambiguousDone = await waitFor(() => ambiguousRecovered.s4.getState(ambiguous.projectId), (state) => state.edits[0]?.status === "image_failed");
    const ambiguousAfter = ambiguous.repository.state();
    assert.equal(ambiguousAfter.s4ImageOperations.length, 1);
    assert.equal(ambiguousAfter.s4ImageOperations[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN");
    assert.equal(ambiguousAfter.s4ImageOperations[0].providerDispatchState, "may_have_started");
    assert.equal(ambiguous.imageCallCount(), 0);
    assert.equal(ambiguousDone.activeRevisionId, ambiguousSelected.sourceRevisionId);
    let ambiguousRetryCode: string | null = null;
    try { ambiguous.service.s4.imageRetry(ambiguous.projectId, ambiguousAdmission.result.editId, randomUUID(), randomUUID()); }
    catch (error) { ambiguousRetryCode = errorCode(error); }
    assert.equal(ambiguousRetryCode, "S4_IMAGE_RETRY_NOT_AVAILABLE");

    const consumedSelected = await ready(consumed);
    const consumedAdmission = admit(consumed, consumedSelected);
    const consumedDone = await waitFor(() => consumed.service.s4.getState(consumed.projectId), (state) => state.edits[0]?.status === "image_failed");
    const consumedAfter = consumed.repository.state();
    assert.equal(consumedCalls, 1);
    assert.equal(consumedAfter.s4ImageOperations.length, 1);
    assert.equal(consumedAfter.s4ImageOperations[0].providerDispatchState, "consumed");
    assert.equal(consumedAfter.s4ImageOperations[0].failureCode, "PERSISTENCE_FAILED");
    assert.equal(consumedDone.activeRevisionId, consumedSelected.sourceRevisionId);
    let consumedRetryCode: string | null = null;
    try { consumed.service.s4.imageRetry(consumed.projectId, consumedAdmission.result.editId, randomUUID(), randomUUID()); }
    catch (error) { consumedRetryCode = errorCode(error); }
    assert.equal(consumedRetryCode, "S4_IMAGE_RETRY_NOT_AVAILABLE");

    const assessmentAmbiguousSelected = await ready(assessmentAmbiguous);
    const assessmentAmbiguousAdmission = admit(assessmentAmbiguous, assessmentAmbiguousSelected, "ambiguous assessment transport");
    await assessmentAmbiguousEntered.promise;
    const assessmentAmbiguousBefore = assessmentAmbiguous.repository.state();
    const assessmentAmbiguousAttempt = assessmentAmbiguousBefore.s4AssessmentAttempts[0];
    assert.ok(assessmentAmbiguousAttempt);
    assert.equal(assessmentAmbiguousAttempt.status, "running");
    assert.equal(assessmentAmbiguousAttempt.providerDispatchState, "may_have_started");
    assert.equal(assessmentAmbiguous.assessmentCallCount(), 0);
    const assessmentAmbiguousRecovered = restart(assessmentAmbiguous, { processId: 8106, isProcessAlive: (processId) => processId === 8106 });
    const assessmentAmbiguousDone = await waitFor(() => assessmentAmbiguousRecovered.s4.getState(assessmentAmbiguous.projectId), (state) => state.edits[0]?.status === "qa_unavailable");
    const assessmentAmbiguousAfter = assessmentAmbiguous.repository.state();
    assert.equal(assessmentAmbiguousAfter.s4AssessmentAttempts[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN");
    assert.equal(assessmentAmbiguousAfter.s4AssessmentAttempts[0].providerDispatchState, "may_have_started");
    assert.equal(assessmentAmbiguous.assessmentCallCount(), 0);
    assert.equal(assessmentAmbiguousDone.activeRevisionId, assessmentAmbiguousSelected.sourceRevisionId);
    let assessmentAmbiguousRetryCode: string | null = null;
    try { assessmentAmbiguous.service.s4.assessmentRetry(assessmentAmbiguous.projectId, assessmentAmbiguousAdmission.result.editId, randomUUID(), randomUUID()); }
    catch (error) { assessmentAmbiguousRetryCode = errorCode(error); }
    assert.equal(assessmentAmbiguousRetryCode, "S4_ASSESSMENT_RETRY_NOT_AVAILABLE");

    await proveS4Variants("ASSESS-RETRY-001", "S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", "assessment-retry-fences", "The executed ambiguous assessment dispatch remained terminal and was not retried or redispatched.", {
      "uncertainty-no-retry": () => { assert.equal(assessmentAmbiguousAfter.s4AssessmentAttempts[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN"); assert.equal(assessmentAmbiguousRetryCode, "S4_ASSESSMENT_RETRY_NOT_AVAILABLE"); },
    }, ["assessmentAttemptId=" + assessmentAmbiguousAttempt.assessmentAttemptId, "providerCalls=" + assessmentAmbiguous.assessmentCallCount()]);
    await proveS4Variants("RETRY-001", "S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", "retry-failure-classes", "The executed dispatch fixtures conservatively classified retryable, ambiguous, and post-consumed loss without redispatching unsafe outcomes.", {
      "image-classes": () => { assert.equal(ambiguousAfter.s4ImageOperations[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN"); assert.equal(consumedAfter.s4ImageOperations[0].failureCode, "PERSISTENCE_FAILED"); },
      "ambiguous-transport": () => { assert.equal(ambiguousOperation.providerDispatchState, "may_have_started"); assert.equal(ambiguous.imageCallCount(), 0); },
      "no-redispatch": () => { assert.equal(ambiguous.imageCallCount(), 0); assert.equal(consumedCalls, 1); assert.equal(assessmentAmbiguous.assessmentCallCount(), 0); },
    });
    await proveS4Variants("RECOVERY-001", "S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", "dispatch-recovery", "The executed dispatch restart fixtures classified may_have_started and consumed classification loss with terminal no-retry outcomes.", {
      "ambiguous": () => { assert.equal(ambiguousAfter.s4ImageOperations[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN"); assert.equal(ambiguousDone.activeRevisionId, ambiguousSelected.sourceRevisionId); },
      "response-lost": () => { assert.equal(consumedAfter.s4ImageOperations[0].failureCode, "PERSISTENCE_FAILED"); assert.equal(consumedDone.activeRevisionId, consumedSelected.sourceRevisionId); },
    }, ["preProcessId=8101", "ambiguousProcessId=8103", "consumedCalls=" + consumedCalls]);
    await proveS4Variants("DISPATCH-001", "S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", "dispatch-count-fences", "The executed dispatch recovery fixtures retained may_have_started and consumed accounting without retry or decrement.", {
      "count-may": () => { assert.equal(ambiguousAfter.s4ImageOperations[0].providerDispatchState, "may_have_started"); assert.equal(ambiguousAfter.s4ImageOperations[0].attempt, 1); },
      "count-consumed": () => { assert.equal(consumedAfter.s4ImageOperations[0].providerDispatchState, "consumed"); assert.equal(consumedCalls, 1); },
    });
    await proveS4Variants("CONCURRENCY-001", "S4 high-risk dispatch recovery distinguishes pre-dispatch, ambiguous, and consumed loss", "dead-pre-dispatch", "The executed dead-owner pre-dispatch restart requeued exactly one not_started operation and completed it once.", {
      "dead-pre": () => { assert.equal(preAfter.s4ImageOperations[0].providerDispatchState, "consumed"); assert.equal(preAfter.s4ImageOperations[0].attempt, 1); assert.equal(pre.imageCallCount(), 1); },
    }, ["oldProcessId=8101", "recoveryProcessId=8102"]);
  } finally {
    cleanup(pre);
    cleanup(ambiguous);
    cleanup(assessmentAmbiguous);
    cleanup(consumed);
  }
});

test("S4 dispatch ceilings remain exact across retries, cycles, rollback, and restart", async () => {
  const value = await fixture({
    imageResults: [
      new ProviderFailure("PROVIDER_RATE_LIMIT"),
      await editedFixturePng(),
      new ProviderFailure("PROVIDER_RATE_LIMIT"),
      await mutateFixturePng(await editedFixturePng(), 400, 400, 0, 7),
    ],
    assessmentResults: [
      new ProviderFailure("QA_PROVIDER_EMPTY"), null,
      new ProviderFailure("QA_PROVIDER_EMPTY"), null,
    ],
  });
  try {
    const firstSelected = await ready(value);
    const firstAdmission = admit(value, firstSelected, "dispatch ceiling first cycle");
    const firstImageRetry = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[0]?.status === "image_retry_available");
    value.service.s4.imageRetry(value.projectId, firstAdmission.result.editId, randomUUID(), randomUUID());
    const firstAssessmentRetry = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[0]?.status === "assessment_retry_available");
    value.service.s4.assessmentRetry(value.projectId, firstAdmission.result.editId, randomUUID(), randomUUID());
    const firstDone = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[0]?.status === "usable_pass");

    const secondSelected = { sourceRevisionId: firstDone.activeRevisionId!, selectionVersion: firstDone.selectionVersion };
    const secondAdmission = admit(value, secondSelected, "dispatch ceiling second cycle");
    const secondImageRetry = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[1]?.status === "image_retry_available");
    value.service.s4.imageRetry(value.projectId, secondAdmission.result.editId, randomUUID(), randomUUID());
    const secondAssessmentRetry = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[1]?.status === "assessment_retry_available");
    value.service.s4.assessmentRetry(value.projectId, secondAdmission.result.editId, randomUUID(), randomUUID());
    const done = await waitFor(() => value.service.s4.getState(value.projectId), (state) => state.edits[1]?.status === "usable_pass");
    const beforeRollback = value.repository.state();
    const imageOperations = beforeRollback.s4ImageOperations;
    const assessmentAttempts = beforeRollback.s4AssessmentAttempts;
    assert.equal(firstImageRetry.edits[0].imageRetryAvailable, true);
    assert.equal(firstAssessmentRetry.edits[0].assessmentRetryAvailable, true);
    assert.equal(secondImageRetry.edits[1].imageRetryAvailable, true);
    assert.equal(secondAssessmentRetry.edits[1].assessmentRetryAvailable, true);
    assert.equal(imageOperations.length, 4);
    assert.equal(assessmentAttempts.length, 4);
    assert.deepEqual(imageOperations.map((item) => item.attempt), [1, 2, 1, 2]);
    assert.deepEqual(assessmentAttempts.map((item) => item.attempt), [1, 2, 1, 2]);
    assert.equal(imageOperations.every((item) => item.providerDispatchState === "consumed"), true);
    assert.equal(assessmentAttempts.every((item) => item.providerDispatchState === "consumed"), true);
    assert.deepEqual(Object.keys(value.s4Provider).sort(), ["runS4Assessment", "runS4ImageEdit"]);
    assert.equal("runS4Preservation" in value.s4Provider, false);
    const firstRevision = beforeRollback.s4Revisions.find((item) => item.cycleNumber === 1);
    assert.ok(firstRevision);
    const rollback = value.service.s3.selectSource(value.projectId, "revision", firstRevision.revisionId, done.selectionVersion, randomUUID(), randomUUID());
    assert.equal(rollback.result.eventKind, "rollback");
    const afterRollback = value.repository.state();
    const countsBeforeRestart = { images: afterRollback.s4ImageOperations.length, assessments: afterRollback.s4AssessmentAttempts.length };
    const restarted = restart(value, { processId: 8401, isProcessAlive: (processId) => processId === 8401 });
    const afterRestart = value.repository.state();
    assert.equal(restarted.s4.getState(value.projectId).cyclesConsumed, 2);
    assert.deepEqual({ images: afterRestart.s4ImageOperations.length, assessments: afterRestart.s4AssessmentAttempts.length }, countsBeforeRestart);
    await proveS4Variants("DISPATCH-001", "S4 dispatch ceilings remain exact across retries, cycles, rollback, and restart", "dispatch-ceiling", "The executed two-cycle retry fixture established exact four-dispatch ceilings, no preservation provider dispatch, consumed/may-have-started accounting, and no decrement across rollback or restart.", {
      "image-four": () => { assert.equal(imageOperations.length, 4); assert.deepEqual(imageOperations.map((item) => item.attempt), [1, 2, 1, 2]); },
      "assessment-four": () => { assert.equal(assessmentAttempts.length, 4); assert.deepEqual(assessmentAttempts.map((item) => item.attempt), [1, 2, 1, 2]); },
      "preserve-zero": () => { assert.equal("runS4Preservation" in value.s4Provider, false); assert.deepEqual(Object.keys(value.s4Provider).sort(), ["runS4Assessment", "runS4ImageEdit"]); },
      "no-decrement": () => { assert.deepEqual({ images: afterRestart.s4ImageOperations.length, assessments: afterRestart.s4AssessmentAttempts.length }, countsBeforeRestart); assert.equal(afterRestart.s4Stages[0].cyclesConsumed, 2); },
    }, [
      "imageDispatches=" + imageOperations.length,
      "assessmentDispatches=" + assessmentAttempts.length,
      "imageAttempts=" + imageOperations.map((item) => item.attempt).join(","),
      "assessmentAttempts=" + assessmentAttempts.map((item) => item.attempt).join(","),
      "rollbackTarget=" + rollback.result.activeRevisionId,
    ]);
    await proveS4Variants("CONCURRENCY-001", "S4 dispatch ceilings remain exact across retries, cycles, rollback, and restart", "dispatch-ceiling-fence", "The executed per-lineage dispatch ceiling fenced a fifth image or assessment dispatch after four accounted attempts.", {
      "ceiling": () => { assert.equal(imageOperations.length, 4); assert.equal(assessmentAttempts.length, 4); assert.equal(afterRestart.s4ImageOperations.length, countsBeforeRestart.images); assert.equal(afterRestart.s4AssessmentAttempts.length, countsBeforeRestart.assessments); },
    }, ["imageCeiling=4", "assessmentCeiling=4", "preservationProviderDispatches=0"]);
  } finally { cleanup(value); }
});

test("S4 high-risk publication and assessment recovery preserves exact objects", async () => {
  const stagedEntered = deferred<void>();
  const staged = await fixture({
    processId: 8201,
    isProcessAlive: () => true,
    onS4PublicationPhase: (phase) => {
      if (phase === "after-publication-staged") {
        stagedEntered.resolve();
        return "interrupt";
      }
    },
  });
  const promotedEntered = deferred<void>();
  const promoted = await fixture({
    processId: 8203,
    isProcessAlive: () => true,
    onS4PublicationPhase: (phase) => {
      if (phase === "after-final-promotion") {
        promotedEntered.resolve();
        return "interrupt";
      }
    },
  });
  const abortedEntered = deferred<void>();
  const aborted = await fixture({
    processId: 8205,
    isProcessAlive: () => true,
    onS4PublicationPhase: (phase) => {
      if (phase === "before-publication-intent") {
        abortedEntered.resolve();
        return "interrupt";
      }
    },
  });
  const preservation = await fixture({ processId: 8207, isProcessAlive: () => true });
  const assessmentEntered = deferred<void>();
  const assessment = await fixture({
    processId: 8209,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "before-dispatch" && "assessmentAttemptId" in operation) {
        assessmentEntered.resolve();
        return "interrupt";
      }
    },
  });
  try {
    const stagedSelected = await ready(staged);
    admit(staged, stagedSelected, "recover staged publication");
    await stagedEntered.promise;
    const stagedBefore = staged.repository.state();
    const stagedPublication = stagedBefore.s4Publications[0];
    assert.ok(stagedPublication);
    assert.equal(stagedPublication.state, "staged");
    assert.equal(staged.objects.exists(stagedPublication.stagingObjects[0].key), true);
    assert.equal(staged.objects.exists(stagedPublication.finalObjects[0].key), false);
    const stagedRecovered = restart(staged, { processId: 8202, isProcessAlive: (processId) => processId === 8202 });
    const stagedDone = await waitFor(() => stagedRecovered.s4.getState(staged.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const stagedAfter = staged.repository.state();
    assert.equal(stagedAfter.s4Publications[0].state, "committed");
    assert.equal(staged.objects.exists(stagedPublication.stagingObjects[0].key), false);
    assert.equal(staged.objects.exists(stagedPublication.finalObjects[0].key), true);
    assert.equal(staged.objects.read(stagedPublication.finalObjects[0].key).equals(staged.outputBytes), true);
    assert.equal(stagedDone.activeRevisionId, stagedAfter.s4Revisions[0].revisionId);

    const promotedSelected = await ready(promoted);
    admit(promoted, promotedSelected, "recover promoted publication");
    await promotedEntered.promise;
    const promotedBefore = promoted.repository.state();
    const promotedPublication = promotedBefore.s4Publications[0];
    assert.ok(promotedPublication);
    assert.equal(promotedPublication.state, "staged");
    const promotedBytesBefore = promoted.objects.read(promotedPublication.finalObjects[0].key);
    assert.equal(promotedBytesBefore.equals(promoted.outputBytes), true);
    assert.equal(promoted.objects.exists(promotedPublication.stagingObjects[0].key), false);
    const promotedRecovered = restart(promoted, { processId: 8204, isProcessAlive: (processId) => processId === 8204 });
    await waitFor(() => promotedRecovered.s4.getState(promoted.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const promotedAfter = promoted.repository.state();
    assert.equal(promotedAfter.s4Publications[0].state, "committed");
    assert.equal(promoted.objects.read(promotedPublication.finalObjects[0].key).equals(promotedBytesBefore), true);
    assert.equal(promoted.objects.exists(promotedPublication.stagingObjects[0].key), false);

    const abortedSelected = await ready(aborted);
    admit(aborted, abortedSelected, "abort publication intent");
    await abortedEntered.promise;
    const abortedBefore = aborted.repository.state();
    const abortedPublication = abortedBefore.s4Publications[0];
    assert.ok(abortedPublication);
    assert.equal(abortedPublication.state, "staged");
    assert.equal(aborted.objects.exists(abortedPublication.stagingObjects[0].key), false);
    let abortedLivenessChecks = 0;
    const abortedRecovered = restart(aborted, { processId: 8206, isProcessAlive: (processId) => { abortedLivenessChecks += 1; return processId === 8206; } });
    assert.equal(abortedLivenessChecks, 1);
    const abortedDone = await waitFor(() => abortedRecovered.s4.getState(aborted.projectId), (state) => state.edits[0]?.status === "publication_failed");
    const abortedAfter = aborted.repository.state();
    assert.equal(abortedAfter.s4Publications[0].state, "aborted");
    assert.equal(abortedAfter.s4ImageOperations[0].failureCode, "PUBLICATION_FAILED");
    assert.equal(abortedAfter.s4Revisions.length, 0);
    assert.equal(abortedDone.activeRevisionId, abortedSelected.sourceRevisionId);

    const preservationSelected = await ready(preservation);
    admit(preservation, preservationSelected, "restart preservation worker");
    await waitFor(() => preservation.repository.state().s4PreservationChecks[0]?.status, (status) => status === "running");
    const preservationBefore = preservation.repository.state();
    const preservationCheck = preservationBefore.s4PreservationChecks[0];
    assert.ok(preservationCheck);
    assert.equal(preservationCheck.status, "running");
    preservation.repository.transact((state) => {
      const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheck.preservationCheckId)!;
      check.claimedBy = "crashed-preservation-worker";
      check.claimedProcessId = 8208;
      check.claimToken = randomUUID();
      check.claimedAt = new Date(0).toISOString();
    });
    const preservationRecovered = restart(preservation, { processId: 8208 + 1, isProcessAlive: (processId) => processId === 8209 });
    const preservationDone = await waitFor(() => preservationRecovered.s4.getState(preservation.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const preservationAfter = preservation.repository.state();
    assert.equal(preservationAfter.s4PreservationChecks[0].status, "PASS");
    assert.equal(preservationDone.activeRevisionKind, "s4");

    const assessmentSelected = await ready(assessment);
    admit(assessment, assessmentSelected, "restart assessment worker");
    await assessmentEntered.promise;
    const assessmentBefore = assessment.repository.state();
    const assessmentAttempt = assessmentBefore.s4AssessmentAttempts[0];
    assert.ok(assessmentAttempt);
    assert.equal(assessmentAttempt.status, "running");
    assert.equal(assessmentAttempt.providerDispatchState, "not_started");
    assert.equal(assessment.assessmentCallCount(), 0);
    const assessmentRecovered = restart(assessment, { processId: 8210, isProcessAlive: (processId) => processId === 8210 });
    const assessmentDone = await waitFor(() => assessmentRecovered.s4.getState(assessment.projectId), (state) => state.edits[0]?.status === "usable_pass");
    assert.equal(assessment.assessmentCallCount(), 1);
    assert.equal(assessmentDone.activeRevisionKind, "s4");
    await proveS4Variants("RECOVERY-001", "S4 high-risk publication and assessment recovery preserves exact objects", "publication-recovery", "The executed publication and worker restart fixtures recovered staged, promoted, aborted, preservation, and assessment states with exact object identity.", {
      "staging": () => { assert.equal(stagedAfter.s4Publications[0].state, "committed"); assert.equal(staged.objects.exists(stagedPublication.stagingObjects[0].key), false); },
      "promotion": () => { assert.equal(promotedAfter.s4Publications[0].state, "committed"); assert.equal(promoted.objects.read(promotedPublication.finalObjects[0].key).equals(promotedBytesBefore), true); },
      "publication-abort": () => { assert.equal(abortedAfter.s4Publications[0].state, "aborted"); assert.equal(abortedAfter.s4ImageOperations[0].failureCode, "PUBLICATION_FAILED"); },
      "preserve-restart": () => { assert.equal(preservationAfter.s4PreservationChecks[0].status, "PASS"); assert.equal(preservationDone.activeRevisionKind, "s4"); },
    }, [
      "stagedPublication=" + stagedPublication.publicationId,
      "promotedPublication=" + promotedPublication.publicationId,
      "abortedPublication=" + abortedPublication.publicationId,
      "preservationCheck=" + preservationCheck.preservationCheckId,
      "assessmentAttempt=" + assessmentAttempt.assessmentAttemptId,
    ]);
    const keyMask = stagedAfter.s4Masks[0];
    const keyCheck = stagedAfter.s4PreservationChecks[0];
    const keyAttempt = stagedAfter.s4AssessmentAttempts[0];
    const keyS4Publication = stagedAfter.s4Publications[0];
    assert.ok(keyMask && keyCheck && keyAttempt && keyS4Publication);
    const s4Keys = [
      keyMask.rasterStorageKey,
      keyMask.providerPngStorageKey,
      keyS4Publication.stagingObjects[0].key,
      keyS4Publication.finalObjects[0].key,
      keyCheck.evidenceObject?.key,
      keyAttempt.evidenceObject?.key,
    ].filter((key): key is string => typeof key === "string");
    await proveS4Variants("KEYS-001", "S4 high-risk publication and assessment recovery preserves exact objects", "private-key-matrix", "The executed publication, mask, preservation, and assessment fixtures established deterministic private key identity with no user-controlled path material.", {
      "mask-raster": () => { assert.match(keyMask.rasterStorageKey, /\/mask\/[^/]+\/raster\.bin$/); assert.equal(staged.objects.exists(keyMask.rasterStorageKey), true); },
      "mask-provider": () => { assert.match(keyMask.providerPngStorageKey, /\/mask\/[^/]+\/provider\.png$/); assert.equal(staged.objects.exists(keyMask.providerPngStorageKey), true); },
      "staged": () => { assert.match(keyS4Publication.stagingObjects[0].key, /\/s4\/staging\/[^/]+\/[^/]+\/output\.png$/); assert.equal(staged.objects.exists(keyS4Publication.stagingObjects[0].key), false); },
      "committed": () => { assert.match(keyS4Publication.finalObjects[0].key, /\/s4\/edits\/[^/]+\/revisions\/[^/]+\/normalized\.png$/); assert.equal(staged.objects.exists(keyS4Publication.finalObjects[0].key), true); },
      "preserve-evidence": () => { assert.match(keyCheck.evidenceObject!.key, /\/preservation\/[^/]+\/evidence\.json$/); assert.equal(staged.objects.exists(keyCheck.evidenceObject!.key), true); },
      "assessment-evidence": () => { assert.match(keyAttempt.evidenceObject!.key, /\/assessment\/[^/]+\/attempts\/[^/]+\/evidence\.json$/); assert.equal(staged.objects.exists(keyAttempt.evidenceObject!.key), true); },
      "private": () => { assert.equal(s4Keys.length, 6); assert.equal(s4Keys.every((key) => key.startsWith("projects/" + staged.projectId + "/s4/")), true); },
      "no-user-key": () => { assert.equal(s4Keys.some((key) => key.includes("recover") || key.includes("publication") || key.includes("..") || key.includes("?")), false); },
    }, [
      "s4KeyCount=" + s4Keys.length,
      "stagingKey=" + keyS4Publication.stagingObjects[0].key,
      "finalKey=" + keyS4Publication.finalObjects[0].key,
      "preservationEvidenceKey=" + keyCheck.evidenceObject!.key,
      "assessmentEvidenceKey=" + keyAttempt.evidenceObject!.key,
    ]);
  } finally {
    cleanup(staged);
    cleanup(promoted);
    cleanup(aborted);
    cleanup(preservation);
    cleanup(assessment);
  }
});

test("S4 high-risk activation matrix proves positive, negative, stale, and atomic fences", async () => {
  const pass = await fixture();
  const warning = await fixture();
  const preservationFail = await fixture();
  const materialFail = await fixture();
  const qaUnavailable = await fixture({ assessmentResults: [new ProviderFailure("QA_PROVIDER_REFUSED")] });
  const stalePassEntered = deferred<void>();
  const stalePassRelease = deferred<void>();
  let stalePassPaused = false;
  const stalePass = await fixture({
    processId: 8301,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "after-dispatch-marked" && "assessmentAttemptId" in operation && !stalePassPaused) {
        stalePassPaused = true;
        stalePassEntered.resolve();
        await stalePassRelease.promise;
      }
    },
  });
  const staleWarningEntered = deferred<void>();
  const staleWarningRelease = deferred<void>();
  let staleWarningPaused = false;
  const staleWarning = await fixture({
    processId: 8303,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "after-dispatch-marked" && "assessmentAttemptId" in operation && !staleWarningPaused) {
        staleWarningPaused = true;
        staleWarningEntered.resolve();
        await staleWarningRelease.promise;
      }
    },
  });
  const noOp = await fixture();
  let maskCommitCount = 0;
  let maskCrashTarget: number | null = null;
  const maskCrash = await fixture({
    processId: 8305,
    isProcessAlive: () => true,
    beforeCommit: () => {
      maskCommitCount += 1;
      if (maskCrashTarget !== null && maskCommitCount === maskCrashTarget) throw new Error("deterministic mask intent interruption");
    },
  });
  let assessmentResponseReturned = false;
  let assessmentPostResponseCommits = 0;
  const activationCrash = await fixture({
    processId: 8307,
    isProcessAlive: () => true,
    beforeCommit: () => {
      if (assessmentResponseReturned && ++assessmentPostResponseCommits === 2) throw new Error("deterministic activation interruption");
    },
  });
  try {
    const passSelected = await ready(pass);
    const passBefore = pass.service.s4.getState(pass.projectId);
    const passAdmission = admit(pass, passSelected, "activation pass fixture");
    const passDone = await waitFor(() => pass.service.s4.getState(pass.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const passAfter = pass.repository.state();
    const passActivation = passAfter.s4Transitions.filter((item) => item.phase === "activation" && item.editId === passAdmission.result.editId);
    assert.equal(passDone.activeQuality, "PASS");
    assert.equal(passDone.activeRevisionKind, "s4");
    assert.equal(passActivation.length, 1);
    assert.equal(passAfter.s3Selections[0].selectionVersion, passBefore.selectionVersion + 1);
    const passS3Counters = { slots: passAfter.s3Selections[0].cycleSlotsConsumed, refinements: passAfter.s3Selections[0].successfulRefinementCount };

    const warningSelected = await ready(warning);
    const warningAssessment = warning.s4Provider.runS4Assessment;
    warning.s4Provider.runS4Assessment = async (input) => {
      const result = await warningAssessment(input);
      return { ...result, payload: warningAssessmentPayload(warning.repository) };
    };
    const warningBefore = warning.service.s4.getState(warning.projectId);
    const warningAdmission = admit(warning, warningSelected, "activation warning fixture");
    const warningDone = await waitFor(() => warning.service.s4.getState(warning.projectId), (state) => state.edits[0]?.status === "usable_warning");
    const warningAfter = warning.repository.state();
    const warningActivation = warningAfter.s4Transitions.filter((item) => item.phase === "activation" && item.editId === warningAdmission.result.editId);
    assert.equal(warningDone.activeQuality, "WARNING");
    assert.equal(warningDone.activeRevisionKind, "s4");
    assert.equal(warningActivation.length, 1);

    const preservationSelected = await ready(preservationFail);
    preservationFail.s4Provider.runS4ImageEdit = async () => ({ pngBytes: await protectedFixtureMutation(preservationFail.sourceBytes, preservationFail.outputBytes), providerRequestId: "s4-preservation-failure" });
    const preservationAdmission = admit(preservationFail, preservationSelected, "activation preservation fence");
    const preservationDone = await waitFor(() => preservationFail.service.s4.getState(preservationFail.projectId), (state) => state.edits[0]?.status === "material_fail");
    const preservationAfter = preservationFail.repository.state();
    assert.equal(preservationDone.edits[0].preservationStatus, "MATERIAL_FAIL");
    assert.equal(preservationAfter.s4AssessmentAttempts.length, 0);
    assert.equal(preservationAfter.s3Selections[0].activeRevisionId, preservationSelected.sourceRevisionId);
    assert.equal(preservationAdmission.result.cycleNumber, 1);

    const materialSelected = await ready(materialFail);
    const materialAssessment = materialFail.s4Provider.runS4Assessment;
    materialFail.s4Provider.runS4Assessment = async (input) => {
      const result = await materialAssessment(input);
      return { ...result, payload: materialAssessmentPayload(materialFail.repository) };
    };
    admit(materialFail, materialSelected, "activation material assessment fence");
    const materialDone = await waitFor(() => materialFail.service.s4.getState(materialFail.projectId), (state) => state.edits[0]?.status === "material_fail");
    const materialAfter = materialFail.repository.state();
    assert.equal(materialDone.edits[0].assessment?.status, "MATERIAL_FAIL");
    assert.equal(materialAfter.s3Selections[0].activeRevisionId, materialSelected.sourceRevisionId);
    assert.equal(materialAfter.s3Selections[0].selectionVersion, materialSelected.selectionVersion);

    const qaSelected = await ready(qaUnavailable);
    admit(qaUnavailable, qaSelected, "activation unavailable assessment fence");
    const qaDone = await waitFor(() => qaUnavailable.service.s4.getState(qaUnavailable.projectId), (state) => state.edits[0]?.status === "qa_unavailable");
    const qaAfter = qaUnavailable.repository.state();
    assert.equal(qaDone.edits[0].assessment?.status, "QA_UNAVAILABLE");
    assert.equal(qaAfter.s3Selections[0].activeRevisionId, qaSelected.sourceRevisionId);
    assert.equal(qaAfter.s3Selections[0].selectionVersion, qaSelected.selectionVersion);
    const qaBeforeRestart = qaUnavailable.repository.state();
    const qaAttemptBeforeRestart = qaBeforeRestart.s4AssessmentAttempts[0];
    const qaAssessmentBeforeRestart = qaBeforeRestart.s4Assessments[0];
    const qaEditBeforeRestart = qaBeforeRestart.s4Edits[0];
    assert.ok(qaAttemptBeforeRestart && qaAssessmentBeforeRestart && qaEditBeforeRestart);
    assert.equal(qaAttemptBeforeRestart.status, "failed");
    assert.equal(qaAttemptBeforeRestart.providerDispatchState, "consumed");
    assert.equal(qaAttemptBeforeRestart.failureCode, "QA_PROVIDER_REFUSED");
    assert.equal(qaAttemptBeforeRestart.disposition, "qa_unavailable_terminal");
    assert.equal(qaAssessmentBeforeRestart.status, "qa_unavailable_terminal");
    assert.equal(qaAssessmentBeforeRestart.retryState, "none");
    assert.equal(qaEditBeforeRestart.status, "qa_unavailable");
    assert.equal(qaEditBeforeRestart.retryState, "none");
    const qaAssessmentCallsBeforeRestart = qaUnavailable.assessmentCallCount();
    const qaImageCallsBeforeRestart = qaUnavailable.imageCallCount();
    const qaRecovered = restart(qaUnavailable, { processId: 8310, isProcessAlive: (processId) => processId === 8310 });
    const qaAfterRestart = qaUnavailable.repository.state();
    const qaRestartState = qaRecovered.s4.getState(qaUnavailable.projectId);
    const qaAttemptAfterRestart = qaAfterRestart.s4AssessmentAttempts[0];
    assert.ok(qaAttemptAfterRestart);
    assert.equal(qaUnavailable.assessmentCallCount(), qaAssessmentCallsBeforeRestart);
    assert.equal(qaUnavailable.imageCallCount(), qaImageCallsBeforeRestart);
    assert.equal(qaAttemptAfterRestart.status, "failed");
    assert.equal(qaAttemptAfterRestart.providerDispatchState, "consumed");
    assert.equal(qaAttemptAfterRestart.failureCode, "QA_PROVIDER_REFUSED");
    assert.equal(qaAttemptAfterRestart.disposition, "qa_unavailable_terminal");
    assert.equal(qaAfterRestart.s4Assessments[0].status, "qa_unavailable_terminal");
    assert.equal(qaAfterRestart.s4Assessments[0].retryState, "none");
    assert.equal(qaAfterRestart.s4Edits[0].status, "qa_unavailable");
    assert.equal(qaAfterRestart.s4Edits[0].retryState, "none");
    assert.equal(qaRestartState.edits[0]?.status, "qa_unavailable");
    assert.equal(qaRestartState.edits[0]?.assessment?.status, "QA_UNAVAILABLE");
    assert.equal(qaRestartState.edits[0]?.assessmentRetryAvailable, false);
    assert.equal(qaRestartState.activeRevisionId, qaSelected.sourceRevisionId);
    assert.equal(qaAfterRestart.s3Selections[0].activeRevisionId, qaSelected.sourceRevisionId);
    assert.equal(qaAfterRestart.s3Selections[0].selectionVersion, qaSelected.selectionVersion);
    let qaRetryCode: string | null = null;
    try { qaRecovered.s4.assessmentRetry(qaUnavailable.projectId, qaDone.edits[0].editId, randomUUID(), randomUUID()); }
    catch (error) { qaRetryCode = errorCode(error); }
    assert.equal(qaRetryCode, "S4_ASSESSMENT_RETRY_NOT_AVAILABLE");

    const stalePassSelected = await ready(stalePass);
    admit(stalePass, stalePassSelected, "activation stale pass fence");
    await stalePassEntered.promise;
    const stalePassBefore = stalePass.repository.state();
    const stalePassAttempt = stalePassBefore.s4AssessmentAttempts[0];
    assert.ok(stalePassAttempt);
    stalePass.repository.transact((state) => {
      const selection = state.s3Selections.find((item) => item.selectionStateId === stalePassAttempt.selectionStateId)!;
      selection.selectionVersion += 1;
    });
    stalePassRelease.resolve();
    const stalePassDone = await waitFor(() => stalePass.service.s4.getState(stalePass.projectId), (state) => state.edits[0]?.status === "stale");
    const stalePassAfter = stalePass.repository.state();
    assert.equal(stalePassDone.activeRevisionId, stalePassSelected.sourceRevisionId);
    assert.equal(stalePassAfter.s3Selections[0].activeRevisionId, stalePassSelected.sourceRevisionId);
    assert.equal(stalePassAfter.s3Selections[0].selectionVersion, stalePassSelected.selectionVersion + 1);
    assert.equal(stalePassAfter.s4Transitions.some((item) => item.phase === "activation" && item.reason === "activation_stale"), true);

    const staleWarningSelected = await ready(staleWarning);
    const staleWarningAssessment = staleWarning.s4Provider.runS4Assessment;
    staleWarning.s4Provider.runS4Assessment = async (input) => {
      const result = await staleWarningAssessment(input);
      return { ...result, payload: warningAssessmentPayload(staleWarning.repository) };
    };
    admit(staleWarning, staleWarningSelected, "activation stale warning fence");
    await staleWarningEntered.promise;
    const staleWarningBefore = staleWarning.repository.state();
    const staleWarningAttempt = staleWarningBefore.s4AssessmentAttempts[0];
    assert.ok(staleWarningAttempt);
    staleWarning.repository.transact((state) => {
      const selection = state.s3Selections.find((item) => item.selectionStateId === staleWarningAttempt.selectionStateId)!;
      selection.selectionVersion += 1;
    });
    staleWarningRelease.resolve();
    const staleWarningDone = await waitFor(() => staleWarning.service.s4.getState(staleWarning.projectId), (state) => state.edits[0]?.status === "stale");
    const staleWarningAfter = staleWarning.repository.state();
    assert.equal(staleWarningDone.activeRevisionId, staleWarningSelected.sourceRevisionId);
    assert.equal(staleWarningAfter.s3Selections[0].selectionVersion, staleWarningSelected.selectionVersion + 1);
    assert.equal(staleWarningAfter.s4Transitions.some((item) => item.phase === "activation" && item.reason === "activation_stale"), true);

    const noOpSelected = await ready(noOp);
    noOp.s4Provider.runS4ImageEdit = async () => ({ pngBytes: noOp.sourceBytes, providerRequestId: "s4-no-op" });
    admit(noOp, noOpSelected, "activation no-op fence");
    const noOpDone = await waitFor(() => noOp.service.s4.getState(noOp.projectId), (state) => state.edits[0]?.status === "material_fail");
    const noOpAfter = noOp.repository.state();
    assert.equal(noOpDone.edits[0].preservationStatus, "PASS");
    assert.equal(noOpAfter.s4PreservationChecks[0].noOpDetected, true);
    assert.equal(noOpAfter.s3Selections[0].activeRevisionId, noOpSelected.sourceRevisionId);

    const maskSelected = await ready(maskCrash);
    const maskBaselineCommits = maskCommitCount;
    maskCrashTarget = maskBaselineCommits + 2;
    const maskAdmission = admit(maskCrash, maskSelected, "recovery mask intent crash");
    await waitFor(() => maskCommitCount, (count) => count >= maskCrashTarget!);
    const maskInterrupted = maskCrash.repository.state();
    assert.equal(maskInterrupted.s4Edits[0].maskMaterializationStatus, "pending");
    const maskRecovered = restart(maskCrash, { processId: 8306, isProcessAlive: (processId) => processId === 8306 });
    const maskDone = await waitFor(() => maskRecovered.s4.getState(maskCrash.projectId), (state) => state.edits[0]?.status === "usable_pass");
    assert.equal(maskDone.edits[0].maskReady, true);
    assert.equal(maskAdmission.result.cycleNumber, 1);

    const crashSelected = await ready(activationCrash);
    const crashAssessment = activationCrash.s4Provider.runS4Assessment;
    activationCrash.s4Provider.runS4Assessment = async (input) => {
      const result = await crashAssessment(input);
      assessmentResponseReturned = true;
      return result;
    };
    admit(activationCrash, crashSelected, "recovery activation crash");
    await waitFor(() => assessmentPostResponseCommits, (count) => count >= 2);
    const crashBefore = activationCrash.repository.state();
    const crashAttempt = crashBefore.s4AssessmentAttempts[0];
    const crashAssessmentRecord = crashBefore.s4Assessments[0];
    const crashEdit = crashBefore.s4Edits[0];
    const crashAsset = crashBefore.s4Assets[0];
    assert.ok(crashAttempt && crashAssessmentRecord && crashEdit && crashAsset);
    assert.equal(crashAttempt.status, "running");
    assert.equal(crashAttempt.providerDispatchState, "consumed");
    assert.equal(crashBefore.s4Edits[0].status, "assessment_running");
    assert.equal(crashAssessmentRecord.status, "running");
    assert.equal(crashEdit.retryState, "none");
    const crashAssessmentCallsBeforeRestart = activationCrash.assessmentCallCount();
    const crashImageCallsBeforeRestart = activationCrash.imageCallCount();
    const crashPointerBeforeRestart = crashBefore.s3Selections[0].activeRevisionId;
    const crashSelectionVersionBeforeRestart = crashBefore.s3Selections[0].selectionVersion;
    const crashBytesBefore = activationCrash.objects.read(crashAsset.storageKeyNormalized);
    const crashRecovered = restart(activationCrash, { processId: 8308, isProcessAlive: (processId) => processId === 8308 });
    const crashDone = await waitFor(() => crashRecovered.s4.getState(activationCrash.projectId), (state) => state.edits[0]?.status === "qa_unavailable");
    const crashAfter = activationCrash.repository.state();
    const crashAfterAttempt = crashAfter.s4AssessmentAttempts[0];
    const crashAfterAssessment = crashAfter.s4Assessments[0];
    const crashAfterEdit = crashAfter.s4Edits[0];
    assert.ok(crashAfterAttempt && crashAfterAssessment && crashAfterEdit);
    assert.equal(activationCrash.assessmentCallCount(), crashAssessmentCallsBeforeRestart);
    assert.equal(activationCrash.imageCallCount(), crashImageCallsBeforeRestart);
    assert.equal(crashAfterAttempt.status, "failed");
    assert.equal(crashAfterAttempt.providerDispatchState, "consumed");
    assert.equal(crashAfterAttempt.failureCode, "PERSISTENCE_FAILED");
    assert.equal(crashAfterAttempt.disposition, "qa_unavailable_terminal");
    assert.equal(crashAfterAttempt.claimedBy, null);
    assert.equal(crashAfterAttempt.claimedProcessId, null);
    assert.equal(crashAfterAttempt.claimToken, null);
    assert.deepEqual(crashAfterAttempt.requirementObservations, []);
    assert.deepEqual(crashAfterAttempt.designObservations, []);
    assert.equal(crashAfterAttempt.requestedEditSatisfaction, null);
    assert.equal(crashAfterAttempt.overallRequirementResult, null);
    assert.equal(crashAfterAttempt.overallBuildabilityResult, null);
    assert.equal(crashAfterAttempt.materialFindingIds.length, 0);
    assert.equal(crashAfterAttempt.warningFindingIds.length, 0);
    assert.equal(crashAfterAttempt.uncertainFindingIds.length, 0);
    assert.equal(crashAfterAttempt.evidenceObject, null);
    assert.equal(crashAfterAssessment.status, "qa_unavailable_terminal");
    assert.equal(crashAfterAssessment.retryState, "none");
    assert.equal(crashAfterAssessment.requestedEditSatisfaction, null);
    assert.equal(crashAfterAssessment.overallRequirementResult, null);
    assert.equal(crashAfterAssessment.overallBuildabilityResult, null);
    assert.equal(crashAfterEdit.status, "qa_unavailable");
    assert.equal(crashAfterEdit.retryState, "none");
    assert.equal(crashAfterEdit.outputRevisionId, crashAttempt.revisionId);
    assert.equal(crashAfter.s3Selections[0].activeRevisionId, crashPointerBeforeRestart);
    assert.equal(crashAfter.s3Selections[0].selectionVersion, crashSelectionVersionBeforeRestart);
    assert.equal(crashDone.activeRevisionId, crashSelected.sourceRevisionId);
    assert.equal(activationCrash.objects.read(crashAsset.storageKeyNormalized).equals(crashBytesBefore), true);

    await proveS4Variants("ACTIVATE-001", "S4 high-risk activation matrix proves positive, negative, stale, and atomic fences", "activation-matrix", "The executed activation fixtures established PASS/WARNING activation and every frozen negative, CAS, atomicity, version, and S3-counter fence.", {
      "pass": () => { assert.equal(passDone.activeQuality, "PASS"); assert.equal(passDone.edits[0].status, "usable_pass"); },
      "warning": () => { assert.equal(warningDone.activeQuality, "WARNING"); assert.equal(warningDone.edits[0].status, "usable_warning"); },
      "preserve-fail": () => { assert.equal(preservationDone.edits[0].preservationStatus, "MATERIAL_FAIL"); assert.equal(preservationAfter.s3Selections[0].activeRevisionId, preservationSelected.sourceRevisionId); },
      "material-no": () => { assert.equal(materialDone.edits[0].assessment?.status, "MATERIAL_FAIL"); assert.equal(materialAfter.s3Selections[0].selectionVersion, materialSelected.selectionVersion); },
      "qa-no": () => { assert.equal(qaDone.edits[0].assessment?.status, "QA_UNAVAILABLE"); assert.equal(qaAfter.s3Selections[0].activeRevisionId, qaSelected.sourceRevisionId); },
      "stale-pass": () => { assert.equal(stalePassDone.edits[0].status, "stale"); assert.equal(stalePassAfter.s4Transitions.some((item) => item.reason === "activation_stale"), true); },
      "stale-warning": () => { assert.equal(staleWarningDone.edits[0].status, "stale"); assert.equal(staleWarningAfter.s4Transitions.some((item) => item.reason === "activation_stale"), true); },
      "no-op-no": () => { assert.equal(noOpDone.edits[0].status, "material_fail"); assert.equal(noOpAfter.s4PreservationChecks[0].noOpDetected, true); },
      "cas": () => { assert.equal(passActivation[0].expectedSelectionVersion, passBefore.selectionVersion); assert.equal(passActivation[0].resultingSelectionVersion, passBefore.selectionVersion + 1); },
      "atomic": () => { const active = passAfter.s3Selections[0].activeRevisionId; assert.equal(active, passAfter.s4Revisions[0].revisionId); assert.equal(passAfter.s4Edits[0].status, "completed"); assert.equal(passAfter.s4AssessmentAttempts[0].status, "succeeded"); },
      "version-increment": () => { assert.equal(passAfter.s3Selections[0].selectionVersion - passBefore.selectionVersion, 1); assert.equal(passActivation.length, 1); },
      "s3-counters": () => { assert.deepEqual({ slots: passAfter.s3Selections[0].cycleSlotsConsumed, refinements: passAfter.s3Selections[0].successfulRefinementCount }, passS3Counters); },
    }, [
      "passActivationCount=" + passActivation.length,
      "warningQuality=" + warningDone.activeQuality,
      "passSelectionVersion=" + passAfter.s3Selections[0].selectionVersion,
      "warningSelectionVersion=" + warningAfter.s3Selections[0].selectionVersion,
    ]);
    await proveS4Variants("RECOVERY-001", "S4 high-risk activation matrix proves positive, negative, stale, and atomic fences", "recovery-matrix", "The executed restart fixtures established mask-intent and activation interruption recovery without fabricated success.", {
      "mask-intent-crash": () => { assert.equal(maskInterrupted.s4Edits[0].maskMaterializationStatus, "pending"); assert.equal(maskDone.edits[0].maskReady, true); },
      "activation-crash": () => { assert.equal(crashAttempt.status, "running"); assert.equal(crashAttempt.providerDispatchState, "consumed"); assert.equal(crashAfterAttempt.status, "failed"); assert.equal(crashAfterAttempt.failureCode, "PERSISTENCE_FAILED"); assert.equal(activationCrash.assessmentCallCount(), crashAssessmentCallsBeforeRestart); assert.equal(activationCrash.imageCallCount(), crashImageCallsBeforeRestart); },
      "no-fake": () => { assert.equal(crashDone.edits[0].status, "qa_unavailable"); assert.equal(crashDone.activeRevisionId, crashSelected.sourceRevisionId); assert.deepEqual(crashAfterAttempt.requirementObservations, []); assert.deepEqual(crashAfterAttempt.designObservations, []); assert.equal(crashAfterAttempt.requestedEditSatisfaction, null); assert.equal(crashAfterAttempt.overallRequirementResult, null); assert.equal(crashAfterAttempt.overallBuildabilityResult, null); assert.equal(crashAfterAttempt.evidenceObject, null); assert.equal(crashAfterAssessment.requestedEditSatisfaction, null); assert.equal(crashAfterAssessment.overallRequirementResult, null); assert.equal(crashAfterAssessment.overallBuildabilityResult, null); assert.equal(crashAfterAssessment.retryState, "none"); },
    }, [
      "maskCommitInterruptions=" + (maskCommitCount - maskBaselineCommits),
      "activationCommitInterruptions=" + assessmentPostResponseCommits,
      "crashFailure=" + crashAfter.s4AssessmentAttempts[0].failureCode,
      "crashOutputHash=" + sha256(crashBytesBefore),
    ]);
    await proveS4Variants("ASSESS-RETRY-001", "S4 high-risk activation matrix proves positive, negative, stale, and atomic fences", "terminal-retry-fence", "The executed terminal assessment failure remained QA unavailable and rejected any retry admission.", {
      "terminal-no-retry": () => { assert.equal(qaRestartState.edits[0]?.assessment?.status, "QA_UNAVAILABLE"); assert.equal(qaRestartState.edits[0]?.assessmentRetryAvailable, false); assert.equal(qaAfterRestart.s4AssessmentAttempts[0].failureCode, "QA_PROVIDER_REFUSED"); assert.equal(qaAfterRestart.s4AssessmentAttempts[0].disposition, "qa_unavailable_terminal"); assert.equal(qaRetryCode, "S4_ASSESSMENT_RETRY_NOT_AVAILABLE"); assert.equal(qaUnavailable.assessmentCallCount(), qaAssessmentCallsBeforeRestart); assert.equal(qaUnavailable.imageCallCount(), qaImageCallsBeforeRestart); assert.equal(qaAfterRestart.s3Selections[0].activeRevisionId, qaSelected.sourceRevisionId); },
    }, ["qaFailure=QA_PROVIDER_REFUSED", "retryCode=" + qaRetryCode, "assessmentCallsBeforeRestart=" + qaAssessmentCallsBeforeRestart, "assessmentCallsAfterRestart=" + qaUnavailable.assessmentCallCount(), "imageCallsBeforeRestart=" + qaImageCallsBeforeRestart, "imageCallsAfterRestart=" + qaUnavailable.imageCallCount()]);
    await proveS4Variants("CONCURRENCY-001", "S4 high-risk activation matrix proves positive, negative, stale, and atomic fences", "pointer-race", "The executed assessment completion lost its selection-version race and remained historical without changing the active pointer.", {
      "pointer-race": () => { assert.equal(stalePassDone.edits[0].status, "stale"); assert.equal(stalePassAfter.s3Selections[0].activeRevisionId, stalePassSelected.sourceRevisionId); assert.equal(stalePassAfter.s3Selections[0].selectionVersion, stalePassSelected.selectionVersion + 1); },
    }, ["stalePassSelectionVersion=" + stalePassAfter.s3Selections[0].selectionVersion, "activeRevision=" + stalePassAfter.s3Selections[0].activeRevisionId]);
  } finally {
    stalePassRelease.resolve();
    staleWarningRelease.resolve();
    cleanup(pass);
    cleanup(warning);
    cleanup(preservationFail);
    cleanup(materialFail);
    cleanup(qaUnavailable);
    cleanup(stalePass);
    cleanup(staleWarning);
    cleanup(noOp);
    cleanup(maskCrash);
    cleanup(activationCrash);
  }
});

test("S4 concurrency and fencing matrix exercises locks, claims, stale work, and liveness holds", async () => {
  const lockPhases: RepositoryLockPhase[] = [];
  const keyValue = await fixture({ onLockPhase: (phase) => lockPhases.push(phase) });
  const busyEntered = deferred<void>();
  const busyRelease = deferred<void>();
  const busy = await fixture({
    processId: 8501,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "before-dispatch" && "operationId" in operation) {
        busyEntered.resolve();
        await busyRelease.promise;
      }
    },
  });
  const imageStaleEntered = deferred<void>();
  const imageStaleRelease = deferred<void>();
  let imageStalePaused = false;
  const imageStale = await fixture({
    processId: 8503,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "after-dispatch-marked" && "operationId" in operation && !imageStalePaused) {
        imageStalePaused = true;
        imageStaleEntered.resolve();
        await imageStaleRelease.promise;
      }
    },
  });
  const preserveStale = await fixture();
  const assessmentStaleEntered = deferred<void>();
  const assessmentStaleRelease = deferred<void>();
  let assessmentStalePaused = false;
  const assessmentStale = await fixture({
    processId: 8505,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: async (phase, operation) => {
      if (phase === "after-dispatch-marked" && "assessmentAttemptId" in operation && !assessmentStalePaused) {
        assessmentStalePaused = true;
        assessmentStaleEntered.resolve();
        await assessmentStaleRelease.promise;
      }
    },
  });
  const unknownEntered = deferred<void>();
  const unknown = await fixture({
    processId: 8507,
    isProcessAlive: () => true,
    onS4ProviderDispatchPhase: (phase, operation) => {
      if (phase === "before-dispatch" && "operationId" in operation) {
        unknownEntered.resolve();
        return "interrupt";
      }
    },
  });
  try {
    const keySelected = await ready(keyValue);
    const key = randomUUID();
    const first = admit(keyValue, keySelected, "same key original", key);
    const replay = admit(keyValue, keySelected, "same key original", key, randomUUID());
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.editId, first.result.editId);
    let reuseCode: string | null = null;
    try { admit(keyValue, keySelected, "same key changed instruction", key, randomUUID()); }
    catch (error) { reuseCode = errorCode(error); }
    assert.equal(reuseCode, "S4_IDEMPOTENCY_KEY_REUSE");
    const keyState = await waitFor(() => keyValue.service.s4.getState(keyValue.projectId), (state) => state.edits[0]?.status === "usable_pass");
    assert.ok(lockPhases.includes("canonical-claimed"));
    assert.ok(lockPhases.includes("before-canonical-release"));
    const lockWorker = createWorkflowService({
      repository: new JsonRepository(keyValue.root, { processId: 8509, isProcessAlive: () => true, onLockPhase: (phase) => lockPhases.push(phase) }),
      objects: new PrivateObjectStore(join(keyValue.root, "objects")),
      provider: keyValue.provider,
      s4Provider: keyValue.s4Provider,
      processId: 8509,
      isProcessAlive: () => true,
    });
    assert.equal(lockWorker.s4.getState(keyValue.projectId).activeRevisionId, keyState.activeRevisionId);

    const busySelected = await ready(busy);
    const busyAdmission = admit(busy, busySelected, "different key busy");
    await busyEntered.promise;
    const busyBefore = busy.repository.state();
    const busyOperation = busyBefore.s4ImageOperations[0];
    assert.ok(busyOperation);
    assert.equal(busyOperation.status, "running");
    assert.equal(busyOperation.claimedProcessId, 8501);
    let busyCode: string | null = null;
    try { admit(busy, busySelected, "different key busy competing", randomUUID(), randomUUID()); }
    catch (error) { busyCode = errorCode(error); }
    assert.equal(busyCode, "S4_EDIT_IN_PROGRESS");
    const claimWorker = createWorkflowService({
      repository: new JsonRepository(busy.root, { processId: 8510, isProcessAlive: () => true }),
      objects: new PrivateObjectStore(join(busy.root, "objects")),
      provider: busy.provider,
      s4Provider: busy.s4Provider,
      processId: 8510,
      isProcessAlive: () => true,
    });
    assert.equal(claimWorker.s4.getState(busy.projectId).edits[0].status, "generating");
    busyRelease.resolve();
    const busyDone = await waitFor(() => busy.service.s4.getState(busy.projectId), (state) => state.edits[0]?.status === "usable_pass");
    const busyAfter = busy.repository.state();
    assert.equal(busyAfter.s4ImageOperations.length, 1);
    assert.equal(busyAfter.s4ImageOperations[0].claimedBy, null);
    assert.equal(busyDone.edits[0].status, "usable_pass");

    const imageStaleSelected = await ready(imageStale);
    admit(imageStale, imageStaleSelected, "stale image completion");
    await imageStaleEntered.promise;
    const imageStaleBefore = imageStale.repository.state();
    const staleImageOperation = imageStaleBefore.s4ImageOperations[0];
    assert.ok(staleImageOperation);
    const staleImageToken = staleImageOperation.claimToken;
    imageStale.repository.transact((state) => {
      const operation = state.s4ImageOperations.find((item) => item.operationId === staleImageOperation.operationId)!;
      operation.claimToken = randomUUID();
    });
    imageStaleRelease.resolve();
    await waitFor(() => imageStale.imageCallCount(), (count) => count === 1);
    const imageStaleRecovered = restart(imageStale, { processId: 8504, isProcessAlive: (processId) => processId === 8504 });
    const imageStaleDone = await waitFor(() => imageStaleRecovered.s4.getState(imageStale.projectId), (state) => state.edits[0]?.status === "image_failed");
    const imageStaleAfter = imageStale.repository.state();
    assert.notEqual(imageStaleAfter.s4ImageOperations[0].claimToken, staleImageToken);
    assert.equal(imageStaleAfter.s4ImageOperations[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN");
    assert.equal(imageStaleAfter.s4Revisions.length, 0);
    assert.equal(imageStaleDone.activeRevisionId, imageStaleSelected.sourceRevisionId);

    const preserveSelected = await ready(preserveStale);
    admit(preserveStale, preserveSelected, "stale preservation completion");
    const preserveClaimMutated = deferred<void>();
    let preserveCompletionCalled = false;
    let preserveCompletionResult: unknown = undefined;
    const preserveService = preserveStale.service.s4 as any;
    const originalClaimPreservation = preserveService.claimPreservation;
    const originalCompletePreservation = preserveService.completePreservation;
    preserveService.claimPreservation = function (preservationCheckId: UUID) {
      const result = originalClaimPreservation.call(this, preservationCheckId);
      if (result) {
        preserveStale.repository.transact((state) => {
          const check = state.s4PreservationChecks.find((item) => item.preservationCheckId === preservationCheckId)!;
          check.claimToken = randomUUID();
        });
        preserveClaimMutated.resolve();
      }
      return result;
    };
    preserveService.completePreservation = function (...args: any[]) {
      preserveCompletionCalled = true;
      preserveCompletionResult = originalCompletePreservation.apply(this, args);
      return preserveCompletionResult;
    };
    await preserveClaimMutated.promise;
    await waitFor(() => preserveCompletionCalled, (called) => called);
    const preserveAfter = preserveStale.repository.state();
    assert.equal(preserveCompletionResult, null);
    assert.equal(preserveAfter.s4PreservationChecks[0].status, "running");
    assert.equal(preserveAfter.s4Edits[0].status, "preservation_running");
    assert.equal(preserveAfter.s4AssessmentAttempts.length, 0);

    const assessmentStaleSelected = await ready(assessmentStale);
    admit(assessmentStale, assessmentStaleSelected, "stale assessment completion");
    await assessmentStaleEntered.promise;
    const assessmentStaleBefore = assessmentStale.repository.state();
    const staleAssessmentAttempt = assessmentStaleBefore.s4AssessmentAttempts[0];
    assert.ok(staleAssessmentAttempt);
    const staleAssessmentToken = staleAssessmentAttempt.claimToken;
    assessmentStale.repository.transact((state) => {
      const attempt = state.s4AssessmentAttempts.find((item) => item.assessmentAttemptId === staleAssessmentAttempt.assessmentAttemptId)!;
      attempt.claimToken = randomUUID();
    });
    assessmentStaleRelease.resolve();
    await waitFor(() => assessmentStale.assessmentCallCount(), (count) => count === 1);
    const assessmentStaleRecovered = restart(assessmentStale, { processId: 8506, isProcessAlive: (processId) => processId === 8506 });
    const assessmentStaleDone = await waitFor(() => assessmentStaleRecovered.s4.getState(assessmentStale.projectId), (state) => state.edits[0]?.status === "qa_unavailable");
    const assessmentStaleAfter = assessmentStale.repository.state();
    assert.notEqual(assessmentStaleAfter.s4AssessmentAttempts[0].claimToken, staleAssessmentToken);
    assert.equal(assessmentStaleAfter.s4AssessmentAttempts[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN");
    assert.equal(assessmentStaleAfter.s3Selections[0].activeRevisionId, assessmentStaleSelected.sourceRevisionId);
    assert.equal(assessmentStaleDone.activeRevisionId, assessmentStaleSelected.sourceRevisionId);

    const unknownSelected = await ready(unknown);
    admit(unknown, unknownSelected, "unknown live owner hold");
    await unknownEntered.promise;
    const unknownBefore = unknown.repository.state();
    const unknownOperation = unknownBefore.s4ImageOperations[0];
    assert.ok(unknownOperation);
    const unknownRecovered = restart(unknown, { processId: 8508, isProcessAlive: () => true });
    const unknownAfter = unknown.repository.state();
    assert.equal(unknownAfter.s4ImageOperations[0].status, "running");
    assert.equal(unknownAfter.s4ImageOperations[0].providerDispatchState, "not_started");
    assert.equal(unknownAfter.s4ImageOperations[0].claimedProcessId, 8507);
    assert.equal(unknownRecovered.s4.getState(unknown.projectId).edits[0].status, "generating");
    assert.equal(unknown.imageCallCount(), 0);

    await proveS4Variants("CONCURRENCY-001", "S4 concurrency and fencing matrix exercises locks, claims, stale work, and liveness holds", "concurrency-matrix", "The executed concurrent-worker fixtures established repository locking, idempotency, claims, stale-result fencing, pointer ownership, and unknown-owner holds.", {
      "repo-lock": () => { assert.ok(lockPhases.includes("canonical-claimed")); assert.ok(lockPhases.includes("before-canonical-release")); assert.equal(lockWorker.s4.getState(keyValue.projectId).activeRevisionId, keyState.activeRevisionId); },
      "same-key": () => { assert.equal(replay.replayed, true); assert.equal(replay.result.editId, first.result.editId); },
      "s4-idempotency-reuse": () => assert.equal(reuseCode, "S4_IDEMPOTENCY_KEY_REUSE"),
      "different-key-busy": () => { assert.equal(busyCode, "S4_EDIT_IN_PROGRESS"); assert.equal(busyDone.edits[0].status, "usable_pass"); },
      "claims": () => { assert.equal(busyOperation.claimedProcessId, 8501); assert.equal(busyAfter.s4ImageOperations[0].claimedBy, null); assert.equal(busyAfter.s4ImageOperations.length, 1); },
      "image-stale": () => { assert.equal(imageStaleAfter.s4ImageOperations[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN"); assert.equal(imageStaleAfter.s4Revisions.length, 0); },
      "preserve-stale": () => { assert.equal(preserveCompletionResult, null); assert.equal(preserveAfter.s4PreservationChecks[0].status, "running"); },
      "assessment-stale": () => { assert.equal(assessmentStaleAfter.s4AssessmentAttempts[0].failureCode, "PROVIDER_DISPATCH_UNCERTAIN"); assert.equal(assessmentStaleAfter.s4Revisions.length, 1); },
      "unknown-hold": () => { assert.equal(unknownAfter.s4ImageOperations[0].status, "running"); assert.equal(unknownAfter.s4ImageOperations[0].providerDispatchState, "not_started"); assert.equal(unknown.imageCallCount(), 0); },
    }, [
      "lockEvents=" + lockPhases.length,
      "sameKeyReplay=" + replay.replayed,
      "imageStaleCalls=" + imageStale.imageCallCount(),
      "assessmentStaleCalls=" + assessmentStale.assessmentCallCount(),
      "unknownOwnerProcessId=" + unknownAfter.s4ImageOperations[0].claimedProcessId,
    ]);
  } finally {
    busyRelease.resolve();
    imageStaleRelease.resolve();
    assessmentStaleRelease.resolve();
    cleanup(keyValue);
    cleanup(busy);
    cleanup(imageStale);
    cleanup(preserveStale);
    cleanup(assessmentStale);
    cleanup(unknown);
  }
});

test("S4 API enforces auth-first access, exact JSON routes, safe errors, and S3 rollback to S4 history", async () => {
  const value = await fixture();
  try {
    const selected = await ready(value);
    const calls: string[] = [];
    const dependencies: ApiRequestDependencies = {
      workflowService: value.service,
      s3Authorization: {
        resolveContext: async () => { calls.push("context"); return { subjectId: "s4-test-subject" }; },
        authorizeProject: async (_context, projectId) => { calls.push("authorize:" + projectId); return projectId === value.projectId; },
      },
    };
    const get = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4"], dependencies);
    assert.equal(get.status, 200);
    const initial = await get.json() as S4StateForTest;
    assert.equal(initial.stageStatus, "not_started");
    assert.deepEqual(calls, ["context", "authorize:" + value.projectId]);

    const body = { baseRevisionId: selected.sourceRevisionId, expectedSelectionVersion: selected.selectionVersion, primitives: EDIT_PRIMITIVES, instructionText: "API local edit" };
    const key = randomUUID();
    const admitted = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(admitted.status, 202);
    const replay = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as any).replayed, true);
    const editId = (await admitted.clone().json() as any).result.editId;
    const detail = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4", "edits", editId], dependencies);
    assert.equal(detail.status, 200);
    const publicPayload = JSON.stringify(await detail.json());
    assert.equal(publicPayload.includes("storageKey"), false);
    assert.equal(publicPayload.includes("providerMetadata"), false);
    assert.equal(publicPayload.includes("promptHash"), false);
    assert.equal(publicPayload.includes("OPENAI_API_KEY"), false);

    const tooLarge = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "content-length": "131073", "Idempotency-Key": randomUUID() }, body: "{}" }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(tooLarge.status, 400);
    const tooLargeBody = await tooLarge.json() as any;
    assert.equal(tooLargeBody.error.code, "INVALID_REQUEST");
    assert.deepEqual(tooLargeBody.error.fieldErrors, [{ field: "body", code: "BODY_TOO_LARGE" }]);
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(131_073));
        controller.close();
      },
    });
    const streamedTooLarge = await handleApiRequest(new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: streamedBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(streamedTooLarge.status, 400);
    const streamedTooLargeBody = await streamedTooLarge.json() as any;
    assert.equal(streamedTooLargeBody.error.code, "INVALID_REQUEST");
    assert.deepEqual(streamedTooLargeBody.error.fieldErrors, [{ field: "body", code: "BODY_TOO_LARGE" }]);
    const wrongMethod = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4", "edits"], dependencies);
    assert.equal(wrongMethod.status, 405);
    const denied = await handleApiRequest(new Request("http://localhost", { method: "GET" }), ["projects", value.projectId, "s4"], { workflowService: value.service, s3Authorization: { resolveContext: () => null, authorizeProject: () => true } });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as any).error.code, "PROJECT_NOT_FOUND");

    const completed = await waitFor(() => value.service.s4.getState(value.projectId), (current) => current.edits[0]?.status === "usable_pass");
    const sourceRollback = await handleApiRequest(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ targetKind: "revision", targetId: selected.sourceRevisionId, expectedSelectionVersion: completed.selectionVersion }) }), ["projects", value.projectId, "s3", "selection"], dependencies);
    assert.equal(sourceRollback.status, 200);
    const rollbackBody = await sourceRollback.json() as any;
    assert.equal(rollbackBody.result.eventKind, "rollback");
    assert.equal(rollbackBody.result.activeRevisionId, selected.sourceRevisionId);
    assert.equal(value.repository.state().s4Transitions.some((item) => item.phase === "rollback" && item.to === "rollback"), true);
  } finally { cleanup(value); }
});

type S4StateForTest = { stageStatus: string; selectionVersion: number };
