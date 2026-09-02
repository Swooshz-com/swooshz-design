import {
  compilerObjectId,
  hashS6Model,
  normalizeS6Geometry,
  normalizeS6Rotation,
  S6_MAX_PHYSICAL_MM,
  S6_MIN_PHYSICAL_MM,
  S6_OPEN_SIDE_ORDER,
  S6_SPATIAL_SCHEMA_VERSION,
} from "./s6-canonical";
import type {
  OpenSide,
  S2Requirement,
  S5LayoutZone,
  S5ToS6Projection,
  S5ZoneCategory,
  S6Assumption,
  S6BoothEnvelope,
  S6DesignFormReview,
  S6GeometryPrimitive,
  S6MaterialFinishKind,
  S6MaterialFinishRef,
  S6ObjectRole,
  S6PrimitiveKind,
  S6Provenance,
  S6SpatialModelRecord,
  S6SpatialObject,
  S6Transform,
  S6Unknown,
  S6Zone,
  Timestamp,
  UUID,
} from "./types";

export type S6CompilerInput = {
  source: S5ToS6Projection;
  revisionId: UUID;
  parentRevisionId: UUID | null;
  clock: () => Timestamp;
};

const CATEGORY_ORDER: readonly S5ZoneCategory[] = [
  "reception_welcome",
  "presentation_display",
  "demo_product",
  "consultation_meeting",
  "storage",
  "interactive_activity",
  "photo_branding",
  "giveaway_brochure",
  "other_confirmed",
];

const DEFAULT_COLORS = ["#808080", "#336699", "#8a6a44", "#9a9a9a"] as const;

const CONVENTION = {
  version: "booth-local-right-handed-v1",
  units: "millimetres",
  handedness: "right-handed",
  origin: "north-west-floor-corner",
  xAxis: "east",
  yAxis: "up",
  zAxis: "south",
} as const;

function words(value: string | null | undefined): string[] {
  return value?.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean) ?? [];
}

function hasAny(value: string, terms: readonly string[]): boolean {
  const valueWords = words(value);
  return terms.some((term) => {
    const termWords = words(term);
    return termWords.length > 0 && termWords.every((item) => valueWords.includes(item));
  });
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized ? Array.from(normalized).slice(0, 120).join("") : fallback;
}

function sourceProvenance(source: S5ToS6Projection, sourceRef: string, note: string, kind: S6Provenance["kind"] = "bounded_design_inference"): S6Provenance {
  return {
    kind,
    sourceRef,
    sourceFingerprint: source.sourceFingerprint,
    acceptedByUser: false,
    note,
  };
}

function inferredProvenance(source: S5ToS6Projection, sourceRef: string, note: string): S6Provenance {
  return sourceProvenance(source, sourceRef, note, "bounded_design_inference");
}

function canonicalProvenance(source: S5ToS6Projection, sourceRef: string, note: string): S6Provenance {
  return sourceProvenance(source, sourceRef, note, "confirmed_project_input");
}

function categoryFor(zone: S5LayoutZone | undefined, requirement: S2Requirement): S5ZoneCategory {
  if (zone) return zone.category;
  const text = requirement.text + " " + String(requirement.expectedValue ?? "");
  if (hasAny(text, ["reception", "welcome", "counter", "desk"])) return "reception_welcome";
  if (hasAny(text, ["display", "showcase", "screen", "presentation"])) return "presentation_display";
  if (hasAny(text, ["demo", "product"])) return "demo_product";
  if (hasAny(text, ["meeting", "consultation", "table"])) return "consultation_meeting";
  if (hasAny(text, ["storage", "cabinet"])) return "storage";
  if (hasAny(text, ["interactive", "activity"])) return "interactive_activity";
  return "other_confirmed";
}

function categoryPriority(category: S5ZoneCategory): number {
  return CATEGORY_ORDER.indexOf(category);
}

function requirementText(requirement: S2Requirement, zone: S5LayoutZone | undefined): string {
  return requirement.text + " " + (zone?.label ?? "") + " " + (zone?.instances.map((item) => item.label).join(" ") ?? "");
}

function unsupportedForm(text: string): boolean {
  return /(?:\bhole\b|\bholes\b|double[-\s]bent|free[-\s]?form|bezier|\bmesh\b|unsupported|arbitrary\s+(?:curve|path|shape))/iu.test(text);
}

