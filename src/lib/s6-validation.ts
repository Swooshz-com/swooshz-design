import {
  canonicalS6Json,
  containsS6WorldBooth,
  containsS6WorldGeometry,
  deriveS6WorldGeometry,
  hashS6Model,
  normalizeS6Geometry,
  normalizeS6Rotation,
  overlapsS6WorldGeometry,
  S6_MAX_ASSUMPTIONS,
  S6_MAX_CAMERAS,
  S6_MAX_COORDINATE_MM,
  S6_MAX_MATERIALS,
  S6_MAX_MODEL_BYTES,
  S6_MAX_OBJECTS,
  S6_MAX_PROVENANCE_ENTRIES,
  S6_MAX_UNKNOWNS,
  S6_MAX_ZONES,
  S6_OPEN_SIDE_ORDER,
  S6_SPATIAL_SCHEMA_VERSION,
  S6_VALIDATION_ORDER_VERSION,
  S6_VALIDATOR_VERSION,
} from "./s6-canonical";
import { buildS6Cameras, hashS6Camera } from "./s6-camera";
import { sha256 } from "./utils";
import type {
  OpenSide,
  S5ToS6Projection,
  S6GeometryPrimitive,
  S6SpatialModelRecord,
  S6SpatialObject,
  S6ValidationIssue,
  S6ValidationReceipt,
  Sha256,
  UUID,
} from "./types";

export type S6ValidationContext = {
  source: S5ToS6Projection;
  priorModels: readonly S6SpatialModelRecord[];
  expectedSourceFingerprint: Sha256;
};

type IssueBag = {
  errors: S6ValidationIssue[];
  warnings: S6ValidationIssue[];
};

function issue(
  bag: IssueBag,
  code: string,
  fieldPath: string,
  objectId: string | null = null,
  requirementId: string | null = null,
  severity: "error" | "warning" = "error",
): void {
  const value: S6ValidationIssue = { code, severity, fieldPath, objectId, requirementId, detail: "S6 validation failed for the referenced field." };
  (severity === "warning" ? bag.warnings : bag.errors).push(value);
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}

function finiteCoordinate(value: unknown): boolean {
  return integer(value, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function objectById(model: S6SpatialModelRecord): Map<string, S6SpatialObject> {
  return new Map(model.objects.map((item) => [item.objectId, item]));
}

function geometryHeight(primitive: S6GeometryPrimitive): number {
  return primitive.kind === "rect_prism" ? primitive.dimensionsMm.heightMm : primitive.heightMm;
}

function geometryAllowed(object: S6SpatialObject): boolean {
  const kind = object.primitive.kind;
  const allowed: Record<string, readonly string[]> = {
    floor_footprint: ["rect_prism"],
    wall: ["rect_prism", "profile_extrusion"],
    partition: ["rect_prism", "profile_extrusion"],
    box: ["rect_prism", "round_prism", "profile_extrusion"],
    counter: ["rect_prism", "round_prism", "profile_extrusion"],
    display_plinth: ["rect_prism", "round_prism", "profile_extrusion"],
    screen: ["rect_prism", "profile_extrusion"],
    storage_volume: ["rect_prism", "profile_extrusion"],
    table: ["rect_prism", "round_prism"],
    seating_marker: ["rect_prism", "round_prism"],
    equipment_placeholder: ["rect_prism", "round_prism", "profile_extrusion"],
    overhead_volume: ["rect_prism", "round_prism", "profile_extrusion"],
    zone_region: ["rect_prism", "profile_extrusion"],
  };
  return (allowed[object.objectType] ?? []).includes(kind);
}

function materialIdsValid(model: S6SpatialModelRecord): boolean {
  const ids = new Set(model.materials.map((item) => item.materialId));
  return model.objects.every((object) => object.materialIds.every((id) => ids.has(id)));
}

function currentSourceReady(source: S5ToS6Projection): boolean {
  return source.readiness === "ready" && source.layoutArtifacts.planJson.status === "committed" &&
    source.layoutArtifacts.planSvg.status === "committed" && source.presentationArtifact.status === "committed";
}

const MODEL_KEYS = [
  "schemaVersion", "modelRevisionId", "projectId", "parentRevisionId", "parentRevisionHash", "revisionNumber",
  "sourceS5Fingerprint", "sourceS5ApprovalEventId", "sourceS5ApprovalGeneration", "status", "booth", "objects",
  "zones", "materials", "cameras", "provenance", "assumptions", "unknowns", "designFormReview", "modelHash",
  "canonicalByteSize", "modelArtifact", "validationReceiptId", "acceptanceEventId", "createdBy", "createdAt",
  "updatedAt", "acceptedAt", "supersededAt", "staleAt",
] as const;

function profileIssueCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("S6_PROFILE_SELF_INTERSECTION")) return "S6_PROFILE_SELF_INTERSECTION";
  if (message.startsWith("S6_PROFILE_TOO_COMPLEX")) return "S6_PROFILE_TOO_COMPLEX";
  if (message.startsWith("S6_PROFILE_INVALID")) return "S6_PROFILE_INVALID";
  if (message.startsWith("ROUND_GEOMETRY_INVALID")) return "ROUND_GEOMETRY_INVALID";
  if (message.startsWith("NUMERIC_OUT_OF_BOUNDS")) return "NUMERIC_OUT_OF_BOUNDS";
  if (message.startsWith("CANONICAL_NUMBER_INVALID")) return "CANONICAL_NUMBER_INVALID";
  return "SPATIAL_SCHEMA_INVALID";
}

