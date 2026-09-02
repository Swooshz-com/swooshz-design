import { Buffer } from "node:buffer";
import { canonicalS6Json, hashS6Model, S6_RENDERER_VERSION } from "./s6-canonical";
import { PrivateObjectStore } from "./store";
import { sha256, privateStorageKey } from "./utils";
import type {
  S6SpatialModelRecord,
  S6ViewArtifact,
  S6ViewId,
  S6ViewSummary,
} from "./types";

export type S6ModelStorageKeys = {
  artifactKey: string;
  stagingKey: string;
};

export type S6ViewStorageKeys = {
  artifactKey: string;
  stagingKey: string;
};

export function s6ModelStorageKeys(
  projectId: string,
  revisionId: string,
  jobId: string,
  claimToken: string,
): S6ModelStorageKeys {
  return {
    artifactKey: privateStorageKey("projects", projectId, "s6", "revisions", revisionId, "model.json"),
    stagingKey: privateStorageKey("projects", projectId, "s6", "staging", jobId, claimToken, "model.json"),
  };
}

export function s6ViewFileName(viewId: S6ViewId): S6ViewArtifact["fileName"] {
  switch (viewId) {
    case "perspective-northwest":
      return "swooshz-spatial-perspective-northwest.svg";
    case "perspective-southeast":
      return "swooshz-spatial-perspective-southeast.svg";
    case "top-orthographic":
      return "swooshz-spatial-top-orthographic.svg";
  }
}

export function s6ViewStorageKeys(
  projectId: string,
  revisionId: string,
  viewId: S6ViewId,
  jobId: string,
  claimToken: string,
): S6ViewStorageKeys {
  return {
    artifactKey: privateStorageKey(
      "projects",
      projectId,
      "s6",
      "revisions",
      revisionId,
      "views",
      viewId,
      S6_RENDERER_VERSION + ".svg",
    ),
    stagingKey: privateStorageKey(
      "projects",
      projectId,
      "s6",
      "staging",
      jobId,
      claimToken,
      viewId + ".svg",
    ),
  };
}

export function canonicalS6ModelBytes(model: S6SpatialModelRecord): Buffer {
  const hashed = hashS6Model(model);
  const bytes = Buffer.from(new TextEncoder().encode(hashed.canonicalJson));
  if (sha256(bytes) !== hashed.modelHash || bytes.byteLength !== hashed.canonicalByteSize) {
    throw new Error("S6_MODEL_HASH_MISMATCH");
  }
  return bytes;
}

export function putS6Exact(
  objects: PrivateObjectStore,
  key: string,
  bytes: Uint8Array,
): { sha256: string; byteSize: number } {
  objects.putExact(key, bytes);
  return { sha256: sha256(bytes), byteSize: bytes.byteLength };
}

export function promoteS6Exact(
  objects: PrivateObjectStore,
  stagingKey: string,
  artifactKey: string,
  bytes: Uint8Array,
): { sha256: string; byteSize: number } {
  objects.promoteExact(stagingKey, artifactKey, bytes);
  const finalBytes = objects.read(artifactKey);
  const outputSha256 = sha256(finalBytes);
  if (outputSha256 !== sha256(bytes) || finalBytes.byteLength !== bytes.byteLength) {
    throw new Error("S6_PUBLICATION_FAILED");
  }
  return { sha256: outputSha256, byteSize: finalBytes.byteLength };
}

export function readS6CommittedExact(
  objects: PrivateObjectStore,
  artifact: Pick<S6ViewArtifact, "artifactKey" | "outputSha256" | "outputByteSize" | "status" | "publicationPhase">,
): Buffer {
  if (artifact.status !== "committed" || artifact.publicationPhase !== "committed" || artifact.outputSha256 === null || artifact.outputByteSize === null) {
    throw new Error("S6_STALE_ARTIFACT");
  }
  const bytes = objects.read(artifact.artifactKey);
  if (sha256(bytes) !== artifact.outputSha256 || bytes.byteLength !== artifact.outputByteSize) {
    throw new Error("S6_STALE_ARTIFACT");
  }
  return bytes;
}

export function s6ViewSummary(
  artifact: S6ViewArtifact,
  preservationOutcome: S6ViewSummary["preservationOutcome"],
): S6ViewSummary {
  return {
    viewId: artifact.viewId,
    revisionId: artifact.revisionId,
    revisionHash: artifact.revisionHash,
    purpose: artifact.purpose,
    status: artifact.status,
    rendererVersion: artifact.rendererVersion,
    preservationOutcome,
    outputSha256: artifact.outputSha256,
    outputByteSize: artifact.outputByteSize,
  };
}

export function canonicalS6JsonBytes(value: unknown): Buffer {
  return Buffer.from(new TextEncoder().encode(canonicalS6Json(value)));
}
