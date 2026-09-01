import { AppError } from "./types";
import type { BoothGeometry, OpenSide, S2Requirement, S5ActiveRevisionKind, S5CoverageReason, S5LayoutCoverage, S5LayoutInstance, S5LayoutPlan, S5LayoutRequirement, S5LayoutSymbol, S5LayoutZone, S5UnknownItem, S5ZoneCategory, Sha256, UUID } from "./types";
import { OPEN_SIDE_ORDER } from "./geometry";
import { cloneJson, jcs, sha256 } from "./utils";

export const S5_LAYOUT_SCHEMA = "s5-concept-layout-v1" as const;
export const S5_LAYOUT_RENDERER_VERSION = "s5-concept-layout-v1" as const;
export const S5_Q16_DENOMINATOR = 65_536;
export const S5_Q16_MAX = S5_Q16_DENOMINATOR - 1;
export const S5_Q16_OUTER_MARGIN = 4_096;
export const S5_Q16_MIN_GUTTER = 1_024;
export const S5_Q16_CIRCULATION_BAND_START = 24_576;
export const S5_Q16_CIRCULATION_BAND_END = 40_960;
export const S5_Q16_ZONE_WIDTH = 8_192;
export const S5_Q16_ZONE_HEIGHT = 8_192;
export const S5_LAYOUT_LABEL_MAX_CODEPOINTS = 80;
export const S5_LAYOUT_LABEL_MAX_WIDTH_UNITS = 12;
export const S5_LAYOUT_LABEL_MAX_LINES = 3;
export const S5_MAX_REQUIREMENT_ITEMS = 64;
export const S5_MAX_ZONE_CANDIDATES = 32;
export const S5_MAX_INSTANCES_PER_REQUIREMENT = 8;
export const S5_MAX_PLACED_INSTANCES = 16;

export type S5LayoutCompilerInput = {
  projectId: UUID;
  generationSetId: UUID;
  selectionStateId: UUID;
  selectionVersion: number;
  activeRevisionId: UUID;
  activeRevisionKind: S5ActiveRevisionKind;
  approvalEventId: UUID;
  approvalGeneration: number;
  approvalEventSequence: number;
  geometry: BoothGeometry;
  requirements: S5LayoutRequirement[];
  canonicalRequirements?: S2Requirement[];
};

const CATEGORY_ORDER: readonly S5ZoneCategory[] = [
  "reception_welcome", "presentation_display", "demo_product", "consultation_meeting", "storage",
  "interactive_activity", "photo_branding", "giveaway_brochure", "other_confirmed",
];
const CATEGORY_ALIASES: ReadonlyArray<{ category: S5ZoneCategory; aliases: readonly string[] }> = [
  { category: "reception_welcome", aliases: ["reception desk", "welcome desk", "registration", "reception", "welcome", "host", "concierge"] },
  { category: "presentation_display", aliases: ["display wall", "presentation", "showcase", "exhibition", "exhibit", "display"] },
  { category: "demo_product", aliases: ["interactive demo", "product demo", "demonstration", "demo", "product"] },
  { category: "consultation_meeting", aliases: ["meeting room", "consultation", "discussion", "meeting"] },
  { category: "storage", aliases: ["back of house", "store room", "storage", "closet", "cabinet"] },
  { category: "interactive_activity", aliases: ["interactive", "activity", "experience", "game"] },
  { category: "photo_branding", aliases: ["photo wall", "photo", "branding", "selfie", "logo"] },
  { category: "giveaway_brochure", aliases: ["giveaway", "brochure", "leaflet", "literature", "handout"] },
];
const DISCLAIMERS = [
  "Concept Layout Plan - concept-stage diagrammatic planning aid only.",
  "Confirmed booth facts are shown in millimetres; origin is north-west, X increases east, and Y increases south.",
  "Furniture and equipment are symbolic non-engineered markers and are not to scale.",
  "No image-pixel inference was used. Exact doors, aisles, furniture dimensions, coordinates, construction, and venue claims are not defined.",
  "A qualified contractor, engineer, and venue must verify all final placement, access, safety, and compliance requirements.",
] as const;

