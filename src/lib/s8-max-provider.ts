import { Buffer } from "node:buffer";
import type {
  S8MaxPayloadV1,
  S8MaxProviderFailureCode,
  S8MaxProviderMetadata,
  S8MaxReadback,
  S8MaxSemanticManifestDocument,
  S8SemanticBinding,
  S8SourceStampV1,
  Sha256,
  Timestamp,
  UUID,
} from "./types";
import {
  buildS8IndependentReadback,
  buildS8Scene,
  compareS8SemanticManifest,
  type S8Scene,
} from "./s8-semantic";
import { S8_NATIVE_FILE_NAME, validateS8Payload } from "./s8-payload";
import { cloneJson, jcs, newUuid, nowUtc, sha256 } from "./utils";

export type S8MaxProviderStage = "generation" | "validation";

export class S8MaxProviderError extends Error {
  readonly code: S8MaxProviderFailureCode;
  readonly stage: S8MaxProviderStage;
  readonly providerRetryable: boolean;

  constructor(code: S8MaxProviderFailureCode, stage: S8MaxProviderStage, providerRetryable: boolean, detail = "provider") {
    super(`${code}: ${detail}`);
    this.name = "S8MaxProviderError";
    this.code = code;
    this.stage = stage;
    this.providerRetryable = providerRetryable;
  }
}

export type S8MaxProviderInput = {
  projectId: UUID;
  jobId: UUID;
  artifactId: UUID;
  payload: S8MaxPayloadV1;
  payloadBytes: Uint8Array;
  sourceStamp: S8SourceStampV1;
  sourceStampDigest: Sha256;
  payloadSha256: Sha256;
  attempt: number;
};

export type S8MaxProviderGenerationOutput = {
  provider: "aps-oss-v2-direct-s3" | "mock-oss-v2" | "unavailable";
  artifactBytes: Buffer;
  binding: S8SemanticBinding;
  scene: S8Scene | null;
  nativeSaveOutcome: "pass" | "fail";
  metadata: S8MaxProviderMetadata;
};

export type S8MaxProviderValidationInput = S8MaxProviderInput & {
  artifactBytes: Buffer;
  artifactSha256: Sha256;
  artifactByteSize: number;
  manifest: S8MaxSemanticManifestDocument;
  binding: S8SemanticBinding;
};

export type S8MaxProviderValidationOutput = {
  provider: "aps-oss-v2-direct-s3" | "mock-oss-v2" | "unavailable";
  binding: S8SemanticBinding;
  readback: S8MaxReadback;
  scene: S8Scene | null;
  metadata: S8MaxProviderMetadata;
};

export type S8MaxProvider = {
  readonly providerKind: "aps-oss-v2-direct-s3" | "mock-oss-v2" | "unavailable";
  generate(input: S8MaxProviderInput): Promise<S8MaxProviderGenerationOutput>;
  validate(input: S8MaxProviderValidationInput): Promise<S8MaxProviderValidationOutput>;
};

export type S8OssV2Object = { bytes: Buffer; sha256: Sha256; byteSize: number };

/**
 * Offline exact-key storage used by provider-contract tests. It models the
 * write-once private OSS v2/direct-S3 boundary without creating a live bucket.
 */
export class MockOssV2Transfer {
  private readonly objects = new Map<string, Buffer>();

  putExact(key: string, bytes: Uint8Array): S8OssV2Object {
    if (this.objects.has(key)) throw new Error("S8_OUTPUT_EXISTS");
    const copy = Buffer.from(bytes);
    this.objects.set(key, copy);
    return { bytes: Buffer.from(copy), sha256: sha256(copy), byteSize: copy.length };
  }

  readExact(key: string): S8OssV2Object {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("S8_OUTPUT_MISSING");
    const copy = Buffer.from(bytes);
    return { bytes: copy, sha256: sha256(copy), byteSize: copy.length };
  }

