import {
  canonicalS6Json,
  hashS6Model,
  S6_RENDERER_VERSION,
} from "./s6-canonical";
import { sha256 } from "./utils";
import type {
  S6Camera,
  S6RenderedView,
  S6SpatialModelRecord,
  S6ValidationIssue,
  S6ViewPreservationReceipt,
  UUID,
} from "./types";

function deterministicUuid(seed: string): UUID {
  const hash = sha256(seed);
  return hash.slice(0, 8) + "-" + hash.slice(8, 12) + "-4" + hash.slice(13, 16) + "-8" + hash.slice(17, 20) + "-" + hash.slice(20, 32);
}

function fail(checks: S6ValidationIssue[], fieldPath: string): void {
  checks.push({ code: "VIEW_PRESERVATION_FAILED", severity: "error", fieldPath, objectId: null, requirementId: null, detail: "Structured view evidence does not preserve the accepted S6 scene." });
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalS6Json(left) === canonicalS6Json(right);
  } catch {
    return false;
  }
}

export function checkS6ViewPreservation(model: S6SpatialModelRecord, camera: S6Camera, rendered: S6RenderedView): S6ViewPreservationReceipt {
  const checks: S6ValidationIssue[] = [];
  const modelHash = hashS6Model(model).modelHash;
  const expectedObjectIds = model.objects.map((object) => object.objectId).sort();
  const actualObjectIds = rendered.sceneEvidence.objects.map((object) => object.objectId).sort();
  if (rendered.viewId !== camera.viewId || rendered.cameraHash !== camera.cameraHash || rendered.sceneEvidence.cameraHash !== camera.cameraHash) fail(checks, "cameraHash");
  if (rendered.sceneEvidence.rendererVersion !== S6_RENDERER_VERSION || rendered.sceneEvidence.externalResourceCount !== 0 || rendered.sceneEvidence.unsafeElementCount !== 0) fail(checks, "sceneEvidence.rendererVersion");
  if (rendered.sceneEvidence.modelHash !== modelHash || rendered.sceneEvidence.sourceS5Fingerprint !== model.sourceS5Fingerprint) fail(checks, "sceneEvidence.modelHash");
  if (rendered.sceneEvidence.booth.widthMm !== model.booth.widthMm || rendered.sceneEvidence.booth.depthMm !== model.booth.depthMm || !sameJson(rendered.sceneEvidence.booth.openSides, model.booth.openSides) || !sameJson(rendered.sceneEvidence.booth.coordinateConvention, model.booth.coordinateConvention)) fail(checks, "sceneEvidence.booth");
  if (!sameJson(actualObjectIds, expectedObjectIds)) fail(checks, "sceneEvidence.objects.objectId");
  for (const object of model.objects) {
    const evidence = rendered.sceneEvidence.objects.find((item) => item.objectId === object.objectId);
    if (!evidence || evidence.objectType !== object.objectType || evidence.geometryKind !== object.primitive.kind || !sameJson(evidence.geometry, object.primitive) || !sameJson(evidence.materialIds, object.materialIds.slice().sort()) || !evidence.visible) {
      fail(checks, "sceneEvidence.objects[" + object.objectId + "]");
    }
  }
  if (!sameJson(rendered.sceneEvidence.overheadObjectIds, model.objects.filter((object) => object.objectType === "overhead_volume").map((object) => object.objectId).sort())) fail(checks, "sceneEvidence.overheadObjectIds");
  if (!sameJson(rendered.sceneEvidence.materialIds, Array.from(new Set(model.objects.flatMap((object) => object.materialIds))).sort())) fail(checks, "sceneEvidence.materialIds");
  if (rendered.sceneHash !== sha256(canonicalS6Json(rendered.sceneEvidence))) fail(checks, "sceneHash");
  if (model.status === "accepted_current" && (model.designFormReview.status !== "complete" || !model.designFormReview.acceptedByUser || model.designFormReview.unresolvedUnknownIds.length > 0)) fail(checks, "designFormReview");
  const hardInvariant = sha256(canonicalS6Json({
    modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    cameraHash: camera.cameraHash,
    objectIds: expectedObjectIds,
    overheadObjectIds: model.objects.filter((object) => object.objectType === "overhead_volume").map((object) => object.objectId).sort(),
    materialIds: Array.from(new Set(model.objects.flatMap((object) => object.materialIds))).sort(),
  }));
  const receipt: S6ViewPreservationReceipt = {
    schemaVersion: "s6-view-preservation-v1",
    receiptId: deterministicUuid("s6-preservation|" + model.modelRevisionId + "|" + camera.viewId + "|" + rendered.sceneHash),
    projectId: model.projectId,
    revisionId: model.modelRevisionId,
    revisionHash: modelHash,
    sourceS5Fingerprint: model.sourceS5Fingerprint,
    viewId: camera.viewId,
    rendererVersion: S6_RENDERER_VERSION,
    cameraHash: camera.cameraHash,
    sceneHash: rendered.sceneHash,
    outcome: checks.length === 0 ? "pass" : "fail",
    hardInvariantHash: hardInvariant,
    objectIds: expectedObjectIds,
    overheadObjectIds: model.objects.filter((object) => object.objectType === "overhead_volume").map((object) => object.objectId).sort(),
    materialIds: Array.from(new Set(model.objects.flatMap((object) => object.materialIds))).sort(),
    checks,
    checkedAt: new Date(0).toISOString(),
    receiptHash: "",
  };
  receipt.receiptHash = sha256(canonicalS6Json(receipt));
  return receipt;
}

