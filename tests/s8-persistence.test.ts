import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advanceS8Publication, assertS8SourceFence, mayReclaimS8Claim, S8_STALE_CLAIM_MS, type S8PublicationRecord } from "../src/lib/s8-fbx-persistence";
import { emptyStoreState, JsonRepository } from "../src/lib/store";
import { jcs, sha256 } from "../src/lib/utils";

function record(): S8PublicationRecord {
  return { projectId: "p", artifactId: "a", sourceRevisionId: "r", sourceRevisionHash: "h", claimToken: "c", ownerId: "o", phase: "source_admission", heartbeatAtMs: 0, stagingKey: "stage", finalKey: "final", artifactSha256: null, validatorReceiptHash: null, committedAtMs: null, failureCode: null };
}

test("publication phases are monotonic and source movement always fences", () => {
  let value = record();
  for (const phase of ["claim", "private_staging", "independent_validation", "source_claim_recheck", "immutable_promotion", "verified_readback", "commit"] as const) value = advanceS8Publication(value, "c", "o", phase, value.heartbeatAtMs + 1);
  assert.equal(value.phase, "commit");
  assert.throws(() => assertS8SourceFence(value, "new", "new"), /S8_SOURCE_STALE/);
  assert.throws(() => advanceS8Publication(record(), "c", "o", "commit", 1), /S8_PUBLICATION_PHASE_INVALID/);
});
test("reclaim needs expiry plus positive dead-owner proof", () => {
  const value = record();
  assert.equal(mayReclaimS8Claim(value, S8_STALE_CLAIM_MS, "dead"), false);
  assert.equal(mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "dead"), true);
  assert.throws(() => mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "live"), /S8_CONTROLLER_REQUIRED/);
  assert.throws(() => mayReclaimS8Claim(value, S8_STALE_CLAIM_MS + 1, "unknown"), /S8_CONTROLLER_REQUIRED/);
});

const LEGACY_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const LEGACY_HASH = "a".repeat(64);

function legacySource(projectId: string) {
  return {
    projectId,
    sourceRevisionId: "10000000-0000-4000-8000-000000000001",
    sourceRevisionHash: LEGACY_HASH,
    sourceS5Fingerprint: "b".repeat(64),
    s6ValidationReceiptId: "10000000-0000-4000-8000-000000000002",
    s6ValidationHash: "c".repeat(64),
    s6HandoffDigest: "d".repeat(64),
    s7ArtifactId: "10000000-0000-4000-8000-000000000003",
    s7ArtifactHash: "e".repeat(64),
    s7ReadbackHash: "f".repeat(64),
    s7ManifestId: "10000000-0000-4000-8000-000000000004",
    s7ManifestHash: "1".repeat(64),
    s8Profile: "swooshz-fbx-static-mesh-v1",
    s8ProtocolVersion: "s8-end-to-end-executable-contract-v1",
  };
}

