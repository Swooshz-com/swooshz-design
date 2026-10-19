import { buildS6Cameras } from "./s6-camera";
import { canonicalS6Json, hashS6Model, normalizeS6Geometry } from "./s6-canonical";
import { renderS6View } from "./s6-renderer";
import { sha256 } from "./utils";
import type { S6SpatialModelRecord, S6ToS7Handoff, S6ViewId, Sha256, UUID } from "./types";

export type S9GroundingControl = {
  schemaVersion: "s9-grounding-control-v1";
  sourceRevisionId: UUID;
  sourceRevisionHash: Sha256;
  sourceS5Fingerprint: Sha256;
  s7ValidationHash: Sha256;
  viewId: S6ViewId;
  cameraHash: Sha256;
  sceneHash: Sha256;
  controlSvgSha256: Sha256;
  controlSvgBytes: Uint8Array;
  objectIds: string[];
  groundingHash: Sha256;
};

function reject(code: string): never {
  throw new Error(code);
}

function sourceIsCurrent(model: S6SpatialModelRecord, handoff: S6ToS7Handoff): void {
  if (model.status !== "accepted_current" || handoff.schemaVersion !== "s6-to-s7-handoff-v1") reject("S9_SOURCE_STALE");
  if (!handoff.eligibility.currentAccepted || !handoff.eligibility.sourceCurrent || handoff.eligibility.stale) reject("S9_SOURCE_STALE");
  if (handoff.projectId !== model.projectId || handoff.acceptedRevisionId !== model.modelRevisionId) reject("S9_SOURCE_STALE");
  if (handoff.acceptedRevisionHash !== model.modelHash || hashS6Model(model).modelHash !== model.modelHash) reject("S9_SOURCE_STALE");
  if (handoff.sourceS5Fingerprint !== model.sourceS5Fingerprint) reject("S9_SOURCE_STALE");
  if (handoff.booth.widthMm !== model.booth.widthMm || handoff.booth.depthMm !== model.booth.depthMm ||
      handoff.booth.maxHeightMm !== model.booth.maxHeightMm ||
      canonicalS6Json(handoff.booth.openSides) !== canonicalS6Json(model.booth.openSides)) reject("S9_SOURCE_STALE");
  if (handoff.objects.length !== model.objects.length || handoff.objects.some((object, index) => {
    const current = model.objects[index];
    return !current || object.objectId !== current.objectId || object.parentObjectId !== current.parentObjectId ||
      object.objectType !== current.objectType || object.role !== current.role ||
      canonicalS6Json(object.geometry) !== canonicalS6Json(normalizeS6Geometry(current.primitive)) ||
      canonicalS6Json(object.transform) !== canonicalS6Json(current.transform) ||
      canonicalS6Json(object.materialIds) !== canonicalS6Json(current.materialIds);
  })) reject("S9_SOURCE_STALE");
}

export function prepareS9Grounding(
  model: S6SpatialModelRecord,
  handoff: S6ToS7Handoff,
  viewId: S6ViewId,
): S9GroundingControl {
  sourceIsCurrent(model, handoff);
  const camera = buildS6Cameras(model).find((item) => item.viewId === viewId);
  const storedCamera = model.cameras.find((item) => item.viewId === viewId);
  if (!camera || !storedCamera || canonicalS6Json(camera) !== canonicalS6Json(storedCamera)) reject("S9_CAMERA_STALE");
  const rendered = renderS6View(model, camera);
  if (rendered.sceneEvidence.modelHash !== model.modelHash || rendered.sceneEvidence.cameraHash !== camera.cameraHash ||
      rendered.sceneEvidence.sourceS5Fingerprint !== model.sourceS5Fingerprint ||
      rendered.sceneEvidence.externalResourceCount !== 0 || rendered.sceneEvidence.unsafeElementCount !== 0) {
    reject("S9_CONTROL_INTEGRITY");
  }
  const identity = {
    schemaVersion: "s9-grounding-control-v1" as const,
    sourceRevisionId: model.modelRevisionId,
    sourceRevisionHash: model.modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    s7ValidationHash: handoff.validationReceipt.validationHash,
    viewId,
    cameraHash: camera.cameraHash,
    sceneHash: rendered.sceneHash,
    controlSvgSha256: rendered.outputSha256,
    objectIds: model.objects.map((object) => object.objectId).sort(),
  };
  return { ...identity, controlSvgBytes: rendered.svgBytes, groundingHash: sha256(canonicalS6Json(identity)) };
}

export function assertS9GroundingCurrent(
  previous: S9GroundingControl,
  currentModel: S6SpatialModelRecord,
  currentHandoff: S6ToS7Handoff,
): void {
  const current = prepareS9Grounding(currentModel, currentHandoff, previous.viewId);
  const { controlSvgBytes: _controlSvgBytes, groundingHash: _groundingHash, ...previousIdentity } = previous;
  if (previous.schemaVersion !== "s9-grounding-control-v1" ||
      previous.groundingHash !== sha256(canonicalS6Json(previousIdentity)) ||
      previous.groundingHash !== current.groundingHash ||
      previous.controlSvgSha256 !== sha256(previous.controlSvgBytes) ||
      previous.controlSvgSha256 !== current.controlSvgSha256) reject("S9_SOURCE_STALE");
}
