import {
  canonicalS6Json,
  containsS6WorldBooth,
  containsS6WorldGeometry,
  deriveS6WorldGeometry,
  hashS6ValidationReceipt,
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
  type S6WorldGeometry,
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
  S6RequirementEvaluation,
  S6RequirementResolution,
  S2Requirement,
  S5ZoneCategory,
  S6GeometryKind,
  S6MaterialFinishKind,
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

function roleTypeAllowed(object: S6SpatialObject): boolean {
  const roles: Record<S6SpatialObject["objectType"], readonly S6SpatialObject["role"][]> = {
    floor_footprint: ["booth_floor"],
    wall: ["booth_wall"],
    partition: ["booth_partition"],
    box: ["furniture", "display", "storage", "equipment", "overhead", "booth_partition"],
    counter: ["furniture"],
    display_plinth: ["display"],
    screen: ["screen"],
    storage_volume: ["storage"],
    table: ["furniture"],
    seating_marker: ["seating"],
    equipment_placeholder: ["equipment"],
    overhead_volume: ["overhead"],
    zone_region: ["zone"],
  };
  return roles[object.objectType]?.includes(object.role) ?? false;
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
    if (!geometryAllowed(object) || !roleTypeAllowed(object)) issue(bag, "SPATIAL_SCHEMA_INVALID", "objects[" + object.objectId + "].primitive.kind", object.objectId);
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

const GEOMETRY_REQUIREMENTS = new Map<string, readonly string[]>([
  ["geometry.width", ["booth.widthMm", "floor.widthMm"]],
  ["geometry.depth", ["booth.depthMm", "floor.depthMm"]],
  ["access.open-sides", ["booth.openSides", "booth-wall-integrity"]],
  ["geometry.max-height", ["booth.maxHeightMm", "world.top"]],
]);

const OBJECT_FAMILIES: Array<{
  objectType: S6SpatialObject["objectType"];
  role: S6SpatialObject["role"];
  words: readonly string[];
}> = [
  { objectType: "partition", role: "booth_partition", words: ["partition", "wall"] },
  { objectType: "overhead_volume", role: "overhead", words: ["overhead", "canopy", "ceiling"] },
  { objectType: "screen", role: "screen", words: ["screen", "monitor"] },
  { objectType: "counter", role: "furniture", words: ["counter", "desk"] },
  { objectType: "table", role: "furniture", words: ["table"] },
  { objectType: "storage_volume", role: "storage", words: ["storage", "cabinet"] },
  { objectType: "display_plinth", role: "display", words: ["display", "plinth", "showcase", "brochure", "giveaway"] },
  { objectType: "equipment_placeholder", role: "equipment", words: ["equipment"] },
];

const ALLOWED_REQUIREMENT_WORDS = new Set([
  "a", "an", "the", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "no", "optional", "required", "confirmed", "primary", "additional", "bounded", "concept", "conceptual",
  "reception", "welcome", "product", "demo", "demonstration", "presentation", "consultation", "meeting", "interactive", "activity", "shared",
  "photo", "brand", "branding", "giveaway", "brochure", "other", "for", "and", "of", "with",
  "round", "circular", "profile", "stepped", "angled", "non", "axis", "aligned", "rectangular", "extrusion", "l",
  "wood", "wooden", "metal", "metallic", "fabric", "textile", "glass", "acrylic", "neutral", "solid", "color",
  "partition", "wall", "overhead", "canopy", "ceiling", "screen", "monitor", "counter", "desk", "table", "storage", "cabinet",
  "display", "plinth", "plinths", "showcase", "fascia", "equipment", "placeholder", "volume", "zone", "area", "space", "designated",
]);

const MATERIAL_WORDS: Array<{ finish: S6MaterialFinishKind; words: readonly string[] }> = [
  { finish: "wood_like", words: ["wood", "wooden"] },
  { finish: "metal_like", words: ["metal", "metallic"] },
  { finish: "fabric_like", words: ["fabric", "textile"] },
  { finish: "glass_like", words: ["glass", "acrylic"] },
  { finish: "brand_reference", words: ["brand", "branding", "logo"] },
];

function normalizedRequirementWords(value: string): string[] {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean);
}

function normalizedRequirementText(requirement: S2Requirement): string {
  return normalizedRequirementWords(requirement.text).join(" ");
}

function hasSequence(words: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || words.length < sequence.length) return false;
  return words.some((_word, index) => sequence.every((part, offset) => words[index + offset] === part));
}

function supportedGeometryRequirement(requirement: S2Requirement): boolean {
  return GEOMETRY_REQUIREMENTS.has(requirement.requirementId);
}

function unresolvedResolution(issueCode: "REQUIREMENT_MAPPING_INVALID" | "S6_UNSUPPORTED_FORM" = "REQUIREMENT_MAPPING_INVALID"): S6RequirementResolution {
  return { kind: "unresolved", evidenceKind: "unresolved", issueCode };
}

function requirementCountValid(requirement: S2Requirement): boolean {
  if (requirement.expected === "exact_count") {
    return requirement.expectedCount !== null && Number.isSafeInteger(requirement.expectedCount) &&
      requirement.expectedCount >= 0 && requirement.expectedCount <= S6_MAX_OBJECTS;
  }
  return requirement.expectedCount === null;
}

function unsupportedRequirementForm(text: string): boolean {
  return /(?:\bhole\b|\bholes\b|double[-\s]?bent|free[-\s]?form|bezier|\bmesh\b|unsupported|arbitrary\s+(?:curve|path|shape))/iu.test(text);
}

function requirementZoneCategories(source: S5ToS6Projection, requirementId: string): S5ZoneCategory[] {
  return source.layoutPlan.zones.filter((zone) => zone.requirementIds.includes(requirementId)).map((zone) => zone.category);
}

function inferredObjectFamily(words: readonly string[]): typeof OBJECT_FAMILIES[number] | null {
  const found = OBJECT_FAMILIES.filter((family) => family.words.some((word) => words.includes(word)));
  return found.length === 1 ? found[0]! : null;
}

/** Resolve confirmed S5 requirement meaning without treating object tags as proof. */
export function resolveS6Requirement(requirement: S2Requirement, source: S5ToS6Projection): S6RequirementResolution {
  const text = normalizedRequirementText(requirement);
  const words = text.split(" ").filter(Boolean);
  if (supportedGeometryRequirement(requirement) || requirement.category === "geometry") {
    const fields = GEOMETRY_REQUIREMENTS.get(requirement.requirementId);
    if (!fields || requirement.category !== "geometry" || requirement.source !== "geometry_snapshot" || requirement.expected !== "present" ||
      requirement.expectedCount !== null || !requirementCountValid(requirement)) return unresolvedResolution();
    return { kind: "geometry", evidenceKind: "booth_fields", predicateVersion: "booth-facts-v1", boothFields: [...fields] };
  }
  if (unsupportedRequirementForm(requirement.text)) return unresolvedResolution("S6_UNSUPPORTED_FORM");
  if (!requirementCountValid(requirement)) return unresolvedResolution();

  if (requirement.category === "prohibited") {
    if (requirement.expected !== "absent" || requirement.expectedCount !== null) return unresolvedResolution();
    if (text === "no enclosed ceiling") return { kind: "prohibited", evidenceKind: "prohibited_absence", predicateVersion: "forbidden-family-absence-v1", family: "enclosed_ceiling" };
    if (text === "no screen" || text === "no screens") return { kind: "prohibited", evidenceKind: "prohibited_absence", predicateVersion: "forbidden-family-absence-v1", family: "screen" };
    return unresolvedResolution();
  }

  if (text === "keep the entry clear" && (requirement.category === "mandatory" || requirement.category === "free_text") && requirement.expected === "present") {
    return { kind: "scene", evidenceKind: "scene_predicate", predicateVersion: "entry-clear-v1", predicate: "entry_clear" };
  }
  if (["keep all objects within the booth", "keep all objects inside the booth", "all objects within the booth", "all objects inside the booth"].includes(text) &&
    (requirement.category === "mandatory" || requirement.category === "free_text") && requirement.expected === "present") {
    return { kind: "scene", evidenceKind: "scene_predicate", predicateVersion: "booth-containment-v1", predicate: "booth_containment" };
  }
  if (["keep all objects below the confirmed maximum height", "all objects below the confirmed maximum height"].includes(text) &&
    (requirement.category === "mandatory" || requirement.category === "free_text") && requirement.expected === "present") {
    return { kind: "scene", evidenceKind: "scene_predicate", predicateVersion: "maximum-height-v1", predicate: "maximum_height" };
  }

  // Apply the complete-expression vocabulary before zone or family inference so
  // an allowed noun cannot hide an unsupported qualifier or suffix.
  if (words.some((word) => !ALLOWED_REQUIREMENT_WORDS.has(word) && !/^\d+$/u.test(word))) return unresolvedResolution();
  if (words.some((word) => ["primary", "additional", "shared"].includes(word))) return unresolvedResolution();

  const negative = words.some((word) => ["no", "not", "without", "free", "avoid", "exclude", "prohibit", "prohibited"].includes(word));
  const absentObjectExpectation = requirement.expected === "absent" || (requirement.expected === "exact_count" && requirement.expectedCount === 0);
  if (negative && !absentObjectExpectation) return unresolvedResolution();

  const explicitZone = words.some((word) => word === "zone" || word === "area" || word === "space");
  if (explicitZone && (requirement.category === "functional" || requirement.category === "mandatory" || requirement.category === "free_text") &&
      (requirement.expected === "present" || requirement.expected === "exact_count" || requirement.expected === "absent")) {
    const categories = [...new Set(requirementZoneCategories(source, requirement.requirementId))];
    if (categories.length === 1 && !words.some((word) => OBJECT_FAMILIES.some((family) => family.words.includes(word)))) {
      return { kind: "zone", evidenceKind: "zone_region", category: categories[0]! };
    }
  }

  const family = inferredObjectFamily(words);
  if (!family) return unresolvedResolution();
  if ((requirement.category !== "functional" && requirement.category !== "mandatory" && requirement.category !== "free_text") ||
      (requirement.expected !== "present" && requirement.expected !== "exact_count" && requirement.expected !== "absent")) return unresolvedResolution();

  const hasRound = words.includes("round") || words.includes("circular");
  const hasProfile = words.includes("profile") || words.includes("stepped") || words.includes("angled") ||
    hasSequence(words, ["non", "axis", "aligned"]) || hasSequence(words, ["non", "rectangular"]) || hasSequence(words, ["l", "profile"]);
  const hasRectangular = words.includes("rectangular") && !hasSequence(words, ["non", "rectangular"]);
  if ((hasRound && hasProfile) || (hasRectangular && (hasRound || hasProfile))) return unresolvedResolution();
  const materialMatches = MATERIAL_WORDS.filter((material) => material.words.some((word) => words.includes(word)));
  if (materialMatches.length > 1) return unresolvedResolution();
  const primitiveKind: S6GeometryKind | null = hasRound ? "round_prism" : hasProfile ? "profile_extrusion" : hasRectangular ? "rect_prism" : null;
  return {
    kind: "object",
    evidenceKind: "object_family",
    objectType: family.objectType,
    role: family.role,
    primitiveKind,
    materialFinishKind: materialMatches[0]?.finish ?? null,
  };
}