function layoutError(code: string, field = "layout"): AppError { return new AppError(422, code, [{ field, code }]); }
function labelWidthUnit(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0;
  if (/\p{M}/u.test(value)) return 0;
  if (/\s/u.test(value)) return 0.5;
  if (codePoint >= 0x2e80) return 2;
  if (/[,.;:!?()[\]{}\-_/]/u.test(value)) return 0.45;
  return 1;
}
export function layoutS5Label(value: string): string[] {
  const codePoints = Array.from(value);
  if (!codePoints.length || codePoints.length > S5_LAYOUT_LABEL_MAX_CODEPOINTS || /[\u0000-\u001f\u007f]/u.test(value)) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "label");
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const character of codePoints) {
    if (character === "\n") {
      lines.push(current);
      current = "";
      width = 0;
      continue;
    }
    const nextWidth = width + labelWidthUnit(character);
    if (current && nextWidth > S5_LAYOUT_LABEL_MAX_WIDTH_UNITS) {
      lines.push(current);
      current = "";
      width = 0;
    }
    current += character;
    width += labelWidthUnit(character);
  }
  if (current || value.endsWith("\n")) lines.push(current);
  if (!lines.length || lines.length > S5_LAYOUT_LABEL_MAX_LINES || lines.join("") !== value) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "label");
  return lines;
}
function labelWidthUnits(value: string): number { return Array.from(value).reduce((total, character) => total + labelWidthUnit(character), 0); }
export function s5LabelLineWidthUnits(value: string): number[] { return layoutS5Label(value).map(labelWidthUnits); }
function normalizeWords(value: string): string[] { return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u).filter(Boolean); }
function containsAlias(tokens: readonly string[], alias: string): boolean {
  const aliasTokens = alias.split(" ");
  for (let index = 0; index <= tokens.length - aliasTokens.length; index += 1) if (aliasTokens.every((token, offset) => tokens[index + offset] === token)) return true;
  return false;
}
function classify(name: string, details: string | null): S5ZoneCategory {
  const tokens = normalizeWords(`${name} ${details ?? ""}`);
  for (const entry of CATEGORY_ALIASES) {
    const aliases = entry.aliases.slice().sort((left, right) => right.split(" ").length - left.split(" ").length || left.localeCompare(right));
    if (aliases.some((alias) => containsAlias(tokens, alias))) return entry.category;
  }
  return "other_confirmed";
}
function symbolKind(tokens: readonly string[], category: S5ZoneCategory): S5LayoutSymbol["kind"] {
  if (tokens.includes("counter") || tokens.includes("desk") || category === "reception_welcome") return "counter";
  if (tokens.includes("table") || tokens.includes("meeting") || category === "consultation_meeting") return "table";
  if (tokens.includes("screen") || tokens.includes("monitor") || category === "presentation_display") return "screen";
  if (category === "storage" || tokens.includes("cabinet") || tokens.includes("closet")) return "storage";
  if (tokens.includes("seat") || tokens.includes("chair") || tokens.includes("sofa")) return "seat";
  if (category === "giveaway_brochure") return "display";
  if (category === "other_confirmed") return "marker";
  return "equipment";
}
function symbolsFor(requirement: S5LayoutRequirement, category: S5ZoneCategory, index: number): S5LayoutSymbol[] {
  return [{ symbolId: `${requirement.requirementId}.symbol.${String(index + 1).padStart(2, "0")}`, kind: symbolKind(normalizeWords(`${requirement.name} ${requirement.details ?? ""}`), category), label: requirement.name, physicalDimensionsMm: null, semantics: "conceptual-zone-marker-not-to-scale" }];
}
function circulationFor(openSides: readonly OpenSide[]): S5LayoutPlan["circulation"] {
  return OPEN_SIDE_ORDER.filter((side) => openSides.includes(side)).map((side) => {
    const start = side === "north" ? { x: 32_768, y: 0 } : side === "east" ? { x: S5_Q16_MAX, y: 32_768 } : side === "south" ? { x: 32_768, y: S5_Q16_MAX } : { x: 0, y: 32_768 };
    return { pathId: `circulation.${side}`, fromOpenSide: side, startXQ16: start.x, startYQ16: start.y, endXQ16: 32_768, endYQ16: 32_768, widthQ16: null, semantics: "symbolic-primary-route-not-a-measured-aisle" as const };
  });
}
function positionFor(slot: number): { xQ16: number; yQ16: number; widthQ16: number; heightQ16: number } {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= S5_MAX_PLACED_INSTANCES) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "placement");
  const column = slot % 4; const row = Math.floor(slot / 4);
  const xQ16 = [S5_Q16_OUTER_MARGIN, S5_Q16_OUTER_MARGIN + S5_Q16_ZONE_WIDTH + 2_048, S5_Q16_CIRCULATION_BAND_END + 2_048, S5_Q16_DENOMINATOR - S5_Q16_OUTER_MARGIN - S5_Q16_ZONE_WIDTH][column]!;
  return { xQ16, yQ16: S5_Q16_OUTER_MARGIN + row * (S5_Q16_ZONE_HEIGHT + 2_048), widthQ16: S5_Q16_ZONE_WIDTH, heightQ16: S5_Q16_ZONE_HEIGHT };
}
function unknownItem(requirement: S5LayoutRequirement, reason: S5UnknownItem["reason"]): S5UnknownItem {
  return { unknownId: `${requirement.requirementId}.${reason}`, requirementId: requirement.requirementId, label: requirement.name, mandatory: requirement.mandatory, status: "unplaced", reason };
}
function instanceFor(requirement: S5LayoutRequirement, category: S5ZoneCategory, index: number, placement: ReturnType<typeof positionFor> | null, reason: S5LayoutInstance["unplacedReason"]): S5LayoutInstance {
  return { instanceId: `${requirement.requirementId}.instance.${String(index + 1).padStart(2, "0")}`, requirementId: requirement.requirementId, label: requirement.countIsExact ? `${requirement.name} ${index + 1}` : requirement.name, mandatory: requirement.mandatory, countIndex: index + 1, status: placement ? "placed" : "unplaced", unplacedReason: placement ? null : reason, xQ16: placement?.xQ16 ?? null, yQ16: placement?.yQ16 ?? null, widthQ16: placement?.widthQ16 ?? null, heightQ16: placement?.heightQ16 ?? null, symbols: placement ? symbolsFor(requirement, category, index) : [] };
}
function verifyRequirement(value: S5LayoutRequirement, index: number): void {
  if (!/^brief\.functional\.\d{3}$/u.test(value.requirementId) || typeof value.name !== "string" || !value.name.trim() || Array.from(value.name).length > S5_LAYOUT_LABEL_MAX_CODEPOINTS || typeof value.mandatory !== "boolean" || typeof value.countIsExact !== "boolean") throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements[" + index + "]");
  if (value.details !== null && (typeof value.details !== "string" || Array.from(value.details).length > 400)) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements[" + index + "].details");
  if (value.count !== null && (!Number.isSafeInteger(value.count) || value.count < 0)) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements[" + index + "].count");
  if (value.countIsExact && value.count === null) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements[" + index + "].count");
}

