import { randomUUID } from "node:crypto";
import {
  canonicalS6Json,
  hashS6Model,
  normalizeS6Geometry,
  normalizeS6Rotation,
  S6_MAX_COORDINATE_MM,
  S6_MAX_LABEL_CODE_POINTS,
  S6_MAX_NOTE_CODE_POINTS,
  S6_MAX_OPERATIONS,
  S6_MAX_PHYSICAL_MM,
  S6_MIN_PHYSICAL_MM,
  S6_SPATIAL_SCHEMA_VERSION,
  S6_CORRECTION_SCHEMA_VERSION,
  userObjectId,
} from "./s6-canonical";
import { sha256 } from "./utils";
import type {
  S6CorrectionEvent,
  S6CorrectionGeometry,
  S6CorrectionOperation,
  S6GeometryPrimitive,
  S6MaterialFinishRef,
  S6ObjectRole,
  S6PrimitiveKind,
  S6SpatialModelRecord,
  S6SpatialObject,
  S6Provenance,
  Timestamp,
  UUID,
} from "./types";

export type S6CorrectionOptions = {
  childRevisionId: UUID;
  clock: () => Timestamp;
  actorSubjectId: string;
  correctionEventId?: UUID;
  idempotencyKey?: UUID;
  requestReferenceId?: UUID;
};

function correctionError(code: string): Error {
  return new Error(code);
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized ? Array.from(normalized).slice(0, S6_MAX_LABEL_CODE_POINTS).join("") : fallback;
}

function boundedNote(value: string): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > S6_MAX_NOTE_CODE_POINTS || /[\u0000-\u001f\u007f]/u.test(value)) throw correctionError("S6_CORRECTION_INVALID");
  return value.trim();
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}

