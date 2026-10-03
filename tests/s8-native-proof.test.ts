import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import {
  parseStrictJson,
  readS8ApplicationTrust,
} from "../src/lib/s8-fbx-config";
import {
  createS8NativeProofAuthority,
  type S8RepositoryProofBinding,
} from "../src/lib/s8-native-proof";


import { randomBytes, randomUUID, sign } from "node:crypto";
import { cpSync } from "node:fs";
import {
  AppError,
  type S5ToS6Projection,
  type S6CorrectionOperation,
  type S6MutationResult,
  type S6SpatialModelRecord,
  type S6ToS7Handoff,
  type S7ToS8Handoff,
  type S8Artifact,
  type UUID,
} from "../src/lib/types";
import { readS5ToS6Projection } from "../src/lib/s5";
import { readS6ToS7Handoff, S6WorkflowService } from "../src/lib/s6";
import { evaluateS6Requirements } from "../src/lib/s6-validation";
import { createS6SourceReader } from "../src/lib/s6-source";
import { readS7ToS8Handoff, S7CadService } from "../src/lib/s7-cad";
import { S8ExportService, type S8PublicationPhaseHook, validateS8Readback } from "../src/lib/s8";
import { S8NativeWorkerClient } from "../src/lib/s8-native-worker-client";
import type { S8NativeWorkerConfig } from "../src/lib/s8-fbx-config";
import { canonicalS8SourceJson } from "../src/lib/s8-fbx-payload";
import { canonicalS8RunnerReceiptBytes, type S8RunnerEvidence } from "../src/lib/s8-fbx-worker";
import { emptyStoreState, JsonRepository, PrivateObjectStore } from "../src/lib/store";
import { S8_NATIVE_RESOURCE_POLICY, S8_NATIVE_RESOURCE_POLICY_SHA256 } from "../src/lib/s8-native-admission";
import { buildS8Mesh } from "../src/lib/s8-fbx-geometry";
import { buildS8TransformOracle } from "../src/lib/s8-fbx-oracle";
import {
  S8_BLENDER_PIN, S8_FBX_PROFILE, S8_LIMITS, S8_PROCESS_RUNNER_PIN, S8_UFBX_PIN,
  S8_VALIDATOR_PIN, S8_WRITER_RECEIPT_VERSION, s8Sha256, s8StableName,
} from "../src/lib/s8-fbx-profile";
import {
  S8_NATIVE_WORKER_PROTOCOL_VERSION, verifyS8ReleaseManifest,
  type S8ReleaseManifestBody, type S8SignedReleaseManifest,
} from "../src/lib/s8-native-release";
import { jcs, sha256 } from "../src/lib/utils";
import { cleanupS5Fixture, createS5Fixture, makeS5Ready } from "./s5-fixture";
import type { S8UfbxReadback } from "../src/lib/s8-fbx-semantic";

export let projectId = "20000000-0000-4000-8000-000000000001" as UUID;
function fixturePair(environmentName: string) {
  const encodedPrivateKey = process.env[environmentName];
  if (!encodedPrivateKey) return generateKeyPairSync("ed25519");
  const privateKey = createPrivateKey(encodedPrivateKey);
  return { privateKey, publicKey: createPublicKey(privateKey) };
}
const appPair = fixturePair("S8_G135_TEST_APP_PRIVATE_PEM");
const releasePair = fixturePair("S8_G135_TEST_RELEASE_PRIVATE_PEM");
const capacityPair = fixturePair("S8_G135_TEST_CAPACITY_PRIVATE_PEM");
const launcherPair = fixturePair("S8_G135_TEST_LAUNCHER_PRIVATE_PEM");
const appPrivatePem = appPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const appPublicPem = appPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const releasePublicPem = releasePair.publicKey.export({ type: "spki", format: "pem" }).toString();
const capacityPublicPem = capacityPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const launcherPublicPem = launcherPair.publicKey.export({ type: "spki", format: "pem" }).toString();
export const testDigest = "a".repeat(64);
const imageDigest = `sha256:${"b".repeat(64)}`;

function signBody(domain: string, body: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  return sign(null, Buffer.concat([Buffer.from(`${domain}\0`, "ascii"), Buffer.from(jcs(body), "utf8")]), privateKey).toString("base64url");
}

function signedReleaseManifest(): S8SignedReleaseManifest {
  const now = Date.now();
  const body: S8ReleaseManifestBody = {
    schemaVersion: "s8-release-manifest-v2", releaseId: "offline-publication-test", sequence: 1,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString(),
    signingKeyId: "release-test", protocolVersion: S8_NATIVE_WORKER_PROTOCOL_VERSION, profile: S8_FBX_PROFILE,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256, processRunnerSha256: testDigest,
    writer: {
      imageDigest, blenderVersion: S8_BLENDER_PIN.version, blenderArchiveSha256: S8_BLENDER_PIN.archiveSha256,
      exporterPatchSha256: testDigest, writerScriptSha256: testDigest,
    },
    validator: {
      imageDigest, identity: S8_VALIDATOR_PIN.identity, ufbxVersion: S8_UFBX_PIN.version,
      ufbxCommit: S8_UFBX_PIN.commit, ufbxTree: S8_UFBX_PIN.tree, executableSha256: testDigest,
    },
    sandbox: {
      seccompPolicySha256: testDigest, jobAppArmorMode: "unsupported-not-relied-upon",
      rootlessKitHostAppArmor: { mode: "required-profile", profileName: "swooshz-s8-rootlesskit-v1", profileSha256: testDigest },
    },
    provenanceSha256: testDigest, sbomSha256: testDigest,
  };
  return { manifest: body, signature: signBody("S8-RELEASE-MANIFEST-V2", body, releasePair.privateKey) };
}

const releaseManifest = process.env.S8_G135_TEST_RELEASE_MANIFEST_JSON === undefined
  ? signedReleaseManifest()
  : JSON.parse(process.env.S8_G135_TEST_RELEASE_MANIFEST_JSON) as S8SignedReleaseManifest;
const releaseManifestSha256 = verifyS8ReleaseManifest(releaseManifest, { "release-test": releasePublicPem }).sha256;
const nativeConfig: S8NativeWorkerConfig = Object.freeze({
  gatewayUrl: "https://s8-offline-fixture.invalid/", appSigningKeyId: "app-test", appSigningPrivateKeyPem: appPrivatePem,
  releaseManifest, releaseAuthorityKeys: { "release-test": releasePublicPem },
  capacityAuthorityKeys: { "capacity-test": capacityPublicPem }, launcherKeys: { "launcher-test": launcherPublicPem },
  tlsCaPem: "offline fixture", tlsClientCertPem: "offline fixture", tlsClientKeyPem: "offline fixture",
});

function createRepository(root: string, beforeCommit?: () => void): JsonRepository {
  const names = ["S8_APP_SIGNING_KEY_ID", "S8_APP_SIGNING_PRIVATE_KEY_PEM", "S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON"] as const;
  const prior = names.map((name) => process.env[name]);
  process.env.S8_APP_SIGNING_KEY_ID = "app-test";
  process.env.S8_APP_SIGNING_PRIVATE_KEY_PEM = appPrivatePem;
  process.env.S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON = JSON.stringify({
    schemaVersion: "s8-app-acceptance-keyset-v1", keys: [{ keyId: "app-test", publicKeyPem: appPublicPem }],
  });
  try { return new JsonRepository(root, { beforeCommit }); }
  finally {
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
  }
}

function budget(cpuMilli: number, memoryBytes: number, pids: number) {
  return { cpuMilli, memoryBytes, pids };
}

function sumBudgets(items: readonly ReturnType<typeof budget>[]) {
  return items.reduce((sum, item) => ({ cpuMilli: sum.cpuMilli + item.cpuMilli, memoryBytes: sum.memoryBytes + item.memoryBytes, pids: sum.pids + item.pids }), budget(0, 0, 0));
}

function openAdmissionEnvelope() {
  const now = Date.now();
  const measuredAt = new Date(now).toISOString();
  const writer = budget(S8_NATIVE_RESOURCE_POLICY.writer.cpuMilli, S8_NATIVE_RESOURCE_POLICY.writer.memoryBytes,
    S8_NATIVE_RESOURCE_POLICY.writer.pids);
  const validator = budget(S8_NATIVE_RESOURCE_POLICY.validator.cpuMilli, S8_NATIVE_RESOURCE_POLICY.validator.memoryBytes,
    S8_NATIVE_RESOURCE_POLICY.validator.pids);
  const activeCpu = Math.max(writer.cpuMilli, validator.cpuMilli);
  const activeMemory = Math.max(writer.memoryBytes, validator.memoryBytes);
  const activePids = Math.max(writer.pids, validator.pids);
  const application = budget(4000, 4 * 1024 ** 3, 512);
  const gateway = budget(2000, 2 * 1024 ** 3, 256);
  const launcher = budget(2000, 2 * 1024 ** 3, 256);
  const rootlessDocker = budget(activeCpu + 1000, activeMemory + 512 * 1024 ** 2, activePids + 16);
  const systemd = budget(2000, 2 * 1024 ** 3, 512);
  const streaming = budget(2000, 2 * 1024 ** 3, 128);
  const designAggregate = sumBudgets([application, gateway, launcher, rootlessDocker, systemd, streaming]);
  const workloadBudget = budget(1000, 2 * 1024 ** 3, 100);
  const workloadIds = ["future-non-design", "n8n", "other-siblings", "quote", "wordpress"];
  const nonDesignWorkloads = workloadIds.map((workloadId) => ({
    workloadId,
    cgroupPath: `/swooshz.slice/swooshz-non-design.slice/swooshz-non-design-${workloadId}.slice`,
    budget: workloadBudget,
  }));
  const nonDesignAggregate = sumBudgets(nonDesignWorkloads.map((item) => item.budget));
  nonDesignAggregate.cpuMilli += 1000; nonDesignAggregate.memoryBytes += 1024 ** 3; nonDesignAggregate.pids += 100;
  const protectedHostReserve = budget(4000, 8 * 1024 ** 3, 2048);
  const host = sumBudgets([designAggregate, nonDesignAggregate, protectedHostReserve, budget(32_000, 64 * 1024 ** 3, 30_000)]);
  const proof = {
    schemaVersion: "s8-capacity-proof-v1", proofId: `offline-${String(now)}`, state: "OPEN",
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 4 * 60_000).toISOString(), signingKeyId: "capacity-test",
    host: { hostId: "offline-synthetic-host", ...host, measuredAt },
    allocation: {
      designAggregate, designApplication: application, gateway, launcher, rootlessDocker, rootlessDockerUid: 1000,
      systemd, streaming, writer, validator, nonDesignAggregate, nonDesignWorkloads, protectedHostReserve,
    },
    oneOperationAtATime: true, workloadInventorySha256: testDigest, cgroupTreeSha256: "c".repeat(64),
    releaseManifestSha256, resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    contentionEvidenceIds: ["offline-contention-check"], resourceLimitEvidenceIds: ["offline-resource-check"],
  };
  const capacity = { proof, signature: signBody("S8-CAPACITY-PROOF-V1", proof, capacityPair.privateKey) };
  const observation = {
    schemaVersion: "s8-launcher-observation-v2", proofSha256: sha256(jcs(capacity)), state: "OPEN",
    observedAt: measuredAt, launcherKeyId: "launcher-test", hostId: proof.host.hostId,
    cpuMilli: proof.host.cpuMilli, memoryBytes: proof.host.memoryBytes, pids: proof.host.pids,
    workloadInventorySha256: proof.workloadInventorySha256, cgroupTreeSha256: proof.cgroupTreeSha256,
    releaseManifestSha256, resourcePolicySha256: proof.resourcePolicySha256,
    jobAppArmorMode: "unsupported-not-relied-upon", rootlessKitHostAppArmorMode: "required-profile",
    rootlessKitHostAppArmorProfileName: "swooshz-s8-rootlesskit-v1", rootlessKitHostAppArmorProfileSha256: testDigest,
    cgroupV2: true, rootlessDocker: true, requiredControllers: ["cpu", "memory", "pids"],
    startupReconciled: true, unreconciledContainerCount: 0,
  };
  return {
    capacity,
    launcher: { observation, signature: signBody("S8-LAUNCHER-OBSERVATION-V2", observation, launcherPair.privateKey) },
  };
}