function evaluation(
  requirement: S2Requirement,
  source: S5ToS6Projection,
  resolution: S6RequirementResolution,
  outcome: S6RequirementEvaluation["outcome"],
  issueCodes: string[] = [],
  objectIds: string[] = [],
  zoneIds: string[] = [],
  boothFields: string[] = [],
): S6RequirementEvaluation {
  return {
    requirementId: requirement.requirementId,
    sourceFingerprint: source.sourceFingerprint,
    evidenceKind: resolution.evidenceKind,
    predicateVersion: resolution.kind === "geometry" || resolution.kind === "scene" || resolution.kind === "prohibited" ? resolution.predicateVersion : null,
    outcome,
    objectIds: [...new Set(objectIds)].sort(),
    zoneIds: [...new Set(zoneIds)].sort(),
    boothFields: [...new Set(boothFields)].sort(),
    issueCodes: [...new Set(issueCodes)].sort(),
  };
}

function sideSetMatches(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length &&
    left.every((side) => right.includes(side));
}

function parseOpenSideRequirement(value: unknown): OpenSide[] | null {
  if (typeof value !== "string") return null;
  const raw = value.split(",");
  if (raw.length < 1 || raw.some((side) => !S6_OPEN_SIDE_ORDER.includes(side as OpenSide)) || new Set(raw).size !== raw.length) return null;
  return S6_OPEN_SIDE_ORDER.filter((side) => raw.includes(side));
}

function floorMatches(model: S6SpatialModelRecord, field: "widthMm" | "depthMm"): boolean {
  const floors = model.objects.filter((item) => item.role === "booth_floor");
  const floor = floors[0];
  return floors.length === 1 && floor?.objectType === "floor_footprint" && floor.parentObjectId === null &&
    floor.primitive.kind === "rect_prism" && floor.primitive.geometryState === "exact" && floor.primitive.localAnchor === "floor" &&
    floor.primitive.dimensionsMm[field] === model.booth[field] &&
    floor.transform.positionMm.xMm === 0 && floor.transform.positionMm.yMm === 0 && floor.transform.positionMm.zMm === 0 &&
    floor.transform.rotationMd.xMd === 0 && floor.transform.rotationMd.yMd === 0 && floor.transform.rotationMd.zMd === 0;
}

function familyPresent(object: S6SpatialObject, resolution: Extract<S6RequirementResolution, { kind: "object" }>): boolean {
  return object.objectType === resolution.objectType;
}

function familyObjectMatches(
  object: S6SpatialObject,
  resolution: Extract<S6RequirementResolution, { kind: "object" }>,
  model: S6SpatialModelRecord,
  source: S5ToS6Projection,
): boolean {
  if (object.objectType !== resolution.objectType || object.role !== resolution.role ||
      object.role === "booth_floor" || object.role === "booth_wall" || object.role === "zone" ||
      object.provenance.sourceFingerprint !== source.sourceFingerprint || object.provenance.sourceRef.length === 0) return false;
  if (resolution.primitiveKind !== null && object.primitive.kind !== resolution.primitiveKind) return false;
  if (resolution.materialFinishKind !== null) {
    const matched = object.materialIds.some((materialId) => model.materials.some((material) => material.materialId === materialId && material.finishKind === resolution.materialFinishKind && material.provenance.sourceFingerprint === source.sourceFingerprint));
    if (!matched) return false;
  }
  return true;
}

function countableRequirement(requirement: S2Requirement): boolean {
  return requirement.expected === "present" || (requirement.expected === "exact_count" && requirementCountValid(requirement) && (requirement.expectedCount ?? 0) > 0);
}

function hasInvalidFunctionalCoallocation(
  object: S6SpatialObject,
  requirement: S2Requirement,
  source: S5ToS6Projection,
): boolean {
  if (requirement.category !== "functional") return false;
  return object.requirementIds.some((otherId) => otherId !== requirement.requirementId &&
    source.canonicalRequirements.some((candidate) => candidate.requirementId === otherId && candidate.category === "functional"));
}

function validOtherRequirementAllocation(
  object: S6SpatialObject,
  requirement: S2Requirement,
  model: S6SpatialModelRecord,
  source: S5ToS6Projection,
  duplicatedIds: ReadonlySet<string>,
): boolean {
  return object.requirementIds.some((otherId) => {
    if (otherId === requirement.requirementId || duplicatedIds.has(object.objectId) || object.requirementIds.filter((id) => id === otherId).length !== 1) return false;
    const other = source.canonicalRequirements.find((candidate) => candidate.requirementId === otherId);
    if (!other || !countableRequirement(other) || (other.category !== "functional" && other.category !== "mandatory" && other.category !== "free_text")) return false;
    const otherResolution = resolveS6Requirement(other, source);
    if (otherResolution.kind !== "object" || !familyObjectMatches(object, otherResolution, model, source)) return false;
    return true;
  });
}

