import { AppError } from "./types";
import type { BoothGeometry, OpenSide, S2Requirement, S5ActiveRevisionKind, S5CoverageReason, S5LayoutCoverage, S5LayoutInstance, S5LayoutPlan, S5LayoutRequirement, S5LayoutSymbol, S5LayoutZone, S5UnknownItem, S5ZoneCategory, Sha256, UUID } from "./types";
import { OPEN_SIDE_ORDER } from "./geometry";
import { cloneJson, jcs, sha256 } from "./utils";

export const S5_LAYOUT_SCHEMA = "s5-concept-layout-v1" as const;
export const S5_LAYOUT_RENDERER_VERSION = "s5-layout-v1" as const;
export const S5_Q16_DENOMINATOR = 65_536;
export const S5_Q16_MAX = S5_Q16_DENOMINATOR - 1;

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
  const column = slot % 4; const row = Math.floor(slot / 4);
  return { xQ16: [6_144, 16_384, 49_152, 59_392][column], yQ16: 8_192 + row * 13_312, widthQ16: 8_192, heightQ16: 8_192 };
}
function unknownItem(requirement: S5LayoutRequirement, reason: S5UnknownItem["reason"]): S5UnknownItem {
  return { unknownId: `${requirement.requirementId}.${reason}`, requirementId: requirement.requirementId, label: requirement.name, mandatory: requirement.mandatory, status: "unplaced", reason };
}
function instanceFor(requirement: S5LayoutRequirement, category: S5ZoneCategory, index: number, placement: ReturnType<typeof positionFor> | null, reason: S5LayoutInstance["unplacedReason"]): S5LayoutInstance {
  return { instanceId: `${requirement.requirementId}.instance.${String(index + 1).padStart(2, "0")}`, requirementId: requirement.requirementId, label: requirement.countIsExact ? `${requirement.name} ${index + 1}` : requirement.name, mandatory: requirement.mandatory, countIndex: index + 1, status: placement ? "placed" : "unplaced", unplacedReason: placement ? null : reason, xQ16: placement?.xQ16 ?? null, yQ16: placement?.yQ16 ?? null, widthQ16: placement?.widthQ16 ?? null, heightQ16: placement?.heightQ16 ?? null, symbols: placement ? symbolsFor(requirement, category, index) : [] };
}
function verifyRequirement(value: S5LayoutRequirement, index: number): void {
  if (value.requirementId !== `brief.functional.${String(index + 1).padStart(3, "0")}` || !value.name.trim() || Array.from(value.name).length > 80 || typeof value.mandatory !== "boolean" || typeof value.countIsExact !== "boolean") throw layoutError("S5_LAYOUT_INPUT_INVALID", `requirements[${index}]`);
  if (value.details !== null && (typeof value.details !== "string" || Array.from(value.details).length > 400)) throw layoutError("S5_LAYOUT_INPUT_INVALID", `requirements[${index}].details`);
  if (value.count !== null && (!Number.isSafeInteger(value.count) || value.count < 0)) throw layoutError("S5_LAYOUT_INPUT_INVALID", `requirements[${index}].count`);
  if (value.countIsExact && value.count === null) throw layoutError("S5_LAYOUT_INPUT_INVALID", `requirements[${index}].count`);
}
function geometryCoverage(requirement: S2Requirement): S5LayoutCoverage {
  const prohibited = requirement.category === "prohibited";
  return { requirementId: requirement.requirementId, role: prohibited ? "prohibited_constraint" : "geometry_constraint", status: "represented", reason: null, mandatory: false, count: null, countIsExact: false, representedCount: 1 };
}