  promoteExact(stagingKey: string, finalKey: string): S8OssV2Object {
    if (this.objects.has(finalKey)) throw new Error("S8_OUTPUT_EXISTS");
    const staged = this.readExact(stagingKey);
    this.objects.set(finalKey, Buffer.from(staged.bytes));
    return this.readExact(finalKey);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

export type MockProviderOptions = {
  clock?: () => Timestamp;
  generationFailures?: S8MaxProviderFailureCode[];
  validationFailures?: S8MaxProviderFailureCode[];
  transfer?: MockOssV2Transfer;
};

const PROVIDER_ERROR_CODES = new Set<S8MaxProviderFailureCode>([
  "APS_UNAVAILABLE", "APS_QUEUE_DELAY", "APS_RATE_LIMIT", "APS_AUTH_FAILURE", "APS_ENGINE_UNAVAILABLE", "APS_ENGINE_DEPRECATED",
  "APS_ENGINE_VERSION_MOVED", "APS_INPUT_DOWNLOAD_FAILED", "APS_WORKITEM_FAILED", "APS_INSTRUCTIONS_FAILED", "APS_TIMEOUT",
  "APS_OUTPUT_UPLOAD_FAILED", "APS_OUTPUT_MISSING", "APS_OUTPUT_INTEGRITY_MISMATCH", "APS_VALIDATOR_FAILED",
]);

function isProviderFailure(code: S8MaxProviderFailureCode): boolean {
  return PROVIDER_ERROR_CODES.has(code);
}

function providerBinding(input: S8MaxProviderInput): S8SemanticBinding {
  const generationId = "swooshz-s8-max-generation-v1";
  const validationId = "swooshz-s8-max-validation-v1";
  const generationVersion = "mock-oss-v2-1";
  const validationVersion = "mock-oss-v2-1";
  return {
    sourceStampDigest: input.sourceStampDigest,
    payloadSha256: input.payloadSha256,
    generationAppBundleId: generationId,
    generationAppBundleVersion: generationVersion,
    generationAppBundleHash: sha256(`mock-appbundle:${generationId}:${generationVersion}`),
    generationActivityId: generationId,
    generationActivityVersion: generationVersion,
    generationActivityHash: sha256(`mock-activity:${generationId}:${generationVersion}`),
    validatorAppBundleId: validationId,
    validatorAppBundleVersion: validationVersion,
    validatorAppBundleHash: sha256(`mock-appbundle:${validationId}:${validationVersion}`),
    validatorActivityId: validationId,
    validatorActivityVersion: validationVersion,
    validatorActivityHash: sha256(`mock-activity:${validationId}:${validationVersion}`),
    engineId: "mock-3dsmax",
    productVersion: "mock",
    engineVersion: "mock-oss-v2-1",
    constructionAlgorithmVersion: "s8-max-scene-construction-v1",
    semanticAlgorithmVersion: "s8-max-semantic-v1",
  };
}

function metadata(
  input: S8MaxProviderInput,
  binding: S8SemanticBinding,
  stage: S8MaxProviderStage,
  attempt: number,
  outcome: "pass" | "hold" | "fail",
  failureCode: S8MaxProviderFailureCode | null,
): S8MaxProviderMetadata {
  return {
    schemaVersion: "s8-max-provider-metadata-v1",
    metadataId: newUuid(),
    projectId: input.projectId,
    artifactId: input.artifactId,
    jobId: input.jobId,
    stage,
    provider: "mock-oss-v2",
    providerAttempt: attempt,
    outcome,
    failureCode,
    engineId: binding.engineId,
    productVersion: binding.productVersion,
    engineVersion: binding.engineVersion,
    appBundleId: stage === "generation" ? binding.generationAppBundleId : binding.validatorAppBundleId,
    appBundleVersion: stage === "generation" ? binding.generationAppBundleVersion : binding.validatorAppBundleVersion,
    appBundleHash: stage === "generation" ? binding.generationAppBundleHash : binding.validatorAppBundleHash,
    activityId: stage === "generation" ? binding.generationActivityId : binding.validatorActivityId,
    activityVersion: stage === "generation" ? binding.generationActivityVersion : binding.validatorActivityVersion,
    activityHash: stage === "generation" ? binding.generationActivityHash : binding.validatorActivityHash,
    occurredAt: nowUtc(),
  };
}

function throwFailure(code: S8MaxProviderFailureCode, stage: S8MaxProviderStage): never {
  if (isProviderFailure(code)) throw new S8MaxProviderError(code, stage, true);
  throw new S8MaxProviderError(code, stage, false);
}

type MockArtifactEnvelope = {
  schemaVersion: "s8.mock-native-max-v1";
  transportFileName: typeof S8_NATIVE_FILE_NAME;
  projectId: UUID;
  jobId: UUID;
  artifactId: UUID;
  sourceStampDigest: Sha256;
  payloadSha256: Sha256;
  binding: S8SemanticBinding;
  scene: S8Scene;
};

function encodeArtifact(envelope: MockArtifactEnvelope): Buffer {
  return Buffer.from(jcs(envelope), "utf8");
}

export function decodeMockNativeArtifact(bytes: Uint8Array): MockArtifactEnvelope {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as MockArtifactEnvelope;
    if (value.schemaVersion !== "s8.mock-native-max-v1" || value.transportFileName !== S8_NATIVE_FILE_NAME || !value.scene || !value.binding) throw new Error("invalid envelope");
    return value;
  } catch {
    throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "validation", true, "mock artifact");
  }
}