function allowlist(objectType: S6PrimitiveKind, geometryKind: S6GeometryPrimitive["kind"]): boolean {
  const allowed: Record<S6PrimitiveKind, readonly S6GeometryPrimitive["kind"][]> = {
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
  return allowed[objectType].includes(geometryKind);
}

function roleForType(objectType: S6PrimitiveKind): S6ObjectRole | null {
  const roles: Partial<Record<S6PrimitiveKind, S6ObjectRole>> = {
    counter: "furniture",
    display_plinth: "display",
    screen: "screen",
    storage_volume: "storage",
    table: "furniture",
    seating_marker: "seating",
    equipment_placeholder: "equipment",
    overhead_volume: "overhead",
    partition: "booth_partition",
    box: "furniture",
  };
  return roles[objectType] ?? null;
}

function geometryFromCorrection(geometry: S6CorrectionGeometry): S6GeometryPrimitive {
  if (geometry.kind === "rect_prism") {
    return normalizeS6Geometry({ kind: "rect_prism", dimensionsMm: geometry.dimensionsMm, geometryState: "exact", localAnchor: geometry.localAnchor });
  }
  if (geometry.kind === "round_prism") {
    return normalizeS6Geometry({ kind: "round_prism", radiusMm: geometry.radiusMm, heightMm: geometry.heightMm, geometryState: "exact", localAnchor: geometry.localAnchor });
  }
  return normalizeS6Geometry({ kind: "profile_extrusion", profile: geometry.profile, heightMm: geometry.heightMm, geometryState: "exact", localAnchor: geometry.localAnchor });
}

function safeMaterial(material: S6MaterialFinishRef): S6MaterialFinishRef {
  if (typeof material.materialId !== "string" || !material.materialId.trim() || typeof material.label !== "string" || Array.from(material.label).length > S6_MAX_LABEL_CODE_POINTS || /(?:https?:|data:|javascript:|[<>])/iu.test(JSON.stringify(material))) {
    throw correctionError("S6_CORRECTION_INVALID");
  }
  if (material.colorHex !== null && !/^#[0-9a-f]{6}$/iu.test(material.colorHex)) throw correctionError("S6_CORRECTION_INVALID");
  return material;
}

function userProvenance(parent: S6SpatialModelRecord, actorSubjectId: string, note: string): S6Provenance {
  return {
    kind: "user_confirmed_design_decision",
    sourceRef: "s6:user-correction",
    sourceFingerprint: parent.sourceS5Fingerprint,
    acceptedByUser: true,
    note: "Typed user correction recorded by " + actorSubjectId + ": " + note,
  };
}

function assertObject(parent: S6SpatialModelRecord, objectId: string): S6SpatialObject {
  const object = parent.objects.find((item) => item.objectId === objectId);
  if (!object) throw correctionError("S6_OBJECT_NOT_FOUND");
  if (!object.editable || !object.removable || object.role === "booth_floor" || object.role === "booth_wall" || object.role === "zone") throw correctionError("S6_HARD_FACT_IMMUTABLE");
  return object;
}

function assertIntegerTransform(object: S6SpatialObject): void {
  const values = [object.transform.positionMm.xMm, object.transform.positionMm.yMm, object.transform.positionMm.zMm];
  if (!values.every((value) => integer(value, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM))) throw correctionError("S6_CORRECTION_INVALID");
}

function addMaterial(model: S6SpatialModelRecord, material: S6MaterialFinishRef): void {
  const existing = model.materials.find((item) => item.materialId === material.materialId);
  if (existing && canonicalS6Json(existing) !== canonicalS6Json(material)) throw correctionError("S6_CORRECTION_INVALID");
  if (!existing) model.materials.push(material);
}

function canonicalOperationInput(operations: readonly S6CorrectionOperation[]): unknown[] {
  return operations.map((operation) => {
    const copy = structuredClone(operation) as Record<string, unknown>;
    if (operation.kind === "replace_geometry") copy.geometry = geometryFromCorrection(operation.geometry);
    if (operation.kind === "resolve_unknown" && operation.replacement) {
      copy.replacement = { ...operation.replacement, geometry: geometryFromCorrection(operation.replacement.geometry) };
    }
    if (operation.kind === "add") copy.geometry = geometryFromCorrection(operation.geometry);
    return copy;
  });
}

export function canonicalS6CorrectionOperations(operations: readonly S6CorrectionOperation[]): unknown[] {
  return canonicalOperationInput(operations);
}

type Replacement = Extract<S6CorrectionOperation, { kind: "resolve_unknown" }>["replacement"];

function applyGeometry(object: S6SpatialObject, geometry: S6CorrectionGeometry): void {
  if (!allowlist(object.objectType, geometry.kind)) throw correctionError("S6_CORRECTION_GEOMETRY_NOT_ALLOWED");
  object.primitive = geometryFromCorrection(geometry);
}

function transformFromReplacement(replacement: NonNullable<Replacement>): S6SpatialObject["transform"] {
  const values = [
    replacement.positionMm.xMm, replacement.positionMm.yMm, replacement.positionMm.zMm,
    replacement.rotationMd.xMd, replacement.rotationMd.yMd, replacement.rotationMd.zMd,
  ];
  if (!values.every((value) => integer(value, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM))) throw correctionError("S6_CORRECTION_INVALID");
  return { positionMm: structuredClone(replacement.positionMm), rotationMd: normalizeS6Rotation(replacement.rotationMd) };
}

function updateReview(model: S6SpatialModelRecord): void {
  const unresolved = model.unknowns.filter((item) => item.kind === "design_form" && item.status === "unresolved").map((item) => item.unknownId).sort();
  model.designFormReview.unresolvedUnknownIds = unresolved;
  model.designFormReview.reviewedObjectIds = Array.from(new Set(model.designFormReview.reviewedObjectIds)).sort();
  model.designFormReview.explicitSimplificationUnknownIds = Array.from(new Set(model.designFormReview.explicitSimplificationUnknownIds)).sort();
  model.designFormReview.acceptedByUser = unresolved.length === 0;
  model.designFormReview.status = unresolved.length === 0 ? "complete" : model.designFormReview.status === "unsupported" ? "unsupported" : "required";
}

function boundedInferenceNote(existing: string | null, confirmation: string): string {
  const prefix = "User confirmed bounded design inference: ";
  const confirmationBudget = Math.max(0, S6_MAX_NOTE_CODE_POINTS - Array.from(prefix).length);
  const boundedConfirmation = prefix + Array.from(confirmation).slice(0, confirmationBudget).join("");
  const existingPoints = Array.from(existing ?? "");
  const existingBudget = Math.max(0, S6_MAX_NOTE_CODE_POINTS - Array.from(boundedConfirmation).length - (existingPoints.length > 0 ? 1 : 0));
  const boundedExisting = existingPoints.slice(0, existingBudget).join("");
  return boundedExisting ? boundedExisting + " " + boundedConfirmation : boundedConfirmation;
}

function resolveUnknown(
  model: S6SpatialModelRecord,
  operation: Extract<S6CorrectionOperation, { kind: "resolve_unknown" }>,
  options: S6CorrectionOptions,
  unknown: NonNullable<S6SpatialModelRecord["unknowns"][number]>,
): void {
  const note = boundedNote(operation.resolutionNote);
  if ((unknown.kind === "geometry" || unknown.kind === "design_form") && operation.replacement === null) throw correctionError("S6_CORRECTION_TYPED_REPLACEMENT_REQUIRED");
  if (operation.replacement) {
    const replacement = operation.replacement;
    const targetId = /^objects\[(.+)\](?:\.primitive)?$/u.exec(unknown.fieldPath)?.[1] ?? null;
    const target = targetId ? model.objects.find((item) => item.objectId === targetId) : undefined;
    const role = roleForType(replacement.objectType);
    if (!role || role !== replacement.role || replacement.objectType === "floor_footprint" || replacement.objectType === "wall" || replacement.objectType === "zone_region") throw correctionError("S6_CORRECTION_INVALID");
    const primitive = geometryFromCorrection(replacement.geometry);
    if (!allowlist(replacement.objectType, primitive.kind)) throw correctionError("S6_CORRECTION_GEOMETRY_NOT_ALLOWED");
    const material = safeMaterial(replacement.material);
    addMaterial(model, material);
    if (target) {
      if (target.role !== replacement.role) throw correctionError("S6_CORRECTION_GEOMETRY_NOT_ALLOWED");
      target.objectType = replacement.objectType;
      target.role = replacement.role;
      target.label = safeLabel(replacement.label, target.label);
      target.primitive = primitive;
      target.transform = transformFromReplacement(replacement);
      target.materialIds = [material.materialId];
      target.provenance = userProvenance(model, options.actorSubjectId, note);
    } else {
      const objectId = userObjectId(randomUUID());
      model.objects.push({
        objectId,
        identityKey: "user:" + objectId,
        parentObjectId: null,
        objectType: replacement.objectType,
        role: replacement.role,
        label: safeLabel(replacement.label, "User spatial object"),
        primitive,
        transform: transformFromReplacement(replacement),
        zoneIds: [],
        requirementIds: unknown.requirementId ? [unknown.requirementId] : [],
        materialIds: [material.materialId],
        unknownIds: [unknown.unknownId],
        provenance: userProvenance(model, options.actorSubjectId, note),
        hardConstraint: "user_editable",
        editable: true,
        removable: true,
      });
    }
  }
  unknown.status = "resolved";
  unknown.resolutionKind = operation.resolutionKind;
  unknown.resolutionNote = note;
  unknown.resolvedBy = "user";
  unknown.resolvedAt = options.clock();
  if (operation.resolutionKind === "explicit_simplification" && !model.designFormReview.explicitSimplificationUnknownIds.includes(unknown.unknownId)) {
    model.designFormReview.explicitSimplificationUnknownIds.push(unknown.unknownId);
  }
}

function applyOperation(model: S6SpatialModelRecord, operation: S6CorrectionOperation, options: S6CorrectionOptions): void {
  if (operation.kind === "add") {
    const role = roleForType(operation.objectType);
    if (!role || role !== operation.role) throw correctionError("S6_CORRECTION_INVALID");
    const primitive = geometryFromCorrection(operation.geometry);
    if (!allowlist(operation.objectType, primitive.kind)) throw correctionError("S6_CORRECTION_GEOMETRY_NOT_ALLOWED");
    const material = safeMaterial(operation.material);
    addMaterial(model, material);
    const objectId = userObjectId(randomUUID());
    if (operation.parentObjectId !== null && !model.objects.some((item) => item.objectId === operation.parentObjectId)) throw correctionError("S6_HIERARCHY_DANGLING_PARENT");
    model.objects.push({
      objectId,
      identityKey: "user:" + objectId,
      parentObjectId: operation.parentObjectId,
      objectType: operation.objectType,
      role: operation.role,
      label: safeLabel(operation.label, "User spatial object"),
      primitive,
      transform: transformFromReplacement({ objectType: operation.objectType, role: operation.role, label: operation.label, geometry: operation.geometry, positionMm: operation.positionMm, rotationMd: operation.rotationMd, material: operation.material }),
      zoneIds: operation.zoneIds.slice().sort(),
      requirementIds: operation.requirementIds.slice().sort(),
      materialIds: [material.materialId],
      unknownIds: [],
      provenance: userProvenance(model, options.actorSubjectId, "Added typed object."),
      hardConstraint: "user_editable",
      editable: true,
      removable: true,
    });
    return;
  }
  if (operation.kind === "resolve_unknown") {
    const unknown = model.unknowns.find((item) => item.unknownId === operation.unknownId);
    if (!unknown || unknown.status !== "unresolved") throw correctionError("S6_UNKNOWN_NOT_FOUND");
    resolveUnknown(model, operation, options, unknown);
    return;
  }
  if (operation.kind === "confirm_design_inference") {
    const note = boundedNote(operation.note);
    for (const objectId of operation.objectIds) {
      const object = model.objects.find((item) => item.objectId === objectId);
      if (!object || object.provenance.kind !== "bounded_design_inference") throw correctionError("S6_DESIGN_FORM_CONFIRMATION_INVALID");
      const linked = model.unknowns.find((item) => item.kind === "design_form" && item.status === "unresolved" && object.unknownIds.includes(item.unknownId));
      if (!linked) throw correctionError("S6_DESIGN_FORM_CONFIRMATION_INVALID");
      object.provenance = {
        ...object.provenance,
        acceptedByUser: true,
        note: boundedInferenceNote(object.provenance.note, note),
      };
      linked.status = "resolved";
      linked.resolutionKind = "represented";
      linked.resolutionNote = note;
      linked.resolvedBy = "user";
      linked.resolvedAt = options.clock();
      if (!model.designFormReview.reviewedObjectIds.includes(objectId)) model.designFormReview.reviewedObjectIds.push(objectId);
    }
    updateReview(model);
    return;
  }
  if (operation.kind === "zone_requirement_map") {
    const object = assertObject(model, operation.objectId);
    const zones = new Set(model.zones.map((item) => item.zoneId));
    const requirements = new Set(model.objects.flatMap((item) => item.requirementIds));
    for (const zoneId of operation.zoneIds) if (!zones.has(zoneId)) throw correctionError("S6_CORRECTION_INVALID");
    for (const requirementId of operation.requirementIds) if (!requirements.has(requirementId) && !model.unknowns.some((item) => item.requirementId === requirementId)) throw correctionError("S6_CORRECTION_INVALID");
    object.zoneIds = operation.zoneIds.slice().sort();
    object.requirementIds = operation.requirementIds.slice().sort();
    return;
  }
  const object = assertObject(model, operation.objectId);
  if (operation.kind === "move") {
    if (![operation.deltaMm.xMm, operation.deltaMm.yMm, operation.deltaMm.zMm].every((value) => integer(value, -S6_MAX_COORDINATE_MM, S6_MAX_COORDINATE_MM))) throw correctionError("S6_CORRECTION_INVALID");
    object.transform.positionMm = {
      xMm: object.transform.positionMm.xMm + operation.deltaMm.xMm,
      yMm: object.transform.positionMm.yMm + operation.deltaMm.yMm,
      zMm: object.transform.positionMm.zMm + operation.deltaMm.zMm,
    };
    assertIntegerTransform(object);
  } else if (operation.kind === "rotate") {
    object.transform.rotationMd = normalizeS6Rotation(operation.rotationMd);
  } else if (operation.kind === "resize") {
    if (object.primitive.kind !== "rect_prism") throw correctionError("S6_CORRECTION_GEOMETRY_NOT_ALLOWED");
    object.primitive = normalizeS6Geometry({ kind: "rect_prism", dimensionsMm: operation.dimensionsMm, geometryState: "exact", localAnchor: object.primitive.localAnchor });
    object.provenance = userProvenance(model, options.actorSubjectId, "Resized typed rectangular geometry.");
  } else if (operation.kind === "replace_geometry") {
    applyGeometry(object, operation.geometry);
    object.provenance = userProvenance(model, options.actorSubjectId, "Replaced geometry with a typed allowlisted form.");
  } else if (operation.kind === "material") {
    const material = safeMaterial(operation.material);
    addMaterial(model, material);
    object.materialIds = [material.materialId];
    object.provenance = userProvenance(model, options.actorSubjectId, "Applied a typed material finish.");
  } else if (operation.kind === "remove") {
    model.objects = model.objects.filter((item) => item.objectId !== object.objectId);
    model.designFormReview.reviewedObjectIds = model.designFormReview.reviewedObjectIds.filter((id) => id !== object.objectId);
  }
}

export function applyS6Corrections(
  parent: S6SpatialModelRecord,
  operations: S6CorrectionOperation[],
  options: S6CorrectionOptions,
): { model: S6SpatialModelRecord; event: S6CorrectionEvent } {
  if (!Array.isArray(operations) || operations.length > S6_MAX_OPERATIONS) throw correctionError("S6_CORRECTION_TOO_MANY_OPERATIONS");
  if (typeof options.actorSubjectId !== "string" || !options.actorSubjectId.trim()) throw correctionError("S6_CORRECTION_INVALID");
  const model = structuredClone(parent);
  for (const operation of operations) applyOperation(model, operation, options);
  updateReview(model);
  const occurredAt = options.clock();
  const modelArtifactBase = "projects/" + model.projectId + "/s6/revisions/" + options.childRevisionId;
  model.schemaVersion = S6_SPATIAL_SCHEMA_VERSION;
  model.modelRevisionId = options.childRevisionId;
  model.parentRevisionId = parent.modelRevisionId;
  model.parentRevisionHash = parent.modelHash;
  model.revisionNumber = parent.revisionNumber + 1;
  model.status = "corrected_draft";
  model.createdBy = "user_correction";
  model.createdAt = occurredAt;
  model.updatedAt = occurredAt;
  model.validationReceiptId = null;
  model.acceptanceEventId = null;
  model.acceptedAt = null;
  model.supersededAt = null;
  model.staleAt = null;
  model.modelArtifact = { artifactKey: modelArtifactBase + "/model.json", stagingKey: modelArtifactBase + "/staging/model.json", sha256: null, byteSize: null, status: "not_written" };
  const hashed = hashS6Model(model);
  model.modelHash = hashed.modelHash;
  model.canonicalByteSize = hashed.canonicalByteSize;
  const event: S6CorrectionEvent = {
    schemaVersion: S6_CORRECTION_SCHEMA_VERSION,
    correctionEventId: options.correctionEventId ?? randomUUID(),
    projectId: parent.projectId,
    parentRevisionId: parent.modelRevisionId,
    parentRevisionHash: parent.modelHash,
    childRevisionId: model.modelRevisionId,
    childRevisionHash: model.modelHash,
    sourceS5Fingerprint: parent.sourceS5Fingerprint,
    actorSubjectId: options.actorSubjectId,
    operations: structuredClone(operations),
    requestHash: sha256(canonicalS6Json({ parentRevisionId: parent.modelRevisionId, parentRevisionHash: parent.modelHash, operations: canonicalOperationInput(operations) })),
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    requestReferenceId: options.requestReferenceId ?? randomUUID(),
    occurredAt,
  };
  return { model, event };
}