function legacyState(options: { version?: 1 | 2 | 3 | 99; activeAttempt?: "DISPATCHING" | "FAILED"; attemptVersion?: 1 | 2 } = {}) {
  const projectId = "20000000-0000-4000-8000-000000000001";
  const jobId = "20000000-0000-4000-8000-000000000002";
  const artifactId = "20000000-0000-4000-8000-000000000003";
  const claimToken = "20000000-0000-4000-8000-000000000004";
  const idempotencyKey = "legacy-export-key";
  const source = legacySource(projectId);
  const dispatching = options.activeAttempt === "DISPATCHING";
  const failed = options.activeAttempt === "FAILED";
  const state = { ...emptyStoreState() } as unknown as Record<string, any>;
  delete state.s8NativeProofSchemaVersion;
  delete state.s8ValidationReceiptBytes;
  delete state.s8NativeProofCheckpoints;
  delete state.s8NativeTerminalOutcomes;
  if (options.version === undefined) delete state.s8NativeEvidenceVersion;
  else state.s8NativeEvidenceVersion = options.version;
  state.s8ExportJobs = [{
    schemaVersion: "s8-export-job-v2", jobId, projectId, artifactId, source, inputHash: LEGACY_HASH, idempotencyKey,
    status: dispatching ? "running" : failed ? "failed_terminal" : "queued",
    publicationPhase: dispatching ? "claim" : "source_admission", attempt: 1,
    claimToken: dispatching ? claimToken : null, ownerId: dispatching ? "legacy-owner" : null,
    ownerProcessId: dispatching ? 321 : null, claimedAt: dispatching ? LEGACY_TIMESTAMP : null,
    heartbeatAt: dispatching ? LEGACY_TIMESTAMP : null, createdAt: LEGACY_TIMESTAMP, updatedAt: LEGACY_TIMESTAMP,
    terminalAt: failed ? LEGACY_TIMESTAMP : null, failureCode: failed ? "S8_NATIVE_LEGACY_FAILURE" : null,
  }];
  state.s8Artifacts = [{
    schemaVersion: "s8-artifact-v2", artifactId, projectId, jobId, source, inputHash: LEGACY_HASH,
    profile: "swooshz-fbx-static-mesh-v1", format: "fbx", mimeType: "application/octet-stream",
    downloadFileName: "swooshz-s8-scene.fbx", status: dispatching ? "running" : failed ? "failed_terminal" : "queued",
    publicationPhase: dispatching ? "claim" : "source_admission", payloadSha256: null, objectHashes: null,
    writerReceiptHash: null, nativeReadbackHash: null, semanticReceiptHash: null, publicationReceiptHash: null,
    validationReceiptId: null, validationReceiptHash: null, immutableReuseFingerprint: null,
    privateStagingPrefix: `private/projects/${projectId}/s8/staging/${artifactId}/${dispatching ? claimToken : "unclaimed"}`,
    privateFinalPrefix: `private/projects/${projectId}/s8/committed/${source.sourceRevisionHash}/${"0".repeat(64)}`,
    attempt: 1, retryOfArtifactId: null, failureCode: failed ? "S8_NATIVE_LEGACY_FAILURE" : null,
    createdAt: LEGACY_TIMESTAMP, updatedAt: LEGACY_TIMESTAMP,
    committedAt: null, staleAt: null,
  }];
  state.s8ValidationReceipts = [];
  state.s8IdempotencyRecords = [{
    schemaVersion: "s8-idempotency-v2", projectId, operation: "export", idempotencyKey, inputHash: LEGACY_HASH,
    source, jobId, artifactId, createdAt: LEGACY_TIMESTAMP,
  }];
  const legacyAttempt = {
    schemaVersion: "s8-native-operation-attempt-v1", attemptId: "20000000-0000-4000-8000-000000000005",
    projectId, jobId, artifactId, claimToken, attempt: 1, operation: "WRITER", state: options.activeAttempt,
    inputSha256: LEGACY_HASH, requestSha256: null, requestNonce: null, responseSha256: null,
    releaseManifestSha256: null, failureClass: options.activeAttempt === "FAILED" ? "PERMANENT" : null,
    disposalState: options.activeAttempt === "FAILED" ? "REAPED_REMOVED" : "NOT_STARTED",
    createdAt: LEGACY_TIMESTAMP, updatedAt: LEGACY_TIMESTAMP,
    completedAt: options.activeAttempt === "FAILED" ? LEGACY_TIMESTAMP : null,
  };
  const nativeAttempt = {
    schemaVersion: "s8-native-operation-attempt-v2", attemptId: legacyAttempt.attemptId, projectId, jobId, artifactId,
    claimToken, attempt: 1, operation: "WRITER", state: options.activeAttempt ?? "DISPATCHING",
    acceptedSourceDigest: sha256(jcs(source)), profile: "swooshz-fbx-static-mesh-v1",
    protocolVersion: "s8-native-worker-v1", configSha256: "2".repeat(64), resourcePolicySha256: "3".repeat(64),
    operationStartedAtUnixMs: 1000000, deadlineUnixMs: 1510000, clockModelVersion: "s8-effective-unix-ms-v1",
    processClockEpoch: "20000000-0000-4000-8000-000000000006", operationStartMonotonicNs: "0",
    inputSha256: LEGACY_HASH, inputBytes: 1, requestSha256: null, requestNonce: null, signedRequest: null,
    responseSha256: null, signedResponse: null, releaseManifestSha256: "4".repeat(64),
    acceptanceReceipt: null, retryEvidence: null, failureClass: null, failureCode: null, disposalState: "NOT_STARTED",
    createdAt: LEGACY_TIMESTAMP, updatedAt: LEGACY_TIMESTAMP, completedAt: null,
  };
  state.s8NativeOperationAttempts = options.activeAttempt === undefined ? [] : [
    options.attemptVersion === 2 ? nativeAttempt : legacyAttempt,
  ];
  if (options.version === 2) state.s8NativeAttemptQuarantines = [];
  else delete state.s8NativeAttemptQuarantines;
  return { state, projectId, jobId, artifactId };
}