function formHint(text: string): "round" | "profile" | "overhead" | "partition" | null {
  if (hasAny(text, ["overhead"]) || hasAny(text, ["canopy"]) || hasAny(text, ["ceiling"])) return "overhead";
  if (hasAny(text, ["partition"]) || hasAny(text, ["wall"]) || hasAny(text, ["angled"])) return "partition";
  if (hasAny(text, ["round"]) || hasAny(text, ["circular"])) return "round";
  if (hasAny(text, ["profile"]) || hasAny(text, ["fascia"]) || hasAny(text, ["stepped"]) || hasAny(text, ["non rectangular"]) || hasAny(text, ["l profile"])) return "profile";
  return null;
}

function semanticFor(category: S5ZoneCategory, text: string): { objectType: S6PrimitiveKind; role: S6ObjectRole } | null {
  if (hasAny(text, ["partition"]) || hasAny(text, ["wall"]) || hasAny(text, ["angled"])) return { objectType: "partition", role: "booth_partition" };
  if (hasAny(text, ["overhead"]) || hasAny(text, ["canopy"]) || hasAny(text, ["ceiling"])) return { objectType: "overhead_volume", role: "overhead" };
  if (hasAny(text, ["screen"]) || hasAny(text, ["monitor"])) return { objectType: "screen", role: "screen" };
  if (hasAny(text, ["counter"]) || hasAny(text, ["desk"]) || category === "reception_welcome") return { objectType: "counter", role: "furniture" };
  if (hasAny(text, ["table"]) || category === "consultation_meeting") return { objectType: "table", role: "furniture" };
  if (hasAny(text, ["storage"]) || hasAny(text, ["cabinet"]) || category === "storage") return { objectType: "storage_volume", role: "storage" };
  if (hasAny(text, ["display"]) || hasAny(text, ["showcase"]) || category === "presentation_display" || category === "demo_product" || category === "giveaway_brochure") {
    return { objectType: "display_plinth", role: "display" };
  }
  if (category === "interactive_activity") return { objectType: "equipment_placeholder", role: "equipment" };
  if (category === "photo_branding") return { objectType: "display_plinth", role: "display" };
  return null;
}

function roleAllowsProfile(objectType: S6PrimitiveKind): boolean {
  return objectType === "partition" || objectType === "display_plinth" || objectType === "storage_volume" ||
    objectType === "screen" || objectType === "equipment_placeholder" || objectType === "overhead_volume" || objectType === "wall";
}

function roleAllowsRound(objectType: S6PrimitiveKind): boolean {
  return objectType === "counter" || objectType === "display_plinth" || objectType === "table" ||
    objectType === "seating_marker" || objectType === "equipment_placeholder" || objectType === "overhead_volume";
}

function usableSize(preferred: number, available: number): number {
  const boundedAvailable = Math.max(1, Math.min(S6_MAX_PHYSICAL_MM, Math.trunc(available)));
  if (boundedAvailable < S6_MIN_PHYSICAL_MM) return boundedAvailable;
  return Math.max(S6_MIN_PHYSICAL_MM, Math.min(preferred, boundedAvailable));
}

function heightFor(objectType: S6PrimitiveKind, renderHeight: number): number {
  const preferred = objectType === "screen" ? 2000 : objectType === "storage_volume" ? 2100 : objectType === "counter" ? 1000 : objectType === "table" ? 750 : objectType === "overhead_volume" ? 300 : 900;
  return usableSize(preferred, Math.max(1, renderHeight));
}

function profileFor(width: number, depth: number): S6GeometryPrimitive {
  const boundedWidth = usableSize(Math.max(600, width), width);
  const boundedDepth = usableSize(Math.max(300, depth), depth);
  if (boundedDepth < 300) {
    const profile = {
      kind: "profile_extrusion" as const,
      profile: {
        winding: "ccw-from-positive-y-v1" as const,
        vertices: [
          { xMm: 0, zMm: 0 },
          { xMm: boundedWidth, zMm: 0 },
          { xMm: Math.max(100, boundedWidth - 100), zMm: boundedDepth },
          { xMm: 100, zMm: boundedDepth },
        ],
      },
      heightMm: 1,
      geometryState: "bounded_inference" as const,
      localAnchor: "floor" as const,
    };
    return profile;
  }
  const notchX = Math.max(100, Math.trunc(boundedWidth * 0.55));
  const notchZ = Math.max(100, Math.trunc(boundedDepth * 0.45));
  const profile = {
    kind: "profile_extrusion" as const,
    profile: {
      winding: "ccw-from-positive-y-v1" as const,
      vertices: [
        { xMm: 0, zMm: 0 },
        { xMm: boundedWidth, zMm: 0 },
        { xMm: boundedWidth, zMm: notchZ },
        { xMm: notchX, zMm: notchZ },
        { xMm: notchX, zMm: boundedDepth },
        { xMm: 0, zMm: boundedDepth },
      ],
    },
    heightMm: 1,
    geometryState: "bounded_inference" as const,
    localAnchor: "floor" as const,
  };
  return profile;
}