function geometryRequirementEvaluation(
  requirement: S2Requirement,
  source: S5ToS6Projection,
  model: S6SpatialModelRecord,
  resolution: Extract<S6RequirementResolution, { kind: "geometry" }>,
): S6RequirementEvaluation {
  const base = (): { outcome: "satisfied" | "unsatisfied" | "unresolved"; codes: string[]; objects: string[] } => {
    if (model.projectId !== source.projectId || model.sourceS5Fingerprint !== source.sourceFingerprint ||
        model.sourceS5ApprovalEventId !== source.approvalEventId || model.sourceS5ApprovalGeneration !== source.approvalGeneration) {
      return { outcome: "unresolved", codes: ["SOURCE_STALE"], objects: [] };
    }
    const invalid = (): { outcome: "unsatisfied"; codes: string[]; objects: string[] } => ({ outcome: "unsatisfied", codes: ["REQUIREMENT_GEOMETRY_MISMATCH"], objects: [] });
    if (requirement.requirementId === "geometry.width") {
      if (!integer(requirement.expectedValue, 1, S6_MAX_COORDINATE_MM) || requirement.expectedValue !== source.geometrySnapshot.widthMm ||
          requirement.expectedValue !== model.booth.widthMm || !floorMatches(model, "widthMm")) return invalid();
    } else if (requirement.requirementId === "geometry.depth") {
      if (!integer(requirement.expectedValue, 1, S6_MAX_COORDINATE_MM) || requirement.expectedValue !== source.geometrySnapshot.depthMm ||
          requirement.expectedValue !== model.booth.depthMm || !floorMatches(model, "depthMm")) return invalid();
    } else if (requirement.requirementId === "access.open-sides") {
      const sides = parseOpenSideRequirement(requirement.expectedValue);
      const sourceSides = S6_OPEN_SIDE_ORDER.filter((side) => source.geometrySnapshot.openSides.includes(side));
      const modelCanonical = S6_OPEN_SIDE_ORDER.filter((side) => model.booth.openSides.includes(side));
      const wallSides = model.objects.filter((item) => item.role === "booth_wall").map((item) => item.identityKey.replace("booth-wall:", ""));
      const wallIntegrity = S6_OPEN_SIDE_ORDER.every((side) => wallSides.filter((candidate) => candidate === side).length === (sourceSides.includes(side) ? 0 : 1)) &&
        wallSides.every((side) => S6_OPEN_SIDE_ORDER.includes(side as OpenSide));
      if (!sides || !sideSetMatches(sides, sourceSides) || JSON.stringify(model.booth.openSides) !== JSON.stringify(modelCanonical) ||
          !sideSetMatches(modelCanonical, sourceSides) || !wallIntegrity) return invalid();
    } else if (requirement.requirementId === "geometry.max-height") {
      if (source.geometrySnapshot.maxHeightMm === null) return { outcome: "unresolved", codes: ["GEOMETRY_HEIGHT_UNKNOWN"], objects: [] };
      const maxHeightMm = requirement.expectedValue;
      if (typeof maxHeightMm !== "number" || !integer(maxHeightMm, 1, S6_MAX_COORDINATE_MM) || maxHeightMm !== source.geometrySnapshot.maxHeightMm ||
          maxHeightMm !== model.booth.maxHeightMm || model.booth.heightState !== "known") return invalid();
      try {
        const world = deriveS6WorldGeometry(model);
        const tooTall = world.filter((shape) => shape.verticalInterval.top > maxHeightMm).map((shape) => shape.objectId);
        if (tooTall.length > 0) return { outcome: "unsatisfied", codes: ["MAX_HEIGHT_EXCEEDED"], objects: tooTall };
      } catch {
        return { outcome: "unresolved", codes: ["TRANSFORM_INVALID"], objects: [] };
      }
    }
    return { outcome: "satisfied", codes: [], objects: [] };
  };
  const value = base();
  return evaluation(requirement, source, resolution, value.outcome, value.codes, value.objects, [], resolution.boothFields);
}

function sceneContainmentEvaluation(
  requirement: S2Requirement,
  source: S5ToS6Projection,
  model: S6SpatialModelRecord,
  resolution: Extract<S6RequirementResolution, { kind: "scene" }>,
): S6RequirementEvaluation {
  const baseFields = resolution.predicate === "entry_clear" ? ["booth.widthMm", "booth.depthMm", "booth.openSides", "objects.transform"] : ["booth", "objects.transform"];
  if (!currentSourceReady(source) || model.projectId !== source.projectId || model.sourceS5Fingerprint !== source.sourceFingerprint ||
      model.sourceS5ApprovalEventId !== source.approvalEventId || model.sourceS5ApprovalGeneration !== source.approvalGeneration) {
    return evaluation(requirement, source, resolution, "unresolved", ["SOURCE_STALE"], [], [], baseFields);
  }
  const sourceSides = S6_OPEN_SIDE_ORDER.filter((side) => source.geometrySnapshot.openSides.includes(side));
  if (model.booth.widthMm !== source.geometrySnapshot.widthMm || model.booth.depthMm !== source.geometrySnapshot.depthMm ||
      model.booth.maxHeightMm !== source.geometrySnapshot.maxHeightMm || JSON.stringify(model.booth.openSides) !== JSON.stringify(sourceSides) ||
      model.booth.heightState !== (source.geometrySnapshot.maxHeightMm === null ? "unknown" : "known")) {
    return evaluation(requirement, source, resolution, "unsatisfied", ["BOOTH_ENVELOPE_INVALID"], [], [], baseFields);
  }
  try {
    const world = deriveS6WorldGeometry(model);
    const byId = new Map(world.map((shape) => [shape.objectId, shape]));
    const physical = model.objects.filter((object) => object.role !== "booth_floor" && object.role !== "zone" && object.objectType !== "zone_region");
    if (resolution.predicate === "booth_containment") {
      const outside = physical.filter((object) => {
        const shape = byId.get(object.objectId);
        return !shape || !containsS6WorldBooth(shape, model.booth.widthMm, model.booth.depthMm);
      }).map((object) => object.objectId);
      return evaluation(requirement, source, resolution, outside.length === 0 ? "satisfied" : "unsatisfied", outside.length === 0 ? [] : ["CONTAINMENT_INVALID"], outside, [], baseFields);
    }
    if (resolution.predicate === "maximum_height") {
      if (model.booth.maxHeightMm === null || model.booth.heightState !== "known") return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"], [], [], ["booth.maxHeightMm"]);
      const tooTall = physical.filter((object) => (byId.get(object.objectId)?.verticalInterval.top ?? Number.POSITIVE_INFINITY) > model.booth.maxHeightMm!).map((object) => object.objectId);
      return evaluation(requirement, source, resolution, tooTall.length === 0 ? "satisfied" : "unsatisfied", tooTall.length === 0 ? [] : ["MAX_HEIGHT_EXCEEDED"], tooTall, [], ["booth.maxHeightMm", "objects.transform"]);
    }

    if (model.booth.widthMm < 900 || model.booth.depthMm < 900 ||
        (model.booth.maxHeightMm !== null && model.booth.maxHeightMm < 2100)) {
      return evaluation(requirement, source, resolution, "unsatisfied", ["ENTRY_CLEARANCE_OUT_OF_BOUNDS"], [], [], baseFields);
    }
    const sides = S6_OPEN_SIDE_ORDER.filter((side) => model.booth.openSides.includes(side));
    if (sides.length === 0 || JSON.stringify(model.booth.openSides) !== JSON.stringify(sides) || !sideSetMatches(sides, sourceSides)) {
      return evaluation(requirement, source, resolution, "unresolved", ["SOURCE_STALE"], [], [], baseFields);
    }
    const blocked: string[] = [];
    const centeredX = Math.floor((model.booth.widthMm - 900) / 2);
    const centeredZ = Math.floor((model.booth.depthMm - 900) / 2);
    for (const side of sides) {
      const x = side === "west" ? 0 : side === "east" ? model.booth.widthMm - 900 : centeredX;
      const z = side === "north" ? 0 : side === "south" ? model.booth.depthMm - 900 : centeredZ;
      const entry: S6WorldGeometry = {
        objectId: "entry-clear:" + side,
        points: [],
        footprint: { kind: "polygon", points: [{ xMm: x, zMm: z }, { xMm: x + 900, zMm: z }, { xMm: x + 900, zMm: z + 900 }, { xMm: x, zMm: z + 900 }] },
        parts: [{ kind: "polygon", points: [{ xMm: x, zMm: z }, { xMm: x + 900, zMm: z }, { xMm: x + 900, zMm: z + 900 }, { xMm: x, zMm: z + 900 }] }],
        boundsMm: { min: { xMm: x, yMm: 0, zMm: z }, max: { xMm: x + 900, yMm: 2100, zMm: z + 900 } },
        verticalInterval: { base: 0, top: 2100 },
      };
      for (const object of physical) {
        const shape = byId.get(object.objectId);
        if (!shape) return evaluation(requirement, source, resolution, "unresolved", ["TRANSFORM_INVALID"], [object.objectId], [], baseFields);
        const verticalOverlap = Math.min(shape.verticalInterval.top, 2100) - Math.max(shape.verticalInterval.base, 0) > 0;
        if (verticalOverlap && overlapsS6WorldGeometry(shape, entry)) blocked.push(object.objectId);
      }
    }
    return evaluation(requirement, source, resolution, blocked.length === 0 ? "satisfied" : "unsatisfied", blocked.length === 0 ? [] : ["ENTRY_CLEARANCE_BLOCKED"], blocked, [], baseFields);
  } catch {
    return evaluation(requirement, source, resolution, "unresolved", ["TRANSFORM_INVALID"], [], [], baseFields);
  }
}

function isNonphysicalZoneRegion(object: S6SpatialObject, shape: S6WorldGeometry): boolean {
  return object.objectType === "zone_region" && object.role === "zone" && object.parentObjectId === null &&
    object.primitive.kind === "rect_prism" && object.primitive.localAnchor === "floor" &&
    object.primitive.dimensionsMm.heightMm === 1 && object.transform.positionMm.yMm === 0 &&
    shape.verticalInterval.base === 0 && shape.verticalInterval.top === 1;
}

function isImmutableBoothFloor(model: S6SpatialModelRecord, object: S6SpatialObject): boolean {
  return object.role === "booth_floor" && floorMatches(model, "widthMm") && floorMatches(model, "depthMm") &&
    object.objectType === "floor_footprint" && object.parentObjectId === null && !object.editable && !object.removable &&
    object.primitive.kind === "rect_prism" && object.primitive.geometryState === "exact" && object.primitive.localAnchor === "floor" &&
    object.transform.positionMm.xMm === 0 && object.transform.positionMm.yMm === 0 && object.transform.positionMm.zMm === 0 &&
    object.transform.rotationMd.xMd === 0 && object.transform.rotationMd.yMd === 0 && object.transform.rotationMd.zMd === 0;
}

