import type {
  S2DesignObservation,
  S2InputVersion,
  S2QaCandidateResult,
  S2RequirementObservation,
} from "./types";

export const S2_CONFIDENCE_THRESHOLD = 0.75;

export type S2FindingSet = {
  materialFindingIds: string[];
  warningFindingIds: string[];
  uncertainFindingIds: string[];
  verdict: "PASS" | "WARNING" | "MATERIAL_FAIL";
};

type FindingLevel = "none" | "uncertain" | "warning" | "material";

function levelRank(level: FindingLevel): number {
  return level === "material" ? 3 : level === "warning" ? 2 : level === "uncertain" ? 1 : 0;
}
function findingOrder(input: S2InputVersion): Map<string, number> {
  const order = new Map<string, number>();
  let position = 0;
  for (const requirement of input.canonicalRequirements) {
    if (!order.has(requirement.requirementId)) order.set(requirement.requirementId, position);
    position += 1;
  }
  for (const rule of input.designRuleSnapshot) {
    if (rule.applicability !== "applicable") continue;
    if (!order.has(rule.ruleId)) order.set(rule.ruleId, position);
    position += 1;
  }
  return order;
}

function sortedIds(levels: Map<string, FindingLevel>, order: Map<string, number>, target: FindingLevel): string[] {
  return Array.from(levels.entries())
    .filter(([, level]) => level === target)
    .sort((left, right) => (order.get(left[0]) ?? Number.MAX_SAFE_INTEGER) - (order.get(right[0]) ?? Number.MAX_SAFE_INTEGER))
    .map(([id]) => id);
}

function requirementLevel(
  expected: S2InputVersion["canonicalRequirements"][number],
  observed: S2RequirementObservation,
): FindingLevel {
  const uncertain = observed.confidence < S2_CONFIDENCE_THRESHOLD ||
    observed.observed === "uncertain" || observed.observed === "not_verifiable";
  if (uncertain) return "uncertain";
  const violation = (expected.expected === "present" && observed.observed === "absent") ||
    (expected.expected === "absent" && observed.observed === "present") ||
    (expected.expected === "exact_count" && observed.observedCount !== expected.expectedCount);
  if (!violation) return "none";
  return expected.criticality === "material" ? "material" : "warning";
}

function designLevel(
  expected: S2InputVersion["designRuleSnapshot"][number],
  observed: S2DesignObservation,
): FindingLevel {
  if (observed.confidence < S2_CONFIDENCE_THRESHOLD ||
      observed.observed === "uncertain" || observed.observed === "not_verifiable") return "uncertain";
  if (observed.observed !== "non_compliant") return "none";
  return expected.materiality === "material" ? "material" : "warning";
}

export function reduceS2Findings(
  input: S2InputVersion,
  requirementObservations: readonly S2RequirementObservation[],
  designObservations: readonly S2DesignObservation[],
): S2FindingSet {
  const levels = new Map<string, FindingLevel>();
  const order = findingOrder(input);

  for (const expected of input.canonicalRequirements) {
    const observed = requirementObservations.find((item) => item.requirementId === expected.requirementId);
    if (!observed) throw new Error("missing requirement observation: " + expected.requirementId);
    const level = requirementLevel(expected, observed);
    if (levelRank(level) > levelRank(levels.get(expected.requirementId) ?? "none")) levels.set(expected.requirementId, level);
  }

  for (const expected of input.designRuleSnapshot) {
    if (expected.applicability !== "applicable") continue;
    const observed = designObservations.find((item) => item.ruleId === expected.ruleId);
    if (!observed) throw new Error("missing design observation: " + expected.ruleId);
    const level = designLevel(expected, observed);
    if (levelRank(level) > levelRank(levels.get(expected.ruleId) ?? "none")) levels.set(expected.ruleId, level);
  }

  const materialFindingIds = sortedIds(levels, order, "material");
  const warningFindingIds = sortedIds(levels, order, "warning");
  const uncertainFindingIds = sortedIds(levels, order, "uncertain");
  return {
    materialFindingIds,
    warningFindingIds,
    uncertainFindingIds,
    verdict: materialFindingIds.length > 0
      ? "MATERIAL_FAIL"
      : warningFindingIds.length > 0 || uncertainFindingIds.length > 0
        ? "WARNING"
        : "PASS",
  };
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

const REPAIRABLE_RULES = new Set([
  "footprint.within-boundary", "access.open-sides", "circulation.primary-access",
  "zones.inside-footprint", "scale.human", "structure.no-floating",
  "structure.screen-support", "structure.overhead-support", "geometry.intersections",
  "branding.prohibited",
]);

const BRIEF_FINDING_PATTERN = /^brief\.(functional|mandatory)\.\d{3}$/;

export function eligibleS2RepairFindingIds(result: S2QaCandidateResult, input: S2InputVersion): string[] | null {
  if (result.status !== "material_fail" || result.verdict !== "MATERIAL_FAIL") return null;

  let reduced: S2FindingSet;
  try {
    reduced = reduceS2Findings(input, result.requirementObservations, result.designObservations);
  } catch {
    return null;
  }
  if (!equalIds(result.materialFindingIds, reduced.materialFindingIds) ||
      !equalIds(result.warningFindingIds, reduced.warningFindingIds) ||
      !equalIds(result.uncertainFindingIds, reduced.uncertainFindingIds) ||
      reduced.verdict !== "MATERIAL_FAIL" || reduced.uncertainFindingIds.length > 0 ||
      reduced.materialFindingIds.length < 1 || reduced.materialFindingIds.length > 3) return null;

  const rules = new Map(input.designRuleSnapshot.map((item) => [item.ruleId, item]));
  const requirements = new Map(input.canonicalRequirements.map((item) => [item.requirementId, item]));
  const ids = reduced.materialFindingIds;
  if (ids.some((id) => {
    const rule = rules.get(id);
    const requirement = requirements.get(id);
    return (rule !== undefined && (!rule.repairable || rule.applicability !== "applicable")) ||
      (requirement !== undefined && requirement.criticality !== "material") ||
      (rule === undefined && requirement === undefined) ||
      (rule === undefined && !BRIEF_FINDING_PATTERN.test(id)) ||
      (rule !== undefined && !REPAIRABLE_RULES.has(id));
  })) return null;
  if (ids.filter((id) => BRIEF_FINDING_PATTERN.test(id)).length > 1) return null;
  return ids.slice();
}