function validateSource(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  if (!currentSourceReady(context.source)) issue(bag, "SOURCE_NOT_READY", "source.readiness");
  if (context.expectedSourceFingerprint !== context.source.sourceFingerprint || model.sourceS5Fingerprint !== context.source.sourceFingerprint) {
    issue(bag, "SOURCE_STALE", "sourceS5Fingerprint");
  }
  if (model.projectId !== context.source.projectId || model.sourceS5ApprovalEventId !== context.source.approvalEventId || model.sourceS5ApprovalGeneration !== context.source.approvalGeneration) {
    issue(bag, "SOURCE_STALE", "sourceIdentity");
  }
}

function validateSchema(model: S6SpatialModelRecord, bag: IssueBag): void {
  if (!exactKeys(model, MODEL_KEYS)) issue(bag, "SPATIAL_SCHEMA_INVALID", "model");
  if (model.schemaVersion !== S6_SPATIAL_SCHEMA_VERSION) issue(bag, "SPATIAL_SCHEMA_INVALID", "schemaVersion");
  const counts: Array<[number, number, string]> = [
    [model.objects.length, S6_MAX_OBJECTS, "objects"],
    [model.zones.length, S6_MAX_ZONES, "zones"],
    [model.materials.length, S6_MAX_MATERIALS, "materials"],
    [model.unknowns.length, S6_MAX_UNKNOWNS, "unknowns"],
    [model.assumptions.length, S6_MAX_ASSUMPTIONS, "assumptions"],
    [model.provenance.length, S6_MAX_PROVENANCE_ENTRIES, "provenance"],
    [model.cameras.length, S6_MAX_CAMERAS, "cameras"],
  ];
  for (const [actual, maximum, fieldPath] of counts) if (!Number.isSafeInteger(actual) || actual > maximum) issue(bag, "SPATIAL_SCHEMA_INVALID", fieldPath);
  try {
    const hashed = hashS6Model(model);
    if (hashed.canonicalByteSize > S6_MAX_MODEL_BYTES) issue(bag, "PAYLOAD_TOO_LARGE", "canonicalByteSize");
  } catch {
    issue(bag, "SPATIAL_SCHEMA_INVALID", "model");
  }
}