type CeilingCertificateStatus = "EXACT_CERTIFICATE" | "CONSERVATIVE_CERTIFICATE" | "UNCERTIFIABLE_BLOCKING";
type CeilingGeometryVerdict = "DEFINITE_PROHIBITED" | "PROVEN_NON_ENCLOSING" | "AMBIGUOUS_BLOCKING";
type CeilingScalar2 = bigint;
type CeilingPoint3 = [CeilingScalar2, CeilingScalar2, CeilingScalar2];
type CeilingMatrix = [CeilingPoint3, CeilingPoint3, CeilingPoint3];
type CeilingBounds3 = { min: CeilingPoint3; max: CeilingPoint3 };
type CeilingBox = CeilingBounds3 & { objectIds: string[] };
type CeilingInterval = { lower: CeilingScalar2; upper: CeilingScalar2 };
type CeilingObjectCertificate = {
  objectId: string;
  status: CeilingCertificateStatus;
  innerBoxes: CeilingBox[];
  outerBoxes: CeilingBox[];
};
type CeilingAxisStratum = { kind: "point" | "open"; lower: CeilingScalar2; upper: CeilingScalar2 };
type CeilingPlanBox = CeilingBox & { minX: CeilingScalar2; maxX: CeilingScalar2; minZ: CeilingScalar2; maxZ: CeilingScalar2 };
type CeilingOccupancyResult = {
  verdict: CeilingGeometryVerdict;
  certificateStatus: CeilingCertificateStatus;
  objectIds: string[];
};

const CEILING_SCALAR2 = 2n;
const CEILING_LIMIT = 1n << 40n;
const CEILING_INTERMEDIATE_LIMIT = (1n << 127n) - 1n;
const CEILING_BAND_SCALAR2 = 4200n;
const CEILING_STRIP_SCALAR2 = 1800n;
const CEILING_MAX_ANCESTOR_EDGES = 64;
const CEILING_MAX_PROFILE_VERTICES = 24;
const CEILING_MAX_PROFILE_CELLS = 529;
const CEILING_MAX_BOXES_BEFORE_DEDUPE = 4096;
const CEILING_MAX_AXIS_BREAKPOINTS = 257;
const CEILING_MAX_PLAN_STRATA = 65536;
const CEILING_MAX_STRATA_BOX_PRODUCT = 1048576;
const CEILING_MAX_INTERVAL_RECORDS = 4096;
const CEILING_MAX_CERTIFICATE_BYTES = 8388608;

const CEILING_IDENTITY: CeilingMatrix = [
  [1n, 0n, 0n],
  [0n, 1n, 0n],
  [0n, 0n, 1n],
];

function ceilingFail(): never {
  throw new Error("S6_CEILING_UNCERTIFIABLE");
}

function ceilingCheckedIntermediate(value: bigint): bigint {
  if (value > CEILING_INTERMEDIATE_LIMIT || value < -CEILING_INTERMEDIATE_LIMIT) return ceilingFail();
  return value;
}

function ceilingCheckedCoordinate(value: bigint): bigint {
  ceilingCheckedIntermediate(value);
  if (value > CEILING_LIMIT || value < -CEILING_LIMIT) return ceilingFail();
  return value;
}

function ceilingCheckedAdd(left: bigint, right: bigint): bigint {
  return ceilingCheckedIntermediate(left + right);
}

function ceilingCheckedSubtract(left: bigint, right: bigint): bigint {
  return ceilingCheckedIntermediate(left - right);
}

function ceilingCheckedMultiply(left: bigint, right: bigint): bigint {
  return ceilingCheckedIntermediate(left * right);
}

function ceilingScalar2Millimetres(value: number): bigint {
  if (!Number.isSafeInteger(value)) return ceilingFail();
  return ceilingCheckedCoordinate(BigInt(value) * CEILING_SCALAR2);
}

function ceilingMatrixMultiply(left: CeilingMatrix, right: CeilingMatrix): CeilingMatrix {
  const result: CeilingMatrix = [[0n, 0n, 0n], [0n, 0n, 0n], [0n, 0n, 0n]];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let value = 0n;
      for (let inner = 0; inner < 3; inner += 1) value = ceilingCheckedAdd(value, ceilingCheckedMultiply(left[row]![inner]!, right[inner]![column]!));
      result[row]![column] = value;
    }
  }
  return result;
}

function ceilingMatrixApply(matrix: CeilingMatrix, point: CeilingPoint3): CeilingPoint3 {
  return [0, 1, 2].map((row) => {
    let value = 0n;
    for (let column = 0; column < 3; column += 1) value = ceilingCheckedAdd(value, ceilingCheckedMultiply(matrix[row]![column]!, point[column]!));
    return ceilingCheckedCoordinate(value);
  }) as CeilingPoint3;
}

function ceilingQuarterTurnMatrix(axis: "x" | "y" | "z", turns: number): CeilingMatrix {
  const oneTurn: CeilingMatrix = axis === "x"
    ? [[1n, 0n, 0n], [0n, 0n, -1n], [0n, 1n, 0n]]
    : axis === "y"
      ? [[0n, 0n, 1n], [0n, 1n, 0n], [-1n, 0n, 0n]]
      : [[0n, -1n, 0n], [1n, 0n, 0n], [0n, 0n, 1n]];
  let result: CeilingMatrix = CEILING_IDENTITY.map((row) => [...row]) as CeilingMatrix;
  for (let index = 0; index < turns; index += 1) result = ceilingMatrixMultiply(oneTurn, result);
  return result;
}

function ceilingRotationMatrix(rotation: S6SpatialObject["transform"]["rotationMd"]): CeilingMatrix {
  const turns = (value: number): number => {
    if (!Number.isSafeInteger(value) || value % 90000 !== 0) return ceilingFail();
    return ((value / 90000) % 4 + 4) % 4;
  };
  const x = ceilingQuarterTurnMatrix("x", turns(rotation.xMd));
  const y = ceilingQuarterTurnMatrix("y", turns(rotation.yMd));
  const z = ceilingQuarterTurnMatrix("z", turns(rotation.zMd));
  return ceilingMatrixMultiply(ceilingMatrixMultiply(z, y), x);
}

type CeilingTransform = { rotation: CeilingMatrix; translation: CeilingPoint3 };

function ceilingLocalTransform(object: S6SpatialObject): CeilingTransform {
  return {
    rotation: ceilingRotationMatrix(object.transform.rotationMd),
    translation: [
      ceilingScalar2Millimetres(object.transform.positionMm.xMm),
      ceilingScalar2Millimetres(object.transform.positionMm.yMm),
      ceilingScalar2Millimetres(object.transform.positionMm.zMm),
    ],
  };
}

function ceilingComposeTransform(parent: CeilingTransform, local: CeilingTransform): CeilingTransform {
  const translated = ceilingMatrixApply(parent.rotation, local.translation);
  return {
    rotation: ceilingMatrixMultiply(parent.rotation, local.rotation),
    translation: [
      ceilingCheckedCoordinate(ceilingCheckedAdd(parent.translation[0], translated[0])),
      ceilingCheckedCoordinate(ceilingCheckedAdd(parent.translation[1], translated[1])),
      ceilingCheckedCoordinate(ceilingCheckedAdd(parent.translation[2], translated[2])),
    ],
  };
}

function ceilingWorldTransform(
  object: S6SpatialObject,
  byId: ReadonlyMap<string, S6SpatialObject>,
  cache: Map<string, CeilingTransform>,
): CeilingTransform {
  const cached = cache.get(object.objectId);
  if (cached) return cached;
  const chain: S6SpatialObject[] = [];
  const visiting = new Set<string>();
  let current: S6SpatialObject | undefined = object;
  let edges = 0;
  while (current) {
    if (visiting.has(current.objectId)) return ceilingFail();
    visiting.add(current.objectId);
    chain.push(current);
    if (current.parentObjectId === null) break;
    edges += 1;
    if (edges > CEILING_MAX_ANCESTOR_EDGES) return ceilingFail();
    current = byId.get(current.parentObjectId);
    if (!current) return ceilingFail();
  }
  let result: CeilingTransform = {
    rotation: CEILING_IDENTITY.map((row) => [...row]) as CeilingMatrix,
    translation: [0n, 0n, 0n],
  };
  for (let index = chain.length - 1; index >= 0; index -= 1) result = ceilingComposeTransform(result, ceilingLocalTransform(chain[index]!));
  cache.set(object.objectId, result);
  return result;
}