function withLegacyRepository(
  state: unknown,
  action: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "s8-legacy-migration-"));
  try {
    const raw = JSON.stringify(state);
    writeFileSync(join(root, "state.json"), raw, "utf8");
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withApplicationKeys(
  currentKeyId: string,
  currentPrivateKeyPem: string,
  keys: Array<{ keyId: string; publicKeyPem: string }>,
  action: () => void,
): void {
  const names = [
    "S8_APP_SIGNING_KEY_ID", "S8_APP_SIGNING_PRIVATE_KEY_PEM", "S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON",
    "S8_BLENDER_RUNTIME_ROOT", "S8_BLENDER_EXECUTABLE", "S8_WRITER_SCRIPT", "S8_PRIVATE_WORK_ROOT",
    "S8_PROCESS_RUNNER_EXECUTABLE", "S8_SANDBOX_EXECUTABLE", "S8_NATIVE_VALIDATOR_EXECUTABLE",
    "S8_SANDBOX_POLICY_SHA256", "S8_BLENDER_EXECUTABLE_SHA256",
    "S8_WORKER_GATEWAY_URL", "S8_CAPACITY_AUTHORITY_PUBLIC_KEYS_JSON", "S8_LAUNCHER_PUBLIC_KEYS_JSON",
    "S8_RELEASE_MANIFEST_JSON", "S8_RELEASE_PUBLIC_KEYS_JSON", "S8_WORKER_TLS_CA_PEM",
    "S8_WORKER_TLS_CLIENT_CERT_PEM", "S8_WORKER_TLS_CLIENT_KEY_PEM",
  ] as const;
  const before = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.S8_APP_SIGNING_KEY_ID = currentKeyId;
    process.env.S8_APP_SIGNING_PRIVATE_KEY_PEM = currentPrivateKeyPem;
    process.env.S8_APP_ACCEPTANCE_PUBLIC_KEYS_JSON = JSON.stringify({ schemaVersion: "s8-app-acceptance-keyset-v1", keys });
    action();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function legacyAcceptedV2State(legacyPrivateKeyPem: string) {
  const legacy = legacyState({ version: 2, activeAttempt: "DISPATCHING", attemptVersion: 2 });
  const attempt = legacy.state.s8NativeOperationAttempts[0];
  const source = legacy.state.s8ExportJobs[0].source;
  const requestNonce = Buffer.alloc(32, 17).toString("base64url");
  const releaseHandle = Buffer.alloc(32, 18).toString("base64url");
  const responseSha256 = "5".repeat(64);
  Object.assign(attempt, {
    state: "SUCCEEDED", acceptedSourceDigest: sha256(jcs(source)), operationStartMonotonicNs: "1",
    requestSha256: "6".repeat(64), requestNonce, signedRequest: { body: {}, signature: requestNonce },
    responseSha256, signedResponse: { body: {}, signature: requestNonce },
    disposalState: "REAPED_REMOVED", completedAt: LEGACY_TIMESTAMP,
  });
  const body = {
    schemaVersion: "s8-native-acceptance-v1", acceptanceId: "20000000-0000-4000-8000-000000000007",
    keyId: "historical-key", operationStartedAtUnixMs: 1000000, deadlineUnixMs: 1510000,
    responseObservedAtUnixMs: 1000001, logicalAcceptedAtUnixMs: 1000002,
    clockModelVersion: "s8-effective-unix-ms-v1", processClockEpoch: attempt.processClockEpoch,
    clockWitness: {
      operationStartMonotonicNs: "1", responseWallUnixMs: 1000001, responseMonotonicElapsedNs: "0",
      responsePriorEffectiveUnixMs: 1000000, decisionWallUnixMs: 1000002,
      decisionMonotonicElapsedNs: "1000000", decisionPriorEffectiveUnixMs: 1000001,
    },
    attemptId: attempt.attemptId, projectId: legacy.projectId, jobId: legacy.jobId, artifactId: legacy.artifactId,
    attempt: 1, operation: "WRITER", claimToken: attempt.claimToken, acceptedSourceDigest: attempt.acceptedSourceDigest,
    profile: "swooshz-fbx-static-mesh-v1", protocolVersion: "s8-native-worker-v1", configSha256: attempt.configSha256,
    requestSha256: attempt.requestSha256, requestNonce, inputSha256: attempt.inputSha256, inputBytes: attempt.inputBytes,
    responseSha256, outputSha256: "7".repeat(64), outputBytes: 28, auxiliarySha256: "8".repeat(64), auxiliaryBytes: 1,
    releaseManifestSha256: attempt.releaseManifestSha256, resourcePolicySha256: attempt.resourcePolicySha256,
    imageDigest: `sha256:${"9".repeat(64)}`, containerId: "a".repeat(64),
    runnerBinarySha256: "b".repeat(64), runnerEvidenceSha256: "c".repeat(64), releaseHandle,
    validatorIdentity: null, disposalState: "REAPED_REMOVED", nativeOutcome: "EXIT_0",
  };
  const signature = sign(null, Buffer.concat([
    Buffer.from("S8-NATIVE-ACCEPTANCE-V1\0", "ascii"), Buffer.from(jcs(body), "utf8"),
  ]), legacyPrivateKeyPem).toString("base64url");
  const unsignedEnvelope = { body, signature };
  attempt.acceptanceReceipt = { ...unsignedEnvelope, receiptSha256: sha256(jcs(unsignedEnvelope)) };
  return legacy;
}

test("missing-version pristine queued S8 work migrates to v3 without creating proof", () => {
  const legacy = legacyState();
  withLegacyRepository(legacy.state, (root) => {
    const repository = new JsonRepository(root);
    const migrated = repository.state();
    assert.equal(migrated.s8NativeEvidenceVersion, 3);
    assert.equal(migrated.s8NativeProofSchemaVersion, "s8-native-proof-v1");
    assert.equal(migrated.s8ExportJobs?.[0]?.schemaVersion, "s8-export-job-v3");
    assert.equal(migrated.s8ExportJobs?.[0]?.status, "queued");
    assert.equal(migrated.s8Artifacts?.[0]?.schemaVersion, "s8-artifact-v3");
    assert.equal(migrated.s8Artifacts?.[0]?.headCheckpointSha256, null);
    assert.deepEqual(migrated.s8NativeOperationAttempts, []);
    assert.deepEqual(migrated.s8NativeAttemptQuarantines, []);
    assert.deepEqual(migrated.s8NativeProofCheckpoints, []);
    const persisted = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(persisted.s8NativeEvidenceVersion, 3);
    const restarted = new JsonRepository(root).state();
    assert.equal(restarted.s8ExportJobs?.length, 1);
    assert.equal(restarted.s8NativeAttemptQuarantines?.length, 0);
  });
});

test("v1 dispatching evidence migrates to a reconciliation quarantine and cannot resume", () => {
  const legacy = legacyState({ version: 1, activeAttempt: "DISPATCHING" });
  withLegacyRepository(legacy.state, (root) => {
    const migrated = new JsonRepository(root).state();
    const job = migrated.s8ExportJobs?.[0];
    const artifact = migrated.s8Artifacts?.[0];
    const quarantine = migrated.s8NativeAttemptQuarantines?.[0] as Record<string, any> | undefined;
    assert.equal(job?.status, "failed_terminal");
    assert.equal(job?.publicationPhase, "source_admission");
    assert.equal(job?.failureCode, "S8_NATIVE_LEGACY_UNPROVEN");
    assert.equal(job?.claimToken, null);
    assert.equal(job?.ownerId, null);
    assert.equal(job?.heartbeatAt, null);
    assert.equal(artifact?.status, "failed_terminal");
    assert.equal(artifact?.payloadSha256, null);
    assert.equal(artifact?.objectHashes, null);
    assert.deepEqual(migrated.s8NativeOperationAttempts, []);
    assert.deepEqual(migrated.s8ValidationReceipts, []);
    assert.equal(quarantine?.quarantineId, legacy.jobId);
    assert.equal(quarantine?.predecessorEvidenceVersion, 1);
    assert.equal(quarantine?.admissionBlock, "RECONCILIATION_REQUIRED");
    assert.deepEqual(quarantine?.originalJob, legacy.state.s8ExportJobs[0]);
    assert.deepEqual(quarantine?.originalArtifact, legacy.state.s8Artifacts[0]);
    assert.deepEqual(quarantine?.originalAttempts, legacy.state.s8NativeOperationAttempts);
    assert.equal(quarantine?.originalIdempotencyRecords.length, 1);
    assert.equal(job?.terminalOutcomeId, migrated.s8NativeTerminalOutcomes?.[0]?.outcomeId);
    const restarted = new JsonRepository(root).state();
    assert.equal(restarted.s8NativeAttemptQuarantines?.length, 1);
    assert.equal((restarted.s8NativeAttemptQuarantines?.[0] as Record<string, unknown>).admissionBlock, "RECONCILIATION_REQUIRED");
  });
});

test("v1 completed attempt is quarantined without inventing a reconciliation block", () => {
  const legacy = legacyState({ version: 1, activeAttempt: "FAILED" });
  withLegacyRepository(legacy.state, (root) => {
    const migrated = new JsonRepository(root).state();
    const quarantine = migrated.s8NativeAttemptQuarantines?.[0] as Record<string, unknown> | undefined;
    assert.equal(quarantine?.admissionBlock, "NONE");
    assert.equal(migrated.s8ExportJobs?.[0]?.status, "failed_terminal");
    assert.deepEqual(migrated.s8NativeOperationAttempts, []);
  });
});

test("version-2 state requires and preserves a fully shaped v2 attempt in quarantine", () => {
  const legacy = legacyState({ version: 2, activeAttempt: "DISPATCHING", attemptVersion: 2 });
  withLegacyRepository(legacy.state, (root) => {
    const migrated = new JsonRepository(root).state();
    const quarantine = migrated.s8NativeAttemptQuarantines?.[0] as Record<string, any> | undefined;
    assert.equal(quarantine?.predecessorEvidenceVersion, 2);
    assert.equal(quarantine?.admissionBlock, "RECONCILIATION_REQUIRED");
    assert.equal(quarantine?.originalAttempts[0]?.schemaVersion, "s8-native-operation-attempt-v2");
    assert.deepEqual(migrated.s8NativeOperationAttempts, []);
    const malformed = legacyState({ version: 2, activeAttempt: "DISPATCHING", attemptVersion: 1 });
    const before = JSON.stringify(malformed.state);
    const otherRoot = mkdtempSync(join(tmpdir(), "s8-v2-shape-rejected-"));
    try {
      writeFileSync(join(otherRoot, "state.json"), before, "utf8");
      assert.throws(() => new JsonRepository(otherRoot), (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PERSISTENCE_FAILED");
      assert.equal(readFileSync(join(otherRoot, "state.json"), "utf8"), before);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

test("a quarantined v2 acceptance still requires its historical verification key", () => {
  const historical = generateKeyPairSync("ed25519");
  const current = generateKeyPairSync("ed25519");
  const historicalPublicKeyPem = historical.publicKey.export({ type: "spki", format: "pem" }).toString();
  const historicalPrivateKeyPem = historical.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const currentPublicKeyPem = current.publicKey.export({ type: "spki", format: "pem" }).toString();
  const currentPrivateKeyPem = current.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signedLegacy = legacyAcceptedV2State(historicalPrivateKeyPem);
  const keyHistory = [
    { keyId: "historical-key", publicKeyPem: historicalPublicKeyPem },
    { keyId: "current-key", publicKeyPem: currentPublicKeyPem },
  ];
  withApplicationKeys("current-key", currentPrivateKeyPem, keyHistory, () => {
    withLegacyRepository(signedLegacy.state, (root) => {
      const migrated = new JsonRepository(root).state();
      const quarantine = migrated.s8NativeAttemptQuarantines?.[0] as Record<string, any> | undefined;
      assert.equal(quarantine?.admissionBlock, "NONE");
      assert.deepEqual(quarantine?.originalAttempts[0]?.acceptanceReceipt, signedLegacy.state.s8NativeOperationAttempts[0].acceptanceReceipt);
      assert.deepEqual(migrated.s8NativeOperationAttempts, []);
    });
  });

  const missingHistory = legacyAcceptedV2State(historicalPrivateKeyPem);
  withApplicationKeys("current-key", currentPrivateKeyPem, [keyHistory[1]!], () => {
    withLegacyRepository(missingHistory.state, (root) => {
      const before = readFileSync(join(root, "state.json"));
      assert.throws(() => new JsonRepository(root), (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PERSISTENCE_FAILED");
      assert.deepEqual(readFileSync(join(root, "state.json")), before);
    });
  });
});

test("unknown and malformed v3 S8 evidence fail closed without rewriting canonical state", () => {
  for (const options of [{ version: 99 as const }, { version: 3 as const }]) {
    const legacy = legacyState(options);
    withLegacyRepository(legacy.state, (root) => {
      const before = readFileSync(join(root, "state.json"));
      assert.throws(() => new JsonRepository(root), (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PERSISTENCE_FAILED");
      assert.deepEqual(readFileSync(join(root, "state.json")), before);
    });
  }
});