export function runnerEvidence(kind: "writer" | "validator", runnerSha256 = kind === "validator" ? "b".repeat(64) : testDigest): S8RunnerEvidence {
  const validator = kind === "validator";
  const addressSpaceBytes = validator ? S8_LIMITS.validatorMemoryBytes : S8_LIMITS.writerAddressSpaceBytes;
  const fileBytes = validator ? S8_LIMITS.validatorTempBytes : S8_LIMITS.artifactBytes;
  const timeoutMs = validator ? S8_LIMITS.validatorTimeoutMs : S8_LIMITS.timeoutMs;
  const stdoutBytes = validator ? S8_LIMITS.readbackBytes : S8_LIMITS.stdoutBytes;
  const cpuSeconds = Math.ceil(timeoutMs / 1000) + 1;
  const evidence: Omit<S8RunnerEvidence, "verifiedByCaller"> = {
    schemaVersion: S8_PROCESS_RUNNER_PIN.protocol, protocol: S8_PROCESS_RUNNER_PIN.protocol, policyId: S8_PROCESS_RUNNER_PIN.policy,
    requested: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, wallTimeoutMs: timeoutMs, stdoutBytes, stderrBytes: S8_LIMITS.stderrBytes, maxChildren: 0 },
    appliedByChild: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    observedByRunnerParent: { rlimitAsBytes: addressSpaceBytes, rlimitFsizeBytes: fileBytes, rlimitCpuSeconds: cpuSeconds, rlimitNproc: 64, noNewPrivs: 1, seccompMode: 2 },
    runnerParentVerification: { status: "PASS", mismatchCode: null }, runnerBinary: { selfSha256: runnerSha256 },
    result: { code: 0, name: "S8_RUNNER_SUCCESS", terminationClass: "target-exit-zero", targetExit: 0, targetSignal: null, elapsedMs: 1, stdoutBytes: 0, stderrBytes: 0, setupStage: null, evidenceCode: null },
  };
  return {
    ...evidence,
    verifiedByCaller: {
      schemaVersion: "s8-runner-caller-verification-v2", status: "VERIFIED_BY_CALLER",
      preLaunchSha256: runnerSha256, postLaunchSha256: runnerSha256, runnerReportedSelfSha256: runnerSha256,
      outerExitStatus: 0, outerSignal: null, observedStdoutBytes: 0, observedStderrBytes: 0,
      receiptSha256: s8Sha256(canonicalS8RunnerReceiptBytes(evidence as S8RunnerEvidence)),
    },
  };
}

export type FixtureOptions = {
  writerEvidence?: S8RunnerEvidence;
  validatorEvidence?: S8RunnerEvidence;
  omitWriterEvidence?: boolean;
  omitValidatorEvidence?: boolean;
  omitValidatorIdentity?: boolean;
  nativeReadback?: S8UfbxReadback;
  onPublicationPhase?: S8PublicationPhaseHook;
  clock?: () => string;
  beforeCommit?: () => void;
  root?: string;
  reuseExistingRoot?: boolean;
  onNativeDispatch?: (operation: "WRITER" | "VALIDATOR", request: unknown) => void | Promise<void>;
};

let acceptedSourceRoot: string | null = null;
export let acceptedS5Fixture: Awaited<ReturnType<typeof createS5Fixture>> | null = null;
export type ProductionS6Draft = {
  fixture: Awaited<ReturnType<typeof createS5Fixture>>;
  projectId: UUID;
  source: S5ToS6Projection;
  s6: S6WorkflowService;
  generated: S6MutationResult;
  corrected: S6MutationResult;
};

function designFormConfirmation(model: Pick<S6SpatialModelRecord, "unknowns">): S6CorrectionOperation[] {
  const objectIds = model.unknowns
    .filter((item) => item.kind === "design_form")
    .map((item) => /^objects\[(.+)\]\.primitive$/u.exec(item.fieldPath)?.[1])
    .filter((item): item is string => item !== undefined);
  return objectIds.length > 0
    ? [{ kind: "confirm_design_inference", objectIds, note: "Confirm the bounded typed form for the offline fixture." }]
    : [];
}

function entryClearMovement(model: Pick<S6SpatialModelRecord, "objects">): S6CorrectionOperation[] {
  const movable = model.objects.filter((item) => item.editable && item.removable && item.objectType !== "overhead_volume" && item.objectType !== "zone_region" &&
    item.role !== "booth_floor" && item.role !== "booth_wall" && item.role !== "zone");
  return movable.flatMap((item, index) => {
    const targetX = 1200 + (index % 3) * 1800;
    const targetZ = 1200 + Math.floor(index / 3) * 1800;
    const deltaMm = {
      xMm: targetX - item.transform.positionMm.xMm,
      yMm: 0,
      zMm: targetZ - item.transform.positionMm.zMm,
    };
    return deltaMm.xMm === 0 && deltaMm.zMm === 0 ? [] : [{ kind: "move", objectId: item.objectId, deltaMm }];
  });
}

export async function createProductionS6Draft(): Promise<ProductionS6Draft> {
  const fixture = await createS5Fixture();
  const sourceProjectId = fixture.projectId as UUID;
  try {
    await makeS5Ready(fixture);
    const approval = fixture.service.s5.approve(sourceProjectId, fixture.service.s5.getFence(sourceProjectId), randomUUID() as UUID, randomUUID() as UUID);
    assert.equal(approval.approval.status, "approved");
    fixture.service.s5.generateLayout(sourceProjectId, fixture.service.s5.getFence(sourceProjectId), randomUUID() as UUID, randomUUID() as UUID);
    await fixture.service.s5.generatePresentation(sourceProjectId, fixture.service.s5.getFence(sourceProjectId), randomUUID() as UUID, randomUUID() as UUID);
    const source = fixture.service.s5.getS6ReadOnlyProjection(sourceProjectId);
    assert.equal(source.readiness, "ready");
    assert.equal(source.layoutArtifacts.planJson.status, "committed");
    assert.equal(source.layoutArtifacts.planSvg.status, "committed");
    assert.equal(source.presentationArtifact.status, "committed");
    const sourceReader = createS6SourceReader(fixture.repository, fixture.objects,
      (project) => fixture.service.s5.getS6ReadOnlyProjection(project));
    const s6 = new S6WorkflowService({ repository: fixture.repository, objects: fixture.objects, sourceReader, isProcessAlive: () => false });
    const generated = await s6.generate(sourceProjectId, randomUUID() as UUID, randomUUID() as UUID, "subject-s8-publication-test");
    const initial = s6.getRevision(sourceProjectId, generated.revisionId).revision;
    const operations = [...designFormConfirmation(initial), ...entryClearMovement(initial)];
    assert.ok(operations.some((item) => item.kind === "move"), "the production fixture must record a typed movement correction");
    const corrected = await s6.correct(sourceProjectId, generated.revisionId, generated.concurrency, operations,
      randomUUID() as UUID, randomUUID() as UUID, "subject-s8-publication-test");
    return { fixture, projectId: sourceProjectId, source, s6, generated, corrected };
  } catch (error) {
    cleanupS5Fixture(fixture);
    throw error;
  }
}

export function assertPreservedProductionRequirements(source: S5ToS6Projection, model: Pick<S6SpatialModelRecord, "objects">): {
  geometryIds: Set<string>;
  entryRequirementId: string;
  prohibitedRequirementId: string;
} {
  const geometryRequirements = source.canonicalRequirements.filter((item) => item.category === "geometry");
  const geometryIds = new Set(geometryRequirements.map((item) => item.requirementId));
  assert.equal(geometryRequirements.length, 4, "the production source must retain exactly four geometry facts");
  assert.deepEqual([...geometryIds].sort(), ["access.open-sides", "geometry.depth", "geometry.max-height", "geometry.width"]);
  assert.equal(model.objects.some((object) => object.requirementIds.some((id) => geometryIds.has(id))), false,
    "geometry facts must remain booth evidence and never become object mappings");
  const entryRequirement = source.canonicalRequirements.find((item) => item.category === "mandatory" && item.text === "Keep the entry clear.");
  const prohibitedRequirement = source.canonicalRequirements.find((item) => item.category === "prohibited" && item.text === "No enclosed ceiling.");
  assert.ok(entryRequirement, "the confirmed entry-clear requirement must survive the S5 projection");
  assert.ok(prohibitedRequirement, "the prohibited-ceiling requirement must survive the S5 projection");
  return { geometryIds, entryRequirementId: entryRequirement.requirementId, prohibitedRequirementId: prohibitedRequirement.requirementId };
}

export function currentS6Token(route: ProductionS6Draft) {
  const token = route.s6.getState(route.projectId).concurrency;
  assert.ok(token);
  return token;
}

export async function correctProductionDraft(route: ProductionS6Draft, revision: S6MutationResult, operations: S6CorrectionOperation[]): Promise<S6MutationResult> {
  return route.s6.correct(route.projectId, revision.revisionId, currentS6Token(route), operations,
    randomUUID() as UUID, randomUUID() as UUID, "subject-s8-publication-test");
}

export async function validateProductionDraft(route: ProductionS6Draft, revision: S6MutationResult) {
  return route.s6.validate(route.projectId, revision.revisionId, currentS6Token(route), randomUUID() as UUID, randomUUID() as UUID);
}

export async function acceptProductionDraft(route: ProductionS6Draft, revision: S6MutationResult) {
  return route.s6.accept(route.projectId, revision.revisionId, currentS6Token(route), randomUUID() as UUID, randomUUID() as UUID, "subject-s8-publication-test");
}

export function requirementEvaluation(model: S6SpatialModelRecord, source: S5ToS6Projection, requirementId: string) {
  const result = evaluateS6Requirements(model, source).find((item) => item.requirementId === requirementId);
  assert.ok(result, `missing derived requirement evaluation ${requirementId}`);
  assert.equal(result.sourceFingerprint, source.sourceFingerprint);
  return result;
}