function ceilingWorldBox(local: CeilingBounds3, transform: CeilingTransform, objectId: string): CeilingBox {
  const min: CeilingPoint3 = [0n, 0n, 0n];
  const max: CeilingPoint3 = [0n, 0n, 0n];
  for (let worldAxis = 0; worldAxis < 3; worldAxis += 1) {
    let localAxis = -1;
    let sign = 0n;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = transform.rotation[worldAxis]![axis]!;
      if (value !== 0n) {
        if (localAxis !== -1 || (value !== 1n && value !== -1n)) return ceilingFail();
        localAxis = axis;
        sign = value;
      }
    }
    if (localAxis === -1) return ceilingFail();
    const lower = sign > 0n ? local.min[localAxis]! : -local.max[localAxis]!;
    const upper = sign > 0n ? local.max[localAxis]! : -local.min[localAxis]!;
    min[worldAxis] = ceilingCheckedCoordinate(ceilingCheckedAdd(transform.translation[worldAxis]!, lower));
    max[worldAxis] = ceilingCheckedCoordinate(ceilingCheckedAdd(transform.translation[worldAxis]!, upper));
    if (min[worldAxis]! >= max[worldAxis]!) return ceilingFail();
  }
  return { min, max, objectIds: [objectId] };
}

function ceilingVerticalBounds(primitive: S6GeometryPrimitive): { min: bigint; max: bigint } {
  if (primitive.localAnchor !== "floor" && primitive.localAnchor !== "center") return ceilingFail();
  const heightMm = primitive.kind === "rect_prism" ? primitive.dimensionsMm.heightMm : primitive.heightMm;
  if (!Number.isSafeInteger(heightMm) || heightMm <= 0) return ceilingFail();
  const height2 = ceilingScalar2Millimetres(heightMm);
  return primitive.localAnchor === "floor" ? { min: 0n, max: height2 } : { min: -BigInt(heightMm), max: BigInt(heightMm) };
}

type CeilingProfilePoint = { x: bigint; z: bigint };

function ceilingOrientation(a: CeilingProfilePoint, b: CeilingProfilePoint, c: CeilingProfilePoint): bigint {
  return ceilingCheckedSubtract(
    ceilingCheckedMultiply(ceilingCheckedSubtract(b.x, a.x), ceilingCheckedSubtract(c.z, a.z)),
    ceilingCheckedMultiply(ceilingCheckedSubtract(b.z, a.z), ceilingCheckedSubtract(c.x, a.x)),
  );
}

function ceilingBetween(value: bigint, left: bigint, right: bigint): boolean {
  return value >= (left < right ? left : right) && value <= (left > right ? left : right);
}

function ceilingSegmentsIntersect(a: CeilingProfilePoint, b: CeilingProfilePoint, c: CeilingProfilePoint, d: CeilingProfilePoint): boolean {
  const aHorizontal = a.z === b.z;
  const cHorizontal = c.z === d.z;
  if (aHorizontal && cHorizontal) {
    const aMin = a.x < b.x ? a.x : b.x;
    const aMax = a.x > b.x ? a.x : b.x;
    const cMin = c.x < d.x ? c.x : d.x;
    const cMax = c.x > d.x ? c.x : d.x;
    return a.z === c.z && (aMin > cMin ? aMin : cMin) <= (aMax < cMax ? aMax : cMax);
  }
  if (!aHorizontal && !cHorizontal) {
    const aMin = a.z < b.z ? a.z : b.z;
    const aMax = a.z > b.z ? a.z : b.z;
    const cMin = c.z < d.z ? c.z : d.z;
    const cMax = c.z > d.z ? c.z : d.z;
    return a.x === c.x && (aMin > cMin ? aMin : cMin) <= (aMax < cMax ? aMax : cMax);
  }
  const horizontalA = aHorizontal ? a : c;
  const horizontalB = aHorizontal ? b : d;
  const verticalA = aHorizontal ? c : a;
  const verticalB = aHorizontal ? d : b;
  return ceilingBetween(verticalA.x, horizontalA.x, horizontalB.x) && ceilingBetween(horizontalA.z, verticalA.z, verticalB.z);
}

function ceilingProfileIsInside(points: readonly CeilingProfilePoint[], xTwice: bigint, zTwice: bigint): boolean {
  let inside = false;
  for (let index = 0; index < points.length; index += 1) {
    const left = points[index]!;
    const right = points[(index + 1) % points.length]!;
    if (left.x !== right.x) continue;
    const lower = left.z < right.z ? left.z : right.z;
    const upper = left.z > right.z ? left.z : right.z;
    if (ceilingCheckedMultiply(lower, 2n) <= zTwice && zTwice < ceilingCheckedMultiply(upper, 2n) &&
        ceilingCheckedMultiply(left.x, 2n) > xTwice) inside = !inside;
  }
  return inside;
}