export class MockS8MaxProvider implements S8MaxProvider {
  readonly providerKind = "mock-oss-v2" as const;
  readonly transfer: MockOssV2Transfer;
  private readonly clock: () => Timestamp;
  private readonly generationFailures: S8MaxProviderFailureCode[];
  private readonly validationFailures: S8MaxProviderFailureCode[];

  constructor(options: MockProviderOptions = {}) {
    this.transfer = options.transfer ?? new MockOssV2Transfer();
    this.clock = options.clock ?? nowUtc;
    this.generationFailures = [...(options.generationFailures ?? [])];
    this.validationFailures = [...(options.validationFailures ?? [])];
  }

  async generate(input: S8MaxProviderInput): Promise<S8MaxProviderGenerationOutput> {
    validateS8Payload(input.payload);
    const binding = providerBinding(input);
    const failure = this.generationFailures.shift();
    if (failure) throwFailure(failure, "generation");
    const scene = buildS8Scene(input.payload, input.artifactId, input.payloadSha256);
    const envelope: MockArtifactEnvelope = {
      schemaVersion: "s8.mock-native-max-v1",
      transportFileName: S8_NATIVE_FILE_NAME,
      projectId: input.projectId,
      jobId: input.jobId,
      artifactId: input.artifactId,
      sourceStampDigest: input.sourceStampDigest,
      payloadSha256: input.payloadSha256,
      binding: cloneJson(binding),
      scene: cloneJson(scene),
    };
    const artifactBytes = encodeArtifact(envelope);
    return {
      provider: this.providerKind,
      artifactBytes,
      binding,
      scene,
      nativeSaveOutcome: "pass",
      metadata: { ...metadata(input, binding, "generation", input.attempt, "pass", null), occurredAt: this.clock() },
    };
  }

  async validate(input: S8MaxProviderValidationInput): Promise<S8MaxProviderValidationOutput> {
    const failure = this.validationFailures.shift();
    if (failure) throwFailure(failure, "validation");
    const envelope = decodeMockNativeArtifact(input.artifactBytes);
    if (envelope.projectId !== input.projectId || envelope.artifactId !== input.artifactId || envelope.sourceStampDigest !== input.sourceStampDigest || envelope.payloadSha256 !== input.payloadSha256) {
      throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "validation", true, "source binding");
    }
    if (jcs(envelope.binding) !== jcs(input.binding)) {
      throw new S8MaxProviderError("APS_OUTPUT_INTEGRITY_MISMATCH", "validation", true, "tool binding");
    }
    const readback = buildS8IndependentReadback({
      projectId: input.projectId,
      artifactId: input.artifactId,
      sourceStampDigest: input.sourceStampDigest,
      payloadSha256: input.payloadSha256,
      binding: cloneJson(input.binding),
      artifactSha256: input.artifactSha256,
      artifactByteSize: input.artifactByteSize,
      scene: envelope.scene,
      checkedAt: this.clock(),
    });
    const comparison = compareS8SemanticManifest(input.manifest, readback);
    if (comparison.outcome !== "pass") throw new S8MaxProviderError("APS_VALIDATOR_FAILED", "validation", true, comparison.issues.join(","));
    return {
      provider: this.providerKind,
      binding: cloneJson(input.binding),
      readback,
      scene: envelope.scene,
      metadata: { ...metadata(input, input.binding, "validation", input.attempt, "pass", null), occurredAt: this.clock() },
    };
  }
}

export class UnavailableS8MaxProvider implements S8MaxProvider {
  readonly providerKind = "unavailable" as const;

  async generate(_input: S8MaxProviderInput): Promise<S8MaxProviderGenerationOutput> {
    throw new S8MaxProviderError("APS_UNAVAILABLE", "generation", true, "live APS authority is not bound");
  }

  async validate(_input: S8MaxProviderValidationInput): Promise<S8MaxProviderValidationOutput> {
    throw new S8MaxProviderError("APS_UNAVAILABLE", "validation", true, "live APS authority is not bound");
  }
}

/** Live APS is intentionally a fail-closed boundary in this executor slice. */
export class ApsOssV2DirectS3Provider implements S8MaxProvider {
  readonly providerKind = "aps-oss-v2-direct-s3" as const;

  async generate(input: S8MaxProviderInput): Promise<S8MaxProviderGenerationOutput> {
    return new UnavailableS8MaxProvider().generate(input);
  }

  async validate(input: S8MaxProviderValidationInput): Promise<S8MaxProviderValidationOutput> {
    return new UnavailableS8MaxProvider().validate(input);
  }
}

export const createMockS8MaxProvider = (options?: MockProviderOptions): MockS8MaxProvider => new MockS8MaxProvider(options);
export const createUnavailableS8MaxProvider = (): UnavailableS8MaxProvider => new UnavailableS8MaxProvider();