export function compileConceptLayoutPlan(input: S5LayoutCompilerInput): S5LayoutPlan {
  if (!Number.isSafeInteger(input.selectionVersion) || input.selectionVersion < 1 || !Number.isSafeInteger(input.approvalGeneration) || input.approvalGeneration < 1 || !Number.isSafeInteger(input.approvalEventSequence) || input.approvalEventSequence < 1 || !Number.isSafeInteger(input.geometry.widthMm) || input.geometry.widthMm < 1 || !Number.isSafeInteger(input.geometry.depthMm) || input.geometry.depthMm < 1) throw layoutError("S5_LAYOUT_INPUT_INVALID", "geometry");
  if (input.requirements.length > 64) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements");
  input.requirements.forEach(verifyRequirement);
  if (new Set(input.requirements.map((item) => item.requirementId)).size !== input.requirements.length) throw layoutError("S5_LAYOUT_INPUT_INVALID", "requirements");
  const sorted = input.requirements.slice().sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  const working: S5LayoutPlan = {
    schemaVersion: S5_LAYOUT_SCHEMA, projectId: input.projectId, generationSetId: input.generationSetId, selectionStateId: input.selectionStateId, selectionVersion: input.selectionVersion,
    activeRevisionId: input.activeRevisionId, activeRevisionKind: input.activeRevisionKind, approvalEventId: input.approvalEventId, approvalGeneration: input.approvalGeneration, approvalEventSequence: input.approvalEventSequence,
    coordinateConvention: { units: "mm", origin: "north-west", x: "east", y: "south", north: "diagram-top-not-surveyed-bearing", displaySpace: "normalized-Q16-conceptual" }, booth: cloneJson(input.geometry), coverage: [], zones: [], circulation: circulationFor(input.geometry.openSides), unknowns: [], disclaimers: [...DISCLAIMERS, input.geometry.maxHeightMm === null ? "Confirmed maximum height was not specified in the brief." : `Confirmed maximum height: ${input.geometry.maxHeightMm} mm.`], planHash: "" as Sha256,
  };
  const canonicalById = new Map((input.canonicalRequirements ?? []).map((item) => [item.requirementId, item]));
  for (const requirement of sorted) {
    const category = classify(requirement.name, requirement.details); const requested = requirement.countIsExact ? requirement.count! : 1; const zoneInstances: S5LayoutInstance[] = []; let representedCount = 0; let reason: S5CoverageReason = null;
    if (category === "other_confirmed") reason = "unknown_semantic";
    if (requested > 8) { if (requirement.mandatory) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", `requirements.${requirement.requirementId}`); reason = "optional_overflow"; }
    const bounded = Math.min(requested, 8);
    for (let index = 0; index < bounded; index += 1) {
      if (category === "other_confirmed") { zoneInstances.push(instanceFor(requirement, category, index, null, "unknown-semantic")); continue; }
      if (representedCount >= 16) { if (requirement.mandatory) throw layoutError("S5_LAYOUT_OVERCONSTRAINED", `requirements.${requirement.requirementId}`); zoneInstances.push(instanceFor(requirement, category, index, null, "optional-overflow")); reason = "optional_overflow"; continue; }
      zoneInstances.push(instanceFor(requirement, category, index, positionFor(representedCount), null)); representedCount += 1;
    }
    if (requested > bounded && bounded > 0) zoneInstances.push(instanceFor(requirement, category, bounded, null, "optional-overflow"));
    const placementStatus = category === "other_confirmed" ? "unknown" : requested === 0 ? "represented" : representedCount > 0 && representedCount >= Math.min(requested, 16) ? "symbolic" : "unplaced";
    const zone: S5LayoutZone = { zoneId: `zone.${requirement.requirementId}`, category, label: requirement.name, requirementIds: [requirement.requirementId], mandatory: requirement.mandatory, count: requirement.count, countIsExact: requirement.countIsExact, representedCount, placementStatus, placementReason: reason, instances: zoneInstances };
    working.zones.push(zone);
    working.coverage.push({ requirementId: requirement.requirementId, role: "zone_candidate", status: placementStatus, reason, mandatory: requirement.mandatory, count: requirement.count, countIsExact: requirement.countIsExact, representedCount });
    if (reason !== null || category === "other_confirmed") working.unknowns.push(unknownItem(requirement, reason === "optional_overflow" ? "optional-overflow" : "unknown-semantic"));
  }
  for (const requirement of input.canonicalRequirements ?? []) if (!working.coverage.some((item) => item.requirementId === requirement.requirementId)) working.coverage.push(geometryCoverage(requirement));
  working.coverage.sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  return withPlanHash(working);
}
function withoutPlanHash(plan: S5LayoutPlan): Record<string, unknown> { const copy = cloneJson(plan) as Record<string, unknown>; delete copy.planHash; return copy; }
function withPlanHash(plan: S5LayoutPlan): S5LayoutPlan { plan.planHash = sha256(jcs(withoutPlanHash(plan))); return plan; }
export function canonicalPlanJson(plan: S5LayoutPlan): string { verifyPlanHash(plan); return jcs(plan); }
export function canonicalPlanBytes(plan: S5LayoutPlan): Buffer { return Buffer.from(canonicalPlanJson(plan), "utf8"); }
export function verifyPlanHash(plan: S5LayoutPlan): void {
  if (plan.schemaVersion !== S5_LAYOUT_SCHEMA || plan.coordinateConvention.units !== "mm" || plan.coordinateConvention.origin !== "north-west" || plan.coordinateConvention.x !== "east" || plan.coordinateConvention.y !== "south" || plan.coordinateConvention.north !== "diagram-top-not-surveyed-bearing" || plan.coordinateConvention.displaySpace !== "normalized-Q16-conceptual") throw layoutError("S5_LAYOUT_CONVENTION_INVALID", "coordinateConvention");
  if (!/^[0-9a-f]{64}$/u.test(plan.planHash) || sha256(jcs(withoutPlanHash(plan))) !== plan.planHash) throw layoutError("S5_PLAN_HASH_MISMATCH", "planHash");
  for (const zone of plan.zones) for (const instance of zone.instances) for (const value of [instance.xQ16, instance.yQ16, instance.widthQ16, instance.heightQ16]) if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > S5_Q16_MAX)) throw layoutError("S5_LAYOUT_INPUT_INVALID", "zones");
}