function validateNumeric(model: S6SpatialModelRecord, bag: IssueBag): void {
  const fields: Array<[unknown, string]> = [
    [model.revisionNumber, "revisionNumber"],
    [model.sourceS5ApprovalGeneration, "sourceS5ApprovalGeneration"],
    [model.canonicalByteSize, "canonicalByteSize"],
  ];
  for (const [value, fieldPath] of fields) if (!integer(value, 0, Number.MAX_SAFE_INTEGER)) issue(bag, "CANONICAL_NUMBER_INVALID", fieldPath);
  for (const object of model.objects) {
    for (const [value, fieldPath] of [
      [object.transform.positionMm.xMm, "objects[" + object.objectId + "].transform.positionMm.xMm"],
      [object.transform.positionMm.yMm, "objects[" + object.objectId + "].transform.positionMm.yMm"],
      [object.transform.positionMm.zMm, "objects[" + object.objectId + "].transform.positionMm.zMm"],
      [object.transform.rotationMd.xMd, "objects[" + object.objectId + "].transform.rotationMd.xMd"],
      [object.transform.rotationMd.yMd, "objects[" + object.objectId + "].transform.rotationMd.yMd"],
      [object.transform.rotationMd.zMd, "objects[" + object.objectId + "].transform.rotationMd.zMd"],
    ] as Array<[unknown, string]>) {
      if (!finiteCoordinate(value)) issue(bag, "CANONICAL_NUMBER_INVALID", fieldPath, object.objectId);
    }
    if (finiteCoordinate(object.transform.rotationMd.xMd) && finiteCoordinate(object.transform.rotationMd.yMd) && finiteCoordinate(object.transform.rotationMd.zMd)) {
      try {
        const normalized = normalizeS6Rotation(object.transform.rotationMd);
        if (normalized.xMd !== object.transform.rotationMd.xMd || normalized.yMd !== object.transform.rotationMd.yMd || normalized.zMd !== object.transform.rotationMd.zMd) issue(bag, "TRANSFORM_INVALID", "objects[" + object.objectId + "].transform.rotationMd", object.objectId);
      } catch {
        issue(bag, "TRANSFORM_INVALID", "objects[" + object.objectId + "].transform", object.objectId);
      }
    }
    try {
      const normalized = normalizeS6Geometry(object.primitive);
      if (object.primitive.kind === "profile_extrusion" && normalized.kind === "profile_extrusion" && JSON.stringify(normalized.profile) !== JSON.stringify(object.primitive.profile)) {
        issue(bag, "S6_PROFILE_INVALID", "objects[" + object.objectId + "].primitive.profile", object.objectId);
      }
    } catch (error) {
      const code = object.primitive.kind === "profile_extrusion" && profileIssueCode(error) === "NUMERIC_OUT_OF_BOUNDS" ? "S6_PROFILE_INVALID" : profileIssueCode(error);
      issue(bag, code, "objects[" + object.objectId + "].primitive", object.objectId);
    }
  }
}

function validateBooth(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  if (!integer(model.booth.widthMm, 1, S6_MAX_COORDINATE_MM) || !integer(model.booth.depthMm, 1, S6_MAX_COORDINATE_MM)) issue(bag, "BOOTH_ENVELOPE_INVALID", "booth");
  if (model.booth.widthMm !== context.source.geometrySnapshot.widthMm || model.booth.depthMm !== context.source.geometrySnapshot.depthMm) {
    issue(bag, "BOOTH_ENVELOPE_INVALID", "booth");
  }
  const openSides = model.booth.openSides;
  if (!Array.isArray(openSides) || new Set(openSides).size !== openSides.length || openSides.some((side) => !S6_OPEN_SIDE_ORDER.includes(side as OpenSide))) issue(bag, "BOOTH_ENVELOPE_INVALID", "booth.openSides");
  const expected = S6_OPEN_SIDE_ORDER.filter((side) => context.source.geometrySnapshot.openSides.includes(side));
  if (JSON.stringify(openSides) !== JSON.stringify(expected)) issue(bag, "OPEN_SIDE_INTEGRITY", "booth.openSides");
  if (model.booth.maxHeightMm !== context.source.geometrySnapshot.maxHeightMm || (model.booth.maxHeightMm === null ? model.booth.heightState !== "unknown" : model.booth.heightState !== "known")) {
    issue(bag, "BOOTH_ENVELOPE_INVALID", "booth.heightState");
  }
  const floor = model.objects.find((item) => item.role === "booth_floor");
  if (floor?.primitive.kind !== "rect_prism" ||
      floor.primitive.dimensionsMm.widthMm !== model.booth.widthMm ||
      floor.primitive.dimensionsMm.depthMm !== model.booth.depthMm) {
    issue(bag, "BOOTH_ENVELOPE_INVALID", "objects.booth-floor.primitive.dimensionsMm");
  }
  const convention = model.booth.coordinateConvention;
  if (convention.version !== "booth-local-right-handed-v1" || convention.units !== "millimetres" || convention.handedness !== "right-handed" || convention.origin !== "north-west-floor-corner" || convention.xAxis !== "east" || convention.yAxis !== "up" || convention.zAxis !== "south") {
    issue(bag, "BOOTH_ENVELOPE_INVALID", "booth.coordinateConvention");
  }
}