async function buildAcceptedSourceSnapshot(): Promise<string> {
  const route = await createProductionS6Draft();
  const { fixture, projectId: sourceProjectId, source, s6, corrected } = route;
  acceptedS5Fixture = fixture;
  acceptedSourceRoot = fixture.root;
  projectId = sourceProjectId;
  const reviewed = fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === corrected.revisionId);
  assert.ok(reviewed, "the corrected production revision must remain in the authoritative repository");
  const preserved = assertPreservedProductionRequirements(source, reviewed);
  const positiveValidation = await validateProductionDraft(route, corrected);
  assert.equal(positiveValidation.validatorVersion, "s6-validator-v2");
  assert.equal(positiveValidation.outcome === "pass" || positiveValidation.outcome === "pass_with_warnings", true, JSON.stringify(positiveValidation.errors));
  for (const requirementId of preserved.geometryIds) {
    const evaluation = requirementEvaluation(reviewed, source, requirementId);
    assert.equal(evaluation.outcome, "satisfied");
    assert.equal(evaluation.evidenceKind, "booth_fields");
    assert.equal(evaluation.objectIds.length, 0);
    const expectedFields: Record<string, string[]> = {
      "access.open-sides": ["booth-wall-integrity", "booth.openSides"],
      "geometry.depth": ["booth.depthMm", "floor.depthMm"],
      "geometry.max-height": ["booth.maxHeightMm", "world.top"],
      "geometry.width": ["booth.widthMm", "floor.widthMm"],
    };
    assert.deepEqual(evaluation.boothFields, expectedFields[requirementId]);
  }
  const entryEvaluation = requirementEvaluation(reviewed, source, preserved.entryRequirementId);
  assert.equal(entryEvaluation.outcome, "satisfied");
  assert.equal(entryEvaluation.evidenceKind, "scene_predicate");
  assert.equal(entryEvaluation.predicateVersion, "entry-clear-v1");
  assert.deepEqual(entryEvaluation.objectIds, [], "the typed movement must clear every production entry volume");
  assert.deepEqual(entryEvaluation.boothFields, ["booth.depthMm", "booth.openSides", "booth.widthMm", "objects.transform"]);
  const prohibitedEvaluation = requirementEvaluation(reviewed, source, preserved.prohibitedRequirementId);
  assert.equal(prohibitedEvaluation.outcome, "satisfied");
  assert.equal(prohibitedEvaluation.evidenceKind, "prohibited_absence");
  assert.equal(prohibitedEvaluation.predicateVersion, "forbidden-family-absence-v1");
  assert.deepEqual(prohibitedEvaluation.objectIds, []);
  await acceptProductionDraft(route, corrected);
  const stateAfterAccept = fixture.repository.state();
  const currentSource = fixture.service.s5.getS6ReadOnlyProjection(projectId);
  const acceptedModel = stateAfterAccept.s6SpatialModels.find((item) => item.projectId === projectId && item.status === "accepted_current");
  assert.ok(acceptedModel);
  const validationReceipt = stateAfterAccept.s6ValidationReceipts.find((item) => item.receiptId === acceptedModel.validationReceiptId);
  assert.ok(validationReceipt);
  const sourceBytes = fixture.objects.read(currentSource.activeAsset.storageKey);
  assert.equal(fixture.objects.root, join(fixture.root, "objects"));
  assert.equal(sourceBytes.byteLength, currentSource.activeAsset.byteSize);
  assert.equal(sha256(sourceBytes), currentSource.activeAsset.sha256);
  assert.equal(acceptedModel.sourceS5Fingerprint, currentSource.sourceFingerprint);
  assert.equal(acceptedModel.sourceS5ApprovalGeneration, currentSource.approvalGeneration);
  assert.equal(acceptedModel.sourceS5ApprovalEventId, currentSource.approvalEventId);
  assert.equal(acceptedModel.designFormReview.status, "complete");
  assert.equal(acceptedModel.designFormReview.acceptedByUser, true);
  assert.deepEqual(acceptedModel.designFormReview.unresolvedUnknownIds, []);
  assert.equal(acceptedModel.unknowns.some((item) => item.blocking && item.status === "unresolved"), false);
  assert.equal(validationReceipt.revisionHash, acceptedModel.modelHash);
  assert.equal(validationReceipt.sourceS5Fingerprint, currentSource.sourceFingerprint);
  assert.equal(validationReceipt.validatorVersion, "s6-validator-v2");
  assert.equal(validationReceipt.validationHash, positiveValidation.validationHash);
  assert.equal(validationReceipt.outcome === "pass" || validationReceipt.outcome === "pass_with_warnings", true);
  const directHandoff = readS6ToS7Handoff(stateAfterAccept, fixture.objects, projectId);
  const delegatedHandoff = s6.getS7Handoff(projectId);
  assert.deepEqual(delegatedHandoff, directHandoff);
  assert.deepEqual(directHandoff.requirements, currentSource.canonicalRequirements, "the exact confirmed requirement set must reach S7");
  assert.deepEqual(directHandoff.booth, {
    widthMm: currentSource.geometrySnapshot.widthMm,
    depthMm: currentSource.geometrySnapshot.depthMm,
    openSides: ["north", "west"],
    maxHeightMm: currentSource.geometrySnapshot.maxHeightMm,
    heightState: "known",
  });
  for (const object of acceptedModel.objects) {
    const handoffObject = directHandoff.objects.find((item) => item.objectId === object.objectId);
    assert.ok(handoffObject, `S7 handoff omitted accepted S6 object ${object.objectId}`);
    assert.deepEqual(handoffObject.geometry, object.primitive);
    assert.deepEqual(handoffObject.transform, object.transform);
    assert.deepEqual(handoffObject.requirementIds, object.requirementIds);
  }
  assert.equal(directHandoff.acceptedRevisionId, acceptedModel.modelRevisionId);
  assert.equal(directHandoff.acceptedRevisionHash, acceptedModel.modelHash);
  assert.equal(directHandoff.sourceS5Fingerprint, currentSource.sourceFingerprint);
  assert.deepEqual(directHandoff.validationReceipt, {
    receiptId: validationReceipt.receiptId,
    validationHash: validationReceipt.validationHash,
    outcome: validationReceipt.outcome,
  });
  assert.deepEqual(directHandoff.eligibility, { currentAccepted: true, sourceCurrent: true, stale: false });
  const s7 = new S7CadService({ repository: fixture.repository, objects: fixture.objects, s6, ownerProcessId: "offline-s8-publication-source" });
  const admitted = (s7 as unknown as { source(projectId: UUID): { handoff: S6ToS7Handoff } }).source(projectId);
  assert.deepEqual(admitted.handoff, directHandoff);
  const result = s7.createExport(projectId, "offline-s8-publication-s7-source", randomUUID() as UUID);
  assert.equal(result.export.status, "committed");
  assert.equal(s7.getHandoff(projectId).s7ArtifactId, result.export.artifactId);
  return fixture.root;
}

export async function assertProductionRequirementNegative(
  route: ProductionS6Draft,
  requirementId: string,
  issueCode: string,
  operation: S6CorrectionOperation,
  expectedObjectId?: string,
): Promise<void> {
  const passingValidation = await validateProductionDraft(route, route.corrected);
  assert.equal(passingValidation.validatorVersion, "s6-validator-v2");
  assert.equal(passingValidation.outcome === "pass" || passingValidation.outcome === "pass_with_warnings", true,
    JSON.stringify(passingValidation.errors));
  const passingModel = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === route.corrected.revisionId);
  assert.ok(passingModel, "the passing production revision must remain in the authoritative repository");
  assert.equal(requirementEvaluation(passingModel, route.source, requirementId).outcome, "satisfied",
    "the same production source and requirement must pass before the typed negative correction");

  const negativeRevision = await correctProductionDraft(route, route.corrected, [operation]);
  const negativeModel = route.fixture.repository.state().s6SpatialModels.find((item) => item.modelRevisionId === negativeRevision.revisionId);
  assert.ok(negativeModel, "the negative production revision must remain in the authoritative repository");
  const evaluation = requirementEvaluation(negativeModel, route.source, requirementId);
  assert.equal(evaluation.outcome, "unsatisfied");
  assert.ok(evaluation.issueCodes.includes(issueCode), `derived evaluation omitted ${issueCode}`);
  assert.ok(evaluation.objectIds.length > 0, "the derived requirement result must identify concrete S6 objects");
  if (expectedObjectId) assert.ok(evaluation.objectIds.includes(expectedObjectId), `derived evaluation omitted offending object ${expectedObjectId}`);

  const validation = await validateProductionDraft(route, negativeRevision);
  assert.equal(validation.validatorVersion, "s6-validator-v2");
  assert.equal(validation.outcome, "acceptance_blocked");
  assert.ok(validation.errors.some((item) => item.requirementId === requirementId && item.code === issueCode),
    `v2 receipt omitted ${issueCode} for requirement ${requirementId}`);
  await assert.rejects(
    () => acceptProductionDraft(route, negativeRevision),
    (error: unknown) => code(error) === "S6_GEOMETRY_INVALID",
  );

  const state = route.fixture.repository.state();
  assert.equal(state.s6AcceptanceEvents.some((item) => item.projectId === route.projectId), false,
    "an invalid requirement receipt must not create S6 acceptance authority");
  assert.throws(() => route.s6.getS7Handoff(route.projectId),
    (error: unknown) => code(error) === "S6_ACCEPTANCE_CONFLICT");
  assert.throws(() => readS7ToS8Handoff(state, route.fixture.objects, route.projectId),
    (error: unknown) => code(error) === "S6_ACCEPTANCE_CONFLICT");
  const s7 = new S7CadService({ repository: route.fixture.repository, objects: route.fixture.objects, s6: route.s6, ownerProcessId: "offline-s8-requirement-negative" });
  assert.throws(() => s7.createExport(route.projectId, "offline-negative-export", randomUUID() as UUID),
    (error: unknown) => code(error) === "S7_SOURCE_NOT_READY");
  const afterDownstreamAttempts = route.fixture.repository.state();
  assert.equal(afterDownstreamAttempts.s7CadExports?.filter((item) => item.projectId === route.projectId).length ?? 0, 0,
    "invalid requirement evidence must stop before a committed S7 export exists");
  assert.equal(afterDownstreamAttempts.s8Artifacts?.filter((item) => item.projectId === route.projectId).length ?? 0, 0,
    "invalid requirement evidence must stop before S8 publication authority exists");
}

let acceptedSourceSnapshot: Promise<string> | null = null;
function bindProjectIdFromSnapshot(snapshotRoot: string): void {
  const state = JSON.parse(readFileSync(join(snapshotRoot, "state.json"), "utf8")) as {
    s6SpatialModels?: Array<{ projectId?: string; status?: string }>;
  };
  const accepted = state.s6SpatialModels?.find((item) => item.status === "accepted_current");
  assert.ok(accepted?.projectId, "the production source snapshot must retain its accepted S6 project");
  projectId = accepted.projectId as UUID;
}

export function sourceSnapshot(): Promise<string> {
  const inheritedRoot = process.env.S8_PROOF_SOURCE_ROOT;
  if (inheritedRoot) {
    bindProjectIdFromSnapshot(inheritedRoot);
    return Promise.resolve(inheritedRoot);
  }
  acceptedSourceSnapshot ??= buildAcceptedSourceSnapshot();
  return acceptedSourceSnapshot;
}

function makeReadback(s6: S6ToS7Handoff, _s7: S7ToS8Handoff): S8UfbxReadback {
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const objects = s6.objects.slice().sort((left, right) => Buffer.compare(Buffer.from(left.objectId), Buffer.from(right.objectId)));
  const names = new Map(objects.map((object, index) => [object.objectId, s8StableName(index, object.objectId)]));
  const transforms = buildS8TransformOracle(s6);
  const toUfbxMatrix = (matrix: number[]) => [
    matrix[0]!, matrix[4]!, matrix[8]!, matrix[1]!, matrix[5]!, matrix[9]!,
    matrix[2]!, matrix[6]!, matrix[10]!, matrix[3]!, matrix[7]!, matrix[11]!,
  ];
  const materialIds = [...new Set(objects.flatMap((object) => object.materialIds.slice().sort().slice(0, 1)))]
    .filter((id) => s6.materials.some((material) => material.materialId === id)).sort();
  const materials = materialIds.map((id) => {
    const source = s6.materials.find((item) => item.materialId === id)!;
    const color = source.colorHex && /^#[0-9a-fA-F]{6}$/u.test(source.colorHex)
      ? [Number.parseInt(source.colorHex.slice(1, 3), 16) / 255, Number.parseInt(source.colorHex.slice(3, 5), 16) / 255, Number.parseInt(source.colorHex.slice(5, 7), 16) / 255] as [number, number, number]
      : [0.62, 0.62, 0.62] as [number, number, number];
    return { name: `SWZ_MAT_${s8Sha256(id).slice(0, 16)}`, shadingModel: "phong", diffuse: color,
      diffuseFactor: 1, transparencyFactor: 0, specularFactor: 0, reflectionFactor: 0,
      emissionFactor: 0, ambientFactor: 0, textureCount: 0 };
  });
  return {
    schemaVersion: "s8-ufbx-readback-v1", fbxVersion: 7400, unitMeters: 0.001, warningCount: 0,
    source: { revisionId: s6.acceptedRevisionId, revisionHash: s6.acceptedRevisionHash,
      s6ValidationHash: s6.validationReceipt.validationHash, s6HandoffDigest: sha256(canonicalS8SourceJson(s6)) },
    materials,
    nodes: [
      { name: "SWZ_ROOT", parent: null, effectiveScale: [1, 1, 1], nodeToParent: identityMatrix, nodeToWorld: identityMatrix, mesh: null },
      ...objects.map((object) => {
        const transform = transforms.get(object.objectId)!;
        const mesh = buildS8Mesh(object.geometry);
        const materialId = object.materialIds.slice().sort()[0];
        const materialNames = materialId && s6.materials.some((item) => item.materialId === materialId)
          ? [`SWZ_MAT_${s8Sha256(materialId).slice(0, 16)}`] : [];
        return {
          name: names.get(object.objectId)!, parent: object.parentObjectId === null ? "SWZ_ROOT" : names.get(object.parentObjectId)!,
          sourceObjectId: object.objectId, identityKey: object.identityKey, effectiveScale: [1, 1, 1] as [number, number, number],
          nodeToParent: toUfbxMatrix(transform.localMatrix), nodeToWorld: toUfbxMatrix(transform.worldMatrix),
          mesh: { vertices: mesh.verticesMm.map((vertex) => [...vertex] as [number, number, number]),
            triangles: mesh.triangles.map((triangle) => [...triangle] as [number, number, number]),
            cornerNormals: mesh.cornerNormals.map((normal) => [...normal] as [number, number, number]), materialNames },
        };
      }),
    ],
  };
}