function ceilingProfileBoxes(primitive: Extract<S6GeometryPrimitive, { kind: "profile_extrusion" }>): CeilingBounds3[] {
  if (primitive.profile.winding !== "ccw-from-positive-y-v1") return ceilingFail();
  const vertices = primitive.profile.vertices;
  if (vertices.length < 4 || vertices.length > CEILING_MAX_PROFILE_VERTICES) return ceilingFail();
  const points = vertices.map((vertex) => ({
    x: ceilingScalar2Millimetres(vertex.xMm),
    z: ceilingScalar2Millimetres(vertex.zMm),
  }));
  let area2 = 0n;
  for (let index = 0; index < points.length; index += 1) {
    const left = points[index]!;
    const right = points[(index + 1) % points.length]!;
    const horizontal = left.z === right.z;
    const vertical = left.x === right.x;
    if (horizontal === vertical) return ceilingFail();
    area2 = ceilingCheckedAdd(area2, ceilingCheckedSubtract(ceilingCheckedMultiply(left.x, right.z), ceilingCheckedMultiply(right.x, left.z)));
  }
  if (area2 >= 0n) return ceilingFail();
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === points.length - 1)) continue;
      if (ceilingSegmentsIntersect(points[first]!, points[(first + 1) % points.length]!, points[second]!, points[(second + 1) % points.length]!)) return ceilingFail();
    }
  }
  const xs = [...new Set(points.map((point) => point.x))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const zs = [...new Set(points.map((point) => point.z))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const candidates = (xs.length - 1) * (zs.length - 1);
  if (candidates <= 0 || candidates > CEILING_MAX_PROFILE_CELLS) return ceilingFail();
  const vertical = ceilingVerticalBounds(primitive);
  const result: CeilingBounds3[] = [];
  for (let xIndex = 0; xIndex + 1 < xs.length; xIndex += 1) {
    for (let zIndex = 0; zIndex + 1 < zs.length; zIndex += 1) {
      const x0 = xs[xIndex]!;
      const x1 = xs[xIndex + 1]!;
      const z0 = zs[zIndex]!;
      const z1 = zs[zIndex + 1]!;
      if (!ceilingProfileIsInside(points, ceilingCheckedAdd(x0, x1), ceilingCheckedAdd(z0, z1))) continue;
      result.push({ min: [x0, vertical.min, z0], max: [x1, vertical.max, z1] });
    }
  }
  if (result.length === 0) return ceilingFail();
  return result;
}

function ceilingRectBounds(primitive: Extract<S6GeometryPrimitive, { kind: "rect_prism" }>): CeilingBounds3 {
  const { widthMm, depthMm } = primitive.dimensionsMm;
  if (!Number.isSafeInteger(widthMm) || !Number.isSafeInteger(depthMm) || widthMm <= 0 || depthMm <= 0) return ceilingFail();
  const vertical = ceilingVerticalBounds(primitive);
  return {
    min: [0n, vertical.min, 0n],
    max: [ceilingScalar2Millimetres(widthMm), vertical.max, ceilingScalar2Millimetres(depthMm)],
  };
}

function ceilingRoundBounds(primitive: Extract<S6GeometryPrimitive, { kind: "round_prism" }>, inner: boolean): CeilingBounds3 {
  if (!Number.isSafeInteger(primitive.radiusMm) || primitive.radiusMm <= 0) return ceilingFail();
  const radius2 = ceilingScalar2Millimetres(primitive.radiusMm);
  const halfRadius2 = BigInt(primitive.radiusMm);
  const extent = inner ? halfRadius2 : radius2;
  const vertical = ceilingVerticalBounds(primitive);
  return {
    min: [-extent, vertical.min, -extent],
    max: [extent, vertical.max, extent],
  };
}

function ceilingObjectCertificate(
  object: S6SpatialObject,
  byId: ReadonlyMap<string, S6SpatialObject>,
  transformCache: Map<string, CeilingTransform>,
): CeilingObjectCertificate {
  const transform = ceilingWorldTransform(object, byId, transformCache);
  let innerLocal: CeilingBounds3[];
  let outerLocal: CeilingBounds3[];
  let status: CeilingCertificateStatus;
  if (object.primitive.geometryState !== "exact" && object.primitive.geometryState !== "bounded_inference") return ceilingFail();
  if (object.primitive.kind === "rect_prism") {
    const box = ceilingRectBounds(object.primitive);
    innerLocal = [box];
    outerLocal = [box];
    status = "EXACT_CERTIFICATE";
  } else if (object.primitive.kind === "profile_extrusion") {
    const boxes = ceilingProfileBoxes(object.primitive);
    innerLocal = boxes;
    outerLocal = boxes;
    status = "EXACT_CERTIFICATE";
  } else if (object.primitive.kind === "round_prism") {
    innerLocal = [ceilingRoundBounds(object.primitive, true)];
    outerLocal = [ceilingRoundBounds(object.primitive, false)];
    status = "CONSERVATIVE_CERTIFICATE";
  } else {
    return ceilingFail();
  }
  return {
    objectId: object.objectId,
    status,
    innerBoxes: innerLocal.map((box) => ceilingWorldBox(box, transform, object.objectId)),
    outerBoxes: outerLocal.map((box) => ceilingWorldBox(box, transform, object.objectId)),
  };
}

function ceilingBoxKey(box: CeilingBox): string {
  return [...box.min, ...box.max].map((value) => value.toString()).join(":");
}

function ceilingDeduplicateBoxes(boxes: readonly CeilingBox[]): CeilingBox[] {
  const unique = new Map<string, CeilingBox>();
  for (const box of boxes) {
    const key = ceilingBoxKey(box);
    const previous = unique.get(key);
    if (previous) previous.objectIds = [...new Set([...previous.objectIds, ...box.objectIds])].sort();
    else unique.set(key, { min: [...box.min], max: [...box.max], objectIds: [...box.objectIds].sort() });
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = ceilingBoxKey(left);
    const rightKey = ceilingBoxKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function ceilingClipBoxes(boxes: readonly CeilingBox[], width: bigint, depth: bigint): CeilingPlanBox[] {
  const clipped: CeilingPlanBox[] = [];
  for (const box of boxes) {
    const minX = box.min[0] < 0n ? 0n : box.min[0];
    const maxX = box.max[0] > width ? width : box.max[0];
    const minZ = box.min[2] < 0n ? 0n : box.min[2];
    const maxZ = box.max[2] > depth ? depth : box.max[2];
    if (minX >= maxX || minZ >= maxZ) continue;
    clipped.push({ ...box, minX, maxX, minZ, maxZ });
  }
  return clipped;
}

function ceilingUniqueSorted(values: readonly bigint[]): bigint[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function ceilingAxisStrata(boundaries: readonly bigint[]): CeilingAxisStratum[] {
  const strata: CeilingAxisStratum[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const value = boundaries[index]!;
    strata.push({ kind: "point", lower: value, upper: value });
    if (index + 1 < boundaries.length) strata.push({ kind: "open", lower: value, upper: boundaries[index + 1]! });
  }
  return strata;
}

function ceilingCoversStratum(lower: bigint, upper: bigint, stratum: CeilingAxisStratum): boolean {
  return lower <= stratum.lower && upper >= stratum.upper;
}

function ceilingMergeIntervals(intervals: readonly CeilingInterval[]): CeilingInterval[] {
  const sorted = intervals.slice().sort((left, right) => left.lower < right.lower ? -1 : left.lower > right.lower ? 1 :
    left.upper < right.upper ? -1 : left.upper > right.upper ? 1 : 0);
  const merged: CeilingInterval[] = [];
  for (const interval of sorted) {
    if (interval.lower >= interval.upper) return ceilingFail();
    const previous = merged.at(-1);
    if (previous && interval.lower <= previous.upper) {
      if (interval.upper > previous.upper) previous.upper = interval.upper;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function ceilingIntersectIntervalSets(left: readonly CeilingInterval[], right: readonly CeilingInterval[]): CeilingInterval[] {
  const result: CeilingInterval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    const lower = a.lower > b.lower ? a.lower : b.lower;
    const upper = a.upper < b.upper ? a.upper : b.upper;
    if (lower <= upper) result.push({ lower, upper });
    if (a.upper < b.upper) leftIndex += 1;
    else rightIndex += 1;
  }
  return ceilingMergeTouchingIntervals(result);
}

function ceilingMergeTouchingIntervals(intervals: readonly CeilingInterval[]): CeilingInterval[] {
  const sorted = intervals.slice().sort((left, right) => left.lower < right.lower ? -1 : left.lower > right.lower ? 1 :
    left.upper < right.upper ? -1 : left.upper > right.upper ? 1 : 0);
  const merged: CeilingInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.lower <= previous.upper) {
      if (interval.upper > previous.upper) previous.upper = interval.upper;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function ceilingHasFullSpanStrip(blocked: readonly boolean[], boundaries: readonly bigint[]): boolean {
  let openWidth = 0n;
  for (let index = 0; index < blocked.length; index += 1) {
    if (blocked[index]) openWidth = 0n;
    else {
      openWidth = ceilingCheckedAdd(openWidth, ceilingCheckedSubtract(boundaries[index + 1]!, boundaries[index]!));
      if (openWidth >= CEILING_STRIP_SCALAR2) return true;
    }
  }
  return false;
}

function isStructuralNonphysicalZoneRegion(object: S6SpatialObject): boolean {
  return object.objectType === "zone_region" && object.role === "zone" && object.parentObjectId === null &&
    object.primitive.kind === "rect_prism" && object.primitive.localAnchor === "floor" &&
    object.primitive.dimensionsMm.heightMm === 1 && object.transform.positionMm.yMm === 0 &&
    object.transform.rotationMd.xMd === 0 && object.transform.rotationMd.yMd === 0 && object.transform.rotationMd.zMd === 0;
}

function certifiedCeilingOccupancy(model: S6SpatialModelRecord, physicalObjects: readonly S6SpatialObject[]): CeilingOccupancyResult {
  const blocked = (ids: readonly string[]): CeilingOccupancyResult => ({
    verdict: "AMBIGUOUS_BLOCKING",
    certificateStatus: "UNCERTIFIABLE_BLOCKING",
    objectIds: [...new Set(ids)].sort(),
  });
  if (model.objects.length > S6_MAX_OBJECTS || physicalObjects.length > S6_MAX_OBJECTS) return blocked(physicalObjects.map((item) => item.objectId));
  if (!Number.isSafeInteger(model.booth.widthMm) || !Number.isSafeInteger(model.booth.depthMm) ||
      model.booth.widthMm <= 0 || model.booth.depthMm <= 0) return blocked(physicalObjects.map((item) => item.objectId));
  const width = ceilingScalar2Millimetres(model.booth.widthMm);
  const depth = ceilingScalar2Millimetres(model.booth.depthMm);
  const byId = new Map<string, S6SpatialObject>();
  const duplicateIds = new Set<string>();
  for (const object of model.objects) {
    if (byId.has(object.objectId)) duplicateIds.add(object.objectId);
    else byId.set(object.objectId, object);
  }
  if (duplicateIds.size > 0) return blocked([...duplicateIds]);
  const transformCache = new Map<string, CeilingTransform>();
  const certificates: CeilingObjectCertificate[] = [];
  const uncertifiableIds: string[] = [];
  let boxesBeforeDedupe = 0;
  for (const object of physicalObjects.slice().sort((left, right) => left.objectId.localeCompare(right.objectId))) {
    try {
      const certificate = ceilingObjectCertificate(object, byId, transformCache);
      certificates.push(certificate);
      boxesBeforeDedupe += certificate.innerBoxes.length + certificate.outerBoxes.length;
      if (boxesBeforeDedupe > CEILING_MAX_BOXES_BEFORE_DEDUPE) return blocked(physicalObjects.map((item) => item.objectId));
    } catch {
      certificates.push({ objectId: object.objectId, status: "UNCERTIFIABLE_BLOCKING", innerBoxes: [], outerBoxes: [] });
      uncertifiableIds.push(object.objectId);
    }
  }
  if (uncertifiableIds.length > 0) return blocked(uncertifiableIds);
  const certificateStatus: CeilingCertificateStatus = certificates.some((item) => item.status === "CONSERVATIVE_CERTIFICATE")
    ? "CONSERVATIVE_CERTIFICATE" : "EXACT_CERTIFICATE";
  const innerBoxes = ceilingDeduplicateBoxes(certificates.flatMap((item) => item.innerBoxes));
  const outerBoxes = ceilingDeduplicateBoxes(certificates.flatMap((item) => item.outerBoxes));
  const clippedInner = ceilingClipBoxes(innerBoxes, width, depth);
  const clippedOuter = ceilingClipBoxes(outerBoxes, width, depth);
  const allBoxes = [...clippedInner, ...clippedOuter];
  const xBoundaries = ceilingUniqueSorted([0n, width, ...allBoxes.flatMap((box) => [box.minX, box.maxX])]);
  const zBoundaries = ceilingUniqueSorted([0n, depth, ...allBoxes.flatMap((box) => [box.minZ, box.maxZ])]);
  if (xBoundaries.length > CEILING_MAX_AXIS_BREAKPOINTS || zBoundaries.length > CEILING_MAX_AXIS_BREAKPOINTS) return blocked(physicalObjects.map((item) => item.objectId));
  const xStrata = ceilingAxisStrata(xBoundaries);
  const zStrata = ceilingAxisStrata(zBoundaries);
  const planStrata = xStrata.length * zStrata.length;
  const totalBoxRecords = innerBoxes.length + outerBoxes.length;
  if (planStrata > CEILING_MAX_PLAN_STRATA || planStrata * totalBoxRecords > CEILING_MAX_STRATA_BOX_PRODUCT) {
    return blocked(physicalObjects.map((item) => item.objectId));
  }
  const certificatePayload = JSON.stringify({
    version: "certified-column-occupancy-v1",
    certificates: certificates.map((item) => [item.objectId, item.status]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    inner: innerBoxes.map((box) => ({ bounds: [...box.min, ...box.max].map(String), objectIds: box.objectIds })),
    outer: outerBoxes.map((box) => ({ bounds: [...box.min, ...box.max].map(String), objectIds: box.objectIds })),
    xBoundaries: xBoundaries.map(String),
    zBoundaries: zBoundaries.map(String),
  });
  const encoder = new TextEncoder();
  let certificateBytes = encoder.encode(certificatePayload).byteLength + 1;
  if (certificateBytes > CEILING_MAX_CERTIFICATE_BYTES) return blocked(physicalObjects.map((item) => item.objectId));

  const xOpenCount = Math.max(0, xBoundaries.length - 1);
  const zOpenCount = Math.max(0, zBoundaries.length - 1);
  const overheadCells = Array.from({ length: xOpenCount }, () => Array.from({ length: zOpenCount }, () => false));
  let commonHeights: CeilingInterval[] | null = null;
  const overheadCandidateIds = new Set(clippedOuter.filter((box) => box.max[1] > CEILING_BAND_SCALAR2).flatMap((box) => box.objectIds));
  for (let xIndex = 0; xIndex < xStrata.length; xIndex += 1) {
    const xStratum = xStrata[xIndex]!;
    for (let zIndex = 0; zIndex < zStrata.length; zIndex += 1) {
      const zStratum = zStrata[zIndex]!;
      const innerIntervals = ceilingMergeIntervals(clippedInner
        .filter((box) => ceilingCoversStratum(box.minX, box.maxX, xStratum) && ceilingCoversStratum(box.minZ, box.maxZ, zStratum))
        .map((box) => ({ lower: box.min[1], upper: box.max[1] })));
      const outerIntervals = ceilingMergeIntervals(clippedOuter
        .filter((box) => ceilingCoversStratum(box.minX, box.maxX, xStratum) && ceilingCoversStratum(box.minZ, box.maxZ, zStratum))
        .map((box) => ({ lower: box.min[1], upper: box.max[1] })));
      if (innerIntervals.length + outerIntervals.length > CEILING_MAX_INTERVAL_RECORDS) return blocked([...overheadCandidateIds]);
      const floorComponent = innerIntervals.find((interval) => interval.lower <= 0n && interval.upper > 0n);
      const top = outerIntervals.reduce<bigint | null>((maximum, interval) => maximum === null || interval.upper > maximum ? interval.upper : maximum, null);
      const possibleOverhead = top !== null && top > CEILING_BAND_SCALAR2 && (floorComponent === undefined || top > floorComponent.upper);
      if (xStratum.kind === "open" && zStratum.kind === "open" && possibleOverhead) {
        overheadCells[xIndex >> 1]![zIndex >> 1] = true;
      }
      const eligible = innerIntervals.filter((inner) =>
        outerIntervals.some((outer) => outer.lower > 0n && outer.lower <= inner.lower && outer.upper >= inner.upper));
      const stratumPayload = JSON.stringify({
        x: [xStratum.kind, xStratum.lower.toString(), xStratum.upper.toString()],
        z: [zStratum.kind, zStratum.lower.toString(), zStratum.upper.toString()],
        inner: innerIntervals.map((interval) => [interval.lower.toString(), interval.upper.toString()]),
        outer: outerIntervals.map((interval) => [interval.lower.toString(), interval.upper.toString()]),
        floor: floorComponent ? [floorComponent.lower.toString(), floorComponent.upper.toString()] : null,
        top: top?.toString() ?? null,
        possibleOverhead,
        eligible: eligible.map((interval) => [interval.lower.toString(), interval.upper.toString()]),
      });
      certificateBytes += encoder.encode(stratumPayload).byteLength + 1;
      if (certificateBytes > CEILING_MAX_CERTIFICATE_BYTES) return blocked(physicalObjects.map((item) => item.objectId));
      if (commonHeights === null) commonHeights = eligible.map((interval) => ({ ...interval }));
      else commonHeights = ceilingIntersectIntervalSets(commonHeights, eligible);
      if (commonHeights.length > CEILING_MAX_INTERVAL_RECORDS) return blocked([...overheadCandidateIds]);
    }
  }
  const blockedX = overheadCells.map((cells) => cells.some(Boolean));
  const blockedZ = Array.from({ length: zOpenCount }, (_, zIndex) => overheadCells.some((cells) => cells[zIndex]));
  const overheadEmpty = !blockedX.some(Boolean) && !blockedZ.some(Boolean);
  const clearStrip = ceilingHasFullSpanStrip(blockedX, xBoundaries) || ceilingHasFullSpanStrip(blockedZ, zBoundaries);
  const definiteClosure = (commonHeights ?? []).some((interval) => interval.upper > CEILING_BAND_SCALAR2);
  const verdict: CeilingGeometryVerdict = definiteClosure ? "DEFINITE_PROHIBITED" :
    overheadEmpty || clearStrip ? "PROVEN_NON_ENCLOSING" : "AMBIGUOUS_BLOCKING";
  certificateBytes += encoder.encode(JSON.stringify({
    certificateStatus,
    definiteClosure,
    commonHeights: (commonHeights ?? []).map((interval) => [interval.lower.toString(), interval.upper.toString()]),
    overheadCells,
    overheadEmpty,
    clearStrip,
    verdict,
  })).byteLength + 1;
  if (certificateBytes > CEILING_MAX_CERTIFICATE_BYTES) return blocked(physicalObjects.map((item) => item.objectId));
  if (definiteClosure) return { verdict, certificateStatus, objectIds: [...overheadCandidateIds].sort() };
  return {
    verdict,
    certificateStatus,
    objectIds: overheadEmpty || clearStrip ? [] : [...overheadCandidateIds].sort(),
  };
}

function prohibitedEvaluation(
  requirement: S2Requirement,
  source: S5ToS6Projection,
  model: S6SpatialModelRecord,
  resolution: Extract<S6RequirementResolution, { kind: "prohibited" }>,
): S6RequirementEvaluation {
  const immutableFloorId = model.objects.find((object) => isImmutableBoothFloor(model, object))?.objectId;
  if (resolution.family === "screen") {
    let world: ReturnType<typeof deriveS6WorldGeometry>;
    try {
      world = deriveS6WorldGeometry(model);
    } catch {
      return evaluation(requirement, source, resolution, "unresolved", ["TRANSFORM_INVALID"]);
    }
    const byId = new Map(world.map((shape) => [shape.objectId, shape]));
    const physicalObjects = model.objects.filter((object) => {
      const shape = byId.get(object.objectId);
      return object.objectId !== immutableFloorId && shape !== undefined && !isNonphysicalZoneRegion(object, shape);
    });
    const present: string[] = [];
    const ambiguous: string[] = [];
    for (const object of physicalObjects) {
      const label = normalizedRequirementWords(object.label + " " + object.identityKey).join(" ");
      if (object.objectType === "screen" || object.role === "screen") present.push(object.objectId);
      else if (label.includes("screen")) ambiguous.push(object.objectId);
    }
    const mapped = model.objects.filter((object) => object.requirementIds.includes(requirement.requirementId)).map((object) => object.objectId);
    if (present.length > 0) return evaluation(requirement, source, resolution, "unsatisfied", ["PROHIBITED_CONTENT_PRESENT", ...(mapped.length > 0 ? ["REQUIREMENT_MAPPING_INVALID"] : [])], [...present, ...mapped]);
    if (ambiguous.length > 0) return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"], [...ambiguous, ...mapped]);
    if (mapped.length > 0) return evaluation(requirement, source, resolution, "unsatisfied", ["REQUIREMENT_MAPPING_INVALID"], mapped);
    return evaluation(requirement, source, resolution, "satisfied");
  }

  const physicalObjects = model.objects.filter((object) =>
    object.objectId !== immutableFloorId && !isStructuralNonphysicalZoneRegion(object));
  let cover: CeilingOccupancyResult;
  try {
    cover = certifiedCeilingOccupancy(model, physicalObjects);
  } catch {
    return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"]);
  }
  if (cover.certificateStatus === "UNCERTIFIABLE_BLOCKING") {
    return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"], cover.objectIds);
  }
  if (cover.verdict === "DEFINITE_PROHIBITED") {
    return evaluation(requirement, source, resolution, "unsatisfied", ["PROHIBITED_CONTENT_PRESENT"], cover.objectIds);
  }
  if (cover.verdict === "AMBIGUOUS_BLOCKING") {
    return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"], cover.objectIds);
  }
  return evaluation(requirement, source, resolution, "satisfied");
}

function objectRequirementEvaluation(
  requirement: S2Requirement,
  source: S5ToS6Projection,
  model: S6SpatialModelRecord,
  resolution: Extract<S6RequirementResolution, { kind: "object" }>,
  duplicatedIds: ReadonlySet<string>,
): S6RequirementEvaluation {
  const objects = model.objects.filter((object) => familyPresent(object, resolution) && object.role !== "booth_floor" && object.role !== "booth_wall" && object.role !== "zone");
  const mapped = model.objects.filter((object) => object.requirementIds.includes(requirement.requirementId));
  const invalidMappings = mapped.filter((object) => {
    const occurrences = object.requirementIds.filter((id) => id === requirement.requirementId).length;
    return occurrences !== 1 || !familyObjectMatches(object, resolution, model, source) || duplicatedIds.has(object.objectId) ||
      hasInvalidFunctionalCoallocation(object, requirement, source);
  }).map((object) => object.objectId);
  const distinctMapped = [...new Set(mapped.filter((object) => familyObjectMatches(object, resolution, model, source) && !duplicatedIds.has(object.objectId) && object.requirementIds.filter((id) => id === requirement.requirementId).length === 1).map((object) => object.objectId))];
  const distinctMappedSet = new Set(distinctMapped);
  const unallocated = requirement.expected === "exact_count" ? objects.filter((object) => {
    if (!familyObjectMatches(object, resolution, model, source) || duplicatedIds.has(object.objectId) || distinctMappedSet.has(object.objectId)) return false;
    return !validOtherRequirementAllocation(object, requirement, model, source, duplicatedIds);
  }).map((object) => object.objectId) : [];

  if (requirement.expected === "absent" || (requirement.expected === "exact_count" && requirement.expectedCount === 0)) {
    const found = objects.map((object) => object.objectId);
    const invalid = invalidMappings.length > 0;
    return evaluation(requirement, source, resolution, found.length === 0 && !invalid ? "satisfied" : "unsatisfied", found.length === 0 && !invalid ? [] : ["REQUIRED_COUNT_MISMATCH", ...(invalid ? ["REQUIREMENT_MAPPING_INVALID"] : [])], [...found, ...invalidMappings]);
  }
  const expected = requirement.expected === "exact_count" ? requirement.expectedCount! : null;
  const countPass = requirement.expected === "present" ? distinctMapped.length >= 1 : distinctMapped.length === expected;
  const unallocatedFail = unallocated.length > 0;
  const codes: string[] = [];
  if (!countPass || unallocatedFail) codes.push("REQUIRED_COUNT_MISMATCH");
  if (invalidMappings.length > 0) codes.push("REQUIREMENT_MAPPING_INVALID", "REQUIREMENT_OBJECT_INCOMPATIBLE");
  const outcome = codes.length > 0 ? "unsatisfied" : "satisfied";
  return evaluation(requirement, source, resolution, outcome, codes, [...distinctMapped, ...invalidMappings, ...unallocated]);
}

/** Recompute S6 requirement evidence from the current immutable S5 projection and model. */
export function evaluateS6Requirements(model: S6SpatialModelRecord, source: S5ToS6Projection): S6RequirementEvaluation[] {
  const duplicatedIds = new Set(model.objects.filter((object, index) => model.objects.findIndex((candidate) => candidate.objectId === object.objectId) !== index).map((object) => object.objectId));
  const ordered = source.canonicalRequirements.slice().sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  const seen = new Set<string>();
  return ordered.map((requirement) => {
    const resolution = resolveS6Requirement(requirement, source);
    if (seen.has(requirement.requirementId)) return evaluation(requirement, source, resolution, "unresolved", ["REQUIREMENT_MAPPING_INVALID"]);
    seen.add(requirement.requirementId);
    if (!currentSourceReady(source) || model.projectId !== source.projectId || model.sourceS5Fingerprint !== source.sourceFingerprint ||
        model.sourceS5ApprovalEventId !== source.approvalEventId || model.sourceS5ApprovalGeneration !== source.approvalGeneration) {
      return evaluation(requirement, source, resolution, "unresolved", ["SOURCE_STALE"], [], [], resolution.kind === "geometry" ? resolution.boothFields : []);
    }
    if (resolution.kind === "unresolved") return evaluation(requirement, source, resolution, "unresolved", [resolution.issueCode]);
    if (resolution.kind === "geometry") return geometryRequirementEvaluation(requirement, source, model, resolution);
    if (resolution.kind === "object") return objectRequirementEvaluation(requirement, source, model, resolution, duplicatedIds);
    if (resolution.kind === "scene") {
      const mapped = model.objects.filter((object) => object.requirementIds.includes(requirement.requirementId)).map((object) => object.objectId);
      if (mapped.length > 0) return evaluation(requirement, source, resolution, "unsatisfied", ["REQUIREMENT_MAPPING_INVALID"], mapped);
      return sceneContainmentEvaluation(requirement, source, model, resolution);
    }
    if (resolution.kind === "prohibited") return prohibitedEvaluation(requirement, source, model, resolution);
    const matchingZones = model.zones.filter((zone) => zone.requirementIds.includes(requirement.requirementId));
    let worldById: Map<string, ReturnType<typeof deriveS6WorldGeometry>[number]>;
    try {
      worldById = new Map(deriveS6WorldGeometry(model).map((shape) => [shape.objectId, shape]));
    } catch {
      return evaluation(requirement, source, resolution, "unresolved", ["TRANSFORM_INVALID"]);
    }
    const zoneIdentityCounts = new Map<string, number>();
    for (const zone of model.zones) zoneIdentityCounts.set(zone.zoneId, (zoneIdentityCounts.get(zone.zoneId) ?? 0) + 1);
    const validZones = matchingZones.filter((zone) => {
      const regions = model.objects.filter((object) => object.objectId === zone.regionObjectId);
      const region = regions[0];
      const shape = region ? worldById.get(region.objectId) : undefined;
      const sourceZones = source.layoutPlan.zones.filter((candidate) => candidate.zoneId === zone.zoneId && candidate.requirementIds.includes(requirement.requirementId));
      const sourceZone = sourceZones[0];
      const expectedSourceRef = "s5:layoutPlan.zones." + zone.zoneId;
      return zoneIdentityCounts.get(zone.zoneId) === 1 && sourceZones.length === 1 && sourceZone !== undefined && resolution.category === sourceZone.category &&
        zone.category === sourceZone.category && zone.provenance.sourceFingerprint === source.sourceFingerprint && zone.provenance.sourceRef === expectedSourceRef &&
        zone.provenance.kind === "bounded_design_inference" && regions.length === 1 &&
        Boolean(region && region.role === "zone" && region.objectType === "zone_region" && region.zoneIds.filter((id) => id === zone.zoneId).length === 1 &&
          region.provenance.sourceFingerprint === source.sourceFingerprint && region.provenance.sourceRef === expectedSourceRef &&
          region.provenance.kind === "bounded_design_inference" && shape && containsS6WorldBooth(shape, model.booth.widthMm, model.booth.depthMm));
    });
    const validIds = [...new Set(validZones.map((zone) => zone.zoneId))];
    const expected = requirement.expected === "exact_count" ? requirement.expectedCount! : 1;
    const invalidMappedZones = matchingZones.length !== validZones.length;
    const countPass = !invalidMappedZones && (requirement.expected === "absent" ? matchingZones.length === 0 :
      requirement.expected === "present" ? validIds.length >= 1 : validIds.length === expected);
    return evaluation(requirement, source, resolution, countPass ? "satisfied" : "unsatisfied", countPass ? [] : ["REQUIRED_COUNT_MISMATCH"], [], validIds);
  });
}

function validateRequirements(model: S6SpatialModelRecord, context: S6ValidationContext, bag: IssueBag): void {
  const requirementById = new Map(context.source.canonicalRequirements.map((item) => [item.requirementId, item]));
  for (const object of model.objects) {
    const seen = new Set<string>();
    for (const requirementId of object.requirementIds) {
      const requirement = requirementById.get(requirementId);
      const resolution = requirement ? resolveS6Requirement(requirement, context.source) : null;
      if (!requirement || seen.has(requirementId) || resolution?.kind !== "object") {
        issue(bag, "REQUIREMENT_MAPPING_INVALID", "objects[" + object.objectId + "].requirementIds", object.objectId, requirementId);
      }
      seen.add(requirementId);
    }
  }
  for (const zone of model.zones) {
    const seen = new Set<string>();
    for (const requirementId of zone.requirementIds) {
      const requirement = requirementById.get(requirementId);
      const resolution = requirement ? resolveS6Requirement(requirement, context.source) : null;
      if (!requirement || seen.has(requirementId) || resolution?.kind !== "zone") {
        issue(bag, "REQUIREMENT_MAPPING_INVALID", "zones[" + zone.zoneId + "].requirementIds", null, requirementId);
      }
      seen.add(requirementId);
    }
  }
  const evaluations = evaluateS6Requirements(model, context.source);
  for (const result of evaluations) {
    if (result.outcome === "satisfied") continue;
    const codes = result.issueCodes.length > 0 ? result.issueCodes : ["REQUIREMENT_MAPPING_INVALID"];
    for (const code of codes) issue(bag, code, "requirements." + result.requirementId, result.objectIds[0] ?? null, result.requirementId);
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
  receipt.validationHash = hashS6ValidationReceipt(receipt);
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
