import { AppError, type S5ToS6Projection, type S6SpatialModelRecord, type S6ToS7Handoff, type S6ValidationReceipt, type S6Dimensions, type S6GeometryPrimitive, type UUID } from "./types";
import { deriveS6Footprint, deriveS6WorldGeometry, hashS6Model, hashS6ValidationReceipt, normalizeS6Geometry, S6_HANDOFF_SCHEMA_VERSION, S6_OPEN_SIDE_ORDER, S6_SPATIAL_SCHEMA_VERSION } from "./s6-canonical";
import { cloneJson } from "./utils";

function reject(code: string): never {
  throw new AppError(409, code, [{ field: "handoff", code }]);
}

function boundsFor(primitive: S6GeometryPrimitive): S6Dimensions {
  const geometry = normalizeS6Geometry(primitive);
  if (geometry.kind === "rect_prism") return cloneJson(geometry.dimensionsMm);
  if (geometry.kind === "round_prism") {
    return { widthMm: geometry.radiusMm * 2, depthMm: geometry.radiusMm * 2, heightMm: geometry.heightMm };
  }
  const xs = geometry.profile.vertices.map((vertex) => vertex.xMm);
  const zs = geometry.profile.vertices.map((vertex) => vertex.zMm);
  return {
    widthMm: Math.max(...xs) - Math.min(...xs),
    depthMm: Math.max(...zs) - Math.min(...zs),
    heightMm: geometry.heightMm,
  };
}

function assertEligible(model: S6SpatialModelRecord, receipt: S6ValidationReceipt, source: S5ToS6Projection): void {
  if (source.readiness !== "ready" || model.projectId !== source.projectId) reject("S6_SOURCE_STALE");
  if (
    model.sourceS5Fingerprint !== source.sourceFingerprint ||
    model.sourceS5ApprovalEventId !== source.approvalEventId ||
    model.sourceS5ApprovalGeneration !== source.approvalGeneration
  ) reject("S6_SOURCE_STALE");
  const expectedOpenSides = S6_OPEN_SIDE_ORDER.filter((side) => source.geometrySnapshot.openSides.includes(side));
  if (
    model.booth.widthMm !== source.geometrySnapshot.widthMm ||
    model.booth.depthMm !== source.geometrySnapshot.depthMm ||
    JSON.stringify(model.booth.openSides) !== JSON.stringify(expectedOpenSides) ||
    model.booth.maxHeightMm !== source.geometrySnapshot.maxHeightMm ||
    (model.booth.maxHeightMm === null ? model.booth.heightState !== "unknown" : model.booth.heightState !== "known")
  ) {
    reject("S6_ACCEPTANCE_CONFLICT");
  }
  if (model.status !== "accepted_current") reject("S6_ACCEPTANCE_CONFLICT");
  if (
    receipt.projectId !== model.projectId ||
    model.validationReceiptId !== receipt.receiptId ||
    receipt.revisionId !== model.modelRevisionId ||
    receipt.revisionHash !== model.modelHash ||
    receipt.sourceS5Fingerprint !== source.sourceFingerprint ||
    (receipt.outcome !== "pass" && receipt.outcome !== "pass_with_warnings") ||
    receipt.errors.length > 0 ||
    hashS6ValidationReceipt(receipt) !== receipt.validationHash
  ) reject("S6_ACCEPTANCE_CONFLICT");
  if (
    model.designFormReview.status !== "complete" ||
    !model.designFormReview.acceptedByUser ||
    model.designFormReview.sourceS5Fingerprint !== source.sourceFingerprint ||
    model.designFormReview.evidenceAssetId !== source.activeAsset.assetId ||
    model.designFormReview.evidenceAssetSha256 !== source.activeAsset.sha256 ||
    model.designFormReview.unresolvedUnknownIds.length > 0 ||
    model.unknowns.some((item) => item.blocking && item.status === "unresolved") ||
    model.unknowns.some((item) => item.kind === "design_form" && item.status === "unresolved" && item.question.includes("S6_UNSUPPORTED_FORM"))
  ) {
    if (model.designFormReview.status === "unsupported" || model.unknowns.some((item) => item.kind === "design_form" && item.status === "unresolved" && item.question.includes("S6_UNSUPPORTED_FORM"))) {
      reject("S6_UNSUPPORTED_FORM");
    }
    reject("S6_DESIGN_FORM_UNREVIEWED");
  }
  if (hashS6Model(model).modelHash !== model.modelHash) reject("S6_ACCEPTANCE_CONFLICT");
  try {
    deriveS6WorldGeometry(model);
  } catch {
    reject("S6_ACCEPTANCE_CONFLICT");
  }
}

export function buildS6ToS7Handoff(
  model: S6SpatialModelRecord,
  receipt: S6ValidationReceipt,
  source: S5ToS6Projection,
): S6ToS7Handoff {
  assertEligible(model, receipt, source);
  if (receipt.outcome !== "pass" && receipt.outcome !== "pass_with_warnings") reject("S6_ACCEPTANCE_CONFLICT");
  const objects = model.objects.map((object) => ({
    objectId: object.objectId,
    identityKey: object.identityKey,
    parentObjectId: object.parentObjectId,
    objectType: object.objectType,
    role: object.role,
    geometry: normalizeS6Geometry(object.primitive),
    footprint: deriveS6Footprint(object.primitive),
    transform: cloneJson(object.transform),
    boundsMm: boundsFor(object.primitive),
    zoneIds: object.zoneIds.slice(),
    requirementIds: object.requirementIds.slice(),
    materialIds: object.materialIds.slice(),
    provenance: cloneJson(object.provenance),
    unknownIds: object.unknownIds.slice(),
  }));
  return {
    schemaVersion: S6_HANDOFF_SCHEMA_VERSION,
    projectId: model.projectId as UUID,
    acceptedRevisionId: model.modelRevisionId,
    acceptedRevisionHash: model.modelHash,
    sourceS5Fingerprint: source.sourceFingerprint,
    spatialSchemaVersion: S6_SPATIAL_SCHEMA_VERSION,
    units: "millimetres",
    coordinateConvention: cloneJson(model.booth.coordinateConvention),
    booth: {
      widthMm: model.booth.widthMm,
      depthMm: model.booth.depthMm,
      openSides: model.booth.openSides.slice(),
      maxHeightMm: model.booth.maxHeightMm,
      heightState: model.booth.heightState,
    },
    objects,
    hierarchy: model.objects.map((object) => ({ objectId: object.objectId, parentObjectId: object.parentObjectId })),
    zones: cloneJson(model.zones),
    requirements: cloneJson(source.canonicalRequirements),
    materials: cloneJson(model.materials),
    assumptions: cloneJson(model.assumptions),
    unknowns: cloneJson(model.unknowns),
    validationReceipt: {
      receiptId: receipt.receiptId,
      validationHash: receipt.validationHash,
      outcome: receipt.outcome,
    },
    eligibility: { currentAccepted: true, sourceCurrent: true, stale: false },
  };
}