function geometryCoverage(requirement: S2Requirement): S5LayoutCoverage {
  const prohibited = requirement.category === "prohibited";
  return { requirementId: requirement.requirementId, role: prohibited ? "prohibited_constraint" : "geometry_constraint", status: "represented", reason: null, mandatory: false, count: null, countIsExact: false, representedCount: 1 };
}

export function compileConceptLayoutPlan(input: S5LayoutCompilerInput): S5LayoutPlan {
  if (!Number.isSafeInteger(input.selectionVersion) || input.selectionVersion < 1 || !Number.isSafeInteger(input.approvalGeneration) || input.approvalGeneration < 1 || !Number.isSafeInteger(input.approvalEventSequence) || input.approvalEventSequence < 1 || !Number.isSafeInteger(input.geometry.widthMm) || input.geometry.widthMm < 1 || !Number.isSafeInteger(input.geometry.depthMm) || input.geometry.depthMm < 1) throw layoutError("S5_LAYOUT_INPUT_INVALID", "geometry");
  if (input.requirements.length > S5_MAX_REQUIREMENT_ITEMS) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements");
  input.requirements.forEach(verifyRequirement);
  if (new Set(input.requirements.map((item) => item.requirementId)).size !== input.requirements.length) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements");
  const sorted = input.requirements.slice().sort((left, right) => Number(right.mandatory) - Number(left.mandatory) || (left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0));
  const working: S5LayoutPlan = {
    schemaVersion: S5_LAYOUT_SCHEMA, projectId: input.projectId, generationSetId: input.generationSetId, selectionStateId: input.selectionStateId, selectionVersion: input.selectionVersion,
    activeRevisionId: input.activeRevisionId, activeRevisionKind: input.activeRevisionKind, approvalEventId: input.approvalEventId, approvalGeneration: input.approvalGeneration, approvalEventSequence: input.approvalEventSequence,
    coordinateConvention: { units: "mm", origin: "north-west", x: "east", y: "south", north: "diagram-top-not-surveyed-bearing", displaySpace: "normalized-Q16-conceptual" }, booth: cloneJson(input.geometry), coverage: [], zones: [], circulation: circulationFor(input.geometry.openSides), unknowns: [], disclaimers: [...DISCLAIMERS, input.geometry.maxHeightMm === null ? "Confirmed maximum height was not specified in the brief." : "Confirmed maximum height: " + input.geometry.maxHeightMm + " mm."], planHash: "" as Sha256,
  };
  let placementCursor = 0;
  let zoneCandidateCount = 0;
  for (const requirement of sorted) {
    const category = classify(requirement.name, requirement.details);
    const requested = requirement.countIsExact ? requirement.count! : 1;
    const bounded = Math.min(requested, S5_MAX_INSTANCES_PER_REQUIREMENT);
    if (requested > S5_MAX_INSTANCES_PER_REQUIREMENT && requirement.mandatory) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "requirements." + requirement.requirementId);
    let reason: S5CoverageReason = category === "other_confirmed" ? "unknown_semantic" : null;
    if (requested > bounded) reason = "optional_overflow";
    if (zoneCandidateCount >= S5_MAX_ZONE_CANDIDATES) {
      if (requirement.mandatory) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "requirements." + requirement.requirementId);
      working.coverage.push({ requirementId: requirement.requirementId, role: "zone_candidate", status: "unplaced", reason: "optional_overflow", mandatory: requirement.mandatory, count: requirement.count, countIsExact: requirement.countIsExact, representedCount: 0 });
      working.unknowns.push(unknownItem(requirement, "optional-overflow"));
      continue;
    }
    zoneCandidateCount += 1;
    const zoneInstances: S5LayoutInstance[] = [];
    let representedCount = 0;
    for (let index = 0; index < bounded; index += 1) {
      if (category === "other_confirmed") {
        zoneInstances.push(instanceFor(requirement, category, index, null, "unknown-semantic"));
        continue;
      }
      if (placementCursor >= S5_MAX_PLACED_INSTANCES) {
        if (requirement.mandatory) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "requirements." + requirement.requirementId);
        zoneInstances.push(instanceFor(requirement, category, index, null, "optional-overflow"));
        reason = "optional_overflow";
        continue;
      }
      zoneInstances.push(instanceFor(requirement, category, index, positionFor(placementCursor), null));
      placementCursor += 1;
      representedCount += 1;
    }
    const placementStatus: S5LayoutZone["placementStatus"] = category === "other_confirmed" ? "unknown" : requested === 0 ? "represented" : representedCount > 0 ? "symbolic" : "unplaced";
    const zone: S5LayoutZone = { zoneId: "zone." + requirement.requirementId, category, label: requirement.name, requirementIds: [requirement.requirementId], mandatory: requirement.mandatory, count: requirement.count, countIsExact: requirement.countIsExact, representedCount, placementStatus, placementReason: reason, instances: zoneInstances };
    working.zones.push(zone);
    working.coverage.push({ requirementId: requirement.requirementId, role: "zone_candidate", status: placementStatus, reason, mandatory: requirement.mandatory, count: requirement.count, countIsExact: requirement.countIsExact, representedCount });
    if (category === "other_confirmed") working.unknowns.push(unknownItem(requirement, "unknown-semantic"));
    if (requested > bounded || zoneInstances.some((item) => item.status === "unplaced" && item.unplacedReason === "optional-overflow")) working.unknowns.push(unknownItem(requirement, "optional-overflow"));
  }
  for (const requirement of input.canonicalRequirements ?? []) if (!working.coverage.some((item) => item.requirementId === requirement.requirementId)) working.coverage.push(geometryCoverage(requirement));
  working.coverage.sort((left, right) => left.requirementId < right.requirementId ? -1 : left.requirementId > right.requirementId ? 1 : 0);
  validatePlanGeometry(working);
  return withPlanHash(working);
}
export function validatePlanGeometry(plan: S5LayoutPlan): void {
  if (plan.zones.length > S5_MAX_ZONE_CANDIDATES) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
  const boxes: Array<{ x: number; y: number; width: number; height: number; instanceId: string }> = [];
  const instanceIds = new Set<string>();
  let placedCount = 0;
  for (const zone of plan.zones) {
    if (zone.instances.length > S5_MAX_INSTANCES_PER_REQUIREMENT) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
    layoutS5Label(zone.label);
    for (const instance of zone.instances) {
      if (instanceIds.has(instance.instanceId)) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
      instanceIds.add(instance.instanceId);
      layoutS5Label(instance.label);
      for (const symbol of instance.symbols) layoutS5Label(symbol.label);
      if (instance.status !== "placed") continue;
      if (instance.xQ16 === null || instance.yQ16 === null || instance.widthQ16 === null || instance.heightQ16 === null || instance.widthQ16 < 4_096 || instance.heightQ16 < 4_096 || ![instance.xQ16, instance.yQ16, instance.widthQ16, instance.heightQ16].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= S5_Q16_MAX) || instance.xQ16 < S5_Q16_OUTER_MARGIN || instance.yQ16 < S5_Q16_OUTER_MARGIN || instance.xQ16 + instance.widthQ16 > S5_Q16_DENOMINATOR - S5_Q16_OUTER_MARGIN || instance.yQ16 + instance.heightQ16 > S5_Q16_DENOMINATOR - S5_Q16_OUTER_MARGIN) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
      const inLeftRail = instance.xQ16 + instance.widthQ16 <= S5_Q16_CIRCULATION_BAND_START;
      const inRightRail = instance.xQ16 >= S5_Q16_CIRCULATION_BAND_END;
      if (!inLeftRail && !inRightRail) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
      boxes.push({ x: instance.xQ16, y: instance.yQ16, width: instance.widthQ16, height: instance.heightQ16, instanceId: instance.instanceId });
      placedCount += 1;
    }
  }
  for (const unknown of plan.unknowns) layoutS5Label(unknown.label);
  if (placedCount > S5_MAX_PLACED_INSTANCES) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones");
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
    const left = boxes[leftIndex]; const right = boxes[rightIndex];
    const xOverlap = left.x < right.x + right.width && right.x < left.x + left.width;
    const yOverlap = left.y < right.y + right.height && right.y < left.y + left.height;
    if (xOverlap && yOverlap) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones." + left.instanceId);
    const xGap = left.x >= right.x + right.width ? left.x - (right.x + right.width) : right.x - (left.x + left.width);
    const yGap = left.y >= right.y + right.height ? left.y - (right.y + right.height) : right.y - (left.y + left.height);
    if ((xOverlap && yGap < S5_Q16_MIN_GUTTER) || (yOverlap && xGap < S5_Q16_MIN_GUTTER) || (!xOverlap && !yOverlap && (xGap < S5_Q16_MIN_GUTTER || yGap < S5_Q16_MIN_GUTTER))) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", "zones." + left.instanceId);
  }
}
function withoutPlanHash(plan: S5LayoutPlan): Record<string, unknown> { const copy = cloneJson(plan) as Record<string, unknown>; delete copy.planHash; return copy; }
function withPlanHash(plan: S5LayoutPlan): S5LayoutPlan { plan.planHash = sha256(jcs(withoutPlanHash(plan))); return plan; }
export function canonicalPlanJson(plan: S5LayoutPlan): string { verifyPlanHash(plan); return jcs(plan); }
export function canonicalPlanBytes(plan: S5LayoutPlan): Buffer { return Buffer.from(canonicalPlanJson(plan), "utf8"); }
export function verifyPlanHash(plan: S5LayoutPlan): void {
  if (plan.schemaVersion !== S5_LAYOUT_SCHEMA || plan.coordinateConvention.units !== "mm" || plan.coordinateConvention.origin !== "north-west" || plan.coordinateConvention.x !== "east" || plan.coordinateConvention.y !== "south" || plan.coordinateConvention.north !== "diagram-top-not-surveyed-bearing" || plan.coordinateConvention.displaySpace !== "normalized-Q16-conceptual") throw layoutError("S5_LAYOUT_CONVENTION_INVALID", "coordinateConvention");
  if (!/^[0-9a-f]{64}$/u.test(plan.planHash) || sha256(jcs(withoutPlanHash(plan))) !== plan.planHash) throw layoutError("S5_PLAN_HASH_MISMATCH", "planHash");
  validatePlanGeometry(plan);
}