function validateHierarchy(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  const ids = new Set<string>();
  const identities = new Map<string, string>();
  const previous = context.priorModels.flatMap((item) => item.objects);
  const priorLatest = context.priorModels.at(-1);
  for (const object of model.objects) {
    if (ids.has(object.objectId)) issue(bag, "OBJECT_ID_DUPLICATE", "objects.objectId", object.objectId);
    ids.add(object.objectId);
    const old = identities.get(object.objectId);
    if (old !== undefined && old !== object.identityKey) issue(bag, "OBJECT_ID_REUSED", "objects.identityKey", object.objectId);
    identities.set(object.objectId, object.identityKey);
    const historical = previous.find((item) => item.objectId === object.objectId);
    if (historical && historical.identityKey !== object.identityKey) issue(bag, "OBJECT_ID_REUSED", "objects.identityKey", object.objectId);
    if (historical && priorLatest && !priorLatest.objects.some((item) => item.objectId === object.objectId)) issue(bag, "OBJECT_ID_REUSED", "objects.objectId", object.objectId);
  }
  const byId = objectById(model);
  for (const object of model.objects) if (object.parentObjectId !== null && !byId.has(object.parentObjectId)) issue(bag, "HIERARCHY_DANGLING_PARENT", "objects[" + object.objectId + "].parentObjectId", object.objectId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (objectId: string): void => {
    if (visiting.has(objectId)) {
      issue(bag, "HIERARCHY_CYCLE", "objects[" + objectId + "].parentObjectId", objectId);
      return;
    }
    if (visited.has(objectId)) return;
    visiting.add(objectId);
    const parent = byId.get(objectId)?.parentObjectId;
    if (parent && byId.has(parent)) visit(parent);
    visiting.delete(objectId);
    visited.add(objectId);
  };
  for (const object of model.objects) visit(object.objectId);
}

function validateSemantics(model: S6SpatialModelRecord, bag: IssueBag): void {
  for (const object of model.objects) {
    if (!geometryAllowed(object)) issue(bag, "SPATIAL_SCHEMA_INVALID", "objects[" + object.objectId + "].primitive.kind", object.objectId);
    if (object.role === "booth_floor") {
      if (object.objectType !== "floor_footprint" || object.editable || object.removable || object.parentObjectId !== null) issue(bag, "SPATIAL_SCHEMA_INVALID", "objects[" + object.objectId + "]", object.objectId);
      if (object.primitive.kind !== "rect_prism" || object.primitive.geometryState !== "exact" || object.primitive.localAnchor !== "floor" || object.transform.positionMm.xMm !== 0 || object.transform.positionMm.yMm !== 0 || object.transform.positionMm.zMm !== 0 || object.transform.rotationMd.xMd !== 0 || object.transform.rotationMd.yMd !== 0 || object.transform.rotationMd.zMd !== 0) issue(bag, "SPATIAL_SCHEMA_INVALID", "objects[" + object.objectId + "]", object.objectId);
    }
    if (!Array.isArray(object.materialIds) || !Array.isArray(object.zoneIds) || !Array.isArray(object.requirementIds) || !Array.isArray(object.unknownIds)) issue(bag, "SPATIAL_SCHEMA_INVALID", "objects[" + object.objectId + "]", object.objectId);
    if (object.primitive.kind === "rect_prism" && (!integer(object.primitive.dimensionsMm.widthMm, 1, S6_MAX_COORDINATE_MM) || !integer(object.primitive.dimensionsMm.depthMm, 1, S6_MAX_COORDINATE_MM) || !integer(object.primitive.dimensionsMm.heightMm, 1, S6_MAX_COORDINATE_MM))) issue(bag, "DIMENSIONS_INVALID", "objects[" + object.objectId + "]", object.objectId);
    if (object.primitive.kind === "round_prism" && (!integer(object.primitive.radiusMm, 100, 50_000) || !integer(object.primitive.heightMm, 1, S6_MAX_COORDINATE_MM))) issue(bag, "ROUND_GEOMETRY_INVALID", "objects[" + object.objectId + "]", object.objectId);
    if (geometryHeight(object.primitive) < 1) issue(bag, "DIMENSIONS_INVALID", "objects[" + object.objectId + "].primitive.heightMm", object.objectId);
  }
  if (!materialIdsValid(model)) issue(bag, "SPATIAL_SCHEMA_INVALID", "materials");
  for (const material of model.materials) {
    if (!exactKeys(material, ["materialId", "label", "finishKind", "colorHex", "source", "sourceAssetId", "sourceAssetSha256", "notes", "provenance"])) issue(bag, "SPATIAL_SCHEMA_INVALID", "materials");
    if (material.colorHex !== null && (typeof material.colorHex !== "string" || !/^#[0-9a-f]{6}$/iu.test(material.colorHex))) issue(bag, "SPATIAL_SCHEMA_INVALID", "materials.colorHex");
    if (/[<>]|(?:https?:|data:|javascript:)/iu.test(JSON.stringify(material))) issue(bag, "SPATIAL_SCHEMA_INVALID", "materials");
  }
}

function validateRequirements(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  const requirements = new Map(context.source.canonicalRequirements.map((item) => [item.requirementId, item]));
  const counts = new Map<string, number>();
  for (const object of model.objects) {
    for (const requirementId of object.requirementIds) {
      if (!requirements.has(requirementId)) issue(bag, "REQUIREMENT_MAPPING_INVALID", "objects[" + object.objectId + "].requirementIds", object.objectId, requirementId);
      counts.set(requirementId, (counts.get(requirementId) ?? 0) + 1);
    }
  }
  for (const requirement of context.source.canonicalRequirements) {
    const count = counts.get(requirement.requirementId) ?? 0;
    const expected = requirement.expected === "absent" ? 0 : requirement.expected === "exact_count" ? requirement.expectedCount ?? 0 : 1;
    if (count !== expected) issue(bag, "REQUIRED_COUNT_MISMATCH", "requirements." + requirement.requirementId, null, requirement.requirementId);
    if (requirement.expected !== "absent" && count === 0) issue(bag, "REQUIREMENT_MAPPING_INVALID", "requirements." + requirement.requirementId, null, requirement.requirementId);
  }
}

function validateContainment(model: S6SpatialModelRecord, bag: IssueBag): void {
  let world: Map<string, ReturnType<typeof deriveS6WorldGeometry>[number]>;
  try {
    world = new Map(deriveS6WorldGeometry(model).map((item) => [item.objectId, item]));
  } catch {
    issue(bag, "TRANSFORM_INVALID", "objects");
    return;
  }
  const byId = objectById(model);
  for (const object of model.objects) {
    const shape = world.get(object.objectId);
    if (!shape) {
      issue(bag, "TRANSFORM_INVALID", "objects[" + object.objectId + "].transform", object.objectId);
      continue;
    }
    if (!containsS6WorldBooth(shape, model.booth.widthMm, model.booth.depthMm)) issue(bag, "CONTAINMENT_INVALID", "objects[" + object.objectId + "].transform", object.objectId);
    if (object.parentObjectId) {
      const parent = byId.get(object.parentObjectId);
      const parentShape = parent ? world.get(parent.objectId) : undefined;
      if (parentShape && !containsS6WorldGeometry(parentShape, shape)) issue(bag, "CONTAINMENT_INVALID", "objects[" + object.objectId + "].parentObjectId", object.objectId);
    }
    const interval = shape.verticalInterval;
    if (interval.base < 0) issue(bag, "CONTAINMENT_INVALID", "objects[" + object.objectId + "].transform.positionMm.yMm", object.objectId);
    if (model.booth.maxHeightMm !== null && interval.top > model.booth.maxHeightMm) issue(bag, "MAX_HEIGHT_EXCEEDED", "objects[" + object.objectId + "].primitive.heightMm", object.objectId);
  }
  const wallSides = new Set(model.objects.filter((item) => item.role === "booth_wall").map((item) => item.identityKey.replace("booth-wall:", "")));
  for (const side of S6_OPEN_SIDE_ORDER) {
    const present = wallSides.has(side);
    if (model.booth.openSides.includes(side) ? present : !present) issue(bag, "OPEN_SIDE_INTEGRITY", "objects.booth-wall." + side);
  }
}

function validateCollisions(model: S6SpatialModelRecord, bag: IssueBag): void {
  const physical = model.objects.filter((item) => item.role !== "booth_floor" && item.role !== "zone" && item.role !== "booth_wall");
  let world: Map<string, ReturnType<typeof deriveS6WorldGeometry>[number]>;
  try {
    world = new Map(deriveS6WorldGeometry(model).map((item) => [item.objectId, item]));
  } catch {
    issue(bag, "TRANSFORM_INVALID", "objects");
    return;
  }
  for (let leftIndex = 0; leftIndex < physical.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < physical.length; rightIndex += 1) {
      const left = physical[leftIndex]!;
      const right = physical[rightIndex]!;
      const leftGeometry = world.get(left.objectId);
      const rightGeometry = world.get(right.objectId);
      if (!leftGeometry || !rightGeometry) continue;
      const leftY = leftGeometry.verticalInterval;
      const rightY = rightGeometry.verticalInterval;
      const vertical = Math.min(leftY.top, rightY.top) - Math.max(leftY.base, rightY.base) > 0;
      if (vertical && overlapsS6WorldGeometry(leftGeometry, rightGeometry)) {
        issue(bag, "MATERIAL_COLLISION", "objects[" + right.objectId + "]", right.objectId);
      }
    }
  }
}

function validateDesignForm(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  const review = model.designFormReview;
  if (review.sourceS5Fingerprint !== context.source.sourceFingerprint || review.evidenceAssetId !== context.source.activeAsset.assetId || review.evidenceAssetSha256 !== context.source.activeAsset.sha256) {
    issue(bag, "S6_DESIGN_FORM_UNREVIEWED", "designFormReview");
  }
  const unresolvedDesign = model.unknowns.filter((item) => item.kind === "design_form" && item.status === "unresolved").map((item) => item.unknownId).sort();
  const listed = review.unresolvedUnknownIds.slice().sort();
  if (JSON.stringify(unresolvedDesign) !== JSON.stringify(listed) || review.status !== "complete" || !review.acceptedByUser || listed.length > 0) issue(bag, "S6_DESIGN_FORM_UNREVIEWED", "designFormReview");
  const unsupportedUnresolved = model.unknowns.some((item) => item.kind === "design_form" && item.status === "unresolved" && item.question.includes("S6_UNSUPPORTED_FORM"));
  if (review.status === "unsupported" || unsupportedUnresolved) issue(bag, "S6_UNSUPPORTED_FORM", "unknowns");
  for (const unknown of model.unknowns) {
    if (unknown.status === "unresolved" && (unknown.kind === "geometry" || unknown.kind === "design_form")) issue(bag, "GEOMETRY_UNRESOLVED", "unknowns[" + unknown.unknownId + "]", null, unknown.requirementId);
    if (unknown.status === "resolved" && unknown.resolutionKind === "explicit_simplification") {
      issue(bag, "S6_DESIGN_FORM_SIMPLIFIED", "unknowns[" + unknown.unknownId + "]", null, unknown.requirementId, "warning");
    }
  }
  for (const unknownId of review.explicitSimplificationUnknownIds) {
    const unknown = model.unknowns.find((item) => item.unknownId === unknownId);
    if (!unknown || unknown.resolutionKind !== "explicit_simplification" || unknown.status !== "resolved") issue(bag, "S6_DESIGN_FORM_UNREVIEWED", "designFormReview.explicitSimplificationUnknownIds");
  }
}

function validateCameras(model: S6SpatialModelRecord, bag: IssueBag): void {
  let canonicalCameras: S6SpatialModelRecord["cameras"];
  try {
    canonicalCameras = buildS6Cameras(model);
  } catch {
    issue(bag, "CAMERA_INVALID", "cameras");
    return;
  }
  if (!Array.isArray(model.cameras) || model.cameras.length !== canonicalCameras.length) {
    issue(bag, "CAMERA_INVALID", "cameras");
    return;
  }
  for (let index = 0; index < canonicalCameras.length; index += 1) {
    const camera = model.cameras[index];
    const canonical = canonicalCameras[index];
    try {
      if (hashS6Camera(camera) !== camera.cameraHash || canonicalS6Json(camera) !== canonicalS6Json(canonical)) {
        issue(bag, "CAMERA_INVALID", "cameras[" + String(index) + "]", null);
      }
    } catch {
      issue(bag, "CAMERA_INVALID", "cameras[" + String(index) + "]", null);
    }
  }
}

function validateHash(model: S6SpatialModelRecord, bag: IssueBag): void {
  try {
    const hashed = hashS6Model(model);
    if (hashed.modelHash !== model.modelHash || hashed.canonicalByteSize !== model.canonicalByteSize) issue(bag, "CANONICAL_HASH_MISMATCH", "modelHash");
    if (hashed.canonicalByteSize > S6_MAX_MODEL_BYTES) issue(bag, "PAYLOAD_TOO_LARGE", "canonicalByteSize");
  } catch {
    issue(bag, "CANONICAL_HASH_MISMATCH", "modelHash");
  }
}

function makeReceipt(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): S6ValidationReceipt {
  const outcome = bag.errors.length > 0 ? "acceptance_blocked" : bag.warnings.length > 0 ? "pass_with_warnings" : "pass";
  const receipt: S6ValidationReceipt = {
    schemaVersion: "s6-validation-receipt-v1",
    receiptId: "validation:" + model.modelRevisionId as UUID,
    projectId: model.projectId,
    revisionId: model.modelRevisionId,
    revisionHash: model.modelHash,
    sourceS5Fingerprint: context.source.sourceFingerprint,
    validatorVersion: S6_VALIDATOR_VERSION,
    orderVersion: S6_VALIDATION_ORDER_VERSION,
    outcome,
    errors: bag.errors,
    warnings: bag.warnings,
    checkedAt: new Date(0).toISOString(),
    validationHash: "" as Sha256,
  };
  receipt.validationHash = sha256(canonicalS6Json(receipt));
  return receipt;
}

export function validateS6Model(model: S6SpatialModelRecord, context: S6ValidationContext): S6ValidationReceipt {
  const bag: IssueBag = { errors: [], warnings: [] };
  validateSource(model, context, bag);
  validateSchema(model, bag);
  validateNumeric(model, bag);
  validateBooth(model, context, bag);
  validateHierarchy(model, context, bag);
  validateSemantics(model, bag);
  validateRequirements(model, context, bag);
  validateContainment(model, bag);
  validateCollisions(model, bag);
  validateDesignForm(model, context, bag);
  validateCameras(model, bag);
  validateHash(model, bag);
  return makeReceipt(model, context, bag);
}
