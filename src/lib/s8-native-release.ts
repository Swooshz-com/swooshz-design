import { verify as verifySignature } from "node:crypto";
import { S8_FBX_PROFILE, S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_UFBX_PIN, S8_VALIDATOR_PIN } from "./s8-fbx-profile";
import { S8_NATIVE_RESOURCE_POLICY_SHA256 } from "./s8-native-admission";
import { jcs, sha256 } from "./utils";

export const S8_NATIVE_WORKER_PROTOCOL_VERSION = "s8-native-worker-v1" as const;

export type S8ReleaseManifestBody = {
  schemaVersion: "s8-release-manifest-v1";
  releaseId: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
  signingKeyId: string;
  protocolVersion: typeof S8_NATIVE_WORKER_PROTOCOL_VERSION;
  profile: typeof S8_FBX_PROFILE;
  resourcePolicySha256: string;
  processRunnerSha256: string;
  writer: {
    imageDigest: string;
    blenderVersion: string;
    blenderArchiveSha256: string;
    exporterPatchSha256: string;
    writerScriptSha256: string;
  };
  validator: {
    imageDigest: string;
    identity: typeof S8_VALIDATOR_PIN.identity;
    ufbxVersion: string;
    ufbxCommit: string;
    ufbxTree: string;
    executableSha256: string;
  };
  sandbox: { seccompPolicySha256: string; appArmorPolicySha256: string };
  provenanceSha256: string;
  sbomSha256: string;
};

export type S8SignedReleaseManifest = { manifest: S8ReleaseManifestBody; signature: string };
export type S8VerifiedReleaseManifest = { manifest: S8ReleaseManifestBody; sha256: string };

const HEX64 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,80}$/u;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,120}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_DOMAIN = "S8-RELEASE-MANIFEST-V1\0";
const CLOCK_SKEW_MS = 5000;
const MAX_RELEASE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("release");
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new Error("release");
}

function assertImageDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IMAGE_DIGEST.test(value)) throw new Error("release");
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") throw new Error("release");
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("release");
  return result;
}

export function verifyS8ReleaseManifest(
  input: unknown,
  trustedKeys: Readonly<Record<string, string>>,
  nowMs = Date.now(),
): S8VerifiedReleaseManifest {
  const signed = record(input);
  exactKeys(signed, ["manifest", "signature"]);
  const body = record(signed.manifest);
  exactKeys(body, [
    "schemaVersion", "releaseId", "sequence", "createdAt", "expiresAt", "signingKeyId", "protocolVersion", "profile",
    "resourcePolicySha256", "processRunnerSha256", "writer", "validator", "sandbox", "provenanceSha256", "sbomSha256",
  ]);
  if (body.schemaVersion !== "s8-release-manifest-v1" || typeof body.releaseId !== "string" || !RELEASE_ID.test(body.releaseId)
    || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 || typeof body.signingKeyId !== "string" || !KEY_ID.test(body.signingKeyId)
    || body.protocolVersion !== S8_NATIVE_WORKER_PROTOCOL_VERSION || body.profile !== S8_FBX_PROFILE) throw new Error("release");
  const createdAt = timestamp(body.createdAt);
  const expiresAt = timestamp(body.expiresAt);
  if (createdAt > nowMs + CLOCK_SKEW_MS || expiresAt <= nowMs || expiresAt <= createdAt || expiresAt - createdAt > MAX_RELEASE_AGE_MS) throw new Error("release");
  assertDigest(body.resourcePolicySha256);
  if (body.resourcePolicySha256 !== S8_NATIVE_RESOURCE_POLICY_SHA256) throw new Error("release");
  assertDigest(body.processRunnerSha256);
  assertDigest(body.provenanceSha256);
  assertDigest(body.sbomSha256);

  const writer = record(body.writer);
  exactKeys(writer, ["imageDigest", "blenderVersion", "blenderArchiveSha256", "exporterPatchSha256", "writerScriptSha256"]);
  assertImageDigest(writer.imageDigest);
  if (writer.blenderVersion !== S8_BLENDER_PIN.version || typeof writer.blenderVersion !== "string") throw new Error("release");
  assertDigest(writer.blenderArchiveSha256);
  if (writer.blenderArchiveSha256 !== S8_BLENDER_PIN.archiveSha256) throw new Error("release");
  assertDigest(writer.exporterPatchSha256);
  if (typeof writer.writerScriptSha256 !== "string" || !HEX64.test(writer.writerScriptSha256)) throw new Error("release");

  const validator = record(body.validator);
  exactKeys(validator, ["imageDigest", "identity", "ufbxVersion", "ufbxCommit", "ufbxTree", "executableSha256"]);
  assertImageDigest(validator.imageDigest);
  if (validator.identity !== S8_VALIDATOR_PIN.identity || validator.ufbxVersion !== S8_UFBX_PIN.version
    || validator.ufbxCommit !== S8_UFBX_PIN.commit || validator.ufbxTree !== S8_UFBX_PIN.tree) throw new Error("release");
  assertDigest(validator.executableSha256);

  const sandbox = record(body.sandbox);
  exactKeys(sandbox, ["seccompPolicySha256", "appArmorPolicySha256"]);
  assertDigest(sandbox.seccompPolicySha256);
  assertDigest(sandbox.appArmorPolicySha256);

  const keyId = body.signingKeyId;
  const publicKeyPem = trustedKeys[keyId];
  if (!publicKeyPem || typeof signed.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signed.signature)) throw new Error("release");
  const signature = Buffer.from(signed.signature, "base64url");
  if (signature.length !== 64 || !verifySignature(null, Buffer.concat([Buffer.from(RELEASE_DOMAIN, "ascii"), Buffer.from(jcs(body), "utf8")]), publicKeyPem, signature)) throw new Error("release");

  const manifest = body as unknown as S8ReleaseManifestBody;
  return { manifest, sha256: sha256(jcs(signed)) };
}