function footprintSize(primitive: S6GeometryPrimitive): { width: number; depth: number } {
  if (primitive.kind === "rect_prism") return { width: primitive.dimensionsMm.widthMm, depth: primitive.dimensionsMm.depthMm };
  if (primitive.kind === "round_prism") return { width: primitive.radiusMm * 2, depth: primitive.radiusMm * 2 };
  const xs = primitive.profile.vertices.map((vertex) => vertex.xMm);
  const zs = primitive.profile.vertices.map((vertex) => vertex.zMm);
  return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
}

function geometryFor(objectType: S6PrimitiveKind, form: "round" | "profile" | null, width: number, depth: number, height: number): S6GeometryPrimitive {
  if (form === "round" && roleAllowsRound(objectType)) {
    return normalizeS6Geometry({ kind: "round_prism", radiusMm: Math.max(S6_MIN_PHYSICAL_MM, Math.trunc(Math.min(width, depth) / 2)), heightMm: height, geometryState: "bounded_inference", localAnchor: "floor" });
  }
  if (form === "profile" && roleAllowsProfile(objectType)) {
    const profile = profileFor(width, depth);
    if (profile.kind !== "profile_extrusion") throw new Error("S6_PROFILE_INVALID");
    return normalizeS6Geometry({ ...profile, heightMm: height });
  }
  return normalizeS6Geometry({
    kind: "rect_prism",
    dimensionsMm: { widthMm: usableSize(width, width), depthMm: usableSize(depth, depth), heightMm: height },
    geometryState: "bounded_inference",
    localAnchor: "floor",
  });
}