function writerArtifact(): Buffer {
  const artifact = Buffer.alloc(40, 7);
  Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary").copy(artifact);
  artifact.writeUInt32LE(7400, 23);
  return artifact;
}

function responseFrame(body: Record<string, unknown>, output: Buffer, auxiliary: Buffer): Buffer {
  const header = Buffer.from(jcs({ body, signature: signBody("S8-NATIVE-RESPONSE-V1", body, launcherPair.privateKey) }), "utf8");
  const headerLength = Buffer.alloc(4); headerLength.writeUInt32BE(header.byteLength);
  const outputLength = Buffer.alloc(8); outputLength.writeBigUInt64BE(BigInt(output.byteLength));
  const auxiliaryLength = Buffer.alloc(8); auxiliaryLength.writeBigUInt64BE(BigInt(auxiliary.byteLength));
  return Buffer.concat([headerLength, header, outputLength, output, auxiliaryLength, auxiliary]);
}

export function code(error: unknown): string | null {
  return error instanceof AppError ? error.code : error instanceof Error ? error.message : null;
}

export async function serviceFixture(options: FixtureOptions = {}) {
  const snapshot = await sourceSnapshot();
  const root = options.root ?? mkdtempSync(join(tmpdir(), "s8-publication-"));
  if (!options.reuseExistingRoot) {
    cpSync(join(snapshot, "state.json"), join(root, "state.json"));
    cpSync(join(snapshot, "objects"), join(root, "objects"), { recursive: true });
  }
  const repository = createRepository(root, options.beforeCommit);
  const objects = new PrivateObjectStore(join(root, "objects"));
  const sourceReader = createS6SourceReader(repository, objects,
    (sourceProjectId) => readS5ToS6Projection(repository.state(), objects, sourceProjectId));
  const s6 = new S6WorkflowService({ repository, objects, sourceReader, isProcessAlive: () => false });
  const s7 = new S7CadService({ repository, objects, s6, ownerProcessId: "offline-s8-publication-test" });
  const s6Handoff = s6.getS7Handoff(projectId);
  const s7Handoff = s7.getHandoff(projectId);
  const nativeReadback = options.nativeReadback ?? makeReadback(s6Handoff, s7Handoff);
  if (!options.nativeReadback) assert.equal(validateS8Readback(s6Handoff, s7Handoff, nativeReadback).outcome, "pass");
  const client = new S8NativeWorkerClient(nativeConfig, async () => Buffer.from(jcs(openAdmissionEnvelope()), "utf8"),
    async (_url, _agent, frame, _payload, _maximum, _timeout, _heartbeat, _clock) => {
      const request = frame.request;
      const operation = request.body.operation;
      await options.onNativeDispatch?.(operation, request);
      const output = operation === "WRITER" ? writerArtifact() : Buffer.from(jcs(nativeReadback), "utf8");
      const writerReceipt = {
        schemaVersion: S8_WRITER_RECEIPT_VERSION, profile: S8_FBX_PROFILE,
        payloadSha256: request.body.inputSha256, writerScriptSha256: releaseManifest.manifest.writer.writerScriptSha256,
        artifactSha256: s8Sha256(output), artifactByteSize: output.byteLength, fbxHeaderVersion: 7400,
        objectCount: 1, controlPointCount: 8, triangleCount: 12, runtime: {},
      };
      const auxiliary = operation === "WRITER" ? Buffer.from(jcs(writerReceipt), "utf8") : Buffer.alloc(0);
      const evidence = operation === "WRITER" ? options.writerEvidence : options.validatorEvidence;
      const omitEvidence = operation === "WRITER" ? options.omitWriterEvidence : options.omitValidatorEvidence;
      const runner = omitEvidence ? { runnerBinary: { selfSha256: releaseManifest.manifest.processRunnerSha256 } }
        : evidence ?? runnerEvidence(operation === "WRITER" ? "writer" : "validator", releaseManifest.manifest.processRunnerSha256);
      const releaseHandle = operation === "WRITER" ? randomBytes(32).toString("base64url") : request.body.releaseHandle;
      const body: Record<string, unknown> = {
        schemaVersion: "s8-native-response-v1", launcherKeyId: "launcher-test", requestSha256: frame.requestSha256,
        projectId: request.body.projectId, jobId: request.body.jobId, artifactId: request.body.artifactId,
        attempt: request.body.attempt, operation, sourceSha256: request.body.sourceSha256,
        releaseManifestSha256, imageDigest: operation === "WRITER" ? releaseManifest.manifest.writer.imageDigest : releaseManifest.manifest.validator.imageDigest,
        containerId: testDigest, inputSha256: request.body.inputSha256, inputBytes: request.body.inputBytes,
        outputSha256: s8Sha256(output), outputBytes: output.byteLength,
        auxiliarySha256: s8Sha256(auxiliary), auxiliaryBytes: auxiliary.byteLength, exitClass: "EXIT_0",
        limitProfileSha256: S8_NATIVE_RESOURCE_POLICY_SHA256, disposalState: "REAPED_REMOVED", releaseHandle,
        validatorIdentity: operation === "VALIDATOR" && !options.omitValidatorIdentity
          ? `s8-validator-sha256:${releaseManifest.manifest.validator.executableSha256}` : null,
        runnerEvidence: runner,
      };
      return { statusCode: 200, bytes: responseFrame(body, output, auxiliary) };
    });
  const service = new S8ExportService({ repository, objects, s6, s7, nativeWorkerConfig: nativeConfig, nativeWorkerClient: client,
    ownerId: "test-owner", processId: process.pid, isProcessAlive: () => false,
    onPublicationPhase: options.onPublicationPhase, clock: options.clock });
  return {
    root, repository, objects, s6, s7, client, service,
    close() { client.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

export async function rejects(options: FixtureOptions, key: string, expectedCode = "S8_PROCESS_RUNNER_EVIDENCE_INVALID"): Promise<void> {
  const fixture = await serviceFixture(options);
  try {
    await assert.rejects(fixture.service.createExport(projectId, key, "77777777-7777-4777-8777-777777777777"),
      (error: unknown) => code(error) === expectedCode);
  } finally { fixture.close(); }
}


export function cleanupSharedS8ProofFixture(): void {
  if (acceptedS5Fixture) cleanupS5Fixture(acceptedS5Fixture);
  acceptedS5Fixture = null;
  acceptedSourceRoot = null;
  acceptedSourceSnapshot = null;
}

type LinuxCrashPoint = "candidate-partial-write" | "after-state-rename" | "after-state-directory-fsync";

function repositoryCrashSource(root: string, barrierFile: string, point: LinuxCrashPoint, action: "transaction" | "migration"): string {
  const rootLiteral = JSON.stringify(root);
  const barrierLiteral = JSON.stringify(barrierFile);
  const pointLiteral = JSON.stringify(point);
  const actionSource = action === "migration"
    ? "new JsonRepository(root);"
    : `const repository = new JsonRepository(root);
       repository.transact((state) => { state.extractionAttempts.checkpoint = (state.extractionAttempts.checkpoint ?? 0) + 1; });`;
  return `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = ${rootLiteral};
    const statePath = join(root, "state.json");
    const barrierFile = ${barrierLiteral};
    const point = ${pointLiteral};
    const realWriteFileSync = fs.writeFileSync;
    const realRenameSync = fs.renameSync;
    const realFsyncSync = fs.fsyncSync;
    const stopAtBarrier = (name) => {
      fs.writeSync(1, name + "\\n");
      const limit = Date.now() + 20000;
      while (!fs.existsSync(barrierFile)) {
        if (Date.now() >= limit) process.exit(86);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      process.exit(87);
    };
    let stateRenamed = false;
    if (point === "candidate-partial-write") {
      fs.writeFileSync = (target, data, options) => {
        if (typeof target === "number") {
          let path = "";
          try { path = fs.readlinkSync("/proc/self/fd/" + target); } catch {}
          if (path.startsWith(statePath + ".") && path.endsWith(".tmp")) {
            const bytes = Buffer.from(data);
            realWriteFileSync(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
            stopAtBarrier("G135-BARRIER-CANDIDATE-PARTIAL");
          }
        }
        return realWriteFileSync(target, data, options);
      };
    } else if (point === "after-state-rename") {
      fs.renameSync = (source, destination) => {
        const result = realRenameSync(source, destination);
        if (destination === statePath) {
          stateRenamed = true;
          stopAtBarrier("G135-BARRIER-STATE-RENAMED");
        }
        return result;
      };
    } else {
      fs.renameSync = (source, destination) => {
        const result = realRenameSync(source, destination);
        if (destination === statePath) stateRenamed = true;
        return result;
      };
      fs.fsyncSync = (descriptor) => {
        const directory = fs.fstatSync(descriptor).isDirectory();
        const result = realFsyncSync(descriptor);
        if (stateRenamed && directory) stopAtBarrier("G135-BARRIER-STATE-DIRECTORY-FSYNCED");
        return result;
      };
    }
    syncBuiltinESMExports();
    const storeModule = await import("./src/lib/store.ts");
    const { JsonRepository } = storeModule.default ?? storeModule;
    ${actionSource}
    process.exit(0);
  `;
}

async function killRepositoryAtBarrier(root: string, point: LinuxCrashPoint, action: "transaction" | "migration"): Promise<void> {
  const barrierFile = join(root, `parent-release-${randomUUID()}`);
  const expectedMarker = point === "candidate-partial-write" ? "G135-BARRIER-CANDIDATE-PARTIAL"
    : point === "after-state-rename" ? "G135-BARRIER-STATE-RENAMED" : "G135-BARRIER-STATE-DIRECTORY-FSYNCED";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", repositoryCrashSource(root, barrierFile, point, action)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: cleanS8ChildEnvironment(),
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error(`barrier timeout for ${point}; child stderr: ${errors}`)), 30_000);
      const inspect = (chunk: string) => {
        if (!output.includes(expectedMarker)) return;
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolvePromise();
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, signal) => {
        if (output.includes(expectedMarker)) return;
        clearTimeout(timeout);
        rejectPromise(new Error(`child exited before ${point} barrier (code=${code}, signal=${signal}); stdout=${output}; stderr=${errors}`));
      });
    });
    assert.match(output, new RegExp(expectedMarker, "u"));
    assert.equal(child.kill("SIGKILL"), true, "the test must kill the child at the observed barrier");
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.equal(outcome.code, null);
    assert.equal(outcome.signal, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    writeFileSync(barrierFile, "release", "utf8");
  }
}

function cleanS8ChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("S8_") && name !== "S8_G135_REQUIRE_LINUX") delete environment[name];
  }
  return environment;
}

function fixtureSubprocessEnvironment(sourceRoot: string): NodeJS.ProcessEnv {
  const environment = cleanS8ChildEnvironment();
  environment.S8_PROOF_SOURCE_ROOT = sourceRoot;
  environment.S8_G135_TEST_APP_PRIVATE_PEM = appPrivatePem;
  environment.S8_G135_TEST_RELEASE_PRIVATE_PEM = releasePair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  environment.S8_G135_TEST_CAPACITY_PRIVATE_PEM = capacityPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  environment.S8_G135_TEST_LAUNCHER_PRIVATE_PEM = launcherPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  environment.S8_G135_TEST_RELEASE_MANIFEST_JSON = JSON.stringify(releaseManifest);
  return environment;
}

