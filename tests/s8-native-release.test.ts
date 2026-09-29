import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { S8_FBX_PROFILE, S8_BLENDER_PIN, S8_EXPORTER_PATCH_PIN, S8_UFBX_PIN, S8_VALIDATOR_PIN } from "../src/lib/s8-fbx-profile";
import { S8_NATIVE_RESOURCE_POLICY_SHA256, type S8AdmissionEnvelope } from "../src/lib/s8-native-admission";
import { verifyS8ReleaseManifest } from "../src/lib/s8-native-release";
import { assertS8ReleaseAdmissionBinding } from "../src/lib/s8-native-worker-client";
import { jcs, sha256 } from "../src/lib/utils";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = Date.parse("2026-09-29T00:00:00.000Z");

function release() {
  return {
    schemaVersion: "s8-release-manifest-v2",
    releaseId: "alpha-1",
    sequence: 1,
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    signingKeyId: "release-2026",
    protocolVersion: "s8-native-worker-v1",
    profile: S8_FBX_PROFILE,
    resourcePolicySha256: S8_NATIVE_RESOURCE_POLICY_SHA256,
    processRunnerSha256: "4".repeat(64),
    writer: {
      imageDigest: `sha256:${"a".repeat(64)}`,
      blenderVersion: S8_BLENDER_PIN.version,
      blenderArchiveSha256: S8_BLENDER_PIN.archiveSha256,
      exporterPatchSha256: "b".repeat(64),
      writerScriptSha256: "c".repeat(64),
    },
    validator: {
      imageDigest: `sha256:${"d".repeat(64)}`,
      identity: S8_VALIDATOR_PIN.identity,
      ufbxVersion: S8_UFBX_PIN.version,
      ufbxCommit: S8_UFBX_PIN.commit,
      ufbxTree: S8_UFBX_PIN.tree,
      executableSha256: "e".repeat(64),
    },
    sandbox: { seccompPolicySha256: "f".repeat(64), jobAppArmorMode: "unsupported-not-relied-upon", rootlessKitHostAppArmor: { mode: "required-profile", profileName: "swooshz-s8-rootlesskit-v1", profileSha256: "1".repeat(64) } },
    provenanceSha256: "2".repeat(64),
    sbomSha256: "3".repeat(64),
  };
}

function signed(body: ReturnType<typeof release>) {
  const signature = sign(null, Buffer.concat([Buffer.from("S8-RELEASE-MANIFEST-V2\0", "ascii"), Buffer.from(jcs(body), "utf8")]), privatePem).toString("base64url");
  return { manifest: body, signature };
}

test("S8 release manifests require an exact signature and pin both image and executable identities", () => {
  const value = signed(release());
  const verified = verifyS8ReleaseManifest(value, { "release-2026": publicPem }, now);
  assert.equal(verified.sha256, sha256(jcs(value)));
  assert.equal(verified.manifest.writer.imageDigest, value.manifest.writer.imageDigest);
  assert.equal(verified.manifest.validator.executableSha256, value.manifest.validator.executableSha256);
  assert.equal(verified.manifest.sandbox.jobAppArmorMode, "unsupported-not-relied-upon");
  assert.equal(verified.manifest.provenanceSha256, "2".repeat(64));
  assert.equal(verified.manifest.sbomSha256, "3".repeat(64));
});

test("signed launcher AppArmor identity must match the active release manifest", () => {
  const value = signed(release());
  const active = verifyS8ReleaseManifest(value, { "release-2026": publicPem }, now);
  const envelope = {
    capacity: { proof: { releaseManifestSha256: active.sha256 } },
    launcher: { observation: {
      jobAppArmorMode: "unsupported-not-relied-upon",
      rootlessKitHostAppArmorMode: "required-profile",
      rootlessKitHostAppArmorProfileName: "swooshz-s8-rootlesskit-v1",
      rootlessKitHostAppArmorProfileSha256: "1".repeat(64),
    } },
  } as unknown as S8AdmissionEnvelope;
  assert.doesNotThrow(() => assertS8ReleaseAdmissionBinding(envelope, active));
  for (const [field, wrong] of [
    ["jobAppArmorMode", "required-profile"],
    ["rootlessKitHostAppArmorMode", "unsupported"],
    ["rootlessKitHostAppArmorProfileName", "wrong-profile"],
    ["rootlessKitHostAppArmorProfileSha256", "9".repeat(64)],
  ] as const) {
    const drifted = structuredClone(envelope);
    (drifted.launcher.observation as Record<string, unknown>)[field] = wrong;
    assert.throws(() => assertS8ReleaseAdmissionBinding(drifted, active), /S8_RELEASE_MANIFEST_DRIFT/u);
  }
  const wrongManifest = structuredClone(envelope);
  wrongManifest.capacity.proof.releaseManifestSha256 = "9".repeat(64);
  assert.throws(() => assertS8ReleaseAdmissionBinding(wrongManifest, active), /S8_RELEASE_MANIFEST_DRIFT/u);
});

test("release schema v1 is rejected after the sandbox identity upgrade", () => {
  const old = release();
  (old as unknown as { schemaVersion: string }).schemaVersion = "s8-release-manifest-v1";
  assert.throws(() => verifyS8ReleaseManifest(signed(old), { "release-2026": publicPem }, now));
});

test("S8 release manifests reject signature, policy, AppArmor-mode, provenance, and expiry drift", () => {
  const value = signed(release());
  const changed = structuredClone(value);
  changed.manifest.writer.imageDigest = `sha256:${"9".repeat(64)}`;
  assert.throws(() => verifyS8ReleaseManifest(changed, { "release-2026": publicPem }, now));

  const wrongPolicy = release();
  wrongPolicy.resourcePolicySha256 = "4".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(signed(wrongPolicy), { "release-2026": publicPem }, now));

  const impossibleJobProfile = release();
  impossibleJobProfile.sandbox.jobAppArmorMode = "required-profile" as never;
  assert.throws(() => verifyS8ReleaseManifest(signed(impossibleJobProfile), { "release-2026": publicPem }, now));

  const malformedHostProfile = release();
  malformedHostProfile.sandbox.rootlessKitHostAppArmor.profileName = "unexpected-profile" as never;
  assert.throws(() => verifyS8ReleaseManifest(signed(malformedHostProfile), { "release-2026": publicPem }, now));

  const missingProvenance = release();
  missingProvenance.provenanceSha256 = "not-a-digest";
  assert.throws(() => verifyS8ReleaseManifest(signed(missingProvenance), { "release-2026": publicPem }, now));
  const missingSbom = release();
  missingSbom.sbomSha256 = "not-a-digest";
  assert.throws(() => verifyS8ReleaseManifest(signed(missingSbom), { "release-2026": publicPem }, now));
  const changedProvenance = signed(release());
  changedProvenance.manifest.provenanceSha256 = "9".repeat(64);
  assert.throws(() => verifyS8ReleaseManifest(changedProvenance, { "release-2026": publicPem }, now));

  const expired = release();
  expired.createdAt = new Date(now - 120_000).toISOString();
  expired.expiresAt = new Date(now - 1).toISOString();
  assert.throws(() => verifyS8ReleaseManifest(signed(expired), { "release-2026": publicPem }, now));
});