function materialKind(value: string): S6MaterialFinishKind {
  const text = value.toLocaleLowerCase("en-US");
  if (text.includes("wood")) return "wood_like";
  if (text.includes("metal")) return "metal_like";
  if (text.includes("fabric") || text.includes("textile")) return "fabric_like";
  if (text.includes("glass") || text.includes("acrylic")) return "glass_like";
  if (text.includes("brand") || text.includes("logo")) return "brand_reference";
  if (/^#[0-9a-f]{6}$/iu.test(text.trim())) return "solid_color";
  return "solid_color";
}

function materialColor(value: string, preferredColors: readonly string[], index: number): string {
  const embedded = value.match(/#[0-9a-f]{6}/iu)?.[0];
  if (embedded) return embedded.toLowerCase();
  const preferred = preferredColors.find((color) => /^#[0-9a-f]{6}$/iu.test(color.trim()));
  if (preferred) return preferred.trim().toLowerCase();
  return DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
}

function buildMaterials(source: S5ToS6Projection): S6MaterialFinishRef[] {
  const labels = source.visualIntent.materials.length > 0 ? source.visualIntent.materials.slice() : ["neutral bounded finish"];
  return labels.map((label, index) => {
    const finishKind = materialKind(label);
    const materialId = "material:" + finishKind + ":" + String(index + 1).padStart(3, "0");
    const provenance = inferredProvenance(source, "s5:visualIntent.materials[" + index + "]", "Structured S5 visual intent only; no hero pixels or remote material resource was read.");
    return {
      materialId,
      label: safeLabel(label, "Neutral bounded finish"),
      finishKind,
      colorHex: materialColor(label, source.visualIntent.preferredColors, index),
      source: "s5_visual_intent",
      sourceAssetId: source.activeAsset.assetId,
      sourceAssetSha256: source.activeAsset.sha256,
      notes: "Bounded S6 finish cue; not a texture or executable resource.",
      provenance,
    };
  });
}

function materialFor(materials: readonly S6MaterialFinishRef[], text: string, index: number): S6MaterialFinishRef {
  const match = materials.find((material) => text.toLocaleLowerCase("en-US").includes(material.finishKind.replace("_like", "").replace("_reference", "")));
  return match ?? materials[index % materials.length]!;
}

function makeUnknown(
  source: S5ToS6Projection,
  unknownId: string,
  kind: S6Unknown["kind"],
  fieldPath: string,
  requirementId: string | null,
  question: string,
  note: string,
): S6Unknown {
  return {
    unknownId,
    kind,
    fieldPath,
    requirementId,
    question: safeLabel(question, "S6 review required"),
    blocking: true,
    status: "unresolved",
    resolutionKind: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    provenance: inferredProvenance(source, "s6:compiler", note),
  };
}

function dimensionFor(objectType: S6PrimitiveKind, boothWidth: number, boothDepth: number): { width: number; depth: number } {
  const preferred = objectType === "counter" ? { width: 1000, depth: 500 } :
    objectType === "table" ? { width: 1200, depth: 700 } :
      objectType === "screen" ? { width: 1200, depth: 120 } :
        objectType === "storage_volume" ? { width: 800, depth: 500 } :
          objectType === "partition" ? { width: 2200, depth: 120 } :
            objectType === "overhead_volume" ? { width: 2200, depth: 400 } :
              { width: 900, depth: 500 };
  return {
    width: usableSize(preferred.width, boothWidth),
    depth: usableSize(preferred.depth, boothDepth),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function placementFor(
  objectType: S6PrimitiveKind,
  category: S5ZoneCategory,
  slot: number,
  footprint: { width: number; depth: number },
  booth: S6BoothEnvelope,
  renderHeight: number,
  objectHeight: number,
): S6Transform {
  const margin = Math.min(200, Math.trunc(Math.min(booth.widthMm, booth.depthMm) / 20));
  const wallThickness = Math.min(100, Math.max(1, Math.trunc(Math.min(booth.widthMm, booth.depthMm) / 30)));
  const maxX = Math.max(0, booth.widthMm - footprint.width);
  const maxZ = Math.max(0, booth.depthMm - footprint.depth);
  let x = margin;
  let z = margin;
  const closedSides = S6_OPEN_SIDE_ORDER.filter((side) => !booth.openSides.includes(side));
  if (objectType === "counter" && closedSides.length > 0) {
    const side = closedSides[0]!;
    if (side === "north") { x = (booth.widthMm - footprint.width) / 2; z = wallThickness + margin; }
    if (side === "east") { x = booth.widthMm - footprint.width - wallThickness - margin; z = (booth.depthMm - footprint.depth) / 2; }
    if (side === "south") { x = (booth.widthMm - footprint.width) / 2; z = booth.depthMm - footprint.depth - wallThickness - margin; }
    if (side === "west") { x = wallThickness + margin; z = (booth.depthMm - footprint.depth) / 2; }
  } else if (objectType === "storage_volume" || category === "storage") {
    x = maxX - margin;
    z = maxZ - margin;
  } else if (objectType === "overhead_volume") {
    x = (booth.widthMm - footprint.width) / 2;
    z = (booth.depthMm - footprint.depth) / 2;
  } else if (objectType === "partition") {
    x = (booth.widthMm - footprint.width) / 2;
    z = (booth.depthMm - footprint.depth) / 2;
  } else {
    const column = slot % 3;
    const row = Math.floor(slot / 3);
    x = margin + column * Math.max(1, Math.trunc((booth.widthMm - footprint.width - 2 * margin) / 2));
    z = margin + row * Math.max(1, Math.trunc((booth.depthMm - footprint.depth - 2 * margin) / 3));
  }
  const y = objectType === "overhead_volume" ? Math.max(0, renderHeight - objectHeight) : 0;
  return {
    positionMm: {
      xMm: clamp(x, 0, maxX),
      yMm: y,
      zMm: clamp(z, 0, maxZ),
    },
    rotationMd: normalizeS6Rotation({ xMd: 0, yMd: 0, zMd: 0 }),
  };
}

function wallGeometry(side: OpenSide, booth: S6BoothEnvelope, height: number): S6GeometryPrimitive {
  const thickness = Math.min(100, Math.max(1, Math.trunc(Math.min(booth.widthMm, booth.depthMm) / 30)));
  const dimensions = side === "north" || side === "south"
    ? { widthMm: booth.widthMm, depthMm: thickness, heightMm: height }
    : { widthMm: thickness, depthMm: booth.depthMm, heightMm: height };
  return normalizeS6Geometry({
    kind: "rect_prism",
    dimensionsMm: dimensions,
    geometryState: "bounded_inference",
    localAnchor: "floor",
  });
}

function wallTransform(side: OpenSide, booth: S6BoothEnvelope): S6Transform {
  const thickness = Math.min(100, Math.max(1, Math.trunc(Math.min(booth.widthMm, booth.depthMm) / 30)));
  const xMm = side === "east" ? booth.widthMm - thickness : 0;
  const zMm = side === "south" ? booth.depthMm - thickness : 0;
  return { positionMm: { xMm, yMm: 0, zMm }, rotationMd: normalizeS6Rotation({ xMd: 0, yMd: 0, zMd: 0 }) };
}

function regionPlacement(index: number, booth: S6BoothEnvelope, width: number, depth: number): S6Transform {
  const column = index % 2;
  const row = Math.floor(index / 2);
  const x = column * Math.max(0, booth.widthMm - width);
  const z = row * Math.max(0, booth.depthMm - depth);
  return { positionMm: { xMm: clamp(x, 0, Math.max(0, booth.widthMm - width)), yMm: 0, zMm: clamp(z, 0, Math.max(0, booth.depthMm - depth)) }, rotationMd: normalizeS6Rotation({ xMd: 0, yMd: 0, zMd: 0 }) };
}

type RequirementRecord = {
  requirement: S2Requirement;
  zone: S5LayoutZone | undefined;
  category: S5ZoneCategory;
  text: string;
};

function expectedInstanceCount(requirement: S2Requirement): number {
  if (requirement.expected === "absent") return 0;
  if (requirement.expected === "exact_count") return Math.max(0, requirement.expectedCount ?? 0);
  return 1;
}

function makeFloor(source: S5ToS6Projection, booth: S6BoothEnvelope, material: S6MaterialFinishRef): S6SpatialObject {
  const primitive = normalizeS6Geometry({
    kind: "rect_prism",
    dimensionsMm: { widthMm: booth.widthMm, depthMm: booth.depthMm, heightMm: 1 },
    geometryState: "exact",
    localAnchor: "floor",
  });
  return {
    objectId: compilerObjectId(source.projectId, source.activeRevisionId, "booth-floor"),
    identityKey: "booth-floor",
    parentObjectId: null,
    objectType: "floor_footprint",
    role: "booth_floor",
    label: "Confirmed booth floor footprint",
    primitive,
    transform: { positionMm: { xMm: 0, yMm: 0, zMm: 0 }, rotationMd: normalizeS6Rotation({ xMd: 0, yMd: 0, zMd: 0 }) },
    zoneIds: [],
    requirementIds: [],
    materialIds: [material.materialId],
    unknownIds: [],
    provenance: canonicalProvenance(source, "s5:geometrySnapshot", "Confirmed booth width, depth, and floor origin are immutable S5 facts."),
    hardConstraint: "booth_envelope",
    editable: false,
    removable: false,
  };
}

function makeWall(source: S5ToS6Projection, booth: S6BoothEnvelope, side: OpenSide, renderHeight: number): S6SpatialObject {
  const provenance = inferredProvenance(source, "s5:geometrySnapshot", "Closed-side wall run follows confirmed open-side facts; thickness is a bounded S6 draft value.");
  const unknownId = "design-form:booth-wall:" + side;
  return {
    objectId: compilerObjectId(source.projectId, source.activeRevisionId, "booth-wall:" + side),
    identityKey: "booth-wall:" + side,
    parentObjectId: null,
    objectType: "wall",
    role: "booth_wall",
    label: "Closed-side wall " + side,
    primitive: wallGeometry(side, booth, renderHeight),
    transform: wallTransform(side, booth),
    zoneIds: [],
    requirementIds: [],
    materialIds: [],
    unknownIds: [unknownId],
    provenance,
    hardConstraint: "booth_envelope",
    editable: false,
    removable: false,
  };
}

function makeZoneRegion(
  source: S5ToS6Projection,
  booth: S6BoothEnvelope,
  zone: S5LayoutZone,
  index: number,
): { object: S6SpatialObject; record: S6Zone } {
  const width = usableSize(Math.max(600, Math.trunc(booth.widthMm * 0.4)), booth.widthMm);
  const depth = usableSize(Math.max(600, Math.trunc(booth.depthMm * 0.4)), booth.depthMm);
  const provenance = inferredProvenance(source, "s5:layoutPlan.zones." + zone.zoneId, "Semantic zone relationship only; S5 normalized-Q16 coordinates are conceptual and were not copied.");
  const regionObjectId = compilerObjectId(source.projectId, source.activeRevisionId, "zone:" + zone.zoneId);
  const object: S6SpatialObject = {
    objectId: regionObjectId,
    identityKey: "zone:" + zone.zoneId,
    parentObjectId: null,
    objectType: "zone_region",
    role: "zone",
    label: safeLabel(zone.label, "S6 zone region"),
    primitive: normalizeS6Geometry({ kind: "rect_prism", dimensionsMm: { widthMm: width, depthMm: depth, heightMm: 1 }, geometryState: "bounded_inference", localAnchor: "floor" }),
    transform: regionPlacement(index, booth, width, depth),
    zoneIds: [zone.zoneId],
    requirementIds: [],
    materialIds: [],
    unknownIds: [],
    provenance,
    hardConstraint: "design_inference",
    editable: false,
    removable: false,
  };
  return {
    object,
    record: {
      zoneId: zone.zoneId,
      label: safeLabel(zone.label, "S6 zone"),
      category: zone.category,
      regionObjectId,
      requirementIds: zone.requirementIds.slice().sort(),
      unknownIds: [],
      provenance,
    },
  };
}

function shapeFor(text: string, objectType: S6PrimitiveKind): "round" | "profile" | null {
  const hint = formHint(text);
  if (hint === "round" && roleAllowsRound(objectType)) return "round";
  if (hasAny(text, ["profile"]) && roleAllowsProfile(objectType)) return "profile";
  if (hint === "profile" && roleAllowsProfile(objectType)) return "profile";
  if (hint === "partition" && hasAny(text, ["angled", "non axis", "non-axis"])) return "profile";
  return null;
}

function objectForRequirement(
  source: S5ToS6Projection,
  booth: S6BoothEnvelope,
  record: RequirementRecord,
  index: number,
  slot: number,
  materials: readonly S6MaterialFinishRef[],
  renderHeight: number,
): { object: S6SpatialObject; unknown: S6Unknown } {
  const semantic = semanticFor(record.category, record.text)!;
  const shape = shapeFor(record.text, semantic.objectType);
  const dimensions = dimensionFor(semantic.objectType, booth.widthMm, booth.depthMm);
  const height = heightFor(semantic.objectType, renderHeight);
  const primitive = geometryFor(semantic.objectType, shape, dimensions.width, dimensions.depth, height);
  const transform = placementFor(semantic.objectType, record.category, slot, footprintSize(primitive), booth, renderHeight, height);
  const stableKey = "requirement:" + record.requirement.requirementId + ":" + semantic.role + ":" + String(index + 1);
  const objectId = compilerObjectId(source.projectId, source.activeRevisionId, stableKey);
  const unknownId = "design-form:" + objectId;
  const provenance = inferredProvenance(source, "s5:layoutPlan.zones." + (record.zone?.zoneId ?? "unmapped"), "Bounded S6 shape, placement, dimensions, and finish inferred from structured requirement semantics; S5 placement remains conceptual.");
  const material = materialFor(materials, record.text, slot);
  const object: S6SpatialObject = {
    objectId,
    identityKey: stableKey,
    parentObjectId: null,
    objectType: semantic.objectType,
    role: semantic.role,
    label: safeLabel(record.requirement.text, "S6 requirement object"),
    primitive,
    transform,
    zoneIds: record.zone ? [record.zone.zoneId] : [],
    requirementIds: [record.requirement.requirementId],
    materialIds: [material.materialId],
    unknownIds: [unknownId],
    provenance,
    hardConstraint: semantic.objectType === "overhead_volume" ? "design_inference" : "requirement",
    editable: true,
    removable: true,
  };
  const unknown = makeUnknown(
    source,
    unknownId,
    "design_form",
    "objects[" + objectId + "].primitive",
    record.requirement.requirementId,
    "Review bounded design form for " + object.label + " and confirm an allowlisted representation.",
    "Material form remains a correction surface until the user confirms the typed design decision.",
  );
  return { object, unknown };
}

function seatingMarkersFor(
  source: S5ToS6Projection,
  booth: S6BoothEnvelope,
  record: RequirementRecord,
  slot: number,
  materials: readonly S6MaterialFinishRef[],
  renderHeight: number,
): Array<{ object: S6SpatialObject; unknown: S6Unknown }> {
  if (record.category !== "consultation_meeting") return [];
  const result: Array<{ object: S6SpatialObject; unknown: S6Unknown }> = [];
  for (let index = 0; index < 2; index += 1) {
    const dimensions = { width: usableSize(400, booth.widthMm), depth: usableSize(400, booth.depthMm) };
    const height = heightFor("seating_marker", renderHeight);
    const primitive = geometryFor("seating_marker", null, dimensions.width, dimensions.depth, height);
    const transform = placementFor("seating_marker", record.category, slot + index, footprintSize(primitive), booth, renderHeight, height);
    const stableKey = "requirement:" + record.requirement.requirementId + ":seating:" + String(index + 1);
    const objectId = compilerObjectId(source.projectId, source.activeRevisionId, stableKey);
    const unknownId = "design-form:" + objectId;
    const provenance = inferredProvenance(source, "s5:layoutPlan.zones." + (record.zone?.zoneId ?? "unmapped"), "Symbolic seating marker added for a confirmed consultation relationship; dimensions remain bounded design inference.");
    const material = materialFor(materials, record.text, slot + index);
    const object: S6SpatialObject = {
      objectId,
      identityKey: stableKey,
      parentObjectId: null,
      objectType: "seating_marker",
      role: "seating",
      label: "Seating marker " + String(index + 1) + " for " + safeLabel(record.requirement.text, "consultation"),
      primitive,
      transform,
      zoneIds: record.zone ? [record.zone.zoneId] : [],
      requirementIds: [],
      materialIds: [material.materialId],
      unknownIds: [unknownId],
      provenance,
      hardConstraint: "design_inference",
      editable: true,
      removable: true,
    };
    result.push({
      object,
      unknown: makeUnknown(source, unknownId, "design_form", "objects[" + objectId + "].primitive", null, "Review seating marker form and placement for " + object.label + ".", "Seating is a bounded symbolic marker and is not a fabrication measurement."),
    });
  }
  return result;
}

function compilerRequirements(source: S5ToS6Projection): RequirementRecord[] {
  const zones = source.layoutPlan.zones.slice().sort((left, right) => left.zoneId < right.zoneId ? -1 : left.zoneId > right.zoneId ? 1 : 0);
  const byRequirement = new Map<string, S5LayoutZone>();
  for (const zone of zones) for (const requirementId of zone.requirementIds) if (!byRequirement.has(requirementId)) byRequirement.set(requirementId, zone);
  return source.canonicalRequirements.slice().sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0).map((requirement) => {
    const zone = byRequirement.get(requirement.requirementId);
    return { requirement, zone, category: categoryFor(zone, requirement), text: requirementText(requirement, zone) };
  }).sort((left, right) => categoryPriority(left.category) - categoryPriority(right.category) || (left.requirement.requirementId < right.requirement.requirementId ? -1 : left.requirement.requirementId > right.requirement.requirementId ? 1 : 0));
}

function boothFor(source: S5ToS6Projection): S6BoothEnvelope {
  const geometry = source.geometrySnapshot;
  return {
    widthMm: geometry.widthMm,
    depthMm: geometry.depthMm,
    openSides: S6_OPEN_SIDE_ORDER.filter((side) => geometry.openSides.includes(side)),
    maxHeightMm: geometry.maxHeightMm,
    coordinateConvention: CONVENTION,
    heightState: geometry.maxHeightMm === null ? "unknown" : "known",
  };
}

function renderHeightFor(booth: S6BoothEnvelope): number {
  return booth.maxHeightMm ?? Math.min(S6_MAX_PHYSICAL_MM, Math.max(2400, Math.min(3000, Math.max(booth.widthMm, booth.depthMm))));
}

function addUniqueProvenance(entries: S6Provenance[], value: S6Provenance): void {
  if (!entries.some((item) => item.sourceRef === value.sourceRef && item.kind === value.kind && item.note === value.note)) entries.push(value);
}

export function compileS6Draft(input: S6CompilerInput): S6SpatialModelRecord {
  const source = input.source;
  const booth = boothFor(source);
  const renderHeight = renderHeightFor(booth);
  const materials = buildMaterials(source);
  const objects: S6SpatialObject[] = [];
  const zones: S6Zone[] = [];
  const assumptions: S6Assumption[] = [];
  const unknowns: S6Unknown[] = [];
  const provenance: S6Provenance[] = [];

  const floor = makeFloor(source, booth, materials[0]!);
  objects.push(floor);
  addUniqueProvenance(provenance, floor.provenance);

  for (const side of S6_OPEN_SIDE_ORDER) {
    if (booth.openSides.includes(side)) continue;
    const wall = makeWall(source, booth, side, renderHeight);
    objects.push(wall);
    addUniqueProvenance(provenance, wall.provenance);
    unknowns.push(makeUnknown(source, "design-form:booth-wall:" + side, "design_form", "objects[" + wall.objectId + "].primitive", null, "Review closed-side wall thickness and finish for " + side + ".", "Closed-side existence is confirmed; draft thickness and finish remain bounded inference."));
  }

  const layoutZones = source.layoutPlan.zones.slice().sort((left, right) => left.zoneId < right.zoneId ? -1 : left.zoneId > right.zoneId ? 1 : 0);
  for (const [index, zone] of layoutZones.entries()) {
    const built = makeZoneRegion(source, booth, zone, index);
    objects.push(built.object);
    zones.push(built.record);
    addUniqueProvenance(provenance, built.object.provenance);
  }

  let placementSlot = 0;
  let hasUnsupported = false;
  for (const record of compilerRequirements(source)) {
    const count = expectedInstanceCount(record.requirement);
    if (count === 0) continue;
    if (unsupportedForm(record.text) || unsupportedForm(source.visualIntent.visualDirection ?? "")) {
      const unknownId = "design-form:" + record.requirement.requirementId;
      unknowns.push(makeUnknown(source, unknownId, "design_form", "requirements." + record.requirement.requirementId, record.requirement.requirementId, "S6_UNSUPPORTED_FORM: choose a typed rect_prism, round_prism, profile_extrusion, or explicit simplification for " + safeLabel(record.requirement.text, "unsupported form") + ".", "Approved structured intent names a form outside the bounded S6 geometry union; no box substitute was created."));
      hasUnsupported = true;
      continue;
    }
    const semantic = semanticFor(record.category, record.text);
    if (!semantic) {
      unknowns.push(makeUnknown(source, "requirement-mapping:" + record.requirement.requirementId, "requirement_mapping", "requirements." + record.requirement.requirementId, record.requirement.requirementId, "Map confirmed requirement " + safeLabel(record.requirement.text, "requirement") + " to an allowlisted S6 object family.", "S5 semantics were not sufficiently specific for a safe metric object."));
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      const built = objectForRequirement(source, booth, record, index, placementSlot, materials, renderHeight);
      objects.push(built.object);
      unknowns.push(built.unknown);
      addUniqueProvenance(provenance, built.object.provenance);
      placementSlot += 1;
    }
    for (const built of seatingMarkersFor(source, booth, record, placementSlot, materials, renderHeight)) {
      objects.push(built.object);
      unknowns.push(built.unknown);
      addUniqueProvenance(provenance, built.object.provenance);
      placementSlot += 1;
    }
  }

  for (const material of materials) addUniqueProvenance(provenance, material.provenance);
  if (booth.maxHeightMm === null) {
    const assumptionProvenance = inferredProvenance(source, "s6:compiler", "Render height is bounded for draft views only; confirmed maximum height remains unknown.");
    assumptions.push({
      assumptionId: "assumption:booth.maxHeightMm",
      fieldPath: "booth.maxHeightMm",
      value: "derived render height " + String(renderHeight) + " mm",
      provenance: assumptionProvenance,
      acceptedByUser: false,
      requiresConfirmation: true,
      createdAt: input.clock(),
    });
    addUniqueProvenance(provenance, assumptionProvenance);
  }
  const designUnknowns = unknowns.filter((item) => item.kind === "design_form").map((item) => item.unknownId).sort();
  const timestamp = input.clock();
  const designFormReview: S6DesignFormReview = {
    status: hasUnsupported ? "unsupported" : "required",
    evidenceAssetId: source.activeAsset.assetId,
    evidenceAssetSha256: source.activeAsset.sha256,
    sourceS5Fingerprint: source.sourceFingerprint,
    reviewedObjectIds: [],
    unresolvedUnknownIds: designUnknowns,
    explicitSimplificationUnknownIds: [],
    acceptedByUser: false,
  };
  const modelArtifactBase = "projects/" + source.projectId + "/s6/revisions/" + input.revisionId;
  const model: S6SpatialModelRecord = {
    schemaVersion: S6_SPATIAL_SCHEMA_VERSION,
    modelRevisionId: input.revisionId,
    projectId: source.projectId,
    parentRevisionId: input.parentRevisionId,
    parentRevisionHash: null,
    revisionNumber: 1,
    sourceS5Fingerprint: source.sourceFingerprint,
    sourceS5ApprovalEventId: source.approvalEventId,
    sourceS5ApprovalGeneration: source.approvalGeneration,
    status: "generated_draft",
    booth,
    objects,
    zones,
    materials,
    cameras: [],
    provenance,
    assumptions,
    unknowns: unknowns.sort((left, right) => left.unknownId < right.unknownId ? -1 : left.unknownId > right.unknownId ? 1 : 0),
    designFormReview,
    modelHash: "" as S6SpatialModelRecord["modelHash"],
    canonicalByteSize: 0,
    modelArtifact: { artifactKey: modelArtifactBase + "/model.json", stagingKey: modelArtifactBase + "/staging/model.json", sha256: null, byteSize: null, status: "not_written" },
    validationReceiptId: null,
    acceptanceEventId: null,
    createdBy: "compiler",
    createdAt: timestamp,
    updatedAt: timestamp,
    acceptedAt: null,
    supersededAt: null,
    staleAt: null,
  };
  const hashed = hashS6Model(model);
  return { ...model, modelHash: hashed.modelHash, canonicalByteSize: hashed.canonicalByteSize };
}