function legacyQueuedState(): Record<string, unknown> {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const jobId = "20000000-0000-4000-8000-000000000002";
  const artifactId = "20000000-0000-4000-8000-000000000003";
  const hash = "a".repeat(64);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const source = {
    projectId, sourceRevisionId: "10000000-0000-4000-8000-000000000001", sourceRevisionHash: hash,
    sourceS5Fingerprint: "b".repeat(64), s6ValidationReceiptId: "10000000-0000-4000-8000-000000000002",
    s6ValidationHash: "c".repeat(64), s6HandoffDigest: "d".repeat(64), s7ArtifactId: "10000000-0000-4000-8000-000000000003",
    s7ArtifactHash: "e".repeat(64), s7ReadbackHash: "f".repeat(64), s7ManifestId: "10000000-0000-4000-8000-000000000004",
    s7ManifestHash: "1".repeat(64), s8Profile: "swooshz-fbx-static-mesh-v1", s8ProtocolVersion: "s8-end-to-end-executable-contract-v1",
  };
  const state = { ...emptyStoreState() } as unknown as Record<string, any>;
  for (const field of ["s8NativeEvidenceVersion", "s8NativeProofSchemaVersion", "s8ValidationReceiptBytes",
    "s8NativeProofCheckpoints", "s8NativeTerminalOutcomes", "s8NativeAttemptQuarantines"]) delete state[field];
  state.s8ExportJobs = [{
    schemaVersion: "s8-export-job-v2", jobId, projectId, artifactId, source, inputHash: hash, idempotencyKey: "legacy-export-key",
    status: "queued", publicationPhase: "source_admission", attempt: 1, claimToken: null, ownerId: null, ownerProcessId: null,
    claimedAt: null, heartbeatAt: null, createdAt, updatedAt: createdAt, terminalAt: null, failureCode: null,
  }];
  state.s8Artifacts = [{
    schemaVersion: "s8-artifact-v2", artifactId, projectId, jobId, source, inputHash: hash,
    profile: "swooshz-fbx-static-mesh-v1", format: "fbx", mimeType: "application/octet-stream", downloadFileName: "swooshz-s8-scene.fbx",
    status: "queued", publicationPhase: "source_admission", payloadSha256: null, objectHashes: null,
    writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null,
    validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null,
    privateStagingPrefix: `private/projects/${projectId}/s8/staging/${artifactId}/unclaimed`,
    privateFinalPrefix: `private/projects/${projectId}/s8/committed/${source.sourceRevisionHash}/${"0".repeat(64)}`,
    attempt: 1, retryOfArtifactId: null, failureCode: null, createdAt, updatedAt: createdAt, committedAt: null, staleAt: null,
  }];
  state.s8ValidationReceipts = [];
  state.s8IdempotencyRecords = [{ schemaVersion: "s8-idempotency-v2", projectId, operation: "export",
    idempotencyKey: "legacy-export-key", inputHash: hash, source, jobId, artifactId, createdAt }];
  state.s8NativeOperationAttempts = [];
  return state;
}

function restartAndObserve(root: string): { state: Record<string, unknown>; directoryFsyncs: number; temporaryFiles: string[] } {
  const source = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    const realFsyncSync = fs.fsyncSync;
    let directoryFsyncs = 0;
    fs.fsyncSync = (descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncs++;
      return realFsyncSync(descriptor);
    };
    syncBuiltinESMExports();
    const storeModule = await import("./src/lib/store.ts");
    const { JsonRepository } = storeModule.default ?? storeModule;
    const repository = new JsonRepository(root);
    const state = repository.state();
    assert.ok(directoryFsyncs > 0, "restart must execute real directory fsync while stabilizing canonical state");
    const temporaryFiles = fs.readdirSync(root).filter((name) => name.startsWith("state.json.") && name.endsWith(".tmp"));
    process.stdout.write(JSON.stringify({ state, directoryFsyncs, temporaryFiles }) + "\\n");
  `;
  const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), env: cleanS8ChildEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  return JSON.parse(result.trim()) as { state: Record<string, unknown>; directoryFsyncs: number; temporaryFiles: string[] };
}

function commitAndObserve(root: string, key: string, value: number): { state: Record<string, unknown>; directoryFsyncs: number } {
  const source = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const root = ${JSON.stringify(root)};
    const realFsyncSync = fs.fsyncSync;
    let directoryFsyncs = 0;
    fs.fsyncSync = (descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) directoryFsyncs++;
      return realFsyncSync(descriptor);
    };
    syncBuiltinESMExports();
    const storeModule = await import("./src/lib/store.ts");
    const { JsonRepository } = storeModule.default ?? storeModule;
    const repository = new JsonRepository(root);
    repository.transact((state) => { state.extractionAttempts[${JSON.stringify(key)}] = ${value}; });
    const state = repository.state();
    assert.ok(directoryFsyncs > 0, "the control commit must execute real directory fsync");
    process.stdout.write(JSON.stringify({ state, directoryFsyncs }) + "\\n");
  `;
  const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), env: cleanS8ChildEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  return JSON.parse(result.trim()) as { state: Record<string, unknown>; directoryFsyncs: number };
}

type NativeCommitCrashPoint = "partial-committed-candidate" | "after-committed-rename" | "after-committed-directory-fsync";

function nativeCommitCrashSource(root: string, barrierFile: string, releaseFile: string, point: NativeCommitCrashPoint): string {
  const rootLiteral = JSON.stringify(root);
  const barrierLiteral = JSON.stringify(barrierFile);
  const releaseLiteral = JSON.stringify(releaseFile);
  const pointLiteral = JSON.stringify(point);
  return `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = ${rootLiteral};
    const statePath = join(root, "state.json");
    const barrierFile = ${barrierLiteral};
    const releaseFile = ${releaseLiteral};
    const point = ${pointLiteral};
    const realWriteFileSync = fs.writeFileSync;
    const realRenameSync = fs.renameSync;
    const realFsyncSync = fs.fsyncSync;
    const committedState = (bytes) => {
      try {
        const state = JSON.parse(Buffer.from(bytes).toString("utf8"));
        return state.s8ExportJobs?.some((job) => job.status === "committed") === true;
      } catch { return false; }
    };
    const canonicalIsCommitted = () => {
      try { return committedState(fs.readFileSync(statePath)); } catch { return false; }
    };
    const stopAtBarrier = (marker) => {
      fs.writeSync(1, marker + "\\n");
      const limit = Date.now() + 30000;
      while (!fs.existsSync(releaseFile)) {
        if (Date.now() >= limit) process.exit(86);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      process.exit(87);
    };
    if (point === "partial-committed-candidate") {
      fs.writeFileSync = (target, data, options) => {
        let candidate = false;
        if (typeof target === "number") {
          try {
            const name = fs.readlinkSync("/proc/self/fd/" + target);
            candidate = name.startsWith(statePath + ".") && name.endsWith(".tmp");
          } catch {}
        }
        const bytes = Buffer.from(data);
        if (candidate && committedState(bytes)) {
          realWriteFileSync(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
          stopAtBarrier("G135-BARRIER-NATIVE-COMMIT-CANDIDATE-PARTIAL");
        }
        return realWriteFileSync(target, data, options);
      };
    } else if (point === "after-committed-rename") {
      fs.renameSync = (source, destination) => {
        const result = realRenameSync(source, destination);
        if (destination === statePath && canonicalIsCommitted()) stopAtBarrier("G135-BARRIER-NATIVE-COMMIT-RENAMED");
        return result;
      };
    } else {
      fs.fsyncSync = (descriptor) => {
        const directory = fs.fstatSync(descriptor).isDirectory();
        const repositoryDirectory = directory && fs.readlinkSync("/proc/self/fd/" + descriptor) === root;
        const committed = repositoryDirectory && canonicalIsCommitted();
        const result = realFsyncSync(descriptor);
        if (committed) stopAtBarrier("G135-BARRIER-NATIVE-COMMIT-DIRECTORY-FSYNCED");
        return result;
      };
    }
    syncBuiltinESMExports();
    const helperModule = await import("./tests/s8-native-proof.test.ts");
    const helpers = helperModule.default ?? helperModule;
    let dispatches = 0;
    const fixture = await helpers.serviceFixture({ root, onNativeDispatch: () => { dispatches += 1; } });
    try {
      await fixture.service.createExport(helpers.projectId, "g135-native-crash", "77777777-7777-4777-8777-777777777777");
      process.stdout.write(JSON.stringify({ outcome: "finished-without-barrier", dispatches }) + "\\n");
    } finally {
      fixture.close();
    }
  `;
}

async function killNativeCommitAtBarrier(root: string, sourceRoot: string, point: NativeCommitCrashPoint): Promise<void> {
  const barrierFile = join(root, `native-commit-release-${randomUUID()}`);
  const releaseFile = join(root, `native-commit-continue-${randomUUID()}`);
  const marker = point === "partial-committed-candidate" ? "G135-BARRIER-NATIVE-COMMIT-CANDIDATE-PARTIAL"
    : point === "after-committed-rename" ? "G135-BARRIER-NATIVE-COMMIT-RENAMED"
      : "G135-BARRIER-NATIVE-COMMIT-DIRECTORY-FSYNCED";
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    nativeCommitCrashSource(root, barrierFile, releaseFile, point)], {
    cwd: process.cwd(), env: fixtureSubprocessEnvironment(sourceRoot), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error(`native commit barrier timeout for ${point}; stderr=${errors}`)), 60_000);
      const inspect = () => {
        if (!output.includes(marker)) return;
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolvePromise();
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
      child.once("close", (code, signal) => {
        if (output.includes(marker)) return;
        clearTimeout(timeout);
        rejectPromise(new Error(`native export exited before ${point} barrier (code=${code}, signal=${signal}); stdout=${output}; stderr=${errors}`));
      });
    });
    assert.ok(output.includes(marker), `the actual native lifecycle must reach ${point}`);
    assert.equal(child.kill("SIGKILL"), true, "the process must be killed at the native commit barrier");
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.deepEqual(outcome, { code: null, signal: "SIGKILL" }, `native crash child failed: ${errors}\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    writeFileSync(releaseFile, "release", "utf8");
  }
}

function nativeRestartSource(root: string): string {
  return `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const root = ${JSON.stringify(root)};
    const realFsyncSync = fs.fsyncSync;
    let directoryFsyncs = 0;
    fs.fsyncSync = (descriptor) => {
      const directory = fs.fstatSync(descriptor).isDirectory();
      const result = realFsyncSync(descriptor);
      if (directory) directoryFsyncs++;
      return result;
    };
    syncBuiltinESMExports();
    const helperModule = await import("./tests/s8-native-proof.test.ts");
    const helpers = helperModule.default ?? helperModule;
    let dispatches = 0;
    const fixture = await helpers.serviceFixture({
      root, reuseExistingRoot: true,
      clock: () => new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      onNativeDispatch: () => { dispatches += 1; },
    });
    try {
      const recovered = fixture.service.recoverPending();
      const state = fixture.repository.state();
      const artifact = state.s8Artifacts?.find((item) => item.projectId === helpers.projectId);
      assert.ok(artifact);
      const published = fixture.service.getExport(helpers.projectId, artifact.artifactId);
      const downloaded = fixture.service.download(helpers.projectId, artifact.artifactId);
      assert.ok(directoryFsyncs > 0, "restart must execute real directory fsync before asserting publication readiness");
      process.stdout.write(JSON.stringify({
        recovered, status: published.status, bytes: downloaded.bytes.length, dispatches, directoryFsyncs,
        jobStatus: state.s8ExportJobs?.find((item) => item.artifactId === artifact.artifactId)?.status,
      }) + "\\n");
    } finally {
      fixture.close();
    }
  `;
}

function observeNativeRestart(root: string, sourceRoot: string): Record<string, unknown> {
  const source = nativeRestartSource(root);
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), env: fixtureSubprocessEnvironment(sourceRoot), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  return JSON.parse(output.trim()) as Record<string, unknown>;
}


const directNativeProofExecution = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (directNativeProofExecution) {
const requireLinuxDurability = process.env.S8_G135_REQUIRE_LINUX === "1";
if (requireLinuxDurability) assert.equal(process.platform, "linux", "G135 requires a real Linux durability carrier");

// These cases intentionally register only on the real carrier. The mandatory
// environment flag rejects an unsupported host before any result can pass.
if (process.platform === "linux") {
  test("G135-LINUX-N39-R130-L rejects asynchronous and nested transactions and freezes retained aliases", () => {
    const source = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const realFsync = fs.fsyncSync;
      let directorySyncs = 0;
      fs.fsyncSync = (fd) => {
        if (fs.fstatSync(fd).isDirectory()) directorySyncs++;
        return realFsync(fd);
      };
      syncBuiltinESMExports();
      const store = await import("./src/lib/store.ts");
      const { JsonRepository } = store.default ?? store;
      const root = fs.mkdtempSync(join(tmpdir(), "s8-g135-transaction-"));
      try {
        const repository = new JsonRepository(root, { lockWaitMs: 25 });
        repository.transact((state) => { state.extractionAttempts.baseline = 1; });
        const original = fs.readFileSync(repository.statePath);
        let asyncAlias;
        assert.throws(() => repository.transact(async (state) => {
          asyncAlias = state;
          state.extractionAttempts.pending = 1;
        }), (error) => error?.code === "PERSISTENCE_FAILED");
        assert.deepEqual(fs.readFileSync(repository.statePath), original);
        assert.ok(Object.isFrozen(asyncAlias.extractionAttempts));
        assert.throws(() => { asyncAlias.extractionAttempts.pending = 2; }, TypeError);
        assert.throws(() => repository.transact(() => repository.transact(() => null)),
          (error) => error?.code === "PERSISTENCE_FAILED");
        assert.deepEqual(fs.readFileSync(repository.statePath), original);
        const contender = new JsonRepository(root, { lockWaitMs: 25 });
        let retained;
        const result = repository.transact((state) => {
          retained = state;
          state.extractionAttempts.committed = 1;
          assert.equal(repository.state().extractionAttempts.committed, undefined);
          assert.throws(() => contender.transact(() => null),
            (error) => error?.code === "PERSISTENCE_BUSY");
          return state.extractionAttempts;
        });
        assert.ok(Object.isFrozen(retained.extractionAttempts));
        assert.throws(() => { retained.extractionAttempts.committed = 2; }, TypeError);
        result.committed = 3;
        const snapshot = repository.snapshot();
        assert.throws(() => { snapshot.extractionAttempts.committed = 4; }, TypeError);
        assert.equal(new JsonRepository(root).state().extractionAttempts.committed, 1);
        assert.ok(directorySyncs > 0, "real directory fsync evidence is required");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), stdio: "pipe", timeout: 30_000 });
  });

  test("G135-LINUX-N26 failed acceptance persistence cannot publish, retry, or redispatch", async () => {
    let dispatches = 0;
    let failNextCommit = false;
    const interrupted = await serviceFixture({
      beforeCommit: () => {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("controlled B acceptance persistence failure");
        }
      },
      onNativeDispatch: (operation) => {
        if (operation === "WRITER") {
          dispatches += 1;
          failNextCommit = true;
        }
      },
    });
    try {
      await assert.rejects(interrupted.service.createExport(projectId, "n26-interrupted", "77777777-7777-4777-8777-777777777777"));
      const state = interrupted.repository.state();
      const attempt = state.s8NativeOperationAttempts!.find((item) => item.operation === "WRITER");
      const job = state.s8ExportJobs!.find((item) => item.projectId === projectId);
      assert.equal(dispatches, 1, "an uncommitted acceptance cannot trigger a replacement native dispatch");
      assert.equal(attempt?.state, "UNKNOWN", "the prepared Writer must end in reconciliation, not forged success");
      assert.equal(job?.attempt, 1, "persistence failure cannot schedule a retry");
      assert.notEqual(job?.status, "committed");
      assert.throws(() => interrupted.service.download(projectId, job!.artifactId));
    } finally {
      interrupted.close();
    }

    let controlDispatches = 0;
    const control = await serviceFixture({ onNativeDispatch: () => { controlDispatches += 1; } });
    try {
      const result = await control.service.createExport(projectId, "n26-control", "88888888-8888-4888-8888-888888888888");
      assert.equal(result.export.status, "committed", "a timely acceptance with successful B persistence remains publishable");
      assert.equal(controlDispatches, 2);
      assert.equal(control.service.download(projectId, result.export.artifactId).bytes.length, 40);
    } finally {
      control.close();
    }
  });

  test("G135-LINUX-R130-A-N27 timely acceptance survives a barrier-delayed real B directory fsync", async () => {
    const sourceRoot = await sourceSnapshot();
    const root = mkdtempSync(join(tmpdir(), "s8-g135-n27-"));
    const barrierFile = join(root, "writer-acceptance-directory-fsync.barrier");
    const releaseFile = join(root, "writer-acceptance-directory-fsync.release");
    const childSource = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      const root = ${JSON.stringify(root)};
      const barrierFile = ${JSON.stringify(barrierFile)};
      const releaseFile = ${JSON.stringify(releaseFile)};
      const realDateNow = Date.now;
      let fakeWall = realDateNow();
      Date.now = () => fakeWall;
      const helperModule = await import("./tests/s8-native-proof.test.ts");
      const helpers = helperModule.default ?? helperModule;
      const realFsyncSync = fs.fsyncSync;
      let directoryFsyncs = 0;
      let delayedWriterAcceptance = false;
      let writerDeadline = null;
      fs.fsyncSync = (descriptor) => {
        const directory = fs.fstatSync(descriptor).isDirectory();
        if (directory) {
          const state = JSON.parse(fs.readFileSync(join(root, "state.json"), "utf8"));
          const writer = state.s8NativeOperationAttempts?.find((item) => item.operation === "WRITER" && item.state === "SUCCEEDED");
          const body = writer?.acceptanceReceipt?.body;
          if (!delayedWriterAcceptance && body) {
            assert.ok(body.logicalAcceptedAtUnixMs < body.deadlineUnixMs,
              "A must be accepted before its original deadline");
            writerDeadline = body.deadlineUnixMs;
            delayedWriterAcceptance = true;
            fs.writeSync(1, "G135-N27-B-DIRECTORY-FSYNC-WAITING " + JSON.stringify({
              logicalAcceptedAtUnixMs: body.logicalAcceptedAtUnixMs,
              deadlineUnixMs: body.deadlineUnixMs,
            }) + "\\n");
            const limit = realDateNow() + 30000;
            while (!fs.existsSync(releaseFile)) {
              if (realDateNow() >= limit) process.exit(86);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
            fakeWall = writerDeadline + 1;
          }
        }
        const result = realFsyncSync(descriptor);
        if (directory) directoryFsyncs += 1;
        return result;
      };
      syncBuiltinESMExports();
      let nativeDispatches = 0;
      const fixture = await helpers.serviceFixture({
        root,
        onNativeDispatch: (operation, request) => {
          nativeDispatches += 1;
          if (operation === "WRITER") fakeWall = request.body.deadlineUnixMs - 30000;
        },
      });
      try {
        const result = await fixture.service.createExport(helpers.projectId, "n27-delayed-fsync", "77777777-7777-4777-8777-777777777777");
        const bytes = fixture.service.download(helpers.projectId, result.export.artifactId).bytes;
        assert.ok(delayedWriterAcceptance);
        assert.ok(writerDeadline !== null && fakeWall > writerDeadline,
          "the real directory fsync must execute after the controlled deadline crossing");
        assert.ok(directoryFsyncs > 0, "the delayed directory fsync must execute the real syscall");
        process.stdout.write(JSON.stringify({
          status: result.export.status, nativeDispatches, bytes: bytes.length, directoryFsyncs,
          fakeWall, writerDeadline,
        }) + "\\n");
      } finally {
        fixture.close();
        Date.now = realDateNow;
      }
    `;
    const environment = fixtureSubprocessEnvironment(sourceRoot);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
      cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error(`N27 directory-fsync barrier timeout: ${errors}`)), 60_000);
        const inspect = () => {
          if (!output.includes("G135-N27-B-DIRECTORY-FSYNC-WAITING ")) return;
          clearTimeout(timeout);
          child.stdout.off("data", inspect);
          resolvePromise();
        };
        child.stdout.on("data", inspect);
        child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
        child.once("close", (code, signal) => {
          if (output.includes("G135-N27-B-DIRECTORY-FSYNC-WAITING ")) return;
          clearTimeout(timeout);
          rejectPromise(new Error(`N27 child exited before the real directory-fsync barrier (code=${code}, signal=${signal}); stdout=${output}; stderr=${errors}`));
        });
      });
      const barrierLine = output.split(/\r?\n/u).find((line) => line.startsWith("G135-N27-B-DIRECTORY-FSYNC-WAITING "));
      assert.ok(barrierLine);
      const accepted = JSON.parse(barrierLine.slice("G135-N27-B-DIRECTORY-FSYNC-WAITING ".length)) as {
        logicalAcceptedAtUnixMs: number; deadlineUnixMs: number;
      };
      assert.ok(accepted.logicalAcceptedAtUnixMs < accepted.deadlineUnixMs);
      const persistedBeforeDirectorySync = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as Record<string, any>;
      const writer = persistedBeforeDirectorySync.s8NativeOperationAttempts.find((item: Record<string, any>) => item.operation === "WRITER");
      assert.equal(writer.state, "SUCCEEDED");
      assert.equal(writer.acceptanceReceipt.body.logicalAcceptedAtUnixMs, accepted.logicalAcceptedAtUnixMs);
      assert.equal(writer.acceptanceReceipt.body.deadlineUnixMs, accepted.deadlineUnixMs);
      writeFileSync(releaseFile, "release", "utf8");
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
      assert.deepEqual(outcome, { code: 0, signal: null }, `N27 child failed: ${errors}\n${output}`);
      const resultLine = output.split(/\r?\n/u).find((line) => line.startsWith("{"));
      assert.ok(resultLine, `N27 child emitted no result JSON: ${errors}\n${output}`);
      const result = JSON.parse(resultLine) as Record<string, unknown>;
      assert.equal(result.status, "committed");
      assert.equal(result.nativeDispatches, 2);
      assert.equal(result.bytes, 40);
      assert.ok((result.fakeWall as number) > (result.writerDeadline as number));
      assert.ok((result.directoryFsyncs as number) > 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("G135-LINUX-N28 kills a partial candidate write without changing canonical state", async () => {
    const root = mkdtempSync(join(tmpdir(), "s8-g135-n28-"));
    try {
      const repository = new JsonRepository(root);
      repository.transact((state) => { state.extractionAttempts.checkpoint = 11; });
      const canonicalBefore = readFileSync(join(root, "state.json"));
      await killRepositoryAtBarrier(root, "candidate-partial-write", "transaction");
      assert.deepEqual(readFileSync(join(root, "state.json")), canonicalBefore,
        "a child killed during candidate writing cannot replace the canonical state");
      const interruptedCandidates = readdirSync(root).filter((name) => name.startsWith("state.json.") && name.endsWith(".tmp"));
      assert.ok(interruptedCandidates.length > 0, "the kill point must leave an actual interrupted candidate");
      const restarted = restartAndObserve(root);
      assert.equal((restarted.state.extractionAttempts as Record<string, number>).checkpoint, 11,
        "restart must use and fsync the prior canonical document, ignoring the partial candidate");
      assert.ok(restarted.directoryFsyncs > 0);
      const committed = commitAndObserve(root, "checkpoint", 12);
      assert.equal((committed.state.extractionAttempts as Record<string, number>).checkpoint, 12,
        "the same repository path must accept a later complete commit");
      assert.ok(committed.directoryFsyncs > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("G135-LINUX-N29 stabilizes a rename-surviving canonical document before readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "s8-g135-n29-"));
    try {
      const repository = new JsonRepository(root);
      repository.transact((state) => { state.extractionAttempts.checkpoint = 21; });
      await killRepositoryAtBarrier(root, "after-state-rename", "transaction");
      assert.equal(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).extractionAttempts.checkpoint, 22,
        "the observed rename barrier must leave the complete replacement at the canonical name");
      const restarted = restartAndObserve(root);
      assert.equal((restarted.state.extractionAttempts as Record<string, number>).checkpoint, 22);
      assert.ok(restarted.directoryFsyncs > 0,
        "restart may return the surviving replacement only after validation and a real directory fsync");
      const committed = commitAndObserve(root, "checkpoint", 23);
      assert.equal((committed.state.extractionAttempts as Record<string, number>).checkpoint, 23);
      assert.ok(committed.directoryFsyncs > 0, "the successful control also executes the real directory fsync syscall");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("G135-LINUX-N30 retains a complete canonical document killed after directory fsync", async () => {
    const root = mkdtempSync(join(tmpdir(), "s8-g135-n30-"));
    try {
      const repository = new JsonRepository(root);
      repository.transact((state) => { state.extractionAttempts.checkpoint = 31; });
      await killRepositoryAtBarrier(root, "after-state-directory-fsync", "transaction");
      const restarted = restartAndObserve(root);
      assert.equal((restarted.state.extractionAttempts as Record<string, number>).checkpoint, 32);
      assert.ok(restarted.directoryFsyncs > 0, "restart validates and stabilizes the durable canonical document");
      const committed = commitAndObserve(root, "checkpoint", 33);
      assert.equal((committed.state.extractionAttempts as Record<string, number>).checkpoint, 33);
      assert.ok(committed.directoryFsyncs > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("G135-LINUX-N44-P10 migration failures expose readiness only after canonical stabilization", async () => {
    for (const [point, expectedTemporary] of [
      ["candidate-partial-write", true],
      ["after-state-rename", false],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "s8-g135-n44-"));
      try {
        const legacyBytes = Buffer.from(JSON.stringify(legacyQueuedState()), "utf8");
        writeFileSync(join(root, "state.json"), legacyBytes);
        await killRepositoryAtBarrier(root, point, "migration");
        if (point === "candidate-partial-write") {
          assert.deepEqual(readFileSync(join(root, "state.json")), legacyBytes,
            "a migration interrupted before rename leaves the legacy canonical document intact");
        } else {
          const renamed = JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as Record<string, unknown>;
          assert.equal(renamed.s8NativeEvidenceVersion, 3,
            "the post-rename barrier must observe the fully serialized migrated canonical document");
        }
        const restarted = restartAndObserve(root);
        const state = restarted.state;
        assert.equal(state.s8NativeEvidenceVersion, 3);
        assert.equal((state.s8ExportJobs as Array<Record<string, unknown>>)[0]?.status, "queued");
        assert.ok(restarted.directoryFsyncs > 0,
          "startup must validate the queued legacy/migrated state and execute a real directory fsync before returning");
        assert.equal(restarted.temporaryFiles.length > 0, expectedTemporary,
          "only a killed pre-rename migration leaves a candidate that startup must ignore");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const positiveRoot = mkdtempSync(join(tmpdir(), "s8-g135-p10-"));
    try {
      writeFileSync(join(positiveRoot, "state.json"), JSON.stringify(legacyQueuedState()), "utf8");
      const migrated = restartAndObserve(positiveRoot);
      assert.equal(migrated.state.s8NativeEvidenceVersion, 3);
      assert.equal((migrated.state.s8ExportJobs as Array<Record<string, unknown>>)[0]?.status, "queued");
      assert.ok(migrated.directoryFsyncs > 0, "P10's durable migration control performs real directory fsync");
    } finally {
      rmSync(positiveRoot, { recursive: true, force: true });
    }
  });
}

test("strict JSON rejects duplicate keys at every nesting level", () => {
  assert.throws(() => parseStrictJson(Buffer.from('{"schemaVersion":1,"schemaVersion":2}')));
  assert.throws(() => parseStrictJson(Buffer.from('{"keys":[{"keyId":"a","keyId":"b"}]}')));
  assert.deepEqual(parseStrictJson(Buffer.from('{"keys":[{"keyId":"a"}]}')), { keys: [{ keyId: "a" }] });
});

test("strict JSON rejects invalid UTF-8 and trailing bytes", () => {
  assert.throws(() => parseStrictJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => parseStrictJson(Buffer.from('{"ok":true} trailing')));
});

test("application trust is closed when configuration is absent", () => {
  const trust = readS8ApplicationTrust({});
  assert.equal(trust.currentKeyId, null);
  assert.equal(trust.signingKey, null);
  assert.equal(trust.verificationKeys.size, 0);
});

test("application trust binds the current private key to one unique Ed25519 history entry", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const trust = readS8ApplicationTrust({
    S8_APP_SIGNING_KEY_ID: "test-current",
    S8_APP_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
    S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON: JSON.stringify({
      schemaVersion: "s8-app-acceptance-keyset-v1",
      keys: [{ keyId: "test-current", publicKeyPem }],
    }),
  });
  assert.equal(trust.currentKeyId, "test-current");
  assert.equal(trust.signingKey?.asymmetricKeyType, "ed25519");
  assert.equal(trust.verificationKeys.get("test-current")?.asymmetricKeyType, "ed25519");
  assert.equal(trust.keyDerIdentities.size, 1);
  assert.throws(() => (trust.verificationKeys as Map<string, unknown>).set("injected", {}));
});

test("application trust rejects duplicate key material, mismatched pairs, and malformed keysets", () => {
  const pair = generateKeyPairSync("ed25519");
  const otherPair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const otherPublicPem = otherPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const env = (keys: unknown, privateKey = privateKeyPem) => ({
    S8_APP_SIGNING_KEY_ID: "test-current",
    S8_APP_SIGNING_PRIVATE_KEY_PEM: privateKey,
    S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON: JSON.stringify({ schemaVersion: "s8-app-acceptance-keyset-v1", keys }),
  });
  assert.throws(() => readS8ApplicationTrust(env([
    { keyId: "test-current", publicKeyPem },
    { keyId: "old-key", publicKeyPem },
  ])));
  assert.throws(() => readS8ApplicationTrust(env([{ keyId: "test-current", publicKeyPem: otherPublicPem }])));
  assert.throws(() => readS8ApplicationTrust(env([{ keyId: "test-current", publicKeyPem }], "")));
  assert.throws(() => readS8ApplicationTrust({
    S8_APP_SIGNING_KEY_ID: "test-current",
    S8_APP_SIGNING_PRIVATE_KEY_PEM: privateKeyPem,
    S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON: '{"schemaVersion":"s8-app-acceptance-keyset-v1","keys":[],"keys":[]}',
  }));
});

test("only a repository-registered binding can construct proof authority", () => {
  assert.throws(() => createS8NativeProofAuthority({} as S8RepositoryProofBinding));
});

test("operation clocks retain the response and decision witness in an isolated process", () => {
  const source = `
    import assert from "node:assert/strict";
    const protocol = await import("./src/lib/s8-native-protocol.ts");
    const { beginS8NativeOperation, finalizeS8NativeAcceptance, nativeOperationStartEvidence, observeS8NativeResponse } = protocol.default ?? protocol;
    let wall = 1900000000000;
    let mono = 7000000000n;
    Date.now = () => wall;
    Object.defineProperty(process.hrtime, "bigint", { configurable: true, value: () => mono });
    const first = beginS8NativeOperation("WRITER");
    const second = beginS8NativeOperation("VALIDATOR");
    const start = nativeOperationStartEvidence(first);
    assert.equal(start.deadlineUnixMs, wall + 510000);
    assert.equal(start.processClockEpoch, nativeOperationStartEvidence(second).processClockEpoch);
    wall += 100;
    mono += 100000000n;
    observeS8NativeResponse(first);
    wall -= 50;
    mono += 50000000n;
    const issued = finalizeS8NativeAcceptance(first, (at, witness) => Object.freeze({ at, witness }));
    assert.equal(issued.acceptedAtUnixMs, 1900000000150);
    assert.equal(issued.event.witness.responseWallUnixMs, 1900000000100);
    assert.equal(issued.event.witness.responseMonotonicElapsedNs, "100000000");
    assert.equal(issued.event.witness.decisionWallUnixMs, 1900000000050);
    assert.equal(issued.event.witness.decisionMonotonicElapsedNs, "150000000");
    assert.throws(() => finalizeS8NativeAcceptance(first, () => null), (error) => error?.code === "S8_PROOF_INVALID");
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: "pipe" });
});

test("operation clock equality with the original deadline latches timeout", () => {
  const source = `
    import assert from "node:assert/strict";
    const protocol = await import("./src/lib/s8-native-protocol.ts");
    const { beginS8NativeOperation, finalizeS8NativeAcceptance, observeS8NativeResponse } = protocol.default ?? protocol;
    let wall = 1900000000000;
    let mono = 7000000000n;
    Date.now = () => wall;
    Object.defineProperty(process.hrtime, "bigint", { configurable: true, value: () => mono });
    const clock = beginS8NativeOperation("WRITER");
    wall += 509999;
    mono += 509999000000n;
    observeS8NativeResponse(clock);
    wall += 1;
    mono += 1000000n;
    assert.throws(() => finalizeS8NativeAcceptance(clock, () => null), (error) => error?.code === "S8_NATIVE_OPERATION_TIMEOUT");
    assert.throws(() => finalizeS8NativeAcceptance(clock, () => null), (error) => error?.code === "S8_PROOF_INVALID");
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: "pipe" });
});

// Exact G135 scope with accepted Run-137, Run-138 and Run-140 amendments.
const gitContract = {
  "base": "ff6a9bada283d36b92637a810a7e9d691b92193e",
  "reimplement": [
    "src/lib/types.ts",
    "src/lib/s8-fbx-persistence.ts",
    "src/lib/store.ts",
    "src/lib/workflow.ts",
    "src/lib/s8.ts",
    "src/lib/s8-fbx-config.ts",
    "src/lib/s8-native-protocol.ts",
    "src/lib/s8-native-worker-client.ts",
    "src/lib/s5.ts",
    "src/lib/s6.ts",
    "src/lib/s7-cad.ts",
    "src/lib/api.ts",
    "tests/g3.test.ts",
    "tests/s2-evidence.test.ts",
    "tests/s8-api.test.ts",
    "tests/s8-persistence.test.ts",
    "tests/s8-publication.test.ts",
    "tests/s8-worker.test.ts",
    "tests/s8-native-admission.test.ts",
    "docs/ARCHITECTURE.md",
    "docs/G2_S8_NATIVE_WORKER_CONTRACT.md",
    "package.json",
    ".github/workflows/s8-fbx.yml",
    "src/lib/s8-fbx-payload.ts",
    "tests/s8-payload.test.ts",
    "tests/s8-native-release.test.ts",
    "src/lib/s6-compiler.ts",
    "src/lib/s6-validation.ts",
    "src/lib/s6-canonical.ts",
    "src/lib/s6-persistence.ts",
    "src/lib/s6-handoff.ts",
    "tests/s6-compiler.test.ts",
    "tests/s6-validation.test.ts",
    "tests/s6-lifecycle.test.ts",
    "tests/s6-persistence.test.ts",
    "tests/s6-handoff.test.ts"
  ],
  "transplant": {
    "native/s8-sandbox-broker/README.md": "92a7e00b9a03fa34767912859273e357f7c63105",
    "native/s8-worker-common/admission.mjs": "06ff6d506d4ef3d0914feee7fe9783c62232105a",
    "native/s8-worker-common/admission.test.mjs": "8cbe8de19a0b6a856229f9019d75a8da31d35a5a",
    "native/s8-worker-common/protocol.mjs": "8fec1694a7484029e881f85c3a6a2d8629c026b3",
    "native/s8-worker-common/protocol.test.mjs": "c5c3a270d4e1a04939b961463f7e5e6aa4b52f6c",
    "native/s8-worker-common/resource-policy.d.mts": "cec90babd491eaf9375a64e38a4398a641c21695",
    "native/s8-worker-common/resource-policy.mjs": "a5288f36d767e0430fec3e56f55ccad041025ece",
    "native/s8-worker-common/worker-entrypoint.mjs": "1c816ddc308aeedef1780cccfc03ae3579c249c2",
    "native/s8-worker-gateway/Dockerfile": "0d0a85c05c28ff4c7f5642ecb5b7f3917b2df0d8",
    "native/s8-worker-gateway/README.md": "c5d62ba1c55972497914db0db4623c05909a0442",
    "native/s8-worker-gateway/compose.yaml": "ef66d10c5662df2ba767d530077ed69059c48284",
    "native/s8-worker-gateway/gateway.mjs": "32d7c0502c6a55a2c693c2921070ba40a10e90d1",
    "native/s8-worker-gateway/gateway.test.mjs": "9439d1cfc31880e1666563dc1de002e033cd2e73",
    "native/s8-worker-images/build-image.sh": "9af9c2f707adff4f565b865bdfbcfd8f15f7b15e",
    "native/s8-worker-images/validator/Dockerfile": "b23685230e85fed27049d287cf683ccd8ca64cba",
    "native/s8-worker-images/writer/Dockerfile": "d80cfa213cacd56d7f26a223558241de4fde33bd",
    "native/s8-worker-launcher/README.md": "ef321172068625fa8f30123fb71891e7d2a38303",
    "native/s8-worker-launcher/capacity.mjs": "e5b8da19b3eb8f3208cecbb183c315d4abf1bee2",
    "native/s8-worker-launcher/capacity.test.mjs": "8edadb96847fe0a90a9406ab053678ae497d4254",
    "native/s8-worker-launcher/config.mjs": "72c461ae66f4e02544457360e2402ce09a1ed378",
    "native/s8-worker-launcher/container-runtime.mjs": "966cea5287ad2a7cb3f365b2ad530c827b2a3770",
    "native/s8-worker-launcher/container-runtime.test.mjs": "29425dc1a961c1e5df4d3ea2b3ef41966d0b5c4d",
    "native/s8-worker-launcher/deploy/swooshz-design-application.slice": "ef0b473a672157191c36ae59dcf3172e4b7804c9",
    "native/s8-worker-launcher/deploy/swooshz-design-gateway.slice": "3b906cb770aa246be33d04c93ff59afe52514cb6",
    "native/s8-worker-launcher/deploy/swooshz-design-launcher.slice": "354feaecf083dec4592a2cf47c0d501dc65b57db",
    "native/s8-worker-launcher/deploy/swooshz-design-rootless-docker.slice": "c1fa0639e282959e3d9a38c70009a1e802ee73d5",
    "native/s8-worker-launcher/deploy/swooshz-design-systemd.slice": "daedbb71bd73c544aba743803862cfb1d4823024",
    "native/s8-worker-launcher/deploy/swooshz-design.slice": "442ac0c6659d1b359e79d9efbf7e24f78e5a617f",
    "native/s8-worker-launcher/deploy/swooshz-host-reserve.slice": "1793b5596fc48e7cc1c603bbaeaf549beee46f08",
    "native/s8-worker-launcher/deploy/swooshz-non-design-future-non-design.slice": "25b2958ebe263b3269b10e9ac9d1882a6d05b02e",
    "native/s8-worker-launcher/deploy/swooshz-non-design-n8n.slice": "bbf6372c4135fc558f04ae43948c5b1aee786de0",
    "native/s8-worker-launcher/deploy/swooshz-non-design-other-siblings.slice": "998ccc0e5415c62cc6eeb5b1c5279a66f6d8c3b7",
    "native/s8-worker-launcher/deploy/swooshz-non-design-quote.slice": "e5d834e197d6f32da758ed34998e28a3e75d72a1",
    "native/s8-worker-launcher/deploy/swooshz-non-design-wordpress.slice": "b3e5cff3d8a3971d18d88ef6638b5783e94c906f",
    "native/s8-worker-launcher/deploy/swooshz-non-design.slice": "f1189f66ea1f6218fb36e033c167c3d6d663ebfb",
    "native/s8-worker-launcher/deploy/swooshz-s8-worker-launcher.service": "83d09bcaff9ca0a2de32c99ad8c39340e29d93aa",
    "native/s8-worker-launcher/deploy/swooshz.slice": "3adf8f29297a84180a1271d8d38fb2ec6b153eb6",
    "native/s8-worker-launcher/deploy/user-manager/swooshz-s8-runtime.tmpfiles.conf": "2bc3d36129bb81e3eed844a9429d64253859439c",
    "native/s8-worker-launcher/deploy/user-manager/user-at-UID.service.d/60-swooshz-s8.conf.template": "9bb33ff16db090e710e58ab979e76a7b9ab2a389",
    "native/s8-worker-launcher/deploy/user/swooshz-s8-rootless-docker.service": "c8122de7da75796d341f8a3cfd1ae153f558dbde",
    "native/s8-worker-launcher/deploy/user/swooshz-s8-workers.slice": "223011a1648d80ce2cfc02932af0a8e721d57a90",
    "native/s8-worker-launcher/host-state.mjs": "e6c5501494d21c948d678090204bc18338307cde",
    "native/s8-worker-launcher/launcher.mjs": "2b16e7b3f860dd64887bbe4509f11f85f31368a5",
    "native/s8-worker-launcher/ledger.mjs": "92743cf4b8010786db380f9b14cc38ec5abebb38",
    "native/s8-worker-launcher/ledger.test.mjs": "f5e8048c6114b42e79d7cea45e8c22ef85d7b40e",
    "native/s8-worker-launcher/operation.mjs": "1f3ecd56a29e64a8b5b326af7f10a30c81c2fb60",
    "native/s8-worker-launcher/result.mjs": "dd1d12ec40ce222b6e136af377298a987fb818af",
    "native/s8-worker-launcher/result.test.mjs": "f230fab3e942d7a22025e8a5020ef5db0f14a7ad",
    "src/lib/s8-native-admission.ts": "fab56d2a11fc124874336aa1948fc7576fa3c822",
    "src/lib/s8-native-release.ts": "4e944693ee5730c3dd6ea20636e0f4e8b0728a36",
    "tests/s8-native-policy-crosscheck.test.ts": "6d17e77b740ac432297176858caeeaecd54ec905"
  },
  "deletions": [
    "native/s8-sandbox-broker/deploy/s8-sandbox",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer",
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in",
    "scripts/s8/s8_application_boundary_proof.mts",
    "scripts/s8/s8_application_boundary_proof.sh",
    "scripts/s8/s8_runtime_sensitivity.py"
  ],
  "new": [
    "src/lib/s8-native-proof.ts",
    "tests/s8-native-proof.test.ts"
  ],
  "deletionIdentities": {
    "native/s8-sandbox-broker/deploy/s8-sandbox": {
      "mode": "100755",
      "blob": "f9dfc0fc75660a7981833750f3465d62096c264e"
    },
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service": {
      "mode": "100644",
      "blob": "afbc2aeb742882fd20e941d29eac18fa3a0010d2"
    },
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer": {
      "mode": "100644",
      "blob": "65b419b733b4b8289fae62606f303034993c3574"
    },
    "native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in": {
      "mode": "100644",
      "blob": "1fd2b1b8ffa64bd0ae3828644e4010c7e45aa9cc"
    },
    "scripts/s8/s8_application_boundary_proof.mts": {
      "mode": "100644",
      "blob": "ba413797b38e3fcfa42141d5ef02d482a8c05218"
    },
    "scripts/s8/s8_application_boundary_proof.sh": {
      "mode": "100644",
      "blob": "ef57ad01e781350eb04be37799b53efaecc7936d"
    },
    "scripts/s8/s8_runtime_sensitivity.py": {
      "mode": "100644",
      "blob": "1b7ca7bd69831fa17a21bc0131fa04044591c18b"
    }
  }
} as const;

function contractGit(...args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function verifyGitContract(candidate: string | null): void {
  const target = candidate ?? "HEAD";
  const base = gitContract.base;
  assert.equal(contractGit("rev-parse", `${base}^{tree}`), "cd7ad2ad1e494a733468ecbb883be1afda644c49");
  contractGit("merge-base", "--is-ancestor", base, target);
  const allowed = new Set<string>([
    ...gitContract.reimplement, ...Object.keys(gitContract.transplant),
    ...gitContract.deletions, ...gitContract.new,
  ]);
  assert.equal(allowed.size, 96);
  assert.equal(gitContract.reimplement.length, 36);
  assert.equal(Object.keys(gitContract.transplant).length, 51);
  assert.equal(gitContract.deletions.length, 7);
  assert.equal(gitContract.new.length, 2);
  const range = candidate ? [base, candidate] : [base];
  const status = contractGit("diff", "--name-status", "--no-renames", ...range)
    .split("\n").filter(Boolean).map((line) => line.split("\t"));
  const others = candidate ? [] : contractGit("ls-files", "--others", "--exclude-standard")
    .split("\n").filter(Boolean).map((path) => ["A", path]);
  const inventory = [...status, ...others];
  assert.equal(new Set(inventory.map((row) => row[1])).size, inventory.length);
  assert.ok(inventory.length <= 96, "changed path ceiling");
  for (const [kind, path] of inventory) {
    assert.ok(path && allowed.has(path), `unauthorized path: ${path}`);
    assert.match(kind!, /^[AMD]$/u);
  }
  assert.ok(inventory.filter(([kind]) => kind === "A").length <= 57);
  assert.deepEqual(inventory.filter(([kind]) => kind === "D").map((row) => row[1]).sort(), [...gitContract.deletions].sort());
  const renameStatus = contractGit("diff", "--name-status", "--find-renames", ...range);
  assert.doesNotMatch(renameStatus, /(?:^|\n)[RC]\d+\t/u, "renames/copies are not admitted");
  const treeEntry = (ref: string, path: string) => contractGit("ls-tree", ref, "--", path);
  for (const [path, blob] of Object.entries(gitContract.transplant)) {
    const sourceEntry = treeEntry("c440ff2723176f3364fae4d8ec916fd0f0e810e4", path);
    assert.equal(sourceEntry.split(/\s/u)[2], blob, `transplant source: ${path}`);
    if (candidate) {
      assert.equal(treeEntry(candidate, path), sourceEntry, `candidate transplant mode/blob: ${path}`);
    } else {
      assert.equal(contractGit("hash-object", `--path=${path}`, path), blob, `working transplant: ${path}`);
      assert.equal(contractGit("ls-files", "--stage", "--", path).split(" ")[0], sourceEntry.split(" ")[0], `transplant mode: ${path}`);
    }
  }
  for (const [path, identity] of Object.entries(gitContract.deletionIdentities)) {
    assert.equal(treeEntry(base, path), `${identity.mode} blob ${identity.blob}\t${path}`);
    if (candidate) assert.equal(treeEntry(candidate, path), "");
    else assert.equal(existsSync(path), false, `deleted path returned: ${path}`);
  }
  const readAt = (path: string): string => candidate
    ? contractGit("show", `${candidate}:${path}`)
    : readFileSync(path, "utf8");
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const oid = candidate ? contractGit("rev-parse", `${candidate}:${path}`) : contractGit("hash-object", `--path=${path}`, path);
    assert.equal(oid, contractGit("rev-parse", `${base}:${path}`), `unchanged dependency surface: ${path}`);
  }
  const basePackage = JSON.parse(contractGit("show", `${base}:package.json`));
  const nextPackage = JSON.parse(readAt("package.json"));
  const baseTest = basePackage.scripts.test as string;
  const nextTest = nextPackage.scripts.test as string;
  delete basePackage.scripts.test;
  delete nextPackage.scripts.test;
  assert.deepEqual(nextPackage, basePackage, "only test membership may change in package.json");
  const requiredTests = [...new Set([...baseTest.split(/\s+/u),
    "tests/s8-native-proof.test.ts", "tests/s8-native-policy-crosscheck.test.ts",
    "tests/s8-native-admission.test.ts", "tests/s8-native-release.test.ts",
  ])].sort();
  assert.deepEqual(nextTest.split(/\s+/u).sort(), requiredTests);
  contractGit("diff", "--check", ...range);
  if (candidate) {
    assert.match(candidate, /^[0-9a-f]{40}$/u, "candidate must be an immutable SHA");
    const parents = contractGit("rev-list", "--parents", "-n", "1", candidate).split(" ");
    assert.deepEqual(parents, [candidate, base], "one immutable direct-child candidate");
    assert.equal(contractGit("log", "--format=%an <%ae>|%cn <%ce>", `${base}..${candidate}`),
      "WJ <10020253+weijunswj@users.noreply.github.com>|WJ <10020253+weijunswj@users.noreply.github.com>");
  }
}

test("G135-GIT-working-tree satisfies the amended 96/36/51/7/2 contract", () => {
  verifyGitContract(null);
});

if (process.env.S8_G135_CANDIDATE !== undefined) {
  test("G135-GIT-candidate binds immutable commit, exact scope, modes, blobs and author identity", () => {
    verifyGitContract(process.env.S8_G135_CANDIDATE!);
  });
}

  test.after(cleanupSharedS8ProofFixture);
}
